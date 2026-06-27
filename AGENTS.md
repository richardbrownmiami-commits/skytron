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
