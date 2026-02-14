import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V4_DEBUGSAFE";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 6500;     // RSS/Guardian取得
const OPENAI_TIMEOUT_MS = 20000;   // OpenAI呼び出し
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

// ====== 小物ユーティリティ ======
const nowISODate = () => new Date().toISOString().slice(0, 10);

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

function hostAllowed(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return ALLOW_HOSTS.some((a) => h === a || h.endsWith("." + a));
  } catch {
    return false;
  }
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

// ====== トピック推定 (誤検知対策済み) ======
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();
  // 「方法/手法」の「法」で誤爆しないように: (?<![方手])法
  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";
  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
  return hint || "other";
}

// ====== 戦略的スコアリング ======
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
      confidence: 10, // ここは将来、ソース数/一致度で変える余地あり
    },
  };
}

// ====== Guardian取得 ======
async function fetchGuardian(key) {
  const url =
    `https://content.guardianapis.com/search` +
    `?section=technology&order-by=newest&page-size=12&show-fields=trailText&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle || "",
      summary: String(a.fields?.trailText || "")
        .replace(/<[^>]*>?/gm, "")
        .trim(),
      jp: false,
      weight: 0.95,
      hint: "market",
    }));
  } catch {
    return [];
  }
}

// ====== RSS取得（安全） ======
async function fetchRssSafe(parser, src) {
  try {
    const res = await timeoutFetch(src.url, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const xml = await res.text();
    const feed = await parser.parseString(xml);

    return (feed.items || []).slice(0, 10).map((it) => ({
      source: src.name,
      url: normalizeUrl(it.link || ""),
      title: it.title || "",
      summary: String(it.contentSnippet || it.content || "")
        .slice(0, 500)
        .replace(/\s+/g, " ")
        .trim(),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
    }));
  } catch {
    return [];
  }
}

// ====== 多様性を維持したトップ選出 ======
function pickDiverseTop(candidates) {
  const enriched = candidates
    .filter((c) => c?.url && c?.title)
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
      host = new URL(c.url).hostname.replace(/^www\./, "");
    } catch {}

    // 同一ホストNG、同一トピックは最大1つ
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填（多様性で足りない場合）
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    if (!picked.find((p) => p.url === enriched[i].url)) picked.push(enriched[i]);
    i++;
  }

  return picked.slice(0, OUTPUT_ITEMS);
}

// ====== OpenAI 呼び出し（デバッグ情報を返す） ======
async function callOpenAI(oKey, picked, debug) {
  const system = [
    "あなたは冷静で知的な戦略アナリストです。",
    "感情的・扇動的表現は禁止。断定しすぎない。",
    "日本市場の視点で評価し、スコア(importance_score/score_breakdown)を活かして文章を補強。",
    "必ず有効なJSONのみを返す。Markdownや説明文は禁止。",
  ].join("\n");

  const user = {
    date_iso: nowISODate(),
    items: picked.map((p) => ({
      impact_level: "", // モデルに最終分類させる
      importance_score: p.importance_score,
      score_breakdown: p.score_breakdown,
      title: p.title,
      summary: p.summary,
      topic: p.topic,
      source: p.source,
      original_url: p.url,
      jp: p.jp,
    })),
    rules: {
      items_count: OUTPUT_ITEMS,
      impact_level: "High|Medium|Low",
      high_max: 1,
      arrays_len: "fact_summary/implications/outlook は各2〜4",
      length: "各項目は50文字目安、title_jaは30文字目安、one_sentenceは60文字目安",
      tone: "煽り禁止、主観断定禁止、丁寧で簡潔",
    },
  };

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const debugInfo = { ok: false, status: null, error: null, raw_preview: null };

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

    // 軽いスキーマ検証
    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== OUTPUT_ITEMS) {
      debugInfo.error = { kind: "schema_invalid", payload_preview: JSON.stringify(payload).slice(0, 900) };
      throw new Error("OpenAI schema invalid: items must be 3");
    }

    debugInfo.ok = true;

    // debug時だけ返す情報
    return { payload, debugInfo };
  } catch (err) {
    if (err?.name === "AbortError") {
      debugInfo.error = { kind: "abort_timeout", name: err.name, message: err.message };
    } else if (!debugInfo.error) {
      debugInfo.error = { kind: "exception", name: err?.name, message: err?.message || String(err) };
    }
    if (!debug) {
      // 本番は詳細を隠す
      debugInfo.error = { kind: debugInfo.error?.kind || "error" };
    }
    return { payload: null, debugInfo };
  } finally {
    clearTimeout(id);
  }
}

// ====== フォールバック（OpenAI失敗時でも表示を崩さない） ======
function fallbackPayload(picked) {
  // 影響度は暫定：topicから雑に決める（OpenAI成功時に置き換わる）
  const impactByTopic = {
    regulation: "High",
    funding: "Medium",
    supply_chain: "Medium",
    product: "Medium",
    research: "Low",
    other: "Low",
  };

  const items = picked.map((p) => ({
    impact_level: impactByTopic[p.topic] || "Medium",
    importance_score: p.importance_score,
    score_breakdown: p.score_breakdown,
    title_ja: p.title, // 暫定：原題
    one_sentence: (p.summary || p.title || "").slice(0, 80),
    why_it_matters: "（AI分析失敗のため一時的に自動要約を省略）",
    japan_impact: p.jp
      ? "国内ソースとして優先表示（詳細は元記事参照）"
      : "海外動向として日本企業への波及可能性を注視（詳細は元記事参照）",
    tags: [p.topic],
    fact_summary: [
      `出典: ${p.source}`,
      `要点: ${(p.summary || p.title || "").slice(0, 80)}`,
    ],
    implications: ["示唆: 競争環境や投資判断への影響があり得る"],
    outlook: ["見通し: 追加発表・規制・決算などを注視"],
    original_title: p.title,
    original_url: p.url,
    source: p.source,
    topic: p.topic,
  }));

  // Highが複数になったら調整
  const highs = items.filter((i) => i.impact_level === "High");
  if (highs.length > 1) {
    let first = true;
    for (const it of items) {
      if (it.impact_level === "High") {
        if (first) first = false;
        else it.impact_level = "Medium";
      }
    }
  }

  return {
    date_iso: nowISODate(),
    items,
  };
}

// ====== メイン ======
export default async function handler(req, res) {
  // CORS（あなたの現状に合わせて * のまま）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!gKey || !oKey) return res.status(500).json({ error: "Missing API Keys" });

  // キャッシュ（ETag対応）
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    const clientEtag = req.headers["if-none-match"];
    if (clientEtag && CACHE.etag && clientEtag === CACHE.etag) {
      return res.status(304).end();
    }
    res.setHeader("ETag", CACHE.etag);
    return res.status(200).json({ ...CACHE.payload, cache: { hit: true, ttl_seconds: Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000) } });
  }

  try {
    const parser = new Parser();

    // 1) 並列取得
    const settled = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const allCandidates = settled
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c?.url && hostAllowed(c.url));

    // 2) 多様性を保って3件選ぶ
    const picked = pickDiverseTop(allCandidates);

    // 3) OpenAIで整形（失敗してもフォールバックする）
    const { payload: aiPayload, debugInfo } = await callOpenAI(oKey, picked, debug);

    let payload;
    let ai_ok = false;

    if (aiPayload) {
      payload = aiPayload;
      ai_ok = true;
    } else {
      payload = fallbackPayload(picked);
      ai_ok = false;
    }

    // 4) メタデータ付与
    payload.generated_at = new Date().toISOString();
    payload.version = BUILD_ID;
    payload.build_id = `${BUILD_ID}__${nowISODate()}`;
    payload.sources = Array.from(new Set(picked.map((p) => p.source)));

    // 5) debug情報（ここが “完全デバッグ対応” の核心）
    if (debug) {
      payload.debug = {
        ai_ok,
        openai: debugInfo, // ★失敗理由がここに入る（status/AbortError/body_preview 等）
        merged_count: allCandidates.length,
        picked: picked.map((p) => {
          let host = "";
          try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch {}
          return { source: p.source, host, topic: p.topic, score: p.importance_score, url: p.url };
        }),
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS },
      };
    } else {
      // 本番でも最低限だけ
      payload.ai_ok = ai_ok;
    }

    // 6) キャッシュ保存（ETag）
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };
    res.setHeader("ETag", etag);

    return res.status(200).json({ ...payload, cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) } });
  } catch (err) {
    // ここもdebug時だけ詳細
    return res.status(500).json({
      error: err?.message || String(err),
      ...(debug ? { stack: err?.stack } : {}),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
    });
  }
}
