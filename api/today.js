export default async function handler(req, res) {
  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey) {
      return res.status(500).json({ error: "Missing GUARDIAN_API_KEY" });
    }
    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // 1️⃣ GuardianからAI関連ニュースを3件取得
    const guardianRes = await fetch(
      `https://content.guardianapis.com/search?q=artificial%20intelligence&section=technology&show-fields=headline,trailText,body,shortUrl&order-by=newest&page-size=3&api-key=${guardianKey}`
    );

    const guardianData = await guardianRes.json();

    if (!guardianData.response?.results?.length) {
      return res.status(500).json({ error: "No articles found" });
    }

    const articles = guardianData.response.results;

    // 2️⃣ 各記事をOpenAIで分析
    const analyses = await Promise.all(
      articles.map(async (article) => {
        const prompt = `
You are an institutional-level strategic analyst.
Write a structured strategic analysis in Japanese for executives and investors.

Return ONLY valid JSON with these keys:
title_ja
impact_level (High / Medium / Low)
executive_summary
what_happened (array of bullet points)
structural_implication (array)
risks (array)
opportunities (array)
watch_indicators (array)
action_advice (array)

Article:
Title: ${article.webTitle}
Body:
${article.fields.body.substring(0, 6000)}
`;

        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You output only valid JSON." },
              { role: "user", content: prompt },
            ],
            temperature: 0.3,
          }),
        });

        const aiData = await aiRes.json();

        const content = aiData.choices?.[0]?.message?.content;

        if (!content) {
          throw new Error("Invalid OpenAI response");
        }

        const parsed = JSON.parse(content);

        // 3️⃣ 厳密構造チェック
        const requiredFields = [
          "title_ja",
          "impact_level",
          "executive_summary",
          "what_happened",
          "structural_implication",
          "risks",
          "opportunities",
          "watch_indicators",
          "action_advice",
        ];

        for (const field of requiredFields) {
          if (!parsed[field]) {
            throw new Error(`Missing field: ${field}`);
          }
        }

        return {
          ...parsed,
          original_url: article.webUrl,
        };
      })
    );

    // 4️⃣ impact_levelでソート
    const priority = { High: 1, Medium: 2, Low: 3 };

    analyses.sort(
      (a, b) => priority[a.impact_level] - priority[b.impact_level]
    );

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      articles: analyses,
    });

  } catch (error) {
    console.error("Error in today.js:", error);
    return res.status(500).json({
      error: error.message || "Unexpected server error",
    });
  }
}
