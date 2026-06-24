# Deployment

- All deployments go through GitHub — commit & push to `main`, GitHub Actions auto-deploys via `cloudflare/wrangler-action`.
- Do NOT run `wrangler deploy` locally. Local builds with `npx esbuild index.ts --bundle --format=esm --outfile=dist\worker.js` are for verification only.
- After pushing, wait ~30s for GH Actions deploy, then test against the live worker URL.

# Known Issues

- **BUDDHI_DWAR KV limit**: All 3 proxied providers (openrouter/groq/mistral) fail with `"gateway error: KV put() limit exceeded for the day."` when the BUDDHI_DWAR Cloudflare KV daily write limit is hit. Workers AI fallback (`@cf/meta/llama-3.1-8b-instruct`) is used instead.
- **No cron trigger**: `wrangler.toml` has no `[[triggers]]` for the `scheduled` handler. Action processing relies on `ctx.waitUntil()` in the `/think` endpoint.
