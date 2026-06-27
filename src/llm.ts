// LLM gateway: calls BUDDHI_DWAR (primary) with 5 providers + 10s timeout each. Falls back to Workers AI 70B on failure. Model-agnostic — no rejection by model name.

export async function callLLM(env, body, sessionId) {
  if (!env.BUDDHI_DWAR) return null;
  const errors = [];
  try {
    const reqBody = { messages: body.messages, model: body.model || "", max_tokens: 3000, task: body.task || "chat" };
    const resp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BRAIN_KEY },
      body: JSON.stringify(reqBody), signal: AbortSignal.timeout(30000)
    });
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
      const waResult = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: body.messages, max_tokens: 2000
      }, { signal: AbortSignal.timeout(60000) });
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
