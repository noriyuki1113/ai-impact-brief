#!/usr/bin/env python3
"""
B1: Vercel public/today.json を毎日自動生成するバッチ
- 複数RSSから候補収集（重複除外）
- 3枠（market/policy/tech）で分散して選定
- OpenAIがあれば分析JSON（score含む）を生成
- OpenAIが無ければフォールバック形式で生成
- public/today.json と public/archive/YYYY-MM-DD.json を出力
"""

import os, json, re, time
from datetime import datetime, timezone
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

import feedparser
import requests
from dateutil import parser as date_parser


# =========================
# RSS（必要に応じて増やす）
# =========================
AI_TECH_RSS_FEEDS = {
    # 公式・一次
    "OpenAI": "https://openai.com/blog/rss/",
    "Google AI Blog": "https://blog.google/technology/ai/rss/",
    "Anthropic": "https://www.anthropic.com/news/rss.xml",
    "DeepMind Blog": "https://deepmind.google/blog/rss.xml",
    "Hugging Face Blog": "https://huggingface.co/blog/feed.xml",

    # 大手メディア（AI）
    "TechCrunch AI": "https://techcrunch.com/tag/artificial-intelligence/feed/",
    "The Verge AI": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    "VentureBeat AI": "https://venturebeat.com/category/ai/feed/",
    "MIT Technology Review": "https://www.technologyreview.com/feed/",

    # 日本語（任意：ここは好みで）
    "ITmedia AI+": "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml",
    "AINOW": "https://ainow.ai/feed/",
}

OUT_PATH = "public/today.json"
ARCHIVE_DIR = "public/archive"

TIMEOUT = 12
PER_FEED_LIMIT = 12
TOTAL_CANDIDATES = 80
SLEEP_BETWEEN_FEEDS = 0.6

# OpenAI（任意）
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()


# =========================
# URL正規化
# =========================
def normalize_url(url: str) -> str:
    u = urlparse((url or "").strip())
    q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if not k.lower().startswith("utm_")]
    query = urlencode(q)
    path = u.path.rstrip("/") or "/"
    scheme = u.scheme or "https"
    if scheme == "http":
        scheme = "https"
    return urlunparse((scheme, u.netloc.lower(), path, u.params, query, ""))


def safe_date(s: str):
    if not s:
        return None
    try:
        dt = date_parser.parse(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def pick_published(entry):
    # feedparser entryはdictっぽい
    for k in ("published", "updated", "created"):
        v = entry.get(k)
        dt = safe_date(v)
        if dt:
            return dt
    return None


def strip_html(s: str) -> str:
    s = s or ""
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# =========================
# AI関連フィルタ（緩め→あとで締める）
# =========================
AI_KEYWORDS = [
    "ai", "artificial intelligence", "machine learning", "deep learning",
    "llm", "gpt", "chatgpt", "claude", "gemini", "foundation model",
    "agent", "inference", "training", "benchmark", "transformer",
    "gpu", "nvidia", "chip", "semiconductor",
    "ai act", "regulation", "governance", "copyright", "export controls",
    # 日本語ざっくり
    "生成ai", "人工知能", "大規模言語モデル", "推論", "学習", "規制", "半導体"
]

def looks_ai_related(title: str, summary: str) -> bool:
    blob = f"{title} {summary}".lower()
    return any(k in blob for k in AI_KEYWORDS)


# =========================
# 3枠（market/policy/tech）推定
# =========================
def infer_bucket(title: str, summary: str) -> str:
    t = (title + " " + summary).lower()

    market = ["funding", "valuation", "investment", "ipo", "earnings", "revenue",
              "acquisition", "merger", "deal", "partnership", "pricing", "layoff"]
    policy = ["regulation", "ai act", "law", "policy", "government", "ban",
              "copyright", "antitrust", "export", "controls", "sanction", "compliance"]
    tech = ["model", "release", "benchmark", "training", "inference", "agent",
            "chip", "gpu", "architecture", "open source", "dataset", "token", "context"]

    if any(k in t for k in policy):
        return "policy"
    if any(k in t for k in market):
        return "market"
    if any(k in t for k in tech):
        return "tech"
    return "tech"


def source_priority(name: str) -> int:
    n = name.lower()
    if any(k in n for k in ["openai", "anthropic", "deepmind", "google", "hugging face"]):
        return 1
    if any(k in n for k in ["itmedia", "ainow"]):
        return 2
    return 3


def fetch_feed(name: str, url: str):
    # feedparserのtimeout不安定対策：requestsで取ってからparse
    r = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": "AIImpactBriefBot/1.0"})
    r.raise_for_status()
    return feedparser.parse(r.text)


def collect_candidates():
    items = []
    seen_urls = set()

    for name, url in AI_TECH_RSS_FEEDS.items():
        try:
            feed = fetch_feed(name, url)
            entries = getattr(feed, "entries", []) or []
            for e in entries[:PER_FEED_LIMIT]:
                link = getattr(e, "link", None) or e.get("link")
                title = getattr(e, "title", None) or e.get("title")
                if not link or not title:
                    continue

                nurl = normalize_url(link)
                if nurl in seen_urls:
                    continue

                summary = strip_html(e.get("summary", "") or e.get("description", "") or "")
                t = strip_html(str(title))

                if not looks_ai_related(t, summary):
                    continue

                published_dt = pick_published(e) or datetime.now(timezone.utc)

                items.append({
                    "source": name,
                    "original_title": t,
                    "original_url": nurl,
                    "published_at": published_dt.isoformat(),
                    "summary_raw": summary[:1500],
                    "bucket": infer_bucket(t, summary),
                    "priority": source_priority(name),
                })
                seen_urls.add(nurl)

            time.sleep(SLEEP_BETWEEN_FEEDS)
        except Exception as ex:
            print(f"[WARN] feed failed: {name} -> {ex}")

    # 新しさ優先、ただし priority は強く効かせる
    def dt(x):
        try:
            return date_parser.parse(x["published_at"])
        except Exception:
            return datetime.now(timezone.utc)

    items.sort(key=lambda x: (x["priority"], -dt(x).timestamp()))
    return items[:TOTAL_CANDIDATES]


def pick_three_diverse(cands):
    """
    3枠（market/policy/tech）を優先しつつ、
    同一sourceは最大1本
    """
    picked = []
    used_sources = set()

    # まず枠を埋める
    for bucket in ["market", "policy", "tech"]:
        for it in cands:
            if it["source"] in used_sources:
                continue
            if it["bucket"] != bucket:
                continue
            picked.append(it)
            used_sources.add(it["source"])
            break

    # 足りない分は新しい順で埋める
    if len(picked) < 3:
        for it in cands:
            if it["source"] in used_sources:
                continue
            picked.append(it)
            used_sources.add(it["source"])
            if len(picked) == 3:
                break

    return picked[:3]


# =========================
# OpenAI構造化（任意）
# =========================
def openai_structurize(picked_articles):
    if not OPENAI_API_KEY:
        return None

    system_prompt = (
        "あなたは冷静で知的な戦略アナリストです。"
        "煽りや主観は禁止。断定しすぎない。"
        "出力は必ず有効なJSONのみ（説明文/Markdown禁止）。"
        "日本市場の視点（事業・投資・規制・実装）で評価し、スコアを公開してください。"
    )

    date_iso = datetime.now(timezone.utc).date().isoformat()

    user_payload = {
        "date_iso": date_iso,
        "articles": picked_articles,
        "score_rule": {
            "importance_score": "0-100",
            "breakdown": {
                "market_impact": "0-40",
                "business_impact": "0-30",
                "japan_relevance": "0-20",
                "confidence": "0-10"
            },
            "note": "Japan relevance is weighted; keep conservative confidence."
        }
    }

    user_prompt = f"""
以下の3本を、日本語で「構造で読む」形式に整形し、スコアも公開してください。
必ずJSONのみで返してください（説明/Markdown/前置き禁止）。

出力スキーマ（厳守）:
{{
  "date_iso": "YYYY-MM-DD",
  "items": [
    {{
      "impact_level": "High|Medium|Low",
      "importance_score": 0-100,
      "score_breakdown": {{
        "market_impact": 0-40,
        "business_impact": 0-30,
        "japan_relevance": 0-20,
        "confidence": 0-10
      }},
      "title_ja": "上質で簡潔（30字目安）",
      "one_sentence": "60字目安",
      "fact_summary": ["2-4項目"],
      "implications": ["2-4項目"],
      "outlook": ["2-4項目"],
      "original_title": "string",
      "original_url": "string",
      "published_at": "ISO8601",
      "source": "string"
    }}
  ]
}}

入力:
{json.dumps(user_payload, ensure_ascii=False)}
""".strip()

    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_API_KEY}"},
        json={
            "model": OPENAI_MODEL,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=40,
    )
    r.raise_for_status()
    data = r.json()
    raw = data["choices"][0]["message"]["content"].strip()

    raw = re.sub(r"^```json\s*", "", raw, flags=re.I).strip()
    raw = re.sub(r"^```\s*", "", raw, flags=re.I).strip()
    raw = re.sub(r"```$", "", raw, flags=re.I).strip()

    return json.loads(raw)


def ensure_dirs():
    os.makedirs("public", exist_ok=True)
    os.makedirs(ARCHIVE_DIR, exist_ok=True)


def write_json(payload, path):
    ensure_dirs()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def fallback_payload(picked):
    date_iso = datetime.now(timezone.utc).date().isoformat()

    def mk(a):
        return {
            "impact_level": "Medium",
            "importance_score": 60,
            "score_breakdown": {"market_impact": 20, "business_impact": 20, "japan_relevance": 15, "confidence": 5},
            "title_ja": a["original_title"][:30],
            "one_sentence": (a["summary_raw"][:60] or "要約なし"),
            "fact_summary": [a["summary_raw"][:50] or "情報なし", "一次情報はリンク参照"],
            "implications": ["影響評価は後続改善で強化可能", "日本市場観点の追加余地あり"],
            "outlook": ["次回更新で追記", "追加ソースで補強予定"],
            "original_title": a["original_title"],
            "original_url": a["original_url"],
            "published_at": a["published_at"],
            "source": a["source"],
        }

    payload = {
        "date_iso": date_iso,
        "items": [mk(a) for a in picked],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "version": "B1-RSS-Fallback-1.0",
        "sources": sorted(list({a["source"] for a in picked})),
    }
    return payload


def main():
    cands = collect_candidates()
    picked = pick_three_diverse(cands)

    # OpenAIがあれば構造化、失敗したらフォールバック
    payload = None
    try:
        structured = openai_structurize(picked)
        if structured and isinstance(structured, dict) and isinstance(structured.get("items"), list) and len(structured["items"]) == 3:
            payload = structured
            payload["generated_at"] = datetime.now(timezone.utc).isoformat()
            payload["version"] = "B1-RSS-OpenAI-1.0"
            payload["sources"] = sorted(list({it.get("source") for it in payload["items"] if it.get("source")}))
        else:
            payload = fallback_payload(picked)
    except Exception as e:
        print(f"[WARN] OpenAI failed -> fallback: {e}")
        payload = fallback_payload(picked)

    # 保存
    date_iso = payload.get("date_iso") or datetime.now(timezone.utc).date().isoformat()
    write_json(payload, OUT_PATH)
    write_json(payload, f"{ARCHIVE_DIR}/{date_iso}.json")

    print(f"[OK] wrote {OUT_PATH} and archive/{date_iso}.json")
    print(f"[INFO] sources: {payload.get('sources')}")


if __name__ == "__main__":
    main()
