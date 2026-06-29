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
import { dispatchTool, toolDefinitions } from './tools';

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}

  // --- Night sleep (6h window: UTC 20-2 = IST 1:30AM-7:30AM) ---
  const now = new Date();
  const h = now.getUTCHours();
  if (h >= 20 || h < 2) return;

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

  // --- Skytron Idle Cycle (hour-slot schedule, complex tasks continue across ticks) ---
  try {
    const pendingCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all()).results?.[0]?.c || 0;
    if (pendingCount > 0) { try { await env.DB.prepare("INSERT INTO brain_logs (action_id, step, content, model) VALUES (?1, ?2, ?3, ?4)").bind("cron", "tick_" + tickCount, "pending=" + pendingCount + " tick=" + tickCount, "system").run(); } catch {} }
    if (pendingCount === 0) {
      const lastHealth = (await env.DB.prepare("SELECT value FROM identity WHERE key='last_health_check'").all()).results?.[0]?.value;
      const hoursSinceHealth = lastHealth ? (Date.now() - new Date(lastHealth).getTime()) / 3600000 : 99;
      const healthDue = hoursSinceHealth >= 1;
      if (healthDue) await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_health_check',datetime('now'),datetime('now'))").run();
      try { await env.DB.prepare("INSERT INTO brain_logs (action_id, step, content, model) VALUES (?1, ?2, ?3, ?4)").bind("cron", "tick_" + tickCount, "free_time_tick=" + tickCount, "system").run(); } catch {}
      // Check for in-progress complex task
      let projectTask = "";
      let projectInput = "";
      try {
        const p = await env.DB.prepare("SELECT value FROM identity WHERE key='idle_project'").first();
        if (p?.value) { const j = JSON.parse(p.value); projectTask = j.task || ""; projectInput = j.input || ""; }
      } catch {}
      // Determine hour slot
      const hourSlot = new Date().getUTCHours() % 4;
      const slots = ["self_improve", "test", "research", "housekeep"];
      const slot = healthDue ? "health" : slots[hourSlot];
      const task = projectTask || (healthDue ? "db_query" : (
        slot === "self_improve" ? "review_code" :
        slot === "test" ? "db_query" :
        slot === "research" ? "web_search" : "learn"
      ));
      const prompt = "tick=" + tickCount + " slot=" + slot + (projectTask ? " continuing " + projectTask : "") + "\nChoose a tool and run it." + (slot === "housekeep" ? " Do something with learn or db_query." : slot === "research" ? " Do web_search." : "") + "\nWhen done with a multi-step task, learn() the result as 'idle_done_DATE'.";
      const decision = await callLLM(env, {
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "pick a tool and run it" }
        ]
      }, "cron-tick-" + tickCount);
      if (decision?.content && typeof decision.content === "string") {
        const trimmed = decision.content.trim();
        let parsed = tryParseSelfAction(trimmed);
        if (!parsed) parsed = tryParseNaturalLanguage(trimmed);
        if (parsed) {
          const result = await dispatchTool(env, parsed.tool, parsed.input || parsed.arguments || {});
          if (result) {
            await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'journal', 'cron')").bind("cron_tick_" + tickCount, "Tick " + tickCount + " " + slot + " " + parsed.tool + ": " + String(result).slice(0, 300)).run();
          }
          // Save complex project state for next tick
          if (slot === "self_improve" || slot === "test") {
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('idle_project',?1,datetime('now'))").bind(JSON.stringify({ task: parsed.tool, input: parsed.input || {}, tick: tickCount })).run();
          } else {
            try { await env.DB.prepare("DELETE FROM identity WHERE key='idle_project'").run(); } catch {}
          }
        }
      } else {
        try { await env.DB.prepare("INSERT INTO brain_logs (action_id, step, content, model) VALUES (?1, ?2, ?3, ?4)").bind("cron", "llm_null_" + tickCount, "LLM returned null. errors=" + JSON.stringify(decision?.errors || []), "none").run(); } catch {}
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

function tryParseNaturalLanguage(text) {
  const tl = text.toLowerCase();
  // Health check: errors/stuck/health/monitoring
  if (/\b(health|stuck|error|fail|energy)\b/.test(tl) && /\b(check|query|look|monitor|audit|review)\b/.test(tl)) {
    return { tool: "db_query", input: { sql: "SELECT status,COUNT(*) as c FROM actions GROUP BY status" } };
  }
  // Data cleanup: "data cleanup", "removing stale entries", "clean up"
  if (/\b(data|stale|cleanup|clean.?up|trim|remove|purge|retention)\b/.test(tl)) {
    return { tool: "db_query", input: { sql: "SELECT COUNT(*) as stale FROM brain_knowledge WHERE created_at < datetime('now', '-30 days')" } };
  }
  // Self-audit: "self-audit", "review code", "check tool performance"
  if (/\b(self.?audit|review|code.?review|tool.?performance|audit)\b/.test(tl)) {
    return { tool: "db_query", input: { sql: "SELECT 'audit requested' as msg" } };
  }
  // Web research / search
  if (/\b(research|search|web|news|latest|find|look up)\b/.test(tl) && !/\b(memory|brain|db|database|sql|query)\b/.test(tl)) {
    return { tool: "web_search", input: { query: text.replace(/research|search|web|news|latest|find|look up|for|about|on|the|a|an|i.ll|will|perform|conduct/i, "").trim().slice(0, 100) || "latest technology news" } };
  }
  // Memory search
  if (/\b(memory|remember|knowledge|brain)\b/.test(tl) && /\b(search|find|look|recall|query)\b/.test(tl)) {
    return { tool: "memory_search", input: { query: text.slice(0, 100) } };
  }
  // Learning / synthesize lessons
  if (/\b(learn|synthesize|lesson|heuristic)\b/.test(tl)) {
    return { tool: "learn", input: { key: "cron_learn_" + new Date().toISOString().split("T")[0], content: text.slice(0, 300), category: "journal" } };
  }
  // Report / summary
  if (/\b(report|summary|summarize|journal|log)\b/.test(tl)) {
    return { tool: "learn", input: { key: "cron_report_" + new Date().toISOString().split("T")[0], content: text.slice(0, 300), category: "journal" } };
  }
  // Idle / nothing need doing
  if (/\b(nothing|idle|all good|fine|okay|ok|no[nt])\b/.test(tl) && (tl.length < 50 || /\b(nothing|idle)\b/.test(tl))) {
    return { tool: "learn", input: { key: "idle", content: text.slice(0, 200) } };
  }
  // Generic: if contains "perform" or "will" + a capability word, try learn
  if (/\b(perform|will|going to)\b/.test(tl) && /\b(data|research|search|audit|review|clean|cleanup|report|learn|monitor|check)\b/.test(tl)) {
    return { tool: "learn", input: { key: "cron_plan_" + new Date().toISOString().split("T")[0], content: "Skytron plans: " + text.slice(0, 200), category: "journal" } };
  }
  return null;
}
