// === Skytron LLM Gateway (AI PROVIDER) ===
// Priority 1: Workers AI (GLM-4.7-Flash) — fast, cheap, always available.
// Priority 2: BUDDHI_DWAR gateway (5 providers: groq/openrouter/mistral/google/opencode-zen) — fallback.
// - callLLM(env, body, sessionId): tries Workers AI first, BD second
// - parseLLMJson: extracts JSON from LLM responses
// - MODEL_OVERRIDE env var can force a specific model (used for coding tasks: deepseek-v4-flash-free)
// - Workers AI response format: handles both {.response} and {choices:[{message:{content:...}}]}
// DO NOT add provider-specific API keys here. They're managed by BUDDHI_DWAR.

function timeoutRace(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

const AI_MODEL = "@cf/zai-org/glm-4.7-flash";

export async function callLLM(env, body, sessionId) {
  const errors = [];
  // Check if WA hit rate limit 2+ times today — skip if so
  let waSkipped = false;
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT value FROM identity WHERE key='wa_limited'").first();
      if (row?.value) {
        const [date, count] = row.value.split(":");
        if (date === new Date().toISOString().split("T")[0] && parseInt(count) >= 2) waSkipped = true;
      }
    } catch {}
  }
  // Priority 1: Workers AI (GLM-4.7-Flash)
  if (env.AI && !waSkipped) {
    try {
      const waResult = await Promise.race([
        env.AI.run(AI_MODEL, {
          messages: body.messages, max_tokens: 2000
        }),
        timeoutRace(60000)
      ]);
      const waText = typeof waResult?.response === "string" ? waResult.response : (waResult?.choices?.[0]?.message?.content || (waResult?.result?.response) || "");
      if (waText) {
        if (env.DB) try { await env.DB.prepare("DELETE FROM identity WHERE key='wa_limited'").run(); } catch {}
        return { content: waText, model: "workers-ai/glm-4.7-flash", tokens: { total: 0 } };
      }
    } catch (e) {
      const errMsg = e.message || "";
      errors.push("Workers AI: " + errMsg);
      if (errMsg.includes("4006") || errMsg.includes("allocation") || errMsg.includes("limit")) {
        if (env.DB) try {
          const row = await env.DB.prepare("SELECT value FROM identity WHERE key='wa_limited'").first();
          const today = new Date().toISOString().split("T")[0];
          let count = 1;
          if (row?.value) { const [d, c] = row.value.split(":"); if (d === today) count = parseInt(c) + 1; }
          await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('wa_limited',?1,datetime('now'))").bind(today + ":" + count).run();
        } catch {}
      }
    }
  }
  // Priority 2: BUDDHI_DWAR fallback
  let bdOk = false;
  if (env.BUDDHI_DWAR) {
    try {
      const reqBody = { messages: body.messages, model: body.model || "", max_tokens: 3000, task: body.task || "chat" };
      const resp = await Promise.race([
        env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
          body: JSON.stringify(reqBody)
        }),
        timeoutRace(60000)
      ]);
      if (resp.ok) {
        const data = await resp.json();
        const msgContent = data.choices?.[0]?.message?.content;
        if (typeof msgContent === "string") {
          bdOk = true;
          return { content: msgContent, model: data.model || "", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
        }
      }
      const errBody = await resp.text().catch(() => "");
      errors.push("BUDDHI_DWAR: HTTP " + resp.status + " " + errBody.slice(0, 100));
    } catch (e) {
      errors.push("BUDDHI_DWAR: " + (e.message || "timeout"));
    }
  } else {
    errors.push("BUDDHI_DWAR: binding not available");
  }
  // Track BD failures — reset on success, flag health after 3 consecutive
  if (env.DB) try {
    if (bdOk) {
      await env.DB.prepare("DELETE FROM identity WHERE key='bd_failures'").run();
    } else {
      const row = await env.DB.prepare("SELECT value FROM identity WHERE key='bd_failures'").first();
      const count = (parseInt(row?.value) || 0) + 1;
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('bd_failures',?1,datetime('now'))").bind(String(count)).run();
      if (count >= 3) {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('health_flags','bd_unreachable',datetime('now'))").run();
      }
    }
  } catch {}
  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

export function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}
