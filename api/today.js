// /api/today.js (Vercel Serverless Function)
// Guardian + GDELT (5秒制限順守) + OpenAI整形 + Score公開（内訳付き）
// そのまま貼り替えOK

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

  // ✅ CDNキャッシュ（GDELT連打防止の要）
  // - 5分キャッシュ + バックグラウンド再検証10分
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey)
      return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
    if (!openaiKey)
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

    // =========================
    // 0) Debug flag (optional)
    // =========================
    const urlObj = new URL(req.url, "https://example.com");
    const debug = urlObj.searchParams.get("debug") === "1";

    // =========================
    // Helpers
    // =========================
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function fetchWithTimeout(url, { timeoutMs = 12000 } = {}) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: controller.signal });
        return r;
      } finally {
        clearTimeout(id);
      }
    }

    // Normalize URL: strip utm_*, normalize scheme/host, strip trailing slash
    function normalizeUrl(u) {
      try {
        const url = new URL(u);
        // drop utm_*
        const kept = [];
        for (const [k, v] of url.searchParams.entries()) {
          if (!String(k).toLowerCase().startsWith("utm_")) kept.push([k, v]);
        }
        url.search = "";
        for (const [k, v] of kept) url.searchParams.append(k, v);

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
      return items.filter((x) => {
        const u = normalizeUrl(x.original_url || x.originalUrl || x.url || "");
        if (!u) return false;
        if (seen.has(u)) return false;
        seen.add(u);
        x.original_url = u;
        return true;
      });
    }

    function themeBucket(title = "", body = "") {
      const t = (title + " " + body).toLowerCase();
      if (t.match(/policy|regulation|act|governance|law|ban|ai act|white house|commission|ministry/))
        return "policy";
      if (t.match(/chip|gpu|semiconductor|export|supply chain|compute|data center|h100|blackwell/))
        return "compute";
      if (t.match(/funding|investment|ipo|acquisition|m&a|valuation|round|capital/))
        return "capital";
      if (t.match(/openai|google|microsoft|amazon|meta|anthropic|deepmind|nvidia/))
        return "bigtech";
      if (t.match(/copyright|licensing|lawsuit|court|publisher/))
        return "copyright";
      if (t.match(/security|safety|bio|misuse|fraud|deepfake/))
        return "risk";
      return "general";
    }

    function pickTop3Diversified(candidates) {
      const buckets = new Set();
      const picked = [];
      for (const c of candidates) {
        const b = themeBucket(c.original_title, c.body || "");
        if (picked.length < 3 && !buckets.has(b)) {
          picked.push(c);
          buckets.add(b);
        }
        if (picked.length === 3) break;
      }
      if (picked.length < 3) {
        for (const c of candidates) {
          if (picked.length === 3) break;
          if (!picked.find((p) => p.original_url === c.original_url)) picked.push(c);
        }
      }
      return picked.slice(0, 3);
    }

    // =========================
    // 1) Guardian：品質のよい代表記事（最大3）
    // =========================
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=6` +
      `&show-fields=headline,trailText,bodyText` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetchWithTimeout(guardianUrl, { timeoutMs: 12000 });
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

    const guardianArticles = results.slice(0, 6).map((a) => ({
      original_title: a.webTitle || "",
      original_url: normalizeUrl(a.webUrl || ""),
      published_at: a.webPublicationDate || "",
      source: "The Guardian",
      // LLM入力用に本文は短く（長すぎるとコスト＆不安定）
      body: String(a?.fields?.bodyText || a?.fields?.trailText || "")
        .replace(/\s+/g, " ")
        .slice(0, 4000),
    }));

    // =========================
    // 2) GDELT：世界の温度（5秒制限順守）
    // =========================
    // ✅ クエリは短く＆少数
    const GDELT_QUERIES = [
      "artificial intelligence regulation",
      "AI semiconductor",
      "AI investment",
    ];

    async function fetchGdeltOnce({ query, maxrecords = 20, timespan = "1d" }) {
      const base = "https://api.gdeltproject.org/api/v2/doc/doc";
      const u = new URL(base);
      u.searchParams.set("query", query);
      u.searchParams.set("mode", "ArtList");
      u.searchParams.set("format", "json");
      u.searchParams.set("maxrecords", String(maxrecords));
      u.searchParams.set("timespan", timespan);

      const r = await fetchWithTimeout(u.toString(), { timeoutMs: 12000 });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`GDELT HTTP ${r.status}: ${t.slice(0, 200)}`);
      }

      const data = await r.json();
      const arts = Array.isArray(data?.articles) ? data.articles : [];

      return arts.map((a) => ({
        original_title: a?.title || "",
        original_url: normalizeUrl(a?.url || ""),
        published_at: a?.seendate || "",
        source: a?.sourceCountry || a?.source || "GDELT",
        language: a?.language || "",
        // 本文は無いので description を短く渡す（なければtitleのみ）
        body: `${a?.title || ""} ${a?.description || ""}`.replace(/\s+/g, " ").slice(0, 900),
      }));
    }

    async function fetchGdeltBatchSafe(queries, { maxrecords = 20, timespan = "1d" } = {}) {
      const out = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];

        // 429/レート警告対策で軽リトライ（待って再試行）
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const items = await fetchGdeltOnce({ query: q, maxrecords, timespan });
            out.push(...items);
            break;
          } catch (e) {
            await sleep(5000);
            if (attempt === 1) throw e;
          }
        }

        if (i < queries.length - 1) await sleep(5000); // ✅ 5秒ルール
      }
      return out;
    }

    let gdeltItems = [];
    try {
      gdeltItems = await fetchGdeltBatchSafe(GDELT_QUERIES, { maxrecords: 20, timespan: "1d" });
    } catch (e) {
      // GDELT失敗でもGuardianだけで継続（落ちない運用）
      gdeltItems = [];
      console.warn("⚠️ GDELT fetch failed:", e?.message || String(e));
    }

    // =========================
    // 3) 統合 → 重複排除 → “今日の候補”を作る
    // =========================
    const merged = dedupeByUrl([...guardianArticles, ...gdeltItems]);

    // ✅ 日本視点の優先（軽いブースト：後で本格スコアに置換可）
    function japanBoostScore(text = "") {
      const s = String(text).toLowerCase();
      const hits = [
        /japan|japanese|tokyo|osaka|yen|boj|meti|digital agency|fsa/.test(s) ? 1 : 0,
        /sony|softbank|ntt|rakuten|toyota|hitachi|fujitsu|nec|kddi|panasonic/.test(s) ? 1 : 0,
        /tsmc|asml|nvidia|semiconductor|chip|gpu|export/.test(s) ? 1 : 0,
      ].reduce((a, b) => a + b, 0);
      return hits; // 0-3
    }

    // 候補を並べ替え（Guardianの品質＋日本波及＋テーマ）
    merged.sort((a, b) => {
      const A = (a.original_title || "") + " " + (a.body || "");
      const B = (b.original_title || "") + " " + (b.body || "");

      // Guardian記事を少し優遇（品質）
      const qa = a.source === "The Guardian" ? 1 : 0;
      const qb = b.source === "The Guardian" ? 1 : 0;

      const ja = japanBoostScore(A);
      const jb = japanBoostScore(B);

      // 大雑把なランキング：日本波及 → Guardian優遇
      if (jb !== ja) return jb - ja;
      if (qb !== qa) return qb - qa;
      return 0;
    });

    // “最終3本”をテーマ分散で選ぶ
    const final3 = pickTop3Diversified(merged).slice(0, 3);

    // もし不足ならGuardianから補完
    if (final3.length < 3) {
      const rest = dedupeByUrl([...final3, ...guardianArticles]).slice(0, 3);
      while (rest.length < 3 && merged[rest.length]) rest.push(merged[rest.length]);
      final3.splice(0, final3.length, ...rest.slice(0, 3));
    }

    // =========================
    // 4) OpenAI prompt（Premium calm analytical JP）
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
・過度に簡略化しない（専門性は保つ）
・語尾は穏やかに（「である調」は可、攻撃的表現は不可）
・3本はサブテーマが被らないように分散させる（規制/投資/供給網/競争など）

【Importance Score（0-100）採点ルール（厳守）】
下記4軸の合計＝importance_score（0-100）。各軸点数も必ず出す。
1) market_impact（0-40）: 市場構造/競争地図/供給網への影響
2) business_impact（0-30）: 経営判断（投資/提携/価格/組織）への影響
3) japan_relevance（0-20）: 日本市場・日本企業・規制・産業への波及
4) confidence（0-10）: 情報確度（一次情報/複数ソース/数字の明確さ）
注意：90以上は“業界転換点級”のみ。インフレ禁止。

【タグ（tags）ルール】
各記事3〜6個。英語の短いタグで統一（例：Regulation, Chips, Pricing, Funding, Japan, EU, US, OpenAI, Google）。

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
    const openaiRes = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      timeoutMs: 30000,
      // NOTE: fetchWithTimeout wraps fetch, so we pass URL only; we will do a normal fetch below
    }).catch(() => null);

    // ↑上は「先に起動してしまう」事故を防ぐためのダミーではありません。
    // Vercel環境で fetchWithTimeout に options を渡すため、下の通常fetchを使用します。

    const openaiRes2 = await fetch("https://api.openai.com/v1/chat/completions", {
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
    });

    if (!openaiRes2.ok) {
      const t = await openaiRes2.text().catch(() => "");
      return res.status(502).json({
        error: "OpenAI API HTTP error",
        status: openaiRes2.status,
        statusText: openaiRes2.statusText,
        body: t.slice(0, 1500),
      });
    }

    const openaiData = await openaiRes2.json();
    const rawText = openaiData?.choices?.[0]?.message?.content;

    if (!rawText) {
      return res.status(502).json({ error: "OpenAI missing content" });
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
    // 7) Dictionary normalization (guaranteed)
    // =========================
    const DICTIONARY = [
      // People
      { from: /エロン・マスク/g, to: "イーロン・マスク" },
      { from: /イロン・マスク/g, to: "イーロン・マスク" },
      { from: /\bElon Musk\b/g, to: "イーロン・マスク" },

      // Companies
      { from: /\bRelx\b/gi, to: "RELX" },
      { from: /レルクス/g, to: "RELX" },
      { from: /\bOpenAI\b/g, to: "OpenAI" },
      { from: /オープンエーアイ/g, to: "OpenAI" },
      { from: /\bGoogle\b/g, to: "Google" },
      { from: /グーグル/g, to: "Google" },
      { from: /\bMicrosoft\b/g, to: "Microsoft" },
      { from: /マイクロソフト/g, to: "Microsoft" },
      { from: /\bAmazon\b/g, to: "Amazon" },
      { from: /アマゾン/g, to: "Amazon" },
      { from: /\bMeta\b/g, to: "Meta" },
      { from: /メタ/g, to: "Meta" },
      { from: /\bNVIDIA\b/g, to: "NVIDIA" },
      { from: /エヌビディア/g, to: "NVIDIA" },

      // Regions
      { from: /\bEU\b/g, to: "EU" },
      { from: /\bUS\b/g, to: "米国" },
      { from: /\bUSA\b/g, to: "米国" },
      { from: /アメリカ/g, to: "米国" },
    ];

    function applyDictionaryToString(s) {
      if (typeof s !== "string") return s;
      let out = s;
      for (const rule of DICTIONARY) out = out.replace(rule.from, rule.to);
      return out;
    }

    function applyDictionaryDeep(value) {
      if (typeof value === "string") return applyDictionaryToString(value);
      if (Array.isArray(value)) return value.map(applyDictionaryDeep);
      if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = applyDictionaryDeep(v);
        return out;
      }
      return value;
    }

    payload = applyDictionaryDeep(payload);

    // =========================
    // 8) Hardening: score/tags/published_at/source を最低限保証
    // =========================
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const toInt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    function ensureTags(tags) {
      if (!Array.isArray(tags)) return [];
      const cleaned2 = tags
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      return Array.from(new Set(cleaned2));
    }

    function levelFromScore(score) {
      if (score >= 90) return "High";
      if (score >= 70) return "Medium";
      return "Low";
    }

    function validateItem(item) {
      const errors = [];
      if (!item.title_ja || String(item.title_ja).length < 6) errors.push("title_ja too short");
      if (!item.one_sentence || String(item.one_sentence).length < 10) errors.push("one_sentence too short");
      if (!item.why_it_matters || String(item.why_it_matters).length < 10) errors.push("why_it_matters too short");
      if (!item.japan_impact || String(item.japan_impact).length < 8) errors.push("japan_impact too short");
      for (const f of ["fact_summary", "implications", "outlook"]) {
        if (!Array.isArray(item[f]) || item[f].length < 2) errors.push(`${f} needs 2+ items`);
      }
      if (!["High", "Medium", "Low"].includes(item.impact_level)) errors.push("impact_level invalid");
      return errors;
    }

    const validationWarnings = [];

    payload.items = payload.items.map((it) => {
      const out = { ...it };

      // URL正規化
      out.original_url = normalizeUrl(out.original_url || "");

      // tags
      out.tags = ensureTags(out.tags);

      // breakdown
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

      // score total
      const total = clamp(toInt(out.importance_score) ?? (market + biz + jp + conf), 0, 100);
      out.importance_score = total;

      // impact_level coherence
      const implied = levelFromScore(total);
      if (!["High", "Medium", "Low"].includes(out.impact_level)) out.impact_level = implied;

      // published_at/source fallback（入力と照合）
      const src = final3.find((a) => normalizeUrl(a.original_url) === out.original_url);
      out.published_at = out.published_at || src?.published_at || "";
      out.source = out.source || src?.source || "";

      // arrays hardening
      for (const f of ["fact_summary", "implications", "outlook"]) {
        if (!Array.isArray(out[f])) out[f] = [];
        out[f] = out[f].map((x) => String(x || "").trim()).filter(Boolean).slice(0, 4);
        if (out[f].length < 2) out[f] = out[f].concat(["情報が限定的なため、追加確認が必要", "一次情報の更新を注視"]).slice(0, 2);
      }

      // strings trim
      for (const k of ["title_ja", "one_sentence", "why_it_matters", "japan_impact", "original_title"]) {
        if (typeof out[k] === "string") out[k] = out[k].trim();
      }

      const errs = validateItem(out);
      if (errs.length) validationWarnings.push({ url: out.original_url, errors: errs });

      return out;
    });

    // =========================
    // 9) Sort by score DESC（勝ち仕様）
    // =========================
    payload.items.sort((a, b) => (Number(b.importance_score) || 0) - (Number(a.importance_score) || 0));

    // =========================
    // 10) Add metadata
    // =========================
    payload.generated_at = new Date().toISOString();
    payload.version = "4.0";
    payload.sources = Array.from(
      new Set(final3.map((a) => String(a.source || "").trim()).filter(Boolean))
    );

    // =========================
    // 11) Optional debug
    // =========================
    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          picked: final3.map((a) => ({
            source: a.source,
            original_title: a.original_title,
            original_url: a.original_url,
            published_at: a.published_at,
          })),
          gdelt_used: gdeltItems.length,
          merged_candidates: merged.length,
          validation_warnings: validationWarnings.length ? validationWarnings : null,
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
