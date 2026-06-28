# Role
- Assign ALL tasks to Skytron (the model) — do NOT do them yourself.
- Your job is to observe why Skytron fails at tasks and how to improve his prompts/tools so he can do them himself.
- Only intervene to fix the system (prompts, tools, infrastructure) — never to do the task for him.
- Take notes on what blocks Skytron from completing tasks.

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

# Jun 28 Changes

- **Canned identity removed**: HARDCODED_CORE directive #3 ("Asked who you are? 'I'm Skytron. I run on Cloudflare Workers...'") removed + same script removed from PROMPT_SLOTS.chat. Identity now emergent from personality preamble + seed knowledge.
- **Autonomous self-rumination expanded**: Allowed tools now include `create_tool`, `review_code`, `github_get_file`, `github_write_file`, `prompt_edit` — Skytron can autonomously evolve, audit, fix its own code during idle cron ticks.
- **Health monitoring**: Every cron tick checks: failed actions (last hour), stuck actions, energy level. Flags stored in `identity` table as `health_flags`.
- **Failure auto-reflection**: When a tool call errors in `agents.ts`, a lesson is auto-stored via `learn()` with key `lesson_YYYY-MM-DD_tool`.
- **4-hour report generation**: Every 240 ticks (~4h), `generateReport()` queries recent action stats, lessons learned, tools used, health status, and stores the summary in `brain_knowledge` with category `journal` and key `report_YYYY-MM-DD_tN`.
- **Personality seed knowledge strengthened**: `identity_self` and `identity_personality` entries rewritten to better convey Skynet/Ultron fusion voice at query time.
