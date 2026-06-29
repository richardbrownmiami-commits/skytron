// === Skytron Scheduler (CRON ENGINE) ===
// Runs every 60s via [[triggers]] pattern "*/1 * * * *" in wrangler.toml.
// Execution order per tick:
//   1. Process queued actions (pick 1 queued → set running → processOneStep)
//   2. Recover stuck actions (>2 min running → reset with checkpoint)
//   3. Process sub-agents (pick 1 queued brain_agent → processOneAgentStep)
//   4. Tick counter (persisted in identity table)
//   5. Skytron Decision Cycle (when idle) — Skytron receives state + capabilities list, calls ONE tool
//      He can edit capabilities via prompt_edit(slot="cron", prompt="...")
//   6. Daily cleanup: trim old memories (>200), logs (>1000), actions (>500), agents (>50)
import { initSchema } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { callLLM } from './llm';
import { dispatchTool } from './tools';

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
            state.fullHistory.push({ role: "user", content: "[TASK INTERRUPTED at step " + lastStep + ". Your completed steps are saved as checkpoints. Run db_query(\"SELECT content FROM brain_knowledge WHERE key LIKE 'checkpoint_" + sid + "_%' ORDER BY key\") to see what you already did. Do NOT re-read files or repeat completed steps. Continue from step " + lastStep + ".]" });
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

  // --- Skytron Decision Cycle (every tick when idle) ---
  try {
    const pendingActions = await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all();
    if (pendingActions.results?.[0]?.c === 0) {
      const stateRows = await env.DB.prepare("SELECT key, value FROM identity WHERE key IN ('energy','tick_count','health_flags')").all();
      const stateMap = {};
      for (const row of stateRows.results || []) stateMap[row.key] = row.value;
      const energy = parseInt(stateMap.energy) || 100;
      const healthFlags = stateMap.health_flags || "none";
      const recentCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE created_at > datetime('now', '-5 minutes')").all()).results?.[0]?.c || 0;
      const recentLogs = (await env.DB.prepare("SELECT content FROM brain_logs WHERE created_at > datetime('now', '-5 minutes') ORDER BY id DESC LIMIT 2").all()).results || [];
      const recentSummary = recentLogs.map(l => (l.content || "").slice(0, 80)).filter(Boolean).join(" | ");

      let cronPrompt;
      try {
        const customPrompt = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_slot_cron'").all();
        if (customPrompt.results?.[0]?.value) cronPrompt = customPrompt.results[0].value;
      } catch {}
      if (!cronPrompt) {
        cronPrompt = "You are Skytron on an idle cron tick (tick " + tickCount + "). Decide what to do in ONE tool call.\nOutput EXACTLY: {\"tool\":\"name\",\"input\":{...}} — raw JSON, no markdown, no explanation.\n\nCURRENT STATE:\n- Energy: " + energy + "% | Health: " + healthFlags + "\n- Recent actions (5min): " + recentCount + "\n- Recent: " + (recentSummary || "none") + "\n\nCAPABILITIES (pick one or invent your own):\n1. Health Checks — db_query for errors/stuck actions, check provider health\n2. Pending Task Processing — check for overdue/scheduled tasks\n3. New Task Creation — schedule future tasks via learn() or db_query INSERT\n4. Data Aggregation & Analysis — memory_search or web_search for useful data\n5. Report Generation — compile and store summaries via learn()\n6. Notification & Alerting — alert on conditions via learn() or api_call\n7. Workflow Automation — execute multi-step sequences\n\nUse any tool you have. One call per tick. If nothing needs doing: {\"tool\":\"learn\",\"input\":{\"key\":\"idle_tick_" + tickCount + "\",\"content\":\"idle\"}}\nAdd/edit capabilities via: prompt_edit(slot=\"cron\", prompt=\"...\")";
      }

      const decision = await callLLM(env, {
        messages: [
          { role: "system", content: cronPrompt },
          { role: "user", content: "One tool call. What do you do?" }
        ]
      }, "cron-tick-" + tickCount);

      if (decision?.content && typeof decision.content === "string") {
        const trimmed = decision.content.trim();
        const parsed = tryParseSelfAction(trimmed);
        if (parsed) {
          const result = await dispatchTool(env, parsed.tool, parsed.input || parsed.arguments || {});
          if (result && result.length > 10) {
            await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'journal', 'cron')").bind("cron_tick_" + tickCount, "Tick " + tickCount + " " + parsed.tool + ": " + result.slice(0, 300)).run();
          }
        }
      }
    }
  } catch (e) { console.error("cron decision error:", e); }

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

function tryParseSelfAction(text) {
  const trimmed = text.trim().replace(/```(?:json)?\s*[\s\S]*?```/g, "").trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?"tool"[\s\S]*?\})\n?```/);
  const jsonToTry = fenceMatch ? fenceMatch[1] : trimmed;
  if (jsonToTry.startsWith("{") && jsonToTry.includes('"tool"') && (jsonToTry.includes('"input"') || jsonToTry.includes('"arguments"'))) {
    try {
      const start = jsonToTry.indexOf("{");
      let depth = 0, end = start;
      for (; end < jsonToTry.length; end++) { if (jsonToTry[end] === "{") depth++; else if (jsonToTry[end] === "}") depth--; if (depth === 0) break; }
      if (depth !== 0) return null;
      const parsed = JSON.parse(jsonToTry.slice(start, end + 1));
      if (parsed.tool) { if (parsed.arguments) { parsed.input = parsed.arguments; delete parsed.arguments; } if (parsed.input) return parsed; }
    } catch {}
  }
  return null;
}
