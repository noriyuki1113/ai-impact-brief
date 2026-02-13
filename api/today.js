// /api/today.js  (Vercel Serverless Function)
// A-GDELT-6.0 ✅完全統合版（Guardian + GDELT + OpenAI）
// - GDELTは“単発クエリ”に統合（5秒ルール待機の連鎖を排除 → Abort激減）
// - GDELT timeoutを25秒に延長
// - GDELT allowlist（低品質媒体除外）
// - URL正規化＆重複除外
// - published_at ISO8601統一（GDELT/Guardian混在OK）
// - 2ソース以上を“取れたら必ず混ぜる”（最低1本は非Guardian優先）
// - テーマ分散（簡易）
// - High最大1件を強制
// - importance_scoreで最終ソート
// - debug=1で内部状態表示
//
// 必要環境変数:
//   GUARDIAN_API_KEY
//   OPENAI_API_KEY
//
// 使い方:
//   https://<your-domain>/api/today
//   https://<your-domain>/api/today?debug=1

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
  // 0) Debug + Cache Control
  // =========================
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const cacheBust = urlObj.searchParams.get("v") || "";

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

    function hostOf(u) {
      try {
        return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    }

    // ✅ allowlist（必要に応じて増やしてOK）
    const GDELT_ALLOWLIST = new Set([
      "reuters.com",
      "bloomberg.com",
      "ft.com",
      "wsj.com",
      "theverge.com",
      "techcrunch.com",
      "venturebeat.com",
      "arstechnica.com",
      "axios.com",
      "semafor.com",
      "economist.com",
      "nature.com",
      "science.org",
      "nytimes.com",
      "washingtonpost.com",
      "bbc.co.uk",
      "bbc.com",
      // 日本系（任意）
      "nikkei.com",
      "itmedia.co.jp",
      "impress.co.jp",
      "ascii.jp",
    ]);

    function isAllowedDomain(u) {
      const h = hostOf(u);
      if (!h) return false;
      for (const d of GDELT_ALLOWLIST) {
        if (h === d || h.endsWith("." + d)) return true;
      }
      return false;
    }

    function dedupeByUrl(items) {
      const seen = new Set();
      const out = [];
      for (const x of items) {
        const u = normalizeUrl(
          x.original_url || x.originalUrl || x.url || x.link || ""
        );
        if (!u) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push({ ...x, original_url: u });
      }
      return out;
    }

    // GDELTの 20260213T031500Z を ISOへ / 既にISOならそのまま
    function toIsoMaybe(s) {
      const v = String(s || "").trim();
      const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
      if (v.includes("-") && v.includes("T")) return v;
      return v || "";
    }

    function themeBucket(title = "", body = "") {
      const t = (title + " " + body).toLowerCase();
      if (t.match(/policy|regulation|governance|law|ban|commission|ministry|act/))
        return "policy";
      if (
        t.match(
          /chip|semiconductor|export|controls|supply chain|compute|data center|accelerator|gpu/
        )
      )
        return "compute";
      if (t.match(/funding|investment|ipo|acquisition|m&a|valuation|round|venture/))
        return "capital";
      if (t.match(/copyright|licensing|lawsuit|court|publisher/))
        return "copyright";
      if (t.match(/security|safety|bio|misuse|fraud|deepfake/)) return "risk";
      if (t.match(/openai|google|microsoft|amazon|meta|anthropic|deepmind|nvidia/))
        return "bigtech";
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

    // ✅ 取れたら必ず非Guardianを混ぜる（最低1本）
    function pick3WithSourceGuarantee(allCandidates) {
      const guardian = allCandidates.filter((x) => x.source === "The Guardian");
      const nonGuardian = allCandidates.filter((x) => x.source !== "The Guardian");

      // まず非Guardianを多様化しながら最大1本（=混ぜる枠）
      const picked = [];
      if (nonGuardian.length > 0) {
        const ng = pickDiversified(nonGuardian, 1);
        picked.push(...ng);
      }

      // 残りは全体から分散して選ぶ
      const rest = allCandidates.filter(
        (x) => !picked.find((p) => p.original_url === x.original_url)
      );
      const more = pickDiversified(rest, 3 - picked.length);

      const out = dedupeByUrl([...picked, ...more]).slice(0, 3);

      // もし足りないならGuardianで埋める
      if (out.length < 3) {
        const fb = pickDiversified(dedupeByUrl(guardian), 3);
        return fb;
      }
      return out;
    }

    // =========================
    // 1) Guardian
    // =========================
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=10` +
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

    const guardianArticles = results.slice(0, 10).map((a) => ({
      original_title: a.webTitle || "",
      original_url: normalizeUrl(a.webUrl || ""),
      published_at: toIsoMaybe(a.webPublicationDate || ""),
      source: "The Guardian",
      body: String(a?.fields?.trailText || a?.fields?.bodyText || "")
        .replace(/\s+/g, " ")
        .slice(0, 2500),
    }));

    // =========================
    // 2) GDELT (Doc 2.1)
    // ✅ “単発”クエリで短語エラー回避＆タイムアウト回避
    // ✅ 5秒ルールも自然に守れる（単発＋失敗時の待機）
    // =========================
    const GDELT_QUERY_SINGLE =
      '(artificial intelligence OR AI) ' +
      '(regulation OR governance OR commission OR law OR act OR export OR controls OR semiconductor OR chip OR GPU OR accelerator OR funding OR investment OR valuation OR venture)';

    async function fetchGdeltOnce({ query, maxrecords = 60, timespan = "1d" }) {
      const base = "https://api.gdeltproject.org/api/v2/doc/doc";
      const u = new URL(base);
      u.searchParams.set("query", query);
      u.searchParams.set("mode", "ArtList");
      u.searchParams.set("format", "json");
      u.searchParams.set("maxrecords", String(maxrecords));
      u.searchParams.set("timespan", timespan);

      // ✅ GDELTは遅い時があるので25秒
      const r = await fetchWithTimeout(u.toString(), {}, 25000);
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
      const mapped = arts
        .map((a) => ({
          original_title: String(a?.title || "").trim(),
          original_url: normalizeUrl(a?.url || ""),
          published_at: toIsoMaybe(a?.seendate || ""),
          source: "GDELT",
          language: a?.language || "",
          body: `${a?.title || ""} ${a?.description || ""}`
            .replace(/\s+/g, " ")
            .slice(0, 900),
        }))
        .filter((x) => x.original_url && x.original_title);

      // ✅ allowlistで品質安定
      return mapped.filter((x) => isAllowedDomain(x.original_url));
    }

    async function fetchGdeltSafeSingle() {
      // 最大2回（失敗したら5秒待って再試行）
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await fetchGdeltOnce({
            query: GDELT_QUERY_SINGLE,
            maxrecords: 60,
            timespan: "1d",
          });
        } catch (e) {
          await sleep(5000);
          if (attempt === 1) throw e;
        }
      }
      return [];
    }

    let gdeltItems = [];
    let gdeltError = null;
    try {
      gdeltItems = await fetchGdeltSafeSingle();
    } catch (e) {
      gdeltItems = [];
      gdeltError = e?.message || String(e);
      console.warn("⚠️ GDELT fetch failed:", gdeltError);
    }

    // =========================
    // 3) Merge -> dedupe -> pick final3
    // =========================
    const merged = dedupeByUrl([...guardianArticles, ...gdeltItems]);
    let final3 = pick3WithSourceGuarantee(merged);

    // フォールバック
    if (final3.length < 3) {
      const fb = pickDiversified(dedupeByUrl(guardianArticles), 3);
      final3 = fb;
    }

    // =========================
    // 4) OpenAI prompt
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
各記事3〜6個。英語の短いタグで統一（例：Regulation, Chips, Funding, Japan, Europe, Security）。

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

    // 元記事マップ（source/published補完用）
    const srcMap = new Map(final3.map((a) => [normalizeUrl(a.original_url), a]));

    payload.items = payload.items.map((it) => {
      const out = { ...it };
      out.original_url = normalizeUrl(out.original_url || "");
      const src = srcMap.get(out.original_url);

      // typo rescue
      if (!out.why_it_matters && out["why_it.matters"]) {
        out.why_it_matters = out["why_it.matters"];
        delete out["why_it.matters"];
      }

      // score breakdown
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
      out.importance_score = clamp(
        toInt(out.importance_score) ?? market + biz + jp + conf,
        0,
        100
      );

      out.impact_level = ["High", "Medium", "Low"].includes(out.impact_level)
        ? out.impact_level
        : levelFromScore(out.importance_score);

      out.tags = ensureTags(out.tags);

      // 補完
      out.source = out.source || src?.source || "";
      out.published_at = toIsoMaybe(out.published_at || src?.published_at || "");

      for (const f of ["fact_summary", "implications", "outlook"]) {
        if (!Array.isArray(out[f])) out[f] = [];
        out[f] = out[f].map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
        if (out[f].length < 2) {
          out[f] = out[f]
            .concat(["情報が限定的なため追加確認が必要", "一次情報の更新を注視"])
            .slice(0, 2);
        }
      }

      for (const k of ["title_ja", "one_sentence", "why_it_matters", "japan_impact", "original_title"]) {
        if (typeof out[k] === "string") out[k] = out[k].trim();
      }

      return out;
    });

    // importance順
    payload.items.sort((a, b) => (Number(b.importance_score) || 0) - (Number(a.importance_score) || 0));

    // ✅ High最大1件を強制
    let highCount = 0;
    payload.items = payload.items.map((it) => {
      const out = { ...it };
      if (out.impact_level === "High") {
        highCount++;
        if (highCount > 1) out.impact_level = "Medium";
      }
      return out;
    });

    payload.generated_at = new Date().toISOString();
    payload.version = "A-GDELT-6.0";
    payload.sources = Array.from(new Set(payload.items.map((x) => x.source).filter(Boolean)));

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
            host: hostOf(a.original_url),
          })),
          queries: [GDELT_QUERY_SINGLE],
          allowlist_size: GDELT_ALLOWLIST.size,
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
