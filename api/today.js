// /api/today.js  (Vercel Serverless Function / Node.js runtime)
// STRATEGIC_AI_BRIEF_V5 — Multi-source + AI ranking + abort-safe + cache/etag + fallback

import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V5_AI_RANKED";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 6500;
const OPENAI_TIMEOUT_MS = 20000;
const OUTPUT_ITEMS = 3;
const AI_RANK_POOL = 12; // AIに順位付けさせる候補数
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

// Guardianは任意（キーがあれば取得）
const GUARDIAN_SECTION = "technology";

// 許可ホスト（安全・品質の最低限フィルタ）
const ALLOW_HOSTS = [
  "theguardian.com",
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "techcrunch.com",
  "itmedia.co.jp",
  "ainow.ai",
];

// ====== インメモリキャッシュ ======
let CACHE = { at: 0, payload: null, etag: "" };

// ====== ユーティリティ ======
const isoDateJST = () => {
  // 日付だけはJST基準に合わせたい場合（サイト表示に優しい）
  const d = new Date();
  // JSTへ寄せる（UTC+9）
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return j.toISOString().slice(0, 10);
};

const sha1Like = (s) => {
  // 軽量なETag用ハッシュ（FNV-1a 32bit風）
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
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return String(raw || "").trim();
  }
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isAllowedHost(url) {
  const host = getHost(url);
  if (!host) return false;
  return ALLOW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/**
 * トピック推定（誤検知対策）
 * - 「方法/手法」の「法」だけで規制判定されないように対策
 */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 規制・訴訟
  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust|dma|dsa|ai act|訴訟|規制|法案|司法|裁判|公取委|独禁/.test(t) ||
    /(?<![方手])法/.test(t); // "方法/手法" を除外

  if (isRegulation) return "regulation";

  // 資金・投資
  if (/fund|financ|valuation|ipo|raises|round|資金|調達|評価額|上場|投資|vc|venture/.test(t)) return "funding";

  // 供給網・半導体
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出|規制強化|サプライ/.test(t)) return "supply_chain";

  // プロダクト/リリース
  if (/model|release|launch|api|tool|product|update|アップデート|公開|提供|新機能|議事録/.test(t)) return "product";

  // 研究
  if (/research|paper|benchmark|arxiv|研究|論文|実験/.test(t)) return "research";

  return hint || "other";
}

/**
 * 事前スコア（AIに渡す候補の優先度を決める）
 * ※ここは「中身」までは見ない。AIで最終判定する前段。
 */
function scoreCandidateBase(c) {
  let s = 35;

  // ソース重み
  s += Math.round((c.weight || 0.8) * 25);

  // 日本語ソース / 日本関連ボーナス
  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省|金融庁|東証/.test(c.title || "")) s += 15;

  // トピックボーナス（戦略向き）
  const bonus = { regulation: 25, funding: 18, supply_chain: 18, product: 6, research: 6, other: 0 };
  s += bonus[c.topic] || 0;

  // 長すぎるHowTo系（勝ち筋から外れやすい）に軽い減点
  if (/(やり方|方法|手順|テンプレ|例文|まとめ|◯選|コピペ)/.test(c.title || "")) s -= 8;

  s = Math.max(0, Math.min(90, s));
  return s;
}

/**
 * 影響度ラベル（暫定。最終はAIに任せる）
 */
function impactFromScore(score) {
  if (score >= 82) return "High";
  if (score >= 60) return "Medium";
  return "Low";
}

/**
 * 多様性を維持したトップ選出（AIが落ちた時のフォールバック）
 */
function pickDiverseTopDeterministic(candidates) {
  const enriched = candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const base = scoreCandidateBase({ ...c, topic });
      return { ...c, topic, importance_score: base, impact_level: impactFromScore(base) };
    })
    .sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    const host = getHost(c.url);
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    if (!picked.find((p) => p.url === enriched[i].url)) picked.push(enriched[i]);
    i++;
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

// ====== データ取得 ======
async function fetchGuardian(key) {
  if (!key) return [];
  const url =
    "https://content.guardianapis.com/search" +
    `?section=${encodeURIComponent(GUARDIAN_SECTION)}` +
    `&order-by=newest&page-size=12&show-fields=trailText` +
    `&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle || "",
      summary: stripHtml(a?.fields?.trailText || ""),
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
      url: normalizeUrl(it.link || it.guid || ""),
      title: String(it.title || "").trim(),
      summary: stripHtml((it.contentSnippet || it.content || "").slice(0, 1200)),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
    }));
  } catch {
    return [];
  }
}

function dedupeCandidates(items) {
  const map = new Map();
  for (const it of items) {
    const url = normalizeUrl(it.url);
    if (!url) continue;
    if (!isAllowedHost(url)) continue;

    const key = url;
    if (!map.has(key)) {
      map.set(key, { ...it, url });
    } else {
      // 既存よりsummaryが長ければ更新
      const prev = map.get(key);
      if ((it.summary || "").length > (prev.summary || "").length) {
        map.set(key, { ...prev, ...it, url });
      }
    }
  }
  return [...map.values()];
}

// ====== OpenAI（AIランク付け＋構造化） ======
function safeJsonParse(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeAiItemShape(item, fallback) {
  const out = { ...fallback, ...(item || {}) };

  // 必須の埋め
  out.title_ja = String(out.title_ja || fallback.title_ja || fallback.title || "タイトルなし").slice(0, 80);
  out.one_sentence = String(out.one_sentence || "").slice(0, 220);

  // 配列のガード
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String).slice(0, 4) : []);
  out.fact_summary = arr(out.fact_summary);
  out.implications = arr(out.implications);
  out.outlook = arr(out.outlook);

  // 空があるなら最低限補完（フロント崩れ防止）
  if (out.fact_summary.length < 2) out.fact_summary = fallback.fact_summary.slice(0, 3);
  if (out.implications.length < 2) out.implications = fallback.implications.slice(0, 3);
  if (out.outlook.length < 2) out.outlook = fallback.outlook.slice(0, 3);

  // スコア類
  out.importance_score = Number.isFinite(+out.importance_score) ? Math.max(0, Math.min(100, +out.importance_score)) : fallback.importance_score;
  out.score_breakdown = out.score_breakdown && typeof out.score_breakdown === "object" ? out.score_breakdown : fallback.score_breakdown;

  // impact
  const lvl = String(out.impact_level || fallback.impact_level || "Medium");
  out.impact_level = ["High", "Medium", "Low"].includes(lvl) ? lvl : fallback.impact_level;

  // why/japan
  out.why_it_matters = String(out.why_it_matters || "").slice(0, 240);
  out.japan_impact = String(out.japan_impact || "").slice(0, 240);

  // source/url
  out.original_url = out.original_url || out.url || fallback.original_url;
  out.original_title = out.original_title || fallback.original_title;
  out.source = out.source || fallback.source;

  // topic/tags
  out.topic = out.topic || fallback.topic;
  out.tags = Array.isArray(out.tags) ? out.tags.map(String).slice(0, 4) : [out.topic || "other"];

  return out;
}

function makeFallbackBriefItem(c) {
  const topic = c.topic || guessTopic(c.title, c.hint);
  const base = scoreCandidateBase({ ...c, topic });
  const impact = impactFromScore(base);

  // 「構造」最低限
  const fact = [
    `出典: ${c.source}`,
    `要点: ${String(c.summary || c.title || "").slice(0, 70)}`,
    `リンク: 元記事参照`,
  ];
  const impl = [
    "示唆: 日本市場では規制/供給網/投資動向の影響を点検",
    "示唆: 競争環境・投資判断・調達方針に波及し得る",
  ];
  const outl = [
    "見通し: 追加発表・規制当局・決算の動きが焦点",
    "見通し: 6〜12か月での政策・投資・採用動向を注視",
  ];

  return {
    impact_level: impact,
    importance_score: base,
    score_breakdown: {
      market_impact: Math.min(40, Math.round(base * 0.4)),
      business_impact: Math.min(30, Math.round(base * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 6,
    },
    title_ja: c.jp ? String(c.title || "").slice(0, 60) : String(c.title || "").slice(0, 70),
    one_sentence: String(c.summary || c.title || "").slice(0, 80),
    why_it_matters: "市場構造・競争条件・投資判断に影響し得るため。",
    japan_impact: c.jp ? "日本市場への直接影響が見込まれるため優先監視。" : "海外動向として波及可能性を注視。",
    tags: [topic],
    fact_summary: fact,
    implications: impl,
    outlook: outl,
    original_title: c.title || "",
    original_url: c.url || "",
    source: c.source || "",
    topic,
  };
}

async function callOpenAIJson(oKey, systemPrompt, userPayload) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

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
        // response_format が効く環境ではJSON保証が強くなる（効かなくてもパースで吸収）
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });

    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, status: res.status, error: raw.slice(0, 800), json: null, rawText: raw };
    }

    const parsed = safeJsonParse(raw);
    // OpenAIの標準レスポンスはJSON全体なので、choicesから取り出す
    const content = parsed?.choices?.[0]?.message?.content;
    const obj = safeJsonParse(content);

    return { ok: !!obj, status: res.status, error: null, json: obj, rawText: content || raw.slice(0, 800) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e), json: null, rawText: "" };
  } finally {
    clearTimeout(id);
  }
}

async function rankAndBriefWithAI(oKey, candidatesPool) {
  // AIに渡すのは「上位候補のみ」
  const pool = candidatesPool.map((c) => ({
    source: c.source,
    original_url: c.url,
    original_title: c.title,
    summary: (c.summary || "").slice(0, 600),
    topic: c.topic,
    jp: !!c.jp,
    base_score: c.base_score,
  }));

  const system = `
あなたは「日本市場視点のAI戦略アナリスト」です。
与えられた候補ニュースから、日本の投資家・経営層にとって価値が高い順に評価し、上位3件を「構造化ブリーフ」で返してください。

【重要】
- 煽り・誇張は禁止（冷静・客観）
- 日本市場への含意（規制/供給網/投資/競争/人材）を明示
- 3件はなるべくトピックを分散（regulation / funding / supply_chain / product / research など）
- importance_score（0-100）と confidence（0-10）を含む
- fact_summary/implications/outlook は各2〜4項目
- 返答は「有効なJSONのみ」

【出力JSONスキーマ（厳守）】
{
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "importance_score": 0,
      "score_breakdown": {
        "market_impact": 0,
        "business_impact": 0,
        "japan_relevance": 0,
        "confidence": 0
      },
      "title_ja": "string",
      "one_sentence": "string",
      "why_it_matters": "string",
      "japan_impact": "string",
      "tags": ["string"],
      "fact_summary": ["string"],
      "implications": ["string"],
      "outlook": ["string"],
      "original_title": "string",
      "original_url": "string",
      "source": "string",
      "topic": "string"
    }
  ]
}
`.trim();

  const resp = await callOpenAIJson(oKey, system, { pool });

  if (!resp.ok || !resp.json || !Array.isArray(resp.json.items)) {
    return { ok: false, items: null, debug: { openai: resp } };
  }

  // itemsが3件に満たない/超える場合も吸収
  const items = resp.json.items.slice(0, OUTPUT_ITEMS);
  return { ok: true, items, debug: { openai: { ok: true, status: resp.status, error: null } } };
}

// ====== ハンドラー ======
export default async function handler(req, res) {
  // ---- CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  // debug=1
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  const guardianKey = process.env.GUARDIAN_API_KEY || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
  // Guardianは任意（なくてもRSSだけで動く）
  // if (!guardianKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });

  // ---- Cache (in-memory) + ETag ----
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    if (CACHE.etag) res.setHeader("ETag", CACHE.etag);
    const inm = req.headers["if-none-match"];
    if (CACHE.etag && inm && inm === CACHE.etag) return res.status(304).end();

    const payload = debug
      ? CACHE.payload
      : (() => {
          const { debug: _d, ...rest } = CACHE.payload;
          return rest;
        })();

    return res.status(200).json(payload);
  }

  try {
    const parser = new Parser();

    // 1) 並列取得
    const settled = await Promise.allSettled([
      fetchGuardian(guardianKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const rawCandidates = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || []);

    // 2) 整形/フィルタ/重複排除
    const deduped = dedupeCandidates(rawCandidates)
      .filter((c) => c.url && c.title)
      .map((c) => {
        const topic = guessTopic(c.title, c.hint);
        const base = scoreCandidateBase({ ...c, topic });
        return { ...c, topic, base_score: base };
      })
      .sort((a, b) => b.base_score - a.base_score);

    // 候補が少なすぎる場合
    if (deduped.length === 0) {
      const emptyPayload = {
        date_iso: isoDateJST(),
        items: [],
        generated_at: new Date().toISOString(),
        version: BUILD_ID,
        sources: [],
        error: "No candidates (all sources empty or blocked by allowlist).",
      };
      const etag = `"${sha1Like(JSON.stringify(emptyPayload))}"`;
      CACHE = { at: Date.now(), payload: emptyPayload, etag };
      res.setHeader("ETag", etag);
      return res.status(200).json(emptyPayload);
    }

    // 3) AIで「中身を見た最終選抜」→ 失敗時はフォールバック
    const pool = deduped.slice(0, AI_RANK_POOL);

    const ai = await rankAndBriefWithAI(openaiKey, pool);

    let finalItems;
    let ai_ok = false;

    if (ai.ok && Array.isArray(ai.items) && ai.items.length > 0) {
      ai_ok = true;

      // AI結果を「フロント互換」に正規化（欠落吸収）
      const fallbackMap = new Map();
      for (const c of pool) fallbackMap.set(c.url, makeFallbackBriefItem(c));

      finalItems = ai.items.slice(0, OUTPUT_ITEMS).map((it) => {
        const url = it?.original_url ? normalizeUrl(it.original_url) : "";
        const fb = fallbackMap.get(url) || makeFallbackBriefItem(pool[0]);
        return normalizeAiItemShape(it, fb);
      });

      // 影響度のルール（Highは最大1件）を保険で適用
      const highs = finalItems.filter((x) => x.impact_level === "High");
      if (highs.length > 1) {
        // 2件目以降をMediumへ
        let flipped = 0;
        for (const item of finalItems) {
          if (item.impact_level === "High") {
            flipped++;
            if (flipped >= 2) item.impact_level = "Medium";
          }
        }
      }
    } else {
      const picked = pickDiverseTopDeterministic(deduped);
      finalItems = picked.map((c) => makeFallbackBriefItem(c));
    }

    // 4) 出力ペイロード（フロント互換）
    const sources = Array.from(new Set(finalItems.map((x) => x.source).filter(Boolean)));

    const payload = {
      date_iso: isoDateJST(),
      items: finalItems.slice(0, OUTPUT_ITEMS),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${isoDateJST()}`,
      sources,
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
      ...(debug
        ? {
            debug: {
              ai_ok,
              merged_count: deduped.length,
              pool_count: pool.length,
              picked: finalItems.map((x) => ({
                source: x.source,
                host: getHost(x.original_url),
                topic: x.topic,
                score: x.importance_score,
                url: x.original_url,
              })),
              openai: ai.debug?.openai || null,
              allowlist_size: ALLOW_HOSTS.length,
              timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS },
            },
          }
        : {}),
    };

    // 5) キャッシュ更新 + ETag
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) return res.status(304).end();

    // debugでない場合、debugを落として返す（payload自体にdebugが無ければそのまま）
    if (!debug && payload.debug) {
      const { debug: _d, ...rest } = payload;
      return res.status(200).json(rest);
    }

    return res.status(200).json(payload);
  } catch (err) {
    const payload = {
      error: err?.message || String(err),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      // 本番でstackを出したくなければNODE_ENVで絞る
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    };
    return res.status(500).json(payload);
  }
}
