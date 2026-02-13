// /api/today.js  (Vercel Serverless Function)
// ✅ Guardian + ✅ GDELT(“phrase too short”回避クエリ / 非JSON耐性 / 5秒ルール) + ✅ 最低1本は非Guardian強制
// ✅ Debug可視化 + ✅ キャッシュ保護 + ✅ OpenAI整形(Score公開)
// Node 18+ / Vercel そのまま貼り替えOK

module.exports = async function handler(req, res) {
  // ---- Robust CORS ----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");

  const reqAllowedHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    reqAllowedHeaders || "Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method Not Allowed" });

  // =========================
  // 0) Debug flag
  // =========================
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const cacheBust = urlObj.searchParams.get("v") || "";

  // ✅ Cache (protect GDELT)
  if (debug || cacheBust) {
    res.setHeader("Cache-Control", "no-store");
  } else {
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
  }

  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey)
      return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
    if (!openaiKey)
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

    // =========================
    // Helpers
    // =========================
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(id);
      }
    }

    function normalizeUrl(u) {
      try {
        const url = new URL(String(u || "").trim());
        const keep = [];
        for (const [k, v] of url.searchParams.entries()) {
          if (!String(k).toLowerCase().startsWith("utm_")) keep.push([k, v]);
        }
        url.search = "";
        for (const [k, v] of keep) url.searchParams.append(k, v);

        url.hash = "";
        url.protocol = "https:";
        url.hostname = url.hostname.toLowerCase();
        url.pathname = (url.pathname || "/").replace(/\/+$/, "") || "/";
        return url.toString();
      } catch {
        return String(u || "").trim();
      }
    }

    function dedupeByUrl(items) {
      const seen = new Set();
      const out = [];
      for (const x of items) {
        const u = normalizeUrl(x.original_url || x.originalUrl || x.url || "");
        if (!u) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push({ ...x, original_url: u });
      }
      return out;
    }

    function themeBucket(title = "", body = "") {
      const t = (title + " " + body).toLowerCase();
      if (t.match(/policy|regulation|act|governance|law|ban|ai act|commission|ministry/))
        return "policy";
      if (t.match(/chip|gpu|semiconductor|export|supply chain|compute|data center|h100|blackwell/))
        return "compute";
      if (t.match(/funding|investment|ipo|acquisition|m&a|valuation|round|capital|venture/))
        return "capital";
      if (t.match(/openai|google|microsoft|amazon|meta|anthropic|deepmind|nvidia/))
        return "bigtech";
      if (t.match(/copyright|licensing|lawsuit|court|publisher/))
        return "copyright";
      if (t.match(/security|safety|bio|misuse|fraud|deepfake/))
        return "risk";
      return "general";
    }

    function pickDiversified(list, limit = 3) {
      const buckets = new Set();
      const picked = [];
      for (const c of list) {
        const b = themeBucket(c.original_title, c.body || "");
        if (!buckets.has(b)) {
          picked.push(c);
          buckets.add(b);
        }
        if (picked.length >= limit) break;
      }
      if (picked.length < limit) {
        for (const c of list) {
          if (picked.length >= limit) break;
          if (!picked.find((p) => p.original_url === c.original_url)) picked.push(c);
        }
      }
      return picked.slice(0, limit);
    }

    // ✅ Force at least 1 non-Guardian item if available
    function pick3WithSourceGuarantee(allCandidates) {
      const guardian = allCandidates.filter((x) => x.source === "The Guardian");
      const nonGuardian = allCandidates.filter((x) => x.source !== "The Guardian");

      const picked = [];
      if (nonGuardian.length > 0) picked.push(nonGuardian[0]);

      const rest = allCandidates.filter(
        (x) => !picked.find((p) => p.original_url === x.original_url)
      );
      const more = pickDiversified(rest, 3 - picked.length);

      const out = dedupeByUrl([...picked, ...more]).slice(0, 3);
      if (out.length < 3) return pickDiversified(dedupeByUrl(guardian), 3);
      return out;
    }

    // Small Japan relevance boost for ranking
    function japanBoostScore(text = "") {
      const s = String(text).toLowerCase();
      let score = 0;
      if (/japan|japanese|tokyo|osaka|yen|boj|meti|digital agency|fsa/.test(s)) score += 2;
      if (/sony|softbank|ntt|rakuten|toyota|hitachi|fujitsu|nec|kddi|panasonic/.test(s))
        score += 2;
      if (/semiconductor|chip|gpu|export|supply chain|tsmc|asml|nvidia/.test(s)) score += 1;
      return score; // 0-5
    }

    // =========================
    // 1) Guardian (quality baseline)
    // =========================
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=8` +
      `&show-fields=headline,trailText,bodyText` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetchWithTimeout(guardianUrl, {}, 15000);
    if (!guardianRes.ok) {
      const t = await guardianRes.text().catch(() => "");
      return res.status(502).json({
        error: "Guardian API HTTP error",
        status: guardianRes.status,
        statusText: guardianRes.statusText,
        body: t.slice(0, 1500),
      });
    }

    const guardianData = await guardianRes.json();
    const results = guardianData?.response?.results;

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(502).json({ error: "Guardian returned no results" });
    }

    const guardianArticles = results.slice(0, 8).map((a) => ({
      original_title: a.webTitle || "",
      original_url: normalizeUrl(a.webUrl || ""),
      published_at: a.webPublicationDate || "",
      source: "The Guardian",
      body: String(a?.fields?.trailText || a?.fields?.bodyText || "")
        .replace(/\s+/g, " ")
        .slice(0, 2500),
    }));

    // =========================
    // 2) GDELT (worldwide sources)
    //    Fix: "phrase too short" => use simple keyword strings
    // =========================
    const GDELT_QUERIES = [
      "artificial intelligence regulation european union AI Act",
      "artificial intelligence semiconductor chip GPU export controls",
      "artificial intelligence investment funding valuation venture capital",
    ];

    async function fetchGdeltOnce({ query, maxrecords = 30, timespan = "1d" }) {
      const base = "https://api.gdeltproject.org/api/v2/doc/doc";
      const u = new URL(base);
      u.searchParams.set("query", query);
      u.searchParams.set("mode", "ArtList");
      u.searchParams.set("format", "json");
      u.searchParams.set("maxrecords", String(maxrecords));
      u.searchParams.set("timespan", timespan);

      const r = await fetchWithTimeout(u.toString(), {}, 15000);

      const text = await r.text().catch(() => "");

      if (!r.ok) {
        throw new Error(`GDELT HTTP ${r.status}: ${text.slice(0, 220)}`);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`GDELT non-JSON response: ${text.slice(0, 220)}`);
      }

      const arts = Array.isArray(data?.articles) ? data.articles : [];

      return arts.map((a) => ({
        original_title: a?.title || "",
        original_url: normalizeUrl(a?.url || ""),
        published_at: a?.seendate || "",
        source: a?.sourceCountry || a?.source || "GDELT",
        language: a?.language || "",
        body: `${a?.title || ""} ${a?.description || ""}`.replace(/\s+/g, " ").slice(0, 700),
      }));
    }

    async function fetchGdeltBatchSafe(queries, { maxrecords = 30, timespan = "1d" } = {}) {
      const out = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const items = await fetchGdeltOnce({ query: q, maxrecords, timespan });
            out.push(...items);
            break;
          } catch (e) {
            await sleep(5000); // retry wait
            if (attempt === 1) throw e;
          }
        }

        if (i < queries.length - 1) await sleep(5000); // ✅ 5 sec rule
      }
      return out;
    }

    let gdeltItems = [];
    let gdeltError = null;
    try {
      gdeltItems = await fetchGdeltBatchSafe(GDELT_QUERIES, { maxrecords: 30, timespan: "1d" });
    } catch (e) {
      gdeltItems = [];
      gdeltError = e?.message || String(e);
      console.warn("⚠️ GDELT fetch failed:", gdeltError);
    }

    // =========================
    // 3) Merge -> dedupe -> rank -> pick final 3
    // =========================
    const merged = dedupeByUrl([...guardianArticles, ...gdeltItems]);

    merged.sort((a, b) => {
      const A = (a.original_title || "") + " " + (a.body || "");
      const B = (b.original_title || "") + " " + (b.body || "");

      const ja = japanBoostScore(A);
      const jb = japanBoostScore(B);

      const qa = a.source === "The Guardian" ? 1 : 0;
      const qb = b.source === "The Guardian" ? 1 : 0;

      if (jb !== ja) return jb - ja;
      if (qb !== qa) return qb - qa;
      return 0;
    });

    const final3 = pick3WithSourceGuarantee(merged);

    // safety fallback
    if (final3.length < 3) {
      const fb = pickDiversified(dedupeByUrl(guardianArticles), 3);
      final3.splice(0, final3.length, ...fb);
    }

    // =========================
    // 4) OpenAI prompt (JP structured + score)
    // =========================
    const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
「構造で読む、AI戦略ニュース」というコンセプトのもと、感情的・扇動的な表現は一切禁止します。
出力は必ず「有効なJSONのみ」です。説明文やMarkdownは禁止。
投資家・経営層が意思決定に使える、高品質な分析を提供してください。
`.trim();

    const userPrompt = `
以下の海外AIニュース記事（3本）を、日本語で上質かつ客観的に整理してください。

【絶対ルール】
・煽らない（「衝撃」「革命的」等の誇張表現禁止）
・断定しすぎない（「〜とみられる」「〜が示唆される」を使用）
・主観的評価を書かない（客観的事実と分析のみ）
・3本はサブテーマが被らないように分散（規制/投資/供給網/競争など）

【Importance Score（0-100）採点ルール（厳守）】
下記4軸の合計＝importance_score（0-100）。各軸点数も必ず出す。
1) market_impact（0-40）: 市場構造/競争地図/供給網への影響
2) business_impact（0-30）: 経営判断（投資/提携/価格/組織）への影響
3) japan_relevance（0-20）: 日本市場・日本企業・規制・産業への波及
4) confidence（0-10）: 情報確度（一次情報/複数ソース/数字の明確さ）
注意：90以上は“業界転換点級”のみ。インフレ禁止。

【タグ（tags）ルール】
各記事3〜6個。英語の短いタグで統一（例：Regulation, Chips, Funding, Japan, EU, US）。

【出力形式（JSONのみ）】
{
  "date_iso": "YYYY-MM-DD",
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
      "title_ja": "簡潔で品のある日本語タイトル",
      "one_sentence": "1文要約",
      "why_it_matters": "なぜ経営判断に関係するか（1-2文）",
      "japan_impact": "日本への具体的影響（2-3点、短く）",
      "tags": ["Tag1","Tag2","Tag3"],
      "fact_summary": ["..."],
      "implications": ["..."],
      "outlook": ["..."],
      "original_title": "string",
      "original_url": "string",
      "published_at": "ISO string or empty",
      "source": "string"
    }
  ]
}

【追加ルール】
・itemsは必ず3件
・配列（fact_summary/implications/outlook）は各2〜4項目
・impact_level は importance_score と整合（基本）
  - 90-100: High（基本）
  - 70-89: Medium（基本）
  - 0-69: Low（基本）
・各項目は簡潔に（1項目50文字以内を目安）

Articles JSON:
${JSON.stringify(final3)}
`.trim();

    // =========================
    // 5) OpenAI call
    // =========================
    const openaiRes = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
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
      },
      35000
    );

    if (!openaiRes.ok) {
      const t = await openaiRes.text().catch(() => "");
      return res.status(502).json({
        error: "OpenAI API HTTP error",
        status: openaiRes.status,
        statusText: openaiRes.statusText,
        body: t.slice(0, 1500),
      });
    }

    const openaiData = await openaiRes.json();
    const rawText = openaiData?.choices?.[0]?.message?.content;

    if (!rawText) {
      return res.status(502).json({ error: "OpenAI missing content", raw: openaiData });
    }

    // =========================
    // 6) Parse JSON safely
    // =========================
    const cleaned = String(rawText)
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: "OpenAI returned non-JSON",
        rawText: cleaned.slice(0, 2000),
      });
    }

    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== 3) {
      return res.status(502).json({ error: "Schema invalid: items must be 3", raw: payload });
    }

    // =========================
    // 7) Post-processing hardening
    // =========================
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const toInt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    const ensureTags = (tags) => {
      if (!Array.isArray(tags)) return [];
      const cleaned2 = tags
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      return Array.from(new Set(cleaned2));
    };
    const levelFromScore = (score) => (score >= 90 ? "High" : score >= 70 ? "Medium" : "Low");

    const srcMap = new Map(final3.map((a) => [normalizeUrl(a.original_url), a]));

    payload.items = payload.items.map((it) => {
      const out = { ...it };

      // normalize url
      out.original_url = normalizeUrl(out.original_url || "");
      const src = srcMap.get(out.original_url);

      // fix typos like "why_it.matters"
      if (!out.why_it_matters && out["why_it.matters"]) {
        out.why_it_matters = out["why_it.matters"];
        delete out["why_it.matters"];
      }

      // breakdown clamp
      const bd = out.score_breakdown || {};
      const market = clamp(toInt(bd.market_impact) ?? 0, 0, 40);
      const biz = clamp(toInt(bd.business_impact) ?? 0, 0, 30);
      const jp = clamp(toInt(bd.japan_relevance) ?? 0, 0, 20);
      const conf = clamp(toInt(bd.confidence) ?? 0, 0, 10);
      out.score_breakdown = {
        market_impact: market,
        business_impact: biz,
        japan_relevance: jp,
        confidence: conf,
      };
      out.importance_score = clamp(toInt(out.importance_score) ?? market + biz + jp + conf, 0, 100);

      // impact_level align
      out.impact_level = ["High", "Medium", "Low"].includes(out.impact_level)
        ? out.impact_level
        : levelFromScore(out.importance_score);

      // tags
      out.tags = ensureTags(out.tags);

      // source/published fallback from selected articles
      out.source = out.source || src?.source || "";
      out.published_at = out.published_at || src?.published_at || "";

      // arrays safety
      for (const f of ["fact_summary", "implications", "outlook"]) {
        if (!Array.isArray(out[f])) out[f] = [];
        out[f] = out[f].map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
        if (out[f].length < 2) {
          out[f] = out[f].concat(["情報が限定的なため追加確認が必要", "一次情報の更新を注視"]).slice(0, 2);
        }
      }

      // trim strings
      for (const k of ["title_ja", "one_sentence", "why_it_matters", "japan_impact", "original_title"]) {
        if (typeof out[k] === "string") out[k] = out[k].trim();
      }

      return out;
    });

    // sort by score desc
    payload.items.sort((a, b) => (Number(b.importance_score) || 0) - (Number(a.importance_score) || 0));

    // =========================
    // 8) Metadata
    // =========================
    payload.generated_at = new Date().toISOString();
    payload.version = "A-GDELT-3.0";
    payload.sources = Array.from(new Set(payload.items.map((x) => x.source).filter(Boolean)));

    // =========================
    // 9) Debug payload
    // =========================
    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          gdelt_used: gdeltItems.length,
          gdelt_error: gdeltError,
          merged_candidates: merged.length,
          picked: final3.map((a) => ({
            source: a.source,
            original_title: a.original_title,
            original_url: a.original_url,
            published_at: a.published_at,
          })),
          queries: GDELT_QUERIES,
        },
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ API Error:", err);
    return res.status(500).json({
      error: err?.message || String(err),
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
};
