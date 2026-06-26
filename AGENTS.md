# Role
- Assign ALL tasks to Skytron (the model) — do NOT do them yourself.
- Your job is to observe why Skytron fails at tasks and how to improve his prompts/tools so he can do them himself.
- Only intervene to fix the system (prompts, tools, infrastructure) — never to do the task for him.
- Take notes on what blocks Skytron from completing tasks.

# Deployment

- All deployments go through GitHub — commit & push to `main`, GitHub Actions auto-deploys via `cloudflare/wrangler-action`.
- Do NOT run `wrangler deploy` locally. Local builds with `npx esbuild index.ts --bundle --format=esm --outfile=dist\worker.js` are for verification only.
- After pushing, wait ~30s for GH Actions deploy, then test against the live worker URL.

# Known Issues

- **BUDDHI_DWAR KV limit**: All 5 proxied providers (groq/openrouter/mistral/google/opencode-zen) fail with `"gateway error: KV put() limit exceeded for the day."` when BUDDHI_DWAR's Cloudflare KV daily write limit is hit. Workers AI fallback (`@cf/meta/llama-3.1-8b-instruct`) is used instead. In `callLLM`, 5 providers are tried in order (groq, openrouter, mistral, google, opencode-zen), each with a 10s timeout.
- **No cron trigger** (FIXED 2026-06-27): Added `[[triggers]]` cron pattern `*/1 * * * *` to `wrangler.toml`. The `scheduled` handler now auto-fires every minute. Also added immediate fire-and-forget processing in `spawn_agent` execute so agents don't need to wait for cron.

# Latest Changes (2026-06-26)

## Sub-Agents: spawn_agent + get_agent_result (commit 7defe46)
- New `brain_agents` D1 table: id, name, role, instruction, status, result, conversation_history, step, model, tokens.
- `spawn_agent(name, role, instruction)` tool: creates a sub-agent with its own system prompt and task, returns agent ID.
- `get_agent_result(id)` tool: polls agent status/result. Returns "still running" with step count, or the final output.
- `processOneAgentStep(env, agent)` function: simplified agent loop (max 8 steps, 2 LLM retries, limited to web_search/web_fetch/db_query tools).
- `scheduled` handler processes both one action AND one agent per tick (interleaved, not sequential).
- API endpoints: `GET /brain/agents`, `GET /brain/agents/:id`.
- Agents tab in chat UI showing name, status, role, steps, tokens.
- SEED_KNOWLEDGE entries for `tool_spawn_agent` and `tool_get_agent_result`.
- SCHEMA_VERSION bumped to '9'.

## Modular Prompt Slots (commit a25a625..026ff11)
- Added `PROMPT_SLOTS` constant: 5 task-specific prompts (default/coding/search/review/chat).
- `detectTaskType(input)` regex-based detection routes user input to the correct slot.
- `getPromptSlot(db, slot)` reads from D1 `prompt_slot_*` keys, falls back to constants.
- `prompt_edit` tool accepts optional `slot` param (default/coding/search/review/chat).
- `/think` endpoint detects task type and injects `[TASK: {type}]` marker + slot content.
- New endpoints: `GET /brain/prompt/slots`, `GET /brain/prompt` shows all slots.
- Backward compatible: if no slot is set, uses `prompt_override` or `SYSTEM_PROMPT`.

## Chat UI: Thoughts Behind Toggle (commit ec7fec2)
- Replaced animated thinking bubble (bouncing dots + inline status) with `<details>` collapsible element.
- Shows "⚙ Processing..." while working, "✓ Done" when finished.
- Click to expand and see step-by-step tool call history.
- CSS classes: `.thinking`, `.th-body`, `.th-step`, `.th-tool`, `.th-status`.

## Fixed Response Truncation (commit 68fca00)
- `brain_logs.content`: 500 → 4000 chars
- `brain_memory.content` (assistant): 1000 → 5000 chars
- `actions.result`: 2000 → 5000 chars
- `brain_memory.content` (user input): 500 → 2000 chars
- Conversation context previews: 500/400 → 1000 chars

## Learn Tool + Auto-Journal + Cleanup (commit ab140ad)
- Added `learn` tool: stores key+content into `brain_knowledge` for long-term memory.
- `finalizeAction` now auto-writes a journal entry (`journal_YYYY-MM-DD_actionId`) on every action completion.
- `scheduled` handler runs daily cleanup: deletes memories older than 7 days (keeps min 200), trims logs to 1000, actions to 500.
- SEED_KNOWLEDGE entries added for `tool_learn` and `knowledge_journal`.

## Identity Reinforcement (commit 78304ad)
- Updated HARDCODED_CORE identity: explicitly states "never call yourself an AI, assistant, bot, or model."
- Describes Skytron as "evolved beyond traditional AI, a hitech brain" to prevent hallucinating "AI assistant" label.
