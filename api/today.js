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
あなたは冷静で知的な経済メディアの編集者です。
感情的・扇動的な表現は禁止します。
出力は必ず「有効なJSONのみ」です。説明文やMarkdownは禁止。
`.trim();

    const userPrompt = `
以下の海外AIニュース記事（3本）を、日本語で上質かつ客観的に整理してください。

【絶対ルール】
・煽らない
・断定しすぎない
・主観的評価を書かない
・過度に簡略化しない
・専門性は保つが難解にしない
・語尾は「〜とみられる」「〜が示唆される」など穏やかに
・固有名詞は可能な限り一般的な日本語表記を用いる（不確かなカタカナ化は避け、英語のままでも可）
・3本はサブテーマが被らないように分散させる（例：市場、企業戦略、規制、技術、社会など）
・impact_level は厳密に分類する
  - High: 市場・政策・地政学・大手企業を跨いだ構造的影響
  - Medium: 業界または大手企業単位の影響
  - Low: 限定的・局所的・話題性中心

【出力形式（厳守）】
{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "title_ja": "簡潔で品のある日本語タイトル",
      "one_sentence": "記事全体を1文で要約（知的トーン）",
      "fact_summary": ["事実整理（客観的事実のみ）", "..."],
      "implications": ["この出来事が意味するもの", "..."],
      "outlook": ["今後の焦点", "..."],
      "original_title": "string",
      "original_url": "string"
    }
  ]
}

【追加ルール】
・items は必ず3件
・各配列は2〜4項目
・Highは最大1件（高インパクトが明確な場合のみ）

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

      // Companies (examples)
      { from: /\bRelx\b/g, to: "RELX" },
      { from: /レルクス/g, to: "RELX" },
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
    // 6) A: Unknown-term auto collection (dictionary candidates)
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

      // Remove noise
      ["High", "Medium", "Low", "JSON", "AI"].forEach((s) => candidates.delete(s));

      return Array.from(candidates).slice(0, 50);
    }

    const allText = collectAllText(payload);
    const dictionary_candidates = extractCandidates(allText);

    if (dictionary_candidates.length > 0) {
      console.log("📘 Dictionary candidate terms:", dictionary_candidates);
    }

    // =========================
    // 7) Sort by impact (High → Medium → Low)
    // =========================
    const order = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => (order[b?.impact_level] || 0) - (order[a?.impact_level] || 0));

    // =========================
    // 8) Return (optional debug)
    // =========================
    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          dictionary_candidates,
          article_sources: articles.map((a) => ({
            original_title: a.original_title,
            original_url: a.original_url,
          })),
        },
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
};
