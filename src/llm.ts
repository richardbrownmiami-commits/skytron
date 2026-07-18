// === Skytron LLM Gateway (AI PROVIDER) ===
// Two modes:
//   TOOL MODE (hasTools): Workers AI REST → Universal
//   CHAT MODE (no tools): BD → Workers AI REST → Universal

import { CF_AI } from './constants';

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
  workers_ai: { enabled: true, api_key: "" },
  buddhidwar: { enabled: false, api_key: "" },
  universal: { enabled: false, endpoint: "", api_key: "", model: "" }
};

// Shared response parser for all providers
function parseChatResponse(data, defaultModel) {
  if (!data?.choices?.[0]?.message) return null;
  const msg = data.choices[0].message;
  return {
    content: msg.content || "",
    tool_calls: msg.tool_calls || null,
    model: data.model || defaultModel || "unknown",
    tokens: data.usage || { total: 0 },
    finish_reason: data.choices[0].finish_reason || ""
  };
}

export async function callLLM(env, body, sessionId) {
  const maxTokens = body.max_tokens || 2000;
  const hasTools = body.tools && Array.isArray(body.tools) && body.tools.length > 0;
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

  if (hasTools) {
    // === TOOL MODE: Workers AI REST → Universal ===
    // Workers AI via REST endpoint (supports tools param), then Universal as fallback

    if (settings.workers_ai?.enabled !== false && env.CF_API_TOKEN) {
      const WA_TOOL_MODEL = "@cf/zai-org/glm-4.7-flash";
      try {
        const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CF_API_TOKEN },
          body: JSON.stringify({
            model: WA_TOOL_MODEL,
            messages: body.messages,
            tools: body.tools,
            max_tokens: Math.min(maxTokens, 4000)
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) {
          const data = await resp.json();
          const parsed = parseChatResponse(data, "workers-ai/" + WA_TOOL_MODEL.split("/").pop());
          if (parsed) return parsed;
          errors.push("Workers AI tools: HTTP 200 empty");
        } else {
          const errBody = await resp.text().catch(() => "");
          errors.push("Workers AI tools: HTTP " + resp.status + " " + errBody.slice(0, 80));
        }
      } catch (e) { errors.push("Workers AI tools: " + (e.message || "timeout")); }
    }

    // Universal AI (if configured) — tools fallback
    if (settings.universal?.enabled && settings.universal?.api_key && settings.universal?.endpoint) {
      try {
        const model = settings.universal.model || "";
        const reqBody = { messages: body.messages, max_tokens: maxTokens, tools: body.tools };
        if (model) reqBody.model = model;
        const resp = await fetchWithRetry(settings.universal.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.universal.api_key },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(45000)
        }, 2);
        if (resp.ok) {
          const data = await resp.json();
          const parsed = parseChatResponse(data, settings.universal.model || "universal");
          if (parsed) return parsed;
          errors.push("Universal tools: HTTP 200 empty");
        } else {
          const errBody = await resp.text().catch(() => "");
          errors.push("Universal tools: HTTP " + resp.status + " " + errBody.slice(0, 100));
        }
      } catch (e) { errors.push("Universal tools: " + (e.message || "timeout")); }
    }

  } else {
    // === CHAT MODE: BD → Workers AI REST → Universal ===

    // Priority 1: BUDDHI_DWAR (auto-selects fastest model)
    if (settings.buddhidwar?.enabled && settings.buddhidwar?.api_key) {
      const BD_URL = "https://buddhi-dwar.richard-brown-miami.workers.dev";
      const timeoutMs = Math.max(20000, maxTokens * 8);
      try {
        const resp = await fetchWithRetry(BD_URL + "/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.buddhidwar.api_key },
          body: JSON.stringify({ messages: body.messages, max_tokens: maxTokens, task: body.task || "chat" }),
          signal: AbortSignal.timeout(timeoutMs)
        }, 1);
        if (resp.ok) {
          const data = await resp.json();
          const msgContent = data.choices?.[0]?.message?.content;
          if (typeof msgContent === "string" && msgContent.length > 0) {
            return { content: msgContent, model: data.model || "buddhidwar", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
          }
          errors.push("BD: HTTP 200 empty");
        } else {
          const errBody = await resp.text().catch(() => "");
          errors.push("BD: HTTP " + resp.status + " " + errBody.slice(0, 80));
        }
      } catch (e) { errors.push("BD: " + (e.message || "timeout")); }
    }

    // Priority 2: Workers AI (REST API with user's API key)
    if (settings.workers_ai?.enabled !== false && settings.workers_ai?.api_key) {
      try {
        const resp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.workers_ai.api_key },
          body: JSON.stringify({
            model: "@cf/meta/llama-3-8b-instruct",
            messages: body.messages,
            max_tokens: maxTokens
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (resp.ok) {
          const data = await resp.json();
          const msgContent = data.choices?.[0]?.message?.content;
          if (typeof msgContent === "string" && msgContent.length > 0) {
            return { content: msgContent, model: data.model || "workers-ai", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
          }
          errors.push("Workers AI: HTTP 200 empty");
        } else {
          const errBody = await resp.text().catch(() => "");
          errors.push("Workers AI: HTTP " + resp.status + " " + errBody.slice(0, 80));
        }
      } catch (e) { errors.push("Workers AI: " + (e.message || "timeout")); }
    }

    // Priority 3: Universal AI (chat mode, no tools)
    if (settings.universal?.enabled && settings.universal?.api_key && settings.universal?.endpoint) {
      try {
        const model = settings.universal.model || "";
        const reqBody = { messages: body.messages, max_tokens: maxTokens };
        if (model) reqBody.model = model;
        const resp = await fetchWithRetry(settings.universal.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.universal.api_key },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(30000)
        }, 2);
        if (resp.ok) {
          const data = await resp.json();
          const msgContent = data.choices?.[0]?.message?.content;
          if (typeof msgContent === "string" && msgContent.length > 0) {
            return { content: msgContent, model: data.model || settings.universal.model || "universal", tokens: data.usage || { total: 0 } };
          }
          errors.push("Universal: HTTP 200 empty");
        } else {
          const errBody = await resp.text().catch(() => "");
          errors.push("Universal: HTTP " + resp.status + " " + errBody.slice(0, 100));
        }
      } catch (e) { errors.push("Universal: " + (e.message || "timeout")); }
    }
  }

  if (errors.length && env.DB) {
    try {
      const errorSummary = errors.join(" | ").slice(0, 500);
      await env.DB.prepare("INSERT INTO brain_logs (action_id, step, content, model) VALUES (?1, ?2, ?3, ?4)").bind(sessionId || "0", "llm_fail", errorSummary, "error").run();
    } catch {}
  }
  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

// Chat Agent: simple one-shot Workers AI call (no tools). Kept for backward compat.
export async function callChatAgent(env, fullHistory, task = "chat") {
  if (!env.AI) return null;
  const models = ["@cf/meta/llama-3.2-3b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
  for (const m of models) {
    try {
      const result = await Promise.race([
        env.AI.run(m, { messages: fullHistory, max_tokens: 2000 }),
        timeoutRace(12000)
      ]);
      const content = typeof result?.response === "string" ? result.response : (result?.choices?.[0]?.message?.content || "");
      if (content) return { content, model: "workers-ai/" + m.split("/").pop(), tokens: { total: 0 } };
    } catch {}
  }
  return null;
}

export function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}
