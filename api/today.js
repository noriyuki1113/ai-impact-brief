// /pages/api/latest.js
// STRATEGIC AI IMPACT BRIEF — V10 "ALL-IN" (stable + angle + main/ops split + OpenAI resilient)
// Works on Vercel / Next.js Pages Router (pages/api/*).
// Env required: OPENAI_API_KEY
// Optional: GUARDIAN_API_KEY

import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/** ========= BUILD ========= */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V10_ALLIN";
const EDITORIAL_MODE_DEFAULT = "attack"; // "attack" | "calm" | "ops"

/** ========= Tunables ========= */
const FETCH_TIMEOUT_MS = 4500;
const OPENAI_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const MAIN_ITEMS = 3;
const OPS_ITEMS = 1;
const POOL_PER_SOURCE = 10;
const MAX_CANDIDATES = 120;

/** ========= Sources ========= */
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

/** ========= In-memory cache ========= */
let CACHE = { at: 0, payload: null, etag: "" };

/** ========= Utils ========= */
const sha1Like = (s) => {
  // fast non-crypto hash (FNV-ish)
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
};

function nowISODateJST() {
  // Vercel runs UTC; return YYYY-MM-DD in JST (+09:00)
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function cleanText(s) {
  return (s || "")
    .replace(/<[^>]*>?/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isAllowed(url) {
  const h = hostOf(url);
  return !!h && ALLOW_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

function toISODateMaybe(d) {
  try {
    if (!d) return null;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  } catch {
    return null;
  }
}

/** ========= Topic detection (JP false-positive guard) ========= */
function guessTopic(title, hint) {
  const t = (title || "").toLowerCase();

  // Security first (ops)
  if (
    /cve|cvss|vuln|vulnerability|exploit|malware|phish|ransom|breach|incident|security|zero[- ]?click|脆弱性|攻撃|不正|侵害|漏えい|詐欺|フィッシング|マルウェア|ランサム/.test(
      t
    )
  )
    return "security";

  // Regulation (guard against 方法/手法)
  const isRegulation =
    /regulat|law|act|ban|suit|court|antitrust|dma|dsa|doj|ftc|訴訟|規制|法案|司法|裁判|公取委|独禁|競争政策|競争法|(?<![方手])法/.test(
      t
    );
  if (isRegulation) return "regulation";

  if (/fund|financ|valuation|ipo|raises|deal|round|資金|調達|評価額|上場|出資|投資/.test(t)) return "funding";
  if (/chip|gpu|semiconductor|export|nvidia|tsmc|intel|amd|半導体|輸出|供給/.test(t)) return "supply_chain";
  if (/model|release|launch|api|tool|product|update|アップデート|公開|提供|リリース|機能/.test(t)) return "product";
  if (/research|paper|benchmark|arxiv|study|研究|論文|ベンチマーク/.test(t)) return "research";

  return hint || "other";
}

/** ========= Scoring ========= */
function scoreCandidate(c) {
  let s = 40;
  s += Math.round((c.weight ?? 0.8) * 20);

  // JP boosts
  if (c.jp) s += 12;
  if (/japan|日本|国内|公取委|総務省|経産省|金融庁|個人情報保護/.test(c.title || "")) s += 15;

  // Topic bonuses
  const bonus = {
    security: 22,
    regulation: 20,
    funding: 14,
    supply_chain: 14,
    product: 7,
    research: 6,
    other: 0,
  };
  s += bonus[c.topic] ?? 0;

  // Freshness bump (last 7 days)
  if (c.published_at) {
    const ageMs = Date.now() - new Date(c.published_at).getTime();
    const days = ageMs / (24 * 60 * 60 * 1000);
    if (days <= 1) s += 8;
    else if (days <= 3) s += 5;
    else if (days <= 7) s += 2;
  }

  s = Math.max(0, Math.min(95, s));
  return {
    score: s,
    breakdown: {
      market_impact: Math.min(40, Math.round(s * 0.4)),
      business_impact: Math.min(30, Math.round(s * 0.3)),
      japan_relevance: Math.min(25, c.jp ? 20 : 10),
      confidence: 6,
    },
  };
}

/** ========= Fetchers ========= */
async function fetchGuardian(key) {
  if (!key) return [];
  const url = `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=${encodeURIComponent(
    String(POOL_PER_SOURCE)
  )}&show-fields=trailText&api-key=${encodeURIComponent(key)}`;

  try {
    const res = await timeoutFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.response?.results || []).map((a) => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle,
      summary: cleanText(a.fields?.trailText || ""),
      jp: false,
      weight: 0.95,
      hint: "market",
      published_at: toISODateMaybe(a.webPublicationDate || null),
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

    const items = (feed.items || []).slice(0, POOL_PER_SOURCE).map((it) => {
      const link = normalizeUrl(it.link || it.guid || "");
      const published_at =
        toISODateMaybe(it.isoDate) || toISODateMaybe(it.pubDate) || toISODateMaybe(it.published) || null;

      return {
        source: src.name,
        url: link,
        title: it.title || "",
        summary: cleanText((it.contentSnippet || it.content || "").slice(0, 800)),
        jp: !!src.jp,
        weight: src.weight,
        hint: src.hint,
        published_at,
      };
    });

    return items;
  } catch {
    return [];
  }
}

/** ========= Dedup ========= */
function dedupeCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const u = normalizeUrl(c.url);
    const key = `${hostOf(u)}|${(c.title || "").toLowerCase().slice(0, 80)}|${u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, url: u });
  }
  return out;
}

/** ========= Pick main/ops with diversity ========= */
function enrichAndSort(candidates) {
  return candidates
    .map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return {
        ...c,
        topic,
        tags: [topic],
        importance_score: score,
        score_breakdown: breakdown,
      };
    })
    .sort((a, b) => b.importance_score - a.importance_score);
}

function pickMainAndOps(enriched, mainN = MAIN_ITEMS, opsN = OPS_ITEMS) {
  const usedHosts = new Set();
  const usedTopicsMain = new Set();

  // Ops: prioritize security items (JP first), then regulation if no security exists
  const opsPool = enriched.filter((x) => x.topic === "security");
  const opsPicked = [];
  for (const c of opsPool) {
    if (opsPicked.length >= opsN) break;
    const h = hostOf(c.url);
    // ops can share host with main if needed, but avoid duplicates if possible
    if (!opsPicked.find((p) => p.url === c.url)) opsPicked.push({ ...c, ops: true });
  }
  // fallback ops: pick best regulation if no security
  if (opsPicked.length < opsN) {
    for (const c of enriched) {
      if (opsPicked.length >= opsN) break;
      if (c.topic !== "regulation") continue;
      if (!opsPicked.find((p) => p.url === c.url)) opsPicked.push({ ...c, ops: true });
    }
  }

  // Main: enforce host & topic diversity
  const mainPicked = [];
  for (const c of enriched) {
    if (mainPicked.length >= mainN) break;
    if (opsPicked.find((o) => o.url === c.url)) continue;

    const h = hostOf(c.url);
    if (usedHosts.has(h)) continue;
    if (usedTopicsMain.has(c.topic)) continue;

    mainPicked.push({ ...c, ops: false });
    usedHosts.add(h);
    usedTopicsMain.add(c.topic);
  }

  // Fill remaining main slots (relax constraints)
  let i = 0;
  while (mainPicked.length < mainN && i < enriched.length) {
    const c = enriched[i++];
    if (opsPicked.find((o) => o.url === c.url)) continue;
    if (mainPicked.find((m) => m.url === c.url)) continue;
    mainPicked.push({ ...c, ops: false });
  }

  return { mainPicked: mainPicked.slice(0, mainN), opsPicked: opsPicked.slice(0, opsN) };
}

/** ========= Angle (no-AI baseline) ========= */
function buildAngle(mainItems, mode) {
  // Simple “editorial angle” based on dominant topics
  const topics = mainItems.map((x) => x.topic);
  const counts = topics.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
  const topTopic = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "other";

  if (mode === "ops") {
    return {
      angle: "今週のAIリスクは「機能」ではなく「運用と信頼設計」で崩れる",
      takeaway: "情シス/法務/CSの“連携手順”を先に作った組織が、事故コストを最小化する。",
    };
  }

  switch (topTopic) {
    case "regulation":
      return {
        angle: "AI規制は『安全』ではなく『参入障壁』として効いてくる",
        takeaway: "日本企業は“遵守”で終わらず、規制を設計と調達に織り込めるかが勝敗になる。",
      };
    case "security":
      return {
        angle: "AIセキュリティは『攻撃』より『つなぎ方（コネクタ/権限）』で壊れる",
        takeaway: "導入判断は“機能”ではなく、権限設計・監査ログ・遮断手順まで含めた運用品質で決める。",
      };
    case "funding":
      return {
        angle: "資金調達は“技術の勝ち負け”より“配布網と採用の勝ち負け”を決める",
        takeaway: "日本企業はモデル選定より、調達・人材・販売導線の再設計を急ぐべき。",
      };
    case "product":
      return {
        angle: "AIプロダクトは“便利”より“置き換える業務”が決まった瞬間に勝つ",
        takeaway: "PoCの成功より、1つの業務を丸ごと置換する設計がKPIを動かす。",
      };
    default:
      return {
        angle: "AIの勝負は『性能』から『制度・運用・供給』へ移っている",
        takeaway: "日本企業は“最新モデル追い”をやめ、意思決定のレイヤーを上げるべき。",
      };
  }
}

/** ========= OpenAI (resilient) ========= */
async function openaiJSON({ apiKey, modelCandidates, input, timeoutMs }) {
  // Try Responses API first, then Chat Completions fallback.
  // Returns: { ok: true, json } or { ok: false, error, status, raw }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  const sys = [
    "あなたは“強く刺す戦略編集者”です。",
    "ニュースの説明ではなく『意思決定に効く結論』を書いてください。",
    "禁止: 同じ言い回しの反復 / 曖昧語（可能性・注視・し得る）の多用。",
    "必須: why_it_matters には具体語（参入障壁/調達/人材/収益/法務/情シス/広告/監査など）を最低1つ。",
    "必須: japan_impact は部署名または業界名を最低1つ。",
    "出力はJSONのみ。"
  ].join("\n");

  const user = JSON.stringify(input);

  try {
    // 1) Responses API (new)
    for (const model of modelCandidates.responses) {
      try {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            input: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
            // NOTE: Some models reject temperature; omit it entirely for stability.
            // Ask for JSON output by instruction; keep parsing tolerant.
          }),
        });

        const rawText = await res.text();
        if (!res.ok) {
          // keep trying other models
          continue;
        }

        let content = rawText;
        try {
          const data = JSON.parse(rawText);
          // Responses API content location can vary; try common shapes.
          const text =
            data?.output_text ||
            data?.output?.[0]?.content?.[0]?.text ||
            data?.output?.[0]?.content?.[0]?.value ||
            null;

          if (typeof text === "string" && text.trim()) content = text;
        } catch {
          // leave content as rawText
        }

        const json = safeParseJSONFromText(content);
        if (json) return { ok: true, json, status: 200 };
      } catch {
        // try next model
      }
    }

    // 2) Chat Completions (legacy)
    for (const model of modelCandidates.chat) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
          }),
        });

        const data = await res.json().catch(() => null);
        if (!res.ok || !data) continue;

        const txt = data?.choices?.[0]?.message?.content || "";
        const json = safeParseJSONFromText(txt);
        if (json) return { ok: true, json, status: 200 };
      } catch {
        // next
      }
    }

    return { ok: false, error: "OpenAI failed for all models", status: 0, raw: "" };
  } finally {
    clearTimeout(id);
  }
}

function safeParseJSONFromText(s) {
  if (!s) return null;
  const t = String(s).trim();

  // direct
  try {
    const j = JSON.parse(t);
    if (j && typeof j === "object") return j;
  } catch {}

  // extract first {...} block
  const m = t.match(/\{[\s\S]*\}$/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j === "object") return j;
    } catch {}
  }

  return null;
}

/** ========= Fallback writer (no AI) ========= */
function fallbackWrite(item, mode, angle) {
  const t = item.topic;
  const title = cleanText(item.title || "");
  const summary = cleanText(item.summary || "");

  const one = (() => {
    if (t === "security") return `AI導入のボトルネックは“モデル性能”ではなく、権限設計と運用手順だ。`;
    if (t === "regulation") return `AI規制は“理念”ではなく、参入条件と勝者を作るルール設計だ。`;
    if (t === "funding") return `資金調達は市場の“期待”ではなく、採用と配布網の現実を動かす。`;
    if (t === "product") return `AIプロダクトは“機能追加”より、置き換える業務が決まった瞬間に勝つ。`;
    if (t === "research") return `研究は“性能競争”だけでなく、安全・評価・運用の標準を作り始めている。`;
    return `${angle || "今日の争点"}が、次の勝者を決める。`;
  })();

  const why = (() => {
    if (t === "security")
      return "情シス/法務が詰むのは“導入後”。権限・監査ログ・遮断手順がないと、事故コストが一直線に増える。";
    if (t === "regulation")
      return "規制は参入障壁になり、調達・提携・プロダクト設計（ログ/説明責任/データ）を巻き込む。";
    if (t === "funding")
      return "資本は採用と供給（GPU/データ/販売）に直結する。競争条件が一段変わる。";
    if (t === "product")
      return "現場の業務置換が進むと、ツール選定ではなく業務設計が差になる（KPI/責任分界/権限）。";
    if (t === "research")
      return "評価指標が標準化すると、採用判断と購買要件が変わる。市場の“当たり前”が更新される。";
    return "意思決定の前提が変わるニュースだから。";
  })();

  const jp = (() => {
    if (t === "security")
      return "日本企業（情シス/CS/経営企画）は、コネクタ権限・監査ログ・二要素・緊急遮断の“運用設計”を先に作る必要がある。";
    if (t === "regulation")
      return "日本（法務/経営企画）は、競争政策・個情法・業法に沿って、ログ/説明/データ取り扱いを“設計要件”に落とすべき。";
    if (t === "funding")
      return "日本（経営企画/投資/採用）は、海外の資本集中がパートナー選定・価格・人材市場に波及する前提で備える。";
    if (t === "product")
      return "日本（人事/情シス/現場）は、議事録や問い合わせ等“単一業務置換”から定着させるとROIが出やすい。";
    return "日本の意思決定（法務/情シス/経営企画）に直撃する形に翻訳して見る必要がある。";
  })();

  const implications = (() => {
    if (t === "security") return ["SaaS/AIコネクタの権限設計が購買要件になる", "監査ログと遮断手順がない導入は“負債”になる"];
    if (t === "regulation") return ["規制対応がプロダクト要件化する（ログ/説明/データ）", "勝者は“性能”より“準拠と実装速度”で決まる"];
    if (t === "funding") return ["採用・GPU・販売導線で格差が広がる", "提携先の選定基準（資本/配布網）が変わる"];
    if (t === "product") return ["業務置換の設計が差になる（責任分界/運用）", "現場導入は“最初の1機能”の勝ち方が全て"];
    return ["意思決定の前提が動く", "日本では導入要件と購買の観点が変わる"];
  })();

  const outlook = (() => {
    if (t === "security") return ["“安全な接続”が差別化要因になりやすい", "インシデント後に規制/監査が強まる可能性"];
    if (t === "regulation") return ["当局/プラットフォーマーの追加発表が焦点", "6〜12か月で準拠要件が具体化しやすい"];
    if (t === "funding") return ["大型投資が連鎖しやすい", "価格/採用/提携で競争条件が変化"];
    if (t === "product") return ["業務置換の成功事例が増える", "日本企業の導入は“運用設計”次第で加速"];
    return ["次の発表と数字で方向性が確定していく", "日本での導入・規制・投資の波及を点検"];
  })();

  return {
    impact_level: item.importance_score >= 90 ? "High" : item.importance_score >= 75 ? "Medium" : "Low",
    importance_score: item.importance_score,
    score_breakdown: item.score_breakdown,
    topic: item.topic,
    tags: item.tags,
    title_ja: title, // fallback uses original title (could be EN)
    one_sentence: one,
    why_it_matters: why,
    japan_impact: jp,
    fact_summary: [
      `出典: ${item.source}`,
      summary ? `要点: ${summary.slice(0, 140)}${summary.length > 140 ? "…" : ""}` : "要点: 元記事参照",
    ],
    implications,
    outlook,
    original_title: item.title,
    original_url: item.url,
    source: item.source,
    published_at: item.published_at || null,
    ops: !!item.ops,
  };
}

/** ========= Payload Assembly ========= */
function assemblePayload({ dateISO, mode, angleObj, mainFinal, opsFinal, allItems, sources, debug }) {
  return {
    date_iso: dateISO,
    version: BUILD_ID,
    build_id: `${BUILD_ID}__${dateISO}`,
    editorial_mode: mode,
    angle: angleObj.angle,
    angle_takeaway: angleObj.takeaway,
    // "items" contains everything for convenience; UI can use main_items/ops_items
    items: allItems,
    main_items: mainFinal,
    ops_items: opsFinal,
    sources,
    generated_at: new Date().toISOString(),
    cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) },
    ...(debug ? { debug } : {}),
  };
}

/** ========= Handler ========= */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1200"); // CDN-friendly

  if (req.method === "OPTIONS") return res.status(200).end();

  const dateISO = nowISODateJST();
  const mode = (req.query?.mode || EDITORIAL_MODE_DEFAULT).toString(); // attack/calm/ops

  const openaiKey = process.env.OPENAI_API_KEY || "";
  const guardianKey = process.env.GUARDIAN_API_KEY || "";

  // ETag / in-memory cache
  const ifNoneMatch = req.headers["if-none-match"];
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    res.setHeader("ETag", CACHE.etag);
    if (ifNoneMatch && ifNoneMatch === CACHE.etag) return res.status(304).end();
    const cached = { ...CACHE.payload, cache: { ...CACHE.payload.cache, hit: true } };
    return res.status(200).json(cached);
  }

  try {
    const parser = new Parser({
      timeout: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": "ai-impact-brief/1.0 (+https://vercel.com)" },
    });

    // 1) Collect in parallel
    const results = await Promise.allSettled([
      fetchGuardian(guardianKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src)),
    ]);

    const allCandidatesRaw = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c?.url && c?.title)
      .filter((c) => isAllowed(c.url));

    const allCandidates = dedupeCandidates(allCandidatesRaw).slice(0, MAX_CANDIDATES);

    // 2) Enrich, sort
    const enriched = enrichAndSort(allCandidates);

    // 3) Pick main/ops
    const { mainPicked, opsPicked } = pickMainAndOps(enriched, MAIN_ITEMS, OPS_ITEMS);

    // 4) Angle (baseline, no-AI)
    const angleObj = buildAngle(mainPicked, mode);

    // 5) AI rewrite (optional but robust)
    let mainFinal = [];
    let opsFinal = [];
    let aiDebug = { ai_ok: false, openai: { ok: false, status: 0, error: null }, picked: [] };

    const pickedAll = [...mainPicked, ...opsPicked];
    aiDebug.picked = pickedAll.map((p) => ({
      source: p.source,
      host: hostOf(p.url),
      topic: p.topic,
      score: p.importance_score,
      url: p.url,
      ops: !!p.ops,
    }));

    if (openaiKey) {
      const input = {
        mode,
        angle: angleObj.angle,
        angle_takeaway: angleObj.takeaway,
        required_fields: [
          "title_ja",
          "one_sentence",
          "why_it_matters",
          "japan_impact",
          "fact_summary",
          "implications",
          "outlook",
        ],
        items: pickedAll.map((p) => ({
          topic: p.topic,
          ops: !!p.ops,
          source: p.source,
          original_title: p.title,
          original_url: p.url,
          summary: p.summary,
          published_at: p.published_at,
          importance_score: p.importance_score,
          score_breakdown: p.score_breakdown,
        })),
        output_rules: {
          // Ban bland repetition
          ban_phrases: ["波及し得る", "注視", "可能性があるため", "影響が考慮される", "必要がある"],
          style: "短文・断定・意思決定向け",
        },
        output_shape: {
          // Keep it simple: a JSON object with items[]
          items: "array",
        },
      };

      const modelCandidates = {
        responses: ["gpt-4.1-mini", "gpt-4o-mini"],
        chat: ["gpt-4o-mini", "gpt-4.1-mini"],
      };

      const ai = await openaiJSON({
        apiKey: openaiKey,
        modelCandidates,
        input,
        timeoutMs: OPENAI_TIMEOUT_MS,
      });

      aiDebug.openai = { ok: ai.ok, status: ai.status || 0, error: ai.ok ? null : ai.error || "unknown" };
      aiDebug.ai_ok = !!ai.ok;

      if (ai.ok && ai.json && Array.isArray(ai.json.items)) {
        // Merge AI text onto base items while preserving scoring/meta
        const byUrl = new Map(pickedAll.map((p) => [p.url, p]));
        const merged = [];

        for (const x of ai.json.items) {
          const url = normalizeUrl(x.original_url || x.url || "");
          const base = byUrl.get(url);
          if (!base) continue;

          const out = {
            impact_level: base.importance_score >= 90 ? "High" : base.importance_score >= 75 ? "Medium" : "Low",
            importance_score: base.importance_score,
            score_breakdown: base.score_breakdown,
            topic: base.topic,
            tags: base.tags,
            title_ja: cleanText(x.title_ja || base.title),
            one_sentence: cleanText(x.one_sentence || ""),
            why_it_matters: cleanText(x.why_it_matters || ""),
            japan_impact: cleanText(x.japan_impact || ""),
            fact_summary: Array.isArray(x.fact_summary) ? x.fact_summary.map(cleanText).filter(Boolean).slice(0, 5) : [],
            implications: Array.isArray(x.implications) ? x.implications.map(cleanText).filter(Boolean).slice(0, 5) : [],
            outlook: Array.isArray(x.outlook) ? x.outlook.map(cleanText).filter(Boolean).slice(0, 5) : [],
            original_title: base.title,
            original_url: base.url,
            source: base.source,
            published_at: base.published_at || null,
            ops: !!base.ops,
          };

          // guard: if AI returns empty strings, fallback parts
          const fb = fallbackWrite(base, mode, angleObj.angle);
          if (!out.one_sentence) out.one_sentence = fb.one_sentence;
          if (!out.why_it_matters) out.why_it_matters = fb.why_it_matters;
          if (!out.japan_impact) out.japan_impact = fb.japan_impact;
          if (!out.fact_summary.length) out.fact_summary = fb.fact_summary;
          if (!out.implications.length) out.implications = fb.implications;
          if (!out.outlook.length) out.outlook = fb.outlook;

          merged.push(out);
        }

        // If mismatch count, fallback missing ones
        const mergedUrls = new Set(merged.map((m) => m.original_url));
        for (const base of pickedAll) {
          if (!mergedUrls.has(base.url)) merged.push(fallbackWrite(base, mode, angleObj.angle));
        }

        mainFinal = merged.filter((x) => !x.ops).slice(0, MAIN_ITEMS);
        opsFinal = merged.filter((x) => x.ops).slice(0, OPS_ITEMS);
      }
    }

    // 6) Hard fallback (no AI or AI failed)
    if (!mainFinal.length) mainFinal = mainPicked.map((p) => fallbackWrite(p, mode, angleObj.angle)).slice(0, MAIN_ITEMS);
    if (!opsFinal.length) opsFinal = opsPicked.map((p) => fallbackWrite(p, mode, angleObj.angle)).slice(0, OPS_ITEMS);

    // 7) Build payload
    const allItems = [...mainFinal, ...opsFinal];
    const sources = [...new Set(allItems.map((x) => x.source))];

    const payload = assemblePayload({
      dateISO,
      mode,
      angleObj,
      mainFinal,
      opsFinal,
      allItems,
      sources,
      debug: {
        ...aiDebug,
        merged_count: enriched.length,
        pool_count: allCandidates.length,
        allowlist_size: ALLOW_HOSTS.length,
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS },
      },
    });

    // cache + etag
    const etag = `"${sha1Like(JSON.stringify(payload))}"`;
    CACHE = { at: Date.now(), payload, etag };

    res.setHeader("ETag", etag);
    if (ifNoneMatch && ifNoneMatch === etag) return res.status(304).end();

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({
      error: err?.message || "Unknown error",
      version: BUILD_ID,
      generated_at: new Date().toISOString(),
    });
  }
}
