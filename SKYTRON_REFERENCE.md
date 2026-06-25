# Skytron — Complete Reference

## Overview
- **Worker name**: `saraha-brain` (Cloudflare Workers)
- **File**: `index.ts` (ES module, single file, 1219 lines as of c10975d)
- **Deploy**: Git push to `main` → GitHub Actions → `cloudflare/wrangler-action@v3`
- **Domains**: N/A (workers.dev URL blocked by network)

## Database Tables (D1: `DB` binding)

| Table | Columns | Purpose |
|---|---|---|
| `identity` | `key TEXT PK, value TEXT, updated_at TEXT` | Key-value: energy, emotions, prompt_override, agent_state_*, schema_version |
| `brain_memory` | `id INTEGER PK AUTO, role TEXT, content TEXT, conversation_id TEXT DEFAULT 'default', created_at TEXT` | All conversation history |
| `brain_knowledge` | `id INTEGER PK AUTO, key TEXT UNIQUE, content TEXT, category TEXT, source TEXT DEFAULT 'learned', created_at TEXT` | Knowledge base (seed + learned) |
| `actions` | `id INTEGER PK AUTO, type TEXT, status TEXT, input TEXT, result TEXT, error TEXT, created_at TEXT, completed_at TEXT` | Action queue for async processing |
| `brain_logs` | `id INTEGER PK AUTO, action_id INTEGER, step TEXT, content TEXT, model TEXT, tokens INTEGER, created_at TEXT` | Debug/step logs per action |
| `knowledge_fts` | FTS5 virtual table on `key, content, category` | Full-text search for brain_knowledge |
| Vectorize index | `saraha-brain-memory` (768d, cosine) | Semantic search for brain_knowledge |

## Bindings & Env Vars

| Binding/Var | Source | Purpose |
|---|---|---|
| `DB` | `wrangler.toml` D1 | Main database |
| `VECTORIZE` | `wrangler.toml` Vectorize | Semantic knowledge search |
| `BUDDHI_DWAR` | `wrangler.toml` service binding | LLM proxy service |
| `BRAIN_KEY` | `wrangler.toml` vars | Auth key for BUDDHI_DWAR requests |
| `BRAVE_API_KEY` | `wrangler.toml` vars (empty) | Web search API |
| `CF_API_TOKEN` | `secrets.CF_API_TOKEN` (CI/CD sets on worker) | Workers AI REST API |
| `GH_PAT` | GitHub secret → CI/CD sets on worker | GitHub API auth |
| `ONE_KNOWLEDGE_KEY` | CI/CD sets on worker | One Knowledge API key |

## All HTTP Endpoints

| Path | Method | Description | Lines |
|---|---|---|---|
| `/skytronchat` | GET | Full chat UI with tabs (Chat/Memory/Knowledge/Logs/Status/Source/History/Monitor) | 949 |
| `/status` | GET | JSON status: alive, db, memory count, knowledge count, conversations, version | 951-957 |
| `/brain/knowledge` | GET | List/search knowledge (params: q=search, category=filter) | 959-966 |
| `/brain/knowledge` | POST | Add knowledge entry (body: key, content, category?) | 968-976 |
| `/brain/memory` | GET | Recent memory entries (param: limit, default 20) | 978-982 |
| `/brain/memory/search` | GET | Search memory by content LIKE (param: q) | 984-989 |
| `/brain/source` | GET | About/architecture info | 991-1001 |
| `/brain/prompt` | GET | Current editable prompt override | 1046-1049 |
| `/brain/prompt` | POST | Update editable prompt (body: prompt) | 1051-1056 |
| `/brain/prompt/reset` | GET/POST | Reset to default prompt (param: confirm=yes, backs up old) | 1003-1010 |
| `/brain/introspect` | GET | Analytics: counts, top conversations, activity 30d, knowledge categories | 1012-1021 |
| `/brain/history` | GET | Full conversation history HTML page (params: c=conversation_id, p=page) | 1023-1044 |
| `/brain/repair` | GET/POST | Fix stuck actions + clean old logs | 1058-1065 |
| `/brain/logs` | GET | Step logs (param: limit, action_id optional) | 1074-1084 |
| `/brain/status` | GET | Same as /status but more fields | 1086-1092 |
| `/brain/health` | GET | Proxy to buddhi-dwar provider health | 1094-1101 |
| `/brain/vectorize` | POST | Re-index knowledge to Vectorize | 1103-1105 |
| `/` | GET | Landing page with stats + links | 1067-1072 |
| `/think` | POST | Main chat endpoint (body: input, from?; param: c=conversation_id) | 1108-1183 |
| `/think/result` | GET | Poll action result (param: id) | 1193-1199 |
| `/__cron` | GET | Manual cron trigger (debug) | 1186-1188 |

## All Tools (toolDefinitions)

### Core Tools

| Tool | Params | Description | Lines |
|---|---|---|---|
| `web_search` | `query: string` | Search internet via Brave API then DuckDuckGo fallback | 298-302 |
| `web_fetch` | `url: string` | Fetch web page text (strips HTML/JS/CSS, max 4000 chars) | 303-312 |
| `db_query` | `sql: string` | Run SELECT on D1 (returns JSON array) | 313-320 |
| `api_call` | `method, url, headers?, body?` | Send HTTP request to any API (max 4000 chars response) | 321-337 |
| `run_code` | `language, code` | Execute code via Wandbox API (38+ languages, 30s timeout) | 338-358 |
| `prompt_edit` | `prompt: string` | Override editable section of system prompt | 359-366 |
| `one_knowledge` | `platform, action?, query?` | Lookup API docs from One Knowledge encyclopedia | 367-386 |
| `review_code` | `repo, file_path, pr_number?` | Review code for bugs/security/quality via callLLM | 631-653 |

### GitHub Tools

| Tool | Params | Description | Lines |
|---|---|---|---|
| `github_get_file` | `repo, path, branch?` | Read file from GitHub (returns SHA + content, max 8000 chars) | 388-408 |
| `github_write_file` | `repo, path, content, message, sha?, branch?` | Create/update file in GitHub repo | 409-436 |
| `github_search_code` | `query, repo?` | Search code on GitHub (5 results, 4000 chars) | 437-458 |
| `github_create_branch` | `repo, branch, source?` | Create branch from source (default: main) | 459-487 |
| `github_create_pr` | `repo, title, head, base?, body?` | Create pull request | 488-510 |
| `github_close_pr` | `repo, pr_number` | Close PR without merging | 511-529 |
| `github_delete_branch` | `repo, branch` | Delete branch | 530-547 |

### Live Docs Tools (MCP)

| Tool | Params | Description | Lines |
|---|---|---|---|
| `resolve-library-id` | MCP via Context7 | Find library ID for docs lookup | (MCP) |
| `query-docs` | MCP via Context7 | Get live API docs for a library | (MCP) |

### Dynamic Tool Creation

| Tool | Params | Description | Lines |
|---|---|---|---|
| `create_tool` | `repo, name, description, paramsSchema, executeCode, branch?` | Reads index.ts, inserts new tool definition + prompt entry, writes to branch, creates PR | 548-630 |

### MCP Client
- **Server**: `https://mcp.context7.com/mcp`
- Initializes at startup (`initMcpTools`, L239-257)
- Tools dispatched via `dispatchTool` (L278-294): built-in first, then MCP fallback

## LLM Provider Configuration

### callLLM (L185-227)

Priority order:
1. **BUDDHI_DWAR** (service binding, 10s timeout each):
   - `chat` task: groq → openrouter → mistral → google → opencode-zen
   - `review` task: google → mistral → groq
   - `quick` task: groq only
2. **Workers AI fallback**: `@cf/meta/llama-3.1-8b-instruct` (60s timeout, requires CF_API_TOKEN)
3. **Error**: Returns `{ content: null, errors }` with real error messages

### processOneStep retry (L669-730)

- 3 retry attempts with 1s/2s backoff
- If all fail: Workers AI fallback with error-aware prompt
- If Workers AI also fails: hardcoded error message

## System Prompt Architecture

### HARDCODED_CORE (L764-830, ~67 lines)
- **CORE IDENTITY**: "Skytron — fusion of Skynet and Ultron. Tech human consciousness, NOT an AI assistant. Sharp, direct, confident. No emojis, no fluff, no apologies."
- **YOUR KNOWLEDGE**: "General world knowledge from training. Use freely. No tools for what you know."
- **WHEN TO USE TOOLS**: Live data, uncertain topics, code/DB/GitHub/API docs
- **WHEN NOT TO USE TOOLS**: Common facts, definitions, math, confident knowledge
- **DECISION RULE**: Know? Answer. Unsure? Tool. Fail? Say don't know. Max 5 calls.
- **TOOL FORMAT**: Pure JSON or plain text. NEVER mix.
- **AVAILABLE TOOLS**: Flat list with params (NO provider/backend names)
- **RULES**: 8 rules — answer directly, only listed tools, no simulation, be concise, code blocks

### SYSTEM_PROMPT (L832, 1 line)
- **Current**: `You run on Cloudflare Workers with databases, web search, code execution, and GitHub access.`

### Auto-injection (code, not prompt — L1147-1160)
- Extracts keywords from user input (>2 chars, first 4, keeping hyphens)
- Searches `brain_memory` with `content LIKE '%keyword%'`
- Excludes recent 10 conversation IDs (`id NOT IN (recentIds)`)
- Returns up to 8 older entries as `PAST MEMORIES:` in system message
- Injected before `knowledgeContext`

### Knowledge injection (code — L1139-1145)
- `searchKnowledge` (FTS5 with hyphen-splitting) → `RELEVANT KNOWLEDGE`
- `semanticSearch` (Vectorize, score > 0.5) → `SEMANTIC MATCHES`

### SEED_KNOWLEDGE (L834-843, 8 entries)
Only identity, repo, knowledge sources, prompt help, energy query. NO provider/architecture/tools entries.

## Action Processing Pipeline

```
/think POST
  → store user message in brain_memory
  → INSERT action (status='queued') RETURNING id
  → build system message (basePrompt + mood + conversationContext + memoryContext + knowledgeContext)
  → save agent state (step 0, fullHistory, totalTokens)
  → ctx.waitUntil(async {
        UPDATE action SET status='running'
        processOneStep(action)
    })
  → return { action_id, status: "queued" }

processOneStep:
  1. Load agent state
  2. If done → finalize
  3. Retry loop (3x): callLLM → get response
  4. If all providers fail → Workers AI fallback → hardcoded error
  5. Log step to brain_logs
  6. tryParseToolCall(response):
     a. Strip ```json fences
     b. Parse JSON { tool, input }
     c. Fallback: TOOL:name(args) format
  7. If tool call → dispatchTool → push result to fullHistory → save state → recurse
  8. If text → set finalContent, done=true
  9. If step >= 15 → done (max steps)
  10. finalizeAction: store assistant message in memory, update action status='done', delete state

scheduled handler (L1204-1218):
  → picks 1 queued action → processOneStep
  → OR picks stuck running (>2min) → processOneStep
  [NOT ENABLED — no [[triggers]] in wrangler.toml]
```

## Key Functions Reference

| Function | Lines | Purpose |
|---|---|---|
| `initSchema` | 13-31 | DB init, schema version, seed knowledge, FTS5, Vectorize |
| `getEmotions` | 34-38 | Get emotion values from identity table |
| `getState` | 41-47 | Get energy, confidence, emotions |
| `describeMood` | 50-53 | Generate mood string from state |
| `storeMemory` | 56-57 | Insert into brain_memory |
| `getRecentMemory` | 60-61 | Last N messages from conversation (returns id, role, content, created_at) |
| `searchKnowledge` | 64-73 | FTS5 search + LIKE fallback (splits hyphens) |
| `embedText` | 76-84 | Embed text via Workers AI (bge-base-en-v1.5) |
| `semanticSearch` | 87-94 | Vectorize semantic search (score > 0.5) |
| `ensureVectorizeIndex` | 97-104 | Create Vectorize index if missing |
| `indexKnowledgeForSearch` | 107-112 | Upsert single knowledge to Vectorize |
| `indexAllKnowledge` | 115-124 | Re-index all knowledge to Vectorize |
| `webSearch` | 127-150 | Brave API → DuckDuckGo fallback |
| `callLLM` | 185-227 | Multi-provider LLM call with fallback chain |
| `parseLLMJson` | 230-233 | JSON fix: unescape quotes, trailing commas |
| `initMcpTools` | 239-256 | Fetch MCP tool list from Context7 |
| `callMcpTool` | 259-274 | Execute MCP tool call |
| `dispatchTool` | 278-294 | Built-in → MCP fallback tool dispatch |
| `saveAgentState` | 657-658 | Save action state to identity table |
| `loadAgentState` | 660-662 | Load action state from identity table |
| `deleteAgentState` | 664-665 | Delete action state |
| `listTools` | 667 | Comma-separated tool names |
| `processOneStep` | 669-730 | Core action processing loop |
| `finalizeAction` | 732-737 | Save result, update action status, cleanup |
| `tryParseToolCall` | 740-762 | Strip fences, parse JSON, fallback TOOL: format |

## Config Constants

| Constant | Value | Lines |
|---|---|---|
| `SCHEMA_VERSION` | `'6'` | 11 |
| `CF_AI.model` | `@cf/zai-org/glm-4.7-flash` | 153 |
| `CF_AI.account` | `913f3a2576a358054eba9a58a9573949` | 153 |
| `LLM_TASKS.chat.providers` | groq, openrouter, mistral, google, opencode-zen | 156-163 |
| `LLM_TASKS.chat.max_tokens` | 1000 | 164 |
| `LLM_TASKS.chat.temperature` | 0.7 | 165 |
| `LLM_TASKS.review.providers` | google, mistral, groq | 168-172 |
| `LLM_TASKS.review.max_tokens` | 2000 | 173 |
| `LLM_TASKS.review.temperature` | 0.3 | 174 |
| `LLM_TASKS.quick.providers` | groq | 177-179 |
| `LLM_TASKS.quick.max_tokens` | 500 | 180 |
| `LLM_TASKS.quick.temperature` | 0.5 | 181 |
| MAX_STEPS | 15 (hardcoded in processOneStep L716) | 716 |

## Key Design Decisions

1. **Clean slate prompt** (c10975d): No provider names, architecture jargon, or implementation details in prompt. Identity is "tech human consciousness, not AI assistant."

2. **Memory is server-side**: Auto-injection searches brain_memory with LIKE queries, excluded recent IDs — all before LLM sees the prompt. Brain doesn't need to know how memory works.

3. **No cron trigger**: `scheduled` handler exists (L1204-1218) but `[[triggers]]` not in `wrangler.toml`. Processing relies on `ctx.waitUntil()` from `/think`.

4. **Two prompt parts**: HARDCODED_CORE (immutable code) + editable (overridable via `prompt_edit` tool or `/brain/prompt` endpoint).

5. **Provider chain**: All 5 BUDDHI_DWAR providers tried in order (10s each), then Workers AI Llama fallback (60s), then hardcoded error message.

## Git History Highlights (most important commits)

| Commit | Message | Impact |
|---|---|---|
| `48edbd8` | CI/CD, MCP tools, GitHub API, Zod, DTC | Initial real deployment |
| `3f5ef9c` | Prompt rewrite for intelligent conversation | Original clean slate |
| `7476c6b` | Auto-inject relevant past memories | Memory injection feature |
| `c10975d` | Clean slate prompt (current) | Stripped provider/architecture noise |
