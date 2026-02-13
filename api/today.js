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
    // 1) Guardian：最新3件
    //    - webPublicationDate を追加（published_at用）
    // =========================
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=3` +
      `&show-fields=headline,trailText,bodyText` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetch(guardianUrl);
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
      return res
        .status(502)
        .json({ error: "Guardian returned no results", raw: guardianData });
    }

    // Guardianの3件をLLM入力に整形（published_atも渡す）
    const articles = results.slice(0, 3).map((a) => ({
      original_title: a.webTitle || "",
      original_url: a.webUrl || "",
      published_at: a.webPublicationDate || "", // ✅ 追加
      body: String(a?.fields?.bodyText || a?.fields?.trailText || "")
        .replace(/\s+/g, " ")
        .slice(0, 9000),
    }));

    // =========================
    // 2) Prompts (Premium calm analytical JP)
    // =========================
    const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
「構造で読む、AI戦略ニュース」というコンセプトのもと、感情的・扇動的な表現は一切禁止します。
出力は必ず「有効なJSONのみ」です。説明文やMarkdownは禁止。
投資家・経営層が意思決定に使える、高品質な分析を提供してください。
`.trim();

    // ✅ ここが重要：Importance Score / Why it matters / Japan Impact / Tags を追加
    const userPrompt = `
以下の海外AIニュース記事（3本）を、日本語で上質かつ客観的に整理してください。

【絶対ルール】
・煽らない（「衝撃」「革命的」等の誇張表現禁止）
・断定しすぎない（「〜とみられる」「〜が示唆される」を使用）
・主観的評価を書かない（客観的事実と分析のみ）
・過度に簡略化しない（専門性は保つ）
・語尾は穏やかに（「である調」は可、攻撃的表現は不可）
・固有名詞は正確な日本語表記を優先
・3本はサブテーマが被らないように分散させる
・impact_level は厳密に分類する
  - High: 市場・政策・地政学レベルで構造的影響がある
  - Medium: 業界または大手企業単位で影響がある
  - Low: 限定的・局所的、または話題性中心

【重要：Importance Score（0-100）採点ルール（必ず遵守）】
スコアは以下の4軸の合計。各軸の点数も必ず出す。
1) 市場影響（0-40）
2) 経営判断影響（0-30）
3) 日本市場波及（0-20）
4) 情報確度（0-10）
合計＝importance_score（0-100）
注意：90以上は“本当に業界転換点級”のときだけ。インフレ禁止。

【タグ（tags）ルール】
各記事に3〜6個。英語の短いタグで統一。
例：Pricing, Regulation, API, Chips, M&A, OpenAI, Google, Microsoft, Safety, Copyright, Data, EU, US, China, Startup, Enterprise, Model, Agent, Robotics

【出力形式（厳守：JSONのみ）】
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
      "title_ja": "簡潔で品のある日本語タイトル（30文字以内推奨）",
      "one_sentence": "記事全体を1文で要約（知的トーン、60文字以内推奨）",
      "why_it_matters": "なぜ経営判断に関係するか（1-2文）",
      "japan_impact": "日本への具体的影響（2-3点を短くまとめる。箇条書きっぽく改行してOK）",
      "tags": ["Tag1","Tag2","Tag3"],
      "fact_summary": [
        "事実1：客観的事実のみを記述",
        "事実2：数値やデータを含める",
        "事実3：時系列を明確に"
      ],
      "implications": [
        "示唆1：市場や企業への具体的影響",
        "示唆2：戦略的な意味合い",
        "示唆3：競争環境の変化"
      ],
      "outlook": [
        "見通し1：今後6ヶ月〜1年の展開予測",
        "見通し2：注視すべきポイント",
        "見通し3：リスクと機会"
      ],
      "original_title": "string",
      "original_url": "string",
      "published_at": "ISO string or empty"
    }
  ]
}

【追加ルール】
・items は必ず3件
・各配列（fact_summary, implications, outlook）は2〜4項目
・Highは最大1件（明確な場合のみ）
・importance_score と impact_level の整合性を保つ
  - 90-100: High（基本）
  - 70-89: Medium（基本）
  - 0-69: Low（基本）
  ※例外はOKだが、矛盾は避ける
・フロント表示を意識した読みやすさ（短く、要点）
・published_at は入力記事の published_at を引き継ぐ

Articles JSON:
${JSON.stringify(articles)}
`.trim();

    // =========================
    // 3) OpenAI call
    // =========================
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
    // 4) Parse JSON safely
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
    // 5) Dictionary normalization (guaranteed)
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

      // Technology terms
      { from: /\bAI\b/g, to: "AI" },
      { from: /人工知能/g, to: "AI" },
      { from: /\bLLM\b/g, to: "LLM" },
      { from: /大規模言語モデル/g, to: "LLM" },
      { from: /\bGPT\b/g, to: "GPT" },
      { from: /\bChatGPT\b/g, to: "ChatGPT" },

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
    // 6) Quality validation + hardening
    //    - importance_score / breakdown / tags を最低限保証
    // =========================
    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
    const toInt = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    function ensureTags(tags) {
      if (!Array.isArray(tags)) return [];
      const cleaned = tags
        .map((t) => String(t || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      // 重複除去
      return Array.from(new Set(cleaned));
    }

    function levelFromScore(score) {
      if (score >= 90) return "High";
      if (score >= 70) return "Medium";
      return "Low";
    }

    function validateItem(item) {
      const errors = [];

      if (!item.title_ja || String(item.title_ja).length < 8) {
        errors.push("title_ja is too short");
      }
      if (!item.one_sentence || String(item.one_sentence).length < 15) {
        errors.push("one_sentence is too short");
      }
      if (!item.why_it_matters || String(item.why_it_matters).length < 15) {
        errors.push("why_it_matters is too short");
      }
      if (!item.japan_impact || String(item.japan_impact).length < 10) {
        errors.push("japan_impact is too short");
      }

      const requiredArrays = ["fact_summary", "implications", "outlook"];
      for (const field of requiredArrays) {
        if (!Array.isArray(item[field]) || item[field].length < 2) {
          errors.push(`${field} must have at least 2 items`);
        }
      }

      if (!["High", "Medium", "Low"].includes(item.impact_level)) {
        errors.push(`Invalid impact_level: ${item.impact_level}`);
      }

      return errors;
    }

    // normalize each item
    const validationErrors = [];
    payload.items = payload.items.map((item, idx) => {
      const out = { ...item };

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

      // impact_level coherence (矛盾の激しい場合だけ補正)
      const implied = levelFromScore(total);
      if (!["High", "Medium", "Low"].includes(out.impact_level)) out.impact_level = implied;

      // published_at: モデルが落とした場合、入力から補完（URL一致で）
      if (!out.published_at) {
        const src = articles.find((a) => a.original_url === out.original_url);
        out.published_at = src?.published_at || "";
      }

      const errors = validateItem(out);
      if (errors.length > 0) validationErrors.push({ index: idx, errors });

      return out;
    });

    if (validationErrors.length > 0) {
      console.warn("⚠️ Validation warnings:", validationErrors);
    }

    // =========================
    // 7) Dictionary candidates collection (optional)
    // =========================
    function collectAllText(obj) {
      let text = "";
      (function walk(v) {
        if (typeof v === "string") text += " " + v;
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      })(obj);
      return text;
    }

    function extractCandidates(text) {
      const candidates = new Set();

      const katakanaRegex = /[ァ-ヶー]{3,}/g;
      for (const w of text.match(katakanaRegex) || []) candidates.add(w);

      const englishMulti = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/g;
      for (const w of text.match(englishMulti) || []) candidates.add(w);

      const englishSingle = /\b[A-Z][A-Za-z0-9]{2,}\b/g;
      for (const w of text.match(englishSingle) || []) candidates.add(w);

      const noiseWords = ["High", "Medium", "Low", "JSON", "AI", "API", "URL", "HTTP"];
      noiseWords.forEach((s) => candidates.delete(s));

      return Array.from(candidates).slice(0, 50);
    }

    const allText = collectAllText(payload);
    const dictionary_candidates = extractCandidates(allText);

    // =========================
    // 8) Sort: importance_score DESC（勝ち仕様）
    // =========================
    payload.items.sort((a, b) => (Number(b.importance_score) || 0) - (Number(a.importance_score) || 0));

    // =========================
    // 9) Add metadata
    // =========================
    payload.generated_at = new Date().toISOString();
    payload.source = "The Guardian API";
    payload.version = "3.0";

    // =========================
    // 10) Return (optional debug)
    // =========================
    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          dictionary_candidates,
          validation_warnings: validationErrors.length > 0 ? validationErrors : null,
          article_sources: articles.map((a) => ({
            original_title: a.original_title,
            original_url: a.original_url,
            published_at: a.published_at,
            body_length: a.body.length,
          })),
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
