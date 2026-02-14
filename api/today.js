import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V4_FINAL";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 5000;   
const OPENAI_TIMEOUT_MS = 15000; 
const OUTPUT_ITEMS = 3;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分

// ====== データソース設定 ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

const ALLOW_HOSTS = ["theguardian.com", "openai.com", "anthropic.com", "deepmind.google", "techcrunch.com", "itmedia.co.jp", "ainow.ai"];

let CACHE = { at: 0, payload: null, etag: "" };

// ====== ユーティリティ ======
const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); }
  return (h >>> 0).toString(16);
};

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach(k => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch { return (raw || "").trim(); }
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/**
 * トピック推定ロジック (日本語の誤検知対策済み)
 */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();
  // 「方法」「手法」を除外した「法」にのみ反応させる (Lookbehindを使用)
  const isRegulation = /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録/.test(t)) return "product";
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
  if (/japan|日本|国内|公取委|総務省|経産省/.test(c.title || "")) s += 15;
  
  const bonus = { regulation: 20, funding: 15, supply_chain: 15, product: 5, research: 5 };
  s += bonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));
  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 5
    }
  };
}

// ====== データ取得関数 (並列化対応) ======
async function fetchGuardian(key) {
  const url = `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=10&show-fields=trailText&api-key=${encodeURIComponent(key)}`;
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
      hint: "market"
    }));
  } catch { return []; }
}

async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url);
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    return feed.items.slice(0, 8).map(it => ({
      source: src.name,
      url: normalizeUrl(it.link),
      title: it.title,
      summary: (it.contentSnippet || it.content || "").slice(0, 500).replace(/\s+/g, " "),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint
    }));
  } catch { return []; }
}

/**
 * 多様性を維持したトップ選出
 */
function pickDiverseTop(candidates) {
  const enriched = candidates.map(c => {
    const topic = guessTopic(c.title, c.hint);
    const { score, breakdown } = scoreCandidate({ ...c, topic });
    return { ...c, topic, importance_score: score, score_breakdown: breakdown };
  }).sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    let host = ""; try { host = new URL(c.url).hostname; } catch {}
    
    // 同一ホストNG、同一トピック制限（1つまで）
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    if (!picked.find(p => p.url === enriched[i].url)) picked.push(enriched[i]);
    i++;
  }
  return picked.slice(0, OUTPUT_ITEMS);
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey || !oKey) return res.status(500).json({ error: "Missing API Keys" });

  if (CACHE.payload && (Date.now() - CACHE.at < CACHE_TTL_MS)) {
    return res.status(200).json(CACHE.payload);
  }

  try {
    const parser = new Parser();
    
    // 1. 並列取得 (パフォーマンス最適化)
    const results = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map(src => fetchRssSafe(parser, src))
    ]);
    
    const allCandidates = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(c => ALLOW_HOSTS.some(h => c.url.includes(h)));

    // 2. 多様性ベースの選出
    const picked = pickDiverseTop(allCandidates);

    // 3. OpenAI による構造化ブリーフィング
    let payload;
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${oKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "あなたは戦略的AIコンサルタントです。提供されたニュースを日本市場の視点で分析し、JSON形式で返してください。日本語タイトル(title_ja)、1行要約(one_sentence)、日本への影響(japan_impact)、今後の展望(outlook)を含めてください。" },
            { role: "user", content: JSON.stringify(picked) }
          ],
          response_format: { type: "json_object" },
          temperature: 0.2
        })
      });
      payload = await response.json();
      payload = JSON.parse(payload.choices[0].message.content);
    } catch {
      // 失敗時のフォールバック
      payload = { items: picked.map(p => ({ title_ja: p.title, original_url: p.url, source: p.source })) };
    }

    // 4. メタデータの付与
    payload.generated_at = new Date().toISOString();
    payload.version = BUILD_ID;
    payload.build_id = `${BUILD_ID}__${new Date().toISOString().slice(0, 10)}`;

    // キャッシュ更新
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    return res.status(200).json(payload);

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
