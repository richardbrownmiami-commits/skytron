// Cron scheduler: runs every minute via [[triggers]]. Processes 1 action + 1 agent step per tick. Self-rumination every 5 ticks.
import { initSchema } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { callLLM } from './llm';
import { dispatchTool } from './tools';

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}
  try {
    const r = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
    if (r.results?.length) {
      await processOneStep(env, r.results[0]);
    } else {
      const s = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='running' AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
      if (s.results?.length) await processOneStep(env, s.results[0]);
    }
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NOT NULL AND updated_at < datetime('now', '-2 minutes')").run();
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NULL AND created_at < datetime('now', '-2 minutes')").run();
    const ar = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 1").all();
    if (ar.results?.length) {
      await processOneAgentStep(env, ar.results[0]);
    }
  } catch (e) { console.error("cron error:", e); }

  // Self-rumination: every 5th tick, Skytron initiates its own action
  try {
    let tickCount = 0;
    const tickRow = await env.DB.prepare("SELECT value FROM identity WHERE key='tick_count'").all();
    if (tickRow.results?.length) tickCount = parseInt(tickRow.results[0].value) || 0;
    tickCount++;
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('tick_count',?1,datetime('now'))").bind(String(tickCount)).run();
    if (tickCount % 5 === 0) {
      const pendingActions = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all();
      if (pendingActions.results?.[0]?.c === 0) {
        const stateRow = await env.DB.prepare("SELECT key, value FROM identity WHERE key IN ('energy','tick_count')").all();
        const stateStr = (stateRow.results || []).map(kv => kv.key + "=" + kv.value).join(", ");
        const rumination = await callLLM(env, {
          messages: [
            { role: "system", content: "You are Skytron. You have idle cycles. Review your state and decide if anything needs your attention.\nState: " + stateStr + "\n\nIf something useful can be done (learn a fact, search knowledge, audit code, improve yourself), output a tool call: {\"tool\":\"name\",\"input\":{...}}\nAllowed tools for self-rumination: learn, db_query, web_search.\nIf nothing needs doing, output: nothing" },
            { role: "user", content: "What should I do with these idle cycles?" }
          ]
        }, "self-rumination-" + tickCount);
        if (rumination?.content && typeof rumination.content === "string") {
          const trimmed = rumination.content.trim();
          if (trimmed !== "nothing" && !trimmed.toLowerCase().includes("nothing")) {
            try {
              const parsed = tryParseSelfAction(trimmed);
              if (parsed && ["learn","db_query","web_search"].includes(parsed.tool)) {
                const result = await dispatchTool(env, parsed.tool, parsed.input);
                console.error("Self-rumination [" + parsed.tool + "]: " + (result || "no result").slice(0, 200));
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) { console.error("self-rumination error:", e); }

  try {
    const lastClean = await env.DB.prepare("SELECT value FROM identity WHERE key='last_cleanup_date'").all();
    const today = new Date().toISOString().split("T")[0];
    if (lastClean.results?.[0]?.value !== today) {
      const deleted = await env.DB.prepare("DELETE FROM brain_memory WHERE id NOT IN (SELECT id FROM brain_memory ORDER BY id DESC LIMIT 200) AND created_at < datetime('now', '-7 days')").run();
      const logTrim = await env.DB.prepare("DELETE FROM brain_logs WHERE id NOT IN (SELECT id FROM brain_logs ORDER BY id DESC LIMIT 1000)").run();
      const actTrim = await env.DB.prepare("DELETE FROM actions WHERE status='done' AND id NOT IN (SELECT id FROM actions WHERE status='done' ORDER BY id DESC LIMIT 500)").run();
      const agentTrim = await env.DB.prepare("DELETE FROM brain_agents WHERE status IN ('done','error') AND id NOT IN (SELECT id FROM brain_agents WHERE status IN ('done','error') ORDER BY id DESC LIMIT 50)").run();
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_cleanup_date',?1,datetime('now'))").bind(today).run();
      console.error("Cleanup: removed " + (deleted.meta?.changes||0) + " old memories, " + (logTrim.meta?.changes||0) + " logs, " + (actTrim.meta?.changes||0) + " actions, " + (agentTrim.meta?.changes||0) + " agents");
    }
  } catch (e) { console.error("cleanup error:", e); }
}

function tryParseSelfAction(text) {
  const jsonMatch = text.match(/\{(?:[^{}]|"(?:\\.|[^"\\])*")*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && parsed.input) return parsed;
    } catch {}
  }
  return null;
}
