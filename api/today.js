module.exports = async function handler(req, res) {
  // ---- CORS（PWA/外部プレビューでも落ちにくい）----
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    const guardianData = await guardianRes.json();

    const results = guardianData?.response?.results;
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(502).json({ error: "Guardian returned no results", raw: guardianData });
    }

    const articles = results.slice(0, 3).map((a) => ({
      original_title: a.webTitle,
      original_url: a.webUrl,
      body: (a?.fields?.bodyText || a?.fields?.trailText || "").slice(0, 12000) // 念のため制限
    }));

    // ---- 2) OpenAI：3件まとめて要約（JSON固定）----
    const prompt = `
You are a Japanese news editor.
Summarize the following THREE articles in Japanese.
Return JSON ONLY. No markdown. No code fences.

Schema:
{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {
      "impact_level": "High|Medium|Low",
      "title_ja": "string",
      "one_sentence": "string",
      "what_happened": ["string","string"],
      "why_important": ["string","string"],
      "action_advice": ["string","string"],
      "original_title": "string",
      "original_url": "string"
    }
  ]
}

Rules:
- items must be exactly 3, same order as given.
- Keep each bullet array 2-4 items.
- Be factual. Avoid speculation.
- Natural Japanese titles (not literal translation).

Articles:
1) ${articles[0].original_title}
${articles[0].original_url}
${articles[0].body}

2) ${articles[1].original_title}
${articles[1].original_url}
${articles[1].body}

3) ${articles[2].original_title}
${articles[2].original_url}
${articles[2].body}
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
      return res.status(502).json({ error: "OpenAI missing content", raw: openaiData });
    }

    // ---- 3) JSONパース（フェンス除去）----
    const cleaned = String(text).trim().replace(/^```json\s*|```$/g, "");
    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: "OpenAI returned non-JSON",
        rawText: cleaned.slice(0, 1500),
      });
    }

    if (!payload?.items || !Array.isArray(payload.items) || payload.items.length !== 3) {
      return res.status(502).json({ error: "Schema invalid: items must be 3", raw: payload });
    }

    // ---- 4) 表示順：High→Medium→Low に並び替え ----
    const order = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => (order[b.impact_level] || 0) - (order[a.impact_level] || 0));

    // ✅ フロントが期待する形で返す
    return res.status(200).json(payload);

  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
};
