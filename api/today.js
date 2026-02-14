import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

// =========================
// Config
// =========================
const BUILD_ID = "FULL_RSS_GUARDIAN_V2";

const GUARDIAN_SECTION = "technology";
const GUARDIAN_PAGE_SIZE = 8;

const RSS_SOURCES = [
  // 企業公式
  { name: "OpenAI", url: "https://openai.com/blog/rss/", topicHint: "product", jp: false, weight: 1.0 },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", topicHint: "product", jp: false, weight: 0.95 },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", topicHint: "research", jp: false, weight: 0.9 },

  // メディア
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", topicHint: "market", jp: false, weight: 0.9 },

  // 日本語
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", topicHint: "japan", jp: true, weight: 1.0 },
  { name: "AINOW", url: "https://ainow.ai/feed/", topicHint: "product", jp: true, weight: 0.8 },
];

const ALLOW_HOSTS = [
  "theguardian.com",
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "techcrunch.com",
  "itmedia.co.jp",
  "ainow.ai",
];

const FETCH_TIMEOUT_MS = 8000;
const OPENAI_TIMEOUT_MS = 14000;

const MAX_RSS_ITEMS_PER_FEED = 10;
const OUTPUT_ITEMS = 3;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// =========================
// Tiny in-memory cache (per lambda instance)
// =========================
let CACHE = { at: 0, payload: null, etag: "" };

// =========================
// Utils
// =========================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha1Like(s) {
  // Lightweight hash (not cryptographic) for ETag
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function fetchWithRetry(url, opts, timeoutMs, retries = 2, baseDelayMs = 400) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await timeoutFetch(url, opts, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const wait = baseDelayMs * Math.pow(2, i);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    // remove utm_*
    const params = new URLSearchParams(u.search);
    for (const k of [...params.keys()]) {
      if (k.toLowerCase().startsWith("utm_")) params.delete(k);
    }
    u.search = params.toString() ? `?${params.toString()}` : "";
    // remove trailing slash (except "/")
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    u.hash = "";
    return u.toString();
  } catch {
    return (raw || "").trim();
  }
}

function hostAllowed(url) {
  try {
    const h = new URL(url).hostname;
    return ALLOW_HOSTS.some((x) => h.includes(x));
  } catch {
    return false;
  }
}

function guessTopic(title, sourceHint) {
  const t = (title || "").toLowerCase();
  if (/regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法/.test(t)) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|gpu|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  if (sourceHint) return sourceHint;
  return "other";
}

function scoreCandidate(c) {
  // Base
  let s = 45;

  // Source weighting
  s += Math.round((c.weight || 0.8) * 20);

  // Japan relevance
  if (c.jp) s += 15;
  if (/japan|日本|国内|経産省|総務省|金融庁|日銀/.test(c.title || "")) s += 10;

  // Topic impact
  if (c.topic === "regulation") s += 18;
  if (c.topic === "funding") s += 12;
  if (c.topic === "supply_chain") s += 14;
  if (c.topic === "product") s += 10;
  if (c.topic === "research") s += 8;

  // Title quality
  if ((c.title || "").length >= 30) s += 3;

  // Cap
  if (s > 95) s = 95;
  if (s < 0) s = 0;

  // breakdown (simple)
  const breakdown = {
    market_impact: Math.min(40, Math.max(0, Math.round(s * 0.4))),
    business_impact: Math.min(30, Math.max(0, Math.round(s * 0.3))),
    japan_relevance: Math.min(25, c.jp ? 18 : 10),
    confidence: Math.min(15, 10),
  };

  return { score: s, breakdown };
}

function impactFromScore(s) {
  if (s >= 78) return "High";
  if (s >= 60) return "Medium";
  return "Low";
}

// =========================
// Fetch: Guardian
// =========================
async function fetchGuardian(guardianKey) {
  const url =
    "https://content.guardianapis.com/search" +
    `?section=${encodeURIComponent(GUARDIAN_SECTION)}` +
    `&order-by=newest&page-size=${GUARDIAN_PAGE_SIZE}` +
    `&show-fields=headline,trailText` +
    `&api-key=${encodeURIComponent(guardianKey)}`;

  const res = await fetchWithRetry(url, {}, FETCH_TIMEOUT_MS, 2);
  if (!res.ok) return [];

  const data = await res.json().catch(() => null);
  const results = data?.response?.results || [];

  return results.map((a) => ({
    source: "The Guardian",
    url: normalizeUrl(a.webUrl || ""),
    title: (a.webTitle || "").trim(),
    summary: (a.fields?.trailText || "").replace(/\s+/g, " ").trim(),
    jp: false,
    weight: 0.95,
    published_at: a.webPublicationDate || null,
    topicHint: "market",
  }));
}

// =========================
// Fetch: RSS (sequential-safe)
// =========================
async function fetchRss(parser, src) {
  try {
    const feed = await parser.parseURL(src.url);
    const items = (feed.items || []).slice(0, MAX_RSS_ITEMS_PER_FEED);

    return items
      .map((it) => ({
        source: src.name,
        url: normalizeUrl(it.link || ""),
        title: (it.title || "").trim(),
        summary: (it.contentSnippet || it.content || "").replace(/\s+/g, " ").trim().slice(0, 500),
        jp: !!src.jp,
        weight: src.weight ?? 0.8,
        published_at: it.isoDate || it.pubDate || null,
        topicHint: src.topicHint || "other",
      }))
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

// =========================
// Pick 3 items with topic diversity
// =========================
function pickDiverseTop(candidates) {
  // add topic + score
  const enriched = candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.topicHint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return { ...c, topic, importance_score: score, score_breakdown: breakdown };
    })
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedTopics = new Set();
  const usedHosts = new Set();

  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;

    let host = "";
    try { host = new URL(c.url).hostname; } catch {}
    const hostKey = host.replace(/^www\./, "");
    const topicOk = !usedTopics.has(c.topic) || usedTopics.size < 2; // allow a little reuse
    const hostOk = !usedHosts.has(hostKey) || usedHosts.size < 2; // avoid single-site monopoly

    if (topicOk && hostOk) {
      picked.push(c);
      usedTopics.add(c.topic);
      if (hostKey) usedHosts.add(hostKey);
    }
  }

  // fallback: fill if not enough
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    const c = enriched[i++];
    if (!picked.find((p) => p.url === c.url)) picked.push(c);
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

// =========================
// OpenAI: format into your schema
// =========================
async function callOpenAI(openaiKey, picked) {
  const system = `
あなたは「構造で読む、AI戦略ニュース」の編集者です。
煽り禁止。断定しすぎない。出力は有効なJSONのみ。
`.trim();

  const user = `
以下の3記事を、日本市場の視点で「構造化ブリーフ」にしてください。
必ず items は3件。impact_level は High は最大1件。

出力形式:
{
  "date_iso":"YYYY-MM-DD",
  "items":[
    {
      "impact_level":"High|Medium|Low",
      "importance_score":0,
      "score_breakdown":{"market_impact":0,"business_impact":0,"japan_relevance":0,"confidence":0},
      "title_ja":"",
      "one_sentence":"",
      "why_it_matters":"",
      "japan_impact":"",
      "tags":[],
      "fact_summary":[],
      "implications":[],
      "outlook":[],
      "original_title":"",
      "original_url":"",
      "source":""
    }
  ]
}

入力（picked）:
${JSON.stringify(picked, null, 2)}
`.trim();

  const res = await fetchWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.25,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    OPENAI_TIMEOUT_MS,
    1
  );

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";

  const cleaned = String(raw)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  let payload;
  try {
    payload = JSON.parse(cleaned);
  } catch {
    // fallback: create minimal payload
    payload = {
      date_iso: new Date().toISOString().slice(0, 10),
      items: [],
    };
  }

  return payload;
}

// =========================
// Handler
// =========================
export default async function handler(req, res) {
  // ---- CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const guardianKey = process.env.GUARDIAN_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!guardianKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const nocache = urlObj.searchParams.get("nocache") === "1";

  // ---- Cache (ETag) ----
  if (!nocache && CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    const inm = req.headers["if-none-match"];
    res.setHeader("ETag", CACHE.etag);
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_MS / 1000}`);
    if (inm && inm === CACHE.etag) return res.status(304).end();
    return res.status(200).json(CACHE.payload);
  }

  try {
    const parser = new Parser();

    const candidates = [];
    const g = await fetchGuardian(guardianKey);
    candidates.push(...g);

    // RSSは「逐次」(落ちない)
    for (const src of RSS_SOURCES) {
      const list = await fetchRss(parser, src);
      candidates.push(...list);
    }

    // allowlist + unique by url
    const uniq = new Map();
    for (const c of candidates) {
      if (!c.url || !c.title) continue;
      if (!hostAllowed(c.url)) continue;
      const key = normalizeUrl(c.url);
      if (!uniq.has(key)) uniq.set(key, { ...c, url: key });
    }
    const merged = [...uniq.values()];

    const picked = pickDiverseTop(merged);

    // OpenAI整形
    let payload = await callOpenAI(openaiKey, picked);

    // normalize / ensure schema
    const today = new Date().toISOString().slice(0, 10);
    if (!payload || typeof payload !== "object") payload = {};
    payload.date_iso = payload.date_iso || today;
    payload.items = Array.isArray(payload.items) ? payload.items : [];

    // ensure items = 3 (fallback)
    if (payload.items.length !== OUTPUT_ITEMS) {
      payload.items = picked.slice(0, OUTPUT_ITEMS).map((p) => ({
        impact_level: impactFromScore(p.importance_score),
        importance_score: p.importance_score,
        score_breakdown: p.score_breakdown,
        title_ja: p.title,
        one_sentence: p.summary?.slice(0, 60) || "",
        why_it_matters: "",
        japan_impact: "",
        tags: [p.topic],
        fact_summary: [],
        implications: [],
        outlook: [],
        original_title: p.title,
        original_url: p.url,
        source: p.source,
      }));
    }

    // Enforce “High max 1”
    const highs = payload.items.filter((x) => x.impact_level === "High");
    if (highs.length > 1) {
      // keep top 1 by score, downgrade others
      payload.items.sort((a, b) => (b.importance_score || 0) - (a.importance_score || 0));
      let highKept = false;
      payload.items = payload.items.map((it) => {
        if (it.impact_level === "High") {
          if (!highKept) { highKept = true; return it; }
          return { ...it, impact_level: "Medium" };
        }
        return it;
      });
    }

    payload.generated_at = new Date().toISOString();
    payload.version = BUILD_ID;
    payload.sources = [...new Set(picked.map((p) => p.source))];
    payload.build_id = `${BUILD_ID}__${payload.date_iso}`;

    if (debug) {
      payload.debug = {
        picked: picked.map((p) => ({
          source: p.source,
          host: (() => { try { return new URL(p.url).hostname; } catch { return ""; } })(),
          topic: p.topic,
          original_title: p.title,
          original_url: p.url,
          score: p.importance_score,
        })),
        merged_count: merged.length,
        allowlist_size: ALLOW_HOSTS.length,
      };
    }

    // cache set
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_MS / 1000}`);

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
    });
  }
}
