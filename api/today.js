export default async function handler(req, res) {
  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (!guardianKey || !openaiKey) {
      return res.status(500).json({ error: "Missing API keys" });
    }

    // ========= 1. Guardian取得 =========
    const guardianRes = await fetch(
      `https://content.guardianapis.com/search?q=AI&section=technology&show-fields=headline,trailText,body&api-key=${guardianKey}`
    );

    const guardianData = await guardianRes.json();
    const article = guardianData?.response?.results?.[0];

    if (!article) {
      return res.status(500).json({ error: "No articles found" });
    }

    const content = article.fields.body.replace(/<[^>]+>/g, "");

    // ========= 2. OpenAI要約 =========
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Summarize in Japanese. Structured, calm analytical tone. Extract key entities separately."
          },
          {
            role: "user",
            content: `
Article:
${content}

Return JSON:
{
  "summary": "...",
  "entities": ["Elon Musk", "Relx", ...]
}`
          }
        ],
        temperature: 0.3
      }),
    });

    const openaiData = await openaiRes.json();
    const aiOutput = JSON.parse(openaiData.choices[0].message.content);

    let summary = aiOutput.summary;
    const entities = aiOutput.entities || [];

    // ========= 3. Wikipedia変換関数 =========
    async function getJapaneseName(name) {
      try {
        const wikiRes = await fetch(
          `https://en.wikipedia.org/w/api.php?action=query&prop=langlinks&titles=${encodeURIComponent(
            name
          )}&lllang=ja&format=json&origin=*`
        );

        const wikiData = await wikiRes.json();
        const pages = wikiData.query.pages;
        const page = Object.values(pages)[0];

        if (page.langlinks && page.langlinks.length > 0) {
          return page.langlinks[0]["*"];
        }

        return name;
      } catch {
        return name;
      }
    }

    // ========= 4. 固有名詞置換 =========
    for (const entity of entities) {
      const jpName = await getJapaneseName(entity);
      const regex = new RegExp(entity, "g");
      summary = summary.replace(regex, jpName);
    }

    // ========= 5. レスポンス =========
    return res.status(200).json({
      title: article.fields.headline,
      summary,
      original_url: article.webUrl
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
