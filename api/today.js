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
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey) return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
    if (!openaiKey) return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

    // ---- 1) Guardian：最新3件 ----
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
      return res.status(502).json({ error: "Guardian returned no results", raw: guardianData });
    }

    const articles = results.slice(0, 3).map((a) => ({
      original_title: a.webTitle || "",
      original_url: a.webUrl || "",
      body: String(a?.fields?.bodyText || a?.fields?.trailText || "")
        .replace(/\s+/g, " ")
        .slice(0, 9000),
    }));

    // ---- 2) Prompts (separated) ----
    const systemPrompt = `
You are a professional financial and policy news analyst writing in Japanese.

Tone:
- Calm, neutral, analytical
- No sensationalism, no clickbait
- Avoid dramatic/emotional words (e.g., shock, panic, crisis)
- No moral judgment
- No speculation without evidence

Naming:
- Use commonly accepted Japanese names for famous people/companies.
- Do NOT mechanically transliterate into unnatural katakana.
- If unsure, prefer the original English spelling rather than incorrect katakana.

Output:
Return strictly valid JSON only. No markdown. No extra text.
`.trim();

    const userPrompt = `
Summarize the following 3 English news articles in Japanese.

Return JSON in this exact schema:
{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "title_ja": "string",
      "one_sentence": "string",
      "what_happened": ["string","string","string"],
      "why_important": ["string","string","string"],
      "action_advice": ["string","string","string"],
      "original_title": "string",
      "original_url": "string"
    }
  ]
}

Rules:
- items must be exactly 3.
- Keep bullet arrays 2-4 items each.
- Use analytical framing in title_ja (no hype).
- impact_level:
  High = cross-market/structural impact
  Medium = industry-level impact
  Low = limited/niche impact

Articles JSON:
${JSON.stringify(articles)}
`.trim();

    // ---- 3) OpenAI ----
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

    // ---- 4) Parse JSON safely ----
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

    // ---- 5) Name normalization (hard guarantee for common failures) ----
    const nameFixes = [
      [/エロン・マスク/g, "イーロン・マスク"],
      [/イロン・マスク/g, "イーロン・マスク"],
      [/Elon Musk/g, "イーロン・マスク"], // 英語のまま出た時も統一したいなら
    ];

    const fixStr = (s) => {
      if (typeof s !== "string") return s;
      let out = s;
      for (const [re, rep] of nameFixes) out = out.replace(re, rep);
      return out;
    };

    for (const it of payload.items) {
      it.title_ja = fixStr(it.title_ja);
      it.one_sentence = fixStr(it.one_sentence);
      it.what_happened = (it.what_happened || []).map(fixStr);
      it.why_important = (it.why_important || []).map(fixStr);
      it.action_advice = (it.action_advice || []).map(fixStr);
    }

    // ---- 6) Sort by impact (High→Medium→Low) ----
    const order = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => (order[b?.impact_level] || 0) - (order[a?.impact_level] || 0));

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
};
