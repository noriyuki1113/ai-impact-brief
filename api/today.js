import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V4_FINAL";

// ====== 制御設定 ======
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

// 許可ホスト（hostnameで厳格判定）
const ALLOW_HOSTS = new Set([
  "www.theguardian.com",
  "theguardian.com",
  "openai.com",
  "www.openai.com",
  "www.anthropic.com",
  "anthropic.com",
  "deepmind.google",
  "www.deepmind.google",
  "techcrunch.com",
  "www.techcrunch.com",
  "www.itmedia.co.jp",
  "itmedia.co.jp",
  "ainow.ai",
  "www.ainow.ai",
]);

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

function normalizeUrl(raw) {
  try {
    const u = new URL((raw || "").trim());
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach((k) => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return (raw || "").trim();
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isAllowed(url) {
  const host = hostnameOf(url);
  return host ? ALLOW_HOSTS.has(host) : false;
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/**
 * トピック推定（日本語「方法/手法」の誤検知回避）
 */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 「法」にだけ反応（方法/手法の誤爆を避ける）
  const isRegulation = /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";

  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  return hint || "other";
}

/**
 * スコアリング（ルールベース）
 */
function scoreCandidate(c) {
  let s = 40;
  s += Math.round((c.weight || 0.8) * 20);
  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省/.test(c.title || "")) s += 15;

  const bonus = { regulation: 20, funding: 15, supply_chain: 15, product: 5, research: 5, japan: 10 };
  s += bonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));

  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 10, // ここは後で「取得成功度/本文長/複数ソース一致」等で可変にできる
    },
  };
}

function impactLevel(score) {
  if (score >= 82) return "High";
  if (score >= 65) return "Medium";
  return "Low";
}

// ====== 取得関数 ======
async function fetchGuardian(key) {
  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=12` +
    `&show-fields=trailText` +
    `&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.response?.results || [])
      .map((a) => ({
        source: "The Guardian",
        url: normalizeUrl(a.webUrl),
        title: a.webTitle || "",
        summary: stripHtml(a.fields?.trailText || ""),
        jp: false,
        weight: 0.9,
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
        title: (it.title || "").trim(),
        summary: stripHtml((it.contentSnippet || it.content || "").slice(0, 700)),
        jp: !!src.jp,
        weight: src.weight,
        hint: src.hint,
      }))
      .filter((x) => x.url && x.title);
  } catch {
    return [];
  }
}

/**
 * 多様性＋日本枠を保証するトップ選出
 * - 同一ホストは原則1件
 * - 同一トピックは原則1件
 * - 可能なら「日本枠（jp=true）」を最低1件
 */
function pickDiverseTop(candidates) {
  const seenUrl = new Set();
  const cleaned = [];

  // 重複除去（URL正規化後）
  for (const c of candidates) {
    if (!c?.url || !c?.title) continue;
    const u = normalizeUrl(c.url);
    if (!u || seenUrl.has(u)) continue;
    seenUrl.add(u);
    cleaned.push({ ...c, url: u });
  }

  const enriched = cleaned
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return {
        ...c,
        topic,
        importance_score: score,
        impact_level: impactLevel(score),
        score_breakdown: breakdown,
      };
    })
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  // 1) まずJP枠を可能なら確保
  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    if (!c.jp) continue;
    const host = hostnameOf(c.url);
    if (!host) continue;
    if (usedHosts.has(host)) continue;
    if (usedTopics.has(c.topic)) continue;
    picked.push(c);
    usedHosts.add(host);
    usedTopics.add(c.topic);
    break;
  }

  // 2) 多様性重視で埋める
  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    const host = hostnameOf(c.url);
    if (!host) continue;

    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 3) 足りない場合はスコア順に補填（重複URLだけ避ける）
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    const c = enriched[i++];
    if (!picked.find((p) => p.url === c.url)) picked.push(c);
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

function ensureOutputSchema(picked, modelOut) {
  // modelOutが壊れてても必ず3件返す
  const itemsFromAI = Array.isArray(modelOut?.items) ? modelOut.items : [];
  const out = [];

  for (let i = 0; i < picked.length; i++) {
    const base = picked[i];
    const ai = itemsFromAI[i] || {};

    // 配列系は最低2要素を保証
    const arr2 = (v, fallback) => {
      if (Array.isArray(v) && v.length >= 2) return v.slice(0, 4).map(String);
      return fallback;
    };

    out.push({
      impact_level: base.impact_level,
      importance_score: base.importance_score,
      score_breakdown: base.score_breakdown,

      title_ja: String(ai.title_ja || base.title || "タイトルなし").slice(0, 80),
      one_sentence: String(ai.one_sentence || base.summary || "").slice(0, 140),

      why_it_matters: String(ai.why_it_matters || "").slice(0, 220),
      japan_impact: String(ai.japan_impact || "").slice(0, 260),

      tags: Array.isArray(ai.tags) ? ai.tags.slice(0, 6).map(String) : [base.topic],

      fact_summary: arr2(ai.fact_summary, [
        `要点：${String(base.summary || "").slice(0, 60)}`,
        "要点：追加情報は元記事参照",
      ]),
      implications: arr2(ai.implications, [
        "示唆：競争環境や投資判断への影響があり得る",
        "示唆：日本市場では規制/供給網/投資動向に注意",
      ]),
      outlook: arr2(ai.outlook, [
        "見通し：今後の政策・競争の進展を注視",
        "見通し：次の決算/発表/規制当局の動きが焦点",
      ]),

      original_title: base.title,
      original_url: base.url,
      source: base.source,
      topic: base.topic,
    });
  }

  return out;
}

async function callOpenAI(oKey, picked) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const system = `
あなたは冷静で知的な戦略アナリストです。
煽り表現は禁止。断定しすぎない。出力は必ず有効なJSON。
次のキーを持つ items(配列) を返す:
title_ja, one_sentence, why_it_matters, japan_impact, tags, fact_summary, implications, outlook
各配列(fact_summary/implications/outlook)は2〜4項目。
`.trim();

    const user = `
以下はスコアリング済みの候補3件です。
各ニュースを日本市場の視点で、上質かつ客観的に整形してください。
必ず items を3件返してください。

INPUT:
${JSON.stringify(picked)}
`.trim();

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content;
    if (!txt) return null;

    // 念のためコードフェンス除去
    const cleaned = String(txt)
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    return JSON.parse(cleaned);
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey || !oKey) return res.status(500).json({ error: "Missing API Keys" });

  // ETag / Cache
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.setHeader("ETag", CACHE.etag);
    if (req.headers["if-none-match"] === CACHE.etag) return res.status(304).end();
    return res.status(200).json(CACHE.payload);
  }

  const debug = (() => {
    try {
      const u = new URL(req.url, "https://example.com");
      return u.searchParams.get("debug") === "1";
    } catch {
      return false;
    }
  })();

  try {
    const parser = new Parser();

    // 1) 並列取得
    const results = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const allCandidates = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c?.url && c?.title)
      .map((c) => ({ ...c, url: normalizeUrl(c.url) }))
      .filter((c) => isAllowed(c.url)); // hostnameで厳格チェック

    // 2) 3件を多様性で選出
    const picked = pickDiverseTop(allCandidates);

    // 3) OpenAIは文章整形だけ（失敗しても落ちない）
    const ai = await callOpenAI(oKey, picked);
    const items = ensureOutputSchema(picked, ai);

    const payload = {
      date_iso: new Date().toISOString().slice(0, 10),
      items,
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${new Date().toISOString().slice(0, 10)}`,
      sources: Array.from(new Set(items.map((x) => x.source))),
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    };

    if (debug) {
      payload.debug = {
        merged_count: allCandidates.length,
        picked: picked.map((p) => ({
          source: p.source,
          host: hostnameOf(p.url),
          topic: p.topic,
          score: p.importance_score,
          url: p.url,
        })),
        ai_ok: !!ai,
      };
    }

    // キャッシュ更新
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      version: BUILD_ID,
      generated_at: new Date().toISOString(),
    });
  }
}
