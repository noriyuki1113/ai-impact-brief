// /api/today.js (or /pages/api/today.js)  ※Vercel Node runtime想定
import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V4_STABLE_FULL";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 6500;
const OPENAI_TIMEOUT_MS = 20000;
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

// 許可ホスト（安全＆品質コントロール）
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

// ====== 基本ユーティリティ ======
const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
};

const nowISODate = () => new Date().toISOString().slice(0, 10);

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

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function normalizeImpactLevel(v) {
  const s = String(v || "").toLowerCase();
  if (s === "high") return "High";
  if (s === "medium") return "Medium";
  if (s === "low") return "Low";
  return "Medium";
}

function ensureArray2to4(arr, fallback) {
  const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (a.length >= 2) return a.slice(0, 4);
  const fb = Array.isArray(fallback) ? fallback : [];
  return [...a, ...fb].filter(Boolean).slice(0, 4);
}

// ====== トピック推定（誤検知対策あり） ======
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();
  // 「方法」「手法」を除外した「法」にのみ反応（lookbehind使用）
  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  return hint || "other";
}

// ====== 戦略的スコアリング（公開スコアの核） ======
function scoreCandidate(c) {
  let s = 40;
  s += Math.round((c.weight || 0.8) * 20);
  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省/.test(c.title || "")) s += 15;

  const bonus = { regulation: 20, funding: 15, supply_chain: 15, product: 5, research: 5 };
  s += bonus[c.topic] || 0;

  s = clamp(s, 0, 95);

  return {
    score: s,
    breakdown: {
      market_impact: clamp(Math.round(s * 0.4), 0, 40),
      business_impact: clamp(Math.round(s * 0.3), 0, 30),
      japan_relevance: clamp(c.jp ? 20 : 10, 0, 25),
      confidence: 10, // ここは後でAI側で微調整してもOK
    },
  };
}

// ====== データ取得 ======
async function fetchGuardian(key) {
  const url =
    "https://content.guardianapis.com/search" +
    `?section=technology&order-by=newest&page-size=10&show-fields=trailText` +
    `&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle,
      summary: String(a.fields?.trailText || "")
        .replace(/<[^>]*>?/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600),
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
    const res = await timeoutFetch(src.url);
    if (!res.ok) return [];
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    return (feed.items || []).slice(0, 10).map((it) => ({
      source: src.name,
      url: normalizeUrl(it.link),
      title: it.title,
      summary: String(it.contentSnippet || it.content || "")
        .replace(/\s+/g, " ")
        .replace(/<[^>]*>?/gm, "")
        .trim()
        .slice(0, 600),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
    }));
  } catch {
    return [];
  }
}

// ====== 多様性を保ったTop3選出 ======
function pickDiverseTop(candidates) {
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
    if (picked.length >= OUTPUT_ITEMS) break;
    let host = "";
    try {
      host = new URL(c.url).hostname;
    } catch {}

    // 同一ホストNG＆同一トピックは原則1つ
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填（足りない場合はスコア順で埋める）
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    if (!picked.find((p) => p.url === enriched[i].url)) picked.push(enriched[i]);
    i++;
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

// ====== フォールバック（AI失敗時でもフロント崩さない） ======
function fallbackPayload(picked) {
  const items = picked.map((p) => ({
    impact_level: p.topic === "regulation" ? "High" : "Medium",
    importance_score: p.importance_score ?? 60,
    score_breakdown: p.score_breakdown ?? {
      market_impact: 20,
      business_impact: 20,
      japan_relevance: p.jp ? 20 : 10,
      confidence: 10,
    },
    title_ja: String(p.title || "タイトルなし").slice(0, 60),
    one_sentence: String(p.summary || p.title || "要約なし").slice(0, 120),
    why_it_matters: "市場・戦略判断に影響し得るため。",
    japan_impact: p.jp ? "国内動向として優先的に注視。" : "海外動向として波及可能性を注視。",
    tags: [p.topic || "other"],
    fact_summary: [
      `出典: ${p.source || "unknown"}`,
      `要点: ${(p.summary || p.title || "").slice(0, 60)}`,
    ].slice(0, 4),
    implications: ["示唆: 競争環境や投資判断への影響があり得る", "示唆: 日本市場への波及可能性を点検"],
    outlook: ["見通し: 追加発表・規制・決算などを注視", "見通し: 次の製品更新/政策動向が焦点"],
    original_title: String(p.title || ""),
    original_url: String(p.url || ""),
    source: String(p.source || ""),
    topic: String(p.topic || "other"),
  }));

  // High最大1件に矯正
  let highSeen = false;
  for (const it of items) {
    if (it.impact_level === "High") {
      if (!highSeen) highSeen = true;
      else it.impact_level = "Medium";
    }
  }

  return { date_iso: nowISODate(), items };
}

// ====== AI出力を必ず完全スキーマへ正規化（勝ち筋） ======
function normalizePayload(aiPayload, picked) {
  const items = (aiPayload?.items || []).map((it, i) => {
    const base = picked[i] || {};
    const title = base.title || it?.title_ja || "タイトルなし";
    const summary = base.summary || "";

    const importance_score = it?.importance_score ?? base.importance_score ?? 60;

    const score_breakdown =
      it?.score_breakdown ??
      base.score_breakdown ?? {
        market_impact: 20,
        business_impact: 20,
        japan_relevance: base.jp ? 20 : 10,
        confidence: 10,
      };

    return {
      impact_level: normalizeImpactLevel(
        it?.impact_level || (base.topic === "regulation" ? "High" : "Medium")
      ),
      importance_score: clamp(importance_score, 0, 100),
      score_breakdown: {
        market_impact: clamp(score_breakdown.market_impact, 0, 40),
        business_impact: clamp(score_breakdown.business_impact, 0, 30),
        japan_relevance: clamp(score_breakdown.japan_relevance, 0, 25),
        confidence: clamp(score_breakdown.confidence, 0, 20),
      },
      title_ja: String(it?.title_ja || title).slice(0, 60),
      one_sentence: String(it?.one_sentence || summary || title).slice(0, 120),
      why_it_matters: String(it?.why_it_matters || "市場・戦略判断に影響し得るため。").slice(0, 200),
      japan_impact: String(
        it?.japan_impact || (base.jp ? "国内動向として優先的に注視。" : "海外動向として波及可能性を注視。")
      ).slice(0, 240),
      tags:
        Array.isArray(it?.tags) && it.tags.length
          ? it.tags.filter(Boolean).slice(0, 4)
          : [base.topic || it?.topic || "other"],
      fact_summary: ensureArray2to4(it?.fact_summary, [
        `出典: ${base.source || it?.source || "unknown"}`,
        `要点: ${(summary || title).slice(0, 60)}`,
      ]),
      implications: ensureArray2to4(it?.implications, [
        "示唆: 競争環境や投資判断への影響があり得る",
        "示唆: 日本市場への波及可能性を点検",
      ]),
      outlook: ensureArray2to4(it?.outlook, [
        "見通し: 追加発表・規制・決算などを注視",
        "見通し: 次の製品更新/政策動向が焦点",
      ]),
      original_title: String(it?.original_title || base.title || ""),
      original_url: String(it?.original_url || base.url || ""),
      source: String(it?.source || base.source || ""),
      topic: String(it?.topic || base.topic || "other"),
    };
  });

  // itemsが3つ揃わないときはフォールバック
  if (!Array.isArray(items) || items.length !== OUTPUT_ITEMS) {
    return fallbackPayload(picked);
  }

  // High最大1件に矯正
  let highSeen = false;
  for (const it of items) {
    if (it.impact_level === "High") {
      if (!highSeen) highSeen = true;
      else it.impact_level = "Medium";
    }
  }

  return { date_iso: nowISODate(), items };
}

// ====== OpenAI呼び出し（完全スキーマ強制） ======
async function callOpenAI(oKey, picked, debug) {
  const system = [
    "あなたは冷静で知的な戦略アナリストです。",
    "煽り禁止。断定しすぎない。根拠が弱い場合は控えめに。",
    "必ず『有効なJSONのみ』を返す。Markdownや説明文は禁止。",
    "",
    "【最重要】出力は items 配列(3件)で、各itemに必須キーを全て含めること。",
    "欠損キーがある場合は、空文字ではなく、最小限でも内容を埋めること。",
    "fact_summary/implications/outlookは各2〜4個、tagsは1〜4個。",
    "Highは最大1件。",
  ].join("\n");

  const input = picked.map((p, idx) => ({
    id: `n${idx + 1}`,
    title: p.title,
    summary: p.summary,
    topic: p.topic,
    source: p.source,
    original_title: p.title,
    original_url: p.url,
    importance_score: p.importance_score,
    score_breakdown: p.score_breakdown,
    jp: p.jp,
  }));

  const task = {
    date_iso: nowISODate(),
    news: input,
  };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const debugInfo = { ok: false, status: null, error: null, raw_preview: null };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${oKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              output_schema_example: {
                date_iso: "YYYY-MM-DD",
                items: [
                  {
                    impact_level: "High|Medium|Low",
                    importance_score: 0,
                    score_breakdown: {
                      market_impact: 0,
                      business_impact: 0,
                      japan_relevance: 0,
                      confidence: 0,
                    },
                    title_ja: "",
                    one_sentence: "",
                    why_it_matters: "",
                    japan_impact: "",
                    tags: ["regulation|funding|supply_chain|product|research|other"],
                    fact_summary: ["", ""],
                    implications: ["", ""],
                    outlook: ["", ""],
                    original_title: "",
                    original_url: "",
                    source: "",
                    topic: "",
                  },
                ],
              },
              rules: {
                items_count: 3,
                high_max: 1,
                tone: "知的・簡潔・非扇動",
              },
              task,
            }),
          },
        ],
      }),
    });

    debugInfo.status = res.status;
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      debugInfo.error = {
        kind: "http_error",
        status: res.status,
        statusText: res.statusText,
        body_preview: text.slice(0, 900),
      };
      throw new Error(`OpenAI HTTP error: ${res.status}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      debugInfo.error = { kind: "non_json", message: e?.message || String(e), body_preview: text.slice(0, 900) };
      throw new Error("OpenAI returned non-JSON response body");
    }

    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) {
      debugInfo.error = { kind: "missing_content", body_preview: JSON.stringify(data).slice(0, 900) };
      throw new Error("OpenAI missing message content");
    }

    debugInfo.raw_preview = String(raw).slice(0, 900);

    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch (e) {
      debugInfo.error = { kind: "content_not_json", message: e?.message || String(e), raw_preview: String(raw).slice(0, 900) };
      throw new Error("OpenAI content is not valid JSON");
    }

    debugInfo.ok = true;
    return { payload, debugInfo };
  } catch (err) {
    if (err?.name === "AbortError") {
      debugInfo.error = { kind: "abort_timeout", name: err.name, message: err.message };
    } else if (!debugInfo.error) {
      debugInfo.error = { kind: "exception", name: err?.name, message: err?.message || String(err) };
    }
    if (!debug) debugInfo.error = { kind: debugInfo.error?.kind || "error" };
    return { payload: null, debugInfo };
  } finally {
    clearTimeout(id);
  }
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  // ---- Robust-ish CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("Access-Control-Allow-Headers", reqAllowedHeaders || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;

  if (!gKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!oKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // Debug flag: /api/today?debug=1
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  // ETag
  const ifNoneMatch = req.headers["if-none-match"];
  if (CACHE.payload && CACHE.etag && ifNoneMatch && ifNoneMatch === CACHE.etag) {
    res.statusCode = 304;
    return res.end();
  }

  // TTL Cache
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.setHeader("ETag", CACHE.etag || "");
    return res.status(200).json({
      ...CACHE.payload,
      cache: { hit: true, ttl_seconds: Math.max(0, Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000)) },
    });
  }

  try {
    const parser = new Parser();

    // 1) 並列取得
    const results = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const allCandidates = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter((c) => {
        // allowlist host filter
        try {
          const host = new URL(c.url).hostname;
          return ALLOW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
        } catch {
          return false;
        }
      });

    if (!allCandidates.length) {
      return res.status(502).json({ error: "No candidates fetched", version: BUILD_ID, generated_at: new Date().toISOString() });
    }

    // 2) 多様性維持してTop3選出
    const picked = pickDiverseTop(allCandidates);

    // 3) OpenAI
    const { payload: aiPayload, debugInfo } = await callOpenAI(oKey, picked, debug);

    let payload;
    let ai_ok = false;

    if (aiPayload) {
      payload = normalizePayload(aiPayload, picked); // ★必ず完全形にする
      ai_ok = true;
    } else {
      payload = fallbackPayload(picked);
      ai_ok = false;
    }

    // 4) メタデータ
    payload.generated_at = new Date().toISOString();
    payload.version = BUILD_ID;
    payload.build_id = `${BUILD_ID}__${nowISODate()}`;
    payload.sources = Array.from(new Set(picked.map((p) => p.source)));

    // 5) キャッシュ
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);

    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          ai_ok,
          openai: debugInfo,
          merged_count: allCandidates.length,
          picked: picked.map((p) => ({
            source: p.source,
            host: (() => {
              try { return new URL(p.url).hostname; } catch { return ""; }
            })(),
            topic: p.topic,
            score: p.importance_score,
            url: p.url,
          })),
          timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS },
        },
        cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
      });
    }

    return res.status(200).json({
      ...payload,
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      version: BUILD_ID,
      generated_at: new Date().toISOString(),
      stack: debug ? err?.stack : undefined,
    });
  }
}
