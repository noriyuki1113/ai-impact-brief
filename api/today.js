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

    const articles = results.slice(0, 3).map((a) => ({
      original_title: a.webTitle || "",
      original_url: a.webUrl || "",
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

    const userPrompt = `
以下の海外AIニュース記事（3本）を、日本語で上質かつ客観的に整理してください。

【絶対ルール】
・煽らない（「衝撃」「革命的」等の誇張表現禁止）
・断定しすぎない（「〜とみられる」「〜が示唆される」を使用）
・主観的評価を書かない（客観的事実と分析のみ）
・過度に簡略化しない（専門性は保つ）
・語尾は穏やかに（「である調」は可、攻撃的表現は不可）
・固有名詞は正確な日本語表記を優先（例：イーロン・マスク、RELX）
・3本はサブテーマが被らないように分散させる
  例：市場動向、企業戦略、規制、技術革新、社会的影響など
・impact_level は厳密に分類する
  - High: 市場・政策・地政学レベルで構造的影響がある
  - Medium: 業界または大手企業単位で影響がある
  - Low: 限定的・局所的、または話題性中心

【出力形式（厳守）】
{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "title_ja": "簡潔で品のある日本語タイトル（30文字以内推奨）",
      "one_sentence": "記事全体を1文で要約（知的トーン、60文字以内推奨）",
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
      "original_url": "string"
    }
  ]
}

【追加ルール】
・items は必ず3件
・各配列（fact_summary, implications, outlook）は2〜4項目
・Highは最大1件（本当に高インパクトが明確な場合のみ）
・各項目は簡潔に（1項目あたり50文字以内推奨）
・「フロントエンドの表示」を意識した読みやすさ

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
    // 6) Quality validation
    // =========================
    function validateItem(item) {
      const errors = [];
      
      // Check required fields
      if (!item.title_ja || item.title_ja.length < 10) {
        errors.push("title_ja is too short");
      }
      if (!item.one_sentence || item.one_sentence.length < 20) {
        errors.push("one_sentence is too short");
      }
      
      // Check arrays
      const requiredArrays = ['fact_summary', 'implications', 'outlook'];
      for (const field of requiredArrays) {
        if (!Array.isArray(item[field]) || item[field].length < 2) {
          errors.push(`${field} must have at least 2 items`);
        }
      }
      
      // Check impact level
      if (!['High', 'Medium', 'Low'].includes(item.impact_level)) {
        errors.push(`Invalid impact_level: ${item.impact_level}`);
      }
      
      return errors;
    }

    // Validate all items
    const validationErrors = [];
    payload.items.forEach((item, idx) => {
      const errors = validateItem(item);
      if (errors.length > 0) {
        validationErrors.push({ index: idx, errors });
      }
    });

    if (validationErrors.length > 0) {
      console.warn("⚠️ Validation warnings:", validationErrors);
    }

    // =========================
    // 7) Dictionary candidates collection
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

      // Katakana sequences (3+)
      const katakanaRegex = /[ァ-ヶー]{3,}/g;
      for (const w of text.match(katakanaRegex) || []) candidates.add(w);

      // English proper nouns
      const englishMulti = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/g;
      for (const w of text.match(englishMulti) || []) candidates.add(w);

      const englishSingle = /\b[A-Z][A-Za-z0-9]{2,}\b/g;
      for (const w of text.match(englishSingle) || []) candidates.add(w);

      // Remove common noise
      const noiseWords = ["High", "Medium", "Low", "JSON", "AI", "API", "URL", "HTTP"];
      noiseWords.forEach((s) => candidates.delete(s));

      return Array.from(candidates).slice(0, 50);
    }

    const allText = collectAllText(payload);
    const dictionary_candidates = extractCandidates(allText);

    if (dictionary_candidates.length > 0) {
      console.log("📘 Dictionary candidate terms:", dictionary_candidates);
    }

    // =========================
    // 8) Sort by impact (High → Medium → Low)
    // =========================
    const order = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => (order[b?.impact_level] || 0) - (order[a?.impact_level] || 0));

    // =========================
    // 9) Add metadata
    // =========================
    payload.generated_at = new Date().toISOString();
    payload.source = "The Guardian API";
    payload.version = "2.0";

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
      stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined
    });
  }
};
