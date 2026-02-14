// /api/today.js
// AI Impact Brief — Today API (FULL v1.2)
// ✅ Guardian + RSS(Multi-source) ハイブリッド
// ✅ 鮮度フィルタ（ソース別）で「古い記事混入」を止める
// ✅ RSS本文が薄いときは meta description / og:description で軽量補完
// ✅ トピック分散（規制/資金/プロダクト/労働/研究…）で“3本が被らない”
// ✅ 日本市場視点のスコア（公開前提）を付与
// ✅ CORS / キャッシュ / デバッグ
//
// Requirements (package.json):
//   npm i rss-parser
//
// Env:
//   GUARDIAN_API_KEY (optional)
//   OPENAI_API_KEY   (required)
//   WEB_ORIGIN_ALLOW (optional, e.g. https://ai-impact-brief.vercel.app)

const Parser = require("rss-parser");

// ---------- In-memory cache (best-effort, per instance) ----------
const CACHE = {
  key: null,
  value: null,
  expiresAt: 0,
};
const CACHE_TTL_MS = 20 * 60 * 1000; // 20min

// ---------- Source config ----------
const RSS_SOURCES = [
  // JP
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", maxAgeHours: 72, weight: 1.0, jp: true },
  { name: "AINOW", url: "https://ainow.ai/feed/", maxAgeHours: 168, weight: 0.75, jp: true },

  // Global official
  { name: "OpenAI Blog", url: "https://openai.com/blog/rss/", maxAgeHours: 336, weight: 1.0, jp: false },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/", maxAgeHours: 336, weight: 1.0, jp: false },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", maxAgeHours: 504, weight: 1.0, jp: false },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", maxAgeHours: 336, weight: 0.9, jp: false },

  // Tech media
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", maxAgeHours: 72, weight: 0.9, jp: false },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", maxAgeHours: 72, weight: 0.85, jp: false },
];

const DEFAULT_WINDOW_HOURS = 72;

// ---------- Utilities ----------
function nowISO() {
  return new Date().toISOString();
}

function toISODate(d = new Date()) {
  // YYYY-MM-DD in JST (Japan focus)
  const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const day = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeText(s) {
  return String(s || "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    // remove utm_*
    const qp = new URLSearchParams(u.search);
    for (const k of Array.from(qp.keys())) {
      if (k.toLowerCase().startsWith("utm_")) qp.delete(k);
    }
    u.search = qp.toString() ? `?${qp.toString()}` : "";
    // normalize
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    // trim trailing slash (keep root)
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function parseTimeMs(t) {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function ageHoursFrom(publishedAt) {
  const ms = parseTimeMs(publishedAt);
  if (!ms) return null;
  return (Date.now() - ms) / 3600000;
}

function withinMaxAge(publishedAt, maxAgeHours) {
  const ageH = ageHoursFrom(publishedAt);
  if (ageH == null) return false; // 日付不明は落とす（精度優先）
  return ageH <= maxAgeHours;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pickPublished(entry) {
  // rss-parser: isoDate / pubDate. sometimes "published" / "updated" are present in custom feeds
  const candidates = [
    entry.isoDate,
    entry.pubDate,
    entry.published,
    entry.updated,
    entry.date,
  ].filter(Boolean);

  for (const c of candidates) {
    const ms = parseTimeMs(c);
    if (ms) return new Date(ms).toISOString();
  }
  return null;
}

function timeoutFetch(url, opts = {}, ms = 9000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal })
    .finally(() => clearTimeout(id));
}

function cors(req, res) {
  const allow = process.env.WEB_ORIGIN_ALLOW;
  const origin = req.headers.origin;

  // if allow is set, reflect only matching origin; else allow all
  const allowOrigin = allow ? (origin === allow ? origin : allow) : (origin || "*");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");

  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ---------- Topic + scoring heuristics (fast, deterministic) ----------
const TOPIC_RULES = [
  { topic: "regulation", re: /\b(regulat|law|act|ban|antitrust|commission|eu|policy|governance|compliance|copyright|著作権|規制|法案|独禁|委員会)\b/i, base: 78 },
  { topic: "funding", re: /\b(fund|funding|raised|round|valuation|ipo|vc|venture|投資|資金調達|評価額|上場)\b/i, base: 76 },
  { topic: "chips", re: /\b(chip|gpu|semiconductor|export control|h100|supply chain|半導体|gpu|輸出規制)\b/i, base: 74 },
  { topic: "product", re: /\b(product|launch|release|feature|model|agent|api|platform|tool|プロダクト|リリース|機能|モデル|エージェント)\b/i, base: 66 },
  { topic: "labor", re: /\b(job|labor|worker|employment|wage|career|education|仕事|雇用|労働|人材|教育|研修)\b/i, base: 64 },
  { topic: "research", re: /\b(paper|benchmark|dataset|arxiv|research|論文|研究|ベンチマーク)\b/i, base: 62 },
];

function classifyTopic(text) {
  const t = String(text || "");
  for (const r of TOPIC_RULES) if (r.re.test(t)) return r.topic;
  return "other";
}

function baseImportance(topic) {
  const r = TOPIC_RULES.find(x => x.topic === topic);
  return r ? r.base : 58;
}

function scoreArticle(a) {
  const text = `${a.original_title} ${a.body || ""}`;
  const topic = a.topic || classifyTopic(text);

  // market/business are split but tied to topic + source weight + text strength
  const srcW = a.source_weight || 0.85;
  const len = (a.body || "").length;

  const marketImpact = clamp(
    Math.round((topic === "regulation" ? 40 : topic === "funding" ? 34 : topic === "chips" ? 36 : 22) * srcW),
    10, 45
  );

  const businessImpact = clamp(
    Math.round((topic === "product" ? 30 : topic === "funding" ? 28 : topic === "labor" ? 26 : 20) * srcW),
    10, 40
  );

  const japanRelevance = clamp(
    (a.jp ? 26 : 10) + (/\b(japan|tokyo|日本|日系)\b/i.test(text) ? 6 : 0),
    5, 35
  );

  // confidence: body length + source type
  const confidence = clamp(
    Math.round((len >= 2500 ? 12 : len >= 1200 ? 10 : len >= 600 ? 8 : 6) * srcW),
    5, 12
  );

  const importance = clamp(
    Math.round(baseImportance(topic) + (marketImpact + businessImpact + japanRelevance) / 10 - (12 - confidence)),
    45, 95
  );

  return {
    topic,
    importance_score: importance,
    score_breakdown: {
      market_impact: marketImpact,
      business_impact: businessImpact,
      japan_relevance: japanRelevance,
      confidence,
    },
  };
}

function inferImpactLevel(importance) {
  if (importance >= 80) return "High";
  if (importance >= 60) return "Medium";
  return "Low";
}

// ---------- Lightweight meta enrichment (only if thin) ----------
async function enrichWithMetaIfThin(article) {
  const minLen = 700;
  if ((article.body || "").length >= minLen) return article;

  // Avoid expensive fetch for some hosts that block often
  const host = article.host || "";
  if (/reddit\.com|x\.com|twitter\.com/i.test(host)) return article;

  try {
    const r = await timeoutFetch(article.original_url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } }, 9000);
    if (!r.ok) return article;

    const html = await r.text();
    const og = html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1];
    const desc = html.match(/name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1];
    const extra = safeText(og || desc || "");

    if (extra && extra.length > 80) {
      const merged = safeText(`${article.body || ""} ${extra}`).slice(0, 7000);
      if (merged.length > (article.body || "").length) {
        return { ...article, body: merged, meta_enriched: true };
      }
    }
  } catch (_) {}
  return article;
}

// ---------- Fetch: Guardian ----------
async function fetchGuardianArticles(guardianKey, { limit = 8 } = {}) {
  if (!guardianKey) return [];

  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=${encodeURIComponent(limit)}` +
    `&show-fields=headline,trailText,bodyText,byline` +
    `&api-key=${encodeURIComponent(guardianKey)}`;

  const r = await timeoutFetch(url, { method: "GET" }, 10000);
  if (!r.ok) return [];

  const data = await r.json().catch(() => null);
  const results = data?.response?.results;
  if (!Array.isArray(results)) return [];

  return results.map((a) => {
    const body = safeText(String(a?.fields?.bodyText || a?.fields?.trailText || ""));
    const link = normalizeUrl(a.webUrl || "");
    const host = (() => { try { return new URL(link).hostname; } catch { return ""; } })();

    return {
      source: "The Guardian",
      source_weight: 0.92,
      jp: false,
      original_title: String(a.webTitle || "").trim(),
      original_url: link,
      host,
      published_at: a.webPublicationDate ? new Date(a.webPublicationDate).toISOString() : null,
      body: body.slice(0, 9000),
    };
  });
}

// ---------- Fetch: RSS ----------
async function fetchRssFeed(parser, { name, url, weight, jp, maxAgeHours }, { maxItems = 12 } = {}) {
  try {
    const feed = await parser.parseURL(url);
    const items = Array.isArray(feed?.items) ? feed.items : [];
    const out = [];

    for (const e of items.slice(0, maxItems)) {
      const title = safeText(e.title || "");
      const link = normalizeUrl(e.link || e.guid || "");
      if (!title || !link) continue;

      const publishedAt = pickPublished(e);
      // strict freshness: no date -> drop
      if (!publishedAt) continue;
      if (!withinMaxAge(publishedAt, maxAgeHours ?? DEFAULT_WINDOW_HOURS)) continue;

      const raw =
        safeText(e.content || "") ||
        safeText(e["content:encoded"] || "") ||
        safeText(e.contentSnippet || "") ||
        safeText(e.summary || "") ||
        safeText(e.description || "");

      const body = raw.slice(0, 6000);
      const host = (() => { try { return new URL(link).hostname; } catch { return ""; } })();

      out.push({
        source: name,
        source_weight: weight ?? 0.85,
        jp: !!jp,
        original_title: title,
        original_url: link,
        host,
        published_at: publishedAt,
        body,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- Dedupe ----------
function dedupeByUrl(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const u = normalizeUrl(a.original_url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push({ ...a, original_url: u });
  }
  return out;
}

// ---------- Pick 3 diverse, high quality ----------
function pickTopDiverse(articles, { want = 3 } = {}) {
  // score + topic
  const scored = articles.map(a => {
    const topic = a.topic || classifyTopic(`${a.original_title} ${a.body || ""}`);
    const s = scoreArticle({ ...a, topic });
    return { ...a, topic, ...s };
  });

  // sort by importance, then by freshness, then by source weight
  scored.sort((a, b) => {
    const ds = (b.importance_score - a.importance_score);
    if (ds !== 0) return ds;

    const at = parseTimeMs(a.published_at) || 0;
    const bt = parseTimeMs(b.published_at) || 0;
    if (bt !== at) return bt - at;

    return (b.source_weight || 0) - (a.source_weight || 0);
  });

  const picked = [];
  const usedTopics = new Set();
  const usedHosts = new Set();

  // 1st pass: unique topic + avoid same host dominance
  for (const a of scored) {
    if (picked.length >= want) break;
    if (usedTopics.has(a.topic)) continue;
    if (usedHosts.has(a.host) && picked.length < 2) continue; // 1〜2本目は分散
    picked.push(a);
    usedTopics.add(a.topic);
    usedHosts.add(a.host);
  }

  // 2nd pass: fill remaining
  for (const a of scored) {
    if (picked.length >= want) break;
    if (picked.some(x => x.original_url === a.original_url)) continue;
    picked.push(a);
  }

  return picked.slice(0, want);
}

// ---------- OpenAI JSON generation ----------
async function callOpenAI(openaiKey, { articles, dateISO }) {
  const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
感情的・扇動的な表現は禁止。断定しすぎない。
出力は「有効なJSONのみ」。説明文やMarkdownは禁止。
`.trim();

  const userPrompt = `
以下のニュース候補から「テーマが被らない3本」を選び、日本語で上質に構造化してください。
併せて「日本市場視点のスコア」を公開前提で整合させてください（importance_score/score_breakdownは候補の値をベースに微調整可）。

【ルール】
- itemsは必ず3件
- 3本はサブテーマが被らない（規制/資金/半導体/プロダクト/労働/研究など）
- 煽り禁止、断定しすぎない、客観的に
- impact_level: Highは最大1件（本当に構造的影響が明確なときのみ）
- fact_summary/implications/outlook: 各2〜4項目、1項目50文字以内推奨
- japan_impact は「日本企業/規制/市場」視点で具体的に
- スコア:
  - market_impact (0-45)
  - business_impact (0-40)
  - japan_relevance (0-35)
  - confidence (0-12)

【出力形式（厳守）】
{
  "date_iso": "${dateISO}",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "importance_score": 0,
      "score_breakdown": { "market_impact":0,"business_impact":0,"japan_relevance":0,"confidence":0 },
      "title_ja": "",
      "one_sentence": "",
      "why_it_matters": "",
      "japan_impact": "",
      "tags": [],
      "fact_summary": [],
      "implications": [],
      "outlook": [],
      "original_title": "",
      "original_url": "",
      "published_at": "",
      "source": ""
    }
  ]
}

Candidates JSON:
${JSON.stringify(articles)}
`.trim();

  const r = await timeoutFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }, 15000);

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status} ${r.statusText}: ${t.slice(0, 300)}`);
  }

  const data = await r.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI missing content");

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
    throw new Error("OpenAI returned non-JSON");
  }

  // Fix common schema accidents
  if (payload?.items && Array.isArray(payload.items)) {
    payload.items = payload.items.map((it) => {
      if (it["why_it.matters"] && !it.why_it_matters) {
        it.why_it_matters = it["why_it.matters"];
        delete it["why_it.matters"];
      }
      return it;
    });
  }

  return payload;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const cacheBust = urlObj.searchParams.get("v");

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    const guardianKey = process.env.GUARDIAN_API_KEY || "";

    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

    const cacheKey = `latest::${toISODate()}::v1.2`;
    if (!cacheBust && CACHE.key === cacheKey && CACHE.value && Date.now() < CACHE.expiresAt) {
      const cached = CACHE.value;
      return res.status(200).json({
        ...cached,
        cache: { hit: true, key: "latest.json", at: nowISO(), ttl_seconds: Math.floor((CACHE.expiresAt - Date.now()) / 1000) },
      });
    }

    // 1) Collect candidates (Guardian + RSS)
    const parser = new Parser({
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const [guardian, ...rssLists] = await Promise.all([
      fetchGuardianArticles(guardianKey, { limit: 10 }),
      ...RSS_SOURCES.map((s) => fetchRssFeed(parser, s, { maxItems: 14 })),
    ]);

    let merged = dedupeByUrl([...(guardian || []), ...rssLists.flat()]);
    const mergedCount = merged.length;

    // 2) Hard freshness guardrail (final) — drop anything older than 10 days even if a source mislabels
    merged = merged.filter(a => withinMaxAge(a.published_at, 240)); // 10 days

    // 3) Pick diverse 3 (pre-enrich)
    let picked = pickTopDiverse(merged, { want: 3 });

    // 4) Meta enrichment (only on the picked 3, sequential, lightweight)
    const enriched = [];
    for (const a of picked) enriched.push(await enrichWithMetaIfThin(a));
    picked = enriched;

    // 5) Re-score after enrichment (confidence can change)
    picked = picked.map(a => {
      const s = scoreArticle(a);
      return {
        ...a,
        ...s,
        impact_level: inferImpactLevel(s.importance_score),
      };
    });

    // Ensure only one High (deterministic)
    picked.sort((a, b) => b.importance_score - a.importance_score);
    const highs = picked.filter(x => x.impact_level === "High");
    if (highs.length > 1) {
      // downgrade all but top one
      let keep = true;
      picked = picked.map(x => {
        if (x.impact_level !== "High") return x;
        if (keep) { keep = false; return x; }
        return { ...x, impact_level: "Medium" };
      });
    }

    // 6) OpenAI: produce final structured brief (with score included)
    const dateISO = toISODate();
    const candidatesForLLM = picked.map(a => ({
      source: a.source,
      original_title: a.original_title,
      original_url: a.original_url,
      published_at: a.published_at,
      topic: a.topic,
      jp: a.jp,
      score_seed: {
        impact_level: a.impact_level,
        importance_score: a.importance_score,
        score_breakdown: a.score_breakdown,
      },
      body: (a.body || "").slice(0, 7000),
    }));

    const payload = await callOpenAI(openaiKey, { articles: candidatesForLLM, dateISO });

    // 7) Validate / normalize output
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (items.length !== 3) throw new Error("Schema invalid: items must be 3");

    // Fill safety fields + force numeric ranges
    const normalizedItems = items.map((it) => {
      const sb = it.score_breakdown || {};
      const market = clamp(Number(sb.market_impact || 0), 0, 45);
      const biz = clamp(Number(sb.business_impact || 0), 0, 40);
      const jp = clamp(Number(sb.japan_relevance || 0), 0, 35);
      const conf = clamp(Number(sb.confidence || 0), 0, 12);
      const imp = clamp(Number(it.importance_score || 0), 0, 100);

      const level = String(it.impact_level || "Medium");
      const lvl = level === "High" || level === "Low" ? level : "Medium";

      return {
        impact_level: lvl,
        importance_score: imp,
        score_breakdown: { market_impact: market, business_impact: biz, japan_relevance: jp, confidence: conf },
        title_ja: String(it.title_ja || "").trim(),
        one_sentence: String(it.one_sentence || "").trim(),
        why_it_matters: String(it.why_it_matters || "").trim(),
        japan_impact: String(it.japan_impact || "").trim(),
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 6).map(s => String(s).trim()).filter(Boolean) : [],
        fact_summary: Array.isArray(it.fact_summary) ? it.fact_summary.slice(0, 4).map(s => String(s).trim()).filter(Boolean) : [],
        implications: Array.isArray(it.implications) ? it.implications.slice(0, 4).map(s => String(s).trim()).filter(Boolean) : [],
        outlook: Array.isArray(it.outlook) ? it.outlook.slice(0, 4).map(s => String(s).trim()).filter(Boolean) : [],
        original_title: String(it.original_title || "").trim(),
        original_url: normalizeUrl(it.original_url || ""),
        published_at: it.published_at ? new Date(it.published_at).toISOString() : null,
        source: String(it.source || "").trim(),
      };
    });

    // enforce "High max 1" again
    const hiCount = normalizedItems.filter(x => x.impact_level === "High").length;
    if (hiCount > 1) {
      let kept = false;
      for (const it of normalizedItems) {
        if (it.impact_level === "High") {
          if (!kept) kept = true;
          else it.impact_level = "Medium";
        }
      }
    }

    // sort High→Medium→Low for UI
    const order = { High: 3, Medium: 2, Low: 1 };
    normalizedItems.sort((a, b) => (order[b.impact_level] || 0) - (order[a.impact_level] || 0));

    const result = {
      date_iso: dateISO,
      items: normalizedItems,
      generated_at: nowISO(),
      version: "FULL-RSS-GUARDIAN-1.2",
      sources: Array.from(new Set(normalizedItems.map(x => x.source))).filter(Boolean),
      build_id: `TODAY_API__${dateISO}__FULL_RSS_GUARDIAN_V12`,
    };

    // cache
    CACHE.key = cacheKey;
    CACHE.value = result;
    CACHE.expiresAt = Date.now() + CACHE_TTL_MS;

    if (debug) {
      return res.status(200).json({
        ...result,
        cache: { hit: false, key: "latest.json", at: nowISO(), ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
        debug: {
          merged_count: mergedCount,
          after_freshness_count: merged.length,
          picked: picked.map(a => ({
            source: a.source,
            host: a.host,
            topic: a.topic,
            original_title: a.original_title,
            original_url: a.original_url,
            published_at: a.published_at,
            body_length: (a.body || "").length,
            meta_enriched: !!a.meta_enriched,
            importance_score: a.importance_score,
            score_breakdown: a.score_breakdown,
          })),
          rss_sources: RSS_SOURCES,
        },
      });
    }

    return res.status(200).json({
      ...result,
      cache: { hit: false, key: "latest.json", at: nowISO(), ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      generated_at: nowISO(),
      version: "FULL-RSS-GUARDIAN-1.2",
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
};
