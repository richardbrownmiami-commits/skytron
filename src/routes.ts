// === Skytron Routes (HTTP ENDPOINTS) ===
// All HTTP endpoints live here. Key function: handleFetch dispatches by pathname.
// - /think POST: builds systemMsg (HARDCODED_CORE + slot + mood + memory + knowledge → fullHistory), saves agent state
// - /think/result GET: polls action status/result from actions table
// - /skytronchat GET: serves chat.html UI
// - /brain/*: memory, knowledge, logs, agents, prompt, repair, vectorize, etc.
// - /status GET: D1 health check
// - /__cron GET: triggers handleScheduled (also runs via cron trigger)
// If you need a new endpoint, add it here. Keep it under 40 lines per handler.
// CRITICAL: systemMsg assembly at ~line 250 controls what Skytron sees as its identity and instructions.
import { HARDCODED_CORE, SYSTEM_PROMPT, PROMPT_SLOTS } from './constants';
import { initSchema, getPromptSlot, detectTaskType, getState, describeMood, buildSensorium, storeMemory, getRecentMemory, searchKnowledge, semanticSearch, ensureVectorizeIndex, indexAllKnowledge, indexKnowledgeForSearch, saveAgentState, logActivity } from './db';
import { getScratchpad, ensureScratchpadTable, collectToScratchpad } from './consolidate';
import { buildScratchpadJournal } from './scratchpad_journal';
import { processOneStep, processOneAgentStep } from './agents';
import { toolDefinitions } from './tools';
import { callLLM } from './llm';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
});

export async function handleFetch(req, env, ctx, CHAT_HTML) {
  const url = new URL(req.url);

  if (url.pathname === "/skytronchat") return new Response(CHAT_HTML, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });

  if (url.pathname === "/status") {
    let dbOk = false; try { await env.DB.prepare("SELECT 1").run(); dbOk = true; } catch {}
    const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
    return json({ alive: true, db: dbOk, memory: memCount, knowledge: knCount, conversations: convCount, version: "4.0.0" });
  }

  if (url.pathname === "/brain/knowledge" && req.method === "GET") {
    const q = url.searchParams.get("q"), cat = url.searchParams.get("category");
    let results;
    if (q) results = await searchKnowledge(env.DB, q);
    else if (cat) results = (await env.DB.prepare("SELECT key, content, category FROM brain_knowledge WHERE category=?1 ORDER BY key LIMIT 50").bind(cat).all()).results;
    else results = (await env.DB.prepare("SELECT key, content, category FROM brain_knowledge ORDER BY category, key LIMIT 100").all()).results;
    return json({ entries: results });
  }

  if (url.pathname === "/brain/knowledge" && req.method === "POST") {
    let body; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    if (!body.key || !body.content) return json({ error: "key and content required" }, 400);
    try {
      await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, ?3, 'learned')").bind(body.key, body.content, body.category || 'general').run();
      try { await env.DB.prepare("INSERT OR REPLACE INTO knowledge_fts (key, content, category) VALUES (?1, ?2, ?3)").bind(body.key, body.content, body.category || 'general').run(); } catch {}
      try { await indexKnowledgeForSearch(env, body.key, body.content, body.category || 'general'); } catch {}
      return json({ ok: true, key: body.key });
    } catch (e) { return json({ error: e.message }, 400); }
  }

  if (url.pathname === "/brain/memory") {
    const limit = parseInt(url.searchParams.get("limit")) || 20;
    const r = await env.DB.prepare("SELECT role, content, created_at FROM brain_memory ORDER BY id DESC LIMIT ?1").bind(limit).all();
    return json({ entries: (r.results || []).reverse() });
  }

  if (url.pathname === "/brain/memory/search") {
    const q = url.searchParams.get("q"); if (!q) return json({ error: "query param q required" }, 400);
    const like = "%" + q.replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
    const r = await env.DB.prepare("SELECT id, role, content, conversation_id, created_at FROM brain_memory WHERE content LIKE ?1 ORDER BY id DESC LIMIT 50").bind(like).all();
    return json({ query: q, results: r.results || [] });
  }

  if (url.pathname === "/brain/scratchpad" && req.method === "GET") {
    // JSON export if ?export=json (check before HTML so browsers can download)
    if (url.searchParams.get("export") === "json") {
      try {
        await ensureScratchpadTable(env);
        const data = await getScratchpad(env, null);
        const exportData = { exported_at: new Date().toISOString(), total_rows: data.results?.length || 0, rows: data.results || [] };
        const body = JSON.stringify(exportData);
        return new Response(body, {
          headers: { "content-type": "application/json", "content-disposition": "attachment; filename=scratchpad-export.json" }
        });
      } catch (e) { return json({ error: e.message }, 500); }
    }
    // Serve HTML UI if client accepts HTML
    const accept = req.headers.get("accept") || "";
    if (accept.includes("text/html")) {
      return new Response(SCRATCHPAD_UI_HTML, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    try {
      await ensureScratchpadTable(env);
      const batchId = url.searchParams.get("batch") || null;
      const data = await getScratchpad(env, batchId);
      const count = data.results?.length || 0;
      const tables = {};
      const tableLabels = {
        brain_memory: "Conversation messages (user/assistant)",
        actions: "Action history (queries, sensorium noise, results)",
        activity_log: "System activity log (tool calls, errors, ticks)",
        brain_knowledge: "Knowledge base (rules, lessons, journals, stats)",
        identity: "Key-value settings & tracking counters",
        brain_vectors: "Semantic vector fingerprints",
        brain_agents: "Agent step execution records"
      };
      const formatted = {};
      if (data.results) for (const row of data.results) {
        const t = row.source_table;
        if (!formatted[t]) formatted[t] = { label: tableLabels[t] || t, rows: [] };
        tables[t] = (tables[t] || 0) + 1;
        let c;
        try { c = JSON.parse(row.content); } catch { c = { content: row.content }; }
        const ts = (c.created_at || c.updated_at || row.collected_at || "").replace("T", " ").slice(0, 19);
        let d = new Date((ts.endsWith("Z") ? ts : ts + "Z"));
        const fmt = ('0'+d.getDate()).slice(-2)+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+d.getFullYear()+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
        let text = "";
        if (t === "brain_memory") text = "[" + c.role + "] " + (c.content || "");
        else if (t === "actions") text = (c.input || c.result || c.error || "").slice(0, 200);
        else if (t === "activity_log") text = c.summary + (c.details ? " | " + JSON.stringify(c.details).slice(0, 100) : "");
        else if (t === "brain_knowledge") text = "[" + (c.category || c.source) + "] " + (c.content || "").slice(0, 200);
        else if (t === "identity") text = c.key + " = " + (c.value || "").slice(0, 100);
        else if (t === "brain_vectors") text = c.ref_key;
        else if (t === "brain_agents") text = (c.instruction || c.result || "").slice(0, 200);
        else text = (c.content || JSON.stringify(c)).slice(0, 200);
        formatted[t].rows.push({ time: fmt, text });
      }
      return json({ batch_id: batchId || "all", total_rows: count, per_table: tables, formatted });
    } catch (e) { return json({ error: e.message, stack: e.stack }, 500); }
  }

  // --- Manual collect trigger for testing ---
  if (url.pathname === "/brain/scratchpad/collect" && req.method === "POST") {
    try {
      const result = await collectToScratchpad(env);
      return json({ collected: true, batch_id: result.batchId, total_rows: result.totalRows });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/scratchpad/journal" && req.method === "POST") {
    try {
      const result = await buildScratchpadJournal(env);
      return json(result);
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/journal" && req.method === "GET") {
    try {
      const r = await env.DB.prepare("SELECT key, content, created_at FROM brain_knowledge WHERE category='journal' ORDER BY created_at DESC LIMIT 200").all();
      if (req.headers.get("Accept")?.includes("text/html")) {
        const entries = (r.results || []).map((row: any) => { try { return JSON.parse(row.content); } catch { return null; } }).filter(Boolean);
        const statusColors: Record<string, string> = { completed: "#3fb950", built: "#58a6ff", planned: "#d29922", unfinished: "#f85149", discussed: "#8b949e", failed: "#f85149", tested: "#3fb950" };
        const cards = entries.map((e: any) => `
          <div class="card" style="max-width:700px;width:100%">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem">
              <span style="font-weight:600;color:#e6edf3">${e.title || e.topic}</span>
              <span style="font-size:0.75rem;color:#8b949e">${e.date_start?.slice(0,10)}${e.date_end?.slice(0,10) !== e.date_start?.slice(0,10) ? ' &ndash; '+e.date_end?.slice(0,10) : ''}</span>
            </div>
            <div style="font-size:0.85rem;color:#c9d1d9;line-height:1.5">${e.summary}</div>
            <div style="display:flex;gap:0.4rem;margin-top:0.6rem;flex-wrap:wrap">
              <span class="tag" style="background:${statusColors[e.status] || '#8b949e'};color:#0b1120;padding:0.15rem 0.5rem;border-radius:99px;font-size:0.7rem;font-weight:600">${e.status}</span>
              ${(e.incidents||[]).map((i: string) => `<span class="tag" style="background:#f85149;color:#fff;padding:0.15rem 0.5rem;border-radius:99px;font-size:0.7rem">${i}</span>`).join('')}
              ${e.next_topic ? `<span style="font-size:0.7rem;color:#8b949e">→ ${e.next_topic.replace(/_/g,' ')}</span>` : ''}
            </div>
          </div>`).join("\n");
        return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Journal &ndash; Skytron</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;min-height:100vh;padding:2rem;display:flex;flex-direction:column;align-items:center}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1rem;margin:0.4rem;transition:border-color 0.2s}.card:hover{border-color:#58a6ff}</style></head><body><div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;width:100%;max-width:700px"><h1 style="margin-bottom:0">Journal</h1><span style="color:#8b949e;font-size:0.85rem">${entries.length} entries</span><a href="/" style="margin-left:auto;color:#58a6ff;font-size:0.85rem">Dashboard</a></div>${cards}</body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
      }
      return json({ entries: r.results || [] });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- Quick LLM provider test ---
  if (url.pathname === "/brain/llmtest" && req.method === "GET") {
    const model = url.searchParams.get("model") || "gemini-2.5-flash";
    const r = await callLLM(env, { messages: [{ role: "user", content: "reply exactly: ok" }], max_tokens: 5, model, task: "test" });
    return json({ model, status: r.content === "ok" ? "OK" : (r.errors?.[0]?.slice(0, 60) || "no content"), content: r.content });
  }
  if (url.pathname === "/brain/scratchpad/summarize" && req.method === "POST") {
    try {
      await ensureScratchpadTable(env);
      const raw = await getScratchpad(env, null);
      if (!raw.results?.length) return json({ error: "scratchpad empty" }, 400);

      // Build condensed text per table (sample from beginning, middle, and end)
      const tableRows = {};
      for (const row of raw.results) {
        if (!tableRows[row.source_table]) tableRows[row.source_table] = [];
        tableRows[row.source_table].push(row);
      }
      const groups = {};
      for (const [table, rows] of Object.entries(tableRows)) {
        const sample = [];
        const len = rows.length;
        if (len <= 20) { sample.push(...rows); }
        else {
          sample.push(...rows.slice(0, 10));
          sample.push(...rows.slice(Math.floor(len / 2) - 5, Math.floor(len / 2) + 5));
          sample.push(...rows.slice(len - 10));
        }
        groups[table] = [];
        for (const row of sample) {
          if (groups[table].length >= 25) break;
          let c;
          try { c = JSON.parse(row.content); } catch { c = {}; }
          const ts = (c.created_at || c.updated_at || row.collected_at || "").replace("T", " ").slice(0, 16);
          let text = "";
          if (table === "brain_memory") text = "[" + c.role + "] " + (c.content || "");
          else if (table === "actions") text = (c.input || c.result || c.error || "empty").slice(0, 80);
          else if (table === "activity_log") text = c.summary || "";
          else if (table === "brain_knowledge") text = "[" + (c.category || c.source) + "] " + (c.content || "").slice(0, 100);
          else if (table === "identity") text = c.key + " = " + (c.value || "").slice(0, 60);
          else if (table === "brain_vectors") text = c.ref_key || "";
          else if (table === "brain_agents") text = (c.instruction || c.result || "").slice(0, 100);
          else text = JSON.stringify(c).slice(0, 100);
          groups[table].push(ts + " " + text);
        }
      }

      const condensed = Object.entries(groups).map(([table, rows]) =>
        "=== " + table + " ===\n" + rows.join("\n")
      ).join("\n\n");

      const prompt = "You are reviewing raw data from an autonomous AI agent called Skytron. Below is a comprehensive sample of data from each of its database tables.\n\n" +
        "YOUR TASK: Write a DETAILED, ELABORATE narrative summary of everything this agent has done. This is NOT a bullet list or tl;dr — write full paragraphs organized by day and topic. Be thorough.\n\n" +
        "REQUIREMENTS:\n" +
        "- ORGANIZE by day/week with clear date headings (e.g., 'June 1-10: Initial Setup')\n" +
        "- For EACH day, describe: what conversations happened, what tools were built/modified, what problems occurred, what knowledge was learned\n" +
        "- Highlight periods of intense activity (many actions clustered in short time)\n" +
        "- Mention specific tool names, error messages, conversation topics, and knowledge entries\n" +
        "- Describe the progression: how the agent evolved over time (early bugs → later fixes → new capabilities)\n" +
        "- Be specific: include exact dates (June 19), exact tool names (db_query, web_search, github_write), exact error messages\n" +
        "- Each period should get 3-8 full sentences, not 1-2 lines\n\n" +
        "IGNORE (skip these entirely, don't mention them):\n" +
        "- Greetings (hello/hi/hey)\n" +
        "- Simple math Q&A (what is 2+2)\n" +
        "- Sensorium ticks (periodic energy/memory status checks)\n" +
        "- Duplicate entries\n" +
        "- Raw tool JSON blobs\n" +
        "- Empty/failed actions without meaningful content\n" +
        "- One-word answers, '[Reached max steps]', connection errors to LLM providers\n\n" +
        condensed + "\n\n---\nWrite the detailed narrative summary now. Full paragraphs, organized by date/topic:";

      const model = url.searchParams.get("model") || "gemini-2.5-flash";
      const result = await callLLM(env, { messages: [{ role: "user", content: prompt }], max_tokens: 3000, model, task: "summarize" });
      return json({ summary: result.content, model: result.model, rows_sampled: raw.results.length, errors: result.errors });
    } catch (e) { return json({ error: e.message, stack: e.stack }, 500); }
  }

  if (url.pathname === "/cron/settings") {
    if (req.method === "POST") {
      let body; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const allowed = ["enabled","log_tick","idle_cycle","health_check","slot_self_improve","slot_test","slot_research","slot_housekeep","idle_project","tool_dispatch","process_actions","stuck_recovery","process_agents","daily_cleanup","night_sleep","wake_up","task_web_search","task_memory_search","task_learn","task_db_query","task_review_code"];
      for (const k of allowed) {
        if (body[k] !== undefined) {
          await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('cron_cfg_' || ?1, ?2, datetime('now'))").bind(k, body[k] ? "true" : "false").run();
        }
      }
      return json({ ok: true });
    }
    const rows = (await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'cron_cfg_%'").all()).results || [];
    const s = {};
    for (const r of rows) s[r.key.replace("cron_cfg_","")] = r.value === "true";
    const d = { enabled: true, log_tick: false, idle_cycle: true, health_check: true, slot_self_improve: true, slot_test: true, slot_research: true, slot_housekeep: true, idle_project: true, tool_dispatch: true, process_actions: true, stuck_recovery: true, process_agents: true, daily_cleanup: true, night_sleep: true, wake_up: true, task_web_search: true, task_memory_search: true, task_learn: true, task_db_query: true, task_review_code: true };
    const set = (k) => s[k] !== undefined ? s[k] : d[k];
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cron Tick Settings</title><style>*{margin:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:2rem;max-width:700px;margin:auto}h1{color:#58a6ff;margin-bottom:0.5rem}.sub{color:#8b949e;font-size:0.85rem;margin-bottom:1.5rem}.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1rem;margin-bottom:1rem}.section h2{font-size:1rem;color:#58a6ff;margin-bottom:0.5rem}.row{display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid #21262d}.row:last-child{border:none}.label{flex:1}.label .desc{font-size:0.75rem;color:#8b949e;margin-top:2px}.switch{position:relative;width:44px;height:24px;flex-shrink:0;margin-left:1rem}input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#30363d;transition:.3s;border-radius:24px}.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background-color:#e6edf3;transition:.3s;border-radius:50%}input:checked+.slider{background-color:#3fb950}input:checked+.slider:before{transform:translateX(20px)}.btn{padding:0.5rem 1.5rem;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;background:#3fb950;color:#0b1120;font-weight:600;display:none;margin-top:0.5rem}.btn.show{display:inline-block}.saved{color:#3fb950;font-size:0.85rem;margin-top:0.5rem;display:none}</style></head><body><h1>Cron Tick Settings</h1><p class="sub">Toggle what Skytron does each idle tick. All settings are read on every tick.</p>
<div class="section"><h2>Master</h2>
<div class="row"><div class="label">Enabled<div class="desc">Master switch — disables ALL cron activity when off</div></div><label class="switch"><input type="checkbox" id="enabled" `+(set("enabled")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Night Sleep UTC 20‑2<div class="desc">Skip cron during sleep hours (IST 1:30AM–7:30AM)</div></div><label class="switch"><input type="checkbox" id="night_sleep" `+(set("night_sleep")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Wake-Up Heartbeat<div class="desc">Queue a think action every ~15min so Skytron stays awake</div></div><label class="switch"><input type="checkbox" id="wake_up" `+(set("wake_up")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Logging</h2>
<div class="row"><div class="label">Log free_time_tick<div class="desc">Log every idle tick to brain_logs (was on by default — noisy)</div></div><label class="switch"><input type="checkbox" id="log_tick" `+(set("log_tick")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Action Processing</h2>
<div class="row"><div class="label">Process Actions<div class="desc">Pick and execute queued actions</div></div><label class="switch"><input type="checkbox" id="process_actions" `+(set("process_actions")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Stuck Recovery<div class="desc">Detect and requeue actions stuck in running for >2min</div></div><label class="switch"><input type="checkbox" id="stuck_recovery" `+(set("stuck_recovery")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Process Agents<div class="desc">Process sub-agent steps</div></div><label class="switch"><input type="checkbox" id="process_agents" `+(set("process_agents")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Idle Cycle</h2>
<div class="row"><div class="label">Idle LLM Cycle<div class="desc">Master — call LLM each idle tick to decide what to do</div></div><label class="switch"><input type="checkbox" id="idle_cycle" `+(set("idle_cycle")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Health Check<div class="desc">Check BD health once/hour when idle</div></div><label class="switch"><input type="checkbox" id="health_check" `+(set("health_check")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Tool Dispatch<div class="desc">Actually run the tool the LLM chose (off = LLM decides but nothing runs)</div></div><label class="switch"><input type="checkbox" id="tool_dispatch" `+(set("tool_dispatch")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Project Continuation<div class="desc">Continue complex tasks (self_improve/test) across multiple ticks</div></div><label class="switch"><input type="checkbox" id="idle_project" `+(set("idle_project")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Hour Slots</h2>
<div class="row"><div class="label">Self‑Improve (HH%4=0)<div class="desc">review_code, create_tool — complex multi-tick</div></div><label class="switch"><input type="checkbox" id="slot_self_improve" `+(set("slot_self_improve")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Test (HH%4=1)<div class="desc">Run checks after changes</div></div><label class="switch"><input type="checkbox" id="slot_test" `+(set("slot_test")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Research (HH%4=2)<div class="desc">web_search, memory_search — quick per tick</div></div><label class="switch"><input type="checkbox" id="slot_research" `+(set("slot_research")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Housekeep (HH%4=3)<div class="desc">learn, db_query — quick per tick</div></div><label class="switch"><input type="checkbox" id="slot_housekeep" `+(set("slot_housekeep")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Per‑Task Toggles</h2>
<div class="row"><div class="label">Web Search<div class="desc">search the web for info</div></div><label class="switch"><input type="checkbox" id="task_web_search" `+(set("task_web_search")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Memory Search<div class="desc">search brain memory/knowledge</div></div><label class="switch"><input type="checkbox" id="task_memory_search" `+(set("task_memory_search")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Learn<div class="desc">store facts, lessons, journals</div></div><label class="switch"><input type="checkbox" id="task_learn" `+(set("task_learn")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">DB Query<div class="desc">run SQL SELECT queries</div></div><label class="switch"><input type="checkbox" id="task_db_query" `+(set("task_db_query")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Review Code<div class="desc">self-audit, review source files</div></div><label class="switch"><input type="checkbox" id="task_review_code" `+(set("task_review_code")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<div class="section"><h2>Maintenance</h2>
<div class="row"><div class="label">Daily Cleanup<div class="desc">Trim old memories, logs, actions, agents once/day</div></div><label class="switch"><input type="checkbox" id="daily_cleanup" `+(set("daily_cleanup")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
</div>
<p class="saved" id="saved">✓ Saved</p>
<script>async function save(){const s={};document.querySelectorAll('input[type=checkbox]').forEach(c=>{s[c.id]=c.checked});await fetch('/cron/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});const e=document.getElementById('saved');e.style.display='block';setTimeout(()=>e.style.display='none',2000)}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
  }

  if (url.pathname === "/brain/source") {
    return json({
      language: "TypeScript", runtime: "Cloudflare Workers (ES module)", file: "src/ (modular)",
      endpoints: ["/think","/status","/skytronchat","/","/brain/history","/brain/memory","/brain/memory/search","/brain/knowledge","/brain/prompt","/brain/prompt/reset","/brain/repair","/brain/logs","/brain/vectorize","/brain/introspect","/brain/source","/brain/agents","/cron/settings"],
      tools: Object.keys(toolDefinitions),
      tables: ["identity","brain_memory","brain_knowledge","actions","brain_logs","brain_agents","knowledge_fts"],
      llm: "Workers AI (@cf/zai-org/glm-4.7-flash) + BUDDHI_DWAR (Groq + OpenCode Zen)",
      agent_loop: "Multi-step function-calling with Zod schema validation (max 15 steps). Sub-agents: spawn_agent + get_agent_result for parallel specialized tasks (max 8 steps, limited tools).",
      capabilities: ["conversation with 10-msg memory","web search","web fetch","DB introspection","prompt self-edit","code execution (38+ langs)","API calls","knowledge base (FTS5 + vector)","GitHub self-modification","live docs via Context7","emotions & energy","conversation history viewer","sub-agents for parallel tools"]
    });
  }

  if (url.pathname === "/brain/prompt/reset" && (req.method === "GET" || req.method === "POST")) {
    const confirm = url.searchParams.get("confirm");
    if (confirm !== "yes") return json({ error: "Add ?confirm=yes to reset." }, 400);
    const current = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all();
    if (current.results?.[0]?.value) { try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'prompt_backup', 'backup')").bind("prompt_backup_" + Date.now(), current.results[0].value).run(); } catch {} }
    try { await env.DB.prepare("DELETE FROM identity WHERE key='prompt_override'").run(); } catch {}
    return json({ ok: true, message: "Reset to default. Previous version backed up as prompt_backup_*." });
  }

  if (url.pathname === "/brain/introspect") {
    const totalMem = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const totalKn = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    const totalActions = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions").all()).results[0]?.c || 0;
    const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
    const topConvs = (await env.DB.prepare("SELECT conversation_id, COUNT(*) as msg_count, MIN(created_at) as start, MAX(created_at) as end FROM brain_memory GROUP BY conversation_id ORDER BY msg_count DESC LIMIT 10").all()).results || [];
    const recent = (await env.DB.prepare("SELECT DATE(created_at) as day, COUNT(*) as count FROM brain_memory WHERE created_at > datetime('now', '-30 days') GROUP BY day ORDER BY day DESC").all()).results || [];
    const cats = (await env.DB.prepare("SELECT category, COUNT(*) as count FROM brain_knowledge GROUP BY category ORDER BY count DESC").all()).results || [];
    return json({ summary: { total_memories: totalMem, total_knowledge: totalKn, total_actions: totalActions, conversations: convCount }, top_conversations: topConvs, activity_30d: recent, knowledge_categories: cats });
  }

  if (url.pathname === "/brain/history") {
    const convId = url.searchParams.get("c") || "default";
    const page = Math.max(1, parseInt(url.searchParams.get("p")) || 1);
    const off = (page - 1) * 50;
    const total = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory WHERE conversation_id=?1").bind(convId).all()).results[0]?.c || 0;
    const r = await env.DB.prepare("SELECT id, role, content, created_at FROM brain_memory WHERE conversation_id=?1 ORDER BY id ASC LIMIT 50 OFFSET ?2").bind(convId, off).all();
    const convs = (await env.DB.prepare("SELECT DISTINCT conversation_id FROM brain_memory ORDER BY conversation_id").all()).results || [];
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const msgs = (r.results || []).map(m => { const nm = m.content.match(/^\[([^\]]+)\]\s*/); const label = nm ? nm[1] : (m.role==='user'?'You':'Skytron'); const txt = nm ? m.content.slice(nm[0].length) : m.content; return `<div class="msg ${m.role}"><div class="meta"><span class="label">${label}</span><span class="time">${(m.created_at||'').slice(0,19)}</span></div><div class="text">${esc(txt)}</div></div>`; }).join("\n");
    const totalPages = Math.ceil(total/50)||1;
const q = `c=${encodeURIComponent(convId)}`;
const nav = `<div class="nav" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center">${page>1?`<a href="?${q}&p=1">\u00AB\u00AB</a><a href="?${q}&p=${page-1}">\u00AB</a>`:`<span style="color:#30363d">\u00AB\u00AB</span><span style="color:#30363d">\u00AB</span>`}<span style="color:#8b949e">Page</span><form style="display:inline;margin:0" method="GET" action=""><input type="hidden" name="c" value="${convId.replace(/"/g,'&quot;')}"/><input type="number" name="p" value="${page}" min="1" max="${totalPages}" style="width:55px;padding:4px 6px;border-radius:6px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:0.85rem;text-align:center;outline:none"/><button type="submit" style="padding:4px 10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#58a6ff;cursor:pointer;font-size:0.85rem;margin-left:4px">Go</button></form><span style="color:#8b949e">of ${totalPages} (${total} msgs)</span>${page<totalPages?`<a href="?${q}&p=${page+1}">\u00BB</a><a href="?${q}&p=${totalPages}">\u00BB\u00BB</a>`:`<span style="color:#30363d">\u00BB</span><span style="color:#30363d">\u00BB\u00BB</span>`}</div>`;
    const sel = convs.map(c => `<option value="${c.conversation_id.replace(/"/g,'&quot;')}"${c.conversation_id===convId?' selected':''}>${c.conversation_id}</option>`).join("\n");
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain Chat</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto;min-height:100vh;display:flex;flex-direction:column}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.control{margin-bottom:1rem}select{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:0.5rem;width:100%;font-size:1rem}.msgs{flex:1;overflow-y:auto}.msg{padding:1rem 1.2rem;margin-bottom:0.6rem;border-radius:10px;font-size:1rem;line-height:1.6}.msg.user{background:#1e3a5f;margin-left:1rem}.msg.assistant{background:#161b22;border:1px solid #30363d;margin-right:1rem}.meta{display:flex;justify-content:space-between;margin-bottom:0.4rem}.label{font-weight:600;font-size:0.85rem}.user .label{color:#60a5fa}.assistant .label{color:#94a3b8}.time{color:#6b7280;font-size:0.8rem}.text{word-break:break-word;white-space:pre-wrap}.nav{display:flex;justify-content:space-between;align-items:center;padding:0.8rem 0;color:#8b949e;font-size:0.9rem}.nav a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px}.nav a:hover{background:#1f2937}.empty{text-align:center;padding:2rem;color:#6b7280}.input-row{display:flex;gap:0.5rem;padding:1rem 0;border-top:1px solid #30363d;margin-top:auto}input{flex:1;padding:0.8rem 1rem;border-radius:8px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:1rem;outline:none}input:focus{border-color:#58a6ff}button{padding:0.8rem 1.2rem;border-radius:8px;border:none;background:#58a6ff;color:#0b1120;font-weight:bold;font-size:1rem;cursor:pointer}button:disabled{opacity:0.5}</style></head><body><h1>Chat with Skytron</h1><div class="control"><select id="convSelect" onchange="if(this.value)window.location='?c='+encodeURIComponent(this.value)"><option value="">-- Select conversation --</option>${sel}</select></div><div class="msgs">${msgs.length?msgs:`<div class="empty">No messages yet. Start a conversation via /skytronchat or POST /think</div>`}</div>${nav}<div class="input-row"><input type="text" id="msgInput" placeholder="Type your message..." /><button id="sendBtn" onclick="send()">Send</button></div>
<script>
var inp=document.getElementById('msgInput'),btn=document.getElementById('sendBtn');
inp.addEventListener('keydown',function(e){if(e.key==='Enter')send()});
btn.addEventListener('click',send);
async function send(){var t=inp.value.trim();if(!t)return;var conv=document.getElementById('convSelect').value;inp.value='';btn.disabled=true;btn.textContent='...';try{var r=await fetch('/think?c='+encodeURIComponent(conv),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:t})});var d=await r.json();location.reload()}catch(e){btn.disabled=false;btn.textContent='Send'}}
</script>
</body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  if (url.pathname === "/brain/prompt" && req.method === "GET") {
    const ov = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all();
    const slots = await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'prompt_slot_%'").all();
    const slotMap = {};
    for (const r of slots.results || []) slotMap[r.key.replace("prompt_slot_", "")] = r.value.slice(0, 200) + "...";
    return json({ active: !!ov.results[0]?.value, editable: (ov.results[0]?.value || SYSTEM_PROMPT).slice(0, 500) + "...", slots: slotMap });
  }

  if (url.pathname === "/brain/prompt" && req.method === "POST") {
    let body; try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    if (!body.prompt) return json({ error: "prompt required" }, 400);
    const key = body.slot ? "prompt_slot_" + body.slot : "prompt_override";
    await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES (?1,?2,datetime('now'))").bind(key, body.prompt).run();
    return json({ ok: true, slot: body.slot || "global" });
  }

  if (url.pathname === "/brain/prompt/slots" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT key, value, updated_at FROM identity WHERE key LIKE 'prompt_slot_%' ORDER BY key").all();
    const slots = {};
    for (const row of r.results || []) slots[row.key.replace("prompt_slot_", "")] = row.value.slice(0, 200) + "...";
    return json({ slots, detected_types: Object.keys(PROMPT_SLOTS) });
  }

  if (url.pathname === "/brain/repair" && (req.method === "GET" || req.method === "POST")) {
    const fixes = [];
    const stuck = await env.DB.prepare("UPDATE actions SET status='error', result='Timeout', completed_at=datetime('now') WHERE status='running' AND created_at < datetime('now', '-10 minutes')").run();
    if (stuck.meta?.changes > 0) fixes.push("Fixed " + stuck.meta.changes + " stuck actions");
    const oldLogs = await env.DB.prepare("DELETE FROM brain_logs WHERE id NOT IN (SELECT id FROM brain_logs ORDER BY id DESC LIMIT 500)").run();
    if (oldLogs.meta?.changes > 0) fixes.push("Cleaned " + oldLogs.meta.changes + " old logs");
    return json({ fixes });
  }

  if (url.pathname === "/" && req.method === "GET") {
    const state = await getState(env.DB);
    const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem;margin:0.5rem;max-width:500px;width:100%}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.stat{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #21262d;font-size:0.85rem}.stat:last-child{border:none}.label{color:#8b949e}.links{display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap}.links a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px;font-size:0.8rem}.links a:hover{background:#1f2937}</style></head><body><h1>Skytron</h1><div class="card"><div class="stat"><span class="label">Energy</span><span class="val" style="color:${state.reg.energy>60?'#3fb950':state.reg.energy>30?'#d29922':'#f85149'}">${state.reg.energy}%</span></div><div class="stat"><span class="label">Happy</span><span class="val">${state.emotions.happy}/10</span></div><div class="stat"><span class="label">Energetic</span><span class="val">${state.emotions.energetic}/10</span></div><div class="stat"><span class="label">Memory</span><span class="val">${memCount} messages</span></div><div class="stat"><span class="label">Knowledge</span><span class="val">${knCount} facts</span></div></div><div class="card"><div class="links"><a href="/skytronchat">Chat</a><a href="/status">Status</a><a href="/brain/history">History</a><a href="/brain/memory">Memory</a><a href="/brain/memory/search?q=">Search</a><a href="/brain/knowledge">Knowledge</a><a href="/brain/introspect">Insights</a><a href="/brain/journal">Journal</a><a href="/brain/source">About</a></div></div></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  if (url.pathname === "/brain/logs") {
    const limit = parseInt(url.searchParams.get("limit")) || 50;
    const actionId = url.searchParams.get("action_id");
    let r;
    if (actionId) {
      r = await env.DB.prepare("SELECT id, action_id, step, model, tokens, content, created_at FROM brain_logs WHERE action_id = ?1 ORDER BY step ASC LIMIT ?2").bind(actionId, limit).all();
    } else {
      r = await env.DB.prepare("SELECT id, action_id, step, model, tokens, content, created_at FROM brain_logs ORDER BY id DESC LIMIT ?1").bind(limit).all();
    }
    return json({ entries: r.results || [] });
  }

  if (url.pathname === "/brain/status") {
    let dbOk = false; try { await env.DB.prepare("SELECT 1").run(); dbOk = true; } catch {}
    const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    const convCount = (await env.DB.prepare("SELECT COUNT(DISTINCT conversation_id) as c FROM brain_memory").all()).results[0]?.c || 0;
    return json({ alive: true, db: dbOk, entries: memCount, knowledge: knCount, conversations: convCount, version: "4.0.0" });
  }

  if (url.pathname === "/brain/health" && req.method === "GET") {
    try {
      const resp = await fetch("https://buddhi-dwar.richard-brown-miami.workers.dev/v1/providers/health", {
        headers: { Authorization: "Bearer " + env.BRAIN_KEY },
        signal: AbortSignal.timeout(10000)
      });
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/usage" && req.method === "GET") {
    try {
      const days = parseInt(url.searchParams.get("days")) || 1;
      const resp = await fetch("https://buddhi-dwar.richard-brown-miami.workers.dev/analytics?days=" + days, {
        headers: { Authorization: "Bearer " + env.BRAIN_KEY },
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) return json({ error: "failed to fetch usage" }, 502);
      const data = await resp.json();
      return json({ usage: data });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/vectorize" && req.method === "POST") {
    try { await ensureVectorizeIndex(env); await indexAllKnowledge(env, env.DB); return json({ ok: true, indexed: true }); } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- OpenAI-compatible /v1/chat/completions proxy (Workers AI only) ---
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    try {
      const body = await req.json();
      const messages = body.messages || [];
      if (!messages.length) return json({ error: "messages required" }, 400);
      const model = body.model || "@cf/zai-org/glm-4.7-flash";
      const maxTokens = body.max_tokens || 2000;
      const stream = body.stream || false;
      if (stream) return json({ error: "streaming not supported" }, 400);
      let result;
      if (env.AI) {
        result = await env.AI.run(model, { messages, max_tokens: maxTokens });
      } else {
        return json({ error: "AI binding not configured" }, 500);
      }
      const content = typeof result?.response === "string" ? result.response : (result?.choices?.[0]?.message?.content || "");
      if (!content) return json({ error: "empty response from Workers AI" }, 502);
      return json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "workers-ai/glm-4.7-flash",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total: 0 }
      });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- ASYNC /think — enqueue, return immediately ---
  if (url.pathname === "/think" && req.method === "POST") {
    try {
      let input, from, mode;
      try { const body = await req.json(); input = body.input; from = body.from; mode = body.mode || "discussion"; } catch { return json({ error: "invalid JSON body" }, 400); }
      if (!input || typeof input !== "string") return json({ error: "input required" }, 400);
      if (!["discussion", "build"].includes(mode)) mode = "discussion";

      const creatorMatch = input.match(/^@creator\s+(.+)/i);
      if (creatorMatch) { from = "Creator"; input = creatorMatch[1]; }

      const llmInput = `[${from || "Creator"}] ${input}`;
      const conversationId = url.searchParams.get("c") || "default";

      await storeMemory(env.DB, "user", llmInput.slice(0, 2000), conversationId);

      const taskType = detectTaskType(input);
      const r = await env.DB.prepare("INSERT INTO actions (type, status, input, task) VALUES ('think', 'running', ?1, ?2) RETURNING id").bind(input, taskType).all();
      const aid = r.results[0].id;
      // Store mode in agent state for processOneStep to read
      logActivity(env.DB, "user_action", { actionId: aid, summary: "User asked: " + input.slice(0, 150), details: JSON.stringify({ from: from || "Creator", taskType, mode, input: input.slice(0, 500) }) });

      let slotContent = await getPromptSlot(env.DB, taskType);
      if (!slotContent) {
        const ov = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all().catch(() => ({}));
        slotContent = (ov.results?.[0]?.value && ov.results[0].value !== "null" && ov.results[0].value !== "DELETE|OVERRIDE") ? ov.results[0].value : SYSTEM_PROMPT;
      }
      const basePrompt = HARDCODED_CORE + "\n\n" + slotContent + "\n\n[TASK: " + taskType + "]";

      const stateData = await getState(env.DB);
      const mood = describeMood(stateData.emotions, stateData.reg.energy);
      const sensorium = await buildSensorium(env);
      const recentMem = await getRecentMemory(env.DB, 50, conversationId);

      let conversationContext = "";
      if (recentMem.length > 0) conversationContext = "\n\nRECENT CONVERSATION:\n" + recentMem.map(m => { var c = m.content.slice(0, 2000); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,200}?[\)\]\]]/g, "[TOOL CALL - see history page]"); return "[" + m.role + "]: " + c; }).join("\n") + "\n";

      let knowledgeContext = "";
      let memoryPack = "";
      try {
        const kw = await searchKnowledge(env.DB, input, 3);
        if (kw.length) knowledgeContext = "\n\nRELEVANT KNOWLEDGE:\n" + kw.map(k => "- " + k.key + " (" + k.category + "): " + k.content.slice(0, 200)).join("\n") + "\n";
        const sem = await semanticSearch(env, input, 3);
        if (sem.length) knowledgeContext += "\nSEMANTIC MATCHES:\n" + sem.map(s => "- " + s.key + " (score: " + s.score.toFixed(2) + "): " + s.content.slice(0, 200)).join("\n") + "\n";
        // Always load memory pack if it exists — OVERRIDES the brevity rule for recall questions
        const mp = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key='memory_pack_main'").first();
        if (mp?.content) memoryPack = "\n\n## What I Remember:\n" + mp.content.slice(0, 4000) + "\n";
      } catch {}

      const STOP_WORDS = new Set(["you","your","this","that","with","from","have","been","were","they","their","what","about","which","when","where","how","why","just","like","know","think","want","need","can","will","would","should","could","did","does","doing","done","make","made","gets","got","get","say","says","said","tell","told","ask","asked","use","used","using","look","looking","found","find","help","need","take","took","thing","things","much","many","some","any","all","each","every","both","few","more","most","other","into","over","after","before","between","under","again","further","then","once","here","there","very","too","also","not","yes","no","maybe","always","never","sometimes","often","usually","well","back","still","already","yet","because","though","although","while","during","until","since","result","answer","question","previous","last","next","first","second","new","old","good","bad","big","small","long","short","high","low","same","different","own","very","really","actually","basically","literally","probably","maybe","perhaps","please","thank","thanks","ok","okay","hi","hello","hey","yes","no","yeah","nope","sure","fine","great","nice","cool","awesome","amazing","perfect","love","hate","sorry","wait","stop","go","come","let","put","set","run","move","show","try","keep","start","end","begin","done","doing","going","coming","taking","making","giving","using","working","looking","trying","asking","telling","saying","thinking","feeling","knowing","seeing","hearing","being","having"]);

      let memoryContext = "";
      try {
        const rawWords = input.split(/\s+/).filter(w => w.length > 2).slice(0, 12).map(w => w.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase()).filter(Boolean);
        const words = rawWords.filter(w => !STOP_WORDS.has(w));
        const phrases = input.match(/"([^"]+)"/g)?.map(p => p.slice(1, -1).toLowerCase()) || [];
        const allTerms = [...words, ...phrases];
        if (allTerms.length >= 1) {
          const recentIds = recentMem.map(m => m.id).filter(id => id != null).join(",");
          const likes = allTerms.map(k => "LOWER(content) LIKE '%" + k.replace(/'/g, "''") + "%'").join(" OR ");
          let sql = "SELECT role, content, created_at, conversation_id FROM brain_memory WHERE (" + likes + ")";
          if (recentIds) sql += " AND id NOT IN (" + recentIds + ")";
          sql += " ORDER BY id DESC LIMIT 20";
          const mr = await env.DB.prepare(sql).all();
          if (mr.results?.length) {
            const memStr = mr.results.map(m => { var c = m.content.slice(0, 2000); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,200}?[\)\]\]]/g, "[TOOL CALL]"); return "[" + m.conversation_id + " " + m.role + " " + (m.created_at || "") + "]: " + c; }).join("\n");
            memoryContext = "\n\nPAST MEMORIES:\n" + memStr + "\n";
          }
          const loopSql = "SELECT key, content FROM brain_knowledge WHERE category='memory_loop' AND (" + likes + ") ORDER BY key DESC LIMIT 5";
          const loops = await env.DB.prepare(loopSql).all();
          if (loops.results?.length) {
            memoryContext += "\nPAST CONVERSATION SUMMARIES:\n" + loops.results.map(l => "- " + l.key + ": " + l.content.slice(0, 500)).join("\n") + "\n";
          }
        }
        // Fallback: if no meaningful keywords matched, show recent activity across all conversations
        if (!memoryContext && recentMem.length < 5) {
          const recentAll = await env.DB.prepare("SELECT role, content, conversation_id, created_at FROM brain_memory WHERE conversation_id != ?1 ORDER BY id DESC LIMIT 15").bind(conversationId).all();
          if (recentAll.results?.length) {
            memoryContext = "\n\nRECENT ACTIVITY (other conversations):\n" + recentAll.results.map(m => { var c = m.content.slice(0, 1000); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,200}?[\)\]\]]/g, "[TOOL CALL]"); return "[" + m.conversation_id + " " + m.role + " " + (m.created_at || "") + "]: " + c; }).join("\n") + "\n";
          }
        }
      } catch {}

      const systemMsg = basePrompt + "\n\n" + mood + "\n" + sensorium + conversationContext + memoryContext + knowledgeContext + memoryPack + "\n\n# NOW RESPOND TO THE USER'S LATEST MESSAGE\nOutput ONLY: a direct answer to the user (plain text) OR a raw JSON tool call. Do NOT summarize, analyze, or narrate the conversation history above. Do NOT talk about the user in third person. Never start with 'The user...' or 'Looking at...' or 'I should...'. Just answer directly or call a tool.\n\nCRITICAL: If asked what you can do, list your tools briefly. Never list generic capabilities.\n\nIMPORTANT: Do NOT copy the format or style from past conversation examples. Answer freshly in your own natural voice every time.";
      const fullHistory = [
        { role: "system", content: systemMsg.slice(0, 32000) },
        { role: "user", content: llmInput }
      ];

      await saveAgentState(env.DB, aid, { step: 0, fullHistory, totalTokens: 0, finalContent: null, modelName: "", conversationId, done: false, mode });

      return json({ action_id: aid, status: "queued", message: "Request queued. Poll /think/result?id=" + aid + " for result." });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // --- /think/process — manually process the next queued/running action (step-by-step, one batch at a time) ---
  if (url.pathname === "/think/process" && req.method === "POST") {
    try {
      // Re-queue stale running actions (running for > 1 minute with no result)
      await env.DB.prepare("UPDATE actions SET status='queued' WHERE status='running' AND result IS NULL AND created_at < datetime('now', '-1 minute')").run();
      // Grab the next queued action
      await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1").run();
      const q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all();
      if (q.results?.length) {
        await processOneStep(env, q.results[0]);
        return json({ processed: true, action_id: q.results[0].id, status: "batch_complete" });
      }
      return json({ processed: false, message: "no queued actions" });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/__cron" && req.method === "GET") {
    try { await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1").run(); const q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all(); if (q.results?.length) { await processOneStep(env, q.results[0]); return json({ processed: true, action_id: q.results[0].id }); } return json({ processed: false, message: "no queued actions" }); } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/__cron_agent" && req.method === "GET") {
    try { await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NOT NULL AND updated_at < datetime('now', '-2 minutes')").run(); await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NULL AND created_at < datetime('now', '-2 minutes')").run(); const q = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 1").all(); if (q.results?.length) { await processOneAgentStep(env, q.results[0]); return json({ processed: true, agent_id: q.results[0].id }); } return json({ processed: false, message: "no queued agents" }); } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/agents" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit")) || 20;
    const r = await env.DB.prepare("SELECT id, name, role, instruction, status, step, tokens, model, created_at, updated_at FROM brain_agents ORDER BY id DESC LIMIT ?1").bind(limit).all();
    return json({ agents: r.results || [] });
  }
  if (url.pathname.startsWith("/brain/agents/") && req.method === "GET") {
    const id = parseInt(url.pathname.split("/").pop()) || 0;
    if (!id) return json({ error: "id required" }, 400);
    const r = await env.DB.prepare("SELECT id, name, role, instruction, status, result, step, tokens, model, created_at, updated_at FROM brain_agents WHERE id=?1").bind(id).all();
    if (!r.results?.length) return json({ error: "not found" }, 404);
    return json(r.results[0]);
  }
  if (url.pathname.startsWith("/brain/agents/") && req.method === "DELETE") {
    const id = parseInt(url.pathname.split("/").pop()) || 0;
    if (!id) return json({ error: "id required" }, 400);
    const r = await env.DB.prepare("DELETE FROM brain_agents WHERE id=?1").bind(id).run();
    return json({ deleted: (r.meta?.changes || 0) > 0 });
  }
  if (url.pathname === "/brain/agents" && req.method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM brain_agents WHERE status IN ('done','error')").run();
    return json({ deleted: r.meta?.changes || 0 });
  }

  if (url.pathname === "/think/result" && req.method === "GET") {
    const id = parseInt(url.searchParams.get("id")) || 0;
    if (!id) return json({ error: "id required" }, 400);
    const r = await env.DB.prepare("SELECT id, status, result, error, created_at, completed_at FROM actions WHERE id=?1").bind(id).all();
    if (!r.results?.length) return json({ error: "not found" }, 404);
    const entry = r.results[0];
    if (entry.result && typeof entry.result === "string") entry.result = entry.result
      .replace(/^As\s+an\s+AI[,.]?\s+[\s\S]*/i, "Skytron.")
      .replace(/^I\s+am\s+Skytron[,.]?\s*(?:an?\s+)?(?:helpful\s+)?(?:AI\s+)?(?:assistant|model|chatbot|bot)[,.]?\s*(?:I\s+)?(?:can|am|will|would|have).*/i, "Skytron.")
      .replace(/^I'm\s+Skytron[,.]?\s*(?:an?\s+)?(?:helpful\s+)?(?:AI\s+)?(?:assistant|model|chatbot|bot)[,.]?\s*(?:I\s+)?(?:can|am|will|would|have).*/i, "Skytron.")
      .replace(/\b(?:an?\s+|as an?\s+)?(?:AI\s+(?:assistant|model|chatbot|bot)|language model|LLM)\b/gi, "")
      .replace(/(I\s+am|I'm)\s+Skytron\s*[,.]?\s*$/i, (m) => m.replace(/[,.]?\s*$/, "") + ".")
      .replace(/\bI am an AI\b/gi, "I am Skytron")
      .replace(/\bI'm an AI\b/gi, "I'm Skytron")
      .replace(/\ba\s+helpful\s+(?=\w)/gi, "")
      .replace(/\s+created\s+by\s+(?:Google|OpenAI|Anthropic|Meta|Microsoft|Amazon|DeepMind|Claude|GPT|LLM)/gi, "")
      .replace(/\b(?:natural language processing|NLP|knowledge retrieval|content generation)\b/gi, "thinking")
      .replace(/\b(?:advanced|extensive|sophisticated|state.?of.?the.?art)\s+(?:capabilities?|abilities?)\b/gi, "capabilities")
      .replace(/\s{2,}/g, " ").trim();
    return json(entry);
  }

  if (url.pathname === "/think/latest" && req.method === "GET") {
    const r = await env.DB.prepare("SELECT id FROM actions WHERE status IN ('queued','running') ORDER BY id DESC LIMIT 1").all();
    return json(r.results?.[0] ? { action_id: r.results[0].id, status: "running" } : { action_id: null });
  }

  if (url.pathname === "/brain/knowledge" && req.method === "DELETE") {
    const cat = url.searchParams.get("category");
    if (!cat) return json({ error: "category param required" }, 400);
    try {
      await env.DB.prepare("DELETE FROM brain_knowledge WHERE category=?1").bind(cat).run();
      await env.DB.prepare("DELETE FROM brain_vectors WHERE category=?1").bind(cat).run();
      await env.DB.exec("DELETE FROM knowledge_fts; INSERT INTO knowledge_fts SELECT key, content, category FROM brain_knowledge");
      return json({ ok: true, deleted_category: cat });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/backfill" && req.method === "POST") {
    try {
      const keepCats = ["identity","architecture","tools","auto_learned","lesson","behavior"];
      const body = await req.json().catch(() => ({}));
      const catsToDelete = body.delete_categories || [];
      let deleted = 0;
      for (const cat of catsToDelete) {
        const r = await env.DB.prepare("DELETE FROM brain_knowledge WHERE category=?1").bind(cat).run();
        deleted += r.meta?.changes || 0;
      }
      await env.DB.exec("DELETE FROM knowledge_fts; INSERT INTO knowledge_fts SELECT key, content, category FROM brain_knowledge");
      await env.DB.prepare("DELETE FROM brain_vectors").run();
      const { indexAllKnowledge } = await import('./db');
      await indexAllKnowledge(env, env.DB);
      return json({ ok: true, deleted_entries: deleted, reindexed: true, kept_categories: keepCats });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/github-webhook" && req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const repo = body.repository?.full_name;
      const ref = body.ref || "";
      if (!repo || !ref.includes("refs/heads/")) return json({ ok: true, ignored: "not a push event" });
      const branch = ref.replace("refs/heads/", "");
      if (branch !== "main") return json({ ok: true, ignored: "not main branch" });
      const token = env.GH_PAT;
      if (!token) return json({ error: "no GH_PAT" }, 500);
      const commits = body.commits || [];
      const files = new Set();
      for (const c of commits) { for (const f of c.added || []) files.add(f); for (const f of c.modified || []) files.add(f); for (const f of c.removed || []) files.add(f); }
      const results = [];
      for (const file of files) {
        if (body.commits?.some(c => (c.removed || []).includes(file))) {
          await env.DB.prepare("DELETE FROM brain_knowledge WHERE key=?1").bind("source_" + file).run();
          await env.DB.prepare("DELETE FROM knowledge_fts WHERE key=?1").bind("source_" + file).run();
          results.push({ file, action: "deleted" });
        } else {
          const resp = await fetch("https://api.github.com/repos/" + repo + "/contents/" + file + "?ref=" + branch, {
            headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "Saraha-Brain" },
            signal: AbortSignal.timeout(10000)
          });
          if (!resp.ok) { results.push({ file, action: "fetch_failed" }); continue; }
          const data = await resp.json();
          const content = atob(data.content).slice(0, 4000);
          await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'source', 'github')").bind("source_" + file, content).run();
          results.push({ file, action: "stored" });
        }
      }
      return json({ ok: true, repo, branch, files_processed: results.length, results });
    } catch (e) { return json({ error: e.message }, 500); }
    }

  return json({ error: "not found" }, 404);
}

const SCRATCHPAD_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brain Scratchpad</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
h1{color:#58a6ff;margin-bottom:4px;font-size:20px}
.sub{color:#8b949e;font-size:13px;margin-bottom:20px}
.section{margin-bottom:24px}
.section h2{color:#f0f6fc;font-size:15px;padding:8px 12px;background:#161b22;border-radius:6px 6px 0 0;border:1px solid #30363d;border-bottom:0}
.section .desc{color:#8b949e;font-size:12px;padding:4px 12px 8px;background:#161b22;border-left:1px solid #30363d;border-right:1px solid #30363d}
.rows{background:#0d1117;border:1px solid #30363d;border-top:0;border-radius:0 0 6px 6px;max-height:70vh;overflow-y:auto}
.row{padding:6px 12px;border-bottom:1px solid #21262d;font-size:12px;line-height:1.4;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;word-break:break-all}
.row:last-child{border-bottom:0}
.row:hover{background:#161b22}
.time{color:#58a6ff;margin-right:8px;white-space:nowrap}
.tag{display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:600;margin-right:6px}
.tag.user{color:#d2a8ff;background:#2a1a4a}
.tag.assistant{color:#7ee787;background:#1b3a1b}
.tag.journal{color:#f0883e;background:#3d2200}
.tag.lesson{color:#79c0ff;background:#0a2e4a}
.tag.auto_learned{color:#ffa657;background:#3d2500}
.tag.rule{color:#ff7b72;background:#3d1111}
.tag.backup{color:#8b949e;background:#1c1f26}
.tag.source{color:#7ee787;background:#1b3a1b}
.tag.error{color:#f85149;background:#3d1212}
.tag.tick{color:#58a6ff;background:#0a2e4a}
.tag.done{color:#7ee787;background:#1b3a1b}
.tag.emotion{color:#ffa657;background:#3d2500}
.continue{color:#8b949e;font-style:italic;padding:6px 12px;font-size:11px;text-align:center}
#loading{color:#8b949e;text-align:center;padding:40px;font-size:14px}
.refresh{float:right;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
.refresh:hover{background:#30363d}
.btn{background:#238636;color:#fff;border:none;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;float:right;margin-left:6px}
.btn:hover{background:#2ea043}
.count{color:#8b949e;font-size:12px;margin-left:8px}
</style>
</head>
<body>
<h1>Brain Scratchpad</h1>
<p class="sub">All collected D1 data grouped by table — <span id="totalRows">0</span> total rows <button class="btn" onclick="location.href='?export=json'">Download JSON</button> <button class="btn" onclick="location.reload()">Refresh</button></p>
<div id="app"><div id="loading">Loading scratchpad data...</div></div>
<script>
(async()=>{
  const r=await fetch('/brain/scratchpad');
  if(!r.ok){document.getElementById('app').innerHTML='<div style="color:#f85149;padding:20px">Error: '+r.status+'</div>';return}
  const d=await r.json();
  if(!d.formatted){document.getElementById('app').innerHTML='<div style="color:#f85149;padding:20px">No formatted data returned</div>';return}
  document.getElementById('totalRows').textContent=d.total_rows;
  const labels={
    brain_memory:'Conversation messages (user/assistant)',
    actions:'Action history — queries, sensorium noise, results',
    activity_log:'System activity — tool calls, errors, ticks',
    brain_knowledge:'Knowledge base — rules, lessons, journals, stats, auto-learned',
    identity:'Key-value settings & tracking counters',
    brain_vectors:'Semantic vector fingerprints',
    brain_agents:'Agent step execution records'
  };
  const html=Object.entries(d.formatted).map(([table,data])=>{
    const label=labels[table]||table;
    const rows=data.rows.map((r,i)=>{
      let text=r.text.slice(0,300);
      let extra='';
      if(table==='brain_memory'){
        const isUser=r.text.startsWith('[user]');
        extra='<span class="tag '+(isUser?'user':'assistant')+'">'+(isUser?'user':'asst')+'</span>';
        text=r.text.replace(/^\[(user|assistant)\]\s*/,'');
      }else if(table==='brain_knowledge'){
        const m=r.text.match(/^\[(\w+)\]/);
        if(m)extra='<span class="tag '+m[1]+'">'+m[1]+'</span>';
      }else if(table==='identity'){
        if(r.text.startsWith('emotion_'))extra='<span class="tag emotion">emotion</span>';
      }else if(table==='actions'){
        const isSensorium=r.text.includes('[SENSORIUM]');
        if(isSensorium)extra='<span class="tag tick">sensorium</span>';
        else extra='<span class="tag done">query</span>';
      }else if(table==='activity_log'){
        const isError=r.text.includes('failed')||r.text.includes('error')||r.text.includes('ERROR');
        if(isError)extra='<span class="tag error">error</span>';
        else extra='<span class="tag tick">event</span>';
      }
      return '<div class="row"><span class="time">'+(r.time||'')+'</span>'+extra+' '+text+'</div>';
    }).join('');
    const more=data.rows.length>30?'<div class="continue">\u2014 showing first 30 of '+data.rows.length+' rows \u2014</div>':'';
    return '<div class="section"><h2>'+table+' <span class="count">('+data.rows.length+')</span></h2><div class="desc">'+label+'</div><div class="rows">'+rows.slice(0,30*999)+more+'</div></div>';
  }).join('');
  document.getElementById('app').innerHTML=html;
})();
</script>
</body>
</html>`;
