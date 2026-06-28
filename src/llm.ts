// === Skytron LLM Gateway (AI PROVIDER) ===
// Routes all LLM calls through BUDDHI_DWAR gateway (5 providers, 10s timeout each).
// Provider order: groq, openrouter, mistral, google, opencode-zen. Each tried in sequence until one succeeds.
// Falls back to Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast) if all BD providers fail.
// - callLLM(env, body, sessionId): sends messages + optional model override + task to BD
// - parseLLMJson: extracts JSON from LLM responses
// - MODEL_OVERRIDE env var can force a specific model (used for coding tasks: deepseek-v4-flash-free)
// - Workers AI response format: handles both {.response} and {choices:[{message:{content:...}}]}
// DO NOT add provider-specific API keys here. They're managed by BUDDHI_DWAR.
// If Skytron gets stuck at step_0 repeatedly, check if BD is healthy or Workers AI fallback is needed.

function timeoutRace(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

export async function callLLM(env, body, sessionId) {
  if (!env.BUDDHI_DWAR) return null;
  const errors = [];
  try {
    const reqBody = { messages: body.messages, model: body.model || "", max_tokens: 3000, task: body.task || "chat" };
    const resp = await Promise.race([
      env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
        body: JSON.stringify(reqBody)
      }),
      timeoutRace(30000)
    ]);
    if (resp.ok) {
      const data = await resp.json();
      const msgContent = data.choices?.[0]?.message?.content;
      if (typeof msgContent === "string")
        return { content: msgContent, model: data.model || "", tokens: data.usage || { total: 0 }, finish_reason: data.choices?.[0]?.finish_reason || "" };
    }
    const errBody = await resp.text().catch(() => "");
    errors.push("BUDDHI_DWAR: HTTP " + resp.status + " " + errBody.slice(0, 100));
  } catch (e) {
    errors.push("BUDDHI_DWAR: " + (e.message || "timeout"));
  }
  // Last resort: Workers AI via native binding
  if (env.AI) {
    try {
      const waResult = await Promise.race([
        env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: body.messages, max_tokens: 2000
        }),
        timeoutRace(60000)
      ]);
      const waText = typeof waResult?.response === "string" ? waResult.response : (waResult?.choices?.[0]?.message?.content || (waResult?.result?.response) || "");
      if (waText) return { content: waText, model: "workers-ai/llama-3.3-70b", tokens: { total: 0 } };
    } catch {}
  }
  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

export function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}
