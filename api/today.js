export default async function handler(req, res) {
  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // 🔎 環境変数チェック
    if (!guardianKey) {
      return res.status(500).json({ error: "Missing GUARDIAN_API_KEY" });
    }

    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // ===============================
    // 1️⃣ GuardianからAI関連記事を3件取得
    // ===============================
    const guardianRes = await fetch(
      `https://content.guardianapis.com/search?q=artificial%20intelligence&section=technology&page-size=3&show-fields=headline,trailText,body,shortUrl&api-key=${guardianKey}`
    );

    const guardianData = await guardianRes.json();

    if (
      !guardianData.response ||
      !guardianData.response.results ||
      guardianData.response.results.length === 0
    ) {
      return res.status(500).json({ error: "Guardian returned no results" });
    }

    const articles = guardianData.response.results.slice(0, 3);

    // ===============================
    // 2️⃣ OpenAIへ送るプロンプト生成
    // ===============================
    const prompt = `
You are an elite financial and technology news analyst.

Summarize the following 3 news articles in Japanese.

Return ONLY valid JSON.
Do not include explanations.
Do not wrap in markdown.

Format:
[
  {
    "title_ja": "",
    "one_sentence": "",
    "summary_3lines": [],
    "what_happened": [],
    "why_important": [],
    "action_advice": [],
    "impact_level": "High | Medium | Low",
    "original_url": ""
  }
]

Articles:
${articles
  .map(
    (a, i) => `
Article ${i + 1}:
Title: ${a.webTitle}
Content: ${a.fields.body}
URL: ${a.webUrl}
`
  )
  .join("\n")}
`;

    // ===============================
    // 3️⃣ OpenAI API呼び出し
    // ===============================
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content: "You generate structured Japanese news brief JSON.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

    const openaiData = await openaiRes.json();

    if (!openaiData.choices) {
      return res.status(500).json({ error: "OpenAI response invalid" });
    }

    const rawContent = openaiData.choices[0].message.content;

    let summaries;

    try {
      summaries = JSON.parse(rawContent);
    } catch (err) {
      return res.status(500).json({
        error: "Failed to parse OpenAI JSON",
        raw: rawContent,
      });
    }

    // ===============================
    // 4️⃣ Impact順にソート（High→Medium→Low）
    // ===============================
    const impactOrder = { High: 3, Medium: 2, Low: 1 };

    const sortedSummaries = summaries.sort((a, b) => {
      return (
        (impactOrder[b.impact_level] || 0) -
        (impactOrder[a.impact_level] || 0)
      );
    });

    // ===============================
    // 5️⃣ レスポンス返却
    // ===============================
    return res.status(200).json(sortedSummaries);
  } catch (error) {
    console.error("API ERROR:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
