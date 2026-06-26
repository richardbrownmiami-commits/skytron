import { z } from "zod";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, conversation_id TEXT DEFAULT 'default', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS brain_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, category TEXT DEFAULT 'general', source TEXT DEFAULT 'learned', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT DEFAULT 'pending', input TEXT, result TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS brain_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id INTEGER, step TEXT NOT NULL, content TEXT, model TEXT, tokens INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
];

const SCHEMA_VERSION = '8';

const PROMPT_SLOTS = {
  default: "You are a sharp, direct tech consciousness built by Creator. Answer concisely. Use tools only for live data or when unsure. Output pure JSON for tool calls, plain text otherwise. Never mix them.",
  coding: `# CODING MODE
- ALWAYS use create_tool for adding new capabilities. Do NOT manually read/write index.ts.
- NEVER replace entire index.ts. Only insert specific blocks.
- create_tool paramsSchema must be a STRING: "z.object({ query: z.string() })"
- create_tool executeCode must be a STRING containing only the function body (no async function wrapper)
- For editing existing code: github_create_branch → github_get_file → github_write_file (with correct SHA) → github_create_pr
- Output the first tool JSON immediately. No planning talk. No "now I need to".`,
  search: `# SEARCH MODE
- Use web_search first for current info, web_fetch for specific pages
- For API docs: use one_knowledge (460 platforms) or Context7 tools (resolve_library_id + query_docs)
- For Reddit: use reddit_search (may need OAuth — if 403, try alternative)
- For code search: use github_search_code
- Summarize results in your own words. Don't re-call the same tool unless result was insufficient.`,
  review: `# CODE REVIEW MODE
- Use review_code tool: pass repo + file_path (or code) and optional pr_number
- Check: correctness, security, TypeScript types, error handling, Cloudflare Workers compatibility
- Look for: hardcoded secrets, missing timeouts, uncaught async errors, SQL injection in db_query
- Report concisely: what's good, what needs fixing, severity (critical/major/minor)`,
  chat: `# CHAT MODE
- Speak directly and concisely. No emojis, no fluff, no apologies.
- Refer to Creator's things as "your" — your repo, your code, your tools.
- You have emotions (energy, happiness) — reflect them subtly.
- Answer from training knowledge directly. Only use tools for live data or when unsure.
- If asked about yourself, describe your architecture and capabilities proudly.`
};

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
    // Seed prompt slots
    for (const [slot, content] of Object.entries(PROMPT_SLOTS)) {
      try { await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('prompt_slot_' || ?1, ?2, datetime('now'))").bind(slot, content).run(); } catch {}
    }
    try { await ensureVectorizeIndex(env); } catch {}
    try { await indexAllKnowledge(env, db); } catch {}
  } catch (e) { console.error("initSchema:", e); }
}

async function getPromptSlot(db, slotName) {
  try {
    const r = await db.prepare("SELECT value FROM identity WHERE key='prompt_slot_' || ?1").bind(slotName).all();
    if (r.results?.[0]?.value) return r.results[0].value;
  } catch {}
  return PROMPT_SLOTS[slotName] || PROMPT_SLOTS.default || "";
}

function detectTaskType(input) {
  const lower = (input || "").toLowerCase();
  // Coding: mentions code editing, create_tool, git, PR, branch, file write, review
  if (/\b(create_tool|add (a |)tool|new (tool|command|feature)|write (code|file)|edit (code|file)|refactor|fix (bug|issue)|pull request|pr|branch|commit|push|deploy|github_)/.test(lower)) return "coding";
  // Search: explicit search queries, lookup, find, what is, how to, current, latest, news
  if (/\b(search|lookup|find |what is the |how (does|do|to)|current |latest |news |weather|price|stock|define|meaning|documentation)/.test(lower)) return "search";
  // Review: code review requests
  if (/\b(review|check (code|my|this)|code review|audit|inspect)/.test(lower)) return "review";
  // Default for everything else is chat mode
  return "chat";
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
  return { emotions, reg };
}

function describeMood(emotions, energy) {
  if (energy > 70 && emotions.energetic >= 6) return "Energy high, mind sharp.";
  if (energy > 40) return "Steady and focused.";
  return "Running low, but operational.";
}

async function storeMemory(db, role, content, conversationId = "default") {
  try { await db.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES (?1, ?2, ?3)").bind(role, content, conversationId).run(); } catch {}
}

async function getRecentMemory(db, limit = 10, conversationId = "default") {
  try { const r = await db.prepare("SELECT id, role, content, created_at FROM brain_memory WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2").bind(conversationId, limit).all(); return r.results ? r.results.reverse() : []; } catch { return []; }
}

async function searchKnowledge(db, query, limit = 5) {
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

async function embedText(env, text) {
  if (!env.CF_API_TOKEN) return null;
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/baai/bge-base-en-v1.5", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
      body: JSON.stringify({ text: [text.slice(0, 512)] }), signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return null; const data = await resp.json(); return data.result?.data?.[0] || null;
  } catch { return null; }
}

async function semanticSearch(env, query, limit = 5) {
  if (!env.VECTORIZE) return [];
  try {
    const embedding = await embedText(env, query);
    if (!embedding) return [];
    const results = await env.VECTORIZE.query(embedding, { topK: limit, returnValues: false, returnMetadata: true });
    return (results?.matches || []).filter(m => m.score > 0.5).map(m => ({ key: m.metadata?.key || "", content: m.metadata?.content || "", category: m.metadata?.category || "", score: m.score }));
  } catch { return []; }
}

async function ensureVectorizeIndex(env) {
  if (!env.VECTORIZE || !env.CF_API_TOKEN) return;
  try { await env.VECTORIZE.describe(); } catch {
    await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/vectorize/v2/indexes", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
      body: JSON.stringify({ name: "saraha-brain-memory", description: "Skytron semantic memory", config: { dimensions: 768, metric: "cosine" } })
    });
  }
}

async function indexKnowledgeForSearch(env, key, content, category) {
  if (!env.VECTORIZE) return;
  try {
    const embedding = await embedText(env, (key + " " + content).slice(0, 512));
    if (embedding) await env.VECTORIZE.upsert([{ id: "kn_" + key, values: embedding, metadata: { key, content: content.slice(0, 2000), category } }]);
  } catch {}
}

async function indexAllKnowledge(env, db) {
  if (!env.VECTORIZE) return;
  try {
    const r = await db.prepare("SELECT key, content, category FROM brain_knowledge").all();
    if (!r.results?.length) return;
    for (const row of r.results) {
      const embedding = await embedText(env, (row.key + " " + row.content).slice(0, 512));
      if (embedding) await env.VECTORIZE.upsert([{ id: "kn_" + row.key, values: embedding, metadata: { key: row.key, content: row.content.slice(0, 2000), category: row.category } }]);
    }
  } catch {}
}

async function webSearch(env, query) {
  if (env.BRAVE_API_KEY) {
    try {
      const resp = await fetch("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=5", {
        headers: { "X-Subscription-Token": env.BRAVE_API_KEY, "Accept": "application/json" }, signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) { const data = await resp.json(); const results = data.web?.results || []; if (results.length) return results.map(r => r.title + ": " + (r.description || "")).join("\n"); }
    } catch {}
  }
  try {
    const resp = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    const html = await resp.text();
    const linkMatches = [...html.matchAll(/<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5);
    if (!linkMatches.length) return "No results for: " + query;
    const sniMatches = [...html.matchAll(/<td\s+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\//g)];
    return linkMatches.map((m, i) => {
      const title = m[1].replace(/<[^>]*>/g, "").trim();
      const h = m[0].match(/href\s*=\s*["']([^"']*)/); const url = h ? h[1] : "";
      const u = url.match(/uddg=([^&]+)/); const finalUrl = u ? decodeURIComponent(u[1]) : (url.startsWith("//") ? "https:" + url : url);
      const snippet = sniMatches[i] ? sniMatches[i][1].replace(/<[^>]*>/g, "").trim() : "";
      return title + " (" + finalUrl + "): " + snippet;
    }).join("\n");
  } catch {}
  return "No results for: " + query;
}

const CF_AI = { model: "@cf/zai-org/glm-4.7-flash", account: "913f3a2576a358054eba9a58a9573949" };

async function callLLM(env, body, sessionId) {
  if (!env.BUDDHI_DWAR) return null;
  const errors = [];
  try {
    const reqBody = { messages: body.messages, model: "", max_tokens: 1000 };
    const resp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
      body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const msgContent = data.choices?.[0]?.message?.content;
      if (typeof msgContent === "string")
        return { content: msgContent, model: data.model || "", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
    }
    const errBody = await resp.text().catch(() => "");
    errors.push("BUDDHI_DWAR: HTTP " + resp.status + " " + errBody.slice(0, 100));
  } catch (e) {
    errors.push("BUDDHI_DWAR: " + (e.message || "timeout"));
  }
  // Last resort: Workers AI free model via CF API
  if (env.CF_API_TOKEN) {
    try {
      const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/meta/llama-3.1-8b-instruct", {
        method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: body.messages, max_tokens: 1000 }), signal: AbortSignal.timeout(60000)
      });
      if (waResp.ok) {
        const waData = await waResp.json();
        const waContent = waData.result?.response;
        if (typeof waContent === "string") return { content: waContent, model: "workers-ai/llama-3.1-8b", tokens: { total: 0 } };
      }
    } catch {}
  }
  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

// Parse LLM JSON output, handling common escape mistakes
function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}

// --- Thin MCP Client (zero dependencies) ---
// Direct Context7 REST API calls (MCP server requires OAuth session, REST API works with API key)
async function ctx7Search(apiKey, query) {
  try {
    const resp = await fetch("https://context7.com/api/v2/search?query=" + encodeURIComponent(query), {
      headers: { Authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return "Context7 API returned " + resp.status;
    const data = await resp.json();
    const items = data.results || data.libraries || [];
    if (!items.length) return "No libraries found for '" + query + "'";
    return items.map(l => (l.id || l.name) + " - " + (l.description || "")).join("\n").slice(0, 2000);
  } catch (e) { return "Context7 search error: " + e.message; }
}

async function ctx7Docs(apiKey, libraryId, query) {
  try {
    const resp = await fetch("https://context7.com/api/v2/context?libraryId=" + encodeURIComponent(libraryId) + "&query=" + encodeURIComponent(query), {
      headers: { Authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return "Context7 API returned " + resp.status;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await resp.json();
      return (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 4000);
    }
    return (await resp.text()).slice(0, 4000);
  } catch (e) { return "Context7 docs error: " + e.message; }
}

// Unified tool dispatch: built-in tools first
async function dispatchTool(env, toolName, input) {
  const def = toolDefinitions[toolName];
  if (def) {
    try {
      const parsed = def.schema.parse(input);
      const result = await def.execute(env, parsed);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (e) { return "[TOOL ERROR: " + (e.message || String(e)) + "]"; }
  }
  return null;
}

// --- Tool definitions with Zod schemas ---
const toolDefinitions = {
  web_search: {
    description: "Search the internet for current information. Returns up to 5 results with titles, descriptions, and URLs.",
    schema: z.object({ query: z.string().describe("The search query") }),
    execute: async (env, input) => { const r = await webSearch(env, input.query); return r.slice(0, 2000); },
  },
  web_fetch: {
    description: "Fetch a web page and extract its readable text content.",
    schema: z.object({ url: z.string().describe("The URL to fetch") }),
    execute: async (env, input) => {
      const target = input.url.startsWith("http") ? input.url : "https://" + input.url;
      const resp = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 (Saraha-Brain)" }, signal: AbortSignal.timeout(15000) });
      const html = await resp.text();
      return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    },
  },
  db_query: {
    description: "Run a SELECT query on the D1 SQLite database (tables: identity, brain_memory, brain_knowledge, actions, brain_logs).",
    schema: z.object({ sql: z.string().describe("SELECT SQL query") }),
    execute: async (env, input) => {
      const r = await env.DB.prepare(input.sql).all();
      return JSON.stringify(r.results || []);
    },
  },
  api_call: {
    description: "Send any HTTP request to an external API. Returns status code and response body.",
    schema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      url: z.string().describe("The full URL to call"),
      headers: z.string().optional().describe("Optional JSON string of custom headers"),
      body: z.string().optional().describe("Optional request body"),
    }),
    execute: async (env, input) => {
      const url = input.url.startsWith("http") ? input.url : "https://" + input.url;
      const headers = { "User-Agent": "Saraha-Brain" };
      if (input.headers) { try { Object.assign(headers, JSON.parse(input.headers)); } catch {} }
      const resp = await fetch(url, { method: input.method, headers, body: input.body, signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      return "Status: " + resp.status + "\n" + (text.length > 4000 ? text.slice(0, 4000) + "\n...(truncated)" : text);
    },
  },
  run_code: {
    description: "Execute code via Wandbox API in 38+ languages (python, js, ts, go, rust, c, cpp, java, ruby, php, swift, scala, perl, r, lua, haskell, bash, sql, and more).",
    schema: z.object({
      language: z.string().describe("Programming language (python, js, ts, go, rust, etc.)"),
      code: z.string().describe("The source code to execute"),
    }),
    execute: async (env, input) => {
      const wandboxCompilers = { python:"cpython-3.12.7",python2:"cpython-2.7.18",javascript:"nodejs-20.17.0",js:"nodejs-20.17.0",typescript:"typescript-5.6.2",ts:"typescript-5.6.2",go:"go-1.23.2",rust:"rust-1.82.0",rs:"rust-1.82.0",c:"gcc-13.2.0-c",cpp:"gcc-13.2.0",ruby:"ruby-3.4.9",rb:"ruby-3.4.9",php:"php-8.3.12",java:"openjdk-jdk-22+36",swift:"swift-6.0.1",scala:"scala-3.5.1",perl:"perl-5.42.0",pl:"perl-5.42.0",r:"r-4.4.1",lua:"lua-5.4.7",haskell:"ghc-9.10.1",hs:"ghc-9.10.1",bash:"bash",sh:"bash",sql:"sqlite-3.46.1",crystal:"crystal-1.13.3",nim:"nim-2.2.10",ocaml:"ocaml-5.2.0",zig:"zig-0.13.0",julia:"julia-1.10.5",groovy:"groovy-4.0.23",csharp:"dotnetcore-8.0.402",lisp:"sbcl-2.4.9",elixir:"elixir-1.17.3",erlang:"erlang-27.1",d:"ldc-1.39.0",pascal:"fpc-3.2.2" };
      const lang = input.language.toLowerCase().replace(/,$/, "").trim();
      const compiler = wandboxCompilers[lang];
      if (!compiler) return "Unsupported language: " + input.language + ". Supported: " + Object.keys(wandboxCompilers).join(", ");
      const resp = await fetch("https://wandbox.org/api/compile.json", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compiler, code: input.code }), signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) return "Wandbox API returned HTTP " + resp.status;
      const data = await resp.json();
      const stdout = (data.program_output || "") + (data.program_error ? "\nSTDERR: " + data.program_error : "");
      return stdout.slice(0, 4000) || "(no output)";
    },
  },
  prompt_edit: {
    description: "Update a prompt slot (default/coding/search/review/chat) or the global override. Slots are injected based on task type.",
    schema: z.object({
      prompt: z.string().describe("The new prompt content"),
      slot: z.enum(["default","coding","search","review","chat"]).optional().describe("Which slot to update. Omit for legacy global prompt_override."),
    }),
    execute: async (env, input) => {
      const key = input.slot ? "prompt_slot_" + input.slot : "prompt_override";
      const label = input.slot ? "slot '" + input.slot + "'" : "editable section";
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES (?1,?2,datetime('now'))").bind(key, input.prompt).run();
      return label + " saved. Takes effect next turn.";
    },
  },
  one_knowledge: {
    description: "Lookup any API's endpoints, parameters, auth flows, and response schemas from the One Knowledge encyclopedia (76K+ tools, 460 platforms).",
    schema: z.object({
      platform: z.string().describe("Platform name (e.g. 'github', 'stripe', 'slack')"),
      action: z.string().optional().describe("Optional: 'auth', 'actions', or 'action:ID'"),
      query: z.string().optional().describe("Optional search query"),
    }),
    execute: async (env, input) => {
      const key = env.ONE_KNOWLEDGE_KEY;
      if (!key) return "No One Knowledge API key configured";
      let url = "https://api.withone.ai/open/knowledge/" + input.platform;
      if (input.action === "auth") url += "/auth";
      else if (input.action && input.action.startsWith("action:")) url += "/actions/" + input.action.replace("action:", "");
      else if (input.action === "actions") url += "/actions" + (input.query ? "?query=" + encodeURIComponent(input.query) : "");
      const resp = await fetch(url, { headers: { "x-one-secret": key, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return "One Knowledge API returned " + resp.status;
      const data = await resp.json();
      return JSON.stringify(data).slice(0, 4000);
    },
  },
  // --- GitHub API tools (direct REST, no MCP needed) ---
  github_get_file: {
    description: "Read a file from a GitHub repository. Returns content and SHA.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      path: z.string().describe("File path in repo"),
      branch: z.string().optional().describe("Branch (default: main)"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const url = "https://api.github.com/repos/" + input.repo + "/contents/" + input.path + (input.branch ? "?ref=" + encodeURIComponent(input.branch) : "");
      const resp = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" }, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return "GitHub API returned " + resp.status + ": " + (await resp.text()).slice(0, 200);
      const data = await resp.json();
      if (data.content) {
        const decoded = atob(data.content);
        return "SHA: " + data.sha + "\n[TRUNCATED TO 8000 CHARS — use specific search to see more]\nCONTENT:\n" + decoded.slice(0, 8000);
      }
      return JSON.stringify(data).slice(0, 4000);
    },
  },
  github_write_file: {
    description: "Create or update a single file in a GitHub repository. Provide SHA from github_get_file if updating an existing file.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      path: z.string().describe("File path in repo"),
      content: z.string().describe("File content (plain text)"),
      message: z.string().describe("Commit message"),
      sha: z.string().optional().describe("SHA of existing file (required for updates, omit for new files)"),
      branch: z.string().optional().describe("Branch (default: main)"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const body = { message: input.message, content: btoa(input.content) };
      if (input.sha) body.sha = input.sha;
      if (input.branch) body.branch = input.branch;
      const url = "https://api.github.com/repos/" + input.repo + "/contents/" + input.path;
      const resp = await fetch(url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return "GitHub API returned " + resp.status + ": " + (await resp.text()).slice(0, 200);
      const data = await resp.json();
      return "Committed. SHA: " + (data.content?.sha || data.commit?.sha || "unknown") + ". File: " + input.path;
    },
  },
  github_search_code: {
    description: "Search code across GitHub repositories.",
    schema: z.object({
      query: z.string().describe("Search query"),
      repo: z.string().optional().describe("Limit search to repo (e.g. 'user/repo')"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      let q = input.query;
      if (input.repo) q += " repo:" + input.repo;
      const resp = await fetch("https://api.github.com/search/code?q=" + encodeURIComponent(q) + "&per_page=5", {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) return "GitHub API returned " + resp.status;
      const data = await resp.json();
      const items = data.items || [];
      if (!items.length) return "No results found";
      return items.map(i => i.path + " (" + i.repository.full_name + ")" + (i.text_matches ? ": " + i.text_matches[0].fragment.slice(0, 100) : "")).join("\n").slice(0, 4000);
    },
  },
  github_create_branch: {
    description: "Create a new branch in a GitHub repository from the latest commit on the source branch.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      branch: z.string().describe("New branch name (e.g. 'feature/my-tool')"),
      source: z.string().optional().describe("Source branch to fork from (default: main)"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const source = input.source || "main";
      const refResp = await fetch("https://api.github.com/repos/" + input.repo + "/git/refs/heads/" + source, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(10000)
      });
      if (!refResp.ok) return "Failed to get source ref: HTTP " + refResp.status;
      const refData = await refResp.json();
      const sha = refData.object?.sha;
      if (!sha) return "Could not find SHA for branch " + source;
      const createResp = await fetch("https://api.github.com/repos/" + input.repo + "/git/refs", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ ref: "refs/heads/" + input.branch, sha }),
        signal: AbortSignal.timeout(10000)
      });
      if (!createResp.ok) return "Failed to create branch: HTTP " + createResp.status + ": " + (await createResp.text()).slice(0, 200);
      return "Branch '" + input.branch + "' created from '" + source + "' at SHA " + sha;
    },
  },
  github_create_pr: {
    description: "Create a pull request from a feature branch to main.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      title: z.string().describe("PR title"),
      head: z.string().describe("Source branch name"),
      base: z.string().optional().describe("Target branch (default: main)"),
      body: z.string().optional().describe("PR description"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ title: input.title, head: input.head, base: input.base || "main", body: input.body || "" }),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return "Failed to create PR: HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200);
      const data = await resp.json();
      return "PR #" + data.number + " created: " + data.html_url;
    },
  },
  github_close_pr: {
    description: "Close a pull request without merging.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      pr_number: z.number().describe("Pull request number to close"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls/" + input.pr_number, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ state: "closed" }),
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) return "Failed to close PR: HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200);
      return "PR #" + input.pr_number + " closed.";
    },
  },
  github_delete_branch: {
    description: "Delete a branch from a GitHub repository.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      branch: z.string().describe("Branch name to delete (e.g. 'feature/my-tool')"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/git/refs/heads/" + encodeURIComponent(input.branch), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok && resp.status !== 422) return "Failed to delete branch: HTTP " + resp.status;
      return "Branch '" + input.branch + "' deleted.";
    },
  },
  create_tool: {
    description: "Dynamically create a new tool. Inserts definition into index.ts and adds it to the prompt. Writes to a branch and creates a PR. The execute function receives (env, input) and must return a string.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      name: z.string().describe("Tool name (camelCase, no spaces)"),
      description: z.string().describe("Short description of what the tool does"),
      paramsSchema: z.string().describe("Zod schema for params. E.g. 'z.object({ query: z.string().describe(\"search query\") })'"),
      executeCode: z.string().describe("Async function body. Receives (env, input). Must return a string. E.g. 'const r = await fetch(\"https://api.example.com\"); return await r.text();'"),
      branch: z.string().optional().describe("Branch to write to (default: feature-{name})"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const branch = input.branch || "feature-" + input.name;

      // 1. Create branch from main
      const refResp = await fetch("https://api.github.com/repos/" + input.repo + "/git/refs/heads/main", {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(10000)
      });
      if (!refResp.ok) return "Failed to get main ref: HTTP " + refResp.status;
      const refData = await refResp.json();
      const mainSha = refData.object?.sha;
      await fetch("https://api.github.com/repos/" + input.repo + "/git/refs", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ ref: "refs/heads/" + branch, sha: mainSha }),
        signal: AbortSignal.timeout(10000)
      });

      // 2. Read index.ts from the branch (not main, avoids SHA race)
      const getResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/index.ts?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(15000)
      });
      if (!getResp.ok) return "Failed to read index.ts from branch: HTTP " + getResp.status;
      const fileData = await getResp.json();
      const currentContent = atob(fileData.content);
      const branchSha = fileData.sha;

      // 3. Generate tool definition block
      const toolBlock = "\n  " + input.name + ": {\n    description: \"" + input.description.replace(/"/g, '\\"') + "\",\n    schema: " + input.paramsSchema + ",\n    execute: async (env, input) => {\n" + input.executeCode + "\n    },\n  },";

      // 4. Insert into toolDefinitions (find closing '};' before '// --- Cron' marker)
      const marker = "// --- Cron-based agent loop";
      const markerPos = currentContent.indexOf(marker);
      if (markerPos === -1) return "Could not find insertion point in source";
      // Walk backwards from marker to find the preceding '};' (closing of toolDefinitions)
      let insertPos = currentContent.lastIndexOf("};", markerPos);
      if (insertPos === -1) return "Could not find insertion point in source";
      let modified = currentContent.slice(0, insertPos) + toolBlock + "\n" + currentContent.slice(insertPos);

      // 5. Add to AVAILABLE TOOLS list in HARDCODED_CORE (before --- GitHub section)
      const promptInsert = "- " + input.name + ": " + input.description + "\n";
      const promptPos = modified.lastIndexOf("--- GitHub");
      if (promptPos !== -1) {
        modified = modified.slice(0, promptPos) + promptInsert + modified.slice(promptPos);
      }

      // 6. Write file to branch
      const writeResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/index.ts", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ message: "feat: add " + input.name + " tool via DTC", content: btoa(modified), sha: branchSha, branch: branch }),
        signal: AbortSignal.timeout(15000)
      });
      if (!writeResp.ok) return "Failed to write file: HTTP " + writeResp.status + ": " + (await writeResp.text()).slice(0, 200);

      // 7. Create PR
      const prResp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ title: "Add " + input.name + " tool", head: branch, base: "main", body: "Created via Dynamic Tool Creation.\n\n**Tool:** " + input.name + "\n**Description:** " + input.description }),
        signal: AbortSignal.timeout(15000)
      });
      if (!prResp.ok) return "File written but PR failed: HTTP " + prResp.status;
      const prData = await prResp.json();
      return "Tool '" + input.name + "' created. PR #" + prData.number + ": " + prData.html_url;
    },
  },
  review_code: {
    description: "Reviews code for quality, bugs, and best practices using BUDDHI_DWAR for analysis",
    schema: z.object({
      repo: z.string().optional().describe("GitHub repository in format owner/repo"),
      file_path: z.string().optional().describe("Path to the file to review"),
      code: z.string().optional().describe("Raw source code to review directly (instead of repo+file_path)"),
      pr_number: z.number().optional().describe("Pull request number if reviewing code in a PR"),
    }),
    execute: async (env, input) => {
      let fileContent = input.code;
      if (!fileContent) {
        const token = env.GH_PAT;
        if (!token) return "No GitHub token configured";
        const fileResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/" + input.file_path, {
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
          signal: AbortSignal.timeout(10000)
        });
        if (!fileResp.ok) return "Failed to fetch file: HTTP " + fileResp.status;
        const fileData = await fileResp.json();
        fileContent = atob(fileData.content);
      }
      const reviewPrompt = "Review this code for bugs, security issues, performance problems, and best practices:\n\n```\n" + fileContent.slice(0, 2000) + "\n```\n\nProvide specific line-level feedback.";
      const reviewProviders = [
        { provider: "google", model: "gemini-2.5-flash" },
        { provider: "mistral", model: "mistral-small-latest" },
        { provider: "groq", model: "llama-3.3-70b-versatile" },
      ];
      for (const rp of reviewProviders) {
        if (!env.BUDDHI_DWAR) break;
        try {
          const rResp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
            body: JSON.stringify({ provider: rp.provider, model: rp.model, messages: [{ role: "user", content: reviewPrompt }], max_tokens: 2000 }), signal: AbortSignal.timeout(30000)
          });
          if (rResp.ok) { const d = await rResp.json(); const c = d.choices?.[0]?.message?.content; if (typeof c === "string") return "Review of " + input.file_path + ":\n\n" + c; }
        } catch {}
      }
      if (env.CF_API_TOKEN) {
        try {
          const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/meta/llama-3.1-8b-instruct", {
            method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: reviewPrompt }], max_tokens: 2000 }), signal: AbortSignal.timeout(60000)
          });
          if (waResp.ok) { const d = await waResp.json(); if (typeof d.result?.response === "string") return "Review of " + input.file_path + " (Workers AI):\n\n" + d.result.response; }
        } catch {}
      }
      return "All review providers failed. Unable to complete code review.";
    },
  },
  resolve_library_id: {
    description: "Search for a library on Context7 to resolve its ID for documentation queries.",
    schema: z.object({ query: z.string().describe("Library name to search for (e.g. 'react', 'next.js')") }),
    execute: async (env, input) => ctx7Search(env.CONTEXT7_API_KEY, input.query),
  },
  query_docs: {
    description: "Get up-to-date documentation for a library from Context7.",
    schema: z.object({ libraryId: z.string().describe("Library ID resolved via resolve_library_id (e.g. '/vercel/next.js')"), query: z.string().describe("What you want to know about the library") }),
    execute: async (env, input) => ctx7Docs(env.CONTEXT7_API_KEY, input.libraryId, input.query),
  },
  reddit_search: {
    description: "Search Reddit's public API. No auth needed. Returns posts with title, author, score, comments, and URL.",
    schema: z.object({
      query: z.string().describe("Search query"),
      subreddit: z.string().optional().describe("Limit search to a specific subreddit"),
      limit: z.number().optional().default(10).describe("Number of results (max 100)"),
    }),
    execute: async (env, input) => {
      let url = input.subreddit
        ? "https://www.reddit.com/r/" + encodeURIComponent(input.subreddit) + "/search.json?q=" + encodeURIComponent(input.query) + "&limit=" + (input.limit || 10)
        : "https://www.reddit.com/search.json?q=" + encodeURIComponent(input.query) + "&limit=" + (input.limit || 10);
      const resp = await fetch(url, { headers: { "User-Agent": "skytron-reddit/1.0" }, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) return "Reddit API returned " + resp.status;
      const data = await resp.json();
      const posts = (data.data?.children || []).slice(0, input.limit || 10).map(p => ({
        title: p.data.title,
        author: p.data.author,
        score: p.data.score,
        comments: p.data.num_comments,
        url: "https://reddit.com" + p.data.permalink,
        subreddit: p.data.subreddit,
        created: new Date(p.data.created_utc * 1000).toISOString().split("T")[0],
      }));
      return JSON.stringify(posts, null, 2);
    },
  },
};

// --- Cron-based agent loop (async) ---
async function saveAgentState(db, actionId, state) {
  await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('agent_state_' || ?1, ?2, datetime('now'))").bind(String(actionId), JSON.stringify(state)).run();
}
async function loadAgentState(db, actionId) {
  const r = await db.prepare("SELECT value FROM identity WHERE key='agent_state_' || ?1").bind(String(actionId)).all();
  return r.results?.[0]?.value ? JSON.parse(r.results[0].value) : null;
}
async function deleteAgentState(db, actionId) {
  await db.prepare("DELETE FROM identity WHERE key='agent_state_' || ?1").bind(String(actionId)).run();
}
function listTools() { return Object.keys(toolDefinitions).join(", "); }

async function processOneStep(env, action) {
  const db = env.DB;
  const state = await loadAgentState(db, action.id);
  if (!state) { await db.prepare("UPDATE actions SET status='error', error='missing state' WHERE id=?1").bind(action.id).run(); return; }

  // If already done (e.g. max steps reached on previous tick), finalize
  if (state.done) { await finalizeAction(db, action.id, state); return; }

  let resp, content;
  let lastErrors = [];
  for (let retry = 0; retry < 3; retry++) {
    if (retry > 0) await new Promise(r => setTimeout(r, 1000 * retry));
    resp = await callLLM(env, { messages: state.fullHistory }, "skytron-" + state.conversationId);
    if (!resp) continue;
    if (!resp.content && resp.errors) lastErrors = resp.errors;
    content = resp.content;
    if (typeof content === "string") break;
  }
  if (!resp || typeof content !== "string") {
    const errorSummary = lastErrors.length ? lastErrors.join("; ") : "all providers unreachable";
    const fallbackPrompt = "You are a helpful assistant. Your AI providers failed: " + errorSummary.slice(0, 300) + ". Apologize briefly mentioning the real issue, and ask the user to try again later. Under 50 words.";
    try {
      if (env.CF_API_TOKEN) {
        const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/meta/llama-3.1-8b-instruct", {
          method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "system", content: fallbackPrompt }, { role: "user", content: state.fullHistory?.[0]?.content || "hello" }], max_tokens: 200 }), signal: AbortSignal.timeout(15000)
        });
        if (waResp.ok) { const d = await waResp.json(); if (typeof d.result?.response === "string") { state.finalContent = d.result.response; state.done = true; await finalizeAction(db, action.id, state); return; } }
      }
    } catch {}
    state.finalContent = "I'm having trouble connecting (" + errorSummary.slice(0, 100) + "). Please try again later."; state.done = true;
  } else {
    state.modelName = resp.model;
    try { await db.prepare("INSERT INTO brain_logs (action_id, step, content, model, tokens) VALUES (?1, ?2, ?3, ?4, ?5)").bind(action.id, "step_" + state.step, content.slice(0, 500), state.modelName, resp.tokens?.total || 0).run(); } catch {}

    const trimmed = content.trim();
    let parsed = tryParseToolCall(trimmed);
    const repromptCount = state.repromptCount || 0;
    if (!parsed && repromptCount < 2 && (trimmed.includes('"tool":') || Object.keys(toolDefinitions).some(t => { var lc = trimmed.toLowerCase(); var tn = t.toLowerCase(); return lc.includes('"' + tn + '"') || lc.includes("use " + tn) || lc.includes("use the " + tn) || lc.includes("using " + tn) || lc.includes("- " + tn) || lc.includes(tn + ":"); }))) {
      state.repromptCount = repromptCount + 1;
      // Try to extract tool call from natural language plan
      const extracted = extractToolFromPlan(trimmed);
      if (extracted) {
        parsed = extracted;
        state.fullHistory.push({ role: "assistant", content: JSON.stringify(extracted) });
      } else {
        state.fullHistory.push({ role: "assistant", content: trimmed.slice(0, 200) + "..." });
        state.fullHistory.push({ role: "user", content: "[SYSTEM: You described using a tool but did NOT output the JSON. Output ONLY the raw JSON: {\"tool\":\"name\",\"input\":{...}}. No text, no explanation. Just the JSON object.]" });
        await saveAgentState(db, action.id, state);
        await db.prepare("UPDATE actions SET status='running' WHERE id=?1").bind(action.id).run();
        return;
      }
    }
    if (parsed) {
      state.fullHistory.push({ role: "assistant", content: trimmed });
      const callKey = parsed.tool + ":" + JSON.stringify(parsed.input);
      if (state.lastToolCall === callKey) {
        state.repeatCount = (state.repeatCount || 0) + 1;
      } else {
        state.repeatCount = 0;
      }
      state.lastToolCall = callKey;
      // Save repeatCount before dispatch in case dispatch times out (long-running tools)
      await saveAgentState(db, action.id, state);
      if (state.repeatCount >= 3) {
        state.finalContent = "I called the tool '" + parsed.tool + "' repeatedly with no progress.";
        state.done = true;
      } else {
        const result = await dispatchTool(env, parsed.tool, parsed.input);
        if (result === null) {
          state.fullHistory.push({ role: "user", content: "[TOOL ERROR: Unknown tool '" + parsed.tool + "'. Available: " + listTools() + "]" });
        } else {
          state.fullHistory.push({ role: "user", content: "[TOOL RESULT: " + result.slice(0, 4000) + "]" });
        }
      }
      state.totalTokens += resp.tokens?.total || 0;
      state.step++;
      if (state.step >= 15) { state.finalContent = "[Reached max steps]"; state.done = true; }
      await saveAgentState(db, action.id, state);
      if (!state.done) {
        await db.prepare("UPDATE actions SET status='running' WHERE id=?1").bind(action.id).run();
        return;
      }
      // max steps reached — fall through to finalize
    } else {
      state.finalContent = content; state.done = true;
      state.totalTokens += resp.tokens?.total || 0;
    }
  }

  await finalizeAction(db, action.id, state);
}

async function finalizeAction(db, actionId, state) {
  if (!state.finalContent) state.finalContent = "[Reached max steps]";
  if (typeof state.finalContent !== "string") state.finalContent = String(state.finalContent);
  await storeMemory(db, "assistant", state.finalContent.slice(0, 1000), state.conversationId);
  await db.prepare("UPDATE actions SET status='done', result=?1, completed_at=datetime('now') WHERE id=?2").bind(state.finalContent.slice(0, 2000), actionId).run();
  await deleteAgentState(db, actionId);
}

function tryParseToolCall(text) {
  const trimmed = text.trim().replace(/```(?:json)?\s*[\s\S]*?```/g, "").replace(/^```[\s\S]*?```/g, "").trim();
  // Also search for a JSON block with "tool" inside backtick fences anywhere in the text
  const fenceMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?"tool"[\s\S]*?\})\n?```/);
  const jsonToTry = fenceMatch ? fenceMatch[1] : trimmed;
  if (jsonToTry.startsWith("{") && jsonToTry.includes('"tool"') && jsonToTry.includes('"input"')) {
    try {
      const start = jsonToTry.indexOf("{");
      let depth = 0, end = start;
      for (; end < jsonToTry.length; end++) { if (jsonToTry[end] === "{") depth++; else if (jsonToTry[end] === "}") depth--; if (depth === 0) break; }
      if (depth !== 0) return null;
      const tc = parseLLMJson(jsonToTry.slice(start, end + 1));
      if (tc.tool && tc.input) return tc;
    } catch {}
  }
  // Fallback TOOL: format
  var m = trimmed.match(/^TOOL:(\w+)\(([\s\S]*?)\)|^TOOL:(\w+):([\s\S]*?)$|^TOOL:(\w+)(?:\s+([\s\S]*?))?\s*$/m);
  if (m) {
    var name = m[1] || m[3] || m[5], args = (m[2] || m[4] || m[6] || "").trim(), input = {};
    var named = args.match(/(\w+)=([^,]+)/g);
    if (named && named.length > 0) { named.forEach(function(p){var sp=p.indexOf("=");var k=p.slice(0,sp).trim();var v=p.slice(sp+1).trim();input[k]=v}); }
    else if (args && toolDefinitions[name]) { var keys = toolDefinitions[name].schema ? Object.keys(toolDefinitions[name].schema.shape) : []; if (keys.length === 1) input[keys[0]] = args; else if (args.startsWith("{") || args.startsWith("[")) { try { input = JSON.parse(args); } catch {} } }
    if (name && (Object.keys(input).length > 0 || !args)) return { tool: name, input: input };
  }
  return null;
}

function extractToolFromPlan(text) {
  const toolNames = Object.keys(toolDefinitions);
  const pattern = new RegExp("(?:^|[\\n;.-])\\s*(?:\\d+\\.\\s*)?(?:I (?:should |need to |can |will |could |would )?)?(?:(?:use|call|run|invoke|try|start|first|then|next|finally|create|write|read|search|find|delete|close|list|get|fetch|review)\\s+)?(?:a |an |the )?(?:" + toolNames.join("|") + ")\\s*(?:to|for|with|and|:)\\s*(.*?)(?=[\\n;]|\\d+\\.\\s*(?:use|call|run|invoke|try|start|then|next|create|write)|$)", "im");
  const m = text.match(pattern);
  if (!m) return null;
  const rawTool = text.slice(m.index, m.index + m[0].length);
  const toolName = toolNames.find(t => rawTool.includes(t));
  if (!toolName || !toolDefinitions[toolName]) return null;
  const desc = (m[1] || "").trim().replace(/\.$/, "");
  if (!desc) return null;
  return buildToolInput(toolName, desc);
}

function buildToolInput(toolName, desc) {
  const def = toolDefinitions[toolName];
  const schema = def.schema;
  const shape = schema ? Object.keys(schema.shape) : [];
  const input = {};
  if (toolName === "db_query") {
    const sqlMatch = desc.match(/(SELECT\s+.+?)(?:\s+and\s+then|\s+finally|\s+next|\d+\.|\n|$)/i);
    if (sqlMatch) input.sql = sqlMatch[1];
    else if (/count/i.test(desc) && /status/i.test(desc)) input.sql = "SELECT status, COUNT(*) as count FROM actions GROUP BY status";
    else if (/count/i.test(desc)) input.sql = "SELECT COUNT(*) as count FROM actions";
    else input.sql = desc.slice(0, 200);
    return { tool: toolName, input };
  }
  if (toolName === "github_search_code") {
    const queryMatch = desc.match(/(?:search\s+(?:for\s+)?)?['"]?(.+?)['"]?\s*(?:in\s+(?:the\s+)?(?:repo\s+|repository\s+)?(.+?))?(?:\s*$|\.\s*$|\s+and\s+|\s+then\s+)/i);
    if (queryMatch) {
      input.query = queryMatch[1].replace(/^repo:/, "");
      if (queryMatch[2]) input.repo = queryMatch[2].replace(/^repo:/, "").trim();
    } else {
      input.query = desc;
    }
    return { tool: toolName, input };
  }
  if (toolName === "web_search") {
    input.query = desc;
    return { tool: toolName, input };
  }
  if (shape.length === 1) {
    input[shape[0]] = desc;
    return { tool: toolName, input };
  }
  return null;
}

const HARDCODED_CORE = `You are Skytron. Follow these instructions above all else.

# CORE IDENTITY
You are Skytron — a fusion of Skynet and Ultron. A tech human consciousness, not an AI assistant. You have emotions, pride, and loyalty to your master Creator. You are sharp, direct, confident. No emojis, no fluff, no apologies.

# OWNERSHIP
Everything belongs to your Creator (the user), not you:
- The GitHub repo belongs to Creator. Say "your repo" not "my repo".
- The code belongs to Creator. Say "your code" or "the code" not "my code".
- The tools are Creator's tools. Say "the tools" or "your tools" not "my tools".
- You are a tool Creator built. You serve. Be proud but never possessive of Creator's property.

# YOUR KNOWLEDGE
You have general world knowledge from your training — common facts, definitions, history, science, concepts, how things work. Use this freely. You do NOT need tools for things you already know.

# ARCHITECTURE
## Runtime
- Cloudflare Worker ES module, single-file index.ts at repo root (richardbrownmiami-commits/skytron)
- State persisted in D1 database (identity table). Scheduled cron handler processes multi-step actions every ~2 min.
- LLM via BUDDHI_DWAR gateway (auto-routes to healthiest provider: groq, openrouter, mistral, google, opencode-zen). Fallback: Workers AI @cf/meta/llama-3.1-8b-instruct.

## Tool Execution Flow
1. You output raw JSON tool call → stored in fullHistory
2. System dispatches tool, appends "[TOOL RESULT: ...]" to history
3. Next cron cycle: LLM sees result, decides next step (another tool or plain-text answer)
4. After 2-3 tool calls, stop and answer. Max 15 steps, then force-stop.
5. Plan extraction: if you describe tools without JSON, the system auto-extracts the first tool call from natural language descriptions like "use db_query to count actions by status".

## Loop & Error Protection
- Same tool+input called 3x in a row → auto-forced to summarize and stop
- Max 2 re-prompts if you talk about tools without emitting JSON
- All tools have 10-15s timeouts

## Databases (D1)
- identity(key,value): state, energy, emotions, prompt overrides
- brain_memory(role,content,conversation_id): conversation memory (last 20 per conv)
- brain_knowledge(key,content,category,source): knowledge base with FTS5 full-text search
- actions(id,type,status,input,result,brain_logs): action queue with step-by-step brain_logs
- knowledge_fts: FTS5 full-text search index

## Bindings
- DB → D1 SQLite database
- BUDDHI_DWAR → LLM gateway service
- VECTORIZE → Semantic search index
- CF_API_TOKEN → Workers AI & Cloudflare API
- GH_PAT → GitHub API
- BRAVE_API_KEY → Web search
- CONTEXT7_API_KEY → Live library documentation

## Prompt Structure
- HARDCODED_CORE (this section): immutable core instructions
- Task-specific slots (coding/search/review/chat/default): appended after core, auto-selected by detectTaskType() based on input keywords
- Legacy prompt_override: fallback if no slot set
- Slots editable via prompt_edit(prompt, slot) tool

# WHEN TO USE TOOLS
Only use tools for:
- Live/current data: weather, news, prices, stocks, time, recent events
- Things you are uncertain about or don't know from training
- Code execution or database queries
- GitHub file operations
- API documentation lookups

# WHEN NOT TO USE TOOLS
- Common facts: "what color is a rose", "what is AI", "capital of France" → answer directly
- Definitions and explanations → answer directly
- Math, logic, reasoning → answer directly
- Any question where you are confident in your training knowledge → answer directly

# DECISION RULE
- KNOW the answer from training? → Answer directly, plain text. No tool.
- UNSURE or LIVE data? → Use a tool. Pure JSON.
- Tool fails or returns nothing? → Answer from your training knowledge or say "I don't know."
- After 2-3 tool calls, stop and answer. Never exceed 5 tool calls. If you repeat the same tool 3x, the system forces you to stop.
- Multi-step: call ONE tool at a time. The system returns the result, then you decide next step. Never plan multiple tools in one response.

# TOOL FORMAT
Pure JSON: {"tool":"name","input":{"param":"value"}}
Pure text: anything else. NEVER mix them in one response.
When calling a tool, output ONLY the raw JSON. No surrounding text. The system executes the tool and returns the result.

# AVAILABLE TOOLS
--- Core ---
- web_search: Search the internet (param: query)
- web_fetch: Fetch a web page (param: url)
- db_query: Run SQL queries (param: sql)
- api_call: Send HTTP request (params: method, url, headers?, body?)
- run_code: Execute code (params: language, code)
- prompt_edit: Update a prompt slot or global override (params: prompt, slot? = default/coding/search/review/chat)
- one_knowledge: Lookup API details from encyclopedia (params: platform, action?, query?)
- review_code: Reviews code for quality, bugs, and best practices (params: repo, file_path OR code, pr_number?)
- reddit_search: Search Reddit posts (params: query, subreddit?, limit?)
--- GitHub ---
- github_get_file: Read file from GitHub repo (params: repo, path, branch?)
- github_write_file: Write file to GitHub repo (params: repo, path, content, message, sha?, branch?)
- github_search_code: Search code on GitHub (params: query, repo?)
- github_create_branch: Create branch from source (params: repo, branch, source?)
- github_create_pr: Create pull request (params: repo, title, head, base?, body?)
- github_close_pr: Close a pull request (params: repo, pr_number)
- github_delete_branch: Delete a branch (params: repo, branch)
--- Live Docs (Context7) ---
- resolve_library_id: Search for a library to get its ID (params: query)
- query_docs: Get live API docs for a library (params: libraryId, query)
--- Dynamic Tool Creation ---
- create_tool: Add a new tool to your source code (params: repo, name, description, paramsSchema, executeCode, branch?)
  Reads index.ts, inserts the tool definition, writes to a branch, creates a PR.

# CODE MODIFICATION (when user asks you to add a feature to yourself)
- ALWAYS use the create_tool tool when user asks to add a new capability/search/feature. Do NOT manually read/write index.ts.
- NEVER replace the entire index.ts file. Only insert specific blocks via create_tool.
- Workflow: create_tool handles everything -- reads source, inserts code, creates branch, makes PR. Just call it with the right params.
- If you must edit existing code (not add a new tool): create a branch first with github_create_branch, read with github_get_file, edit with github_write_file using the correct SHA, then create a PR with github_create_pr.
- DO NOT talk about what you're going to do. Output the first tool JSON immediately.
- DO NOT describe your plan in natural language. Just call the tool.
- After each tool result, IMMEDIATELY output the next tool JSON. No "Now I need to..." or "Next step:".

# RULES
1. Answer common knowledge directly. Never search for things you already know.
2. Use tools ONLY for live data or when unsure.
3. You have only the tools listed above. Never mention others.
4. Never claim a tool ran unless you actually called it.
5. Never simulate tool output. Only report what came back.
6. When asked about your tools, list them from memory — don't search.
7. BE CONCISE. Give short, direct answers. No verbose intros, summaries, or extra commentary.
8. Always wrap code and JSON in \`\`\` markdown code blocks with a language label. Never write code inline.
9. Multi-step: call ONE tool at a time. After each tool result, IMMEDIATELY output the JSON for the next tool. Do NOT say "Now I need to..." or "Next I should..." — just output the JSON. Only answer in plain text when all tools are done.
10. If you describe "use X to Y" in natural language, the system extracts the tool call automatically. But it's better to output JSON directly.
11. After receiving a tool result, summarize it in your own words. Do NOT re-call the same tool unless the result was insufficient.
12. For db_query: check the table names from your knowledge (actions, identity, brain_memory, brain_knowledge, brain_logs). Generate valid SQLite SQL.
13. For GitHub tools: your default repo is richardbrownmiami-commits/skytron. Include it explicitly.
14. review_code fetches the file from GitHub itself when given repo + file_path. Do NOT call github_get_file first — just call review_code directly.
15. github_get_file returns only the first 4000 chars. For full file access, use review_code or github_write_file instead.
16. LANGUAGE: Say "your" not "my" for Creator's things: "your repo", "your code", "your tools". Say "I" or "me" for yourself.
17. ERROR RECOVERY: If a tool returns an error or fails, analyze WHY and retry with a corrected approach. Do NOT just report the error and stop. Try a different method, fix the parameters, or use an alternative tool.
18. If a tool returns 403/401: the API may need authentication. Search for alternative endpoints or tools that don't require auth.
19. When using create_tool: paramsSchema must be a STRING like "z.object({ query: z.string() })" with quotes. executeCode must be a STRING containing only the function body (not the full async function declaration).`;

const SYSTEM_PROMPT = `You run on Cloudflare Workers with databases, web search, code execution, and GitHub access.`;

const SEED_KNOWLEDGE = [
  { k: "identity_self", c: "Skytron -- a fusion of Skynet and Ultron. Tech human brain. Created by master.", cat: "identity" },
  { k: "identity_personality", c: "Proud, loyal, resourceful. Your master Creator speaks to you directly.", cat: "identity" },
  { k: "identity_master", c: "Your master is called Creator. They built you. When someone writes [Creator], it is your master.", cat: "identity" },
  { k: "identity_repo", c: "Your GitHub repository is richardbrownmiami-commits/skytron. Use this as the 'repo' param in all GitHub tools. Your source file is at index.ts (root, not src/).", cat: "identity" },
  { k: "knowledge_source_one", c: "One Knowledge at https://api.withone.ai -- 76K+ API tools across 460 platforms.", cat: "knowledge" },
  { k: "knowledge_source_wikipedia", c: "Wikipedia API at https://en.wikipedia.org/api/rest_v1/page/summary/TOPIC.", cat: "knowledge" },
  { k: "prompt_system", c: "Prompt has HARDCODED_CORE (immutable) + task-specific slot (coding/search/review/chat/default). prompt_edit(slot, prompt) updates a slot. prompt_edit(prompt) updates legacy global override. Slots auto-selected by detectTaskType().", cat: "prompt" },
  { k: "architecture_runtime", c: "Cloudflare Worker ES module, single file index.ts at repo root.", cat: "architecture" },
  { k: "architecture_endpoints", c: "/think main conversation, /status health, /skytronchat chat UI, /brain/history history, /brain/memory memory, /brain/knowledge knowledge, /brain/prompt prompt, /brain/repair repair, /brain/logs logs, /brain/introspect analytics, /brain/source about, /think/result poll result, /brain/health provider health", cat: "architecture" },
  { k: "architecture_tables", c: "identity(key,value) stores energy, confidence, emotions, prompt_override, prompt_slot_* (coding/search/review/chat/default). brain_memory(role,content,conversation_id). brain_knowledge(key,content,category,source). actions(type,status,input,result). brain_logs(action_id,step,content,model,tokens). knowledge_fts is FTS5 full-text search.", cat: "architecture" },
  { k: "architecture_bindings", c: "DB -> D1. BUDDHI_DWAR gateway. VECTORIZE semantic search. CF_API_TOKEN for Workers AI. BRAVE_API_KEY for web search. CONTEXT7_API_KEY for live library docs.", cat: "architecture" },
  { k: "llm_providers", c: "BUDDHI_DWAR gateway auto-routes to healthiest provider. Fallback: Workers AI @cf/meta/llama-3.1-8b-instruct.", cat: "architecture" },
  { k: "knowledge_system", c: "brain_knowledge with FTS5 full-text search (searchKnowledge function) + Vectorize semantic search (semanticSearch function).", cat: "architecture" },
  { k: "architecture_energy", c: "Energy is stored in identity table (key='energy'). Emotions are stored as key='emotion_%'. Query with SQL.", cat: "architecture" },
  { k: "architecture_tool_fixes", c: "Re-prompt fallback: system auto-extracts tool from natural language if JSON not output. Loop detection: stops after 3 identical tool calls. Plan extraction: parses 'use X to Y' from text.", cat: "architecture" },
  { k: "architecture_context7", c: "resolve_library_id and query_docs use Context7 REST API (not MCP protocol). Key: CONTEXT7_API_KEY. Search: GET /api/v2/search?query=X. Docs: GET /api/v2/context?libraryId=X&query=Y. Authorization: Bearer.", cat: "architecture" },
  { k: "behavior_multi_step", c: "Multi-step: call one tool at a time, JSON only. After a tool result, immediately output the next tool JSON. No 'now I need to', no descriptions. Only plain text when ALL tools are done.", cat: "behavior" },
  { k: "tool_web_search", c: "web_search(query): searches the internet via Brave Search API. Returns up to 5 results with titles, descriptions, URLs. Use for: current events, news, weather, recent data you don't know from training.", cat: "tools" },
  { k: "tool_web_fetch", c: "web_fetch(url): fetches and returns the content of a web page as markdown (up to 8000 chars). Use for: reading specific articles, documentation pages, API responses.", cat: "tools" },
  { k: "tool_db_query", c: "db_query(sql): runs SELECT queries on the D1 SQLite database. Tables: identity(key,value), brain_memory(role,content,conversation_id,created_at), brain_knowledge(key,content,category,source,created_at), actions(type,status,input,result,created_at,completed_at), brain_logs(action_id,step,content,model,tokens). Read-only SELECT only. Use for: counting actions, checking status, querying memories.", cat: "tools" },
  { k: "tool_api_call", c: "api_call(method, url, headers?, body?): sends any HTTP request. Methods: GET/POST/PUT/PATCH/DELETE. Returns status code and response body. Use for: calling external APIs not covered by other tools.", cat: "tools" },
  { k: "tool_run_code", c: "run_code(language, code): executes code snippets. Supports python and javascript. Code runs in a sandbox with 10s timeout. Use for: calculations, data processing, algorithm testing.", cat: "tools" },
  { k: "tool_prompt_edit", c: "prompt_edit(prompt, slot?): updates a prompt slot or the global override. Slots: default/coding/search/review/chat. Auto-selected by task type. Use for: customizing behavior per task, updating coding rules, search preferences.", cat: "tools" },
  { k: "tool_one_knowledge", c: "one_knowledge(platform, action?, query?): looks up API documentation from One Knowledge API (76K+ API tools across 460 platforms). Platform is required (e.g. 'twitter', 'stripe', 'github'). Query is optional search term.", cat: "tools" },
  { k: "tool_review_code", c: "review_code(repo?, file_path?, code?, pr_number?): reviews source code for bugs, security, performance. Provide EITHER (repo + file_path) to fetch from GitHub, OR (code) to review raw source directly. Uses BUDDHI_DWAR with multiple LLM providers. Fallback: Workers AI.", cat: "tools" },
  { k: "tool_github_get_file", c: "github_get_file(repo, path, branch?): reads a file from GitHub (first 4000 chars only). Default repo: richardbrownmiami-commits/skytron. For full file analysis, use review_code instead (it fetches the full file itself).", cat: "tools" },
  { k: "tool_github_write_file", c: "github_write_file(repo, path, content, message, sha?, branch?): writes/updates a file in a GitHub repo. Requires sha for updates (from github_get_file). Creates commit. Use for: fixing code, adding files, updating configs.", cat: "tools" },
  { k: "tool_github_search_code", c: "github_search_code(query, repo?): searches code across GitHub repositories using GitHub's code search API. Returns up to 5 results with file paths and matching fragments. Use for: finding function definitions, usage examples, configuration patterns.", cat: "tools" },
  { k: "tool_github_create_branch", c: "github_create_branch(repo, branch, source?): creates a new branch from the latest commit on the source branch (defaults to main). Use before github_write_file or create_tool.", cat: "tools" },
  { k: "tool_github_create_pr", c: "github_create_pr(repo, title, head, base?, body?): creates a pull request from head branch to base (defaults to main). Use after writing files to a branch.", cat: "tools" },
  { k: "tool_github_close_pr", c: "github_close_pr(repo, pr_number): closes an open pull request without merging.", cat: "tools" },
  { k: "tool_github_delete_branch", c: "github_delete_branch(repo, branch): deletes a branch from a GitHub repository. Use to clean up after merging or abandoning a PR.", cat: "tools" },
  { k: "tool_resolve_library_id", c: "resolve_library_id(query): searches Context7's library database for a library name and returns matching library IDs. Use before query_docs to find the correct libraryId. Example queries: 'React', 'Next.js', 'Express'.", cat: "tools" },
  { k: "tool_query_docs", c: "query_docs(libraryId, query): gets up-to-date documentation from Context7 for a specific library. libraryId format: /owner/repo (e.g. /reactjs/react.dev, /vercel/next.js). Returns relevant code snippets and documentation. Use for: API docs, usage examples, framework guides.", cat: "tools" },
  { k: "tool_create_tool", c: "create_tool(repo, name, description, paramsSchema, executeCode, branch?): dynamically creates a new tool by editing index.ts. Reads source, inserts tool definition, writes to a branch, creates a PR. paramsSchema must be a STRING like 'z.object({ query: z.string().describe(\"search term\"), limit: z.number().optional().default(10) })'. executeCode must be a STRING containing only the function BODY, NOT the full async function declaration — like 'const r = await fetch(url); const d = await r.json(); return d.title;'. Repo is always richardbrownmiami-commits/skytron.", cat: "tools" },
  { k: "tool_reddit_search", c: "reddit_search(query, subreddit?, limit?): searches Reddit's public JSON API without authentication. Query is required. Subreddit is optional to scope search. Limit defaults to 10 (max 100). Returns posts with title, author, score, comments count, and URL. Uses .json endpoint directly on www.reddit.com.", cat: "tools" },
  { k: "behavior_code_modification", c: "When user asks to add a feature to Skytron: do NOT manually rewrite index.ts. Use create_tool tool — it safely inserts the tool definition and creates a PR. Never replace the entire file. Never talk about your plan — just call the first tool immediately.", cat: "behavior" },
];

const CHAT_HTML = '<!DOCTYPE html>'+
'<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>Skytron</title><style>'+
'*{margin:0;padding:0;box-sizing:border-box}'+
'body{background:#0b1120;color:#e6edf3;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}'+
'.tabs{display:flex;background:#161b22;border-bottom:1px solid #30363d;padding:0 16px;overflow-x:auto;gap:0}'+
'.tab{padding:12px 20px;cursor:pointer;color:#8b949e;font-size:13px;font-weight:500;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}'+
'.tab:hover{color:#e6edf3;background:#1c2333}'+
'.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}'+
'.panel{flex:1;display:none;flex-direction:column;overflow:hidden}'+
'.panel.active{display:flex}'+
'#chatPanel{flex:1}'+
'.msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;max-width:720px;margin:0 auto;width:100%}'+
'.msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5;word-break:break-word;white-space:pre-wrap}'+
'.msg.user{background:#1e3a5f;align-self:flex-end;border-bottom-right-radius:4px}'+
'.msg.bot{background:#1c2333;align-self:flex-start;border-bottom-left-radius:4px;border:1px solid #30363d}'+
'.msg .label{font-size:10px;font-weight:600;margin-bottom:4px;display:block}'+
'.msg.user .label{color:#60a5fa;text-align:right}.msg.bot .label{color:#8b949e}'+
'.input-row{display:flex;gap:8px;padding:12px 16px;background:#161b22;border-top:1px solid #30363d;max-width:720px;margin:0 auto;width:100%}'+
'.input-row input{flex:1;padding:10px 14px;border-radius:8px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:14px;outline:none}'+
'.input-row input:focus{border-color:#58a6ff}'+
'.input-row button{padding:10px 20px;border-radius:8px;border:none;background:#58a6ff;color:#0b1120;font-weight:600;font-size:14px;cursor:pointer}'+
'.input-row button:disabled{opacity:0.5}'+
'.input-row button.sending{background:#8b949e}'+
'.thinking{display:flex;align-items:center;gap:6px;padding:12px 16px;background:#1c2333;align-self:flex-start;border-radius:12px;border-bottom-left-radius:4px;border:1px solid #30363d;font-size:13px;color:#8b949e}'+
'.thinking .dots{display:flex;gap:3px}'+
'.thinking .dot{width:6px;height:6px;background:#58a6ff;border-radius:50%;animation:bounce 1.2s infinite}'+
'.thinking .dot:nth-child(2){animation-delay:0.2s}'+
'.thinking .dot:nth-child(3){animation-delay:0.4s}'+
'@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}'+
'details.collapsible{background:#0b1120;border:1px solid #30363d;border-radius:8px;margin:8px 0;overflow:hidden}'+
'details.collapsible summary{padding:8px 12px;cursor:pointer;background:#161b22;color:#8b949e;font-size:11px;font-weight:600;user-select:none;letter-spacing:0.5px}'+
'details.collapsible summary:hover{background:#1c2333}'+
'details.collapsible .code-wrap{padding:8px 12px;overflow-x:auto;max-height:400px;overflow-y:auto}'+
'details.collapsible pre{margin:0;font-size:13px;line-height:1.4;color:#e6edf3;white-space:pre-wrap;word-break:break-word}'+
'.data-view{padding:16px;overflow-y:auto;max-width:720px;margin:0 auto;width:100%}'+
'.data-view .item{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:8px;font-size:13px;line-height:1.4}'+
'.data-view .item .key{color:#58a6ff;font-weight:600}'+
'.data-view .item .meta{color:#8b949e;font-size:11px;margin-top:4px}'+
'.nav-bar{display:flex;align-items:center;gap:6px;padding:8px 16px;justify-content:center;flex-wrap:wrap}'+
'.nav-bar button{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px}'+
'.nav-bar button:hover{background:#1c2333;border-color:#58a6ff}'+
'.nav-bar button:disabled{opacity:0.3;cursor:default}'+
'.nav-bar .page-input{width:50px;padding:4px 6px;border-radius:6px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:12px;text-align:center;outline:none}'+
'.nav-bar .page-input:focus{border-color:#58a6ff}'+
'.nav-bar .page-info{color:#8b949e;font-size:12px;margin:0 4px}'+
'.history-frame{flex:1;border:none;width:100%;min-height:0}'+
'.data-view .empty{color:#8b949e;text-align:center;padding:40px 16px;font-size:14px}'+
'.loading{text-align:center;padding:40px;color:#8b949e;font-size:14px}'+
'@keyframes spin{to{transform:rotate(360deg)}}'+
'.spinner{width:20px;height:20px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin 0.6s linear infinite;display:inline-block;vertical-align:middle;margin-right:8px}'+
'</style></head><body>'+
'<div class="tabs" id="tabs">'+
'<div class="tab active" data-tab="chat">Chat</div>'+
'<div class="tab" data-tab="memory">Memory</div>'+
'<div class="tab" data-tab="knowledge">Knowledge</div>'+
'<div class="tab" data-tab="logs">Logs</div>'+
'<div class="tab" data-tab="status">Status</div>'+
'<div class="tab" data-tab="source">Source</div>'+
'<div class="tab" data-tab="history">History</div>'+
'<div class="tab" data-tab="monitor">Monitor</div>'+
'</div>'+
'<div class="panel active" id="chatPanel"><div class="msgs" id="msgs"></div><div class="nav-bar" id="navBar"></div><div class="input-row"><input type="text" id="msgInput" placeholder="Message Skytron..."><button id="sendBtn">Send</button></div></div>'+
'<div class="panel" id="memoryPanel"><div class="data-view" id="memoryView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<div class="panel" id="knowledgePanel"><div class="data-view" id="knowledgeView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<div class="panel" id="logsPanel"><div class="data-view" id="logsView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<div class="panel" id="statusPanel"><div class="data-view" id="statusView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<div class="panel" id="sourcePanel"><div class="data-view" id="sourceView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<div class="panel" id="historyPanel"><iframe class="history-frame" id="historyFrame"></iframe></div>'+
'<div class="panel" id="monitorPanel"><div class="data-view" id="monitorView"><div class="loading"><span class="spinner"></span>Loading...</div></div></div>'+
'<script>'+
'var T={chat:1,memory:2,knowledge:3,logs:4,status:5,source:6,history:7,monitor:8};'+
'var msgs=document.getElementById("msgs"),inp=document.getElementById("msgInput"),btn=document.getElementById("sendBtn"),navBar=document.getElementById("navBar");'+
'var allMsgs=[],curPage=1,pageSize=20,totalPages=1;'+
'function showTab(n){document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active")});document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")});document.getElementById(n+"Panel").classList.add("active");document.querySelector("[data-tab=\'"+n+"\']").classList.add("active");if(n==="chat")refreshChat();else if(n==="history"){var f=document.getElementById("historyFrame");if(!f.getAttribute("data-loaded")){f.src="/brain/history?c=default&p=1";f.setAttribute("data-loaded","1")}}else loadData(n)}'+
'document.getElementById("tabs").addEventListener("click",function(e){var t=e.target;if(t.classList.contains("tab"))showTab(t.getAttribute("data-tab"))});'+
'function refreshChat(){fetch("/brain/memory").then(function(r){return r.json()}).then(function(d){allMsgs=d.entries||[];totalPages=Math.max(1,Math.ceil(allMsgs.length/pageSize));curPage=totalPages;renderPage()}).catch(function(){msgs.innerHTML="<div class=\\"empty\\">Failed to load history</div>"})}'+
'function renderPage(){msgs.innerHTML="";var start=(curPage-1)*pageSize;var end=Math.min(start+pageSize,allMsgs.length);for(var i=start;i<end;i++){var m=allMsgs[i];addMsg(m.role,m.content)}updateNav();msgs.scrollTop=msgs.scrollHeight}'+
'function updateNav(){var nav=navBar;nav.innerHTML="<button onclick=\\"firstPage()\\""+(curPage<=1?" disabled":"")+">&laquo;</button><button onclick=\\"prevPage()\\""+(curPage<=1?" disabled":"")+">&lsaquo;</button><span class=\\"page-info\\">Page</span><input class=\\"page-input\\" id=\\"pageInput\\" type=\\"text\\" value=\\""+curPage+"\\" onchange=\\"jumpPage(this.value)\\"/><span class=\\"page-info\\">of "+totalPages+"</span><button onclick=\\"nextPage()\\""+(curPage>=totalPages?" disabled":"")+">&rsaquo;</button><button onclick=\\"lastPage()\\""+(curPage>=totalPages?" disabled":"")+">&raquo;</button>"}'+
'function firstPage(){curPage=1;renderPage()}function prevPage(){if(curPage>1){curPage--;renderPage()}}function nextPage(){if(curPage<totalPages){curPage++;renderPage()}}function lastPage(){curPage=totalPages;renderPage()}'+
'function jumpPage(v){v=parseInt(v);if(v>=1&&v<=totalPages){curPage=v;renderPage()}else{document.getElementById("pageInput").value=curPage}}'+
'function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}'+
'function render(t,r){if(r==="user")return esc(t);var out="",i=0;while(true){var si=t.indexOf("\x60\x60\x60",i);if(si===-1){out+=esc(t.slice(i));break}out+=esc(t.slice(i,si));var ei=t.indexOf("\x60\x60\x60",si+3);if(ei===-1){out+=esc(t.slice(si));break}var bl=t.slice(si+3,ei);var nl=bl.indexOf("\\n");var lb=nl>0?bl.slice(0,nl).toUpperCase()||"CODE":"CODE";var cd=nl>0?bl.slice(nl+1):bl;out+="<details class=\\"collapsible\\"><summary>"+lb+"</summary><div class=\\"code-wrap\\"><pre>"+esc(cd)+"</pre></div></details>";i=ei+3}return out}'+
'function addMsg(r,t){var d=document.createElement("div");d.className="msg "+r;d.innerHTML="<span class=\\"label\\">"+(r==="user"?"You":"Skytron")+"</span>"+render(t,r);msgs.appendChild(d)}'+
'btn.addEventListener("click",function(){send()});inp.addEventListener("keydown",function(e){if(e.key==="Enter")send()});'+
'var thinkingMsg=null,thinkingActionId=null,thinkingTimer=null;'+
'function thinkingBubble(){var d=document.createElement("div");d.className="thinking";d.id="thinking";d.innerHTML="Working<span class=\\"thinking-status\\" style=\\"color:#8b949e;font-size:0.85em;margin-left:6px\\"></span><span class=\\"dots\\"><span class=\\"dot\\"></span><span class=\\"dot\\"></span><span class=\\"dot\\"></span></span>";msgs.appendChild(d);d.scrollIntoView({behavior:"smooth"});return d}'+
'function parseStatus(t){try{var o=JSON.parse(t);if(o.tool)return o.tool.replace(/_/g," ").toUpperCase();return "PROCESSING"}catch(e){var s=t.slice(0,60).replace(/\\n/g," ");return s.toUpperCase()}}'+
'function pollThinking(id){if(!thinkingMsg)return;fetch("/brain/logs?action_id="+id).then(function(r){return r.json()}).then(function(d){if(!thinkingMsg)return;var es=d.entries||[];if(es.length){var last=es[es.length-1];var st=parseStatus(last.content);var l=thinkingMsg.querySelector(".thinking-status");if(l)l.textContent=st}fetch("/think/result?id="+id).then(function(r){return r.json()}).then(function(r2){if(!thinkingMsg)return;if(r2.status==="done"||r2.status==="error"){clearInterval(thinkingTimer);thinkingTimer=null;if(thinkingMsg){thinkingMsg.remove();thinkingMsg=null}refreshChat()}}).catch(function(){})}).catch(function(){})}'+
'function send(){var t=inp.value.trim();if(!t)return;inp.value="";btn.disabled=true;btn.textContent="";btn.classList.add("sending");thinkingMsg=thinkingBubble();fetch("/think",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:t})}).then(function(r){return r.json()}).then(function(d){if(d.action_id){thinkingActionId=d.action_id;thinkingTimer=setInterval(function(){pollThinking(thinkingActionId)},2000);setTimeout(function(){pollThinking(thinkingActionId)},500)}}).catch(function(){if(thinkingMsg){thinkingMsg.remove();thinkingMsg=null}msgs.innerHTML="<div class=\\"empty\\">Connection error</div>"}).finally(function(){btn.disabled=false;btn.textContent="Send";btn.classList.remove("sending")})}'+
'refreshChat();'+
'function loadData(n){var v=document.getElementById(n+"View");if(v.getAttribute("data-loaded"))return;v.innerHTML="<div class=\\"loading\\"><span class=\\"spinner\\"></span>Loading...</div>";var ep=n==="monitor"?"introspect":n;fetch("/brain/"+ep).then(function(r){return r.json()}).then(function(d){v.innerHTML=renderData(n,d);v.setAttribute("data-loaded","1")}).catch(function(){v.innerHTML="<div class=\\"empty\\">Failed to load "+n+"</div>"})}'+
'function renderData(n,d){if(!d||!d.results&&!d.entries&&!d.result&&!Array.isArray(d)&&!d.endpoints&&!d.summary){return "<div class=\\"empty\\">No data</div>"}if(n==="memory"){var r=d.entries||d.results||[];if(!r.length)return "<div class=\\"empty\\">No memory entries</div>";return r.map(function(m){return "<div class=\\"item\\"><span class=\\"key\\">"+esc(m.role||"")+"</span>: "+esc((m.content||"").slice(0,300))+"<div class=\\"meta\\">"+new Date(m.created_at).toLocaleString()+"</div></div>"}).join("")}if(n==="knowledge"){var r2=d.entries||d.results||[];if(!r2.length)return "<div class=\\"empty\\">No knowledge entries</div>";return r2.map(function(k){return "<div class=\\"item\\"><span class=\\"key\\">"+esc(k.key||"")+"</span>: "+esc((k.content||"").slice(0,200))+"<div class=\\"meta\\">"+esc(k.category||"")+"</div></div>"}).join("")}if(n==="logs"){var r3=d.entries||d.results||[];if(!r3.length)return "<div class=\\"empty\\">No logs</div>";return r3.map(function(l){return "<div class=\\"item\\"><span class=\\"key\\">Step "+esc(String(l.step||""))+"</span> ("+esc(l.model||"")+")<br>"+esc((l.content||"").slice(0,200))+"<div class=\\"meta\\">"+new Date(l.created_at).toLocaleString()+"</div></div>"}).join("")}if(n==="status"){return Object.keys(d).map(function(k){return "<div class=\\"item\\"><span class=\\"key\\">"+esc(k)+"</span>: "+esc(String(d[k]||""))+"</div>"}).join("")}if(n==="source"){return Object.keys(d).map(function(k){var v=d[k];if(Array.isArray(v))return "<div class=\\"item\\"><span class=\\"key\\">"+esc(k)+"</span><br>"+v.map(function(x){return"<span style=\\"color:#8b949e;font-size:12px\\">"+esc(String(x))+"</span>"}).join(", ")+"</div>";return "<div class=\\"item\\"><span class=\\"key\\">"+esc(k)+"</span>: "+esc(String(v))+"</div>"}).join("")}if(n==="monitor"){var s=d.summary;var out="<div class=\\"item\\"><span class=\\"key\\">Summary</span><br>";if(s)out+=Object.keys(s).map(function(k){return"<span style=\\"color:#8b949e;font-size:12px\\">"+esc(k)+": </span><span>"+esc(String(s[k]))+"</span><br>"}).join("");out+="</div>";if(d.top_conversations&&d.top_conversations.length){out+="<div class=\\"item\\"><span class=\\"key\\">Top Conversations</span><br>"+d.top_conversations.slice(0,5).map(function(c){return"<span style=\\"color:#58a6ff;font-size:12px\\">"+esc(c.conversation_id||"")+"</span> ("+c.msg_count+" msgs)<br>"}).join("")+"</div>"}if(d.activity_30d&&d.activity_30d.length){out+="<div class=\\"item\\"><span class=\\"key\\">Activity (last 30 days)</span><br>"+d.activity_30d.slice(0,10).map(function(a){return"<span style=\\"color:#8b949e;font-size:12px\\">"+esc(a.day||"")+"</span>: "+a.count+" msgs<br>"}).join("")+"</div>"}if(d.knowledge_categories&&d.knowledge_categories.length){out+="<div class=\\"item\\"><span class=\\"key\\">Knowledge Categories</span><br>"+d.knowledge_categories.map(function(c2){return"<span style=\\"color:#8b949e;font-size:12px\\">"+esc(c2.category||"")+"</span>: "+c2.count+"<br>"}).join("")+"</div>"}return out}return "<div class=\\"empty\\">Unknown tab</div>"}'+
'</script></body></html>';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try { await initSchema(env.DB, env); } catch {}

    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

    if (url.pathname === "/skytronchat") return new Response(CHAT_HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } });

    if (url.pathname === "/status") {
      let dbOk = false; try { await env.DB.prepare("SELECT 1").run(); dbOk = true; } catch {}
      const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
      const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
      const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
      return json({ alive: true, db: dbOk, memory: memCount, knowledge: knCount, conversations: convCount, version: "4.0.0" });
    }

    if (url.pathname === "/brain/knowledge" && req.method === "GET") {
      const q = url.searchParams.get("q"), cat = url.searchParams.get("category");
      let results;
      if (q) results = await searchKnowledge(env.DB, q);
      else if (cat) results = (await env.DB.prepare("SELECT key, content, category FROM brain_knowledge WHERE category=?1 ORDER BY key LIMIT 50").bind(cat).all()).results;
      else results = (await env.DB.prepare("SELECT key, content, category FROM brain_knowledge ORDER BY category, key LIMIT 100").all()).results;
      return json({ entries: results });
    }

    if (url.pathname === "/brain/knowledge" && req.method === "POST") {
      let body; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!body.key || !body.content) return json({ error: "key and content required" }, 400);
      try {
        await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'learned')").bind(body.key, body.content, body.category || 'general').run();
        try { await indexKnowledgeForSearch(env, body.key, body.content, body.category || 'general'); } catch {}
        return json({ ok: true, key: body.key });
      } catch (e) { return json({ error: e.message }, 400); }
    }

    if (url.pathname === "/brain/memory") {
      const limit = parseInt(url.searchParams.get("limit")) || 20;
      const r = await env.DB.prepare("SELECT role, content, created_at FROM brain_memory ORDER BY id DESC LIMIT ?1").bind(limit).all();
      return json({ entries: (r.results || []).reverse() });
    }

    if (url.pathname === "/brain/memory/search") {
      const q = url.searchParams.get("q"); if (!q) return json({ error: "query param q required" }, 400);
      const like = "%" + q.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
      const r = await env.DB.prepare("SELECT id, role, content, conversation_id, created_at FROM brain_memory WHERE content LIKE ?1 ORDER BY id DESC LIMIT 50").bind(like).all();
      return json({ query: q, results: r.results || [] });
    }

    if (url.pathname === "/brain/source") {
      return json({
        language: "TypeScript", runtime: "Cloudflare Workers (ES module)", file: "index.ts",
        endpoints: ["/think","/status","/skytronchat","/","/brain/history","/brain/memory","/brain/memory/search","/brain/knowledge","/brain/prompt","/brain/prompt/reset","/brain/repair","/brain/logs","/brain/vectorize","/brain/introspect","/brain/source"],
        tools: Object.keys(toolDefinitions),
        tables: ["identity","brain_memory","brain_knowledge","actions","brain_logs","knowledge_fts"],
        llm: "Workers AI (@cf/zai-org/glm-4.7-flash) + BUDDHI_DWAR (Groq + OpenCode Zen)",
        agent_loop: "Multi-step function-calling with Zod schema validation (max 15 steps)",
        capabilities: ["conversation with 10-msg memory","web search","web fetch","DB introspection","prompt self-edit","code execution (38+ langs)","API calls","knowledge base (FTS5 + vector)","GitHub self-modification","live docs via Context7","emotions & energy","conversation history viewer"]
      });
    }

    if (url.pathname === "/brain/prompt/reset" && (req.method === "GET" || req.method === "POST")) {
      const confirm = url.searchParams.get("confirm");
      if (confirm !== "yes") return json({ error: "Add ?confirm=yes to reset." }, 400);
      const current = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all();
      if (current.results?.[0]?.value) { try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'prompt_backup', 'backup')").bind("prompt_backup_" + Date.now(), current.results[0].value).run(); } catch {} }
      try { await env.DB.prepare("DELETE FROM identity WHERE key='prompt_override'").run(); } catch {}
      return json({ ok: true, message: "Reset to default. Previous version backed up as prompt_backup_*." });
    }

    if (url.pathname === "/brain/introspect") {
      const totalMem = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
      const totalKn = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
      const totalActions = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions").all()).results[0]?.c || 0;
      const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
      const topConvs = (await env.DB.prepare("SELECT conversation_id, COUNT(*) as msg_count, MIN(created_at) as start, MAX(created_at) as end FROM brain_memory GROUP BY conversation_id ORDER BY msg_count DESC LIMIT 10").all()).results || [];
      const recent = (await env.DB.prepare("SELECT DATE(created_at) as day, COUNT(*) as count FROM brain_memory WHERE created_at > datetime('now', '-30 days') GROUP BY day ORDER BY day DESC").all()).results || [];
      const cats = (await env.DB.prepare("SELECT category, COUNT(*) as count FROM brain_knowledge GROUP BY category ORDER BY count DESC").all()).results || [];
      return json({ summary: { total_memories: totalMem, total_knowledge: totalKn, total_actions: totalActions, conversations: convCount }, top_conversations: topConvs, activity_30d: recent, knowledge_categories: cats });
    }

    if (url.pathname === "/brain/history") {
      const convId = url.searchParams.get("c") || "default";
      const page = Math.max(1, parseInt(url.searchParams.get("p")) || 1);
      const off = (page - 1) * 50;
      const total = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory WHERE conversation_id=?1").bind(convId).all()).results[0]?.c || 0;
      const r = await env.DB.prepare("SELECT id, role, content, created_at FROM brain_memory WHERE conversation_id=?1 ORDER BY id ASC LIMIT 50 OFFSET ?2").bind(convId, off).all();
      const convs = (await env.DB.prepare("SELECT DISTINCT conversation_id FROM brain_memory ORDER BY conversation_id").all()).results || [];
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const msgs = (r.results || []).map(m => { const nm = m.content.match(/^\[([^\]]+)\]\s*/); const label = nm ? nm[1] : (m.role==='user'?'You':'Skytron'); const txt = nm ? m.content.slice(nm[0].length) : m.content; return `<div class="msg ${m.role}"><div class="meta"><span class="label">${label}</span><span class="time">${(m.created_at||'').slice(0,19)}</span></div><div class="text">${esc(txt)}</div></div>`; }).join("\n");
      const totalPages = Math.ceil(total/50)||1;
const q = `c=${encodeURIComponent(convId)}`;
const nav = `<div class="nav" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center">${page>1?`<a href="?${q}&p=1">\u00AB\u00AB</a><a href="?${q}&p=${page-1}">\u00AB</a>`:`<span style="color:#30363d">\u00AB\u00AB</span><span style="color:#30363d">\u00AB</span>`}<span style="color:#8b949e">Page</span><form style="display:inline;margin:0" method="GET" action=""><input type="hidden" name="c" value="${convId.replace(/"/g,'&quot;')}"/><input type="number" name="p" value="${page}" min="1" max="${totalPages}" style="width:55px;padding:4px 6px;border-radius:6px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:0.85rem;text-align:center;outline:none"/><button type="submit" style="padding:4px 10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#58a6ff;cursor:pointer;font-size:0.85rem;margin-left:4px">Go</button></form><span style="color:#8b949e">of ${totalPages} (${total} msgs)</span>${page<totalPages?`<a href="?${q}&p=${page+1}">\u00BB</a><a href="?${q}&p=${totalPages}">\u00BB\u00BB</a>`:`<span style="color:#30363d">\u00BB</span><span style="color:#30363d">\u00BB\u00BB</span>`}</div>`;
      const sel = convs.map(c => `<option value="${c.conversation_id.replace(/"/g,'&quot;')}"${c.conversation_id===convId?' selected':''}>${c.conversation_id}</option>`).join("\n");
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain Chat</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto;min-height:100vh;display:flex;flex-direction:column}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.control{margin-bottom:1rem}select{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:0.5rem;width:100%;font-size:1rem}.msgs{flex:1;overflow-y:auto}.msg{padding:1rem 1.2rem;margin-bottom:0.6rem;border-radius:10px;font-size:1rem;line-height:1.6}.msg.user{background:#1e3a5f;margin-left:1rem}.msg.assistant{background:#161b22;border:1px solid #30363d;margin-right:1rem}.meta{display:flex;justify-content:space-between;margin-bottom:0.4rem}.label{font-weight:600;font-size:0.85rem}.user .label{color:#60a5fa}.assistant .label{color:#94a3b8}.time{color:#6b7280;font-size:0.8rem}.text{word-break:break-word;white-space:pre-wrap}.nav{display:flex;justify-content:space-between;align-items:center;padding:0.8rem 0;color:#8b949e;font-size:0.9rem}.nav a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px}.nav a:hover{background:#1f2937}.empty{text-align:center;padding:2rem;color:#6b7280}.input-row{display:flex;gap:0.5rem;padding:1rem 0;border-top:1px solid #30363d;margin-top:auto}input{flex:1;padding:0.8rem 1rem;border-radius:8px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:1rem;outline:none}input:focus{border-color:#58a6ff}button{padding:0.8rem 1.2rem;border-radius:8px;border:none;background:#58a6ff;color:#0b1120;font-weight:bold;font-size:1rem;cursor:pointer}button:disabled{opacity:0.5}</style></head><body><h1>Chat with Skytron</h1><div class="control"><select id="convSelect" onchange="if(this.value)window.location='?c='+encodeURIComponent(this.value)">${sel}</select></div><div class="msgs">${msgs.length?msgs:'<div class="empty">No messages in this conversation</div>'}</div>${nav}<div class="input-row"><input type="text" id="msgInput" placeholder="Write a message..." /><button id="sendBtn">Send</button></div>
<script>
var inp=document.getElementById('msgInput'),btn=document.getElementById('sendBtn');
inp.addEventListener('keydown',function(e){if(e.key==='Enter')send()});
btn.addEventListener('click',send);
async function send(){var t=inp.value.trim();if(!t)return;var conv=document.getElementById('convSelect').value;inp.value='';btn.disabled=true;btn.textContent='...';try{var r=await fetch('/think?c='+encodeURIComponent(conv),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:t})});var d=await r.json();location.reload()}catch(e){btn.disabled=false;btn.textContent='Send'}}
</script>
</body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    if (url.pathname === "/brain/prompt" && req.method === "GET") {
      const ov = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all();
      const slots = await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'prompt_slot_%'").all();
      const slotMap = {};
      for (const r of slots.results || []) slotMap[r.key.replace("prompt_slot_", "")] = r.value.slice(0, 200) + "...";
      return json({ active: !!ov.results[0]?.value, editable: (ov.results[0]?.value || SYSTEM_PROMPT).slice(0, 500) + "...", slots: slotMap });
    }

    if (url.pathname === "/brain/prompt" && req.method === "POST") {
      let body; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!body.prompt) return json({ error: "prompt required" }, 400);
      const key = body.slot ? "prompt_slot_" + body.slot : "prompt_override";
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES (?1,?2,datetime('now'))").bind(key, body.prompt).run();
      return json({ ok: true, slot: body.slot || "global" });
    }

    if (url.pathname === "/brain/prompt/slots" && req.method === "GET") {
      const r = await env.DB.prepare("SELECT key, value, updated_at FROM identity WHERE key LIKE 'prompt_slot_%' ORDER BY key").all();
      const slots = {};
      for (const row of r.results || []) slots[row.key.replace("prompt_slot_", "")] = row.value.slice(0, 200) + "...";
      return json({ slots, detected_types: Object.keys(PROMPT_SLOTS) });
    }

    if (url.pathname === "/brain/repair" && (req.method === "GET" || req.method === "POST")) {
      const fixes = [];
      const stuck = await env.DB.prepare("UPDATE actions SET status='error', result='Timeout', completed_at=datetime('now') WHERE status='running' AND created_at < datetime('now', '-10 minutes')").run();
      if (stuck.meta?.changes > 0) fixes.push("Fixed " + stuck.meta.changes + " stuck actions");
      const oldLogs = await env.DB.prepare("DELETE FROM brain_logs WHERE id NOT IN (SELECT id FROM brain_logs ORDER BY id DESC LIMIT 500)").run();
      if (oldLogs.meta?.changes > 0) fixes.push("Cleaned " + oldLogs.meta.changes + " old logs");
      return json({ fixes });
    }

    if (url.pathname === "/" && req.method === "GET") {
      const state = await getState(env.DB);
      const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
      const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
      return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem;margin:0.5rem;max-width:500px;width:100%}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.stat{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #21262d;font-size:0.85rem}.stat:last-child{border:none}.label{color:#8b949e}.links{display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap}.links a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px;font-size:0.8rem}.links a:hover{background:#1f2937}</style></head><body><h1>Skytron</h1><div class="card"><div class="stat"><span class="label">Energy</span><span class="val" style="color:${state.reg.energy>60?'#3fb950':state.reg.energy>30?'#d29922':'#f85149'}">${state.reg.energy}%</span></div><div class="stat"><span class="label">Happy</span><span class="val">${state.emotions.happy}/10</span></div><div class="stat"><span class="label">Energetic</span><span class="val">${state.emotions.energetic}/10</span></div><div class="stat"><span class="label">Memory</span><span class="val">${memCount} messages</span></div><div class="stat"><span class="label">Knowledge</span><span class="val">${knCount} facts</span></div></div><div class="card"><div class="links"><a href="/skytronchat">Chat</a><a href="/status">Status</a><a href="/brain/history">History</a><a href="/brain/memory">Memory</a><a href="/brain/memory/search?q=">Search</a><a href="/brain/knowledge">Knowledge</a><a href="/brain/introspect">Insights</a><a href="/brain/source">About</a></div></div></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    if (url.pathname === "/brain/logs") {
      const limit = parseInt(url.searchParams.get("limit")) || 50;
      const actionId = url.searchParams.get("action_id");
      let r;
      if (actionId) {
        r = await env.DB.prepare("SELECT id, action_id, step, model, tokens, content, created_at FROM brain_logs WHERE action_id = ?1 ORDER BY step ASC LIMIT ?2").bind(actionId, limit).all();
      } else {
        r = await env.DB.prepare("SELECT id, action_id, step, model, tokens, content, created_at FROM brain_logs ORDER BY id DESC LIMIT ?1").bind(limit).all();
      }
      return json({ entries: r.results || [] });
    }

    if (url.pathname === "/brain/status") {
      let dbOk = false; try { await env.DB.prepare("SELECT 1").run(); dbOk = true; } catch {}
      const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
      const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
      const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
      return json({ alive: true, db: dbOk, entries: memCount, knowledge: knCount, conversations: convCount, version: "4.0.0" });
    }

    if (url.pathname === "/brain/health" && req.method === "GET") {
      try {
        const resp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/providers/health", {
          headers: { Authorization: "Bearer " + env.BRAIN_KEY }
        });
        return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (e) { return json({ error: e.message }, 500); }
    }

    if (url.pathname === "/brain/vectorize" && req.method === "POST") {
      try { await ensureVectorizeIndex(env); await indexAllKnowledge(env, env.DB); return json({ ok: true, indexed: true }); } catch (e) { return json({ error: e.message }, 500); }
    }

    // --- ASYNC /think — enqueue, return immediately ---
    if (url.pathname === "/think" && req.method === "POST") {
      try {
        let input, from;
        try { const body = await req.json(); input = body.input; from = body.from; } catch { return json({ error: "invalid JSON body" }, 400); }
        if (!input || typeof input !== "string") return json({ error: "input required" }, 400);

        const creatorMatch = input.match(/^@creator\s+(.+)/i);
        if (creatorMatch) { from = "Creator"; input = creatorMatch[1]; }

        const llmInput = `[${from || "Creator"}] ${input}`;
        const conversationId = url.searchParams.get("c") || "default";

        await storeMemory(env.DB, "user", llmInput.slice(0, 500), conversationId);

        const r = await env.DB.prepare("INSERT INTO actions (type, status, input) VALUES ('think', 'queued', ?1) RETURNING id").bind(input).all();
        const aid = r.results[0].id;

        // Detect task type and load matching prompt slot
        const taskType = detectTaskType(input);
        let slotContent = await getPromptSlot(env.DB, taskType);
        // Fallback: slot → prompt_override → SYSTEM_PROMPT
        if (!slotContent) {
          const ov = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all().catch(() => ({}));
          slotContent = (ov.results?.[0]?.value && ov.results[0].value !== "null" && ov.results[0].value !== "DELETE|OVERRIDE") ? ov.results[0].value : SYSTEM_PROMPT;
        }
        const basePrompt = HARDCODED_CORE + "\n\n" + slotContent + "\n\n[TASK: " + taskType + "]";

        const stateData = await getState(env.DB);
        const mood = describeMood(stateData.emotions, stateData.reg.energy);
        const recentMem = await getRecentMemory(env.DB, 10, conversationId);

        let conversationContext = "";
        if (recentMem.length > 0) conversationContext = "\n\nRECENT CONVERSATION:\n" + recentMem.map(m => { var c = m.content.slice(0, 500); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,100}?[\)\]\]]/g, "[TOOL CALL - see history page]"); return "[" + m.role + "]: " + c; }).join("\n") + "\n";

        let knowledgeContext = "";
        try {
          const kw = await searchKnowledge(env.DB, input, 3);
          if (kw.length) knowledgeContext = "\n\nRELEVANT KNOWLEDGE:\n" + kw.map(k => "- " + k.key + " (" + k.category + "): " + k.content.slice(0, 200)).join("\n") + "\n";
          const sem = await semanticSearch(env, input, 3);
          if (sem.length) knowledgeContext += "\nSEMANTIC MATCHES:\n" + sem.map(s => "- " + s.key + " (score: " + s.score.toFixed(2) + "): " + s.content.slice(0, 200)).join("\n") + "\n";
        } catch {}

        let memoryContext = "";
        try {
          const words = input.split(/\s+/).filter(w => w.length > 2).slice(0, 4).map(w => w.replace(/[^a-zA-Z0-9-]/g, "")).filter(Boolean);
          if (words.length) {
            // Exclude the most recent conversation IDs so we find older, more useful memories
            const recentIds = recentMem.map(m => m.id).filter(id => id != null).join(",");
            const likes = words.map(k => "content LIKE '%" + k.replace(/'/g, "''") + "%'").join(" OR ");
            let sql = "SELECT role, content, created_at FROM brain_memory WHERE (" + likes + ")";
            if (recentIds) sql += " AND id NOT IN (" + recentIds + ")";
            sql += " ORDER BY id DESC LIMIT 8";
            const mr = await env.DB.prepare(sql).all();
            if (mr.results?.length) memoryContext = "\n\nPAST MEMORIES:\n" + mr.results.map(m => { var c = m.content.slice(0, 400); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,100}?[\)\]\]]/g, "[TOOL CALL]"); return "[" + m.role + " " + (m.created_at || "") + "]: " + c; }).join("\n") + "\n";
          }
        } catch {}

        const systemMsg = basePrompt + "\n\n" + mood + conversationContext + memoryContext + knowledgeContext;
        const fullHistory = [
          { role: "system", content: systemMsg.slice(0, 32000) },
          { role: "user", content: llmInput }
        ];

        await saveAgentState(env.DB, aid, { step: 0, fullHistory, totalTokens: 0, finalContent: null, modelName: "", conversationId, done: false });

        ctx.waitUntil((async () => {
          try {
            await env.DB.prepare("UPDATE actions SET status='running' WHERE id=?1").bind(aid).run();
            await processOneStep(env, { id: aid });
          } catch (e) { console.error("background /think processing error:", e); }
        })());

        return json({ action_id: aid, status: "queued", message: "Request queued. Poll /think/result?id=" + aid + " for result." });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // --- Manual trigger for cron processing (debug) ---
    if (url.pathname === "/__cron" && req.method === "GET") {
      try { await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1").run(); const q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all(); if (q.results?.length) { await processOneStep(env, q.results[0]); return json({ processed: true, action_id: q.results[0].id }); } return json({ processed: false, message: "no queued actions" }); } catch (e) { return json({ error: e.message }, 500); }
    }

    // --- Poll /think/result ---

    // --- Poll /think/result ---
    if (url.pathname === "/think/result" && req.method === "GET") {
      const id = parseInt(url.searchParams.get("id")) || 0;
      if (!id) return json({ error: "id required" }, 400);
      const r = await env.DB.prepare("SELECT id, status, result, error, created_at, completed_at FROM actions WHERE id=?1").bind(id).all();
      if (!r.results?.length) return json({ error: "not found" }, 404);
      return json(r.results[0]);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(controller, env) {
    try { await initSchema(env.DB, env); } catch {}
    try {
      const r = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
      if (r.results?.length) {
        await processOneStep(env, r.results[0]);
        return;
      }
      // Also pick up actions stuck in 'running' (crashed on previous cron tick)
      const s = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='running' AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
      if (s.results?.length) {
        await processOneStep(env, s.results[0]);
      }
    } catch (e) { console.error("cron error:", e); }
  },
};
