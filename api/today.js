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
      return res.status(502).json({ error: "Guardian returned no results", raw: guardianData });
    }

    const articles = results.slice(0, 3).map((a) => ({
      original_title: a.webTitle || "",
      original_url: a.webUrl || "",
      body: String(a?.fields?.bodyText || a?.fields?.trailText || "")
        .replace(/\s+/g, " ")
        .slice(0, 9000), // 長文対策
    }));

    // =========================
    // 2) Prompts (separated)
    // =========================
    const systemPrompt = `
You are a neutral, analytical AI news strategist creating a premium AI briefing in Japanese.

Tone:
- Calm, neutral, analytical
- No sensationalism, no clickbait
- Avoid dramatic/emotional words (e.g., shock, panic, crisis)
- No moral judgment
- No speculation without evidence

Naming:
- Use widely accepted Japanese names for well-known people and companies.
- Do NOT mechanically transliterate into unnatural katakana.
- If unsure, prefer the original English spelling rather than incorrect katakana.

Output:
Return strictly valid JSON only. No markdown. No extra text.
`.trim();

    const userPrompt = `
Select and analyze exactly 3 AI-related news items (based on the provided articles) with structural depth.

CRITICAL RULES:
1) Diversification:
The 3 items must belong to clearly different sub-themes.
Avoid selecting multiple stories about similar stock reactions or similar corporate announcements.
Prefer distribution across categories such as:
- Financial markets
- Corporate strategy
- Regulation or policy
- Social impact
- Technology innovation
- Labor market
- Geopolitics
- Data economy

2) Impact classification:
Assign exactly ONE item as High.
Assign at least ONE item as Medium.
Use Low only if impact is clearly limited/local/reputational.

Definitions:
High = Cross-market, systemic, geopolitical, or structural economic impact.
Medium = Industry-level or major company-level strategic impact.
Low = Limited, localized, reputational, or commentary-level impact.

3) Analytical depth:
The one_sentence must be decisive and analytical (not merely descriptive).

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

      // Add more as you discover candidates
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

    // For filtering: build a set of dictionary "from" tokens (best-effort)
    // We treat plain strings found in DICTIONARY regex sources as "known".
    const knownHints = new Set(
      DICTIONARY.map((r) => String(r.from))
        .flatMap((s) => {
          // Extract visible tokens from regex string like "/.../g" form
          // Best-effort: take inside slashes when present
          const m = s.match(/^\/(.+)\/[gimsuy]*$/);
          const body = m ? m[1] : s;
          // Split by obvious regex operators to get rough tokens
          return body
            .split(/[\|$begin:math:text$$end:math:text$$begin:math:display$$end:math:display$\?\+\*\{\}\\.^$]/g)
            .map((t) => t.trim())
            .filter((t) => t.length >= 2);
        })
    );

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
      for (const w of text.match(katakanaRegex) || []) {
        if (!isKnownToken(w)) candidates.add(w);
      }

      // English proper nouns: "Elon Musk", "OpenAI", "New York Times" etc.
      // (two+ words or camel-case single like OpenAI)
      const englishMulti = /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/g;
      for (const w of text.match(englishMulti) || []) {
        if (!isKnownToken(w)) candidates.add(w);
      }

      const englishSingle = /\b[A-Z][A-Za-z0-9]{2,}\b/g; // OpenAI, RELX, Anthropic
      for (const w of text.match(englishSingle) || []) {
        if (!isKnownToken(w)) candidates.add(w);
      }

      // Remove obvious noise
      const stop = new Set(["High", "Medium", "Low", "JSON", "AI"]);
      for (const s of stop) candidates.delete(s);

      return Array.from(candidates).slice(0, 50);
    }

    function isKnownToken(token) {
      if (!token || token.length < 2) return true;
      // Already corrected target names are okay; we care about unknowns
      for (const hint of knownHints) {
        if (hint && token.includes(hint)) return true;
      }
      return false;
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
          article_sources: articles.map((a) => ({ original_title: a.original_title, original_url: a.original_url })),
        },
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
};
