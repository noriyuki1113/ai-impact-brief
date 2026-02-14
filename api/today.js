// api/today.js
// STRATEGIC_AI_BRIEF_V6 — Stable + AbortSafe + Main(3) + Ops(1)

const Parser = require("rss-parser");

module.exports = async function handler(req, res) {
  // ===== CORS / Headers =====
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  // ===== Build Identity =====
  const BUILD_ID = "STRATEGIC_AI_BRIEF_V6_MAIN3_OPS1_ABORTSAFE";

  // ===== Tunables =====
  const OUTPUT_MAIN = 3;   // 本編
  const OUTPUT_OPS = 1;    // 実務/ツール枠
  const FETCH_TIMEOUT_MS = 4500;     // RSS/Guardianを短めに
  const OPENAI_TIMEOUT_MS = 30000;   // OpenAIは少し長めに
  const CACHE_TTL_MS = 15 * 60 * 1000; // 15分
  const MIN_AI_REMAIN_MS = 9000;     // これ未満ならAI呼ばない（abort回避）
  const FUNC_BUDGET_MS = 25000;      // この関数は最大25秒で動かす想定（保守的）

  // ===== Keys =====
  const guardianKey = process.env.GUARDIAN_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
  // Guardianは任意（RSSだけでも動く）。無い場合はGuardianをスキップ
  // if (!guardianKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });

  // ===== Debug flag =====
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";

  // ===== In-memory cache (per lambda warm instance) =====
  // NOTE: Vercel serverless is ephemeral; cache is best-effort only.
  global.__AIBRIEF_CACHE__ = global.__AIBRIEF_CACHE__ || { at: 0, payload: null, etag: "" };
  const CACHE = global.__AIBRIEF_CACHE__;

  // ETag short-circuit
  if (CACHE.payload && Date.now() - CACHE.at < CACHE_TTL_MS) {
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === CACHE.etag) {
      return res.status(304).end();
    }
    res.setHeader("ETag", CACHE.etag);
    return res.status(200).json(CACHE.payload);
  }

  const startedAt = Date.now();

  // ===== Data Sources =====
  const RSS_SOURCES = [
    { name: "OpenAI",       url: "https://openai.com/blog/rss/",                         jp: false, weight: 1.00, hint: "product" },
    { name: "Anthropic",    url: "https://www.anthropic.com/news/rss.xml",               jp: false, weight: 0.95, hint: "product" },
    { name: "DeepMind",     url: "https://deepmind.google/blog/rss.xml",                 jp: false, weight: 0.90, hint: "research" },
    { name: "TechCrunch AI",url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp:false, weight: 0.80, hint: "market" },

    // 日本ソース（強い）
    { name: "ITmedia AI+",  url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",         jp: true,  weight: 1.00, hint: "japan" },
    { name: "AINOW",        url: "https://ainow.ai/feed/",                               jp: true,  weight: 0.70, hint: "product" }
  ];

  const ALLOW_HOSTS = [
    "theguardian.com",
    "openai.com",
    "anthropic.com",
    "deepmind.google",
    "techcrunch.com",
    "itmedia.co.jp",
    "ainow.ai"
  ];

  // ===== Utilities =====
  const sha1Like = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  };

  const stripHtml = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      const params = new URLSearchParams(u.search);
      [...params.keys()].forEach((k) => k.toLowerCase().startsWith("utm_") && params.delete(k));
      u.search = params.toString() ? `?${params.toString()}` : "";
      u.pathname = u.pathname.replace(/\/+$/, "");
      return u.toString();
    } catch {
      return String(raw || "").trim();
    }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  function withinAllowHosts(url) {
    const h = hostOf(url);
    return ALLOW_HOSTS.some((a) => h === a || h.endsWith("." + a));
  }

  function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
  }

  // ===== "HowTo/テンプレ" 除外（本編の質を上げる） =====
  function isHowToish(title) {
    return /(やり方|方法|手順|テンプレ|例文|コピペ|◯選|選\b|完全攻略|入門|初心者|まとめ|徹底解説|効率化テクニック)/.test(title || "");
  }

  // ===== Topic Guess =====
  function guessTopic(title, hint) {
    const t = (title || "").toLowerCase();
    // 「法」誤検知対策：(?<![方手])法
    const isReg = /regulat|law|act|ban|suit|court|antitrust|訴訟|規制|法案|司法|裁判|(?<![方手])法/.test(t);
    if (isReg) return "regulation";
    if (/fund|financ|valuation|ipo|raises|資金|調達|評価額|上場/.test(t)) return "funding";
    if (/chip|gpu|semiconductor|export|nvidia|tsmc|半導体|輸出|サプライ/.test(t)) return "supply_chain";
    if (/model|release|launch|api|tool|product|update|アップデート|公開|提供/.test(t)) return "product";
    if (/research|paper|benchmark|arxiv|研究|論文/.test(t)) return "research";
    if (/security|breach|leak|vulnerab|攻撃|脆弱|漏えい/.test(t)) return "security";
    return hint || "other";
  }

  // ===== Strategic Scoring =====
  function scoreCandidate(c) {
    let s = 40;
    s += Math.round((c.weight || 0.8) * 20);
    if (c.jp) s += 15;

    // 日本政策/当局/国内ワード加点
    if (/japan|日本|国内|公取委|総務省|経産省|金融庁|個人情報保護|著作権/.test(c.title || "")) s += 15;

    const bonus = { regulation: 20, funding: 15, supply_chain: 15, security: 12, product: 6, research: 6, other: 0 };
    s += bonus[c.topic] || 0;

    // HowToは「本編」では弱くする（OPS枠へ寄せる）
    if (isHowToish(c.title)) s -= 18;

    s = Math.max(0, Math.min(95, s));

    // breakdown（見せる用）
    const marketImpact = Math.min(40, Math.round(s * 0.4));
    const businessImpact = Math.min(30, Math.round(s * 0.3));
    const japanRel = Math.min(25, c.jp ? 20 : 10);
    const confidence = 6; // AIが後で調整する想定（フォールバックは固定）

    return {
      score: s,
      breakdown: { market_impact: marketImpact, business_impact: businessImpact, japan_relevance: japanRel, confidence }
    };
  }

  function impactLevelFromScore(score) {
    if (score >= 86) return "High";
    if (score >= 60) return "Medium";
    return "Low";
  }

  // ===== Fetchers =====
  async function fetchGuardian(key) {
    if (!key) return [];
    const url =
      "https://content.guardianapis.com/search" +
      "?section=technology&order-by=newest&page-size=12&show-fields=trailText" +
      `&api-key=${encodeURIComponent(key)}`;

    try {
      const res = await timeoutFetch(url, {}, FETCH_TIMEOUT_MS);
      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      const list = data?.response?.results || [];
      return list.map((a) => ({
        source: "The Guardian",
        url: normalizeUrl(a.webUrl),
        title: a.webTitle || "",
        summary: stripHtml(a.fields?.trailText || ""),
        jp: false,
        weight: 0.90,
        hint: "market"
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

      return (feed.items || []).slice(0, 10).map((it) => ({
        source: src.name,
        url: normalizeUrl(it.link),
        title: stripHtml(it.title || ""),
        summary: stripHtml(it.contentSnippet || it.content || "").slice(0, 600),
        jp: !!src.jp,
        weight: src.weight,
        hint: src.hint
      }));
    } catch {
      return [];
    }
  }

  // ===== Dedup =====
  function dedupeCandidates(cands) {
    const seen = new Set();
    const out = [];
    for (const c of cands) {
      const u = normalizeUrl(c.url);
      if (!u) continue;
      const key = u.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, url: u });
    }
    return out;
  }

  // ===== Pick Logic: Main(3) =====
  function pickMainDiverse(enriched) {
    const picked = [];
    const usedHosts = new Set();
    const usedTopics = new Set();

    // 本編は HowTo を落としやすくする
    const primaryPool = enriched.filter((c) => !isHowToish(c.title));

    for (const c of primaryPool) {
      if (picked.length >= OUTPUT_MAIN) break;
      const h = hostOf(c.url);
      if (!h) continue;

      // 同一ホスト/同一トピックを避ける（多様性）
      if (usedHosts.has(h)) continue;
      if (usedTopics.has(c.topic)) continue;

      picked.push(c);
      usedHosts.add(h);
      usedTopics.add(c.topic);
    }

    // 補填（不足分）
    let i = 0;
    while (picked.length < OUTPUT_MAIN && i < primaryPool.length) {
      const c = primaryPool[i++];
      if (!picked.find((p) => p.url === c.url)) picked.push(c);
    }

    // まだ足りないなら、HowTo込みでも補填
    i = 0;
    while (picked.length < OUTPUT_MAIN && i < enriched.length) {
      const c = enriched[i++];
      if (!picked.find((p) => p.url === c.url)) picked.push(c);
    }

    return picked.slice(0, OUTPUT_MAIN);
  }

  // ===== Pick Logic: Ops(1) =====
  function pickOps(enriched, alreadyPickedUrls) {
    const opsPool = enriched
      .filter((c) => !alreadyPickedUrls.has(c.url))
      .filter((c) => c.jp) // OPS枠は日本の現場寄りを優先
      .filter((c) => isHowToish(c.title) || c.topic === "product" || c.topic === "security")
      .sort((a, b) => b.importance_score - a.importance_score);

    if (opsPool.length > 0) return opsPool[0];

    // 代替：日本ソースが無ければ、プロダクト系から1つ
    const alt = enriched
      .filter((c) => !alreadyPickedUrls.has(c.url))
      .filter((c) => c.topic === "product" || c.topic === "security")
      .sort((a, b) => b.importance_score - a.importance_score)[0];

    return alt || null;
  }

  // ===== Fallback Item =====
  function makeFallbackBriefItem(c) {
    return {
      impact_level: impactLevelFromScore(c.importance_score),
      importance_score: c.importance_score,
      score_breakdown: c.score_breakdown,

      title_ja: c.title || "タイトル未取得",
      one_sentence: (c.summary || c.title || "").slice(0, 80) || "要約情報なし",

      why_it_matters: "市場構造・競争条件・投資判断に影響し得るため。",
      japan_impact: c.jp ? "日本市場への直接影響が見込まれるため優先監視。" : "海外動向として波及可能性を注視。",

      tags: [c.topic],
      fact_summary: [
        `出典: ${c.source}`,
        `要点: ${(c.summary || c.title || "").slice(0, 80)}`,
        "リンク: 元記事参照"
      ],
      implications: [
        "示唆: 競争環境・投資判断・調達方針に波及し得る",
        "示唆: 日本市場では規制/供給網/投資動向の影響を点検"
      ],
      outlook: [
        "見通し: 追加発表・規制当局・決算の動きが焦点",
        "見通し: 6〜12か月での政策・投資・採用動向を注視"
      ],

      original_title: c.title || "",
      original_url: c.url || "",
      source: c.source,
      topic: c.topic
    };
  }

  // ===== OpenAI Briefing (AbortSafe) =====
  async function callOpenAI(openaiKey, mainPicked, opsPicked) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    // 送る情報は最小限（token削減＝速度UP）
    const pack = {
      main: mainPicked.map((c) => ({
        source: c.source,
        title: c.title,
        url: c.url,
        summary: (c.summary || "").slice(0, 600),
        topic: c.topic,
        jp: c.jp,
        importance_score: c.importance_score,
        score_breakdown: c.score_breakdown
      })),
      ops: opsPicked
        ? [{
            source: opsPicked.source,
            title: opsPicked.title,
            url: opsPicked.url,
            summary: (opsPicked.summary || "").slice(0, 600),
            topic: opsPicked.topic,
            jp: opsPicked.jp,
            importance_score: opsPicked.importance_score,
            score_breakdown: opsPicked.score_breakdown
          }]
        : []
    };

    const system = `
あなたは「日本市場の視点で、世界のAI戦略ニュースを構造化する」冷静な戦略アナリストです。
煽り・断定・主観的評価は禁止。事実と示唆を分け、短く濃く書く。
出力は必ず有効なJSONのみ。Markdown禁止。

【要件】
- main_items は必ず3件。ops_items は 0〜1件。
- main_items は「規制/供給網/資金調達/市場構造」など“上流”を優先。
- ops_items は「現場の実務・ツール・運用」に寄せる（HowTo系はこちらへ）。
- fact_summary/implications/outlook は各 2〜4 個。1項目は50文字程度まで。
- title_ja は品がある日本語。one_sentence は60〜90文字目安。
- original_url/source/topic/importance_score/score_breakdown は入力値を維持。
`.trim();

    const user = `
次の候補を、日本市場の視点で「本編3本(main_items) + 実務1本(ops_items)」に整形してください。
各アイテムに以下を含める:
impact_level(High/Medium/Low), title_ja, one_sentence, why_it_matters, japan_impact,
tags(配列), fact_summary(配列), implications(配列), outlook(配列),
original_title, original_url, source, topic, importance_score, score_breakdown

【impact_level 目安】
- High: 市場/政策/競争条件を変えうる（構造的）
- Medium: 業界・大手企業単位
- Low: 限定的/実務寄り（ただし ops_items では許容）

入力JSON:
${JSON.stringify(pack)}
`.trim();

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });

      const text = await r.text().catch(() => "");
      if (!r.ok) {
        return { ok: false, status: r.status, error: `OpenAI HTTP ${r.status}`, rawText: text.slice(0, 1200) };
      }

      const data = JSON.parse(text);
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) return { ok: false, status: 502, error: "OpenAI missing content", rawText: text.slice(0, 1200) };

      let obj;
      try { obj = JSON.parse(raw); }
      catch { return { ok: false, status: 502, error: "OpenAI returned non-JSON", rawText: raw.slice(0, 1200) }; }

      // 軽い形チェック
      const main = Array.isArray(obj.main_items) ? obj.main_items : [];
      const ops = Array.isArray(obj.ops_items) ? obj.ops_items : [];
      if (main.length !== 3) return { ok: false, status: 502, error: "Schema: main_items must be 3", rawText: raw.slice(0, 1200) };
      if (ops.length > 1) return { ok: false, status: 502, error: "Schema: ops_items must be 0..1", rawText: raw.slice(0, 1200) };

      return { ok: true, status: 200, json: obj, rawText: raw.slice(0, 800) };
    } catch (e) {
      return { ok: false, status: 0, error: e?.message || "This operation was aborted", rawText: "" };
    } finally {
      clearTimeout(id);
    }
  }

  // ===== Main execution =====
  try {
    const parser = new Parser();

    const tasks = [
      fetchGuardian(guardianKey),
      ...RSS_SOURCES.map((src) => fetchRssSafe(parser, src))
    ];

    const results = await Promise.allSettled(tasks);

    const rawCandidates = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value || [])
      .filter((c) => c.url && c.title)
      .map((c) => ({ ...c, url: normalizeUrl(c.url) }))
      .filter((c) => withinAllowHosts(c.url));

    // dedupe + enrich
    const deduped = dedupeCandidates(rawCandidates);

    const enriched = deduped.map((c) => {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return { ...c, topic, importance_score: score, score_breakdown: breakdown };
    }).sort((a, b) => b.importance_score - a.importance_score);

    // pick main + ops (deterministic)
    const mainPicked = pickMainDiverse(enriched);
    const used = new Set(mainPicked.map((x) => x.url));
    const opsPicked = pickOps(enriched, used);

    // Decide whether we call OpenAI
    const elapsed = Date.now() - startedAt;
    const remaining = FUNC_BUDGET_MS - elapsed;

    let ai_ok = false;
    let payload = null;
    let openaiDebug = { ok: false, status: 0, error: null, raw_preview: "" };

    if (remaining >= MIN_AI_REMAIN_MS) {
      const ai = await callOpenAI(openaiKey, mainPicked, opsPicked);
      ai_ok = !!ai.ok;
      openaiDebug = {
        ok: ai.ok,
        status: ai.status,
        error: ai.ok ? null : ai.error,
        raw_preview: ai.rawText || ""
      };

      if (ai.ok) {
        payload = ai.json;
      }
    }

    // Fallback if AI not ok
    if (!payload) {
      payload = {
        main_items: mainPicked.map(makeFallbackBriefItem),
        ops_items: opsPicked ? [makeFallbackBriefItem(opsPicked)] : []
      };
    }

    // Attach metadata + normalize output
    const out = {
      date_iso: new Date().toISOString().slice(0, 10),
      items: payload.main_items || [],     // 互換：従来items
      main_items: payload.main_items || [],
      ops_items: payload.ops_items || [],
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${new Date().toISOString().slice(0, 10)}`,
      sources: Array.from(new Set([...mainPicked, ...(opsPicked ? [opsPicked] : [])].map((x) => x.source))),
      cache: { hit: false, ttl_seconds: Math.floor(CACHE_TTL_MS / 1000) }
    };

    // debug info
    if (debug) {
      out.debug = {
        ai_ok,
        remaining_ms_before_ai: remaining,
        merged_count: enriched.length,
        pool_count: deduped.length,
        picked: [
          ...mainPicked.map((p) => ({ source: p.source, host: hostOf(p.url), topic: p.topic, score: p.importance_score, url: p.url })),
          ...(opsPicked ? [{ source: opsPicked.source, host: hostOf(opsPicked.url), topic: opsPicked.topic, score: opsPicked.importance_score, url: opsPicked.url, ops: true }] : [])
        ],
        openai: openaiDebug,
        timeouts: { fetch: FETCH_TIMEOUT_MS, openai: OPENAI_TIMEOUT_MS, budget: FUNC_BUDGET_MS, min_ai_remain: MIN_AI_REMAIN_MS }
      };
    }

    // Cache store
    const etag = `"${sha1Like(JSON.stringify(out))}"`;
    global.__AIBRIEF_CACHE__ = { at: Date.now(), payload: out, etag };

    res.setHeader("ETag", etag);
    return res.status(200).json(out);

  } catch (err) {
    return res.status(500).json({
      error: err?.message || String(err),
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined
    });
  }
};
