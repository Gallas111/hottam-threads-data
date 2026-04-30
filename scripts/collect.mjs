// hottam-threads-data collector
// 6h cron — 19 카테고리 trending → playwright enrich → JSON commit

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { KEYWORD_PRESETS, PRESET_NAMES } from "./keywords.mjs";

const TOKEN = process.env.THREADS_TOKEN;
if (!TOKEN) { console.error("THREADS_TOKEN env required"); process.exit(1); }

// Subset for cost control. 일부 카테고리만 매 cron, 다른 cron 에서 다른 묶음 가능.
// 환경변수 PRESETS="A,B,C" 로 override, 없으면 전체.
const ARG_PRESETS = process.env.PRESETS?.split(",").map(s => s.trim()).filter(Boolean);
const SELECTED = ARG_PRESETS?.length ? ARG_PRESETS : PRESET_NAMES;
const PER_KEYWORD = Number(process.env.PER_KEYWORD || "10");
const MAX_ENRICH_PER_CAT = Number(process.env.MAX_ENRICH_PER_CAT || "20");
const ENRICH_CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || "3");

console.log(`Collecting ${SELECTED.length} categories: ${SELECTED.join(", ")}`);

// ==================== Meta API: keyword search ====================
async function searchKeyword(keyword, type = "TOP", limit = 10) {
  const url = new URL("https://graph.threads.net/v1.0/me/threads_keyword_search");
  url.searchParams.set("q", keyword);
  url.searchParams.set("search_type", type);
  url.searchParams.set("fields", "id,text,username,timestamp,permalink,media_type,media_url,thumbnail_url,shortcode,is_quote_post,is_reply,has_replies,alt_text");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", TOKEN);
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`keyword_search ${keyword} failed (${r.status}): ${text.slice(0, 200)}`);
  }
  const json = await r.json();
  return json.data || [];
}

// ==================== Playwright: enrich ====================
function findMetrics(obj, target) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { for (const v of obj) findMetrics(v, target); return; }
  const pickInt = (v) => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string") { const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.floor(n); }
    return null;
  };
  const like = pickInt(obj.like_count) ?? pickInt(obj.likes);
  if (like !== null && like > target.like) target.like = like;
  const reply = pickInt(obj.reply_count) ?? pickInt(obj.comment_count) ?? pickInt(obj.replies);
  if (reply !== null && reply > target.reply) target.reply = reply;
  const repost = pickInt(obj.repost_count) ?? pickInt(obj.reposts);
  if (repost !== null && repost > target.repost) target.repost = repost;
  const quote = pickInt(obj.quote_count) ?? pickInt(obj.quotes);
  if (quote !== null && quote > target.quote) target.quote = quote;
  const view = pickInt(obj.view_count) ?? pickInt(obj.video_view_count) ?? pickInt(obj.views);
  if (view !== null && view > target.view) target.view = view;
  for (const v of Object.values(obj)) findMetrics(v, target);
}

async function enrichOne(browser, post) {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  try {
    await page.goto(post.permalink, { waitUntil: "networkidle", timeout: 20000 });
    const blobs = await page.$$eval("script[data-sjs]", (els) => els.map(el => el.textContent || ""));
    const target = { like: 0, reply: 0, repost: 0, quote: 0, view: 0 };
    for (const blob of blobs) {
      if (!blob) continue;
      try { findMetrics(JSON.parse(blob), target); } catch {}
    }
    return {
      id: post.id,
      like_count: target.like, reply_count: target.reply, repost_count: target.repost,
      quote_count: target.quote, view_count: target.view,
      fetched_at: Date.now(), source: "scraped",
    };
  } catch (e) {
    return {
      id: post.id, like_count: 0, reply_count: 0, repost_count: 0, quote_count: 0, view_count: 0,
      fetched_at: Date.now(), source: "failed", _err: String(e).slice(0, 200),
    };
  } finally {
    await page.close();
  }
}

async function enrichBatch(browser, posts, concurrency = 3) {
  const out = [];
  for (let i = 0; i < posts.length; i += concurrency) {
    const slice = posts.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(p => enrichOne(browser, p)));
    out.push(...results);
  }
  return out;
}

// ==================== Per-category collect ====================
async function collectCategory(browser, presetName) {
  const keywords = KEYWORD_PRESETS[presetName];
  if (!keywords) { console.warn(`unknown preset: ${presetName}`); return null; }
  const seen = new Set();
  const all = [];
  for (const kw of keywords) {
    try {
      const posts = await searchKeyword(kw, "TOP", PER_KEYWORD);
      for (const p of posts) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        all.push({ ...p, _keyword: kw });
      }
    } catch (e) {
      console.warn(`  keyword '${kw}' failed: ${e.message}`);
    }
  }
  console.log(`  [${presetName}] ${all.length} unique posts collected`);
  // permalink 있는 글만 enrich, 상위 N 개
  const enrichable = all.filter(p => p.permalink).slice(0, MAX_ENRICH_PER_CAT);
  const metrics = await enrichBatch(browser, enrichable, ENRICH_CONCURRENCY);
  const byId = Object.fromEntries(metrics.map(m => [m.id, m]));
  const enriched = all.map(p => byId[p.id] ? { ...p, _metrics: byId[p.id] } : p);
  return {
    preset: presetName,
    keywords,
    fetchedAt: new Date().toISOString(),
    items: enriched,
    summary: {
      total: enriched.length,
      enriched: metrics.filter(m => m.source === "scraped").length,
      failed: metrics.filter(m => m.source === "failed").length,
    },
  };
}

// ==================== Main ====================
async function main() {
  const browser = await chromium.launch({ headless: true });
  const indexPayload = { generatedAt: new Date().toISOString(), categories: [] };
  for (const presetName of SELECTED) {
    console.log(`\n→ ${presetName}`);
    try {
      const result = await collectCategory(browser, presetName);
      if (!result) continue;
      const slug = encodeURIComponent(presetName).replace(/%/g, "_");
      const path = `data/trending/${slug}.json`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(result, null, 2), "utf8");
      console.log(`  → wrote ${path} (${result.items.length} items, ${result.summary.enriched} enriched)`);
      indexPayload.categories.push({
        preset: presetName,
        slug,
        path,
        ...result.summary,
        fetchedAt: result.fetchedAt,
      });
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      indexPayload.categories.push({ preset: presetName, error: e.message });
    }
  }
  await mkdir("data", { recursive: true });
  await writeFile("data/index.json", JSON.stringify(indexPayload, null, 2), "utf8");
  console.log(`\n✓ wrote data/index.json (${indexPayload.categories.length} categories)`);
  await browser.close();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
