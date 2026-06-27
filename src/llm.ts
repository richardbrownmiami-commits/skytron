import { CF_AI } from './constants';

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
  // Last resort: Workers AI free model via CF API
  if (env.CF_API_TOKEN) {
    try {
      const waResp = await fetch("https://api.cloudflare.com/client/v4/accounts/" + CF_AI.account + "/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        method: "POST", headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: body.messages, max_tokens: 2000 }), signal: AbortSignal.timeout(60000)
      });
      if (waResp.ok) {
        const waData = await waResp.json();
        const waContent = waData.result?.response;
        if (typeof waContent === "string") return { content: waContent, model: "workers-ai/llama-3.3-70b", tokens: { total: 0 } };
      }
    } catch {}
  }
  return { content: null, errors, model: "none", tokens: { total: 0 } };
}

export function parseLLMJson(text) {
  text = text.replace(/\\'/g, "'");
  text = text.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(text);
}
