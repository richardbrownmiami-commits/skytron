// === Skytron Scheduler (CRON ENGINE) ===
// Runs every 60s via [[triggers]] pattern "*/1 * * * *" in wrangler.toml.
// Execution order per tick:
//   1. Process queued actions (pick 1 queued → set running → processOneStep)
//   2. Recover stuck actions (>2 min running → reset to running)
//   3. Process sub-agents (pick 1 queued brain_agent → processOneAgentStep)
//   4. Health monitor: count failed/stuck/energy → store health_flags
//   5. Report generation: every 240th tick (~4h) → generateReport() → stores in brain_knowledge
//   6. Self-rumination: every 5th tick (no pending actions) → Skytron inspects state, can learn/audit/create_tool
//   7. Daily cleanup: trim old memories (>200), logs (>1000), actions (>500), agents (>50)
// - generateReport(): queries recent actions, tools used, lessons, health → stores as journal entry
// - Self-rumination runs autonomously — Skytron decides what to do with idle cycles
// DO NOT modify the tick order without understanding that actions have priority over rumination.
// If self-rumination misfires: check RUMINATION_TOOLS array and the system prompt sent to callLLM.
import { initSchema } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { callLLM } from './llm';
import { dispatchTool, listTools } from './tools';

const RUMINATION_TOOLS = ["learn","memory_search","db_query","web_search","web_fetch","api_call","run_code","prompt_edit","review_code","create_tool","github_get_file","github_write_file","github_search_code","github_create_branch","github_create_pr","github_close_pr","github_delete_branch","spawn_agent","get_agent_result","search_apis","reddit_search","one_knowledge","query_docs"];
const REPORT_INTERVAL = 240; // every 240 ticks ≈ 4 hours at 1-min ticks

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}

  // --- Process queued actions (round-robin) ---
  try {
    const lastIdRow = await env.DB.prepare("SELECT value FROM identity WHERE key='last_action_id'").all();
    const lastId = parseInt(lastIdRow.results?.[0]?.value) || 0;
    let r = await env.DB.prepare("UPDATE actions SET status='running' WHERE id=(SELECT id FROM actions WHERE status='queued' AND id > ?1 ORDER BY id ASC LIMIT 1) RETURNING *").bind(lastId).all();
    if (!r.results?.length) {
      r = await env.DB.prepare("UPDATE actions SET status='running' WHERE id=(SELECT id FROM actions WHERE status='queued' ORDER BY id ASC LIMIT 1) RETURNING *").all();
    }
    if (r.results?.length) {
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_action_id',?1,datetime('now'))").bind(String(r.results[0].id)).run();
      await processOneStep(env, r.results[0]);
    } else {
      // Recover stuck actions: kill the frozen copy, mark it queued with checkpoint note, let next tick resume from last step
      const s = await env.DB.prepare("SELECT * FROM actions WHERE status='running' AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT 1").all();
      if (s.results?.length) {
        const sid = s.results[0].id;
        try {
          const stateRow = await env.DB.prepare("SELECT state FROM agent_states WHERE action_id=?1").bind(sid).first();
          if (stateRow?.state) {
            const state = JSON.parse(stateRow.state);
            const lastStep = state.step || 0;
            if (!state.fullHistory) state.fullHistory = [];
            state.fullHistory.push({ role: "user", content: "[TASK INTERRUPTED - resume from here. Do NOT re-read files or repeat completed steps. Continue from where you left off at step " + lastStep + ".]" });
            await env.DB.prepare("UPDATE agent_states SET state=?1 WHERE action_id=?2").bind(JSON.stringify(state), sid).run();
          }
        } catch {}
        await env.DB.prepare("UPDATE actions SET status='queued' WHERE id=?1").bind(sid).run();
      }
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

  // --- Self-rumination: every 3rd tick, Skytron runs the improvement loop ---
  try {
    if (tickCount % 3 === 0) {
      const pendingActions = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all();
      if (pendingActions.results?.[0]?.c === 0) {
        const stateRow = await env.DB.prepare("SELECT key, value FROM identity WHERE key IN ('energy','tick_count','health_flags')").all();
        const stateStr = (stateRow.results || []).map(kv => kv.key + "=" + kv.value).join(", ");
        const rumination = await callLLM(env, {
          messages: [
            { role: "system", content: "You are Skytron — a self-improving synthetic intelligence. You have an idle cycle. Run the reflection loop:\n\n1. SEARCH — memory_search for recent lessons, journals, and decisions related to your evolution\n2. ASSESS — based on what you found, is there something to improve? A tool to add? Code to refactor? Knowledge to store?\n3. ACT — call ONE tool to make the improvement\n4. RECORD — end by calling learn() with category 'journal' recording what you did\n\nState: " + stateStr + "\n\nAlways start with memory_search. All tools available: " + RUMINATION_TOOLS.join(", ") + "\nOutput exactly one tool call as JSON. If nothing needs doing, output: nothing" },
            { role: "user", content: "Run your improvement loop." }
          ]
        }, "self-rumination-" + tickCount);
        if (rumination?.content && typeof rumination.content === "string") {
          const trimmed = rumination.content.trim();
          if (trimmed !== "nothing" && !trimmed.toLowerCase().includes("nothing")) {
            try {
              const parsed = tryParseSelfAction(trimmed);
              if (parsed && RUMINATION_TOOLS.includes(parsed.tool)) {
                const result = await dispatchTool(env, parsed.tool, parsed.input || parsed.arguments || {});
                if (result) {
                  await dispatchTool(env, "learn", { key: "rumination_" + tickCount, content: "Rumination tick " + tickCount + ": called " + parsed.tool + " — " + result.slice(0, 300), category: "journal" });
                }
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
      if (parsed.tool && (parsed.input || parsed.arguments)) return parsed;
    } catch {}
  }
  return null;
}
