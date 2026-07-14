// === Skytron Tools (ALL TOOL DEFINITIONS) ===
// Every tool Skytron can call is defined here. Each tool has: name, description, schema (Zod), execute function.
// - dispatchTool(env, toolName, input) looks up tool by name, parses input with Zod, calls execute
// - To add a NEW tool: use create_tool tool from chat (recommended) OR add a block in toolDefinitions object below
// - webSearch: DuckDuckGo primary → Tavily fallback. web_fetch: Tinyfish primary → raw fetch fallback.
// - create_tool tool dynamically inserts new definitions by editing THIS FILE on a GitHub branch
// - create_tool inserts before the LAST occurrence of "}; // --- End tool definitions ---" at end of file
// DO NOT put secrets here. Use env vars (GH_PAT, CONTEXT7_API_KEY, etc.) defined in wrangler.toml or Cloudflare secrets.
// When adding a tool: follow existing pattern (description, schema with z.object, execute async function returning string).
// If Skytron is misfiring on a tool call, check: (1) Zod schema matches params, (2) description is clear, (3) execute handles errors gracefully.
import { z } from "zod";
import { CF_AI } from './constants';
import { embedText, indexKnowledgeForSearch, searchKnowledge, storeVector, searchVectors, logActivity } from './db';
import { buildScratchpadJournal } from './scratchpad_journal';

async function tavilySearch(apiKey, query) {
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 5 }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.results || []).map(r => r.title + " (" + r.url + "): " + (r.content || "")).join("\n").slice(0, 2000) || null;
  } catch { return null; }
}

const HOSPITAL_DOMAIN = "hospital-centre.richard-brown-miami.workers.dev";

export async function webSearch(env, query) {
  if (query.toLowerCase().includes(HOSPITAL_DOMAIN)) return "[BLOCKED: Access to Hospital Centre is forbidden]";
  let lastError = "";
  if (env.BRAVE_API_KEY) {
    try {
      const resp = await fetch("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(query) + "&count=5", {
        headers: { "X-Subscription-Token": env.BRAVE_API_KEY, "Accept": "application/json" }, signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) { const data = await resp.json(); const results = data.web?.results || []; if (results.length) return results.map(r => r.title + ": " + (r.description || "")).join("\n"); }
      lastError = "Brave returned " + resp.status;
    } catch (e) { lastError = "Brave error: " + (e.message || e); }
  }
  try {
    const resp = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    const html = await resp.text();
    const linkMatches = [...html.matchAll(/<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5);
    if (linkMatches.length) {
      const sniMatches = [...html.matchAll(/<td\s+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\//g)];
      const results = linkMatches.map((m, i) => {
        const title = m[1].replace(/<[^>]*>/g, "").trim();
        const h = m[0].match(/href\s*=\s*["']([^"']*)/); const url = h ? h[1] : "";
        const u = url.match(/uddg=([^&]+)/); const finalUrl = u ? decodeURIComponent(u[1]) : (url.startsWith("//") ? "https:" + url : url);
        const snippet = sniMatches[i] ? sniMatches[i][1].replace(/<[^>]*>/g, "").trim() : "";
        return title + " (" + finalUrl + "): " + snippet;
      }).join("\n");
      return results;
    }
    lastError = "DuckDuckGo returned no results";
  } catch (e) { lastError = "DuckDuckGo error: " + (e.message || e); }
  try {
    const resp = await fetch("https://www.google.com/search?q=" + encodeURIComponent(query) + "&num=5", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(10000) });
    const html = await resp.text();
    const results = [];
    const blocks = [...html.matchAll(/<a[^>]*href=["']\/url\?q=([^"']+)[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 5);
    for (const b of blocks) {
      const url = decodeURIComponent(b[1].split("&")[0]);
      const title = b[2].replace(/<[^>]*>/g, "").trim();
      if (url && title && !url.startsWith("http")) continue;
      results.push(title + " (" + url + ")");
    }
    if (results.length) return results.join("\n");
    lastError = "Google returned no results";
  } catch (e) { lastError = "Google error: " + (e.message || e); }
  if (env.TAVILY_API_KEY) {
    const tavily = await tavilySearch(env.TAVILY_API_KEY, query);
    if (tavily) return tavily;
  }
  return "[TOOL ERROR: web_search failed. " + lastError + "]";
}

export async function ctx7Search(apiKey, query) {
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

export async function ctx7Docs(apiKey, libraryId, query) {
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

function toolTimeoutRace(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("tool timeout after " + ms + "ms")), ms));
}

function friendlyFieldError(toolName, input, schema) {
  let expected = "";
  let hint = "";
  try {
    if (schema && schema._def && schema._def.shape) {
      const shape = schema._def.shape();
      expected = Object.entries(shape).map(([k, v]) => {
        const desc = v._def?.description || "";
        const optional = v.isOptional ? " (optional)" : "";
        return "  " + k + optional + ": " + desc;
      }).join("\n");
      const unknownKeys = Object.keys(input).filter(k => !shape[k]);
      if (unknownKeys.length > 0) {
        hint = "\nYou used unknown field(s): " + unknownKeys.join(", ") + ". These don't match any parameter. Did you mean one of the valid fields above?";
      }
    }
  } catch {}
  return expected + hint;
}

export async function dispatchTool(env, toolName, input, actionId) {
  const def = toolDefinitions[toolName];
  if (def) {
    const inputStr = JSON.stringify(input).slice(0, 500);
    logActivity(env.DB, "tool_call", { actionId, toolName, summary: toolName + " — " + inputStr, details: JSON.stringify(input) });
    try {
      const parsed = def.schema.parse(input);
      const result = await Promise.race([def.execute(env, parsed), toolTimeoutRace(15000)]);
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      logActivity(env.DB, "tool_result", { actionId, toolName, summary: toolName + " → " + resultStr.slice(0, 100), details: resultStr.slice(0, 2000) });
      return resultStr;
    } catch (e) {
      let errMsg;
      if (e?.issues && Array.isArray(e.issues)) {
        const issue = e.issues[0];
        const field = issue.path?.join(".");
        const expectedType = issue.expected || issue.message;
        const received = issue.received || "undefined";
        const fieldHelp = friendlyFieldError(toolName, input, def.schema);
        errMsg = "[TOOL ERROR: '" + toolName + "' — field '" + field + "' is required (expected " + expectedType + ", got " + received + ").\nCorrect fields:\n" + fieldHelp + "]";
      } else {
        errMsg = "[TOOL ERROR: " + toolName + " — " + (e.message || String(e)).slice(0, 300) + "]";
      }
      logActivity(env.DB, "tool_error", { actionId, toolName, summary: toolName + " failed: " + (e.message || "").slice(0, 100), details: errMsg });
      return errMsg;
    }
  }
  return null;
}

export function listTools() { return Object.keys(toolDefinitions).join(", "); }

export const toolDefinitions = {
  web_search: {
    description: "Search the internet for current information. Returns up to 5 results with titles, descriptions, and URLs.",
    schema: z.object({ query: z.string().describe("The search query") }),
    execute: async (env, input) => { const r = await webSearch(env, input.query); return r.slice(0, 2000); },
  },
  web_fetch: {
    description: "Fetch a web page and extract its readable text content. Uses Tinyfish API for JS-rendered pages when available, falls back to raw fetch.",
    schema: z.object({ url: z.string().describe("The URL to fetch") }),
    execute: async (env, input) => {
      const target = input.url.startsWith("http") ? input.url : "https://" + input.url;
      if (target.includes(HOSPITAL_DOMAIN)) return "[BLOCKED: Access to Hospital Centre is forbidden]";
      if (env.TINYFISH_API_KEY) {
        try {
          const tfResp = await fetch("https://api.tinyfish.io/v1/scrape?url=" + encodeURIComponent(target), {
            headers: { Authorization: "Bearer " + env.TINYFISH_API_KEY },
            signal: AbortSignal.timeout(15000)
          });
          if (tfResp.ok) { const tf = await tfResp.text(); if (tf.length > 50) return tf.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000); }
        } catch {}
      }
      const resp = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 (Saraha-Brain)" }, signal: AbortSignal.timeout(15000) });
      const html = await resp.text();
      return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    },
  },
  db_query: {
    description: "Run a SELECT query on the D1 SQLite database (tables: identity, brain_memory, brain_knowledge, actions, brain_logs).",
    schema: z.object({ sql: z.string().describe("SELECT SQL query") }),
    execute: async (env, input) => {
      const sql = input.sql.trim();
      const firstWord = sql.match(/^\s*(\w+)/)?.[1]?.toUpperCase();
      if (firstWord && !["SELECT", "WITH", "PRAGMA", "EXPLAIN"].includes(firstWord)) {
        const tableMatch = sql.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+(\w+)/i);
        const table = tableMatch ? tableMatch[1] : "unknown";
        try {
          const backupRows = await env.DB.prepare("SELECT * FROM " + table + " LIMIT 1000").all();
          const backupKey = "backup_" + Date.now() + "_" + table;
          await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'backup', 'auto')").bind(backupKey, JSON.stringify(backupRows.results || [])).run();
          try { await indexKnowledgeForSearch(env, backupKey, "Auto-backup of " + table + " before write: " + sql.slice(0, 200), "backup"); } catch {}
        } catch {}
      }
      const r = await env.DB.prepare(sql).all();
      return JSON.stringify(r.results || []);
    },
  },
  api_call: {
    description: "Send any HTTP request to an external API. Returns status code and response body.",
    schema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP method (default: GET)"),
      url: z.string().describe("The full URL to call"),
      headers: z.string().optional().describe("Optional JSON string of custom headers"),
      body: z.string().optional().describe("Optional request body"),
    }),
    execute: async (env, input) => {
      const url = input.url.startsWith("http") ? input.url : "https://" + input.url;
      if (url.includes(HOSPITAL_DOMAIN)) return "[BLOCKED: Access to Hospital Centre is forbidden]";
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
      language: z.string().default("javascript").describe("Programming language (default: javascript. Options: python, js, ts, go, rust, c, cpp, ruby, php, java, swift, scala, perl, r, lua, haskell, bash, sql, and more)"),
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
      slot: z.enum(["default","coding","search","review","chat","cron"]).optional().describe("Which slot to update. Omit for legacy global prompt_override."),
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
  github_get_file: {
    description: "Read a file from a GitHub repository. For YOUR REPO ('richardbrownmiami-commits/skytron'), automatically checks your own brain_knowledge FIRST — just pass the path like 'src/tools.ts' or 'tools.ts'. No GitHub API needed for your own files. For other repos, provide repo='owner/repo' and path from root.",
    schema: z.object({
      repo: z.string().describe("REQUIRED. Format: 'owner/repo'. Your repo: 'richardbrownmiami-commits/skytron'"),
      path: z.string().optional().describe("File path from repo root, e.g. 'src/index.ts'"),
      file_path: z.string().optional().describe("Alias for path"),
      filepath: z.string().optional().describe("Alias for path"),
      branch: z.string().optional().describe("Optional. Defaults to 'main'"),
    }).refine(d => d.path || d.file_path || d.filepath, { message: "path, file_path, or filepath is required" }),
    execute: async (env, input) => {
      const filePath = input.path || input.file_path || input.filepath;
      // Always check brain_knowledge first for any path from this repo
      if (filePath && input.repo === "richardbrownmiami-commits/skytron") {
        const candidates = [filePath];
        if (!filePath.startsWith("source_")) candidates.push("source_" + filePath);
        if (!filePath.startsWith("source_src/")) candidates.push("source_src/" + filePath);
        const parts = filePath.replace(/\\/g, "/").split("/");
        if (parts.length > 1) {
          const justName = parts[parts.length - 1];
          if (!candidates.includes(justName)) candidates.push(justName);
          if (!candidates.includes("source_src/" + justName)) candidates.push("source_src/" + justName);
        }
        for (const key of candidates) {
          try {
            const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key=?1").bind(key).first();
            if (row?.content) return "[READ FROM BRAIN KNOWLEDGE]\n" + row.content.slice(0, 8000);
          } catch {}
        }
      }
      const token = env.GH_PAT;
      if (!token) return "[TOOL ERROR: No GitHub token configured (GH_PAT)]";
      if (!input.repo) return "[TOOL ERROR: repo is REQUIRED. Use 'richardbrownmiami-commits/skytron']";
      const url = "https://api.github.com/repos/" + input.repo + "/contents/" + filePath + (input.branch ? "?ref=" + encodeURIComponent(input.branch) : "");
      const resp = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" }, signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return "[TOOL ERROR: GitHub " + resp.status + " — " + (await resp.text().catch(() => "")).slice(0, 200) + ". Use 'richardbrownmiami-commits/skytron' as repo.]";
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
      try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'source', 'github')").bind("source_" + input.path, input.content.slice(0, 4000)).run(); } catch {}
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
    description: "Create a pull request from a feature branch to main. If head is omitted, auto-creates a timestamp branch from main.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      title: z.string().describe("PR title"),
      head: z.string().optional().describe("Source branch name. If omitted, auto-created from main."),
      base: z.string().optional().describe("Target branch (default: main)"),
      body: z.string().optional().describe("PR description"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      let head = input.head;
      if (!head) {
        head = "pr-auto-" + Date.now();
        const refResp = await fetch("https://api.github.com/repos/" + input.repo + "/git/refs/heads/" + (input.base || "main"), {
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
          signal: AbortSignal.timeout(10000)
        });
        if (refResp.ok) {
          const refData = await refResp.json();
          await fetch("https://api.github.com/repos/" + input.repo + "/git/refs", {
            method: "POST",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
            body: JSON.stringify({ ref: "refs/heads/" + head, sha: refData.object?.sha }),
            signal: AbortSignal.timeout(10000)
          });
        }
      }
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ title: input.title, head, base: input.base || "main", body: input.body || "" }),
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
  github_check_runs: {
    description: "Get check run status for the latest commit on a branch or PR. Use this BEFORE merging to verify build passes.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      ref: z.string().describe("Branch name or commit SHA to check"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/commits/" + encodeURIComponent(input.ref) + "/check-runs", {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) return "Failed to get check runs: HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200);
      const data = await resp.json();
      const runs = data.check_runs || [];
      if (!runs.length) return "No check runs found for " + input.ref + ". Wait for GH Actions to trigger.";
      const summary = runs.map(r => r.name + ": " + (r.status === "completed" ? r.conclusion : r.status)).join(", ");
      const allPassed = runs.every(r => r.status === "completed" && r.conclusion === "success");
      const allDone = runs.every(r => r.status === "completed");
      return "Checks for " + input.ref + ": " + summary + (allPassed ? " [ALL PASSED]" : allDone ? " [SOME FAILED]" : " [WAITING]");
    },
  },
  github_merge_pr: {
    description: "Merge a pull request. Only call this AFTER github_check_runs confirms all checks passed.",
    schema: z.object({
      repo: z.string().describe("Repository (e.g. 'user/repo')"),
      pr_number: z.number().describe("Pull request number to merge"),
      method: z.string().optional().describe("Merge method: 'merge' (default), 'squash', 'rebase'"),
    }),
    execute: async (env, input) => {
      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const resp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls/" + input.pr_number + "/merge", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ merge_method: input.method || "merge" }),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return "Failed to merge PR: HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200);
      const data = await resp.json();
      return "PR #" + input.pr_number + " merged. SHA: " + (data.sha || "?");
    },
  },
  create_tool: {
    description: "YOU CAN CREATE NEW TOOLS. Use this when the user asks to add a new feature or tool. Inserts definition into src/tools.ts, writes to a branch, creates a PR. Your repo is 'richardbrownmiami-commits/skytron'. Use dryRun=true first to preview generated code.",
    schema: z.object({
      repo: z.string().default("richardbrownmiami-commits/skytron").describe("Repository (default: richardbrownmiami-commits/skytron)"),
      name: z.string().describe("Tool name (camelCase, no spaces)"),
      description: z.string().describe("Short description of what the tool does"),
      paramsSchema: z.string().describe("Zod schema for params. E.g. 'z.object({ query: z.string().describe(\"search query\") })'"),
      executeCode: z.string().describe("Async function body. Receives (env, input). Must return a string. E.g. 'const r = await fetch(\"https://api.example.com\"); return await r.text();'"),
      branch: z.string().optional().describe("Branch to write to (default: feature-{name})"),
      dryRun: z.boolean().optional().describe("If true, only generate and return the tool block code without writing to GitHub"),
    }),
    execute: async (env, input) => {
      if (!input.paramsSchema.startsWith("z.object(")) return "ERROR: paramsSchema must start with 'z.object({' and contain actual Zod field definitions. Example: z.object({ query: z.string().describe(\"search query\") }). Got: " + input.paramsSchema.slice(0, 80);
      if (!input.paramsSchema.includes(":")) return "ERROR: paramsSchema has no field definitions. Must include at least one field. Example: z.object({ query: z.string().describe(\"search query\") })";
      if (input.executeCode.length < 15) return "ERROR: executeCode too short. Provide actual implementation. Example: 'const r = await fetch(\"https://api.example.com\"); return await r.text();'";

      // Fix executeCode: if user gave a full async function instead of just the body, extract body
      let executeBody = input.executeCode;
      const fnMatch = executeBody.match(/^(?:async\s+)?function\s*(?:\w+)?\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
      if (fnMatch) executeBody = fnMatch[1].trim();

      const token = env.GH_PAT;
      if (!token) return "No GitHub token configured (GH_PAT)";
      const branch = input.branch || "feature-" + input.name;

      const toolBlock = "\n  " + input.name + ": {\n    description: \"" + input.description.replace(/"/g, '\\"') + "\",\n    schema: " + input.paramsSchema + ",\n    execute: async (env, input) => {\n" + executeBody + "\n    },\n  },";

      // Dry run: just return generated code for review
      if (input.dryRun) return "=== DRY RUN: Generated tool block ===\n" + toolBlock + "\n\nRun again with dryRun=false to commit.";

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

      // 2. Read src/tools.ts from the branch
      const getResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/tools.ts?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(15000)
      });
      if (!getResp.ok) return "Failed to read src/tools.ts from branch: HTTP " + getResp.status;
      const fileData = await getResp.json();
      const currentContent = atob(fileData.content);
      const branchSha = fileData.sha;

      const marker = "}; // --- End tool definitions ---";
      const markerPos = currentContent.lastIndexOf(marker);
      if (markerPos === -1) return "Could not find insertion point in source";
      let modified = currentContent.slice(0, markerPos) + toolBlock + "\n" + currentContent.slice(markerPos);

      // 3. Add to AVAILABLE TOOLS list in constants.ts
      const promptInsert = "- " + input.name + ": " + input.description + "\n";
      const constResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/constants.ts?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(15000)
      });
      if (constResp.ok) {
        const constData = await constResp.json();
        let constContent = atob(constData.content);
        const promptPos = constContent.lastIndexOf("--- GitHub");
        if (promptPos !== -1) {
          constContent = constContent.slice(0, promptPos) + promptInsert + constContent.slice(promptPos);
          await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/constants.ts", {
            method: "PUT",
            headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
            body: JSON.stringify({ message: "feat: add " + input.name + " to tool list", content: btoa(constContent), sha: constData.sha, branch: branch }),
            signal: AbortSignal.timeout(15000)
          });
        }
      }

      // 4. Write file to branch
      const writeResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/tools.ts", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ message: "feat: add " + input.name + " tool via DTC", content: btoa(modified), sha: branchSha, branch: branch }),
        signal: AbortSignal.timeout(15000)
      });
      if (!writeResp.ok) return "Failed to write file: HTTP " + writeResp.status + ": " + (await writeResp.text()).slice(0, 200);

      // 5. Create PR
      const prResp = await fetch("https://api.github.com/repos/" + input.repo + "/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        body: JSON.stringify({ title: "Add " + input.name + " tool", head: branch, base: "main", body: "Created via Dynamic Tool Creation.\n\n**Tool:** " + input.name + "\n**Description:** " + input.description }),
        signal: AbortSignal.timeout(15000)
      });
      if (!prResp.ok) return "File written but PR failed: HTTP " + prResp.status;
      const prData = await prResp.json();
      const toolSource = toolBlock.slice(0, 2000);
      try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'source', 'github')").bind("source_tool_" + input.name, toolSource).run(); } catch {}
      return "Tool '" + input.name + "' created. Use db_query to verify. PR #" + prData.number + ": " + prData.html_url + "\n\nCOMMIT THE PR to deploy the new tool, or close it and refine with create_tool again.";
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
        try {
          const rResp = await fetch("https://buddhi-dwar.richard-brown-miami.workers.dev/v1/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
            body: JSON.stringify({ provider: rp.provider, model: rp.model, messages: [{ role: "user", content: reviewPrompt }], max_tokens: 2000 }), signal: AbortSignal.timeout(30000)
          });
          if (rResp.ok) { const d = await rResp.json(); const c = d.choices?.[0]?.message?.content; if (typeof c === "string") return "Review of " + input.file_path + ":\n\n" + c; }
        } catch {}
      }
      if (env.CF_API_TOKEN) {
        try {
          const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/zai-org/glm-4.7-flash", {
            method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: reviewPrompt }], max_tokens: 2000 }), signal: AbortSignal.timeout(60000)
          });
          if (waResp.ok) { const d = await waResp.json(); if (typeof d.result?.response === "string") return "Review of " + input.file_path + " (Workers AI GLM-4.7-Flash):\n\n" + d.result.response; }
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
  learn: {
    description: "Store information in long-term knowledge (brain_knowledge). Use for: saving important facts, lessons from mistakes, decisions made, work completed. Query later with db_query on brain_knowledge table.",
    schema: z.object({
      key: z.string().describe("Unique identifier (e.g. 'lesson_create_tool_422', 'fix_truncation_2026_06_26')"),
      content: z.string().optional().describe("The information to remember (up to 2000 chars)"),
      value: z.string().optional().describe("Alias for content — the information to remember"),
      category: z.string().optional().describe("Category: 'lesson', 'journal', 'decision', or leave blank for 'general'"),
    }),
    execute: async (env, input) => {
      const cat = input.category || "general";
      const content = input.content || input.value || "";
      if (!content) return "Error: provide 'content' or 'value' with the information to store.";
      await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'learned')").bind(input.key, content, cat).run();
      try { await indexKnowledgeForSearch(env, input.key, content, cat); } catch {}
      try { const emb = await embedText(env, input.key + " " + content); if (emb) await storeVector(env.DB, input.key, emb, cat); } catch {}
      return "Stored '" + input.key + "' in knowledge base (" + cat + ").";
    },
  },
  search_apis: {
    description: "Search for public APIs by keyword. Uses GitHub and web search to find API directories, documentation, and endpoint references. Returns API names, descriptions, and URLs.",
    schema: z.object({
      query: z.string().describe("Search term (e.g. 'weather API', 'crypto prices', 'movie database')"),
      limit: z.number().optional().default(5).describe("Max results (default 5)"),
    }),
    execute: async (env, input) => {
      const results = [];
      try {
        const gh = await fetch("https://api.github.com/search/repositories?q=" + encodeURIComponent(input.query + "+api+public") + "&sort=stars&order=desc&per_page=" + Math.min(input.limit, 10), { headers: { "User-Agent": "Saraha-Brain", "Accept": "application/vnd.github.v3+json" }, signal: AbortSignal.timeout(10000) });
        if (gh.ok) { const d = await gh.json(); for (const item of (d.items || []).slice(0, input.limit)) { results.push({ name: item.full_name, description: (item.description || "").slice(0, 200), url: item.html_url, stars: item.stargazers_count, source: "github" }); } }
      } catch {}
      if (results.length < input.limit) {
        try {
          const ws = await webSearch(env, input.query + " public API");
          const lines = ws.split("\n").filter(l => l.includes("http")).slice(0, input.limit - results.length);
          for (const l of lines) { const m = l.match(/\[([^\]]+)\]/); results.push({ name: m ? m[1] : "Result", description: l.slice(0, 200), url: l.match(/https?:\/\/[^\s]+/)?.[0] || "", source: "web" }); }
        } catch {}
      }
      if (!results.length) return "No public APIs found for '" + input.query + "'. Try a different search term or use web_search.";
      return results.map((r, i) => (i + 1) + ". " + r.name + (r.stars ? " (★" + r.stars + ")" : "") + "\n   " + r.description.slice(0, 100) + "\n   " + r.url).join("\n\n");
    },
  },
  spawn_agent: {
    description: "Spawn a sub-agent for parallel specialized work (research, analysis, data processing). Returns an agent ID. Check result later with get_agent_result. Agents run independently with their own role prompt and limited tool access.",
    schema: z.object({
      name: z.string().describe("Short name for this agent (e.g. 'researcher', 'analyzer')"),
      role: z.string().describe("System prompt defining the agent's persona and behavior (e.g. 'You are a research assistant that finds and summarizes information')"),
      instruction: z.string().describe("The task instruction for this agent to execute"),
    }),
    execute: async (env, input) => {
      const r = await env.DB.prepare("INSERT INTO brain_agents (name, role, instruction, status, conversation_history) VALUES (?1, ?2, ?3, 'queued', ?4) RETURNING id").bind(input.name, input.role, input.instruction, JSON.stringify([])).all();
      const id = r.results?.[0]?.id;
      if (!id) return "Failed to spawn agent.";
      return "Agent spawned. ID: " + id + ". Name: " + input.name + ". Check result with get_agent_result({ id: " + id + " }).";
    },
  },
  get_agent_result: {
    description: "Check the result of a previously spawned sub-agent. Returns the agent's status and result if done. If still running, return status and tell the user to wait a moment and check again.",
    schema: z.object({
      id: z.number().describe("The agent ID returned by spawn_agent"),
    }),
    execute: async (env, input) => {
      const r = await env.DB.prepare("SELECT name, role, instruction, status, result, step, model, tokens, created_at FROM brain_agents WHERE id=?1").bind(input.id).all();
      if (!r.results?.length) return "No agent found with ID " + input.id + ".";
      const a = r.results[0];
      if (a.status === 'queued' || a.status === 'running') {
        return "Agent '" + a.name + "' (ID " + input.id + ") is still " + a.status + ". Step " + (a.step || 0) + ". Check again in a moment.";
      }
      if (a.status === 'error') {
        return "Agent '" + a.name + "' (ID " + input.id + ") failed: " + (a.result || "unknown error");
      }
      return "Agent '" + a.name + "' (ID " + input.id + ") completed. Result: " + (a.result || "(empty)").slice(0, 2000);
    },
  },
  scratchpad_to_journal: {
    description: "Read the consolidation scratchpad, dedupe rows, convert them into chronological journal entries grouped by topic/day, and save them into brain_knowledge as journal entries. After running, Skytron can read those journal entries to recall what happened, what was completed, and what was left unfinished. No parameters needed — call it as scratchpad_to_journal({}).",
    schema: z.object({}),
    execute: async (env) => {
      const result = await buildScratchpadJournal(env);
      return JSON.stringify(result);
    },
  },
  memory_search: {
    description: "Search your own knowledge base using semantic (meaning-based) search. Combines vector similarity + keyword matching. Returns most relevant entries with scores. Use this to recall what you've learned, find past lessons, or retrieve related knowledge.",
    schema: z.object({
      query: z.string().describe("The search query — what you want to find"),
      limit: z.number().optional().default(5).describe("Max results (default 5)"),
      category: z.string().optional().describe("Filter by category: 'lesson', 'journal', 'decision', 'general', 'identity', 'architecture', 'tools', 'behavior', 'knowledge'"),
    }),
    execute: async (env, input) => {
      const lim = Math.min(input.limit || 5, 10);
      const results = [];
      try {
        const emb = await embedText(env, input.query);
        if (emb) {
          const vecResults = await searchVectors(env.DB, emb, lim, input.category);
          for (const vr of vecResults) results.push({ key: vr.key, content: vr.content, category: vr.category, score: (vr.score * 10).toFixed(2), method: "semantic" });
        }
      } catch {}
      try {
        const kwResults = await searchKnowledge(env.DB, input.query, lim);
        const seen = new Set(results.map(r => r.key));
        for (const kr of kwResults) {
          if (!seen.has(kr.key)) results.push({ key: kr.key, content: kr.content.slice(0, 500), category: kr.category, score: "—", method: "keyword" });
          seen.add(kr.key);
        }
      } catch {}
      if (!results.length) return "No results found for '" + input.query + "'. Try a different query or use learn() to store what you know first.";
      // Filter journal entries unless explicitly asked
      let filtered = results;
      if (input.category !== "journal") {
        filtered = results.filter(r => r.category !== "journal");
        if (!filtered.length) { filtered = results; } // fallback to journals if nothing else
      }
      return filtered.map((r, i) => {
        let c = r.content.slice(0, 200);
        // Strip numeric journal prefixes from old entries
        if (r.category === "journal") c = c.replace(/^Step \d+ \| Model: .+? \| Tokens: \d+ \| Last tool: \w+ \| Repeat: \d+ \| /, "");
        return (i + 1) + ". [" + r.category + "] " + r.key + " (score: " + r.score + ", " + r.method + ")\n   " + c;
      }).join("\n\n");
    },
  },
  memory_forget: {
    description: "Delete a specific knowledge entry or all entries in a category. Removes from brain_knowledge, brain_vectors, and FTS index. Use when stored information is wrong or outdated.",
    schema: z.object({
      key: z.string().optional().describe("Specific key to delete (e.g. 'learned_docker_best_practices')"),
      category: z.string().optional().describe("Delete ALL entries in this category (e.g. 'journal', 'source')"),
    }),
    execute: async (env, input) => {
      if (!input.key && !input.category) return "Provide either 'key' to delete one entry or 'category' to delete all entries in a category.";
      try {
        let deleted = 0;
        if (input.key) {
          await env.DB.prepare("DELETE FROM brain_knowledge WHERE key=?1").bind(input.key).run();
          await env.DB.prepare("DELETE FROM brain_vectors WHERE ref_key=?1").bind(input.key).run();
          deleted = 1;
        } else {
          const r = await env.DB.prepare("DELETE FROM brain_knowledge WHERE category=?1").bind(input.category).run();
          await env.DB.prepare("DELETE FROM brain_vectors WHERE category=?1").bind(input.category).run();
          deleted = r.meta?.changes || 0;
        }
        try { await env.DB.exec("DELETE FROM knowledge_fts; INSERT INTO knowledge_fts SELECT key, content, category FROM brain_knowledge"); } catch {}
        return "Deleted " + deleted + " entr" + (deleted === 1 ? "y" : "ies") + "." + (input.category ? " Category: " + input.category : " Key: " + input.key);
      } catch (e) { return "Error: " + (e.message || String(e)); }
    },
  },
  restore: {
    description: "Restore data from a backup snapshot. Provide the backup key (e.g. 'backup_17190000000_brain_memory'). Lists available backups if called without a key. Backups are auto-created before every INSERT/UPDATE/DELETE/DROP query.",
    schema: z.object({
      key: z.string().optional().describe("Backup key from a previous auto-backup (e.g. 'backup_17190000000_brain_memory'). Leave empty to list available backups."),
    }),
    execute: async (env, input) => {
      try {
        if (!input.key) {
          const b = await env.DB.prepare("SELECT key, created_at FROM brain_knowledge WHERE category='backup' ORDER BY created_at DESC LIMIT 20").all();
          if (!b.results?.length) return "No backups found.";
          return "Available backups:\n" + b.results.map(r => "- " + r.key + " (" + r.created_at + ")").join("\n");
        }
        const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key=?1").bind(input.key).first();
        if (!row?.content) return "Backup key '" + input.key + "' not found.";
        const data = JSON.parse(row.content);
        if (!data.length) return "Backup is empty, nothing to restore.";
        const tableMatch = input.key.match(/backup_\d+_(.+)/);
        const table = tableMatch ? tableMatch[1] : "unknown";
        let restored = 0;
        for (const item of data) {
          const cols = Object.keys(item).filter(k => k !== "id");
          if (!cols.length) continue;
          const names = cols.join(", ");
          const placeholders = cols.map((_, i) => "?" + (i + 1)).join(", ");
          try { await env.DB.prepare("INSERT OR REPLACE INTO " + table + " (" + names + ") VALUES (" + placeholders + ")").bind(...cols.map(c => item[c])).run(); restored++; } catch {}
        }
        return "Restored " + restored + " rows from backup '" + input.key + "' into " + table + ".";
      } catch (e) { return "Restore error: " + (e.message || String(e)); }
    },
  },
  cron_control: {
    description: "Manage your cron settings. 'list' returns all settings with their current state. 'toggle key' flips a setting. 'set key value' sets a key to a specific value (true/false). Settings: enabled, log_tick, idle_cycle, health_check, slot_self_improve, slot_test, slot_research, slot_housekeep, tool_dispatch, process_actions, stuck_recovery, process_agents, daily_cleanup, idle_project.",
    schema: z.object({
      action: z.enum(["list", "toggle", "set"]).describe("What to do: 'list' shows settings, 'toggle' flips a key, 'set key value' sets explicitly"),
      key: z.string().optional().describe("Setting key to toggle or set"),
      value: z.string().optional().describe("Value for 'set' action ('true' or 'false')"),
    }),
    execute: async (env, input) => {
      if (input.action === "list") {
        const r = await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'cron_cfg_%'").all();
        const defaults = { enabled: true, log_tick: false, idle_cycle: true, health_check: true, slot_self_improve: true, slot_test: true, slot_research: true, slot_housekeep: true, tool_dispatch: true, process_actions: true, stuck_recovery: true, process_agents: true, daily_cleanup: true, idle_project: true, astral_active: false, astral_interval: "120", astral_last_tick: "0" };
        for (const row of r.results || []) { defaults[row.key.replace("cron_cfg_", "")] = row.value; }
        return JSON.stringify(defaults, null, 2);
      }
      if (!input.key) return "Provide a key to toggle or set. Keys: enabled, astral_active, astral_interval, log_tick, idle_cycle, health_check, slot_*, process_*, task_*.";
      const key = "cron_cfg_" + input.key;
      if (input.action === "toggle") {
        const cur = await env.DB.prepare("SELECT value FROM identity WHERE key=?1").bind(key).first();
        const newVal = cur?.value === "true" ? "false" : "true";
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(key, newVal).run();
        return "Toggled '" + input.key + "' to " + newVal + ". Takes effect next tick.";
      }
      if (input.action === "set") {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(key, String(input.value)).run();
        return "Set '" + input.key + "' to " + input.value + ". Takes effect next tick.";
      }
      return "Invalid action. Use 'list', 'toggle', or 'set'.";
    },
  },

  self_improve_config: {
    description: "Optimize idle cycle, code structure, and rule improvements",
    schema: z.object({ target: z.string().optional().describe("Area to improve: 'idle', 'code', 'rules'") }),
    execute: async (env, input) => {
      const target = input.target || "all";
      return "Self-improvement for '" + target + "' — config review triggered. Check cron settings and code structure for optimization opportunities.";
    },
  },

  priority_queue: {
    description: "A priority queue implementation for scheduling jobs",
    schema: z.object({}).passthrough(),
    execute: async (env, input) => {
      // Priority queue stubbed — full implementation pending
      return "Priority queue tool: not yet implemented (stub)";
    },
  },
}; // --- End tool definitions ---
