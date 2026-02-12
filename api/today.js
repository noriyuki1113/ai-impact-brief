module.exports = async function handler(req, res) {
  // ---- Robust CORS (PWA/外部プレビューでも落ちにくい) ----
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

    // ---- 1) Guardian: 最新3件 ----
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=3` +
      `&show-fields=headline,trailText,bodyText` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetch(guardianUrl);
    const guardianData = await guardianRes.json();

    const results = guardianData?.response?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(502).json({
        error: "Guardian API returned no results",
        raw: guardianData,
      });
    }

    const articles = results.slice(0, 3).map((a) => ({
      originalTitle: a.webTitle,
      originalUrl: a.webUrl,
      body:
        a?.fields?.bodyText ||
        a?.fields?.trailText ||
        "",
    }));

    // ---- 2) OpenAI: 3件まとめて1回で要約（コストも速さも◎）----
    const prompt = `
You are a Japanese news editor.

Summarize the following THREE articles in Japanese.
Return JSON ONLY (no markdown, no code fences).

Schema:
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
- items must be exactly 3 in the same order as given.
- Each bullet array should have 2-4 items (keep it concise).
- Be factual and avoid speculation unless clearly stated in the article.
- Keep titles natural Japanese, not literal translation.
- impact_level: High if broad social/economic impact, Medium if industry-level, Low if niche/limited.

Articles (in order):
1) Title: ${articles[0].originalTitle}
URL: ${articles[0].originalUrl}
Body: ${articles[0].body}

2) Title: ${articles[1].originalTitle}
URL: ${articles[1].originalUrl}
Body: ${articles[1].body}

3) Title: ${articles[2].originalTitle}
URL: ${articles[2].originalUrl}
Body: ${articles[2].body}
`.trim();

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });

    const openaiData = await openaiRes.json();
    const text = openaiData?.choices?.[0]?.message?.content;

    if (!text) {
      return res.status(502).json({ error: "OpenAI response missing content", raw: openaiData });
    }

    // ---- 3) JSONパース（コードフェンス対策も一応）----
    const cleaned = String(text).trim().replace(/^```json\s*|```$/g, "");
    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({
        error: "OpenAI returned non-JSON",
        rawText: cleaned.slice(0, 2000),
      });
    }

    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== 3) {
      return res.status(502).json({
        error: "OpenAI JSON schema invalid (items must be 3)",
        raw: payload,
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
};
