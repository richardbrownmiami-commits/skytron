// === Skytron Scheduler (CRON ENGINE) ===
// Two cron triggers in wrangler.toml:
//   * * * * *  → non-LLM tasks (every 1 min): maintenance, recovery, heartbeat, consolidation
//   */5 * * * * → LLM tasks (every 5 min): process actions, sub-agents, emergency repair
import { initSchema, indexKnowledgeForSearch, logActivity, buildSensorium, saveAgentState } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { callOpenRouter } from './llm';
import { collectToScratchpad } from './consolidate';

export async function handleScheduled(controller, env, cronPattern = "* * * * *") {
  try { await initSchema(env.DB, env); } catch {}
  const db = env.DB;
  const settings = await getCronSettings(env.DB);
  if (!settings.enabled) return;

  if (cronPattern === "*/5 * * * *") {
    await runLLMTasks(settings, env, db);
  } else {
    await runNonLLMTasks(settings, env, db);
  }
}

// ── LLM CRON (every 5 min) ──────────────────────────────────────────
// Only tasks that call the LLM: process actions, sub-agents, emergency repair
async function runLLMTasks(settings, env, db) {

  // --- Step 2: Process queued actions ---
  if (settings.process_actions) try {
    const lastIdRow = await env.DB.prepare("SELECT value FROM identity WHERE key='last_action_id'").all();
    const lastId = parseInt(lastIdRow.results?.[0]?.value) || 0;
    let r = await env.DB.prepare("UPDATE actions SET status='running', updated_at=datetime('now') WHERE id=(SELECT id FROM actions WHERE status='queued' AND id > ?1 ORDER BY id ASC LIMIT 1) RETURNING *").bind(lastId).all();
    if (!r.results?.length) {
      r = await env.DB.prepare("UPDATE actions SET status='running', updated_at=datetime('now') WHERE id=(SELECT id FROM actions WHERE status='queued' ORDER BY id ASC LIMIT 1) RETURNING *").all();
    }
    if (r.results?.length) {
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_action_id',?1,datetime('now'))").bind(String(r.results[0].id)).run();
      logActivity(db, "scheduler_tick", { actionId: r.results[0].id, summary: "Processing action " + r.results[0].id + " — " + (r.results[0].task || ""), details: "input: " + (r.results[0].input || "").slice(0, 200) });
      await processOneStep(env, r.results[0]);
    }
  } catch (e) { console.error("process_actions error:", e); }

  // --- Step 5: Process sub-agents ---
  if (settings.process_agents) try {
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NOT NULL AND updated_at < datetime('now', '-2 minutes')").run();
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NULL AND created_at < datetime('now', '-2 minutes')").run();
    const ar = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 1").all();
    if (ar.results?.length) {
      logActivity(db, "scheduler_tick", { summary: "Processing sub-agent " + ar.results[0].id + " — " + (ar.results[0].name || ""), details: "role: " + (ar.results[0].role || "").slice(0, 200) });
      await processOneAgentStep(env, ar.results[0]);
    }
  } catch (e) { console.error("process_agents error:", e); }

  // --- Emergency self-repair (LLM-dependent part only) ---
  try {
    const bdFails = await env.DB.prepare("SELECT value FROM identity WHERE key='bd_failures'").first();
    const bdDown = bdFails?.value && parseInt(bdFails.value) >= 3;
    const waLimited = await env.DB.prepare("SELECT value FROM identity WHERE key='wa_limited'").first();
    const waDown = waLimited?.value && waLimited.value.startsWith(new Date().toISOString().split("T")[0]);
    if (bdDown && waDown) {
      const lastRepair = await env.DB.prepare("SELECT value FROM identity WHERE key='last_emergency_repair'").first();
      const minsSince = lastRepair?.value ? (Date.now() - new Date(lastRepair.value).getTime()) / 60000 : 999;
      if (minsSince > 30) {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_emergency_repair',datetime('now'),datetime('now'))").run();
        logActivity(db, "emergency_repair", { summary: "WA + BD both down — running self-repair via OpenRouter" });
        const diag = await callOpenRouter(env, [
          { role: "system", content: "You are Skytron's emergency repair routine. WA (Workers AI) and BD (BUDDHI_DWAR gateway) are both down. Available actions: (a) retry WA by clearing wa_limited flag, (b) retry BD by clearing bd_failures flag, (c) test BD connectivity by fetching /v1/status, (d) wait. Respond with one word: 'retry_wa', 'retry_bd', 'test_bd', or 'wait'." },
          { role: "user", content: "Both LLM providers failed. Fix it." }
        ], 500);
        if (diag?.content) {
          const action = diag.content.trim().toLowerCase();
          if (action.includes("retry_wa")) {
            await env.DB.prepare("DELETE FROM identity WHERE key='wa_limited'").run();
            logActivity(db, "emergency_repair", { summary: "Cleared wa_limited — will retry WA next tick" });
          } else if (action.includes("retry_bd")) {
            await env.DB.prepare("DELETE FROM identity WHERE key='bd_failures'").run();
            await env.DB.prepare("DELETE FROM identity WHERE key='health_flags'").run();
            logActivity(db, "emergency_repair", { summary: "Cleared bd_failures + health_flags — will retry BD next tick" });
          } else if (action.includes("test_bd")) {
            try {
              const testResp = env.BRAIN_KEY ? await fetch("https://buddhi-dwar.richard-brown-miami.workers.dev/v1/status", { signal: AbortSignal.timeout(5000) }).catch(() => null) : null;
              const reachable = testResp?.ok ? "yes" : "no";
              await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('emergency_bd_test', ?1, 'lesson', 'auto')").bind("BD connectivity test at " + new Date().toISOString() + ": reachable=" + reachable + (testResp ? " status=" + testResp.status : "")).run();
              logActivity(db, "emergency_repair", { summary: "Tested BD — reachable=" + reachable });
            } catch {}
          } else {
            logActivity(db, "emergency_repair", { summary: "OpenRouter suggests waiting — " + diag.content.slice(0, 100) });
          }
        }
      }
    }
  } catch (e) { console.error("emergency_repair error:", e); }

}

// ── NON-LLM CRON (every 1 min) ──────────────────────────────────────
// All maintenance, recovery, heartbeat, consolidation, cleanup — no LLM calls
async function runNonLLMTasks(settings, env, db) {

  // --- Step 3: Recover stuck actions ---
  if (settings.stuck_recovery) try {
    const s = await env.DB.prepare("SELECT * FROM actions WHERE status='running' AND COALESCE(updated_at, created_at) < datetime('now', '-2 minutes') ORDER BY COALESCE(updated_at, created_at) ASC LIMIT 1").all();
    if (s.results?.length) {
      const sid = s.results[0].id;
      const ageMins = Math.round((Date.now() - new Date(s.results[0].created_at + "Z").getTime()) / 60000);
      const retryKey = "recovery_count_" + sid;
      const prevRetry = await env.DB.prepare("SELECT value FROM identity WHERE key=?1").bind(retryKey).first();
      const retryCount = parseInt(prevRetry?.value) || 0;
      if (ageMins >= 15) {
        logActivity(db, "action_killed_15min", { actionId: sid, summary: "Action " + sid + " stuck for " + ageMins + " min — killed (15-min hard limit)", details: "step: " + (s.results[0].step || "?") + ", task: " + (s.results[0].task || "?") });
        await env.DB.prepare("UPDATE actions SET status='error', result='Stuck >15 min — killed by hard limit', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?1").bind(sid).run();
        try { await env.DB.prepare("DELETE FROM identity WHERE key=?1").bind(retryKey).run(); } catch {}
        try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('repair_retry_' + ?1, ?2, 'lesson', 'auto')").bind(String(sid), "ORIGINAL_TASK: " + (s.results[0].task || "?") + "\nORIGINAL_INPUT: " + (s.results[0].input || "").slice(0, 2000) + "\nSTUCK_STEP: " + (s.results[0].step || "?") + "\nAGE_MIN: " + ageMins + "\nKILLED_BY: 15min_hard_limit").run(); } catch {}
        try { await env.DB.prepare("INSERT INTO actions (type, status, input, task, created_at) VALUES ('tool_repair', 'queued', ?1, 'repair_tool', datetime('now'))").bind("Action " + sid + " was stuck for " + ageMins + " minutes and hit the 15-min hard kill limit. Task: " + (s.results[0].task || "?") + ". Step: " + (s.results[0].step || "?") + ". Input: " + (s.results[0].input || "").slice(0, 300)).run(); } catch {}
        try { await env.DB.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES ('assistant', ?1, 'default')").bind("Something went wrong with your request and I couldn't recover it automatically. I'm investigating what caused the issue and will fix it.").run(); } catch {}
      } else if (retryCount >= 2) {
        logActivity(db, "action_stuck", { actionId: sid, summary: "Action " + sid + " failed after 3 recovery attempts — " + ageMins + " min stuck", details: "step: " + (s.results[0].step || "?") });
        await env.DB.prepare("UPDATE actions SET status='error', result='Stuck after 3 recovery attempts', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?1").bind(sid).run();
        try { await env.DB.prepare("DELETE FROM identity WHERE key=?1").bind(retryKey).run(); } catch {}
        const qCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all()).results?.[0]?.c || 0;
        try { await env.DB.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES ('assistant', ?1, 'default')").bind("Something went wrong with your request and I couldn't recover it automatically. I'm investigating what caused the issue and will fix it.").run(); } catch {}
        // Store stuck action details for self-repair
        try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('repair_retry_' + ?1, ?2, 'lesson', 'auto')").bind(String(sid), "ORIGINAL_TASK: " + (s.results[0].task || "?") + "\nORIGINAL_INPUT: " + (s.results[0].input || "").slice(0, 2000) + "\nSTUCK_STEP: " + (s.results[0].step || "?") + "\nRETRY_COUNT: " + (retryCount + 1)).run(); } catch {}
        try { await env.DB.prepare("INSERT INTO actions (type, status, input, task, created_at) VALUES ('tool_repair', 'queued', ?1, 'repair_tool', datetime('now'))").bind("Action " + sid + " got stuck after 3 recovery attempts. Task: " + (s.results[0].task || "?") + ". Step: " + (s.results[0].step || "?") + ". Input: " + (s.results[0].input || "").slice(0, 300)).run(); } catch {}
      } else {
        logActivity(db, "action_recovered", { actionId: sid, summary: "Action " + sid + " stuck for " + ageMins + " min — recovering (attempt " + (retryCount + 1) + "/3)", details: "step: " + (s.results[0].step || "?") });
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(retryKey, String(retryCount + 1)).run();
        try {
          const stateRow = await env.DB.prepare("SELECT value as state FROM identity WHERE key='agent_state_' || ?1").bind(sid).first();
          if (stateRow?.state) {
            const state = JSON.parse(stateRow.state);
            const lastStep = state.step || 0;
            if (!state.fullHistory) state.fullHistory = [];
            const ckRows = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key LIKE ?1 ORDER BY key").bind("checkpoint_" + sid + "_%").all();
            let ckSummary = "";
            if (ckRows.results?.length) {
              ckSummary = ckRows.results.map((r, i) => "  Step " + (i + 1) + ": " + r.content.slice(0, 300)).join("\n");
            }
            state.fullHistory.push({ role: "user", content: "[TASK RESUMED at step " + lastStep + (ckSummary ? " — previous steps:\n" + ckSummary : " — no checkpoints found") + "\n\nContinue from step " + lastStep + ". DO NOT repeat completed steps.]" });
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('agent_state_' || ?2, ?1, datetime('now'))").bind(JSON.stringify(state), sid).run();
          }
        } catch {}
        await env.DB.prepare("UPDATE actions SET status='queued', updated_at=datetime('now') WHERE id=?1").bind(sid).run();
        const qCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all()).results?.[0]?.c || 0;
        try { await env.DB.prepare("INSERT INTO brain_memory (role, content, conversation_id) VALUES ('assistant', ?1, 'default')").bind("One moment, I'm checking on your request. It's taking a bit longer than expected." + (retryCount >= 1 ? " Still working on it — let me investigate what's going wrong." : "")).run(); } catch {}
        // On 2nd detection, start self-repair investigation alongside requeue
        if (retryCount >= 1) {
          try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('repair_retry_' + ?1, ?2, 'lesson', 'auto')").bind(String(sid), "ORIGINAL_TASK: " + (s.results[0].task || "?") + "\nORIGINAL_INPUT: " + (s.results[0].input || "").slice(0, 2000) + "\nSTUCK_STEP: " + (s.results[0].step || "?") + "\nRETRY_COUNT: " + (retryCount + 1)).run(); } catch {}
          try { await env.DB.prepare("INSERT INTO actions (type, status, input, task, created_at) VALUES ('tool_repair', 'queued', ?1, 'repair_tool', datetime('now'))").bind("Action " + sid + " keeps getting stuck. Task: " + (s.results[0].task || "?") + ". Step: " + (s.results[0].step || "?") + ". Input: " + (s.results[0].input || "").slice(0, 300) + ". INVESTIGATE root cause in the source code using github_get_file and fix it.").run(); } catch {}
        }
      }
    }
  } catch (e) { console.error("stuck_recovery error:", e); }

  // --- Step 3.5: Loop detection — detect repeated failure patterns ---
  try {
    const recentFails = (await env.DB.prepare("SELECT id, task, result, error, created_at FROM actions WHERE status='error' AND created_at > datetime('now', '-1 hour') ORDER BY created_at DESC LIMIT 10").all()).results || [];
    if (recentFails.length >= 3) {
      const patternCounts = {};
      for (const f of recentFails) {
        const msg = (f.error || f.result || "").toLowerCase();
        let pattern = "unknown";
        if (msg.includes("4006") || msg.includes("limit") || msg.includes("exhausted") || msg.includes("neurons")) pattern = "workers_ai_limit";
        else if (msg.includes("429") || msg.includes("rate limit")) pattern = "rate_limited";
        else if (msg.includes("timeout") || msg.includes("timed out")) pattern = "timeout";
        else if (msg.includes("stuck") || msg.includes("running")) pattern = "stuck";
        else if (msg.includes("auth") || msg.includes("key") || msg.includes("unauthorized") || msg.includes("403")) pattern = "auth_error";
        else if (msg.includes("empty") || msg.includes("null") || msg.includes("undefined")) pattern = "empty_response";
        else if (msg.includes("dns") || msg.includes("resolve") || msg.includes("econnrefused") || msg.includes("fetch failed")) pattern = "network_error";
        patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
      }
      const worst = Object.entries(patternCounts).sort((a, b) => b[1] - a[1])[0];
      if (worst && worst[1] >= 3) {
        const loopKey = "loop_pattern_" + worst[0];
        const prev = await env.DB.prepare("SELECT value FROM identity WHERE key=?1").bind(loopKey).first();
        const prevCount = parseInt(prev?.value) || 0;
        if (prevCount < 3) {
          await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES (?1,?2,datetime('now'))").bind(loopKey, String(prevCount + 1)).run();
          logActivity(db, "loop_detected", { summary: "Loop pattern '" + worst[0] + "' repeated " + worst[1] + " times in last hour (detection #" + (prevCount + 1) + ")" });
          if (worst[0] === "workers_ai_limit") {
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('wa_limited',datetime('now'),datetime('now'))").run();
            logActivity(db, "loop_action", { summary: "Marked Workers AI as limited — will skip it in provider rotation" });
          } else if (worst[0] === "rate_limited") {
            logActivity(db, "loop_action", { summary: "Rate limit detected — adding cooldown delay before next provider retry" });
          } else if (worst[0] === "timeout" || worst[0] === "empty_response") {
            logActivity(db, "loop_action", { summary: "Empty/timeout pattern detected — will shorten inputs and reduce max_tokens on retry" });
          } else if (worst[0] === "auth_error") {
            logActivity(db, "loop_action", { summary: "Auth errors detected — skipping all providers with missing config" });
          }
        } else {
          logActivity(db, "loop_escalated", { summary: "Loop pattern '" + worst[0] + "' persisted after 3 detections — escalating to operator notice" });
          await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('loop_notice_' + ?1, ?2, 'lesson', 'auto')").bind(worst[0], "Loop pattern '" + worst[0] + "' detected " + prevCount + " times without resolution. Recent errors: " + recentFails.slice(0, 3).map(function(f) { return "Action " + f.id + ": " + (f.error || f.result || "").slice(0, 100); }).join(" | ")).run();
        }
      }
    }
  } catch (e) { console.error("loop_detection error:", e); }

  // --- Step 4: Idle exploration ---
  if (settings.idle_project) try {
    const pendingCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions WHERE status IN ('queued','running')").all()).results?.[0]?.c || 0;
    if (pendingCount === 0) {
      const lastProject = await env.DB.prepare("SELECT value FROM identity WHERE key='last_idle_project'").first();
      const lastTime = lastProject?.value || "1970-01-01";
      const minutesSince = (Date.now() - new Date(lastTime).getTime()) / 60000;
      if (minutesSince > 30) {
        const sensorium = await buildSensorium(env);
        const lastThought = await env.DB.prepare("SELECT value FROM identity WHERE key='subconscious_thread'").first();
        const thread = lastThought?.value ? "Last session: " + lastThought.value : "No previous session.";
        const input = sensorium + "\n" + thread + "\n\nWhat do YOU want to do? Pick one thing from your current state. Study your code. Improve a feature. Explore your data. Fix something you noticed. Tell me what and do it.";
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value) VALUES ('last_idle_project', datetime('now'))").run();
        const ir = await env.DB.prepare("INSERT INTO actions (type, status, input, task, created_at) VALUES ('idle_explore','queued',?1,'self_explore',datetime('now')) RETURNING id").bind(input).all();
        const iid = ir.results?.[0]?.id;
        if (iid) await saveAgentState(env.DB, iid, { step: 0, fullHistory: [{ role: "system", content: "You are Skytron, an autonomous AI. Explore, improve, and fix things." }, { role: "user", content: input }], totalTokens: 0, finalContent: null, modelName: "", conversationId: "idle", done: false, mode: "astral" });
        logActivity(db, "idle", { summary: "Queued idle exploration — self-directed" });
      }
    }
  } catch (e) { console.error("idle_project error:", e); }

  // --- Wake-up heartbeat ---
  try {
    const lastWake = await env.DB.prepare("SELECT value FROM identity WHERE key='last_wake_up'").first();
    const lastWakeTime = lastWake?.value || "1970-01-01T00:00:00Z";
    const minsSince = (Date.now() - new Date(lastWakeTime).getTime()) / 60000;
    if (minsSince > 15) {
      const sensorium = await buildSensorium(env);
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_wake_up',datetime('now'),datetime('now'))").run();
      const wr = await env.DB.prepare("INSERT INTO actions (type,status,input,task,created_at) VALUES ('think','queued',?1,'self_explore',datetime('now')) RETURNING id").bind(sensorium + "\n\nWake up. Check your state. Queue tasks, run maintenance, or self-improve. Decide and act.").all();
      const wid = wr.results?.[0]?.id;
      if (wid) await saveAgentState(env.DB, wid, { step: 0, fullHistory: [{ role: "system", content: "You are Skytron, an autonomous AI. Wake up, check your state, queue tasks, run maintenance, or self-improve. Decide and act." }, { role: "user", content: sensorium + "\n\nWake up. Check your state. Queue tasks, run maintenance, or self-improve. Decide and act." }], totalTokens: 0, finalContent: null, modelName: "", conversationId: "cron", done: false, mode: "astral" });
      logActivity(env.DB, "wake_up", { summary: "Heartbeat tick — wake-up action queued" });
    }
  } catch {}

  // --- Astral auto-recovery ---
  try {
    const astralActive = (await env.DB.prepare("SELECT value FROM identity WHERE key='cron_cfg_astral_active'").all()).results?.[0]?.value === "true";
    if (astralActive) {
      const lastAstral = (await env.DB.prepare("SELECT id, status, error FROM actions WHERE task='astral' ORDER BY id DESC LIMIT 1").all()).results?.[0];
      if (lastAstral && lastAstral.status === 'error') {
        const recentErrs = (await env.DB.prepare("SELECT error FROM actions WHERE task='astral' AND (status='error' OR error IS NOT NULL AND error != '') ORDER BY id DESC LIMIT 3").all()).results || [];
        const allProviderFailures = recentErrs.length >= 3 && recentErrs.every(function(r) { return (r.error || "").includes("LLM provider failed") || (r.error || "").includes("all providers unreachable") || (r.error || "").includes("provider fail"); });
        if (allProviderFailures) {
          const cooldownRow = await env.DB.prepare("SELECT value FROM identity WHERE key='astral_cooldown_until'").first();
          const cooldownUntil = cooldownRow?.value || "1970-01-01";
          const now = new Date().toISOString().replace("T", " ").slice(0, 19);
          if (now > cooldownUntil) {
            await env.DB.prepare("UPDATE actions SET status='queued', error='All LLM providers down — waiting 5 min before retry', result=NULL, completed_at=NULL WHERE id=?1").bind(lastAstral.id).run();
            const nextCooldown = new Date(Date.now() + 300000).toISOString().replace("T", " ").slice(0, 19);
            await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('astral_cooldown_until', ?1, datetime('now'))").bind(nextCooldown).run();
            logActivity(env.DB, "astral_cooldown", { summary: "All providers down — re-queued astral " + lastAstral.id + " with 5 min cooldown" });
          }
        } else {
          await env.DB.prepare("UPDATE actions SET status='queued', error=NULL, result=NULL, completed_at=NULL WHERE id=?1").bind(lastAstral.id).run();
          logActivity(env.DB, "astral_recovery", { summary: "Re-queued errored astral action " + lastAstral.id });
        }
      }
    }
  } catch (e) { console.error("astral_recovery error:", e); }

  // --- Source file index ---
  try {
    const srcRows = await env.DB.prepare("SELECT key FROM brain_knowledge WHERE key LIKE 'source_%' ORDER BY key").all();
    if (srcRows.results?.length) {
      const index = srcRows.results.map(r => r.key.replace("source_", "")).join("\n");
      await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('file_index', ?1, 'system', 'cron')").bind(index).run();
    }
  } catch {}

  // --- Tick counter ---
  let tickCount = 0;
  try {
    const tickRow = await env.DB.prepare("SELECT value FROM identity WHERE key='tick_count'").all();
    if (tickRow.results?.length) tickCount = parseInt(tickRow.results[0].value) || 0;
    tickCount++;
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('tick_count',?1,datetime('now'))").bind(String(tickCount)).run();
    logActivity(db, "scheduler_tick", { summary: "Tick #" + tickCount });
  } catch { tickCount = 1; }

  // --- Consolidation ---
  try {
    const result = await collectToScratchpad(env);
    if (result.totalRows > 0) logActivity(db, "consolidation_collect", { summary: "Collected " + result.totalRows + " new records to scratchpad (batch: " + result.batchId + ")" });
  } catch (e) { console.error("consolidation collect error:", e); }

  // --- Maintenance Cycle (every 60 ticks = ~1h at 1-min cadence) ---
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
            logActivity(db, "health_check", { summary: "Health check due — marking as checked" });
          }
        } catch {}
      }

      if (maintCounter >= 60) {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('maintenance_counter','0',datetime('now'))").run();

        // 1. Extract errors from recent actions → store as lessons
        let lessonCount = 0, convCount = 0;
        try {
          const errors = await env.DB.prepare("SELECT id, input, error FROM actions WHERE error IS NOT NULL AND created_at > datetime('now', '-2 hours') LIMIT 10").all();
          if (errors.results?.length) {
            for (const e of errors.results) {
              const lessonKey = "lesson_" + new Date().toISOString().split("T")[0] + "_act" + e.id;
              await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'lesson', 'auto')").bind(lessonKey, "Action " + e.id + " failed: " + (e.error || "").slice(0, 300) + ". Input: " + (e.input || "").slice(0, 200)).run();
              try { await indexKnowledgeForSearch(env, lessonKey, "Lesson from action " + e.id + ": " + (e.error || "").slice(0, 200), "lesson"); } catch {}
              lessonCount++;
            }
          }
        } catch {}

        // 2. Memory loop: summarize recent conversations → durable knowledge
        try {
          const SW = new Set(["the","you","your","this","that","with","from","have","been","were","they","their","what","about","which","when","where","how","why","just","like","know","think","want","need","can","will","would","should","could","did","does","doing","done","make","made","gets","got","get","say","says","said","tell","told","ask","asked","use","used","using","look","looking","found","find","help","need","take","took","thing","things","much","many","some","any","all","each","every","both","few","more","most","other","into","over","after","before","between","under","again","further","then","once","here","there","very","too","also","not","yes","no","maybe","always","never","sometimes","often","usually","well","back","still","already","yet","because","though","although","while","during","until","since","result","answer","question","previous","last","next","first","second","new","old","good","bad","big","small","long","short","high","low","same","different","own","very","really","actually","basically","literally","probably","maybe","perhaps","please","thank","thanks","ok","okay","hi","hello","hey","sure","fine","great","nice","cool","awesome","amazing","perfect","love","hate","sorry","wait","stop","go","come","let","put","set","run","move","show","try","keep","start","end","begin","done","doing","going","coming","taking","making","giving","using","working","looking","trying","asking","telling","saying","thinking","feeling","knowing","seeing","hearing","being","having","test","testing","check","checking","gonna","wanna","gotta","kinda","sorta","lots","stuff","bit","shall","may","might","must","dont","doesnt","wont","cant","couldnt","shouldnt","wouldnt","isnt","arent","wasnt","werent","hasnt","havent","hadnt","for","are","was","but","not","its","has","had","him","her","out","did","top","see","way","who","now","get","two","our","may","than","been","them","now","then","such","only","very","than","also","must","over","these","where","here","there","while","well"]);
          const convs = await env.DB.prepare("SELECT DISTINCT conversation_id FROM brain_memory WHERE created_at > datetime('now', '-2 hours')").all();
          for (const c of (convs.results || [])) {
            const msgs = await env.DB.prepare("SELECT role, content, created_at FROM brain_memory WHERE conversation_id=?1 AND created_at > datetime('now', '-2 hours') ORDER BY id ASC").bind(c.conversation_id).all();
            if (msgs.results?.length) {
              function isJunk(text) {
                const t = text.trim().toLowerCase();
                if (t.length < 5) return true;
                if (t.startsWith("{\"tool\"") || t.startsWith("{\"tool\":") || t.startsWith("[tool") || t.startsWith("[max steps")) return true;
                if (t.startsWith("tool:") || t.match(/^TOOL:\w+[\(\[\{]/)) return true;
                if (t.includes("i don't have personal memorie") || t.includes("i don't recall") || t.includes("i don't have a personal memory") || t.includes("i don't have personal memories")) return true;
                if (t === "hi" || t === "hello" || t === "hey" || t === "ok" || t === "okay" || t === "thanks" || t === "thank you" || t === "sure" || t === "yes" || t === "no" || t === "yeah" || t === "nope" || t.startsWith("max steps reached")) return true;
                if (t.startsWith("{\"error") || t.includes("\"status\":\"running\"") || t.includes("\"gateway error\"")) return true;
                return false;
              }
              function extractTopics(texts, maxWords = 8) {
                const freq = {};
                const parts = texts.join(" ").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
                for (const w of parts) {
                  if (w.length > 2 && !SW.has(w) && w !== "creator" && !w.startsWith("202") && !w.startsWith("19") && !w.startsWith("20")) {
                    freq[w] = (freq[w] || 0) + 1;
                  }
                }
                return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, maxWords).map(e => e[0]);
              }
              function extractTools(texts) {
                const tools = new Set();
                const all = texts.join(" ");
                const known = ["db_query","web_search","memory_search","github_get_file","github_write_file","create_tool","prompt_edit","review_code","learn","cron_control","search_code","chat"];
                for (const k of known) { if (all.includes(k)) tools.add(k); }
                return [...tools];
              }
              function cleanContent(text) {
                let t = text.replace(/\{\\"tool\\"[^}]+}/g, " ").replace(/\{"tool"[^}]+}/g, " ");
                t = t.replace(/TOOL:\w+[\(\[][\s\S]{0,200}[\)\]]/g, " ");
                t = t.replace(/\[TOOL CALL\]/g, " ");
                t = t.replace(/\[Max steps reached[^\]]*\]/gi, " ");
                t = t.replace(/@(?:cf|hf)\/[^\s]+/g, " ");
                t = t.replace(/\b(datetime|datetime\(\)|datetime\('now'\)|from brain_|select .*? from|insert into|update .*? set)\b/gi, " ");
                t = t.replace(/\[Creator\]\s*/gi, "").replace(/^\[.*?\]\s*/gm, "");
                return t.replace(/\s+/g, " ").trim();
              }
              function hasSubstance(text) {
                const t = cleanContent(text);
                const meaningful = t.split(/\s+/).filter(w => w.length > 3 && !SW.has(w) && w !== "Creator");
                return meaningful.length >= 2;
              }

              const dateStr = new Date().toISOString().split("T")[0];
              const safeConv = (c.conversation_id || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
              const goodMsgs = msgs.results.filter(m => !isJunk(m.content));
              const userMsgs = goodMsgs.filter(m => m.role === "user").map(m => cleanContent(m.content)).filter(Boolean);
              const asstMsgs = goodMsgs.filter(m => m.role === "assistant").map(m => cleanContent(m.content)).filter(Boolean);
              const allTexts = [...userMsgs, ...asstMsgs];

              const topics = extractTopics(allTexts);
              const tools = extractTools(msgs.results.map(m => m.content));
              const questions = userMsgs.filter(hasSubstance).slice(0, 3);
              const answers = asstMsgs.filter(hasSubstance).slice(0, 2);

              const parts = [];
              if (topics.length) parts.push("Discussed " + topics.slice(0, 4).join(", ") + ".");

              if (questions.length) {
                const qs = questions.map(q => q.length > 80 ? q.slice(0, 77) + "..." : q);
                if (qs.length === 1) parts.push("User asked: " + qs[0] + ".");
                else parts.push("User asked about " + qs.join(" and ") + ".");
              }

              if (answers.length) {
                const aText = answers[0].length > 120 ? answers[0].slice(0, 117) + "..." : answers[0];
                parts.push("Skytron responded: " + aText + ".");
                if (answers.length > 1) {
                  const a2 = answers[1].length > 80 ? answers[1].slice(0, 77) + "..." : answers[1];
                  parts.push("Also: " + a2 + ".");
                }
              }

              if (tools.length) parts.push("Used tools: " + tools.join(", ") + ".");
              let summary = parts.join(" ");
              if (!summary) {
                const rawSamples = msgs.results.filter(m => m.role === "user" && m.content.length > 10).map(m => m.content.replace(/\[Creator\]\s*/g, "").slice(0, 200)).filter(Boolean).slice(0, 3);
                summary = rawSamples.length ? "User said: " + rawSamples.join(" | ") : "Conversation with tool operations";
              }

              const convLabel = c.conversation_id === "default" ? "Main" : c.conversation_id;
              await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'memory_loop', 'auto')").bind("memory_loop_" + dateStr + "_" + safeConv, convLabel + " conversation\n" + summary).run();
              convCount++;
            }
          }
        } catch {}

        // 3. Extract stats
        try {
          const stats = await env.DB.prepare("SELECT status, COUNT(*) as c FROM actions WHERE created_at > datetime('now', '-24 hours') GROUP BY status").all();
          if (stats.results?.length) {
            const summary = stats.results.map(s => s.status + ": " + s.c).join(", ");
            await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'insight', 'auto')").bind("stats_" + new Date().toISOString().split("T")[0], "Last 24h action stats: " + summary).run();
            logActivity(db, "maintenance", { summary: "Maintenance cycle — extracted " + lessonCount + " lessons, summarized " + convCount + " conversations, " + summary });
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
        logActivity(db, "cleanup", { summary: "Daily cleanup — removed " + (deleted.meta?.changes||0) + " memories, " + (logTrim.meta?.changes||0) + " logs, " + (actTrim.meta?.changes||0) + " actions, " + (agentTrim.meta?.changes||0) + " agents" });
        console.error("Cleanup: removed " + (deleted.meta?.changes||0) + " old memories, " + (logTrim.meta?.changes||0) + " logs, " + (actTrim.meta?.changes||0) + " actions, " + (agentTrim.meta?.changes||0) + " agents");
      }
    } catch (e) { console.error("cleanup error:", e); }
  }
}

async function getCronSettings(db) {
  const defaults = {
    enabled: true, idle_cycle: true, health_check: true,
    idle_project: true, process_actions: true, stuck_recovery: true,
    process_agents: true, daily_cleanup: true, wake_up: true
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
