import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V7_RESPONSES_JSON";

// ====== Tunables ======
const OUTPUT_MAIN = 3;
const OUTPUT_OPS = 1;

const FETCH_TIMEOUT_MS = 4200;      // RSS/Guardian取得 4.2s
const OPENAI_TIMEOUT_MS = 12000;    // OpenAI 12s
const BUDGET_MS = 18000;            // 関数全体の予算 18s
const MIN_AI_REMAIN_MS = 16000;     // これ以上残ってたらAI実行（安定優先）
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分

// ====== Data Sources ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "ITmedia Enterprise", url: "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml", jp: true, weight: 0.9, hint: "security" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

// allowlist（最低限）
const ALLOW_HOSTS = [
  "theguardian.com",
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "techcrunch.com",
  "itmedia.co.jp",
  "ainow.ai",
];

let CACHE = { at: 0, payload: null, etag: "" };

// ====== Utilities ======
const nowIso = () => new Date().toISOString();
const todayIso = () => new Date().toISOString().slice(0, 10);

const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
};

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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllowed(url) {
  const h = hostOf(url);
  if (!h) return false;
  return ALLOW_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim();
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

// ====== Topic Guess (誤検知対策) ======
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 「方法」「手法」を除外して「法」に反応（lookbehindは環境差があるので回避）
  const hasHou = /法/.test(title || "");
  const isHowHou = /(方法|手法)/.test(title || "");
  const jpLaw = hasHou && !isHowHou;

  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust/.test(t) ||
    /訴訟|規制|法案|司法|裁判|公取委|総務省|経産省/.test(title || "") ||
    jpLaw;

  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出|供給網/.test(t)) return "supply_chain";
  if (/security|vulnerab|cve|breach|attack|脆弱|漏えい|不正|cvss/.test(t) || /セキュリ/.test(title || "")) return "security";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録|会議/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  return hint || "other";
}

// ====== Scoring (日本市場視点) ======
function scoreCandidate(c) {
  let s = 40;

  // source weight
  s += Math.round((c.weight || 0.8) * 20);

  // JP bias
  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省|日銀|東証|円|人材|賃金/.test(c.title || "")) s += 15;

  // topic bonus
  const bonus = { regulation: 20, funding: 15, supply_chain: 15, security: 18, product: 6, research: 6 };
  s += bonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));

  // breakdown（公開想定）
  const market_impact = Math.min(40, Math.round(s * 0.4));
  const business_impact = Math.min(30, Math.round(s * 0.3));
  const japan_relevance = Math.min(25, c.jp ? 20 : 10);
  const confidence = 6;

  return {
    score: s,
    breakdown: { market_impact, business_impact, japan_relevance, confidence },
  };
}

// ====== Fetchers ======
async function fetchGuardian(key) {
  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=12&show-fields=trailText&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const list = data?.response?.results || [];
    return list
      .map((a) => ({
        source: "The Guardian",
        url: normalizeUrl(a.webUrl),
        title: a.webTitle || "",
        summary: stripHtml(a?.fields?.trailText || ""),
        jp: false,
        weight: 0.95,
        hint: "market",
      }))
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url);
    if (!res.ok) return [];
    const xml = await res.text();
    const feed = await parser.parseString(xml);

    return (feed.items || [])
      .slice(0, 10)
      .map((it) => ({
        source: src.name,
        url: normalizeUrl(it.link || ""),
        title: String(it.title || ""),
        summary: stripHtml((it.contentSnippet || it.content || "").slice(0, 800)),
        jp: !!src.jp,
        weight: src.weight,
        hint: src.hint,
      }))
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

// ====== Diversity Picking ======
function enrichCandidates(candidates) {
  return candidates
    .filter((c) => c?.url && c?.title)
    .filter((c) => isAllowed(c.url))
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      const host = hostOf(c.url);
      return {
        ...c,
        topic,
        host,
        importance_score: score,
        score_breakdown: breakdown,
      };
    })
    .sort((a, b) => b.importance_score - a.importance_score);
}

function pickMainAndOps(enriched) {
  const pickedMain = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  // Ops候補は security を優先（なければ null）
  const opsCandidate = enriched.find((c) => c.topic === "security") || null;

  // main_items: host と topic の重複を避けつつ 3本
  for (const c of enriched) {
    if (pickedMain.length >= OUTPUT_MAIN) break;
    if (opsCandidate && c.url === opsCandidate.url) continue;

    if (!usedHosts.has(c.host) && !usedTopics.has(c.topic)) {
      pickedMain.push(c);
      usedHosts.add(c.host);
      usedTopics.add(c.topic);
    }
  }

  // 補填（多様性が足りない時）
  let i = 0;
  while (pickedMain.length < OUTPUT_MAIN && i < enriched.length) {
    const c = enriched[i];
    if (opsCandidate && c.url === opsCandidate.url) { i++; continue; }
    if (!pickedMain.find((p) => p.url === c.url)) pickedMain.push(c);
    i++;
  }

  return {
    main: pickedMain.slice(0, OUTPUT_MAIN),
    ops: opsCandidate ? opsCandidate : null,
  };
}

// ====== OpenAI (Responses API / JSON強制) ======
async function callOpenAIResponses(openaiKey, mainPicked, opsPicked, budgetRemainMs) {
  // 予算が少ないなら呼ばない
  if (budgetRemainMs < MIN_AI_REMAIN_MS) {
    return { ok: false, status: 0, error: "Skip AI: budget too tight", rawText: "" };
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const pack = {
    date_iso: todayIso(),
    main: mainPicked.map((c) => ({
      source: c.source,
      original_title: c.title,
      original_url: c.url,
      topic: c.topic,
      importance_score: c.importance_score,
      score_breakdown: c.score_breakdown,
      summary: (c.summary || "").slice(0, 700),
    })),
    ops: opsPicked
      ? [
          {
            source: opsPicked.source,
            original_title: opsPicked.title,
            original_url: opsPicked.url,
            topic: opsPicked.topic,
            importance_score: opsPicked.importance_score,
            score_breakdown: opsPicked.score_breakdown,
            summary: (opsPicked.summary || "").slice(0, 700),
          },
        ]
      : [],
  };

  const system = `
あなたは「日本市場の視点で、世界のAI戦略ニュースを構造化する」冷静な戦略アナリストです。
煽り・断定・主観は禁止。短く濃く書く。出力は必ずJSONのみ。

必須:
- main_items は3件固定。ops_items は0〜1件。
- fact_summary/implications/outlook は各2〜4個。
- title_ja は上質で簡潔。one_sentence は60〜90文字目安。
- 重要: original_url/source/topic/importance_score/score_breakdown は入力値を維持。
- why_it_matters と japan_impact は具体的に（抽象語だけ禁止）。
- impact_level: High は最大1件（本当に構造的影響が強い場合のみ）。
`.trim();

  const user = `
次の候補(JSON)を「本編3本(main_items) + 実務1本(ops_items)」に整形してください。

各アイテムのキー:
impact_level, title_ja, one_sentence, why_it_matters, japan_impact,
tags, fact_summary, implications, outlook,
original_title, original_url, source, topic, importance_score, score_breakdown

入力:
${JSON.stringify(pack)}
`.trim();

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,

        // ✅ Responses API: JSON強制はここ
        text: { format: { type: "json_object" } },
      }),
    });

    const text = await r.text().catch(() => "");
    if (!r.ok) {
      return { ok: false, status: r.status, error: `OpenAI HTTP ${r.status}`, rawText: text.slice(0, 1400) };
    }

    const data = JSON.parse(text);

    // ✅ 最短: output_text
    const raw = data?.output_text;
    if (typeof raw === "string" && raw.trim()) {
      return parseAiJson(raw);
    }

    // ✅ 互換: output配列
    const out = Array.isArray(data?.output) ? data.output : [];
    let maybe = "";
    for (const block of out) {
      const contents = Array.isArray(block?.content) ? block.content : [];
      for (const c of contents) {
        if (c?.type === "output_text" && typeof c?.text === "string") maybe += c.text;
      }
    }
    if (!maybe.trim()) {
      return { ok: false, status: 502, error: "OpenAI missing output_text", rawText: text.slice(0, 1400) };
    }
    return parseAiJson(maybe);
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || "This operation was aborted", rawText: "" };
  } finally {
    clearTimeout(id);
  }
}

function parseAiJson(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);
    const main = Array.isArray(obj.main_items) ? obj.main_items : [];
    const ops = Array.isArray(obj.ops_items) ? obj.ops_items : [];

    if (main.length !== 3) return { ok: false, status: 502, error: "Schema: main_items must be 3", rawText: cleaned.slice(0, 1200) };
    if (ops.length > 1) return { ok: false, status: 502, error: "Schema: ops_items must be 0..1", rawText: cleaned.slice(0, 1200) };

    return { ok: true, status: 200, json: obj, rawText: cleaned.slice(0, 900) };
  } catch {
    return { ok: false, status: 502, error: "OpenAI returned non-JSON", rawText: cleaned.slice(0, 1200) };
  }
}

// ====== Fallback shaping (AI失敗時でもUIが崩れない) ======
function fallbackItemFromCandidate(c, isOps = false) {
  // 影響度の雑推定（スコアで段階）
  const impact_level = c.importance_score >= 90 ? "High" : c.importance_score >= 72 ? "Medium" : "Low";

  return {
    impact_level,
    importance_score: c.importance_score,
    score_breakdown: c.score_breakdown,
    title_ja: stripHtml(c.title).slice(0, 44),
    one_sentence: (stripHtml(c.summary) || stripHtml(c.title)).slice(0, 90),
    why_it_matters: isOps
      ? "実務影響（セキュリティ/運用）として、即時の確認が必要になり得るため。"
      : "市場構造・競争条件・投資判断に波及し得るため。",
    japan_impact: c.jp
      ? "日本市場への直接影響が見込まれるため、優先度高く点検。"
      : "海外動向として、日本企業の戦略/調達/規制対応への波及を注視。",
    tags: [c.topic],
    fact_summary: [`出典: ${c.source}`, `要点: ${stripHtml(c.summary).slice(0, 80) || "元記事参照"}`, "リンク: 元記事参照"],
    implications: ["示唆: 競争環境・投資判断・調達方針に波及し得る", "示唆: 日本市場では規制/供給網/投資動向の影響を点検"],
    outlook: ["見通し: 追加発表・規制当局・決算の動きが焦点", "見通し: 6〜12か月での政策・投資・採用動向を注視"],
    original_title: c.title,
    original_url: c.url,
    source: c.source,
    topic: c.topic,
  };
}

// ====== Handler ======
export default async function handler(req, res) {
  const started = Date.now();
  const remain = () => BUDGET_MS - (Date.now() - started);

  // ---- Robust CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  // debug=1
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const noCache = urlObj.searchParams.get("nocache") === "1";

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!oKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // Cache hit
  if (!noCache && CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    const payload = CACHE.payload;
    if (debug) payload.cache = { hit: true, ttl_seconds: Math.max(0, Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000)) };
    res.setHeader("ETag", CACHE.etag);
    return res.status(200).json(payload);
  }

  try {
    const parser = new Parser();

    // 1) Parallel fetch
    const tasks = [
      fetchGuardian(gKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ];

    const results = await Promise.allSettled(tasks);

    const allCandidates = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c?.url && c?.title)
      .filter((c) => isAllowed(c.url));

    // 2) Enrich + pick
    const enriched = enrichCandidates(allCandidates);

    const { main, ops } = pickMainAndOps(enriched);

    // pool_count (debug)
    const pool_count = enriched.length;

    // 3) Call AI (if time budget allows)
    const ai = await callOpenAIResponses(oKey, main, ops, remain());

    let payload;
    let ai_ok = false;

    if (ai.ok && ai.json) {
      // 正常: AI JSON
      payload = {
        date_iso: todayIso(),
        main_items: ai.json.main_items || [],
        ops_items: ai.json.ops_items || [],
      };

      // 互換: 旧フロントが items だけ見る場合
      payload.items = payload.main_items;

      // sources（表示用）
      payload.sources = Array.from(new Set([...payload.main_items, ...payload.ops_items].map((x) => x.source))).filter(Boolean);

      ai_ok = true;
    } else {
      // 失敗: フォールバック（UI崩さない）
      const mainItems = main.map((c) => fallbackItemFromCandidate(c, false));
      const opsItems = ops ? [fallbackItemFromCandidate(ops, true)] : [];

      payload = {
        date_iso: todayIso(),
        items: mainItems,
        main_items: mainItems,
        ops_items: opsItems,
        sources: Array.from(new Set([...mainItems, ...opsItems].map((x) => x.source))).filter(Boolean),
      };
    }

    // 4) Meta
    payload.generated_at = nowIso();
    payload.version = BUILD_ID;
    payload.build_id = `${BUILD_ID}__${todayIso()}`;

    // 5) Cache + ETag
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };
    res.setHeader("ETag", etag);

    // 6) Debug info
    if (debug) {
      payload.cache = { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) };

      payload.debug = {
        ai_ok,
        openai: {
          ok: ai.ok,
          status: ai.status,
          error: ai.error || null,
          raw_preview: ai.rawText ? ai.rawText.slice(0, 400) : "",
        },
        merged_count: allCandidates.length,
        pool_count,
        picked: [
          ...main.map((c) => ({
            source: c.source,
            host: c.host,
            topic: c.topic,
            score: c.importance_score,
            url: c.url,
          })),
          ...(ops ? [{
            source: ops.source,
            host: ops.host,
            topic: ops.topic,
            score: ops.importance_score,
            url: ops.url,
            ops: true,
          }] : []),
        ],
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS, budget: BUDGET_MS, min_ai_remain: MIN_AI_REMAIN_MS },
        remaining_ms_before_return: remain(),
      };
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      generated_at: nowIso(),
      version: BUILD_ID,
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
}
