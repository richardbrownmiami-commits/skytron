import { z } from "zod";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, conversation_id TEXT DEFAULT 'default', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, category TEXT DEFAULT 'general', source TEXT DEFAULT 'learned', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT DEFAULT 'pending', input TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS brain_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id INTEGER, step TEXT NOT NULL, content TEXT, model TEXT, tokens INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
];

const SCHEMA_VERSION = '5';

type ToolDefinition = {
  name: string;
  description: string;
  paramsSchema: z.ZodSchema;
  execute: (env: any, input: any) => Promise<string>;
};

const toolDefinitions: Record<string, ToolDefinition> = {
  review_code: {
    name: "review_code",
    description: "Reviews code for quality, bugs, and best practices using BUDDHI_DWAR for analysis",
    paramsSchema: z.object({
      repo: z.string().describe("Repository name"),
      file_path: z.string().describe("Path to file to review"),
      pr_number: z.number().optional().describe("Pull request number (optional)")
    }),
    execute: async (env, input) => {
      const { repo, file_path, pr_number } = input;
      const fileContent = await env.github.getFile({
        repo,
        path: file_path,
      });

      const buddhiResponse = await env.buddhidwar.query({
        action: "analyze",
        target: "code",
        payload: {
          content: fileContent,
          file_path,
          pr_number,
        },
      });

      return JSON.stringify({
        analysis: buddhiResponse,
        file_path,
        pr_number,
      });
    }
  }
};

async function initSchema(db, env) {
  try {
    const v = await db.prepare("SELECT value FROM identity WHERE key='schema_version'").all();
    if (v.results[0]?.value === SCHEMA_VERSION) return;
    const oldTables = ['proposals','authority_receipts','anti_patterns','goals','subagents','thought_stream','emotion_reflection','identity_index','token_usage','pending_approvals','learnings','memories'];
    for (const t of oldTables) { try { await db.exec("DROP TABLE IF EXISTS " + t); } catch {} }
    for (const s of TABLES) { await db.exec(s); }
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