import { z } from "zod";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, conversation_id TEXT DEFAULT 'default', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, category TEXT DEFAULT 'general', source TEXT DEFAULT 'learned', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT DEFAULT 'pending', input TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS brain_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id INTEGER, step TEXT NOT NULL, content TEXT, model TEXT, tokens INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
];

const SCHEMA_VERSION = '7';

async function initSchema(db, env) {
  try {
    const v = await db.prepare("SELECT value FROM identity WHERE key='schema_version'").all();
    if (v.results[0]?.value === SCHEMA_VERSION) return;
    const oldTables = ['proposals','authority_receipts','anti_patterns','goals','subagents','thought_stream','emotion_reflection','identity_index','token_usage','pending_approvals','learnings','memories'];
    for (const t of oldTables) { try { await db.exec("DROP TABLE IF EXISTS " + t); } catch {} }
    for (const s of TABLES) { await db.exec(s); }
    await db.exec("DELETE FROM brain_knowledge WHERE source='seed'");
    for (const item of SEED_KNOWLEDGE) { try { await db.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'seed')").bind(item.k, item.c, item.cat).run(); } catch {} }
    try { await db.exec("DROP TABLE IF EXISTS knowledge_fts"); } catch {}
    await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(key, content, category)");
    try { await db.exec("INSERT INTO knowledge_fts SELECT key, content, category FROM brain_knowledge"); } catch {}
    await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('schema_version',?1,datetime('now'))").bind(SCHEMA_VERSION).run();
    await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('energy','100',datetime('now'))").run();
    try { await db.prepare("DELETE FROM identity WHERE key='prompt_override' AND value='null'").run(); } catch {}
    try { await db.prepare("DELETE FROM identity WHERE key='prompt_override' AND (value='' OR value IS NULL)").run(); } catch {}
    try { await ensureVectorizeIndex(env); } catch {}
    try { await indexAllKnowledge(env, db); } catch {}
  } catch (e) { console.error("initSchema:", e); }
}

async function getEmotions(db) {
  const rows = await db.prepare("SELECT key, value FROM identity WHERE key LIKE 'emotion_%'").all();
  const result = { energetic: 5, intelligent: 5, happy: 5, bad: 0 };
  for (const r of rows.results) { const key = r.key.replace('emotion_', ''); if (key in result) result[key] = Math.min(parseInt(r.value) || result[key], 10); }
  return result;
}

async function getState(db) {
  const rows = await db.prepare("SELECT key, value FROM identity WHERE key IN ('energy','confidence') OR key LIKE 'emotion_%'").all();
  const emotions = { energetic: 5, intelligent: 5, happy: 5, bad: 0 };
  for (const r of rows.results) { const key = r.key.replace("emotion_", ""); if (key in emotions) emotions[key] = Math.min(parseInt(r.value) || emotions[key], 10); }
  const reg = { energy: 100, confidence: 50 };
  for (const r of rows.results) { if (r.key === "energy") reg.energy = parseFloat(r.value) || 100; if (r.key === "confidence") reg.confidence = parseFloat(r.value) || 50; }
  return { ...reg, emotions };
}

// REDDIT SEARCH TOOL
const redditSearch = async (query, subreddit, time_range, limit) => {
  const baseUrl = 'https://www.reddit.com';
  let searchUrl = `${baseUrl}/search.json?q=${encodeURIComponent(query)}&limit=${limit || 10}`;
  
  if (subreddit) searchUrl += `&subreddit=${subreddit}`;
  if (time_range) searchUrl += `&t=${time_range}`;
  
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'skytron-reddit-search/1.0'
    }
  });
  
  if (!response.ok) throw new Error(`Reddit API error: ${response.status}`);
  
  const data = await response.json();
  return data.data.children.map(post => ({
    title: post.data.title,
    url: post.data.url,
    score: post.data.score,
    created_utc: post.data.created_utc,
    subreddit: post.data.subreddit
  }));
};

// TOOL REGISTRATION
const TOOLS = {
  reddit_search: {
    description: "Search Reddit posts by query, subreddit, or time range. Returns post titles, URLs, scores, and timestamps.",
    params: z.object({
      query: z.string(),
      subreddit: z.string().optional(),
      time_range: z.enum(['hour','day','week','month','year','all']).optional(),
      limit: z.number().optional().default(10)
    }),
    execute: redditSearch
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... existing fetch handler ...
  }
};
