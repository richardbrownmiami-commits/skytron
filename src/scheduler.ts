// === Skytron Scheduler (CRON ENGINE) with Priority Queue ===
// Runs every 120s via [[triggers]] pattern in wrangler.toml.
// Execution order per tick:
//   1. Process queued actions (pick 1 queued → set running → processOneStep)
//   2. Recover stuck actions (>2 min running → reset with checkpoint)
//   3. Process sub-agents (pick 1 queued brain_agent → processOneAgentStep)
//   4. Tick counter (persisted in identity table)
//   5. Maintenance Cycle (every 60 ticks = ~2h): extract lessons, memory loop, trim noise
//   6. Daily cleanup: trim old memories (>200), logs (>1000), actions (>500), agents (>50)
import { initSchema, indexKnowledgeForSearch } from './db';
// Priority queue: actions ordered by priority (idle_explore < user < cron)
const ACTION_PRIORITY = { idle_explore: 0, system: 1, cron: 2, user: 3, chat: 3 };
import { processOneStep, processOneAgentStep } from './agents';

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}

  // --- Load settings ---
  const settings = await getCronSettings(env.DB);

  // --- Night sleep (6h window: UTC 20-2 = IST 1:30AM-7:30AM) ---
  if (settings.night_sleep) {
    const now = new Date();
    const h = now.getUTCHours();
    if (h >= 20 || h < 2) return;
  }

  // --- Process queued actions (round-robin) ---
  if (settings.process_actions) {
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
      } else if (settings.stuck_recovery) {
        const s = await env.DB.prepare("SELECT * FROM actions WHERE status='running' AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT 1").all();
        if (s.results?.length) {
          const sid = s.results[0].id;
          const ageMins = Math.round((Date.now() - new Date(s.results[0].created_at + "Z").getTime()) / 60000);
          const retryKey = "recovery_count_" + sid;
          const prevRetry = await env.DB.prepare("SELECT value FROM identity WHERE key=?1").bind(retryKey).first();
          const retryCount = parseInt(prevRetry?.value) || 0;
          if (retryCount >= 3) {
            await env.DB.prepare("UPDATE actions SET status='error', result='Stuck after 3 recovery attempts', completed_at=datetime('now') WHERE id=?1").bind(sid).run();
            try { await env.DB.prepare("DELETE FROM identity WHERE key=?1").bind(retryKey).run(); } catch {}
            try { await env.DB.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES ('assistant', ?1, 'default')").bind("⚠️ Action " + sid + " kept getting stuck for " + ageMins + " minutes. I auto-failed it. It was on step " + (s.results[0].step || "?") + ".").run(); } catch {}
          } else {
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(retryKey, String(retryCount + 1)).run();
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
            if (retryCount === 0 && ageMins > 10) {
              try { await env.DB.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES ('assistant', ?1, 'default')").bind("⚠️ Action " + sid + " has been stuck for " + ageMins + " minutes at step " + (s.results[0].step || "?") + ". I'm recovering it.").run(); } catch {}
            }
          }
        }
      }
      if (settings.process_agents) {
        await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NOT NULL AND updated_at < datetime('now', '-2 minutes')").run();
        await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NULL AND created_at < datetime('now', '-2 minutes')").run();
        const ar = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 1").all();
        if (ar.results?.length) {
          await processOneAgentStep(env, ar.results[0]);
        }
      }
    } catch (e) { console.error("cron error:", e); }
  }

  // --- Tick counter ---
  let tickCount = 0;
  try {
    const tickRow = await env.DB.prepare("SELECT value FROM identity WHERE key='tick_count'").all();
    if (tickRow.results?.length) tickCount = parseInt(tickRow.results[0].value) || 0;
    tickCount++;
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('tick_count',?1,datetime('now'))").bind(String(tickCount)).run();
  } catch { tickCount = 1; }

  // --- Maintenance Cycle (every 60 ticks = ~2 hours) ---
  // Replaces the old idle LLM cycle that ran every 60 seconds.
  // Instead of polling the LLM for busywork, this runs deterministic
  // maintenance: extract lessons, summarize conversations, trim noise, memory loop.
  if (settings.idle_cycle) {
    const pendingCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all()).results?.[0]?.c || 0;
    if (pendingCount === 0) {
      let maintCounter = 0;
      try {
        const mRow = await env.DB.prepare("SELECT value FROM identity WHERE key='maintenance_counter'").first();
        if (mRow?.value) maintCounter = parseInt(mRow.value) || 0;
      } catch {}
      maintCounter++;
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('maintenance_counter',?1,datetime('now'))").bind(String(maintCounter)).run();

      // Health check (once per hour)
      if (settings.health_check) {
        try {
          const hcRow = await env.DB.prepare("SELECT value FROM identity WHERE key='last_health_check'").first();
          const hcDue = hcRow?.value ? (Date.now() - new Date(hcRow.value).getTime()) / 3600000 >= 1 : true;
          if (hcDue) {
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_health_check',datetime('now'),datetime('now'))").run();
          }
        } catch {}
      }

      if (maintCounter >= 60) { // ~2 hours elapsed
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('maintenance_counter','0',datetime('now'))").run();

        // 1. Extract errors from recent actions → store as lessons
        try {
          const errors = await env.DB.prepare("SELECT id, input, error FROM actions WHERE error IS NOT NULL AND created_at > datetime('now', '-2 hours') LIMIT 10").all();
          if (errors.results?.length) {
            for (const e of errors.results) {
              const lessonKey = "lesson_" + new Date().toISOString().split("T")[0] + "_act" + e.id;
              await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'lesson', 'auto')").bind(lessonKey, "Action " + e.id + " failed: " + (e.error || "").slice(0, 300) + ". Input: " + (e.input || "").slice(0, 200)).run();
              try { await indexKnowledgeForSearch(env, lessonKey, "Lesson from action " + e.id + ": " + (e.error || "").slice(0, 200), "lesson"); } catch {}
            }
          }
        } catch {}

        // 2. Memory loop: summarize recent conversations → durable knowledge
        try {
          const convs = await env.DB.prepare("SELECT DISTINCT conversation_id FROM brain_memory WHERE created_at > datetime('now', '-2 hours')").all();
          for (const c of (convs.results || [])) {
            const msgs = await env.DB.prepare("SELECT role, content, created_at FROM brain_memory WHERE conversation_id=?1 AND created_at > datetime('now', '-2 hours') ORDER BY id ASC").bind(c.conversation_id).all();
            if (msgs.results?.length) {
              const dateStr = new Date().toISOString().split("T")[0];
              const safeConv = (c.conversation_id || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
              const summary = msgs.results.map(m => "[" + m.role + " " + (m.created_at || "") + "]: " + m.content.slice(0, 150)).join("\n").slice(0, 4000);
              await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'memory_loop', 'auto')").bind("memory_loop_" + dateStr + "_" + safeConv, "Conversation: " + c.conversation_id + " | " + msgs.results.length + " messages in last 2h\n" + summary).run();
            }
          }
        } catch {}

        // 3. Extract stats: action counts, error rates → store as knowledge
        try {
          const stats = await env.DB.prepare("SELECT status, COUNT(*) as c FROM actions WHERE created_at > datetime('now', '-24 hours') GROUP BY status").all();
          if (stats.results?.length) {
            const summary = stats.results.map(s => s.status + ": " + s.c).join(", ");
            await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'insight', 'auto')").bind("stats_" + new Date().toISOString().split("T")[0], "Last 24h action stats: " + summary).run();
          }
        } catch {}

        // 4. Delete old journal entries (>14 days)
        try { await env.DB.prepare("DELETE FROM brain_knowledge WHERE category='journal' AND created_at < datetime('now', '-14 days')").run(); } catch {}
      }
    }
  }

  // --- Daily cleanup ---
  if (settings.daily_cleanup) {
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
}

async function getCronSettings(db) {
  const defaults = {
    enabled: true, log_tick: false, idle_cycle: true, health_check: true,
    slot_self_improve: true, slot_test: true, slot_research: true, slot_housekeep: true,
    idle_project: true, tool_dispatch: true, process_actions: true, stuck_recovery: true,
    process_agents: true, daily_cleanup: true, night_sleep: true,
    task_web_search: true, task_memory_search: true, task_learn: true, task_db_query: true, task_review_code: true
  };
  try {
    const rows = await db.prepare("SELECT key, value FROM identity WHERE key LIKE 'cron_cfg_%'").all();
    if (rows.results?.length) {
      for (const r of rows.results) {
        const k = r.key.replace("cron_cfg_", "");
        if (k in defaults) defaults[k] = r.value === "true";
      }
    }
  } catch {}
  return defaults;
}
