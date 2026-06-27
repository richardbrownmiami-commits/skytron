import { z } from "zod";
import { CF_AI } from './constants';
import { embedText, indexKnowledgeForSearch } from './db';

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

export async function webSearch(env, query) {
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

export async function dispatchTool(env, toolName, input) {
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
    description: "Dynamically create a new tool. Inserts definition into src/tools.ts and adds it to the prompt. Writes to a branch and creates a PR. The execute function receives (env, input) and must return a string.",
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

      // 2. Read src/tools.ts from the branch (not main, avoids SHA race)
      const getResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/tools.ts?ref=" + branch, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
        signal: AbortSignal.timeout(15000)
      });
      if (!getResp.ok) return "Failed to read src/tools.ts from branch: HTTP " + getResp.status;
      const fileData = await getResp.json();
      const currentContent = atob(fileData.content);
      const branchSha = fileData.sha;

      // 3. Generate tool definition block
      const toolBlock = "\n  " + input.name + ": {\n    description: \"" + input.description.replace(/"/g, '\\"') + "\",\n    schema: " + input.paramsSchema + ",\n    execute: async (env, input) => {\n" + input.executeCode + "\n    },\n  },";

      // 4. Insert into toolDefinitions (find closing '};' before export marker)
      const marker = "// --- End tool definitions ---";
      const markerPos = currentContent.indexOf(marker);
      if (markerPos === -1) return "Could not find insertion point in source";
      let insertPos = currentContent.lastIndexOf("};", markerPos);
      if (insertPos === -1) return "Could not find insertion point in source";
      let modified = currentContent.slice(0, insertPos) + toolBlock + "\n" + currentContent.slice(insertPos);

      // 5. Add to AVAILABLE TOOLS list in constants.ts
      const promptInsert = "- " + input.name + ": " + input.description + "\n";
      // Read and update constants.ts
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

      // 6. Write file to branch
      const writeResp = await fetch("https://api.github.com/repos/" + input.repo + "/contents/src/tools.ts", {
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
          const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
            method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: reviewPrompt }], max_tokens: 2000 }), signal: AbortSignal.timeout(60000)
          });
          if (waResp.ok) { const d = await waResp.json(); if (typeof d.result?.response === "string") return "Review of " + input.file_path + " (Workers AI 70B):\n\n" + d.result.response; }
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
      content: z.string().describe("The information to remember (up to 2000 chars)"),
      category: z.string().optional().describe("Category: 'lesson', 'journal', 'decision', or leave blank for 'general'"),
    }),
    execute: async (env, input) => {
      const cat = input.category || "general";
      await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'learned')").bind(input.key, input.content, cat).run();
      try { await indexKnowledgeForSearch(env, input.key, input.content, cat); } catch {}
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
};
// --- End tool definitions ---
