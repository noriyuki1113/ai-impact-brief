// api/today.js
import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V10_STABLE_UIFIX";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 4500;      // 外部取得は短めで切る
const OPENAI_TIMEOUT_MS = 12000;    // AIは予算内で
const BUDGET_MS = 18000;            // 全体タイムバジェット
const MIN_AI_REMAIN_MS = 9000;      // AIに最低残す時間（残らなければフォールバック）
const OUTPUT_MAIN = 3;
const OUTPUT_OPS = 1;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分

// ====== データソース設定 ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "ITmedia Enterprise", url: "https://rss.itmedia.co.jp/rss/2.0/enterprise.xml", jp: true, weight: 0.9, hint: "security" }, // ops候補増強
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

const ALLOW_HOSTS = [
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "techcrunch.com",
  "itmedia.co.jp",
  "ainow.ai",
  "theguardian.com",
];

let CACHE = { at: 0, payload: null, etag: "" };

// ====== ユーティリティ ======
const nowIso = () => new Date().toISOString();
const isoDate = () => new Date().toISOString().slice(0, 10);

const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
};

function safeUrlHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

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

function stripHtml(s) {
  return (s || "").replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim();
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

// タイトルの“切れ”をUI用に整える（語っ/語り/語る/の/が/を/に/へ/と/や/などで終わったら…付与）
function uiTrimTitle(title, max = 72) {
  const t = (title || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;

  // まずmaxまで切る
  let cut = t.slice(0, max);

  // 句読点/記号で一段戻れるなら戻す（不自然な途中切れを避ける）
  const lastPunc = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("、"),
    cut.lastIndexOf("・"),
    cut.lastIndexOf("】"),
    cut.lastIndexOf("）"),
    cut.lastIndexOf(")"),
    cut.lastIndexOf("]"),
    cut.lastIndexOf("｜"),
    cut.lastIndexOf("|"),
    cut.lastIndexOf(":"),
    cut.lastIndexOf("："),
    cut.lastIndexOf("—"),
    cut.lastIndexOf("–"),
    cut.lastIndexOf("-")
  );
  if (lastPunc >= 28) cut = cut.slice(0, lastPunc + 1);

  cut = cut.replace(/[ 　\-—–:：|｜]+$/, "").trim();

  // “語っ”など明らかな途中で終わってたらさらに少し戻す
  if (/[ぁ-ん一-龥A-Za-z0-9]$/.test(cut) && /(語っ|語り|語る|話|述べ|示|発表|公開|解説)$/.test(cut)) {
    cut = cut.slice(0, -1).trim();
  }

  // 助詞で終わるのも不自然 → …付与
  const endsBad = /(語っ|語り|語る|の|が|を|に|へ|と|や|など|について|にて|で|から)$/.test(cut);
  return cut + (endsBad ? "…" : "…");
}

/**
 * トピック推定ロジック（誤検知対策）
 */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // 「方法」「手法」を除外した「法」にのみ反応させる
  const isRegulation = /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
  if (isRegulation) return "regulation";

  const isSecurity = /security|vuln|vulnerability|cve|cvss|breach|attack|phish|malware|ransom|exploit|脆弱|攻撃|詐欺|不正|漏えい|侵害|マルウェア|ランサム/.test(t);
  if (isSecurity) return "security";

  if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|アップデート|公開|提供|議事録|会議/.test(t)) return "product";
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
  if (/japan|日本|国内|公取委|総務省|経産省|金融庁|個人情報|ガイドライン/.test(c.title || "")) s += 15;

  const bonus = { regulation: 20, security: 18, funding: 15, supply_chain: 15, product: 7, research: 6 };
  s += bonus[c.topic] || 0;

  s = clamp(s, 0, 95);

  return {
    score: s,
    breakdown: {
      market_impact: clamp(Math.round(s * 0.4), 0, 40),
      business_impact: clamp(Math.round(s * 0.3), 0, 30),
      japan_relevance: clamp(c.jp ? 20 : 10, 0, 25),
      confidence: 6, // RSS中心のため固定（必要なら将来上げる）
    },
  };
}

// ====== データ取得関数 ======
async function fetchGuardian(key) {
  const url =
    `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=10&show-fields=trailText&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json();

    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: stripHtml(a.webTitle),
      summary: stripHtml(a.fields?.trailText || ""),
      jp: false,
      weight: 0.85,
      hint: "market",
      published_at: a.webPublicationDate || null,
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
      title: stripHtml(it.title),
      summary: stripHtml(it.contentSnippet || it.content || "").slice(0, 700),
      jp: !!src.jp,
      weight: src.weight,
      hint: src.hint,
      published_at: it.isoDate || it.pubDate || null,
    }));
  } catch {
    return [];
  }
}

/**
 * 多様性を維持したピック（mainとopsを分離）
 */
function pickDiverse(enriched, mainN, opsN) {
  const sorted = [...enriched].sort((a, b) => b.importance_score - a.importance_score);

  // ops: securityだけ（同一ホスト1つまで）
  const ops = [];
  const usedOpsHosts = new Set();

  for (const c of sorted) {
    if (ops.length >= opsN) break;
    if (c.topic !== "security") continue;
    const host = safeUrlHost(c.url);
    if (!host || usedOpsHosts.has(host)) continue;
    ops.push({ ...c, ops: true });
    usedOpsHosts.add(host);
  }

  // main: ホスト重複禁止 + topic重複は基本NG（ただし足りなければ補填）
  const main = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  // opsで使ったURLは除外
  const opsUrls = new Set(ops.map((x) => x.url));

  for (const c of sorted) {
    if (main.length >= mainN) break;
    if (opsUrls.has(c.url)) continue;

    const host = safeUrlHost(c.url);
    if (!host) continue;

    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      main.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 補填
  let i = 0;
  while (main.length < mainN && i < sorted.length) {
    const c = sorted[i++];
    if (opsUrls.has(c.url)) continue;
    if (main.find((p) => p.url === c.url)) continue;
    main.push(c);
  }

  return { main: main.slice(0, mainN), ops: ops.slice(0, opsN) };
}

/**
 * OpenAI Responses API（JSON Schemaで安定返却）
 * - temperature 等の非対応パラメータは送らない
 */
async function callOpenAI_Responses(oKey, input, timeoutMs = OPENAI_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${oKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        // Responses API: 出力フォーマットは text.format に移動
        text: {
          format: {
            type: "json_schema",
            name: "strategic_ai_brief",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                items: {
                  type: "array",
                  minItems: 1,
                  maxItems: OUTPUT_MAIN + OUTPUT_OPS,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title_ja: { type: "string", maxLength: 72 }, // ★60→72（UI切れ改善）
                      one_sentence: { type: "string", maxLength: 160 },
                      why_it_matters: { type: "string", maxLength: 140 },
                      japan_impact: { type: "string", maxLength: 140 },
                      fact_summary: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", maxLength: 120 } },
                      implications: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", maxLength: 120 } },
                      outlook: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", maxLength: 120 } },
                    },
                    required: ["title_ja", "fact_summary", "implications", "outlook"],
                  },
                },
              },
              required: ["items"],
            },
          },
        },
        input,
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: `OpenAI HTTP ${response.status}`, raw_preview: rawText.slice(0, 400) };
    }

    // Responses APIのテキスト出力を安全に抽出
    // 典型: { output: [{ content: [{ type: "output_text", text: "{...json...}" }] }] }
    let data;
    try { data = JSON.parse(rawText); } catch { return { ok: false, status: 0, error: "OpenAI non-JSON response", raw_preview: rawText.slice(0, 400) }; }

    const textParts =
      (data?.output || [])
        .flatMap((o) => o?.content || [])
        .filter((c) => c?.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text);

    const joined = textParts.join("\n").trim();
    if (!joined) return { ok: false, status: 0, error: "OpenAI empty output_text", raw_preview: rawText.slice(0, 400) };

    let json;
    try { json = JSON.parse(joined); } catch { return { ok: false, status: 0, error: "OpenAI output_text not JSON", raw_preview: joined.slice(0, 400) }; }

    return { ok: true, status: 200, json, raw_preview: joined.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === "AbortError" ? "This operation was aborted" : (e?.message || "OpenAI request failed"), raw_preview: "" };
  } finally {
    clearTimeout(id);
  }
}

/**
 * AI結果を“候補のメタ”へマージ（URLは保持、タイトルはUI整形）
 */
function mergeAiIntoPicked(aiItems, pickedAll, pickedIndexByUrl) {
  const out = [];

  for (let i = 0; i < pickedAll.length; i++) {
    const p = pickedAll[i];
    const ai = aiItems?.[i] || null;

    const merged = {
      impact_level: p.impact_level,
      importance_score: p.importance_score,
      score_breakdown: p.score_breakdown,
      topic: p.topic,
      tags: [p.topic],

      title_ja: uiTrimTitle(ai?.title_ja || p.title, 72),
      one_sentence: (ai?.one_sentence || "").trim() || stripHtml(p.summary || "").slice(0, 160),
      why_it_matters: (ai?.why_it_matters || "").trim() || "市場構造・競争条件・投資判断に波及し得るため。",
      japan_impact: (ai?.japan_impact || "").trim() || (p.jp ? "日本市場への直接影響が見込まれるため、優先度高く点検。" : "海外動向として、日本企業の戦略/調達/規制対応への波及を注視。"),

      fact_summary: Array.isArray(ai?.fact_summary) ? ai.fact_summary.slice(0, 3) : [`出典: ${p.source}`, "要点: 元記事参照"],
      implications: Array.isArray(ai?.implications) ? ai.implications.slice(0, 3) : ["示唆: 競争環境・投資判断・調達方針に波及し得る", "示唆: 日本市場では規制/供給網/投資動向の影響を点検"],
      outlook: Array.isArray(ai?.outlook) ? ai.outlook.slice(0, 3) : ["見通し: 追加発表・規制当局・決算の動きが焦点", "見通し: 6〜12か月での政策・投資・採用動向を注視"],

      original_title: p.title,
      original_url: p.url,
      source: p.source,
      published_at: p.published_at || null,
    };

    // fact_summary等の文字整形
    merged.fact_summary = merged.fact_summary.map((s) => stripHtml(s).slice(0, 120));
    merged.implications = merged.implications.map((s) => stripHtml(s).slice(0, 120));
    merged.outlook = merged.outlook.map((s) => stripHtml(s).slice(0, 120));

    out.push(merged);
  }

  return out;
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  const t0 = Date.now();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ETag対応（CDN/ブラウザキャッシュ）
  if (CACHE.payload && CACHE.etag) {
    res.setHeader("ETag", CACHE.etag);
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === CACHE.etag) {
      return res.status(304).end();
    }
  }

  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  if (!oKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  // まずアプリ内キャッシュ
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    return res.status(200).json({
      ...CACHE.payload,
      cache: { hit: true, ttl_seconds: Math.max(0, Math.floor((CACHE_TTL_MS - (Date.now() - CACHE.at)) / 1000)) },
    });
  }

  try {
    const parser = new Parser();

    // 1) 並列取得
    const jobs = [
      ...(gKey ? [fetchGuardian(gKey)] : []),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ];

    const results = await Promise.allSettled(jobs);

    const allCandidates = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .map((c) => ({ ...c, url: normalizeUrl(c.url) }))
      .filter((c) => c.url && ALLOW_HOSTS.includes(safeUrlHost(c.url)))
      // 重複排除（URL）
      .filter((c, idx, arr) => arr.findIndex((x) => x.url === c.url) === idx);

    // 2) enrich + score
    const enriched = allCandidates.map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });

      const impact =
        score >= 85 ? "High" :
        score >= 70 ? "Medium" : "Low";

      return {
        ...c,
        topic,
        importance_score: score,
        score_breakdown: breakdown,
        impact_level: impact,
      };
    });

    // 3) pick main/ops
    const { main, ops } = pickDiverse(enriched, OUTPUT_MAIN, OUTPUT_OPS);

    const pickedAll = [...main, ...ops];
    const sources = [...new Set(pickedAll.map((x) => x.source))];

    // 4) AIを呼べるか判定（残り時間）
    const elapsed = Date.now() - t0;
    const remain = BUDGET_MS - elapsed;

    let ai_ok = false;
    let ai = { ok: false, status: 0, error: "Skipped", raw_preview: "" };
    let itemsMerged;

    const pickedForAi = pickedAll.map((p) => ({
      title: p.title,
      url: p.url,
      source: p.source,
      topic: p.topic,
      jp: p.jp,
      summary: (p.summary || "").slice(0, 700),
    }));

    if (remain >= MIN_AI_REMAIN_MS) {
      // Responses APIへ渡す input（system的指示はinput文字列に含める）
      const input = [
        {
          role: "system",
          content:
            "あなたは日本市場視点のAI戦略アナリスト。入力ニュース（title/summary/topic）ごとに、" +
            "1) 日本語タイトル（短く自然、途中で切れない） 2) 1行要約 3) なぜ重要か 4) 日本への影響 " +
            "5) 事実要点（2〜3） 6) 示唆（2〜3） 7) 見通し（2〜3）を作る。誇張せず、推測は避ける。"
        },
        { role: "user", content: JSON.stringify({ picked: pickedForAi }) },
      ];

      ai = await callOpenAI_Responses(oKey, input, OPENAI_TIMEOUT_MS);
      ai_ok = !!ai.ok;

      if (ai_ok) {
        const aiItems = ai.json?.items;
        itemsMerged = mergeAiIntoPicked(aiItems, pickedAll);
      }
    }

    // 5) AI失敗/スキップ時のフォールバック（それでもUI整形はかける）
    if (!itemsMerged) {
      itemsMerged = pickedAll.map((p) => ({
        impact_level: p.impact_level,
        importance_score: p.importance_score,
        score_breakdown: p.score_breakdown,
        topic: p.topic,
        tags: [p.topic],

        title_ja: uiTrimTitle(p.title, 72),
        one_sentence: stripHtml(p.summary || "").slice(0, 160) || "要点: 元記事参照",
        why_it_matters: "市場構造・競争条件・投資判断に波及し得るため。",
        japan_impact: p.jp ? "日本市場への直接影響が見込まれるため、優先度高く点検。" : "海外動向として、日本企業の戦略/調達/規制対応への波及を注視。",

        fact_summary: [`出典: ${p.source}`, "要点: 元記事参照"],
        implications: ["示唆: 競争環境・投資判断・調達方針に波及し得る", "示唆: 日本市場では規制/供給網/投資動向の影響を点検"],
        outlook: ["見通し: 追加発表・規制当局・決算の動きが焦点", "見通し: 6〜12か月での政策・投資・採用動向を注視"],

        original_title: p.title,
        original_url: p.url,
        source: p.source,
        published_at: p.published_at || null,
      }));
    }

    // 6) main/ops 分割（topic==security & ops==true をopsへ）
    const opsUrls = new Set(ops.map((x) => x.url));
    const main_items = itemsMerged.filter((x) => !opsUrls.has(x.original_url)).slice(0, OUTPUT_MAIN);
    const ops_items = itemsMerged.filter((x) => opsUrls.has(x.original_url)).slice(0, OUTPUT_OPS);

    const payload = {
      date_iso: isoDate(),
      items: itemsMerged,      // 互換用（全部入り）
      main_items,
      ops_items,
      sources,
      generated_at: nowIso(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${isoDate()}`,
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
      debug: {
        ai_ok,
        openai: ai_ok ? { ok: true, status: ai.status, error: null, raw_preview: ai.raw_preview } : { ok: false, status: ai.status, error: ai.error, raw_preview: ai.raw_preview },
        merged_count: enriched.length,
        pool_count: allCandidates.length,
        picked: pickedAll.map((p) => ({
          source: p.source,
          host: safeUrlHost(p.url),
          topic: p.topic,
          score: p.importance_score,
          url: p.url,
          ops: opsUrls.has(p.url) || undefined,
        })),
        timeouts: {
          fetch: FETCH_TIMEOUT_MS,
          openai: OPENAI_TIMEOUT_MS,
          budget: BUDGET_MS,
          min_ai_remain: MIN_AI_REMAIN_MS,
        },
        remaining_ms_before_return: Math.max(0, BUDGET_MS - (Date.now() - t0)),
      },
    };

    // 7) キャッシュ更新（ETag付与）
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || "Internal Server Error",
      stack: err?.stack || "",
      version: BUILD_ID,
      generated_at: nowIso(),
    });
  }
}
