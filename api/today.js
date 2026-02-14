import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

const BUILD_ID = "FULL_RSS_GUARDIAN_V3_PERFORMANCE_ENHANCED";

// ====== Tunables (調整変数) ======
const FETCH_TIMEOUT_MS = 4500;   
const OPENAI_TIMEOUT_MS = 15000; // 4o-miniの推論時間を考慮し少し延長
const RSS_PER_FEED = 6;          
const OUTPUT_ITEMS = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;

// ====== Sources (取得元) ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, topicHint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, topicHint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, topicHint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.85, topicHint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, topicHint: "japan" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.75, topicHint: "product" },
];

const ALLOW_HOSTS = [
  "theguardian.com", "openai.com", "anthropic.com", "deepmind.google", 
  "techcrunch.com", "itmedia.co.jp", "ainow.ai"
];

// ====== In-memory cache ======
let CACHE = { at: 0, payload: null, etag: "" };

// ====== Utils (便利関数) ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    [...params.keys()].forEach(k => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    u.hash = "";
    return u.toString();
  } catch { return (raw || "").trim(); }
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

// ====== Scoring Logic ======
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();
  if (/regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法/.test(t)) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  return hint || "other";
}

function scoreCandidate(c) {
  let s = 45;
  s += Math.round((c.weight || 0.8) * 20);
  if (c.jp) s += 15;
  if (/japan|日本|国内|経産省|総務省/.test(c.title || "")) s += 10;
  
  const topicBonus = { regulation: 18, funding: 12, supply_chain: 14, product: 10, research: 8 };
  s += topicBonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));
  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 18 : 10),
      confidence: 10
    }
  };
}

// ====== Data Fetchers ======
async function fetchGuardian(key) {
  const url = `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=8&show-fields=trailText&api-key=${encodeURIComponent(key)}`;
  try {
    const res = await timeoutFetch(url);
    const data = await res.json();
    return (data?.response?.results || []).map(a => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle,
      summary: (a.fields?.trailText || "").replace(/<[^>]*>?/gm, '').trim(),
      jp: false,
      weight: 0.95,
      topicHint: "market"
    }));
  } catch { return []; }
}

async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url);
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    return feed.items.slice(0, RSS_PER_FEED).map(it => ({
      source: src.name,
      url: normalizeUrl(it.link),
      title: it.title,
      summary: (it.contentSnippet || it.content || "").slice(0, 500),
      jp: !!src.jp,
      weight: src.weight,
      topicHint: src.topicHint
    }));
  } catch { return []; }
}

// ====== OpenAI Integration ======
async function callOpenAI(apiKey, picked) {
  const userPrompt = `以下の3記事を日本市場の視点で構造化JSONにしてください。itemsは必ず3件。
${JSON.stringify(picked)}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "AI戦略ニュース編集者として、構造化された日本語JSONのみを返してください。煽り禁止。" },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3
      })
    });
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  } catch (e) { throw e; }
}

// ====== Main Handler ======
export default async function handler(req, res) {
  // 1. CORS & Methods
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  
  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey || !oKey) return res.status(500).json({ error: "Missing API Keys" });

  // 2. Cache Check
  if (CACHE.payload && (Date.now() - CACHE.at < CACHE_TTL_MS)) {
    return res.status(200).json(CACHE.payload);
  }

  try {
    const parser = new Parser();
    
    // 3. Parallel Fetching (ここが高速化のポイント)
    const [guardianResults, ...rssResultsArray] = await Promise.all([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map(src => fetchRssSafe(parser, src))
    ]);
    
    const allCandidates = [...guardianResults, ...rssResultsArray.flat()];

    // 4. Dedupe & Scoring
    const uniq = new Map();
    allCandidates.forEach(c => {
      const url = normalizeUrl(c.url);
      if (!uniq.has(url)) {
        const topic = guessTopic(c.title, c.topicHint);
        const { score, breakdown } = scoreCandidate({ ...c, topic });
        uniq.set(url, { ...c, url, topic, importance_score: score, score_breakdown: breakdown });
      }
    });

    // 5. Diversity Selection
    const sorted = [...uniq.values()].sort((a, b) => b.importance_score - a.importance_score);
    const picked = sorted.slice(0, OUTPUT_ITEMS); // 簡易化のため上位3件

    // 6. OpenAI Analysis
    let finalPayload;
    try {
      finalPayload = await callOpenAI(oKey, picked);
    } catch {
      // Fallback
      finalPayload = { items: picked.map(p => ({ title_ja: p.title, original_url: p.url, source: p.source })) };
    }

    // 7. Finalize & Cache
    finalPayload.generated_at = new Date().toISOString();
    finalPayload.version = BUILD_ID;
    
    const etag = `"${sha1Like(JSON.stringify(finalPayload))}"`;
    CACHE = { at: Date.now(), payload: finalPayload, etag };

    return res.status(200).json(finalPayload);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
