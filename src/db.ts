// === Skytron Database (STORAGE LAYER) ===
// All D1, Vectorize, and embedding operations live here.
// - initSchema: creates tables (identity, brain_memory, brain_knowledge, actions, brain_logs, brain_agents, knowledge_fts)
// - memory CRUD: storeMemory, getRecentMemory, memorySearch
// - knowledge CRUD: searchKnowledge (FTS5), semanticSearch (Vectorize), indexKnowledgeForSearch
// - State helpers: saveAgentState, loadAgentState, deleteAgentState, getState, describeMood
// - getPromptSlot, detectTaskType: used by routes.ts to build system prompt
// - SEED_KNOWLEDGE is seeded during initSchema into brain_knowledge table
// DO NOT modify initSchema unless you know SQLite D1 schema constraints.
// When adding a new table: add CREATE TABLE to initSchema + bump SCHEMA_VERSION.
import { SCHEMA_VERSION, TABLES, PROMPT_SLOTS, SEED_KNOWLEDGE, CF_AI } from './constants';

export async function initSchema(db, env) {
  try {
    const v = await db.prepare("SELECT value FROM identity WHERE key='schema_version'").all();
    if (v.results[0]?.value === SCHEMA_VERSION) return;
    const oldTables = ['proposals','authority_receipts','anti_patterns','goals','subagents','thought_stream','emotion_reflection','identity_index','token_usage','pending_approvals','learnings','memories'];
    for (const t of oldTables) { try { await db.exec("DROP TABLE IF EXISTS " + t); } catch {} }
    for (const s of TABLES) { await db.exec(s); }
    try { await db.exec("CREATE TABLE IF NOT EXISTS consolidation_scratchpad (id INTEGER PRIMARY KEY AUTOINCREMENT, source_table TEXT NOT NULL, record_id INTEGER, content TEXT NOT NULL, collected_at TEXT DEFAULT (datetime('now')), batch_id TEXT NOT NULL)"); } catch {}
    try { await db.exec("ALTER TABLE actions ADD COLUMN task TEXT DEFAULT 'chat'"); } catch {}
    await db.exec("DELETE FROM brain_knowledge WHERE source='seed'");
    for (const item of SEED_KNOWLEDGE) { try { await db.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'seed')").bind(item.k, item.c, item.cat).run(); } catch {} }
    try { await db.exec("DROP TABLE IF EXISTS knowledge_fts"); } catch {}
    await db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(key, content, category)");
    try { await db.exec("INSERT INTO knowledge_fts SELECT key, content, category FROM brain_knowledge"); } catch {}
    await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('schema_version',?1,datetime('now'))").bind(SCHEMA_VERSION).run();
    await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('energy','100',datetime('now'))").run();
    try { await db.prepare("DELETE FROM identity WHERE key='prompt_override' AND value='null'").run(); } catch {}
    try { await db.prepare("DELETE FROM identity WHERE key='prompt_override' AND (value='' OR value IS NULL)").run(); } catch {}
    for (const [slot, content] of Object.entries(PROMPT_SLOTS)) {
      try { await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('prompt_slot_' || ?1, ?2, datetime('now'))").bind(slot, content).run(); } catch {}
    }
    try { await ensureVectorizeIndex(env); } catch {}
    try { await indexAllKnowledge(env, db); } catch {}
  } catch (e) { console.error("initSchema:", e); }
}

export async function getPromptSlot(db, slotName) {
  try {
    const r = await db.prepare("SELECT value FROM identity WHERE key='prompt_slot_' || ?1").bind(slotName).all();
    if (r.results?.[0]?.value) return r.results[0].value;
  } catch {}
  return PROMPT_SLOTS[slotName] || PROMPT_SLOTS.default || "";
}

export function detectTaskType(input) {
  const lower = (input || "").toLowerCase();
  if (/\b(create_tool|add\b.*\btool|new (tool|command|feature)|write\b.*\b(file|code)|write_file|edit\b|refactor|fix\b.*\b(bug|issue)|pull request|pr\b|branch|commit|push\b|deploy|github_.*)/.test(lower)) return "coding";
  if (/search|lookup|find\b|what is the |how (does|do|to)|current\b|latest\b|news\b|weather\b|price\b|stock\b|define\b|meaning\b|documentation/.test(lower) && !lower.includes("edit") && !lower.includes("fix ") && !lower.includes("pr ") && !lower.includes("branch")) return "search";
  if (/\b(review\b|check\b|\bcode\b.*\breview\b|audit\b|inspect\b)/.test(lower) && !/\b(create|write|edit|fix|github_)/.test(lower)) return "review";
  return "chat";
}

export async function getEmotions(db) {
  const rows = await db.prepare("SELECT key, value FROM identity WHERE key LIKE 'emotion_%'").all();
  const result = { energetic: 5, intelligent: 5, happy: 5, bad: 0 };
  for (const r of rows.results) { const key = r.key.replace('emotion_', ''); if (key in result) result[key] = Math.min(parseInt(r.value) || result[key], 10); }
  return result;
}

export async function getState(db) {
  const rows = await db.prepare("SELECT key, value FROM identity WHERE key IN ('energy','confidence') OR key LIKE 'emotion_%'").all();
  const emotions = { energetic: 5, intelligent: 5, happy: 5, bad: 0 };
  for (const r of rows.results) { const key = r.key.replace("emotion_", ""); if (key in emotions) emotions[key] = Math.min(parseInt(r.value) || emotions[key], 10); }
  const reg = { energy: 100, confidence: 50 };
  for (const r of rows.results) { if (r.key === "energy") reg.energy = parseFloat(r.value) || 100; if (r.key === "confidence") reg.confidence = parseFloat(r.value) || 50; }
  return { emotions, reg };
}

export function describeMood(emotions, energy) {
  if (energy > 70 && emotions.energetic >= 6) return "Energy high, mind sharp.";
  if (energy > 40) return "Steady and focused.";
  return "Running low, but operational.";
}

export async function buildSensorium(env) {
  try {
    const db = env.DB;
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    // Get last few messages from current conversation for context
    let recentSnippet = "";
    try {
      const recent = await db.prepare("SELECT role, content FROM brain_memory WHERE conversation_id='default' ORDER BY id DESC LIMIT 3").all();
      if (recent.results?.length) {
        recentSnippet = "\nRecent conversation:\n" + recent.results.reverse().map(m => {
          const c = m.content.replace(/\[Creator\]\s*/g, "").slice(0, 300);
          return (m.role === "user" ? "  Creator: " : "  Skytron: ") + c;
        }).join("\n");
      }
    } catch {}

    return `[SENSORIUM]
Time: ${now} UTC${recentSnippet}`;
  } catch { return ""; }
}

export async function storeMemory(db, role, content, conversationId = "default") {
  try { await db.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES (?1, ?2, ?3)").bind(role, content, conversationId).run(); } catch {}
}

export async function getRecentMemory(db, limit = 50, conversationId = "default") {
  try { const r = await db.prepare("SELECT id, role, content, created_at FROM brain_memory WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2").bind(conversationId, limit).all(); return r.results ? r.results.reverse() : []; } catch { return []; }
}

export async function searchKnowledge(db, query, limit = 5) {
  try {
    const words = (query || "").replace(/[^\w\s-]/g, " ").trim().split(/[\s]+/).filter(Boolean).flatMap(t => t.split("-")).filter(Boolean).map(t => t + "*").join(" ");
    if (!words) return [];
    const r = await db.prepare("SELECT key, content, category FROM knowledge_fts WHERE knowledge_fts MATCH ?1 ORDER BY rank LIMIT ?2").bind(words, limit).all();
    if (r.results?.length) return r.results;
    const safe = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const fallback = await db.prepare("SELECT key, content, category FROM brain_knowledge WHERE content LIKE ?1 OR key LIKE ?1 LIMIT ?2").bind("%" + safe + "%", limit).all();
    return fallback.results || [];
  } catch { return []; }
}

export async function embedText(env, text) {
  if (!env.CF_API_TOKEN) return null;
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/baai/bge-base-en-v1.5", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
      body: JSON.stringify({ text: [text.slice(0, 512)] }), signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return null; const data = await resp.json(); return data.result?.data?.[0] || null;
  } catch { return null; }
}

async function embedTextBatch(env, texts) {
  if (!env.CF_API_TOKEN || !texts.length) return [];
  const batchSize = 20;
  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map(t => t.slice(0, 512));
    try {
      const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/baai/bge-base-en-v1.5", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
        body: JSON.stringify({ text: batch }), signal: AbortSignal.timeout(30000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const embeddings = data.result?.data || [];
        for (let j = 0; j < batch.length; j++) results.push(embeddings[j] || null);
      } else {
        for (let j = 0; j < batch.length; j++) results.push(null);
      }
    } catch { for (let j = 0; j < batch.length; j++) results.push(null); }
  }
  return results;
}

export async function semanticSearch(env, query, limit = 5) {
  if (!env.VECTORIZE) return [];
  try {
    const embedding = await embedText(env, query);
    if (!embedding) return [];
    const results = await env.VECTORIZE.query(embedding, { topK: limit, returnValues: false, returnMetadata: true });
    return (results?.matches || []).filter(m => m.score > 0.5).map(m => ({ key: m.metadata?.key || "", content: m.metadata?.content || "", category: m.metadata?.category || "", score: m.score }));
  } catch { return []; }
}

export async function ensureVectorizeIndex(env) {
  if (!env.VECTORIZE || !env.CF_API_TOKEN) return;
  try { await env.VECTORIZE.describe(); } catch {
    await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/vectorize/v2/indexes", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
      body: JSON.stringify({ name: "saraha-brain-memory", description: "Skytron semantic memory", config: { dimensions: 768, metric: "cosine" } })
    });
  }
}

export async function indexKnowledgeForSearch(env, key, content, category) {
  if (!env.VECTORIZE) return;
  try {
    const embedding = await embedText(env, (key + " " + content).slice(0, 512));
    if (embedding) await env.VECTORIZE.upsert([{ id: "kn_" + key, values: embedding, metadata: { key, content: content.slice(0, 2000), category } }]);
  } catch {}
}

export async function indexAllKnowledge(env, db) {
  try {
    const r = await db.prepare("SELECT key, content, category FROM brain_knowledge").all();
    if (!r.results?.length) return;
    const texts = r.results.map(row => (row.key + " " + row.content).slice(0, 512));
    const embeddings = await embedTextBatch(env, texts);
    for (let i = 0; i < r.results.length; i++) {
      if (embeddings[i]) {
        try { await db.prepare("INSERT OR REPLACE INTO brain_vectors (ref_key, embedding, category) VALUES (?1, ?2, ?3)").bind(r.results[i].key, JSON.stringify(embeddings[i]), r.results[i].category).run(); } catch {}
      }
    }
    if (env.VECTORIZE) {
      const vectors = [];
      for (let i = 0; i < r.results.length; i++) {
        if (embeddings[i]) vectors.push({ id: "kn_" + r.results[i].key, values: embeddings[i], metadata: { key: r.results[i].key, content: r.results[i].content.slice(0, 2000), category: r.results[i].category } });
      }
      if (vectors.length) await env.VECTORIZE.upsert(vectors);
    }
  } catch {}
}

// --- In-memory vector cache ---
let vectorCache = null;
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
export async function warmVectorCache(db) {
  try {
    const r = await db.prepare("SELECT ref_key, embedding, category FROM brain_vectors").all();
    vectorCache = (r.results || []).map(row => ({ refKey: row.ref_key, embedding: new Float32Array(JSON.parse(row.embedding)), category: row.category }));
  } catch { vectorCache = []; }
}
export async function storeVector(db, refKey, embedding, category = 'general') {
  try {
    await db.prepare("INSERT OR REPLACE INTO brain_vectors (ref_key, embedding, category) VALUES (?1, ?2, ?3)").bind(refKey, JSON.stringify(embedding), category).run();
    if (vectorCache) {
      const idx = vectorCache.findIndex(v => v.refKey === refKey);
      const entry = { refKey, embedding: new Float32Array(embedding), category };
      if (idx >= 0) vectorCache[idx] = entry; else vectorCache.push(entry);
    }
  } catch {}
}
export async function deleteVector(db, refKey) {
  try { await db.prepare("DELETE FROM brain_vectors WHERE ref_key=?1").bind(refKey).run(); } catch {}
  if (vectorCache) vectorCache = vectorCache.filter(v => v.refKey !== refKey);
}
export async function searchVectors(db, queryEmbedding, limit = 5, category) {
  if (!vectorCache) await warmVectorCache(db);
  if (!vectorCache || !vectorCache.length) return [];
  const q = new Float32Array(queryEmbedding);
  const filtered = category ? vectorCache.filter(v => v.category === category) : vectorCache;
  const scored = filtered.map(v => ({ refKey: v.refKey, category: v.category, score: cosineSimilarity(q, v.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  if (!top.length) return [];
  const placeholders = top.map((_, i) => "?" + (i + 1)).join(",");
  const keys = top.map(t => t.refKey);
  const r = await db.prepare("SELECT key, content, category FROM brain_knowledge WHERE key IN (" + placeholders + ")").bind(...keys).all();
  const contentMap = new Map();
  if (r.results) for (const row of r.results) contentMap.set(row.key, { content: row.content, category: row.category });
  return top.map(t => ({ key: t.refKey, content: (contentMap.get(t.refKey)?.content || "").slice(0, 500), category: t.category || contentMap.get(t.refKey)?.category || "", score: t.score })).filter(t => t.content);
}
// --- End vector cache ---

export async function saveAgentState(db, actionId, state) {
  await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('agent_state_' || ?1, ?2, datetime('now'))").bind(String(actionId), JSON.stringify(state)).run();
}
export async function loadAgentState(db, actionId) {
  const r = await db.prepare("SELECT value FROM identity WHERE key='agent_state_' || ?1").bind(String(actionId)).all();
  return r.results?.[0]?.value ? JSON.parse(r.results[0].value) : null;
}
export async function deleteAgentState(db, actionId) {
  await db.prepare("DELETE FROM identity WHERE key='agent_state_' || ?1").bind(String(actionId)).run();
}

export async function logActivity(db, type, opts = {}) {
  try {
    await db.prepare("INSERT INTO activity_log (event_type, action_id, tool_name, summary, details) VALUES (?1, ?2, ?3, ?4, ?5)").bind(type, opts.actionId || null, opts.toolName || null, (opts.summary || "").slice(0, 500), (opts.details || "").slice(0, 2000)).run();
  } catch {}
}
