// === Skytron LLM Gateway (AI PROVIDER) ===
// Reads enabled providers from brain_knowledge settings_llm and tries them in order:
//   1. Workers AI (if enabled + binding exists)
//   2. BUDDHI_DWAR (if enabled + api_key provided)
//   3. Universal AI (if enabled + endpoint + api_key configured)
// First provider that returns a valid response wins.
// callOpenRouter() kept as standalone emergency utility (used by scheduler).

function timeoutRace(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

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
        const delay = 3000 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const DEFAULT_SETTINGS = {
  workers_ai: { enabled: true },
  buddhidwar: { enabled: false, api_key: "" },
  universal: { enabled: false, endpoint: "", api_key: "", model: "" }
};

export async function callLLM(env, body, sessionId) {
  const maxTokens = body.max_tokens || 2000;
  const errors = [];

  // Load settings from brain_knowledge
  let settings = { ...DEFAULT_SETTINGS };
  try {
    if (env.DB) {
      const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key='settings_llm'").first();
      if (row?.content) {
        const parsed = JSON.parse(row.content);
        if (parsed.workers_ai) settings.workers_ai = { ...settings.workers_ai, ...parsed.workers_ai };
        if (parsed.buddhidwar) settings.buddhidwar = { ...settings.buddhidwar, ...parsed.buddhidwar };
        if (parsed.universal) settings.universal = { ...settings.universal, ...parsed.universal };
      }
    }
  } catch {}

  // Priority 1: Workers AI
  if (settings.workers_ai?.enabled !== false && env.AI) {
    try {
      const waResult = await Promise.race([
        env.AI.run("@cf/zai-org/glm-4.7-flash", {
          messages: body.messages, max_tokens: maxTokens
        }),
        timeoutRace(20000)
      ]);
      const waText = typeof waResult?.response === "string" ? waResult.response : (waResult?.choices?.[0]?.message?.content || (waResult?.result?.response) || "");
      if (waText) return { content: waText, model: "workers-ai/glm-4.7-flash", tokens: { total: 0 } };
    } catch (e) {
      errors.push("Workers AI: " + (e.message || "timeout"));
    }
  }

  // Priority 2: BUDDHI_DWAR
  if (settings.buddhidwar?.enabled && settings.buddhidwar?.api_key) {
    const BD_URL = "https://buddhi-dwar.richard-brown-miami.workers.dev";
    try {
      const model = body.model || "gemini-2.5-flash";
      const timeoutMs = Math.max(20000, maxTokens * 8);
      const resp = await fetchWithRetry(BD_URL + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.buddhidwar.api_key },
        body: JSON.stringify({ messages: body.messages, model, max_tokens: maxTokens || 3000, task: body.task || "chat" }),
        signal: AbortSignal.timeout(timeoutMs)
      }, 2);
      if (resp.ok) {
        const data = await resp.json();
        const msgContent = data.choices?.[0]?.message?.content;
        if (typeof msgContent === "string" && msgContent.length > 0) {
          return { content: msgContent, model: data.model || model, tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
        }
        errors.push("BUDDHI_DWAR: HTTP 200 empty");
      } else {
        const errBody = await resp.text().catch(() => "");
        errors.push("BUDDHI_DWAR: HTTP " + resp.status + " " + errBody.slice(0, 100));
      }
    } catch (e) { errors.push("BUDDHI_DWAR: " + (e.message || "timeout")); }
  }

  // Priority 3: Universal AI API (OpenAI-compatible)
  if (settings.universal?.enabled && settings.universal?.api_key && settings.universal?.endpoint) {
    try {
      const model = settings.universal.model || "gpt-4o";
      const resp = await fetchWithRetry(settings.universal.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + settings.universal.api_key
        },
        body: JSON.stringify({
          model,
          messages: body.messages,
          max_tokens: maxTokens
        }),
        signal: AbortSignal.timeout(30000)
      }, 2);
      if (resp.ok) {
        const data = await resp.json();
        const msgContent = data.choices?.[0]?.message?.content;
        if (typeof msgContent === "string" && msgContent.length > 0) {
          return { content: msgContent, model: data.model || model, tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
        }
        errors.push("Universal: HTTP 200 empty");
      } else {
        const errBody = await resp.text().catch(() => "");
        errors.push("Universal: HTTP " + resp.status + " " + errBody.slice(0, 100));
      }
    } catch (e) { errors.push("Universal: " + (e.message || "timeout")); }
  }

  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

// callOpenRouter: standalone — bypasses settings entirely, calls OpenRouter directly.
// Used by scheduler for emergency self-repair.
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

// Chat Agent: simple one-shot Workers AI call (no tools). Kept for backward compat.
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
