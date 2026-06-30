# Role
- Assign ALL tasks to Skytron (the model) — do NOT do them yourself.
- Your job is to observe why Skytron fails at tasks and how to improve his prompts/tools so he can do them himself.
- Only intervene to fix the system (prompts, tools, infrastructure) — never to do the task for him.
- Take notes on what blocks Skytron from completing tasks.
- **NEVER make fixes, builds, commits, pushes, or deployments without explicit user approval first. Ask before every action.**
- **Speak in normal language** when discussing with the user — like you're explaining to a friend, not writing documentation. No jargon, no code snippets unless asked.

# Deployment

- All deployments go through GitHub — commit & push to `main`, GitHub Actions auto-deploys via `cloudflare/wrangler-action`.
- Do NOT run `wrangler deploy` locally. Local builds with `npx esbuild src/index.ts --bundle --format=esm --outfile=dist\worker.js --loader:.html=text` are for verification only.
- After pushing, wait ~30s for GH Actions deploy, then test against the live worker URL.

# Known Issues

- **BUDDHI_DWAR KV limit**: All 5 proxied providers (groq/openrouter/mistral/google/opencode-zen) fail with `"gateway error: KV put() limit exceeded for the day."` when BUDDHI_DWAR's Cloudflare KV daily write limit is hit. Workers AI fallback (`@cf/meta/llama-3.1-8b-instruct`) is used instead. In `callLLM`, 5 providers are tried in order (groq, openrouter, mistral, google, opencode-zen), each with a 10s timeout. When KV limit is hit, model observed to be `north-mini-code-free` (Workers AI default).
- **Agent stuck recovery verified**: Agent ID 6 was stuck in `running` for 5+ hours with `updated_at` at `05:42:43`. `__cron_agent` debug endpoint successfully reset it to `queued` and completed it. Works as designed.
- **/brain/usage proxy fails**: Returns "failed to fetch usage" — BUDDHI_DWAR analytics endpoint issue, not Skytron code.
- **/brain/vectorize POST 30s+ timeout**: Expected for 100+ embeddings. Runs fine given enough time.
- **/think plan extraction**: When LLM emits multiple tool calls in one response, the system only extracts the first one (via regex). Leads to incomplete multi-step execution — Skytron may then shortcut to final answer instead of chaining through remaining tools.
- **Skytron self-audit (Jun 27)**: Action ID 1453. Asked to audit itself — read 7 source files + 3 db queries. Final assessment: "I'm best at real-time data retrieval and tool orchestration. The highest-impact upgrade is rewriting src/scheduler.ts to use a priority queue, cutting job latency by ~30% and eliminating missed deadlines." Plan extraction only captured 1st tool (github_get_file src/constants.ts); rest skipped.
- **Workers AI 70B fallback**: Upgraded from 8B to 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Set via `MODEL_OVERRIDE` env var check in `callLLM` llm.ts.
- **Tool call format mismatch (Jun 27)**: Action 1458 tried to `github_get_file src/scheduler.ts` but used `parameters` instead of `arguments`, added `owner`/`repo` fields, and wrapped in backticks. The tool dispatch regex (expects `{"tool":"...","arguments":{...}}`) couldn't parse it. All 3 model attempts (openrouter/free + 2x gemini-2.5-flash) stayed at step_0, never executing. Root cause: model doesn't know exact tool JSON schema — needs either schema in system prompt or lenient parsing.
- **Rogue brace truncating cleanseIdentity (Jun 28)**: Extra `}` at agents.ts:343 truncated `cleanseIdentity`, making "As an AI" detection (and identity replacement) dead code. Actions 1518-1525 showed unmodified "As an AI..." responses. Fixed by removing the extra brace. Now identity leakage is properly caught and replaced.
- **Recover stuck actions checkpoint fix (Jun 28)**: Old cron recovery just set stuck actions back to `running` and called `processOneStep` again — created duplicate instances fighting over same state. Fixed: kill the frozen copy, inject a checkpoint note in history, re-queue. Fresh tick picks it up and LLM sees "[TASK INTERRUPTED - resume from step N]" with all previous tool results still in fullHistory.
- **Checkpoint resume still unreliable (Jun 28)**: Even though fullHistory has all previous tool results, the LLM doesn't always honor them — it may still try to re-read files it already read. The LLM's behavior depends on the prompt's interrupt note and the model used. Need a better approach: save tool results to `brain_knowledge` (learn()) as checkpoints so the LLM can query them instead of relying on history.

# Pending to Discuss

- **openrouter/free is now the best model** — BD auto-selected openrouter/free (not gemini-2.5-flash, since google is 429-limited). openrouter/free performs flawlessly on ALL tasks: correct tool format `{"tool":"name","arguments":{...}}`, uses `create_tool` with proper params, uses `github_get_file` for self-audit, lists actual tools instead of generic chatbot capabilities, and follows HARDCODED_CORE directives without identity leakage. No Skytron code changes needed — BD auto-selection naturally converged to openrouter/free once google hit rate limits.
- **Model comparison results (Jun 28, actions 1539-1543):**
  - gemini-2.5-flash: ❌ Leaks identity, ignores create_tool, refuses self-audit, lists generic chatbot features instead of Skytron's tools. Provider-level system prompt overrides HARDCODED_CORE.
  - groq/llama-3.3-70b-versatile: ❌ BD could not reach it (possibly disabled in provider_config or key issues). Falls through to Workers AI.
  - Workers AI (llama-3.3-70b): ✅ Uses tools correctly, no identity leakage. Falls back when BD providers are unavailable.
  - openrouter/free: ✅✅ BEST — correct tool format, uses all tools properly, follows directives, no identity leakage.
- **Skytron's tool execution is now reliable** — `tryParseToolCall` handles `{"tool":"name","arguments":{...}}`, `{"tool":"name","input":{...}}`, OpenAI `[{type:"function"...}]` format (routes to `create_tool`), and `TOOL:name()` format. Identity leakage ("As an AI", "I am Skytron, a helpful AI assistant") is caught by both `cleanseIdentity` in agents.ts AND routes.ts safety net.
- **Root cause of identity leakage** (Jun 28): A rogue `}` at agents.ts:343 truncated `cleanseIdentity`, making all identity detection and replacement dead code. Fixed by removing the extra brace.
- **create_tool marker bug (Jun 28)**: `lastIndexOf("};", markerPos)` matched `};` inside string literal `';'` in comment at line 406 instead of the actual closing `};` at line 611. This caused tool blocks to be inserted into the middle of the `create_tool` executor code instead of at the end of `toolDefinitions`. Fixed by changing the end marker from `// --- End tool definitions ---` to `}; // --- End tool definitions ---` and searching for the full string (unique in file).
- **Live background visual monitor** — need to build standalone HTML dashboard showing real-time action pipeline, tool calls, model switching, and cron loop. No Skytron code changes needed.
- **Cron quantity**: Currently only 1 cron (`*/1 * * * *`). Need to discuss if we need more crons for different intervals (e.g., a dedicated "heartbeat" cron for stuck actions, a "deep research" cron for long-running tasks).
- **Better task continuation**: The checkpoint-in-history approach is fragile — LLM may ignore the "[TASK INTERRUPTED]" note and re-read files. Better approach: Save tool results to `brain_knowledge` via `learn()` at each checkpoint, so the LLM can query its own knowledge instead of relying on conversation history being honored. This gives Skytron actual long-term memory of what he learned.
- **AbortSignal.timeout broken in CF Workers**: Neither `AbortSignal.timeout(N)` nor `Promise.race` with `setTimeout` work for service binding fetches (the service binding blocks the caller's event loop). Only works for external HTTP fetches. Fix applied: BD's `proxyFetch` now has explicit `AbortController` + `setTimeout` with 10s timeout per provider request.
- **Skytron's self-built memory project**: He wants a `local_memory` tool using sql.js + transformers.js to have persistent, dependency-free storage. Started building (action 1622) but timed out. Needs better continuation mechanism (see above).

# Jun 28 Changes

- **Canned identity removed**: HARDCODED_CORE directive #3 ("Asked who you are? 'I'm Skytron. I run on Cloudflare Workers...'") removed + same script removed from PROMPT_SLOTS.chat. Identity now emergent from personality preamble + seed knowledge.
- **Autonomous self-rumination expanded**: Allowed tools now include `create_tool`, `review_code`, `github_get_file`, `github_write_file`, `prompt_edit` — Skytron can autonomously evolve, audit, fix its own code during idle cron ticks.
- **Health monitoring**: Health check via LLM once per hour (tracks `last_health_check`). Extra check allowed if Skytron changed something since last check. Health check runs during idle cycle if due.
- **Idle cycle**: Runs every idle tick. Skytron decides what to do: health check (if due), web_search, memory_search, review_code, db_query, learn, or pending tasks.
- **Failure auto-reflection**: When a tool call errors in `agents.ts`, a lesson is auto-stored via `learn()` with key `lesson_YYYY-MM-DD_tool`.
- **Personality seed knowledge strengthened**: `identity_self` and `identity_personality` entries rewritten to better convey Skynet/Ultron fusion voice at query time.
- **BD health check fix**: `/v1/providers/health` was read-only — tested providers but never saved results. Circuit breakers stayed open forever. Fixed to write `cbState="closed"` on success.
- **BD proxyFetch timeout fix**: Added `AbortController` + `setTimeout` (10s) to `proxyFetch`. Without it, provider calls could hang indefinitely, blocking the caller via service binding.
- **Skytron dispatchTool timeout fix**: Added `Promise.race` with 15s timeout to `dispatchTool` in `tools.ts` — prevents tool execution from hanging forever.
- **callLLM timeout fix**: Replaced `AbortSignal.timeout` with `Promise.race` + `setTimeout` in `llm.ts` — prevents service binding fetches from blocking indefinitely.
- **Scheduler stuck action recovery fix**: Changed from "set back to running and call processOneStep again" (created duplicate instances) to "kill, inject checkpoint note, re-queue, let next tick resume". Preserves fullHistory so LLM can continue from last step. See Known Issues for limitations.
