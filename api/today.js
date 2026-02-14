import Parser from "rss-parser";

export const config = { runtime: "nodejs" };

/**
 * BUILD_ID: プロダクトのアイデンティティ
 */
const BUILD_ID = "STRATEGIC_AI_BRIEF_V5_ENHANCED";

// ====== 制御設定 (Tunables) ======
const FETCH_TIMEOUT_MS = 5000;   
const OPENAI_TIMEOUT_MS = 20000; // タイムアウト延長
const OUTPUT_ITEMS = 3;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15分
const MAX_RETRY_ATTEMPTS = 2; // リトライ回数

// ====== データソース設定 ======
const RSS_SOURCES = [
  { name: "OpenAI", url: "https://openai.com/blog/rss/", jp: false, weight: 1.0, hint: "product" },
  { name: "Anthropic", url: "https://www.anthropic.com/news/rss.xml", jp: false, weight: 0.95, hint: "product" },
  { name: "DeepMind", url: "https://deepmind.google/blog/rss.xml", jp: false, weight: 0.9, hint: "research" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/tag/artificial-intelligence/feed/", jp: false, weight: 0.8, hint: "market" },
  { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml", jp: true, weight: 1.0, hint: "japan" },
  { name: "AINOW", url: "https://ainow.ai/feed/", jp: true, weight: 0.7, hint: "product" },
];

const ALLOW_HOSTS = ["theguardian.com", "openai.com", "anthropic.com", "deepmind.google", "techcrunch.com", "itmedia.co.jp", "ainow.ai"];

// ====== キャッシュストア (並行性対応) ======
const CACHE_STORE = new Map();

// ====== カスタムエラークラス ======
class AIBriefError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "AIBriefError";
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

// ====== ロガー ======
const logger = {
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: "error", msg, ...meta, ts: new Date().toISOString() })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: "warn", msg, ...meta, ts: new Date().toISOString() })),
  info: (msg, meta = {}) => console.log(JSON.stringify({ level: "info", msg, ...meta, ts: new Date().toISOString() })),
};

// ====== ユーティリティ ======
const sha1Like = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { 
    h ^= s.charCodeAt(i); 
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24); 
  }
  return (h >>> 0).toString(16);
};

/**
 * URL正規化 (エラー処理強化)
 */
function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    logger.warn("Invalid URL provided to normalizeUrl", { raw });
    return "";
  }
  
  try {
    const u = new URL(raw);
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach(k => k.toLowerCase().startsWith("utm_") && params.delete(k));
    u.search = params.toString() ? `?${params.toString()}` : "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch (err) {
    logger.warn("URL normalization failed", { raw, error: err.message });
    return raw.trim();
  }
}

/**
 * タイムアウト付きfetch (リソースリーク対策)
 */
function timeoutFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AIBriefError(
        `Fetch timeout after ${timeoutMs}ms`,
        "FETCH_TIMEOUT",
        { url, timeoutMs }
      ));
    }, timeoutMs);

    fetch(url, { ...opts, signal: controller.signal })
      .then(response => {
        clearTimeout(timeoutId);
        resolve(response);
      })
      .catch(err => {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          reject(new AIBriefError(
            "Fetch aborted",
            "FETCH_ABORTED",
            { url }
          ));
        } else {
          reject(err);
        }
      });
  });
}

/**
 * トピック推定ロジック (正規表現改善版)
 */
function guessTopic(title, hint) {
  if (!title || typeof title !== 'string') {
    return hint || "other";
  }
  
  const t = title.toLowerCase();
  
  // 規制関連の厳密な検出 (誤検知対策)
  const regulationPatterns = [
    /\b(regulat(ion|ory)?|lawsuit|litigation|antitrust|ban|court)\b/i,
    /訴訟|規制|法案|司法|裁判/,
    /(?<![開発手方施実])(法律|法規)(?![人的案])/  // 「開発手法」「法人」などを除外
  ];
  if (regulationPatterns.some(re => re.test(t))) return "regulation";
  
  if (/\b(fund(ing)?|financ(e|ing)|valuation|ipo|raises?)\b|資金|調達|評価額|上場/i.test(t)) return "funding";
  if (/\b(chip|gpu|semiconductor|export|nvidia|tsmc)\b|半導体|輸出/i.test(t)) return "supply_chain";
  if (/\b(model|release|launch|api|tool|product)\b|アップデート|公開|提供|議事録/i.test(t)) return "product";
  if (/\b(research|paper|benchmark|arxiv)\b|研究|論文/i.test(t)) return "research";
  
  return hint || "other";
}

/**
 * 戦略的重み付けスコアリング
 */
function scoreCandidate(c) {
  let s = 40;
  s += Math.round((c.weight || 0.8) * 20);
  if (c.jp) s += 15;
  if (/japan|日本|国内|公取委|総務省|経産省/i.test(c.title || "")) s += 15;
  
  const bonus = { 
    regulation: 20, 
    funding: 15, 
    supply_chain: 15, 
    product: 5, 
    research: 5 
  };
  s += bonus[c.topic] || 0;

  s = Math.max(0, Math.min(95, s));
  
  // スコアブレイクダウンの整合性を保証
  const marketImpact = Math.min(40, Math.round(s * 0.42));
  const businessImpact = Math.min(30, Math.round(s * 0.32));
  const japanRelevance = Math.min(25, c.jp ? Math.round(s * 0.21) : Math.round(s * 0.11));
  const confidence = s - marketImpact - businessImpact - japanRelevance; // 残りを信頼度に
  
  return {
    score: s,
    breakdown: {
      market_impact: marketImpact,
      business_impact: businessImpact,
      japan_relevance: japanRelevance,
      confidence: Math.max(0, confidence)
    }
  };
}

// ====== データ取得関数 (エラー処理強化) ======

/**
 * The Guardian API取得
 */
async function fetchGuardian(key) {
  if (!key) {
    throw new AIBriefError("Guardian API key is missing", "MISSING_API_KEY");
  }
  
  const url = `https://content.guardianapis.com/search?section=technology&order-by=newest&page-size=10&show-fields=trailText&api-key=${encodeURIComponent(key)}`;
  
  try {
    logger.info("Fetching Guardian API", { url: url.replace(key, "***") });
    const res = await timeoutFetch(url);
    
    if (!res.ok) {
      throw new AIBriefError(
        `Guardian API returned ${res.status}`,
        "GUARDIAN_API_ERROR",
        { status: res.status, statusText: res.statusText }
      );
    }
    
    const data = await res.json();
    
    if (!data?.response?.results) {
      logger.warn("Guardian API returned unexpected structure", { data });
      return [];
    }
    
    const articles = data.response.results.map(a => ({
      source: "The Guardian",
      url: normalizeUrl(a.webUrl),
      title: a.webTitle || "No title",
      summary: (a.fields?.trailText || "").replace(/<[^>]*>?/gm, '').trim(),
      jp: false,
      weight: 0.95,
      hint: "market"
    })).filter(a => a.url && a.title); // 不完全なデータを除外
    
    logger.info("Guardian fetch successful", { count: articles.length });
    return articles;
    
  } catch (err) {
    if (err instanceof AIBriefError) {
      logger.error("Guardian fetch failed", { error: err.message, code: err.code });
    } else {
      logger.error("Guardian fetch failed with unexpected error", { error: err.message });
    }
    return []; // 失敗時は空配列を返す (グレースフルデグラデーション)
  }
}

/**
 * RSS取得 (エラー処理強化)
 */
async function fetchRssSafe(parser, src) {
  if (!src?.url || !src?.name) {
    logger.warn("Invalid RSS source configuration", { src });
    return [];
  }
  
  try {
    logger.info("Fetching RSS", { source: src.name, url: src.url });
    const res = await timeoutFetch(src.url);
    
    if (!res.ok) {
      throw new AIBriefError(
        `RSS fetch failed for ${src.name}`,
        "RSS_FETCH_ERROR",
        { status: res.status, source: src.name }
      );
    }
    
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("xml") && !contentType.includes("rss")) {
      logger.warn("RSS source returned non-XML content", { 
        source: src.name, 
        contentType 
      });
    }
    
    const xml = await res.text();
    
    if (!xml || xml.trim().length === 0) {
      throw new AIBriefError(
        `Empty RSS feed from ${src.name}`,
        "EMPTY_RSS_FEED",
        { source: src.name }
      );
    }
    
    const feed = await parser.parseString(xml);
    
    if (!feed?.items || !Array.isArray(feed.items)) {
      throw new AIBriefError(
        `Invalid RSS structure from ${src.name}`,
        "INVALID_RSS_STRUCTURE",
        { source: src.name }
      );
    }
    
    const articles = feed.items.slice(0, 8).map(it => ({
      source: src.name,
      url: normalizeUrl(it.link),
      title: it.title || "No title",
      summary: (it.contentSnippet || it.content || it.description || "")
        .slice(0, 500)
        .replace(/\s+/g, " ")
        .trim(),
      jp: !!src.jp,
      weight: src.weight || 0.5,
      hint: src.hint || "other"
    })).filter(a => a.url && a.title); // 不完全なエントリを除外
    
    logger.info("RSS fetch successful", { source: src.name, count: articles.length });
    return articles;
    
  } catch (err) {
    if (err instanceof AIBriefError) {
      logger.error("RSS fetch failed", { 
        source: src.name, 
        error: err.message, 
        code: err.code 
      });
    } else {
      logger.error("RSS fetch failed with unexpected error", { 
        source: src.name, 
        error: err.message,
        stack: err.stack 
      });
    }
    return [];
  }
}

/**
 * 多様性を維持したトップ選出
 */
function pickDiverseTop(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    logger.warn("pickDiverseTop received invalid candidates", { candidates });
    return [];
  }
  
  const enriched = candidates.map(c => {
    try {
      const topic = guessTopic(c.title, c.hint);
      const { score, breakdown } = scoreCandidate({ ...c, topic });
      return { 
        ...c, 
        topic, 
        importance_score: score, 
        score_breakdown: breakdown 
      };
    } catch (err) {
      logger.warn("Failed to score candidate", { candidate: c, error: err.message });
      return {
        ...c,
        topic: "other",
        importance_score: 30,
        score_breakdown: { market_impact: 10, business_impact: 10, japan_relevance: 5, confidence: 5 }
      };
    }
  }).sort((a, b) => b.importance_score - a.importance_score);

  const picked = [];
  const usedHosts = new Set();
  const usedTopics = new Set();

  // 第一パス: 多様性重視
  for (const c of enriched) {
    if (picked.length >= OUTPUT_ITEMS) break;
    
    let host = "";
    try { 
      host = new URL(c.url).hostname; 
    } catch (err) {
      logger.warn("Failed to extract hostname", { url: c.url, error: err.message });
      continue;
    }
    
    if (!usedHosts.has(host) && !usedTopics.has(c.topic)) {
      picked.push(c);
      usedHosts.add(host);
      usedTopics.add(c.topic);
    }
  }

  // 第二パス: 不足分を補填
  let i = 0;
  while (picked.length < OUTPUT_ITEMS && i < enriched.length) {
    if (!picked.find(p => p.url === enriched[i].url)) {
      picked.push(enriched[i]);
    }
    i++;
  }
  
  const result = picked.slice(0, OUTPUT_ITEMS);
  logger.info("Diversity selection complete", { 
    total: enriched.length, 
    selected: result.length 
  });
  
  return result;
}

// ====== OpenAI統合 (大幅強化) ======

/**
 * OpenAIでブリーフィング生成 (リトライ機能付き)
 */
async function generateBriefingWithOpenAI(picked, apiKey, attempt = 1) {
  if (!apiKey) {
    throw new AIBriefError("OpenAI API key is missing", "MISSING_OPENAI_KEY");
  }
  
  if (!Array.isArray(picked) || picked.length === 0) {
    throw new AIBriefError("No articles to process", "NO_ARTICLES", { picked });
  }
  
  try {
    logger.info("Calling OpenAI API", { attempt, articleCount: picked.length });
    
    const response = await timeoutFetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          Authorization: `Bearer ${apiKey}` 
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { 
              role: "system", 
              content: `あなたは戦略的AIコンサルタントです。提供されたニュースを日本市場の視点で分析し、以下のJSON形式で返してください:

{
  "items": [
    {
      "title_ja": "日本語タイトル",
      "one_sentence": "1行要約",
      "japan_impact": "日本市場への影響",
      "outlook": "今後の展望",
      "original_url": "元URL",
      "source": "ソース名",
      "topic": "トピック"
    }
  ],
  "market_summary": "市場全体のサマリー"
}

必ず有効なJSONを返してください。` 
            },
            { 
              role: "user", 
              content: JSON.stringify(picked, null, 2) 
            }
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 2000
        })
      },
      {},
      OPENAI_TIMEOUT_MS
    );
    
    if (!response.ok) {
      const errorBody = await response.text();
      throw new AIBriefError(
        `OpenAI API error: ${response.status}`,
        "OPENAI_API_ERROR",
        { 
          status: response.status, 
          statusText: response.statusText,
          body: errorBody.slice(0, 500) // 長いエラーメッセージは切り詰め
        }
      );
    }
    
    const data = await response.json();
    
    // レスポンス構造の検証
    if (!data?.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new AIBriefError(
        "Invalid OpenAI response structure",
        "INVALID_OPENAI_RESPONSE",
        { data }
      );
    }
    
    const messageContent = data.choices[0]?.message?.content;
    if (!messageContent) {
      throw new AIBriefError(
        "OpenAI response missing message content",
        "MISSING_MESSAGE_CONTENT",
        { choices: data.choices }
      );
    }
    
    // JSONパース
    let payload;
    try {
      payload = JSON.parse(messageContent);
    } catch (parseErr) {
      throw new AIBriefError(
        "Failed to parse OpenAI JSON response",
        "JSON_PARSE_ERROR",
        { 
          content: messageContent.slice(0, 500),
          parseError: parseErr.message 
        }
      );
    }
    
    // ペイロードの検証
    if (!payload.items || !Array.isArray(payload.items)) {
      throw new AIBriefError(
        "OpenAI response missing items array",
        "INVALID_PAYLOAD_STRUCTURE",
        { payload }
      );
    }
    
    logger.info("OpenAI processing successful", { 
      itemCount: payload.items.length,
      usage: data.usage 
    });
    
    return payload;
    
  } catch (err) {
    if (err instanceof AIBriefError) {
      logger.error("OpenAI processing failed", { 
        attempt,
        error: err.message, 
        code: err.code,
        details: err.details 
      });
    } else {
      logger.error("OpenAI processing failed with unexpected error", { 
        attempt,
        error: err.message,
        stack: err.stack 
      });
    }
    
    // リトライロジック
    if (attempt < MAX_RETRY_ATTEMPTS) {
      logger.info("Retrying OpenAI request", { attempt: attempt + 1 });
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // 指数バックオフ
      return generateBriefingWithOpenAI(picked, apiKey, attempt + 1);
    }
    
    // 最終的なフォールバック
    logger.warn("OpenAI retries exhausted, using fallback");
    return createFallbackPayload(picked);
  }
}

/**
 * フォールバックペイロード生成
 */
function createFallbackPayload(picked) {
  return {
    items: picked.map(p => ({
      title_ja: p.title,
      one_sentence: p.summary || "要約なし",
      japan_impact: "分析データなし",
      outlook: "展望データなし",
      original_url: p.url,
      source: p.source,
      topic: p.topic || "other",
      importance_score: p.importance_score,
      score_breakdown: p.score_breakdown
    })),
    market_summary: "OpenAI分析が利用できないため、基本情報のみ表示しています。",
    fallback: true
  };
}

// ====== キャッシュ管理 ======

function getCachedResponse(key = "default") {
  const cached = CACHE_STORE.get(key);
  if (cached && (Date.now() - cached.at < CACHE_TTL_MS)) {
    logger.info("Cache hit", { key, age: Date.now() - cached.at });
    return cached.payload;
  }
  logger.info("Cache miss", { key });
  return null;
}

function setCachedResponse(payload, key = "default") {
  const etag = `"${sha1Like(JSON.stringify(payload))}"`;
  CACHE_STORE.set(key, {
    at: Date.now(),
    payload,
    etag
  });
  logger.info("Cache updated", { key, etag });
}

// ====== メインハンドラー ======
export default async function handler(req, res) {
  const requestId = sha1Like(`${Date.now()}-${Math.random()}`);
  logger.info("Request received", { requestId, method: req.method });
  
  // CORS設定
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  if (req.method !== "GET") {
    return res.status(405).json({ 
      error: "Method not allowed",
      allowed: ["GET", "OPTIONS"]
    });
  }

  // API Key検証
  const gKey = process.env.GUARDIAN_API_KEY;
  const oKey = process.env.OPENAI_API_KEY;
  
  if (!gKey || !oKey) {
    logger.error("Missing API keys", { 
      hasGuardianKey: !!gKey, 
      hasOpenAIKey: !!oKey 
    });
    return res.status(500).json({ 
      error: "Server configuration error",
      code: "MISSING_API_KEYS",
      message: "必要なAPIキーが設定されていません"
    });
  }

  // キャッシュチェック
  const cached = getCachedResponse();
  if (cached) {
    return res.status(200).json({
      ...cached,
      cached: true,
      request_id: requestId
    });
  }

  try {
    const parser = new Parser({
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Strategic-AI-Brief/5.0 (News Aggregator)',
      }
    });
    
    // 1. データ取得 (並列実行 + エラー処理)
    logger.info("Starting parallel data fetch", { sourceCount: RSS_SOURCES.length + 1 });
    
    const results = await Promise.allSettled([
      fetchGuardian(gKey),
      ...RSS_SOURCES.map(src => fetchRssSafe(parser, src))
    ]);
    
    // 成功した結果のみを集約
    const successfulResults = results.filter(r => r.status === 'fulfilled');
    const failedResults = results.filter(r => r.status === 'rejected');
    
    if (failedResults.length > 0) {
      logger.warn("Some sources failed", { 
        failedCount: failedResults.length,
        successCount: successfulResults.length 
      });
    }
    
    const allCandidates = successfulResults
      .flatMap(r => r.value)
      .filter(c => {
        // ホワイトリストチェック
        if (!c?.url) return false;
        const isAllowed = ALLOW_HOSTS.some(h => c.url.includes(h));
        if (!isAllowed) {
          logger.warn("Article filtered by whitelist", { url: c.url });
        }
        return isAllowed;
      });

    logger.info("Data collection complete", { 
      totalCandidates: allCandidates.length,
      sources: [...new Set(allCandidates.map(c => c.source))]
    });

    // 最小記事数チェック
    if (allCandidates.length === 0) {
      throw new AIBriefError(
        "No articles collected from any source",
        "NO_ARTICLES_COLLECTED",
        { 
          sourcesAttempted: RSS_SOURCES.length + 1,
          failedCount: failedResults.length 
        }
      );
    }

    // 2. 多様性選出
    const picked = pickDiverseTop(allCandidates);
    
    if (picked.length === 0) {
      throw new AIBriefError(
        "Diversity selection returned no results",
        "SELECTION_FAILED",
        { candidateCount: allCandidates.length }
      );
    }

    // 3. OpenAI分析
    let payload = await generateBriefingWithOpenAI(picked, oKey);

    // 4. メタデータ付与
    payload = {
      ...payload,
      generated_at: new Date().toISOString(),
      version: BUILD_ID,
      build_id: `${BUILD_ID}__${new Date().toISOString().slice(0, 10)}`,
      request_id: requestId,
      sources_used: [...new Set(allCandidates.map(c => c.source))],
      total_candidates: allCandidates.length,
      cached: false
    };

    // キャッシュ更新
    setCachedResponse(payload);

    logger.info("Request completed successfully", { 
      requestId,
      itemCount: payload.items?.length 
    });
    
    return res.status(200).json(payload);

  } catch (err) {
    // 統一エラーレスポンス
    const statusCode = err.code === "NO_ARTICLES_COLLECTED" ? 503 : 500;
    
    const errorResponse = {
      error: err.message || "Internal server error",
      code: err.code || "UNKNOWN_ERROR",
      details: err.details || {},
      timestamp: err.timestamp || new Date().toISOString(),
      request_id: requestId,
      build_id: BUILD_ID
    };
    
    // 本番環境ではスタックトレースを非表示
    if (process.env.NODE_ENV !== "production") {
      errorResponse.stack = err.stack;
    }
    
    logger.error("Request failed", errorResponse);
    
    return res.status(statusCode).json(errorResponse);
  }
}
