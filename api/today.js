// /api/today.js
// =====================================================
// AI Impact Brief - Today API (Full Version)
// Guardian + Multi RSS + OpenAI Structured Brief + Score
// Cache: latest.json (TTL) + nocache/debug flags
// =====================================================

const fs = require("fs");
const path = require("path");

// Node 18+ on Vercel has fetch globally. Keep fallback safe.
const fetchFn = global.fetch
  ? global.fetch
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const Parser = require("rss-parser");
const parser = new Parser({
  timeout: 12000,
  headers: {
    // Some feeds block generic user agents
    "User-Agent":
      "Mozilla/5.0 (compatible; AIImpactBriefBot/1.0; +https://ai-impact-brief.vercel.app)",
    Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
  },
});

// =========================
// Build marker (for you)
// =========================
const BUILD_ID = "TODAY_API__2026-02-14__FULL_RSS_GUARDIAN_V1";

// =========================
// Settings
// =========================
const CACHE_FILENAME = "latest.json";
const CACHE_TTL_SECONDS = 20 * 60; // 20 minutes

// Guardian
const GUARDIAN_SECTION = "technology";
const GUARDIAN_PAGE_SIZE = 5;

// RSS feed pool (AI / Tech / JP)
const RSS_FEEDS = [
  // AI companies
  { name: "OpenAI Blog", url: "https://openai.com/blog/rss/", bias: "ai_company" },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/", bias: "ai_company" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", bias: "ai_company" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", bias: "ai_research" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", bias: "ai_tools" },

  // Media
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", bias: "ai_news" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", bias: "ai_news" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", bias: "tech" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/", bias: "ai_news" },

  // Japan
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", bias: "jp" },
  { name: "AINOW", url: "https://ainow.ai/feed/", bias: "jp" },
];

// Topic diversification (avoid 3 funding-only, etc.)
const TOPIC_BUCKETS = [
  { key: "regulation", keywords: ["regulation", "ai act", "law", "governance", "policy", "antitrust", "eu", "commission"] },
  { key: "chips", keywords: ["chip", "gpu", "semiconductor", "nvidia", "amd", "tsmc", "export", "controls", "supply chain"] },
  { key: "funding", keywords: ["funding", "valuation", "venture", "raises", "financing", "ipo"] },
  { key: "product", keywords: ["model", "release", "launch", "api", "agent", "copilot", "chatbot", "gpt", "llm"] },
  { key: "jobs", keywords: ["jobs", "labor", "work", "employment", "white-collar", "skills", "productivity"] },
  { key: "security", keywords: ["security", "safety", "misuse", "fraud", "deepfake", "privacy"] },
];

// =========================
// Helpers
// =========================
function nowIso() {
  return new Date().toISOString();
}

function ymdJapan(date = new Date()) {
  // For "date_iso" we want YYYY-MM-DD in JST
  const jst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    // drop UTM
    const params = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (!k.toLowerCase().startsWith("utm_")) params.push([k, v]);
    }
    url.search = new URLSearchParams(params).toString();
    // normalize hostname
    url.hostname = url.hostname.toLowerCase();
    // remove trailing slash
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return String(u || "");
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function categorizeTopic(title, text) {
  const blob = (safeText(title) + " " + safeText(text)).toLowerCase();
  for (const b of TOPIC_BUCKETS) {
    if (b.keywords.some((k) => blob.includes(k))) return b.key;
  }
  return "other";
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const u = normalizeUrl(it.original_url);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ ...it, original_url: u, host: hostOf(u) });
  }
  return out;
}

function pickDiverse(items, limit = 3) {
  // Rule: avoid same host, avoid same topic bucket
  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  for (const it of items) {
    if (picked.length >= limit) break;
    const h = it.host || hostOf(it.original_url);
    const t = it.topic || "other";

    if (usedHosts.has(h)) continue;
    if (usedTopics.has(t) && usedTopics.size < limit) continue;

    picked.push(it);
    usedHosts.add(h);
    usedTopics.add(t);
  }

  // If not enough, relax topic constraint
  if (picked.length < limit) {
    for (const it of items) {
      if (picked.length >= limit) break;
      const u = it.original_url;
      if (picked.some((p) => p.original_url === u)) continue;
      const h = it.host || hostOf(u);
      if (usedHosts.has(h) && usedHosts.size < limit) continue;
      picked.push(it);
      usedHosts.add(h);
    }
  }

  return picked.slice(0, limit);
}

// =========================
// Cache (Vercel FS is ephemeral but works within same deployment)
// =========================
function cachePath() {
  return path.join("/tmp", CACHE_FILENAME);
}

function readCache() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    const json = JSON.parse(raw);
    return json;
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify(payload), "utf-8");
  } catch {
    // ignore
  }
}

// =========================
// Guardian fetch
// =========================
async function fetchGuardianArticles(guardianKey) {
  const guardianUrl =
    "https://content.guardianapis.com/search" +
    `?section=${encodeURIComponent(GUARDIAN_SECTION)}` +
    `&order-by=newest&page-size=${GUARDIAN_PAGE_SIZE}` +
    `&show-fields=headline,trailText,bodyText` +
    `&api-key=${encodeURIComponent(guardianKey)}`;

  const r = await fetchFn(guardianUrl);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Guardian HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const results = data?.response?.results || [];
  return results.map((a) => {
    const body = safeText(a?.fields?.bodyText || a?.fields?.trailText || "");
    return {
      source: "The Guardian",
      original_title: safeText(a.webTitle || a?.fields?.headline || ""),
      original_url: normalizeUrl(a.webUrl || ""),
      body: body.slice(0, 9000),
    };
  });
}

// =========================
// RSS fetch
// =========================
async function fetchRssFeed(feed) {
  const out = [];
  try {
    const data = await parser.parseURL(feed.url);
    const entries = Array.isArray(data.items) ? data.items : [];
    for (const e of entries.slice(0, 8)) {
      const link = normalizeUrl(e.link || e.guid || "");
      const title = safeText(e.title || "");
      const content =
        safeText(e.contentSnippet || e.summary || e.content || "") || "";
      out.push({
        source: feed.name,
        original_title: title,
        original_url: link,
        body: content.slice(0, 4000),
      });
    }
  } catch (err) {
    // return empty on failure
  }
  return out;
}

async function fetchRssPool() {
  const tasks = RSS_FEEDS.map((f) => fetchRssFeed(f));
  const chunks = await Promise.all(tasks);
  return chunks.flat();
}

// =========================
// OpenAI call
// =========================
async function callOpenAI(openaiKey, model, systemPrompt, userPrompt) {
  const r = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 800)}`);
  }

  const data = await r.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI missing content");

  // response_format json_object should already be JSON string
  const cleaned = String(raw)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

// =========================
// Scoring (Japan perspective)
// =========================
function scoreOne(item) {
  const text = (safeText(item.title_ja) + " " + safeText(item.one_sentence) + " " + safeText(item.original_title)).toLowerCase();

  // Japan relevance signals
  const jpSignals = [
    "japan", "tokyo", "japanese", "日本", "日", "経産省", "総務省", "ソニー", "トヨタ", "日立", "ntt", "楽天", "softbank", "三菱", "みずほ",
  ];
  const jpHit = jpSignals.some((k) => text.includes(k.toLowerCase())) ? 1 : 0;

  // Market impact signals
  const marketSignals = ["ipo", "valuation", "funding", "raises", "billions", "規制", "law", "ai act", "antitrust", "sanctions", "export"];
  const marketHit = marketSignals.some((k) => text.includes(k)) ? 1 : 0;

  // Business impact signals
  const bizSignals = ["enterprise", "api", "platform", "partnership", "acquisition", "product", "launch", "model", "copilot", "agent"];
  const bizHit = bizSignals.some((k) => text.includes(k)) ? 1 : 0;

  // Confidence heuristic: based on presence of concrete facts
  const factCount = Array.isArray(item.fact_summary) ? item.fact_summary.length : 0;
  const confidence = clamp(5 + factCount * 2, 5, 20);

  const market_impact = clamp(20 + (marketHit ? 15 : 0) + (item.impact_level === "High" ? 10 : 0), 0, 40);
  const business_impact = clamp(15 + (bizHit ? 15 : 0) + (item.impact_level === "Medium" ? 5 : 0), 0, 35);
  const japan_relevance = clamp(10 + (jpHit ? 15 : 0), 0, 25);

  const total = clamp(market_impact + business_impact + japan_relevance + confidence, 0, 100);

  return {
    importance_score: total,
    score_breakdown: {
      market_impact,
      business_impact,
      japan_relevance,
      confidence,
    },
  };
}

function enforceImpactRules(items) {
  // allow High max 1. If multiple High -> keep the highest score later.
  const highs = items.filter((x) => x.impact_level === "High");
  if (highs.length <= 1) return items;

  // Temporarily score to decide which High to keep
  const scored = items.map((it) => ({ it, s: scoreOne(it).importance_score }));
  scored.sort((a, b) => b.s - a.s);

  let highKept = false;
  const out = [];
  for (const { it } of scored) {
    if (it.impact_level === "High") {
      if (highKept) it.impact_level = "Medium";
      else highKept = true;
    }
    out.push(it);
  }
  return out;
}

// =========================
// Main handler
// =========================
module.exports = async function handler(req, res) {
  // ---- Robust CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

    const urlObj = new URL(req.url, "https://example.com");
    const debug = urlObj.searchParams.get("debug") === "1";
    const nocache = urlObj.searchParams.get("nocache") === "1";
    const force = urlObj.searchParams.get("force") === "1"; // stronger than nocache

    // -------------------------
    // Cache return
    // -------------------------
    const cached = readCache();
    if (cached && !nocache && !force) {
      // TTL check
      const cachedAt = cached?.cache?.at ? Date.parse(cached.cache.at) : 0;
      const age = cachedAt ? (Date.now() - cachedAt) / 1000 : 999999;
      if (age <= CACHE_TTL_SECONDS) {
        cached.cache = { ...(cached.cache || {}), hit: true, age_seconds: Math.round(age) };
        cached.build_id = BUILD_ID;
        return res.status(200).json(cached);
      }
    }

    // -------------------------
    // 1) Collect candidates
    // -------------------------
    const [guardianArticles, rssArticles] = await Promise.all([
      fetchGuardianArticles(guardianKey),
      fetchRssPool(),
    ]);

    // combine and annotate topic
    let merged = [...guardianArticles, ...rssArticles].map((a) => ({
      ...a,
      host: hostOf(a.original_url),
      topic: categorizeTopic(a.original_title, a.body),
    }));

    merged = dedupeByUrl(merged);

    // prioritize: newest-ish is unknown for RSS, so we rank by source bias + topic diversity + Guardian first
    // sort: Guardian first, then JP feeds, then AI companies, then general
    const sourcePriority = (src) => {
      const s = (src || "").toLowerCase();
      if (s.includes("guardian")) return 1;
      if (s.includes("itmedia") || s.includes("ainow")) return 2;
      if (s.includes("openai") || s.includes("anthropic") || s.includes("deepmind") || s.includes("google")) return 3;
      return 4;
    };
    merged.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));

    const picked = pickDiverse(merged, 3);

    if (picked.length < 3) {
      return res.status(502).json({
        error: "Not enough articles from sources",
        picked_count: picked.length,
        build_id: BUILD_ID,
      });
    }

    // -------------------------
    // 2) Prompts
    // -------------------------
    const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
「構造で読む、AI戦略ニュース」というコンセプトのもと、誇張や扇動は一切禁止です。
投資家・経営層が意思決定に使えるよう、事実と示唆を分離して提示してください。
出力は必ず「有効なJSONのみ」。説明文やMarkdownは禁止。
`.trim();

    const articlesForLLM = picked.map((a) => ({
      source: a.source,
      original_title: a.original_title,
      original_url: a.original_url,
      body: a.body,
      topic: a.topic,
      host: a.host,
    }));

    const userPrompt = `
以下の海外/国内AIニュース（3本）を、日本語で上質かつ客観的に整理してください。

【絶対ルール】
・煽らない（「衝撃」「革命的」等は禁止）
・断定しすぎない（「〜とみられる」「〜が示唆される」を優先）
・主観的評価を書かない（事実と分析を分ける）
・固有名詞は正確な日本語表記を優先
・3本はサブテーマが被らないよう分散（規制/半導体/資金/プロダクト/労働/安全 等）
・impact_level は厳密に分類
  - High: 市場・政策・地政学レベルで構造的影響
  - Medium: 業界または大手企業単位で影響
  - Low: 限定的/局所的 or 話題性中心
・Highは最大1件（明確な場合のみ）
・日本市場視点を必ず入れる（Japan impact は “日本での意思決定” につながる表現で）

【出力形式（厳守）】
{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "title_ja": "簡潔で品のある日本語タイトル（30文字以内推奨）",
      "one_sentence": "記事全体を1文で要約（60文字以内推奨）",
      "why_it_matters": "なぜ重要か（意思決定に直結する観点）",
      "japan_impact": "日本市場/日本企業の観点での影響（2-3文）",
      "tags": ["短いタグ", "短いタグ", "短いタグ"],
      "fact_summary": ["事実1", "事実2", "事実3"],
      "implications": ["示唆1", "示唆2", "示唆3"],
      "outlook": ["焦点1", "焦点2", "焦点3"],
      "original_title": "string",
      "original_url": "string",
      "source": "string"
    }
  ]
}

【追加ルール】
・items は必ず3件
・各配列（fact_summary, implications, outlook）は2〜4項目
・1項目は50文字以内推奨
・元記事URL/タイトル/ソースは必ず対応するものを入れる

Articles JSON:
${JSON.stringify(articlesForLLM)}
`.trim();

    // -------------------------
    // 3) OpenAI
    // -------------------------
    const payload = await callOpenAI(
      openaiKey,
      process.env.OPENAI_MODEL || "gpt-4o-mini",
      systemPrompt,
      userPrompt
    );

    // -------------------------
    // 4) Validate / normalize
    // -------------------------
    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== 3) {
      return res.status(502).json({
        error: "Schema invalid: items must be 3",
        raw: payload,
        build_id: BUILD_ID,
      });
    }

    // Ensure the source/url are correct & mapped
    const byUrl = new Map(articlesForLLM.map((a) => [normalizeUrl(a.original_url), a]));
    payload.items = payload.items.map((it) => {
      const u = normalizeUrl(it.original_url || it.originalUrl || "");
      const mapped = byUrl.get(u);
      return {
        impact_level: it.impact_level || "Medium",
        title_ja: safeText(it.title_ja),
        one_sentence: safeText(it.one_sentence),
        why_it_matters: safeText(it.why_it_matters || it["why_it.matters"]),
        japan_impact: safeText(it.japan_impact),
        tags: Array.isArray(it.tags) ? it.tags.slice(0, 5).map(safeText) : [],
        fact_summary: Array.isArray(it.fact_summary) ? it.fact_summary.slice(0, 4).map(safeText) : [],
        implications: Array.isArray(it.implications) ? it.implications.slice(0, 4).map(safeText) : [],
        outlook: Array.isArray(it.outlook) ? it.outlook.slice(0, 4).map(safeText) : [],
        original_title: mapped ? mapped.original_title : safeText(it.original_title),
        original_url: mapped ? mapped.original_url : u,
        source: mapped ? mapped.source : safeText(it.source),
      };
    });

    // Enforce "High max 1"
    payload.items = enforceImpactRules(payload.items);

    // Add score
    payload.items = payload.items.map((it) => {
      const sc = scoreOne(it);
      return { ...it, ...sc };
    });

    // Sort High->Medium->Low by impact, then score desc
    const impactOrder = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => {
      const d = (impactOrder[b.impact_level] || 0) - (impactOrder[a.impact_level] || 0);
      if (d !== 0) return d;
      return (b.importance_score || 0) - (a.importance_score || 0);
    });

    payload.date_iso = ymdJapan(new Date());
    payload.generated_at = nowIso();
    payload.version = "FULL-RSS-GUARDIAN-1.0";
    payload.sources = Array.from(new Set(articlesForLLM.map((a) => a.source)));
    payload.build_id = BUILD_ID;
    payload.cache = { hit: false, key: CACHE_FILENAME, at: nowIso(), ttl_seconds: CACHE_TTL_SECONDS };

    if (debug) {
      payload.debug = {
        picked: articlesForLLM.map((a) => ({
          source: a.source,
          host: a.host,
          topic: a.topic,
          original_title: a.original_title,
          original_url: a.original_url,
          body_length: (a.body || "").length,
        })),
        merged_count: merged.length,
      };
    }

    // write cache
    writeCache(payload);

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      build_id: BUILD_ID,
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
};
