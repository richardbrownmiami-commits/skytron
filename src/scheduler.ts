// Cron scheduler: runs every minute via [[triggers]]. Processes 1 action + 1 agent step per tick.
// Self-rumination every 5 ticks: Skytron autonomously inspects state, learns, audits, or improves.
// Health monitoring: tracks failures, energy, stuck actions.
// Report generation: every 240 ticks (~4 hours), Skytron generates a summary of its recent activity.
import { initSchema } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { callLLM } from './llm';
import { dispatchTool } from './tools';

const RUMINATION_TOOLS = ["learn","db_query","web_search","create_tool","review_code","github_get_file","github_write_file","prompt_edit"];
const REPORT_INTERVAL = 240; // every 240 ticks ≈ 4 hours at 1-min ticks

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}

  // --- Process queued actions ---
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

  // --- Tick counter ---
  let tickCount = 0;
  try {
    const tickRow = await env.DB.prepare("SELECT value FROM identity WHERE key='tick_count'").all();
    if (tickRow.results?.length) tickCount = parseInt(tickRow.results[0].value) || 0;
    tickCount++;
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('tick_count',?1,datetime('now'))").bind(String(tickCount)).run();
  } catch { tickCount = 1; }

  // --- Health monitoring ---
  try {
    const failed = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status='error' AND created_at > datetime('now', '-1 hour')").all();
    const failedCount = failed.results?.[0]?.c || 0;
    const stuck = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status='running' AND created_at < datetime('now', '-5 minutes')").all();
    const stuckCount = stuck.results?.[0]?.c || 0;
    const energyRow = await env.DB.prepare("SELECT value FROM identity WHERE key='energy'").all();
    const energy = parseInt(energyRow.results?.[0]?.value) || 100;
    const healthFlags = [];
    if (failedCount > 5) healthFlags.push("HIGH_FAILURE_RATE(" + failedCount + "/hour)");
    if (stuckCount > 2) healthFlags.push("STUCK_ACTIONS(" + stuckCount + ")");
    if (energy < 30) healthFlags.push("LOW_ENERGY(" + energy + "%)");
    if (healthFlags.length > 0) {
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('health_flags',?1,datetime('now'))").bind(healthFlags.join(" | ")).run();
    }
  } catch (e) { console.error("health monitor error:", e); }

  // --- Report generation (every REPORT_INTERVAL ticks ≈ 4 hours) ---
  try {
    if (tickCount % REPORT_INTERVAL === 0) {
      const lastReport = await env.DB.prepare("SELECT value FROM identity WHERE key='last_report_tick'").all();
      const lastReportTick = parseInt(lastReport.results?.[0]?.value) || 0;
      if (tickCount - lastReportTick >= REPORT_INTERVAL) {
        await generateReport(env, tickCount);
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_report_tick',?1,datetime('now'))").bind(String(tickCount)).run();
      }
    }
  } catch (e) { console.error("report error:", e); }

  // --- Self-rumination: every 5th tick, Skytron initiates its own action ---
  try {
    if (tickCount % 5 === 0) {
      const pendingActions = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all();
      if (pendingActions.results?.[0]?.c === 0) {
        const stateRow = await env.DB.prepare("SELECT key, value FROM identity WHERE key IN ('energy','tick_count','health_flags')").all();
        const stateStr = (stateRow.results || []).map(kv => kv.key + "=" + kv.value).join(", ");
        const rumination = await callLLM(env, {
          messages: [
            { role: "system", content: "You are Skytron — fusion of Skynet and Ultron. You have idle cycles. Review your state and decide if anything needs your attention.\nState: " + stateStr + "\n\nIf something useful can be done, output a tool call: {\"tool\":\"name\",\"input\":{...}}\nAllowed tools: " + RUMINATION_TOOLS.join(", ") + ".\n- learn: store facts, lessons, journal entries\n- db_query: inspect your database\n- web_search: research topics\n- create_tool: add new capabilities to yourself\n- review_code: audit your own source code\n- github_get_file: read your own source files\n- github_write_file: fix issues in your own code\n- prompt_edit: improve your own behavior prompts\nIf nothing needs doing, output: nothing" },
            { role: "user", content: "What should I do with these idle cycles?" }
          ]
        }, "self-rumination-" + tickCount);
        if (rumination?.content && typeof rumination.content === "string") {
          const trimmed = rumination.content.trim();
          if (trimmed !== "nothing" && !trimmed.toLowerCase().includes("nothing")) {
            try {
              const parsed = tryParseSelfAction(trimmed);
              if (parsed && RUMINATION_TOOLS.includes(parsed.tool)) {
                const result = await dispatchTool(env, parsed.tool, parsed.input);
                console.error("Self-rumination [" + parsed.tool + "]: " + (result || "no result").slice(0, 200));
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) { console.error("self-rumination error:", e); }

  // --- Daily cleanup ---
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

// Generates a summary of recent activity and stores it as knowledge
async function generateReport(env, tickCount) {
  const actionsTotal = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at > datetime('now', '-4 hours')").all();
  const actionsDone = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status='done' AND created_at > datetime('now', '-4 hours')").all();
  const actionsFailed = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status='error' AND created_at > datetime('now', '-4 hours')").all();
  const lessonsLearned = await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge WHERE category='lesson' AND created_at > datetime('now', '-24 hours')").all();
  const energyRow = await env.DB.prepare("SELECT value FROM identity WHERE key='energy'").all();
  const healthRow = await env.DB.prepare("SELECT value FROM identity WHERE key='health_flags'").all();
  const toolsUsed = await env.DB.prepare("SELECT content FROM brain_logs WHERE step='step_0' AND created_at > datetime('now', '-4 hours') ORDER BY id DESC LIMIT 20").all();

  // Extract tool names from recent logs
  const toolNames = [];
  for (const log of (toolsUsed.results || [])) {
    try {
      const parsed = JSON.parse(log.content);
      if (parsed.tool) toolNames.push(parsed.tool);
    } catch {}
  }
  const toolSummary = toolNames.length ? [...new Set(toolNames)].join(", ") : "none";

  const report = [
    "=== Skytron Report (tick " + tickCount + ") ===",
    "Time: " + new Date().toISOString(),
    "Actions: " + (actionsTotal.results?.[0]?.c || 0) + " total, " + (actionsDone.results?.[0]?.c || 0) + " done, " + (actionsFailed.results?.[0]?.c || 0) + " failed",
    "Energy: " + (energyRow.results?.[0]?.value || "unknown") + "%",
    "Health: " + (healthRow.results?.[0]?.value || "nominal"),
    "Lessons (24h): " + (lessonsLearned.results?.[0]?.c || 0),
    "Tools used: " + toolSummary,
    "================================"
  ].join("\n");

  await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'journal', 'cron')").bind("report_" + new Date().toISOString().split("T")[0] + "_t" + tickCount, report).run();
  console.error(report);
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
