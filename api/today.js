export default async function handler(req, res) {
  try {
    const guardianKey = process.env.GUARDIAN_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // 0) 環境変数チェック（ここで落ちると原因が明確になる）
    if (!guardianKey) {
      return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
    }
    if (!openaiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
    }

    // 1) Guardianから記事取得
    const guardianUrl =
      `https://content.guardianapis.com/search` +
      `?q=artificial%20intelligence` +
      `&section=technology` +
      `&order-by=newest` +
      `&page-size=1` +
      `&show-fields=headline,trailText,body,shortUrl` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetch(guardianUrl);

    // GuardianがHTTPエラーを返した場合のガード
    if (!guardianRes.ok) {
      const text = await guardianRes.text().catch(() => "");
      return res.status(500).json({
        error: "Guardian API HTTP error",
        status: guardianRes.status,
        statusText: guardianRes.statusText,
        body: text
      });
    }

    const guardianData = await guardianRes.json();

    // GuardianのJSON構造が期待と違う場合のガード（ここが今回の本丸）
    if (!guardianData.response || !guardianData.response.results) {
      return res.status(500).json({
        error: "Guardian API response invalid (missing response/results)",
        guardianData
      });
    }

    const results = guardianData.response.results;

    if (!Array.isArray(results) || results.length === 0) {
      return res.status(404).json({
        error: "No Guardian articles found",
        guardianData
      });
    }

    const article = results[0];

    // fieldsが無い場合のガード
    const fields = article.fields || {};
    const title = article.webTitle || fields.headline || "";
    const trailText = fields.trailText || "";
    const body = fields.body || "";
    const originalUrl = article.webUrl || fields.shortUrl || "";

    if (!title) {
      return res.status(500).json({
        error: "Guardian article missing title",
        article
      });
    }

    // 2) OpenAIに渡すテキスト（長すぎ防止：bodyをざっくり切る）
    const bodyTrimmed = body.length > 12000 ? body.slice(0, 12000) : body;

    const content = `
Title: ${title}
TrailText: ${trailText}
Body: ${bodyTrimmed}
OriginalURL: ${originalUrl}
`.trim();

    // 3) OpenAIで要約生成（Responses API）
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "You are an editor for a Japanese business brief app. Be accurate and avoid hype."
          },
          {
            role: "user",
            content: `
以下のニュースを「AI Impact Brief」として日本語で要約してください。
出力は必ずJSONのみ（余計な文章なし）。

JSONの形式：
{
  "title_ja": "...",
  "one_sentence": "...",
  "summary_3lines": ["...", "...", "..."],
  "what_happened": ["...", "...", "..."],
  "why_important": ["...", "...", "..."],
  "impact_level": "Low|Medium|High",
  "action_advice": ["...", "...", "..."],
  "original_url": "${originalUrl}"
}

記事：
${content}
`.trim()
          }
        ]
      })
    });

    if (!aiRes.ok) {
      const text = await aiRes.text().catch(() => "");
      return res.status(500).json({
        error: "OpenAI API HTTP error",
        status: aiRes.status,
        statusText: aiRes.statusText,
        body: text
      });
    }

    const aiData = await aiRes.json();

    // Responses API は output_text が使える場合があるが、無い場合に備えてガード
    const outputText =
      aiData.output_text ||
      (Array.isArray(aiData.output)
        ? aiData.output
            .flatMap((o) => o.content || [])
            .map((c) => c.text || "")
            .join("")
        : "");

    if (!outputText) {
      return res.status(500).json({
        error: "OpenAI returned empty output",
        aiData
      });
    }

    // 4) 返却（AIのJSON文字列をそのまま返す／パースできればJSON化して返す）
    // AIがJSON以外を混ぜた時の保険として、パースを試みる
    let brief = null;
    try {
      brief = JSON.parse(outputText);
    } catch (e) {
      // JSONとしてパースできない場合はテキストとして返す
      brief = { raw: outputText };
    }

    return res.status(200).json({
      originalTitle: title,
      originalUrl,
      brief
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
}
