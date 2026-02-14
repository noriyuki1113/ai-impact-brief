// /api/today.js  (Vercel Serverless Function / Node runtime)
// STRATEGIC_AI_BRIEF_V4_STABLE — “絶対に止まらない”運用安定版
//
// ✅ Guardian + RSS を並列収集
// ✅ URL正規化 + allowlist
// ✅ 多様性(ホスト/トピック)を維持して3本選出
// ✅ OpenAIは「成功したら上書き」。失敗/タイムアウトでも完成形JSONで返す（500回避）
// ✅ AbortError / タイムアウトは握りつぶしてフォールバック
// ✅ 15分キャッシュ（メモリ）+ ETag
//
// Required ENV:
// - GUARDIAN_API_KEY
// - OPENAI_API_KEY

import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/** BUILD_ID: プロダクトのアイデンティティ */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V4_STABLE";

// ====== Tunables ======
const FETCH_TIMEOUT_MS = 6500;
const OPENAI_TIMEOUT_MS = 20000;
const OUTPUT_ITEMS = 3;
const CACHE_TTL_MS = 15 * 60 * 1000;

// ====== Sources ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

// ホスト許可（安全＆品質）
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

// ====== Utils ======
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
    const u = new URL(String(raw || "").trim());
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach((k) => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, ""); // remove trailing slash
    return u.toString();
  } catch {
    return String(raw || "").trim();
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllowed(u) {
  const host = safeHost(u);
  return !!host && ALLOW_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

// ====== Topic Guess (JP false positives controlled) ======
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 「方法」「手法」を除外した「法」検知（※Lookbehind非対応環境対策：簡易除外）
  const hasHou = /法/.test(title || "");
  const methodHou = /(方法|手法)/.test(title || "");
  const jpLawSignal = hasHou && !methodHou;

  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust/.test(t) ||
    /訴訟|規制|法案|司法|裁判/.test(title || "") ||
    jpLawSignal;

  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises/.test(t) || /資金|調達|評価額|上場/.test(title || "")) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc/.test(t) || /半導体|輸出|GPU|チップ/.test(title || "")) return "supply_chain";
  if (/model|release|launch|api|tool|product/.test(t) || /アップデート|公開|提供|リリース|ツール|議事録/.test(title || "")) return "product";
  if (/research|paper|benchmark|arxiv/.test(t) || /研究|論文|ベンチマーク/.test(title || "")) return "research";
  return hint || "other";
}

// ====== Scoring ======
function scoreCandidate(c) {
  let s = 40;

  // ソース信頼 + 重要度
  s += Math.round((c.weight || 0.8) * 20);

  // 日本ソースは加点
  if (c.jp) s += 15;

  // 日本関連ワード
  if (/japan|日本|国内|公取委|総務省|経産省|金融庁|デジタル庁/.test(c.title || "")) s += 15;

  // トピックボーナス（戦略テーマ）
  const bonus = { regulation: 20, funding: 15, supply_chain: 15, product: 5, research: 5 };
  s += bonus[c.topic] || 0;

  // スコア範囲
  s = Math.max(0, Math.min(95, s));

  // 内訳（UI用）
  const breakdown = {
    market_impact: Math.min(40, Math.round(s * 0.4)),
    business_impact: Math.min(30, Math.round(s * 0.3)),
    japan_relevance: Math.min(25, c.jp ? 20 : 10),
    confidence: 10, // 後でOpenAIが補正してもOK
  };

  // 合計100に寄せる（軽い補正）
  const sum = breakdown.market_impact + breakdown.business_impact + breakdown.japan_relevance + breakdown.confidence;
  if (sum > 100) breakdown.market_impact = Math.max(0, breakdown.market_impact - (sum - 100));

  return { score: s, breakdown };
}

function toImpactLevel(score) {
  if (score >= 85) return "High";
  if (score >= 70) return "Medium";
  return "Low";
}

// ====== Data Fetchers ======
async function fetchGuardian(key) {
  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=12` +
    `&show-fields=trailText` +
    `&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const results = data?.response?.results || [];
    return results.map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle || "",
      summary: stripHtml(a.fields?.trailText || ""),
      jp: false,
      weight: 0.95,
      hint: "market",
    }));
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

    const items = Array.isArray(feed.items) ? feed.items : [];
    return items.slice(0, 10).map((it) => ({
      source: src.name,
      url: normalizeUrl(it.link || it.guid || ""),
      title: String(it.title || "").trim(),
      summary: stripHtml(String(it.contentSnippet || it.content || "").slice(0, 800)),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
    }));
  } catch {
    return [];
  }
}

// ====== Pick Diverse Top ======
function pickDiverseTop(candidates) {
  const seenUrl = new Set();

  const cleaned = candidates
    .map((c) => ({
      ...c,
      url: normalizeUrl(c.url),
      title: String(c.title || "").trim(),
      summary: String(c.summary || "").trim(),
    }))
    .filter((c) => c.url && c.title && !seenUrl.has(c.url) && (seenUrl.add(c.url) || true))
    .filter((c) => isAllowed(c.url));

  const enriched = cleaned
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return {
        ...c,
        topic,
        importance_score: score,
        score_breakdown: breakdown,
      };
    })
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    const host = safeHost(c.url);

    // 1) 同一ホスト回避 2) 同一トピック回避（多様性）
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填（多様性が足りない場合）
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    const e = enriched[i];
    if (!picked.find((p) => p.url === e.url)) picked.push(e);
    i++;
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

// ====== Stable Fallback Payload (ALWAYS valid) ======
function buildFallbackPayload(picked) {
  const dateIso = new Date().toISOString().slice(0, 10);

  const items = picked.map((p) => ({
    impact_level: toImpactLevel(p.importance_score),
    importance_score: p.importance_score,
    score_breakdown: p.score_breakdown,
    title_ja: p.title,
    one_sentence: (p.summary || "").slice(0, 80) || "要点は元記事をご確認ください。",
    why_it_matters:
      p.topic === "regulation"
        ? "規制・競争政策は市場構造と参入条件を変える可能性があるため。"
        : p.topic === "funding"
        ? "資金調達や評価は競争環境・投資姿勢を映すため。"
        : p.topic === "supply_chain"
        ? "半導体・供給制約はAIの性能とコストを左右するため。"
        : p.topic === "product"
        ? "新機能/新製品は実装・運用の前提を更新するため。"
        : "中長期の戦略判断に影響し得るため。",
    japan_impact: p.jp
      ? "日本市場への直接影響が見込まれるため、動向を優先的に注視。"
      : "海外動向として、日本企業の戦略・調達・規制対応に波及する可能性を注視。",
    tags: [p.topic],
    fact_summary: [
      `出典: ${p.source}`,
      `要点: ${(p.summary || "概要は元記事参照").slice(0, 60)}`,
    ],
    implications: [
      "示唆: 競争環境や投資判断への影響があり得る",
      "示唆: 日本市場では規制/供給網/投資動向に注意",
    ],
    outlook: [
      "見通し: 関連当局・企業の追加発表を注視",
      "見通し: 次の決算/政策/プロダクト更新が焦点",
    ],
    original_title: p.title,
    original_url: p.url,
    source: p.source,
    topic: p.topic,
  }));

  return {
    date_iso: dateIso,
    items,
    generated_at: new Date().toISOString(),
    version: BUILD_ID,
    build_id: `${BUILD_ID}__${dateIso}`,
    sources: Array.from(new Set(picked.map((p) => p.source))),
  };
}

// ====== OpenAI overlay (Best-effort) ======
async function openaiEnhance(oKey, picked) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const dateIso = new Date().toISOString().slice(0, 10);

  const system = [
    "あなたは冷静で知的な戦略アナリストです。",
    "日本市場の視点で、煽らず、断定しすぎず、客観的な分析を行います。",
    "出力は必ずJSONのみ（説明文・Markdown禁止）。",
    "itemsは必ず3件、各配列は2〜4項目。",
    "impact_levelはHigh/Medium/Low。Highは最大1件を推奨。",
  ].join("\n");

  const user = {
    date_iso: dateIso,
    candidates: picked.map((p) => ({
      source: p.source,
      topic: p.topic,
      importance_score: p.importance_score,
      score_breakdown: p.score_breakdown,
      original_title: p.title,
      original_url: p.url,
      snippet: p.summary,
      jp_source: p.jp,
    })),
    output_schema: {
      date_iso: "YYYY-MM-DD",
      items: [
        {
          impact_level: "High|Medium|Low",
          importance_score: "number(0-100)",
          score_breakdown: { market_impact: "0-40", business_impact: "0-30", japan_relevance: "0-25", confidence: "0-10" },
          title_ja: "品のある日本語タイトル（30文字目安）",
          one_sentence: "1文要約（60-90文字目安）",
          why_it_matters: "なぜ重要か（1-2文）",
          japan_impact: "日本への含意（2-3文）",
          tags: ["topic string"],
          fact_summary: ["2-4 bullets"],
          implications: ["2-4 bullets"],
          outlook: ["2-4 bullets"],
          original_title: "string",
          original_url: "string",
          source: "string",
          topic: "string",
        },
      ],
    },
  };

  try {
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
          { role: "user", content: JSON.stringify(user) },
        ],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;

    const payload = JSON.parse(text);

    // schema guard (best-effort)
    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== 3) return null;

    // ensure required top-level fields exist
    payload.date_iso = payload.date_iso || dateIso;

    return payload;
  } catch (err) {
    // AbortError含め、強制的にフォールバックへ
    return null;
  } finally {
    clearTimeout(id);
  }
}

// ====== Handler ======
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;

  // ここだけは即エラー（鍵がないのは運用ミス）
  if (!gKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!oKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // debug=1
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  // Cache hit
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.setHeader("ETag", CACHE.etag || "");
    res.setHeader("Cache-Control", "s-maxage=0, max-age=0");
    return res.status(200).json({ ...CACHE.payload, cache: { hit: true, ttl_seconds: Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000) } });
  }

  try {
    const parser = new Parser();

    // 1) Parallel fetch (Guardian + RSS)
    const settled = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const allCandidates = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c?.url && c?.title);

    // 2) Pick diverse top 3
    const picked = pickDiverseTop(allCandidates);

    // 3) Always build fallback (guaranteed output)
    let payload = buildFallbackPayload(picked);

    // 4) Best-effort OpenAI enhance (never breaks)
    const enhanced = await openaiEnhance(oKey, picked);
    if (enhanced) {
      // Merge minimal metadata + keep stable fields
      payload = {
        ...payload,
        ...enhanced,
        generated_at: new Date().toISOString(),
        version: BUILD_ID,
        build_id: `${BUILD_ID}__${new Date().toISOString().slice(0, 10)}`,
        sources: Array.from(new Set(picked.map((p) => p.source))),
      };
    }

    // 5) Add debug
    if (debug) {
      payload.debug = {
        merged_count: allCandidates.length,
        picked: picked.map((p) => ({
          source: p.source,
          host: safeHost(p.url),
          topic: p.topic,
          score: p.importance_score,
          url: p.url,
        })),
        ai_ok: !!enhanced,
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS },
      };
    }

    // 6) Cache update
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "s-maxage=0, max-age=0");
    return res.status(200).json({ ...payload, cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) } });
  } catch (err) {
    // 最後の砦：絶対に落とさない
    const safe = {
      error: err?.message || String(err),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      date_iso: new Date().toISOString().slice(0, 10),
      items: [],
    };
    return res.status(200).json(safe); // 500回避（監視はログで）
  }
}
