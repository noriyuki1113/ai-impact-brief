// /pages/api/today.js
// STRATEGIC_AI_BRIEF — RSS + Guardian + OpenAI Responses(JSON Schema)
// Node.js runtime (Vercel). Requires: npm i rss-parser
import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V8_RESPONSES_SCHEMA";

/**
 * ====== Tunables ======
 * Vercel は実行時間/ネットワーク状況で abort になりやすいので、
 * 「全体予算」「個別timeout」「AI呼び出しに必要な残り時間」を管理します。
 */
const OUTPUT_MAIN = 3; // メイン3本
const OUTPUT_OPS = 1; // 重要運用(セキュリティ等)を1本まで
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分

const FETCH_TIMEOUT_MS = 4500; // RSS/Guardian 1本あたり
const OPENAI_TIMEOUT_MS = 12000; // OpenAI 1回
const BUDGET_MS = 18000; // 1リクエスト全体の予算
const MIN_AI_REMAIN_MS = 9000; // AIコールに必要な最低残時間

/**
 * ====== Data sources ======
 * 「1サイトだけ」になりにくいように RSS を厚めにし、Guardian は任意(あれば追加)に。
 */
const RSS_SOURCES = [
  // Official / primary
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },

  // Market / media
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },

  // Japan
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "ITmedia Enterprise", url: "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml", jp: true, weight: 0.9, hint: "security" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

/**
 * ====== Allowlist (host) ======
 * RSSは外部リンクを含む場合があるため、ホストで制限。
 * 追加したいホストが出たらここに入れるだけでOK。
 */
const ALLOW_HOSTS = new Set([
  "openai.com",
  "www.openai.com",
  "anthropic.com",
  "www.anthropic.com",
  "deepmind.google",
  "www.deepmind.google",
  "techcrunch.com",
  "www.techcrunch.com",
  "itmedia.co.jp",
  "www.itmedia.co.jp",
  "ainow.ai",
  "www.ainow.ai",
  "theguardian.com",
  "www.theguardian.com",
]);

/**
 * ====== In-memory cache ======
 * Note: サーバレスはインスタンスが変わることがあるため「ベストエフォート」。
 */
let CACHE = { at: 0, payload: null, etag: "" };

/* ----------------------- small utils ----------------------- */

function nowIsoDateJST() {
  // JST固定（Asia/Tokyo）
  // 「YYYY-MM-DD」だけ使う
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function sha1Like(s) {
  // 速い疑似hash（ETag用）
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach((k) => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return (raw || "").trim();
  }
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function allowlisted(url) {
  const host = safeHost(url);
  if (!host) return false;
  if (ALLOW_HOSTS.has(host)) return true;
  // サブドメイン許可（例: x.theguardian.com）
  for (const h of ALLOW_HOSTS) {
    if (host === h) return true;
    if (host.endsWith(`.${h}`)) return true;
  }
  return false;
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/**
 * “This operation was aborted” 対策：
 * 1) 全体予算を超えない
 * 2) 個別Abort
 * 3) AI呼び出し前に残時間をチェックして、厳しければフォールバックに切り替える
 */
function remainingMs(startMs) {
  return Math.max(0, BUDGET_MS - (Date.now() - startMs));
}

/* ----------------------- topic + scoring ----------------------- */

function guessTopic(title, hint) {
  const raw = title || "";
  const t = raw.toLowerCase();

  // 「方法」「手法」は“規制/法”判定から除外したい
  const containsMethodWords = raw.includes("方法") || raw.includes("手法");

  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust/.test(t) ||
    /訴訟|規制|法案|司法|裁判/.test(raw) ||
    (!containsMethodWords && raw.includes("法"));

  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises/.test(t) || /資金|調達|評価額|上場/.test(raw)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc/.test(t) || /半導体|輸出/.test(raw)) return "supply_chain";
  if (/vuln|cve|security|exploit|breach|patch/.test(t) || /脆弱性|不正|流出|攻撃|詐欺/.test(raw)) return "security";
  if (/model|release|launch|api|tool|product/.test(t) || /アップデート|公開|提供|リリース|議事録/.test(raw)) return "product";
  if (/research|paper|benchmark|arxiv/.test(t) || /研究|論文|ベンチマーク/.test(raw)) return "research";
  return hint || "other";
}

function scoreCandidate(c) {
  // 0..100に寄せる
  let s = 40;

  // ソース重み（一次情報・信頼・重要度）
  s += Math.round((c.weight || 0.8) * 20);

  // 日本ソースは加点
  if (c.jp) s += 15;

  // タイトルに日本の制度・省庁等
  if (/japan|日本|国内|公取委|総務省|経産省|デジタル/.test(c.title || "")) s += 15;

  // トピック別の構造インパクト
  const bonus = { regulation: 20, funding: 15, supply_chain: 15, security: 18, product: 6, research: 6 };
  s += bonus[c.topic] || 0;

  // 上限・下限
  s = Math.max(0, Math.min(95, s));

  // breakdown は “公開Score” 用に安定して返す（合計は厳密に一致させない）
  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 6, // “速報” 前提で控えめ
    },
  };
}

/* ----------------------- fetchers ----------------------- */

async function fetchGuardian(guardianKey) {
  if (!guardianKey) return [];
  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=12` +
    `&show-fields=trailText` +
    `&api-key=${encodeURIComponent(guardianKey)}`;

  try {
    const res = await timeoutFetch(url, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    const rows = data?.response?.results || [];
    return rows
      .map((a) => ({
        source: "The Guardian",
        url: normalizeUrl(a.webUrl),
        title: a.webTitle || "",
        summary: String(a?.fields?.trailText || "").replace(/<[^>]*>?/gm, "").trim(),
        jp: false,
        weight: 0.85,
        hint: "market",
      }))
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const xml = await res.text();
    const feed = await parser.parseString(xml);

    return (feed.items || [])
      .slice(0, 10)
      .map((it) => {
        const link = normalizeUrl(it.link || "");
        const title = (it.title || "").trim();
        const summary = String(it.contentSnippet || it.content || "")
          .replace(/\s+/g, " ")
          .replace(/<[^>]*>?/gm, "")
          .slice(0, 600);

        return {
          source: src.name,
          url: link,
          title,
          summary,
          jp: !!src.jp,
          weight: src.weight,
          hint: src.hint,
        };
      })
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

/* ----------------------- pick diverse ----------------------- */

function enrichAndSort(candidates) {
  return candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      const host = safeHost(c.url);
      return {
        ...c,
        host,
        topic,
        importance_score: score,
        score_breakdown: breakdown,
      };
    })
    .sort((a, b) => b.importance_score - a.importance_score);
}

/**
 * メイン(3本)は「ホスト分散」「トピック分散」優先。
 * ops(1本)は security を優先し、メインと被らないものがあればそれを採用。
 */
function pickMainAndOps(enriched) {
  const main = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  // 1) main pick with diversity
  for (const c of enriched) {
    if (main.length >= OUTPUT_MAIN) break;
    if (!c.host) continue;

    // 同一ホストNG、同一トピックは最大1
    if (usedHosts.has(c.host)) continue;
    if (usedTopics.has(c.topic)) continue;

    main.push(c);
    usedHosts.add(c.host);
    usedTopics.add(c.topic);
  }

  // 2) fill main if不足（多様性条件を緩める）
  for (const c of enriched) {
    if (main.length >= OUTPUT_MAIN) break;
    if (!main.find((m) => m.url === c.url)) main.push(c);
  }

  // 3) ops pick (security 優先)
  let ops = null;
  const securityCandidates = enriched.filter((c) => c.topic === "security");
  for (const c of securityCandidates) {
    if (main.find((m) => m.url === c.url)) continue;
    ops = c;
    break;
  }

  // fallback: それでも無ければ null
  return { main: main.slice(0, OUTPUT_MAIN), ops };
}

/* ----------------------- OpenAI (Responses API) ----------------------- */

/**
 * Responses API + text.format(json_schema)
 * ここが “response_format” ではなく “text.format” になります。
 * （OpenAIの移行ガイドに準拠）
 */
async function callOpenAIResponsesJSON({ openaiKey, model, main, ops, startMs, debug }) {
  const remain = remainingMs(startMs);
  if (remain < MIN_AI_REMAIN_MS) {
    return { ok: false, error: `Skip AI: not enough budget (${remain}ms)` };
  }

  const systemPrompt = `
あなたは「構造で読む、AI戦略ニュース」の編集者兼アナリストです。
煽り・断定・主観評価は禁止。日本市場の視点で、意思決定に役立つ要約と示唆を作る。
必ず有効なJSONのみを返す。余計な文章は禁止。
`.trim();

  const userPrompt = `
以下の候補ニュースから、メイン${OUTPUT_MAIN}本（main_items）と、運用上の重要トピックがあれば1本（ops_items）を日本語で整理してください。
- main_items は必ず ${OUTPUT_MAIN} 件
- ops_items は 0 or 1 件（候補に security が無い/弱いなら空で可）
- 出力は UI表示前提。1項目は簡潔に。
- importance_score と score_breakdown は与えた値をそのまま採用（改変しない）
- impact_level:
  High: 規制・安全保障・市場構造に構造的影響
  Medium: 業界/大手企業に影響
  Low: 局所的/ツールTips中心

候補(JSON):
${JSON.stringify({ main_candidates: main, ops_candidate: ops ? [ops] : [] })}
`.trim();

  const schema = {
    name: "strategic_ai_brief",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        date_iso: { type: "string", minLength: 10, maxLength: 10 },
        items: {
          type: "array",
          minItems: OUTPUT_MAIN,
          maxItems: OUTPUT_MAIN,
          items: { $ref: "#/$defs/item" },
        },
        main_items: {
          type: "array",
          minItems: OUTPUT_MAIN,
          maxItems: OUTPUT_MAIN,
          items: { $ref: "#/$defs/item" },
        },
        ops_items: {
          type: "array",
          minItems: 0,
          maxItems: 1,
          items: { $ref: "#/$defs/item" },
        },
        sources: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      required: ["date_iso", "items", "main_items", "ops_items", "sources"],
      $defs: {
        item: {
          type: "object",
          additionalProperties: false,
          properties: {
            impact_level: { type: "string", enum: ["High", "Medium", "Low"] },
            importance_score: { type: "number", minimum: 0, maximum: 100 },
            score_breakdown: {
              type: "object",
              additionalProperties: false,
              properties: {
                market_impact: { type: "number", minimum: 0, maximum: 40 },
                business_impact: { type: "number", minimum: 0, maximum: 30 },
                japan_relevance: { type: "number", minimum: 0, maximum: 25 },
                confidence: { type: "number", minimum: 0, maximum: 20 },
              },
              required: ["market_impact", "business_impact", "japan_relevance", "confidence"],
            },
            title_ja: { type: "string", minLength: 6, maxLength: 60 },
            one_sentence: { type: "string", minLength: 12, maxLength: 120 },
            why_it_matters: { type: "string", minLength: 8, maxLength: 120 },
            japan_impact: { type: "string", minLength: 8, maxLength: 140 },
            tags: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 2, maxLength: 24 } },
            fact_summary: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 6, maxLength: 90 } },
            implications: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 6, maxLength: 90 } },
            outlook: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 6, maxLength: 90 } },
            original_title: { type: "string", minLength: 3 },
            original_url: { type: "string", minLength: 10 },
            source: { type: "string", minLength: 2 },
            topic: { type: "string", minLength: 3 },
          },
          required: [
            "impact_level",
            "importance_score",
            "score_breakdown",
            "title_ja",
            "one_sentence",
            "why_it_matters",
            "japan_impact",
            "tags",
            "fact_summary",
            "implications",
            "outlook",
            "original_title",
            "original_url",
            "source",
            "topic",
          ],
        },
      },
    },
  };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), Math.min(OPENAI_TIMEOUT_MS, remain - 250));
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        },
      }),
    });

    const status = r.status;
    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      return { ok: false, status, error: `OpenAI HTTP ${status}`, raw_preview: raw.slice(0, 800) };
    }

    // Responses API は output_text が便利（JSON文字列が返る）
    // ただし実装差異がある可能性があるので安全に両方見る
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, status, error: "OpenAI non-JSON HTTP body", raw_preview: raw.slice(0, 800) };
    }

    const textOut =
      data?.output_text ||
      data?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
      "";

    if (!textOut) {
      return { ok: false, status, error: "OpenAI missing output_text", raw_preview: raw.slice(0, 800) };
    }

    let parsed;
    try {
      parsed = JSON.parse(textOut);
    } catch {
      return { ok: false, status, error: "Model returned non-JSON text", raw_preview: textOut.slice(0, 800) };
    }

    // 最低限の整形（dateなど）
    parsed.date_iso = parsed.date_iso || nowIsoDateJST();
    return { ok: true, json: parsed, status, debug_raw_preview: debug ? textOut.slice(0, 1200) : "" };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e), raw_preview: "" };
  } finally {
    clearTimeout(id);
  }
}

/* ----------------------- payload builders ----------------------- */

function impactLevelFromTopic(topic, score) {
  // “Highは乱発しない” 前提の控えめルール
  if (topic === "regulation" || topic === "security") return score >= 88 ? "High" : "Medium";
  if (topic === "supply_chain" || topic === "funding") return score >= 90 ? "High" : "Medium";
  if (topic === "product" || topic === "research") return "Medium";
  return "Low";
}

function fallbackItemFromCandidate(c) {
  const impact = impactLevelFromTopic(c.topic, c.importance_score);

  return {
    impact_level: impact,
    importance_score: c.importance_score,
    score_breakdown: c.score_breakdown,
    title_ja: (c.jp ? c.title : c.title).slice(0, 60),
    one_sentence: (c.summary || c.title || "").slice(0, 120) || "要点は元記事参照。",
    why_it_matters: "市場構造・競争条件・投資判断に波及し得るため。",
    japan_impact: c.jp
      ? "日本市場への直接影響が見込まれるため、優先度高く点検。"
      : "海外動向として、日本企業の戦略/調達/規制対応への波及を注視。",
    tags: [c.topic],
    fact_summary: [`出典: ${c.source}`, `要点: ${(c.summary || c.title || "").slice(0, 80)}`, "リンク: 元記事参照"],
    implications: ["示唆: 競争環境・投資判断・調達方針に波及し得る", "示唆: 日本市場では規制/供給網/投資動向の影響を点検"],
    outlook: ["見通し: 追加発表・規制当局・決算の動きが焦点", "見通し: 6〜12か月での政策・投資・採用動向を注視"],
    original_title: c.title || "",
    original_url: c.url || "",
    source: c.source || "",
    topic: c.topic || "other",
  };
}

function assembleFallbackPayload({ main, ops }) {
  const items = main.map(fallbackItemFromCandidate);
  const main_items = [...items];

  const ops_items = [];
  if (ops) ops_items.push(fallbackItemFromCandidate(ops));

  const sources = Array.from(new Set([...main.map((x) => x.source), ...(ops ? [ops.source] : [])]));

  return {
    date_iso: nowIsoDateJST(),
    items,
    main_items,
    ops_items,
    sources,
  };
}

/* ----------------------- CORS ----------------------- */

function setCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");

  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/* ----------------------- handler ----------------------- */

export default async function handler(req, res) {
  const startMs = Date.now();

  setCors(req, res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  const openaiKey = process.env.OPENAI_API_KEY;
  const guardianKey = process.env.GUARDIAN_API_KEY || "";
  const openaiModel = process.env.OPENAI_MODEL || "gpt-5"; // アクセスが無ければ "gpt-4o-mini" などに変更

  if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // Cache (best effort)
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    const inm = req.headers["if-none-match"];
    if (inm && CACHE.etag && inm === CACHE.etag) return res.status(304).end();

    res.setHeader("ETag", CACHE.etag);
    const out = { ...CACHE.payload, cache: { hit: true, ttl_seconds: Math.max(0, Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000)) } };
    return res.status(200).json(out);
  }

  try {
    // 1) Fetch candidates in parallel
    const parser = new Parser();

    const tasks = [
      fetchGuardian(guardianKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ];

    const settled = await Promise.allSettled(tasks);

    const rawCandidates = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .map((c) => ({ ...c, url: normalizeUrl(c.url) }))
      .filter((c) => c.url && c.title && allowlisted(c.url));

    // 2) Deduplicate (by normalized url)
    const seen = new Set();
    const deduped = [];
    for (const c of rawCandidates) {
      const key = c.url;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(c);
    }

    // 3) Enrich + pick
    const enriched = enrichAndSort(deduped);

    // Poolが少なすぎる場合でも最低3本は返す（可能な範囲で）
    const { main, ops } = pickMainAndOps(enriched);

    // 4) If AI budget OK => call OpenAI Responses(JSON Schema). Else => fallback
    let finalPayload = null;
    let openaiDebug = { ok: false, status: 0, error: null, raw_preview: "" };

    const aiResult = await callOpenAIResponsesJSON({
      openaiKey,
      model: openaiModel,
      main,
      ops,
      startMs,
      debug,
    });

    if (aiResult.ok) {
      finalPayload = aiResult.json;
      openaiDebug = { ok: true, status: aiResult.status, error: null, raw_preview: aiResult.debug_raw_preview || "" };
    } else {
      finalPayload = assembleFallbackPayload({ main, ops });
      openaiDebug = { ok: false, status: aiResult.status || 0, error: aiResult.error || "unknown", raw_preview: aiResult.raw_preview || "" };
    }

    // 5) Add metadata (always)
    const sources = Array.from(new Set([...(finalPayload.sources || []), ...main.map((x) => x.source), ...(ops ? [ops.source] : [])]));
    finalPayload.sources = sources;

    finalPayload.generated_at = new Date().toISOString();
    finalPayload.version = BUILD_ID;
    finalPayload.build_id = `${BUILD_ID}__${nowIsoDateJST()}`;

    // items は main_items と揃える（互換用）
    finalPayload.items = finalPayload.main_items || finalPayload.items || [];

    // 6) Cache
    const etag = `"${sha1Like(JSON.stringify(finalPayload))}"`;
    CACHE = { at: Date.now(), payload: finalPayload, etag };

    res.setHeader("ETag", etag);

    // 7) Debug extras
    if (debug) {
      return res.status(200).json({
        ...finalPayload,
        cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
        debug: {
          ai_ok: !!aiResult.ok,
          openai: openaiDebug,
          merged_count: enriched.length,
          pool_count: deduped.length,
          picked: [
            ...main.map((x) => ({ source: x.source, host: x.host, topic: x.topic, score: x.importance_score, url: x.url })),
            ...(ops ? [{ source: ops.source, host: ops.host, topic: ops.topic, score: ops.importance_score, url: ops.url, ops: true }] : []),
          ],
          timeouts: {
            fetch: FETCH_TIMEOUT_MS,
            openai: OPENAI_TIMEOUT_MS,
            budget: BUDGET_MS,
            min_ai_remain: MIN_AI_REMAIN_MS,
          },
          remaining_ms_before_return: remainingMs(startMs),
        },
      });
    }

    return res.status(200).json({
      ...finalPayload,
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
    });
  }
}
