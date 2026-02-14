/**
 * /api/today (Multi-source RSS + Guardian + OpenAI + R2)
 *
 * ✅ Pythonなし
 * ✅ RSS複数ソース + Guardian を統合
 * ✅ 重複除外、分散選択（企業/規制/技術など）
 * ✅ importance_score（日本市場視点）を公開
 * ✅ R2保存（latest / daily / raw）
 *
 * 必要ENV:
 *  GUARDIAN_API_KEY
 *  OPENAI_API_KEY
 *  （任意）R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

const RSSParser = require("rss-parser");

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

  // ===== Query =====
  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const force = urlObj.searchParams.get("force") === "1";
  const dateParam = urlObj.searchParams.get("date");

  // ===== Helpers =====
  const nowIso = () => new Date().toISOString();
  const todayJST = () => {
    const d = new Date();
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  };
  const dateIso = dateParam || todayJST();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const stripHtml = (s) =>
    String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  function normalizeUrl(u) {
    try {
      const x = new URL(u);
      // utm_*除去
      [...x.searchParams.keys()].forEach((k) => {
        if (k.toLowerCase().startsWith("utm_")) x.searchParams.delete(k);
      });
      x.hash = "";
      // 末尾 / を削りすぎない（/だけは残す）
      if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
      return x.toString();
    } catch {
      return String(u || "").trim();
    }
  }

  function pickPublished(item) {
    // rss-parser: isoDate, pubDate, ... を拾う
    const cand = item?.isoDate || item?.pubDate || item?.published || item?.updated;
    if (!cand) return null;
    const d = new Date(cand);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function guessCategoryFromSource(source) {
    const s = String(source || "").toLowerCase();
    if (/(openai|anthropic|deepmind|google|huggingface)/.test(s)) return "AI企業";
    if (/(techcrunch|the verge|technologyreview|venturebeat|wired)/.test(s)) return "AIニュース";
    if (/(itmedia|ainow)/.test(s)) return "AI国内";
    if (/(arxiv|paperswithcode)/.test(s)) return "AI論文";
    return "その他";
  }

  // ===== ENV =====
  const guardianKey = process.env.GUARDIAN_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!guardianKey)
    return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!openaiKey)
    return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // ===== R2 ENV (optional) =====
  const r2AccountId = process.env.R2_ACCOUNT_ID;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const r2Bucket = process.env.R2_BUCKET;
  const r2Enabled = Boolean(
    r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket
  );
  const r2Endpoint = r2Enabled
    ? `https://${r2AccountId}.r2.cloudflarestorage.com`
    : null;

  // ===== R2 SigV4 minimal =====
  async function sha256Hex(message) {
    const enc = new TextEncoder();
    const data = enc.encode(message);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  async function hmac(key, msg) {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
    return new Uint8Array(sig);
  }
  function toHex(buf) {
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function getSignatureKey(secret, dateStamp, regionName, serviceName) {
    const enc = new TextEncoder();
    const kDate = await hmac(enc.encode("AWS4" + secret), dateStamp);
    const kRegion = await hmac(kDate, regionName);
    const kService = await hmac(kRegion, serviceName);
    const kSigning = await hmac(kService, "aws4_request");
    return kSigning;
  }
  function amzDate() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "Z"
    );
  }
  async function r2SignedFetch({ method, key, body, contentType }) {
    const region = "auto";
    const service = "s3";
    const host = `${r2AccountId}.r2.cloudflarestorage.com`;
    const endpoint = `${r2Endpoint}/${encodeURIComponent(r2Bucket)}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

    const t = amzDate();
    const dateStamp = t.slice(0, 8);

    const payloadHash = await sha256Hex(body ? body : "");
    const canonicalUri = `/${r2Bucket}/${key
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/")}`;

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${t}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest =
      `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign =
      `${algorithm}\n${t}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

    const signingKey = await getSignatureKey(
      r2SecretAccessKey,
      dateStamp,
      region,
      service
    );
    const signature = toHex(await hmac(signingKey, stringToSign));

    const authorizationHeader =
      `${algorithm} ` +
      `Credential=${r2AccessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`;

    const headers = {
      "x-amz-date": t,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorizationHeader,
    };
    if (contentType) headers["Content-Type"] = contentType;

    return fetch(endpoint, { method, headers, body: body || undefined });
  }
  async function r2GetJson(key) {
    if (!r2Enabled) return null;
    const resp = await r2SignedFetch({ method: "GET", key });
    if (!resp.ok) return null;
    const t = await resp.text().catch(() => "");
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
  async function r2PutJson(key, obj) {
    if (!r2Enabled) return false;
    const body = JSON.stringify(obj);
    const resp = await r2SignedFetch({
      method: "PUT",
      key,
      body,
      contentType: "application/json; charset=utf-8",
    });
    return resp.ok;
  }

  // ===== 0) Cache read (R2) =====
  try {
    if (r2Enabled && !force) {
      if (dateParam && dateParam !== todayJST()) {
        const daily = await r2GetJson(`daily/${dateParam}.json`);
        if (daily) {
          daily.cache = { hit: true, key: `daily/${dateParam}.json`, at: nowIso() };
          return res.status(200).json(daily);
        }
      } else {
        const latest = await r2GetJson("latest.json");
        if (latest) {
          latest.cache = { hit: true, key: "latest.json", at: nowIso() };
          return res.status(200).json(latest);
        }
      }
    }
  } catch (_) {}

  // ===== 1) Sources =====
  const RSS_FEEDS = [
    // AI企業公式
    { name: "OpenAI", url: "https://openai.com/blog/rss/" },
    { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml" },
    { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml" },
    { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
    { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },

    // テックメディア
    { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/" },
    { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
    { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },

    // 日本語
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "AINOW", url: "https://ainow.ai/feed/" },

    // 研究
    { name: "arXiv cs.AI", url: "http://export.arxiv.org/rss/cs.AI" },
    { name: "Papers with Code", url: "https://paperswithcode.com/latest/rss" },
  ];

  // RSSの取得数（多すぎるとOpenAIが重くなるので上限）
  const PER_FEED_LIMIT = 3;  // 1フィードあたり最大3件
  const RSS_TOTAL_CAP = 30;  // RSS候補最大30件
  const GUARDIAN_LIMIT = 10; // Guardian候補10件

  const parser = new RSSParser({
    timeout: 12000,
    headers: {
      "User-Agent": "ai-impact-brief-bot/1.0 (+https://ai-impact-brief.vercel.app/)",
      "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
  });

  async function fetchRssCandidates() {
    const out = [];
    for (const f of RSS_FEEDS) {
      try {
        const feed = await parser.parseURL(f.url);
        const items = Array.isArray(feed.items) ? feed.items.slice(0, PER_FEED_LIMIT) : [];
        for (const it of items) {
          const link = normalizeUrl(it.link || it.guid || "");
          const title = stripHtml(it.title || "");
          if (!link || !title) continue;

          // content/summaryを短く（OpenAIに渡す用）
          const summary =
            stripHtml(it.contentSnippet || it.summary || it.content || "").slice(0, 1500);

          out.push({
            source: f.name,
            category: guessCategoryFromSource(f.name),
            original_title: title,
            original_url: link,
            published_at: pickPublished(it),
            body: summary || "", // RSSは本文が取れないことが多いので要約で代用
          });
        }
      } catch (e) {
        // RSS失敗はスルー（debugで見たいなら後で出す）
      }
      await sleep(150); // 負荷軽減
      if (out.length >= RSS_TOTAL_CAP) break;
    }
    return out.slice(0, RSS_TOTAL_CAP);
  }

  async function fetchGuardianCandidates() {
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=${GUARDIAN_LIMIT}` +
      `&show-fields=headline,trailText,bodyText,byline` +
      `&api-key=${encodeURIComponent(guardianKey)}`;

    const guardianRes = await fetch(guardianUrl);
    if (!guardianRes.ok) {
      const t = await guardianRes.text().catch(() => "");
      throw new Error(
        `Guardian API error: ${guardianRes.status} ${guardianRes.statusText} ${t.slice(0, 200)}`
      );
    }
    const guardianData = await guardianRes.json();
    const results = guardianData?.response?.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    return results.slice(0, GUARDIAN_LIMIT).map((a) => ({
      source: "The Guardian",
      category: "AIニュース",
      original_title: stripHtml(a.webTitle || ""),
      original_url: normalizeUrl(a.webUrl || ""),
      published_at: a.webPublicationDate ? new Date(a.webPublicationDate).toISOString() : null,
      body: stripHtml(a?.fields?.bodyText || a?.fields?.trailText || "").slice(0, 3500),
      author: stripHtml(a?.fields?.byline || ""),
    }));
  }

  // ===== 2) Build candidates pool =====
  let rssCandidates = [];
  let guardianCandidates = [];
  try {
    [rssCandidates, guardianCandidates] = await Promise.all([
      fetchRssCandidates(),
      fetchGuardianCandidates(),
    ]);
  } catch (e) {
    // Guardianが落ちてもRSSで継続はしたいが、いまはGuardian必須なのでthrow
    return res.status(502).json({ error: e?.message || String(e) });
  }

  const merged = [...rssCandidates, ...guardianCandidates];

  // URL重複除去（勝ち筋：同じニュースの別ソースは残すか？→基本はURL単位で重複排除）
  // もし「同一トピックの別URL」を束ねたいなら、次段階で“話題クラスタリング”を入れる。
  const seen = new Set();
  const candidates = [];
  for (const x of merged) {
    const u = normalizeUrl(x.original_url);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    candidates.push({ ...x, original_url: u });
  }

  if (candidates.length < 6) {
    return res.status(502).json({
      error: "Not enough candidates (RSS/Guardian).",
      rss_count: rssCandidates.length,
      guardian_count: guardianCandidates.length,
    });
  }

  // ===== 3) OpenAI Prompt =====
  const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
「構造で読む、AI戦略ニュース」のコンセプトのもと、扇動・誇張・断定しすぎは禁止します。
出力は必ず「有効なJSONのみ」。説明文やMarkdownは禁止。
日本市場の視点（規制、産業構造、人材、供給網、資本市場）を必ず含めます。
`.trim();

  const userPrompt = `
以下のニュース候補（複数ソース混在）から、サブテーマが被らないように3件を選び、日本語で上質かつ客観的に整理してください。

【分散ルール（重要）】
- 3件は必ずテーマ分散：例）(1)企業戦略/資金 (2)規制/政策 (3)技術/供給網/研究
- 同一企業/同一話題の類似は避ける
- 可能なら「日本語ソース」も1件含める（候補にあれば）

【impact_level】
- High: 市場・政策・地政学レベルで構造影響
- Medium: 業界/大手企業単位
- Low: 限定的/話題性中心
Highは最大1件（明確な場合のみ）

【Score（公開前提）】
importance_score: 0〜100（整数）
score_breakdown:
  market_impact: 0-40
  business_impact: 0-30
  japan_relevance: 0-20
  confidence: 0-10
合計がimportance_scoreになる（厳守）

【出力JSON（厳守）】
{
  "date_iso":"YYYY-MM-DD",
  "items":[
    {
      "impact_level":"High|Medium|Low",
      "importance_score": 0,
      "score_breakdown": { "market_impact":0, "business_impact":0, "japan_relevance":0, "confidence":0 },
      "title_ja":"簡潔で品のある日本語タイトル",
      "one_sentence":"1文要約（知的トーン）",
      "why_it_matters":"なぜ重要か（2-3文）",
      "japan_impact":"日本市場への影響（2-3文、具体）",
      "tags":["短いタグを3つまで"],
      "fact_summary":["2-4項目"],
      "implications":["2-4項目"],
      "outlook":["2-4項目"],
      "original_title":"string",
      "original_url":"string",
      "source":"string",
      "published_at":"ISO8601 or null"
    }
  ]
}

【制約】
- itemsは必ず3件
- fact_summary/implications/outlookは各2〜4項目
- 1項目50文字以内推奨

Candidates JSON:
${JSON.stringify(candidates)}
`.trim();

  // ===== 4) OpenAI call =====
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

  // ===== 5) Score整合性補正 + 並び =====
  function clampInt(n, min, max) {
    const x = Number.isFinite(+n) ? Math.round(+n) : 0;
    return Math.max(min, Math.min(max, x));
  }
  for (const it of payload.items) {
    const sb = it.score_breakdown || {};
    const mi = clampInt(sb.market_impact, 0, 40);
    const bi = clampInt(sb.business_impact, 0, 30);
    const jr = clampInt(sb.japan_relevance, 0, 20);
    const cf = clampInt(sb.confidence, 0, 10);
    const sum = mi + bi + jr + cf;
    it.score_breakdown = { market_impact: mi, business_impact: bi, japan_relevance: jr, confidence: cf };
    it.importance_score = sum;

    // 返ってこない時の保険
    it.original_url = normalizeUrl(it.original_url || "");
    it.source = it.source || "Unknown";
    it.published_at = it.published_at || null;
  }

  const order = { High: 3, Medium: 2, Low: 1 };
  payload.items.sort((a, b) => {
    const o = (order[b.impact_level] || 0) - (order[a.impact_level] || 0);
    if (o !== 0) return o;
    return (b.importance_score || 0) - (a.importance_score || 0);
  });

  payload.date_iso = payload.date_iso || dateIso;
  payload.generated_at = nowIso();
  payload.version = "MULTISOURCE-RSS-1.0";
  payload.sources = Array.from(new Set(candidates.map((c) => c.source))).slice(0, 20);
  payload.cache = { hit: false, at: nowIso() };

  // ===== 6) Save R2 =====
  if (r2Enabled) {
    const dailyKey = `daily/${payload.date_iso}.json`;
    const rawKey = `raw/${payload.date_iso}.json`;
    const rawPayload = {
      date_iso: payload.date_iso,
      generated_at: payload.generated_at,
      candidates_count: candidates.length,
      candidates,
    };
    await r2PutJson("latest.json", payload).catch(() => {});
    await r2PutJson(dailyKey, payload).catch(() => {});
    await r2PutJson(rawKey, rawPayload).catch(() => {});
  }

  // ===== 7) Return =====
  if (debug) {
    return res.status(200).json({
      ...payload,
      debug: {
        r2Enabled,
        rss_count: rssCandidates.length,
        guardian_count: guardianCandidates.length,
        candidates_count: candidates.length,
        sample_sources: payload.sources,
      },
    });
  }

  return res.status(200).json(payload);
};
