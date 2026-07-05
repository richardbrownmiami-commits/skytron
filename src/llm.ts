// === Skytron LLM Gateway (AI PROVIDER) ===
// Priority 1: Workers AI — skip if rate-limited today (wa_limited flag in identity table).
// Priority 2: BUDDHI_DWAR gateway — BD's scoring selects best provider.
// Priority 3: OpenRouter direct — maintenance fallback when both WA and BD fail.
// callLLM(env, body, sessionId): auto-cycles through all 3 priorities.
// callOpenRouter(env, messages, max_tokens?): standalone — bypasses WA and BD entirely.
// Workers AI response format: handles both {.response} and {choices:[{message:{content:...}}]}

function timeoutRace(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

// Retry wrapper — handles DNS throttling and transient errors
// Cloudflare Workers get DNS throttled after ~6 rapid fetch() calls to same zone
async function fetchWithRetry(url, opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      const msg = (e.message || "").toLowerCase();
      const isTransient = msg.includes("dns") || msg.includes("resolve") || msg.includes("enotfound")
        || msg.includes("fetch failed") || msg.includes("network") || msg.includes("timeout")
        || msg.includes("abort") || msg.includes("1042") || msg.includes("remote name");
      if (isTransient && attempt < maxRetries) {
        const delay = 3000 * Math.pow(2, attempt); // 3s, 6s, 12s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function isWARateLimited(db) {
  if (!db) return false;
  try {
    const row = await db.prepare("SELECT value FROM identity WHERE key='wa_limited'").first();
    if (!row?.value) return false;
    const today = new Date().toISOString().split("T")[0];
    const [d] = row.value.split(":");
    return d === today;
  } catch { return false; }
}

async function markWARateLimited(db) {
  if (!db) return;
  try {
    const row = await db.prepare("SELECT value FROM identity WHERE key='wa_limited'").first();
    const today = new Date().toISOString().split("T")[0];
    let count = 1;
    if (row?.value) { const [d, c] = row.value.split(":"); if (d === today) count = parseInt(c) + 1; }
    await db.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('wa_limited',?1,datetime('now'))").bind(today + ":" + count).run();
  } catch {}
}

async function clearWARateLimit(db) {
  if (!db) return;
  try { await db.prepare("DELETE FROM identity WHERE key='wa_limited'").run(); } catch {}
}

export async function callLLM(env, body, sessionId) {
  const errors = [];
  const waLimited = await isWARateLimited(env.DB);
  const maxTokens = body.max_tokens || 2000;

  // Priority 1: Workers AI
  if (!waLimited && env.AI) {
    let waReturned = false;
    try {
      const waResult = await Promise.race([
        env.AI.run("@cf/zai-org/glm-4.7-flash", {
          messages: body.messages, max_tokens: maxTokens
        }),
        timeoutRace(25000)
      ]);
      waReturned = true;
      const waText = typeof waResult?.response === "string" ? waResult.response : (waResult?.choices?.[0]?.message?.content || (waResult?.result?.response) || "");
      if (waText) { await clearWARateLimit(env.DB); return { content: waText, model: "workers-ai/glm-4.7-flash", tokens: { total: 0 } }; }
    } catch (e) {
      const errMsg = e.message || "";
      if (!waReturned) errors.push("Workers AI: " + errMsg);
      // Try WA fallback model on timeout
      if (!waReturned && errMsg.includes("timeout")) {
        try {
          const fallback = await Promise.race([
            env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
              messages: body.messages, max_tokens: maxTokens
            }),
            timeoutRace(30000)
          ]);
          const fbText = typeof fallback?.response === "string" ? fallback.response : (fallback?.choices?.[0]?.message?.content || "");
          if (fbText) { await clearWARateLimit(env.DB); return { content: fbText, model: "workers-ai/gemma-4-26b-a4b-it", tokens: { total: 0 } }; }
        } catch (fbErr) { errors.push("WA fallback: " + (fbErr.message || "timeout")); }
      }
      // Mark rate limit if WA hit its daily limit
      if (errMsg.includes("4006") || errMsg.includes("allocation") || errMsg.includes("limit")) {
        await markWARateLimited(env.DB);
        errors.push("Workers AI: rate limited today");
      }
    }
  }

  // Priority 2: BUDDHI_DWAR gateway via public fetch (disabled — WA only mode)
  let bdOk = false;
  const BD_URL = "https://buddhi-dwar.richard-brown-miami.workers.dev";
  if (false && env.BRAIN_KEY) {
    try {
      const task = body.task || "chat";
      const model = body.model || (task === "coding" ? "" : "");
      const reqBody = { messages: body.messages, model, max_tokens: 3000, task };
      const timeoutMs = task === "coding" ? 30000 : 15000;
      const resp = await fetchWithRetry(BD_URL + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      }, 2);
      if (resp.ok) {
        const data = await resp.json();
        const msgContent = data.choices?.[0]?.message?.content;
        if (typeof msgContent === "string" && msgContent.length > 0) {
          bdOk = true;
          if (env.DB) try { await env.DB.prepare("DELETE FROM identity WHERE key='bd_failures'").run(); } catch {}
          return { content: msgContent, model: data.model || "", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
        }
        errors.push("BUDDHI_DWAR: HTTP 200 empty: " + (data.error?.message || JSON.stringify(data).slice(0, 100)));
      } else {
        const errBody = await resp.text().catch(() => "");
        errors.push("BUDDHI_DWAR: HTTP " + resp.status + " " + errBody.slice(0, 100));
      }
    } catch (e) { errors.push("BUDDHI_DWAR: " + (e.message || "timeout")); }
  } else { errors.push("BUDDHI_DWAR: service binding not available"); }

  // Track consecutive BD failures
  if (!bdOk && env.DB) try {
    const row = await env.DB.prepare("SELECT value FROM identity WHERE key='bd_failures'").first();
    const count = (parseInt(row?.value) || 0) + 1;
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('bd_failures',?1,datetime('now'))").bind(String(count)).run();
    if (count >= 3) await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('health_flags','bd_unreachable',datetime('now'))").run();
  } catch {}

  // Priority 3: OpenRouter direct — last resort when WA times out
  if (env.OPENROUTER_API_KEY) {
    const orResult = await callOpenRouter(env, body.messages, maxTokens, body.model || "openrouter/free");
    if (orResult?.content) {
      if (env.DB) try { await env.DB.prepare("DELETE FROM identity WHERE key='bd_failures'").run(); } catch {}
      return orResult;
    }
    if (orResult?.error) errors.push(orResult.error);
  }

  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

// callOpenRouter: direct OpenRouter call — bypasses WA and BD entirely.
// Used by callLLM as Priority 3 and by scheduler for emergency self-repair.
export async function callOpenRouter(env, messages, maxTokens = 2000, model = "openrouter/free") {
  if (!env.OPENROUTER_API_KEY) return { content: null, error: "OPENROUTER_API_KEY not set" };
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.OPENROUTER_API_KEY,
        "HTTP-Referer": "https://github.com/richardbrownmiami-commits/skytron",
        "X-Title": "Skytron"
      },
      body: JSON.stringify({ messages, model, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(25000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const msgContent = data.choices?.[0]?.message?.content;
      if (typeof msgContent === "string" && msgContent.length > 0) {
        return { content: msgContent, model: data.model || model, tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
      }
      return { content: null, error: "OpenRouter: HTTP 200 empty: " + (data.error?.message || JSON.stringify(data).slice(0, 100)) };
    } else {
      const errBody = await resp.text().catch(() => "");
      return { content: null, error: "OpenRouter: HTTP " + resp.status + " " + errBody.slice(0, 100) };
    }
  } catch (e) { return { content: null, error: "OpenRouter: " + (e.message || "timeout") }; }
}

// === Chat Agent ===
// Simple one-shot LLM call using Workers AI (no tool context).
// Used by the agent loop fast path.
export async function callChatAgent(env, fullHistory, task = "chat") {
  if (!env.AI) return null;
  try {
    const result = await Promise.race([
      env.AI.run("@cf/zai-org/glm-4.7-flash", {
        messages: fullHistory, max_tokens: 2000
      }),
      timeoutRace(25000)
    ]);
    const content = typeof result?.response === "string" ? result.response : (result?.choices?.[0]?.message?.content || "");
    if (content) return { content, model: "workers-ai/glm-4.7-flash", tokens: { total: 0 } };
  } catch {}
  // Try fallback on timeout
  try {
    const fallback = await Promise.race([
      env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
        messages: fullHistory, max_tokens: 2000
      }),
      timeoutRace(30000)
    ]);
    const fbContent = typeof fallback?.response === "string" ? fallback.response : (fallback?.choices?.[0]?.message?.content || "");
    if (fbContent) return { content: fbContent, model: "workers-ai/gemma-4-26b-a4b-it", tokens: { total: 0 } };
  } catch {}
  return null;
}

export function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}
