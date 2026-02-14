import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V10_STABLE_UIFIX";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 4500;
const OPENAI_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分
const OUTPUT_MAIN = 3;
const OUTPUT_OPS = 1;

// AIを呼ぶ最低残り予算（ms）。これ未満ならAIは呼ばずにフォールバックで返す
const MIN_AI_REMAIN_MS = 9000;

// ====== データソース設定 ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "ITmedia Enterprise", url: "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml", jp: true, weight: 0.95, hint: "security" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

const ALLOW_HOSTS = [
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "techcrunch.com",
  "itmedia.co.jp",
  "ainow.ai",
  "theguardian.com",
];

// （メモリキャッシュ：Vercelのコールドスタートではリセットされ得るが、ETagで補う）
let CACHE = { at: 0, payload: null, etag: "" };

// ====== ユーティリティ ======
const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
};

function nowIso() {
  return new Date().toISOString();
}

function isoDateOnly() {
  return new Date().toISOString().slice(0, 10);
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

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostAllowed(url) {
  const h = safeHost(url);
  if (!h) return false;
  return ALLOW_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim();
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/**
 * トピック推定ロジック（日本語の誤検知対策）
 */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 「方法」「手法」を除外した「法」にのみ反応（lookbehind）
  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";

  const isSecurity =
    /vuln|cve|cvss|breach|hack|phish|malware|ransom|security|脆弱|侵害|漏えい|詐欺|なりすまし|不正/.test(t);
  if (isSecurity) return "security";

  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録|会議録/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";

  return hint || "other";
}

/**
 * 戦略的重み付けスコアリング
 */
function scoreCandidate(c) {
  let s = 40;
  s += Math.round((c.weight || 0.8) * 20);

  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省|デジタル|個人情報|著作権/.test(c.title || "")) s += 15;

  const bonus = { regulation: 20, security: 18, funding: 15, supply_chain: 15, product: 5, research: 5 };
  s += bonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));

  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 6,
    },
  };
}

/**
 * 多様性を維持した main(3) 選出
 */
function pickDiverseMain(candidates) {
  const enriched = candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return { ...c, topic, importance_score: score, score_breakdown: breakdown };
    })
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  for (const c of enriched) {
    if (picked.length >= OUTPUT_MAIN) break;
    const host = safeHost(c.url);

    // 同一ホストは避ける／topicは最大1枠（多様性）
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填（多様性条件で埋まらなければスコア順で足す）
  let i = 0;
  while (picked.length < OUTPUT_MAIN && i < enriched.length) {
    const x = enriched[i];
    if (!picked.find((p) => p.url === x.url)) picked.push(x);
    i++;
  }

  return picked.slice(0, OUTPUT_MAIN);
}

/**
 * ops(1): “日本の実務に効くセキュリティ/運用”を優先
 */
function pickOps(candidates, alreadyPickedUrls) {
  const enriched = candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return { ...c, topic, importance_score: score, score_breakdown: breakdown };
    })
    .filter((c) => c.topic === "security")
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  for (const c of enriched) {
    if (picked.length >= OUTPUT_OPS) break;
    if (alreadyPickedUrls.has(c.url)) continue;

    // opsは “国内” を強く優先（なければ国外でもOK）
    if (c.jp) {
      picked.push({ ...c, ops: true });
      break;
    }
  }

  // 国内が取れなければ上位を1つ
  if (picked.length < OUTPUT_OPS) {
    const fallback = enriched.find((c) => !alreadyPickedUrls.has(c.url));
    if (fallback) picked.push({ ...fallback, ops: true });
  }

  return picked.slice(0, OUTPUT_OPS);
}

// ====== 取得（Guardian + RSS） ======
async function fetchGuardian(key) {
  const url = `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=10&show-fields=trailText&api-key=${encodeURIComponent(
    key
  )}`;

  try {
    const res = await timeoutFetch(url);
    const data = await res.json();

    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle,
      summary: stripHtml(a.fields?.trailText || ""),
      jp: false,
      weight: 0.95,
      hint: "market",
      published_at: a.webPublicationDate ? new Date(a.webPublicationDate).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url);
    const xml = await res.text();
    const feed = await parser.parseString(xml);

    return (feed.items || []).slice(0, 10).map((it) => ({
      source: src.name,
      url: normalizeUrl(it.link),
      title: it.title || "",
      summary: stripHtml((it.contentSnippet || it.content || "").slice(0, 800)),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
      published_at: it.isoDate
        ? new Date(it.isoDate).toISOString()
        : it.pubDate
        ? new Date(it.pubDate).toISOString()
        : null,
    }));
  } catch {
    return [];
  }
}

// ====== OpenAI Responses API（Structured Outputs: json_schema） ======
function buildBriefSchema() {
  // NOTE:
  // - items.items の required は “properties の全キーを含む配列” が必須（あなたの400の原因）
  // - strict: true で形式逸脱を防ぐ
  return {
    name: "strategic_ai_brief",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              original_url: { type: "string" },
              title_ja: { type: "string" },
              one_sentence: { type: "string" },
              why_it_matters: { type: "string" },
              japan_impact: { type: "string" },
              fact_summary: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
              implications: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
              outlook: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
            },
            required: [
              "original_url",
              "title_ja",
              "one_sentence",
              "why_it_matters",
              "japan_impact",
              "fact_summary",
              "implications",
              "outlook",
            ],
          },
        },
      },
      required: ["items"],
    },
  };
}

function extractResponsesJson(respJson) {
  // responses.create には output_text がある場合がある（SDK/仕様差異を吸収）  [oai_citation:1‡OpenAI Platform](https://platform.openai.com/docs/api-reference/responses/create)
  if (respJson && typeof respJson.output_text === "string" && respJson.output_text.trim()) {
    return JSON.parse(respJson.output_text);
  }

  // output配列から拾う
  const out = respJson?.output || [];
  for (const item of out) {
    if (item?.type === "message") {
      const parts = item.content || [];
      for (const p of parts) {
        if (p?.type === "output_text" && typeof p.text === "string") {
          return JSON.parse(p.text);
        }
      }
    }
  }
  throw new Error("No JSON text in response");
}

async function openaiBrief(oKey, pickedMainPlusOps, timeoutMs = OPENAI_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  const schema = buildBriefSchema();

  // “AIに渡す情報”は必要最小限（短くするとAbortに強い）
  const compact = pickedMainPlusOps.map((x) => ({
    original_url: x.url,
    original_title: x.title,
    source: x.source,
    topic: x.topic,
    jp: x.jp,
    published_at: x.published_at,
    summary: x.summary,
  }));

  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "あなたは戦略的AIニュース編集者です。与えられた記事候補ごとに、日本語で“構造化ブリーフ”を作り、必ず指定JSONスキーマで返してください。" +
              "推測は避け、断定が難しい場合は一般論として表現してください。各配列は短文で。",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(compact) }],
      },
    ],
    // Responses API: text.format で json_schema を指定  [oai_citation:2‡OpenAI Platform](https://platform.openai.com/docs/api-reference/responses/create)
    text: {
      format: {
        type: "json_schema",
        name: schema.name,
        strict: schema.strict,
        schema: schema.schema,
      },
    },
    // temperature はモデルによって非対応があるので送らない（あなたのエラー回避）
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${oKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = await res.json();
    if (!res.ok) {
      const msg = json?.error?.message || `OpenAI HTTP ${res.status}`;
      throw new Error(msg);
    }

    const parsed = extractResponsesJson(json);
    return parsed;
  } finally {
    clearTimeout(id);
  }
}

// ====== フォールバック生成（AIが死んでも返す） ======
function fallbackBrief(pickedMainPlusOps) {
  return {
    items: pickedMainPlusOps.map((p) => {
      const title_ja = p.jp ? p.title : p.title; // ここで翻訳はしない（推測を避ける）
      const one = (p.summary || p.title || "").slice(0, 120) || "要点は元記事参照";
      const why = "市場構造・競争条件・投資判断に波及し得るため。";
      const jpImpact = p.jp
        ? "日本市場への直接影響が見込まれるため、優先度高く点検。"
        : "海外動向として、日本企業の戦略/調達/規制対応への波及を注視。";

      return {
        original_url: p.url,
        title_ja,
        one_sentence: one,
        why_it_matters: why,
        japan_impact: jpImpact,
        fact_summary: [`出典: ${p.source}`, "要点: 元記事参照"],
        implications: [
          "示唆: 競争環境・投資判断・調達方針に波及し得る",
          "示唆: 日本市場では規制/供給網/投資動向の影響を点検",
        ],
        outlook: [
          "見通し: 追加発表・規制当局・決算の動きが焦点",
          "見通し: 6〜12か月での政策・投資・採用動向を注視",
        ],
      };
    }),
  };
}

function mergeAIIntoPicked(picked, aiJson) {
  // aiJson.items: original_url で突合
  const map = new Map();
  for (const it of aiJson?.items || []) {
    if (it?.original_url) map.set(it.original_url, it);
  }

  return picked.map((p) => {
    const ai = map.get(p.url);
    if (!ai) return p;

    return {
      ...p,
      title_ja: ai.title_ja || p.title_ja || p.title,
      one_sentence: ai.one_sentence || p.one_sentence,
      why_it_matters: ai.why_it_matters || p.why_it_matters,
      japan_impact: ai.japan_impact || p.japan_impact,
      fact_summary: Array.isArray(ai.fact_summary) ? ai.fact_summary : p.fact_summary,
      implications: Array.isArray(ai.implications) ? ai.implications : p.implications,
      outlook: Array.isArray(ai.outlook) ? ai.outlook : p.outlook,
    };
  });
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  const start = Date.now();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey || !oKey) return res.status(500).json({ error: "Missing API Keys" });

  // ETag / 304（クライアントキャッシュ）
  const inm = req.headers["if-none-match"];
  if (CACHE.payload && CACHE.etag && inm && inm === CACHE.etag && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.statusCode = 304;
    return res.end();
  }

  // メモリキャッシュ
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.setHeader("ETag", CACHE.etag);
    return res.status(200).json(CACHE.payload);
  }

  try {
    const parser = new Parser();

    // 1) 並列取得
    const results = await Promise.allSettled([fetchGuardian(gKey), ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src))]);

    const pool = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter((c) => c?.url && hostAllowed(c.url));

    // 2) main/ops 選出
    const mainPicked = pickDiverseMain(pool);
    const used = new Set(mainPicked.map((x) => x.url));
    const opsPicked = pickOps(pool, used);

    // 3) items を組み立て（ここではメタ情報+スコア中心）
    const picked = [...mainPicked, ...opsPicked].map((p) => ({
      impact_level: p.importance_score >= 90 ? "High" : p.importance_score >= 70 ? "Medium" : "Low",
      importance_score: p.importance_score,
      score_breakdown: p.score_breakdown,
      topic: p.topic,
      tags: [p.topic],
      title_ja: p.title,
      one_sentence: "",
      why_it_matters: "",
      japan_impact: "",
      fact_summary: [],
      implications: [],
      outlook: [],
      original_title: p.title,
      original_url: p.url,
      source: p.source,
      published_at: p.published_at || null,
      ops: !!p.ops,
      // summaryは最終JSONには出さない（AIに渡すだけ）
      __summary: p.summary || "",
      __jp: !!p.jp,
    }));

    // 4) AIでブリーフ化（残り時間が足りなければ呼ばない）
    const elapsed = Date.now() - start;
    const remain = OPENAI_TIMEOUT_MS + FETCH_TIMEOUT_MS + 2000 - elapsed; // ざっくり予算
    let ai_ok = false;
    let openaiDebug = { ok: false, status: 0, error: null };

    // AI入力用に、必要フィールドを“候補”に戻す
    const aiInput = picked.map((x) => ({
      url: x.original_url,
      title: x.original_title,
      source: x.source,
      topic: x.topic,
      jp: x.__jp,
      published_at: x.published_at,
      summary: x.__summary,
    }));

    let briefJson = null;

    if (remain >= MIN_AI_REMAIN_MS) {
      try {
        const ai = await openaiBrief(oKey, aiInput, OPENAI_TIMEOUT_MS);
        briefJson = ai;
        ai_ok = true;
        openaiDebug.ok = true;
      } catch (e) {
        openaiDebug.ok = false;
        openaiDebug.error = String(e?.message || e);
      }
    } else {
      openaiDebug.error = `Skipped AI (remain_ms=${remain})`;
    }

    // 5) AI結果をitemsへマージ or フォールバック
    const baseForMerge = picked.map((x) => ({
      url: x.original_url,
      source: x.source,
      title: x.original_title,
      topic: x.topic,
      jp: x.__jp,
      published_at: x.published_at,
      summary: x.__summary,
    }));

    const brief = briefJson ? briefJson : fallbackBrief(baseForMerge);

    const merged = mergeAIIntoPicked(
      picked.map((x) => ({
        ...x,
        url: x.original_url,
        jp: x.__jp,
        summary: x.__summary,
      })),
      brief
    ).map((x) => {
      // 返却前に内部フィールド削除
      const { __summary, __jp, url, jp, summary, ...rest } = x;
      return rest;
    });

    // 6) main_items / ops_items / items
    const main_items = merged.filter((x) => !x.ops).slice(0, OUTPUT_MAIN);
    const ops_items = merged.filter((x) => x.ops).slice(0, OUTPUT_OPS);

    const payload = {
      date_iso: isoDateOnly(),
      items: [...main_items, ...ops_items],
      main_items,
      ops_items,
      sources: Array.from(new Set(merged.map((x) => x.source))),
      generated_at: nowIso(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${isoDateOnly()}`,
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
      debug: {
        ai_ok,
        openai: openaiDebug,
        merged_count: pool.length,
        picked: [...main_items, ...ops_items].map((x) => ({
          source: x.source,
          host: safeHost(x.original_url),
          topic: x.topic,
          score: x.importance_score,
          url: x.original_url,
          ops: !!x.ops,
        })),
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS, min_ai_remain: MIN_AI_REMAIN_MS },
      },
    };

    // ETag & メモリキャッシュ更新
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err), stack: err?.stack || "" });
  }
}
