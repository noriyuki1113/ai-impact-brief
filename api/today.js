export default async function handler(req, res) {
  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    const guardianRes = await fetch(
      `https://content.guardianapis.com/search?q=artificial%20intelligence&section=technology&order-by=newest&page-size=1&show-fields=headline,trailText,body,shortUrl&api-key=${guardianKey}`
    );

    const guardianData = await guardianRes.json();
    const article = guardianData.response.results[0];

    const content = `
    Title: ${article.webTitle}
    Summary: ${article.fields.trailText}
    Body: ${article.fields.body}
    `;

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `
        Summarize this article in Japanese.
        Structure:
        - 何が起きたか
        - なぜ重要か
        - どんな仕事に影響するか
        - 取るべきアクション

        ${content}
        `
      })
    });

    const aiData = await aiRes.json();
    const output = aiData.output_text;

    res.status(200).json({
      originalTitle: article.webTitle,
      originalUrl: article.webUrl,
      summary: output
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

