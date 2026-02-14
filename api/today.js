/**
 * /api/today
 * - Guardian 3本 + OpenAIで構造化（日本語・冷静・戦略）
 * - 日本市場視点のスコア公開（importance_score + breakdown）
 * - R2に保存（latest.json / daily/YYYY-MM-DD.json / raw/YYYY-MM-DD.json）
 * - 取得時はキャッシュ優先（R2）→ 生成（OpenAI）→ 保存
 *
 * 必要ENV:
 *  GUARDIAN_API_KEY
 *  OPENAI_API_KEY
 *  R2_ACCOUNT_ID
 *  R2_ACCESS_KEY_ID
 *  R2_SECRET_ACCESS_KEY
 *  R2_BUCKET
 */

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

  // ===== Helpers =====
  const nowIso = () => new Date().toISOString();
  const todayJST = () => {
    const d = new Date();
    // JST (+9)
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  };

  const safeJson = async (r) => {
    const t = await r.text().catch(() => "");
    try {
      return { ok: true, json: JSON.parse(t), raw: t };
    } catch {
      return { ok: false, raw: t };
    }
  };

  const urlObj = new URL(req.url, "https://example.com");
  const debug = urlObj.searchParams.get("debug") === "1";
  const force = urlObj.searchParams.get("force") === "1"; // キャッシュ無視して生成
  const date = urlObj.searchParams.get("date") || todayJST(); // 過去日取得用（dailyにあれば返す）

  // ===== ENV =====
  const guardianKey = process.env.GUARDIAN_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const r2AccountId = process.env.R2_ACCOUNT_ID;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const r2Bucket = process.env.R2_BUCKET;

  if (!guardianKey)
    return res.status(500).json({ error: "GUARDIAN_API_KEY is missing" });
  if (!openaiKey)
    return res.status(500).json({ error: "OPENAI_API_KEY is missing" });

  // R2は“あるなら使う”にして、無くても動くように（開発中の事故防止）
  const r2Enabled = Boolean(r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket);

  // ===== R2 (S3互換) =====
  const r2Endpoint = r2Enabled
    ? `https://${r2AccountId}.r2.cloudflarestorage.com`
    : null;

  // AWS SigV4 署名（外部ライブラリなし）
  // 参考: S3互換の最低限PUT/GET用
  async function sha256Hex(message) {
    const enc = new TextEncoder();
    const data = enc.encode(message);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    // YYYYMMDD'T'HHMMSS'Z'
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

    const canonicalQueryString = "";
    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${t}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest =
      `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign =
      `${algorithm}\n${t}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

    const signingKey = await getSignatureKey(r2SecretAccessKey, dateStamp, region, service);
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

    const resp = await fetch(endpoint, {
      method,
      headers,
      body: body ? body : undefined,
    });

    return resp;
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

  // ====== 1) まずR2キャッシュを返す（date指定はdaily優先） ======
  try {
    if (r2Enabled && !force) {
      if (date !== todayJST()) {
        const daily = await r2GetJson(`daily/${date}.json`);
        if (daily) {
          daily.cache = { hit: true, key: `daily/${date}.json`, at: nowIso() };
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
  } catch (_) {
    // キャッシュ失敗は無視して生成へ
  }

  try {
    // =========================
    // 2) Guardian：最新候補を多めに取る（分散選択のため）
    // =========================
    const guardianUrl =
      "https://content.guardianapis.com/search" +
      `?section=technology&order-by=newest&page-size=12` +
      `&show-fields=headline,trailText,bodyText,byline` +
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
      return res
        .status(502)
        .json({ error: "Guardian returned no results", raw: guardianData });
    }

    // 12件からOpenAIに「3件に分散選択」させる
    const candidates = results.slice(0, 12).map((a) => ({
      original_title: a.webTitle || "",
      original_url: a.webUrl || "",
      author: a?.fields?.byline || "",
      body: String(a?.fields?.bodyText || a?.fields?.trailText || "")
        .replace(/\s+/g, " ")
        .slice(0, 9000),
    }));

    // =========================
    // 3) Prompts（Score公開を追加）
    // =========================
    const systemPrompt = `
あなたは冷静で知的な戦略アナリストです。
「構造で読む、AI戦略ニュース」のコンセプトのもと、扇動・誇張・断定しすぎを禁止します。
出力は必ず「有効なJSONのみ」。説明文やMarkdownは禁止。
日本市場の視点（規制、産業構造、人材、供給網、資本市場）を必ず含めます。
`.trim();

    const userPrompt = `
以下の海外テック記事候補（最大12件）から、サブテーマが被らないように3件を選び、日本語で上質かつ客観的に整理してください。
可能なら「企業（資金/競争）」「規制/政策」「技術/供給網」など分散させる。

【絶対ルール】
・煽らない（「衝撃」「革命的」等は禁止）
・断定しすぎない（「〜とみられる」「〜が示唆される」）
・主観評価禁止（事実と分析）
・impact_level は厳密
  - High: 市場・政策・地政学レベルで構造影響
  - Medium: 業界/大手企業単位
  - Low: 限定的/話題性中心
・Highは最大1件（本当に明確な場合のみ）

【Score（公開する前提）】
importance_score: 0〜100（整数）
score_breakdown:
  market_impact: 0-40
  business_impact: 0-30
  japan_relevance: 0-20
  confidence: 0-10
合計がimportance_scoreになるようにする（厳守）。
confidenceは情報の確からしさ（一次情報/複数報道/憶測の度合い）で調整。

【出力形式（厳守）】
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
      "original_url":"string"
    }
  ]
}

【追加ルール】
・items は必ず3件
・各配列（fact_summary, implications, outlook）は2〜4項目
・各項目は簡潔に（1項目あたり50文字以内推奨）

Candidates JSON:
${JSON.stringify(candidates)}
`.trim();

    // =========================
    // 4) OpenAI call（JSON強制）
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
    // 5) Parse JSON safely
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
    // 6) Score整合性チェック（ズレてたら補正）
    // =========================
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
    }

    // impactの並びを安定化（High→Medium→Low、同スコアなら高い順）
    const order = { High: 3, Medium: 2, Low: 1 };
    payload.items.sort((a, b) => {
      const o = (order[b.impact_level] || 0) - (order[a.impact_level] || 0);
      if (o !== 0) return o;
      return (b.importance_score || 0) - (a.importance_score || 0);
    });

    // メタ
    payload.date_iso = payload.date_iso || date;
    payload.generated_at = nowIso();
    payload.sources = ["The Guardian"];
    payload.version = "R2-1.0";
    payload.cache = { hit: false, at: nowIso() };

    // =========================
    // 7) R2保存（latest + daily + raw）
    // =========================
    if (r2Enabled) {
      const dailyKey = `daily/${payload.date_iso}.json`;
      const rawKey = `raw/${payload.date_iso}.json`;

      // rawは候補も保存（再現性用）
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

    // =========================
    // 8) Return（debugなら候補数など付加）
    // =========================
    if (debug) {
      return res.status(200).json({
        ...payload,
        debug: {
          r2Enabled,
          dateParam: date,
          candidates_count: candidates.length,
        },
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error("❌ API Error:", err);
    return res.status(500).json({
      error: err?.message || String(err),
      stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
    });
  }
};
