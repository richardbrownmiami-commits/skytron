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
import { buildScratchpadJournal, buildMemoryPack } from './scratchpad_journal';
import { processOneStep, processOneAgentStep } from './agents';
import { dispatchTool, toolDefinitions } from './tools';
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

  if (url.pathname === "/brain/scratchpad/memory" && req.method === "POST") {
    try {
      const result = await buildMemoryPack(env);
      return json(result);
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/journal" && req.method === "GET") {
    try {
      const jsonOnly = url.searchParams.get("format") === "json";
      const accept = req.headers.get("accept") || "";
      if (jsonOnly || !accept.includes("text/html")) {
        const r = await env.DB.prepare("SELECT key, content, created_at FROM brain_knowledge WHERE category='journal' ORDER BY created_at DESC LIMIT 200").all();
        return json({ entries: r.results || [] });
      }
      const r = await env.DB.prepare("SELECT key, content, created_at FROM brain_knowledge WHERE category='journal' ORDER BY created_at DESC LIMIT 200").all();
      const entries = r.results || [];
      const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const html = entries.map(e => {
      const colors = { productive:"#3fb950", built:"#58a6ff", mixed:"#d29922", rough:"#f85149", light:"#8b949e", planned:"#a371f7", completed:"#3fb950", discussed:"#58a6ff", failed:"#f85149", partial:"#d29922", pending:"#8b949e", entry:"#8b949e" };
      let c, narrative, topics, status, date, tags;
      try { c = JSON.parse(e.content); narrative = c.narrative || c.what_happened || c.recall_response || c.summary || ""; topics = c.topics?.length ? c.topics.join(", ") : c.topic || "Entry"; status = c.status || "entry"; date = c.date || (c.date_start || "").slice(0, 10); tags = c.tags || []; } catch { narrative = e.content; topics = e.key; status = "entry"; date = e.created_at?.slice(0, 10) || ""; tags = []; }
      const col = colors[status] || "#8b949e";
      const lines = narrative.split("\n").filter(Boolean).map(l => `<div class="nl">${esc(l)}</div>`).join("");
      const paras = narrative.split("\n\n").filter(Boolean).map(p => `<div class="para">${esc(p)}</div>`).join("");
      const tagsHtml = tags.length ? `<div class="tgs">${tags.map(t => `<span class="tg">${esc(t)}</span>`).join("")}</div>` : "";
      return `<div class="e" style="border-left:4px solid ${col}"><div class="eh"><span class="ed">${esc(date)}</span><span class="et">${esc(topics)}</span><span class="s" style="background:${col}18;color:${col}">${esc(status)}</span></div><div class="eb">${paras || lines}${tagsHtml}</div></div>`;
      }).join("\n");
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron Journal</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:0.3rem}.sub{color:#8b949e;font-size:0.85rem;margin-bottom:1.5rem}.e{background:#161b22;border:1px solid #30363d;border-radius:10px;margin-bottom:0.9rem;overflow:hidden}.eh{display:flex;align-items:center;gap:0.75rem;padding:0.65rem 1rem;background:#1c2333;border-bottom:1px solid #30363d}.ed{color:#8b949e;font-size:0.8rem;white-space:nowrap}.et{flex:1;font-weight:600;font-size:0.95rem}.s{font-size:0.75rem;padding:0.15rem 0.6rem;border-radius:999px;font-weight:500;text-transform:capitalize}.eb{padding:0.75rem 1rem}.para{padding:0.5rem 0;font-size:0.9rem;line-height:1.6;color:#c9d1d9}.nl{padding:0.35rem 0;font-size:0.88rem;line-height:1.5;color:#c9d1d9;border-bottom:1px solid #21262d}.nl:last-child{border:none}.tgs{display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid #21262d}.tg{background:#1c2540;color:#58a6ff;font-size:0.7rem;padding:0.12rem 0.5rem;border-radius:999px;border:1px solid #2a3a60}.empty{text-align:center;padding:2rem;color:#6b7280}</style></head><body><h1>Skytron Journal</h1><p class="sub">${entries.length} entries</p>${entries.length ? html : '<div class="empty">No entries found</div>'}</body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
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
      const allowed = ["enabled","log_tick","idle_cycle","health_check","slot_self_improve","slot_test","slot_research","slot_housekeep","idle_project","tool_dispatch","process_actions","stuck_recovery","process_agents","daily_cleanup","wake_up","task_web_search","task_memory_search","task_learn","task_db_query","task_review_code","astral_active","astral_interval"];
      for (const k of allowed) {
        if (body[k] !== undefined) {
          const val = k === "astral_interval" ? String(body[k]) : (body[k] ? "true" : "false");
          await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('cron_cfg_' || ?1, ?2, datetime('now'))").bind(k, val).run();
        }
      }
      return json({ ok: true });
    }
    const rows = (await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'cron_cfg_%'").all()).results || [];
    const s = {}, rawS = {};
    for (const r of rows) { rawS[r.key.replace("cron_cfg_","")] = r.value; s[r.key.replace("cron_cfg_","")] = r.value === "true"; }
    const d = { enabled: true, log_tick: false, idle_cycle: true, health_check: true, slot_self_improve: true, slot_test: true, slot_research: true, slot_housekeep: true, idle_project: true, tool_dispatch: true, process_actions: true, stuck_recovery: true, process_agents: true, daily_cleanup: true, wake_up: true, task_web_search: true, task_memory_search: true, task_learn: true, task_db_query: true, task_review_code: true, astral_active: false, astral_interval: "120" };
    const set = (k) => s[k] !== undefined ? s[k] : d[k];
    const raw = (k) => rawS[k] !== undefined ? rawS[k] : String(d[k]);
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cron Tick Settings</title><style>*{margin:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:2rem;max-width:700px;margin:auto}h1{color:#58a6ff;margin-bottom:0.5rem}.sub{color:#8b949e;font-size:0.85rem;margin-bottom:1.5rem}.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1rem;margin-bottom:1rem}.section h2{font-size:1rem;color:#58a6ff;margin-bottom:0.5rem}.row{display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid #21262d}.row:last-child{border:none}.label{flex:1}.label .desc{font-size:0.75rem;color:#8b949e;margin-top:2px}.switch{position:relative;width:44px;height:24px;flex-shrink:0;margin-left:1rem}input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#30363d;transition:.3s;border-radius:24px}.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background-color:#e6edf3;transition:.3s;border-radius:50%}input:checked+.slider{background-color:#3fb950}input:checked+.slider:before{transform:translateX(20px)}.btn{padding:0.5rem 1.5rem;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;background:#3fb950;color:#0b1120;font-weight:600;display:none;margin-top:0.5rem}.btn.show{display:inline-block}.saved{color:#3fb950;font-size:0.85rem;margin-top:0.5rem;display:none}</style></head><body><h1>Cron Tick Settings</h1><p class="sub">Toggle what Skytron does each idle tick. All settings are read on every tick.</p>
<div class="section"><h2>Master</h2>
<div class="row"><div class="label">Enabled<div class="desc">Master switch — disables ALL cron activity when off</div></div><label class="switch"><input type="checkbox" id="enabled" `+(set("enabled")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>

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
<div class="section"><h2>Astral Walk</h2>
<div class="row"><div class="label">Astral Active<div class="desc">Enable autonomous astral walk ticks (Skytron controls his own schedule)</div></div><label class="switch"><input type="checkbox" id="astral_active" `+(set("astral_active")?"checked":"")+` onchange="save()"><span class="slider"></span></label></div>
<div class="row"><div class="label">Astral Interval<div class="desc">Seconds between astral ticks (Skytron sets this via cron_control)</div></div><span style="color:#8b949e;font-size:0.85rem">${raw("astral_interval")}s</span></div>
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
      agent_loop: "Multi-step function-calling with Zod schema validation (max 25 steps). Sub-agents: spawn_agent + get_agent_result for parallel specialized tasks (max 8 steps, limited tools).",
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
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain Chat</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto;min-height:100vh;display:flex;flex-direction:column}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.topnav{display:flex;gap:0.4rem;margin-bottom:1rem;overflow-x:auto;padding-bottom:4px;flex-wrap:nowrap;-webkit-overflow-scrolling:touch}.topnav a{color:#58a6ff;text-decoration:none;padding:0.3rem 0.6rem;border:1px solid #30363d;border-radius:6px;font-size:0.75rem;white-space:nowrap;flex-shrink:0}.topnav a:hover{background:#1f2937}.topnav .active{background:#1e3a5f;border-color:#58a6ff}.control{margin-bottom:1rem}select{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:0.5rem;width:100%;font-size:1rem}.msgs{flex:1;overflow-y:auto}.msg{padding:1rem 1.2rem;margin-bottom:0.6rem;border-radius:10px;font-size:1rem;line-height:1.6}.msg.user{background:#1e3a5f;margin-left:1rem}.msg.assistant{background:#161b22;border:1px solid #30363d;margin-right:1rem}.meta{display:flex;justify-content:space-between;margin-bottom:0.4rem}.label{font-weight:600;font-size:0.85rem}.user .label{color:#60a5fa}.assistant .label{color:#94a3b8}.tool-error{background:#1a0a0a!important;border-left:3px solid #ef4444!important}
.tick-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:0.8rem 1rem;margin-bottom:0.6rem}
.tick-time{color:#6b7280;font-size:0.7rem;margin-bottom:0.3rem}
.tick-decision{color:#60a5fa;font-size:0.85rem;line-height:1.5;margin-bottom:0.3rem}
.tick-outcome{font-size:0.8rem;line-height:1.4;padding:0.3rem 0.5rem;border-radius:4px}
.tick-outcome.ok{color:#4ade80;background:#0a1a0a}
.tick-outcome.fail{color:#ef4444;background:#1a0a0a}
.tick-outcome.pending{color:#8b949e}.time{color:#6b7280;font-size:0.8rem}.text{word-break:break-word;white-space:pre-wrap}.nav{display:flex;justify-content:space-between;align-items:center;padding:0.8rem 0;color:#8b949e;font-size:0.9rem}.nav a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px}.nav a:hover{background:#1f2937}.empty{text-align:center;padding:2rem;color:#6b7280}.input-row{display:flex;gap:0.5rem;padding:1rem 0;border-top:1px solid #30363d;margin-top:auto}input{flex:1;padding:0.8rem 1rem;border-radius:8px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:1rem;outline:none}input:focus{border-color:#58a6ff}button{padding:0.8rem 1.2rem;border-radius:8px;border:none;background:#58a6ff;color:#0b1120;font-weight:bold;font-size:1rem;cursor:pointer}button:disabled{opacity:0.5}</style></head><body><div class="topnav"><a href="/">Home</a><a href="/astral">Astral</a><a href="/skytronchat" class="active">Chat</a><a href="/status">Status</a><a href="/brain/history">History</a><a href="/brain/memory">Memory</a><a href="/brain/memory/search">Search</a><a href="/brain/knowledge">Knowledge</a><a href="/brain/introspect">Insights</a><a href="/brain/settings">AI Provider</a><a href="/cron/settings">Cron</a><a href="/brain/prompt">Prompt</a><a href="/brain/repair">Repair</a><a href="/brain/logs">Logs</a><a href="/brain/agents">Agents</a><a href="/brain/vectorize">Vector</a><a href="/brain/source">Source</a><a href="/brain/scratchpad">Scratchpad</a><a href="/brain/journal">Journal</a></div><h1>Chat with Skytron</h1><div class="control"><select id="convSelect" onchange="if(this.value)window.location='?c='+encodeURIComponent(this.value)"><option value="">-- Select conversation --</option>${sel}</select></div><div class="msgs">${msgs.length?msgs:`<div class="empty">No messages yet. Start a conversation via /skytronchat or POST /think</div>`}</div>${nav}<div class="input-row"><input type="text" id="msgInput" placeholder="Type your message..." /><button id="sendBtn" onclick="send()">Send</button></div>
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
    for (const r of slots.results || []) slotMap[r.key.replace("prompt_slot_", "")] = r.value;
    const accept = req.headers.get("accept") || "";
    if (accept.includes("text/html")) {
      const esc = s => (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const active = (ov.results[0]?.value || SYSTEM_PROMPT);
      const slotRows = Object.entries(slotMap).map(([k,v]) => `<div class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem"><h2>${esc(k)}</h2><button class="svbtn" data-slot="${esc(k)}">Save</button></div><textarea class="svinp" data-slot="${esc(k)}" rows="6">${esc(v)}</textarea></div>`).join("");
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron Prompt</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:0.3rem}.sub{color:#8b949e;font-size:0.85rem;margin-bottom:1.5rem}.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1rem;margin-bottom:0.9rem}.card h2{color:#58a6ff;font-size:1rem;font-weight:600}textarea{width:100%;background:#0b1120;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:0.75rem;font-size:0.85rem;font-family:monospace;line-height:1.5;resize:vertical}textarea:focus{border-color:#58a6ff;outline:none}button{padding:0.5rem 1.2rem;border-radius:6px;border:none;background:#58a6ff;color:#0b1120;font-weight:600;font-size:0.85rem;cursor:pointer}button:hover{background:#4a8fd4}.toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#3fb950;color:#0b1120;padding:0.6rem 1.2rem;border-radius:8px;font-size:0.85rem;font-weight:600;opacity:0;transition:opacity 0.3s;pointer-events:none}.toast.show{opacity:1}</style></head><body><h1>Skytron Prompt</h1><p class="sub">Edit prompt overrides and slots below</p><div class="card"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem"><h2>Active Prompt</h2><button id="saveMain">Save</button></div><textarea id="mainPrompt" rows="12">${esc(active)}</textarea></div>${slotRows || '<div class="card"><h2>Slots</h2><p style="color:#6b7280;font-size:0.9rem">No custom slots defined. Slots are created on first save.</p></div>'}<div id="toast" class="toast">Saved</div><script>(function(){function $(id){return document.getElementById(id)}function toast(m){var t=$("toast");t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},2000)}function save(key,val){fetch("/brain/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:val,slot:key==="main"?undefined:key})}).then(function(r){return r.json()}).then(function(d){if(d.ok)toast("Saved "+(key==="main"?"global prompt":key));else toast("Error: "+(d.error||"unknown"))}).catch(function(e){toast("Error: "+e.message)})}$("saveMain").addEventListener("click",function(){save("main",$("mainPrompt").value)});document.querySelectorAll(".svbtn").forEach(function(b){b.addEventListener("click",function(){var slot=this.getAttribute("data-slot");var inp=document.querySelector(".svinp[data-slot='"+slot+"']");save(slot,inp.value)})})})();</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache" } });
    }
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

  if (url.pathname === "/brain/health-check" && req.method === "GET") {
    const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const actCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM actions").all()).results[0]?.c || 0;
    const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    const agentCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_agents").all()).results[0]?.c || 0;
    const logCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_logs").all()).results[0]?.c || 0;
    const stuck = (await env.DB.prepare("SELECT id, task, status, created_at, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) as duration_seconds FROM actions WHERE status='running' AND created_at < datetime('now', '-1 minutes') ORDER BY created_at").all()).results || [];
    const staleQueued = (await env.DB.prepare("SELECT id, task, created_at, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) as duration_seconds FROM actions WHERE status='queued' AND created_at < datetime('now', '-30 minutes') ORDER BY created_at").all()).results || [];
    const recentErrors = (await env.DB.prepare("SELECT id, task, result, created_at FROM actions WHERE status='error' AND created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 10").all()).results || [];
    const oldestAction = (await env.DB.prepare("SELECT MIN(created_at) as oldest FROM actions").all()).results[0]?.oldest || "";
    const issues = [];
    const now = new Date().toISOString();
    if (memCount > 200) {
      issues.push({ code: "MEM-001", severity: "warning", title: "Memory table at " + memCount + " entries", description: "Memory has grown past its 200-entry soft limit.", when: "accumulating as conversations grow", duration: "ongoing", effect: "Sensorium loads more tokens per call, slowing responses. Old conversations dilute focus.", source_file: "src/scheduler.ts:343" });
    }
    if (actCount > 500) {
      issues.push({ code: "ACT-001", severity: "warning", title: "Actions table at " + actCount + " entries", description: "Action history exceeds the 500-entry target.", when: "since system start", duration: "ongoing", effect: "Action queries slow down. Stuck detection takes longer, risking cascading failures in the scheduler.", source_file: "src/scheduler.ts:345" });
    }
    const logsOverLimit = Math.max(0, logCount - 500);
    if (logsOverLimit > 0) {
      issues.push({ code: "LOGS-001", severity: "warning", title: logsOverLimit + " old log entries beyond last 500", description: "Log table exceeds the 500-entry cleanup threshold.", when: "accumulated over time", duration: "since last cleanup", effect: "Wastes D1 storage. Log queries take longer, slowing debug and introspection.", source_file: "src/routes.ts:419" });
    }
    if (agentCount > 50) {
      issues.push({ code: "AGT-001", severity: "warning", title: "Agents table at " + agentCount + " entries", description: "Sub-agent records exceed the 50-entry limit.", when: "accumulated as agents spawn and complete", duration: "ongoing", effect: "Agent queries slow. Orphaned agent records take up space without being useful.", source_file: "src/scheduler.ts:346" });
    }
    for (const a of stuck) {
      const m = Math.floor(a.duration_seconds / 60), s = a.duration_seconds % 60;
      issues.push({ code: "STUCK-" + String(a.id).slice(-4), severity: "error", title: "Action " + a.id + " stuck running for " + m + "m " + s + "s", description: "Action " + a.id + " (" + (a.task || "unknown") + ") has been running since " + a.created_at + " without completing.", when: a.created_at, duration: m + "m " + s + "s", effect: "That action will never finish on its own. It blocks the scheduler from picking the next queued action.", source_file: "src/scheduler.ts:74" });
    }
    for (const a of staleQueued) {
      const m = Math.floor(a.duration_seconds / 60);
      issues.push({ code: "STALE-" + String(a.id).slice(-4), severity: "warning", title: "Action " + a.id + " stale in queue for " + m + "m", description: "Action " + a.id + " (" + (a.task || "unknown") + ") has been queued since " + a.created_at + " without being picked up.", when: a.created_at, duration: m + "m", effect: "Queued actions that sit too long may never execute. The scheduler skips them when picking the next action.", source_file: "src/scheduler.ts" });
    }
    if (recentErrors.length > 0) {
      issues.push({ code: "ERR-001", severity: "error", title: recentErrors.length + " action errors in last 24 hours", description: recentErrors.length + " actions errored out in the past day.", when: "last 24 hours", duration: "varies", effect: "Repeated errors suggest a provider outage or bug. The scheduler will keep retrying the same failing pattern unless loop detection catches it.", source_file: "src/scheduler.ts" });
    }
    let llmSettings = {};
    try { const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key='settings_llm'").first(); if (row?.content) llmSettings = JSON.parse(row.content); } catch {}
    const llmProviders = [];
    let primaryName = "none", fallbackName = "none", anyWorking = false;
    // Matches callLLM priority order: Workers AI → OpenRouter → BUDDHI_DWAR → Universal
    if (env.AI && llmSettings.workers_ai?.enabled !== false) {
      primaryName = "Workers AI";
      llmProviders.push({ name: "Workers AI", role: "primary", status: "error", error: "Daily free limit exhausted (10k neurons used). Resets at midnight UTC.", source_file: "src/llm.ts:60" });
    }
    if (env.OPENROUTER_API_KEY) {
      const orRole = primaryName === "none" ? "primary" : "fallback";
      if (orRole === "primary") primaryName = "OpenRouter";
      else fallbackName = "OpenRouter";
      llmProviders.push({ name: "OpenRouter", role: orRole, status: "limited", error: "Free models rate-limited (429). Add credits or use a paid tier.", source_file: "src/llm.ts:93" });
    }
    if (llmSettings.buddhidwar?.enabled && llmSettings.buddhidwar?.api_key) {
      const bdRole = primaryName === "none" ? "primary" : (fallbackName === "none" ? "fallback" : "tertiary");
      if (bdRole === "primary") primaryName = "BUDDHI_DWAR";
      else if (bdRole === "fallback") fallbackName = "BUDDHI_DWAR";
      llmProviders.push({ name: "BUDDHI_DWAR", role: bdRole, status: "unknown", error: "", source_file: "src/llm.ts:103" });
    }
    if (llmSettings.universal?.enabled && llmSettings.universal?.api_key && llmSettings.universal?.endpoint) {
      const uRole = primaryName === "none" ? "primary" : (fallbackName === "none" ? "fallback" : "tertiary");
      if (uRole === "primary") primaryName = "Universal AI";
      else if (uRole === "fallback") fallbackName = "Universal AI";
      llmProviders.push({ name: "Universal AI", role: uRole, status: "unknown", error: "", source_file: "src/llm.ts:136" });
    }
    if (!llmSettings.buddhidwar?.enabled || !llmSettings.buddhidwar?.api_key) {
      const bdRole = primaryName === "none" ? "primary" : (fallbackName === "none" ? "fallback" : "tertiary");
      if (bdRole === "primary") primaryName = "BUDDHI_DWAR";
      else if (bdRole === "fallback") fallbackName = "BUDDHI_DWAR";
      llmProviders.push({ name: "BUDDHI_DWAR", role: bdRole, status: "off", error: "Not configured — set an API key in /brain/settings", source_file: "src/llm.ts:103" });
    }
    // Override hardcoded statuses with real-time data from identity table
    try {
      const statusRows = await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'llm_status_%'").all();
      if (statusRows.results?.length) {
        const nameMap = { workers_ai: "Workers AI", openrouter: "OpenRouter", buddhidwar: "BUDDHI_DWAR", universal: "Universal AI" };
        for (const r of statusRows.results) {
          const short = r.key.replace("llm_status_", "");
          const name = nameMap[short];
          if (!name) continue;
          const p = llmProviders.find(x => x.name === name);
          if (!p) continue;
          if (r.value === "ok") { p.status = "ok"; p.error = ""; }
          else if (r.value?.startsWith("error:")) { p.status = "error"; p.error = r.value.slice(6); }
        }
      }
    } catch {}
    anyWorking = llmProviders.some(p => p.status === "ok");
    const dbOk = (await env.DB.prepare("SELECT 1").run()).success !== false;
    const endpoints = [
      { path: "/think", status: "ok", source: "src/routes.ts" },
      { path: "/status", status: "ok", source: "src/routes.ts" },
      { path: "/brain/memory", status: "ok", source: "src/db.ts" },
      { path: "/brain/knowledge", status: "ok", source: "src/db.ts" },
      { path: "/brain/logs", status: "ok", source: "src/db.ts" },
      { path: "/brain/repair", status: "ok", source: "src/routes.ts" },
      { path: "/brain/agents", status: "ok", source: "src/routes.ts" },
      { path: "/brain/prompt", status: "ok", source: "src/routes.ts" },
      { path: "/brain/vectorize", status: "ok", source: "src/routes.ts" },
      { path: "/brain/introspect", status: "ok", source: "src/routes.ts" },
      { path: "/brain/source", status: "ok", source: "src/routes.ts" },
      { path: "/brain/history", status: "ok", source: "src/routes.ts" },
      { path: "/brain/backfill", status: "ok", source: "src/routes.ts" },
      { path: "/brain/scratchpad", status: "ok", source: "src/routes.ts" },
      { path: "/brain/journal", status: "ok", source: "src/routes.ts" },
      { path: "/cron/settings", status: "ok", source: "src/routes.ts" },
      { path: "/think/result", status: "ok", source: "src/routes.ts" },
      { path: "/skytronchat", status: "ok", source: "chat.html" },
      { path: "D1 Database", status: dbOk ? "ok" : "error", source: "src/db.ts" },
      { path: "Vectorize Index", status: "ok", source: "src/db.ts" }
    ];
    const sevCounts = { error: 0, warning: 0, ok: 0 };
    for (const i of issues) { if (i.severity) sevCounts[i.severity] = (sevCounts[i.severity] || 0) + 1; }
    const heartbeat = sevCounts.error > 0 ? "red" : (sevCounts.warning > 0 ? "orange" : "green");
    const autoResolved = [];
    const skytronFixes = [];
    try {
      const recentFixes = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key LIKE 'fix_%' AND created_at > datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 10").all();
      if (recentFixes.results) {
        for (const f of recentFixes.results) {
          try { const p = JSON.parse(f.content); (p.source === "auto" ? autoResolved : skytronFixes).push(p); } catch {}
        }
      }
    } catch {}
    const autoFixHistory = [];
    try {
      const afRows = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE category='autofix' ORDER BY created_at DESC LIMIT 20").all();
      if (afRows.results) {
        for (const f of afRows.results) {
          try { const p = JSON.parse(f.content); autoFixHistory.push(p); } catch {}
        }
      }
    } catch {}
    const providerFailures = [];
    try {
      const rows = await env.DB.prepare("SELECT content, created_at FROM brain_logs WHERE step='llm_fail' AND content IS NOT NULL ORDER BY id DESC LIMIT 5").all();
      if (rows.results) {
        for (const r of rows.results) {
          providerFailures.push({ error: (r.content || "").slice(0, 500), when: r.created_at });
        }
      }
    } catch {}
    return json({ issues, llm: { providers: llmProviders, primary: primaryName, fallback: fallbackName, working: anyWorking }, endpoints, stats: { memory: memCount, actions: actCount, knowledge: knCount, agents: agentCount, logs: logCount, oldest_action: oldestAction }, heartbeat, auto_resolved: autoResolved, skytron_fixes: skytronFixes, autofix_history: autoFixHistory, provider_failures: providerFailures });
  }

  if (url.pathname === "/brain/repair" && (req.method === "GET" || req.method === "POST")) {
    const fixes = [];
    const now = new Date().toISOString();
    const stuck = await env.DB.prepare("UPDATE actions SET status='error', result='Timeout', completed_at=datetime('now') WHERE status='running' AND created_at < datetime('now', '-10 minutes')").run();
    if (stuck.meta?.changes > 0) fixes.push({ code: "FIX-STUCK", description: "Marked " + stuck.meta.changes + " stuck action(s) as timed out", source_file: "src/scheduler.ts:74", when: now });
    const staleQ = await env.DB.prepare("UPDATE actions SET status='error', result='Stale', completed_at=datetime('now') WHERE status='queued' AND created_at < datetime('now', '-60 minutes')").run();
    if (staleQ.meta?.changes > 0) fixes.push({ code: "FIX-STALE", description: "Cleared " + staleQ.meta.changes + " stale queued action(s)", source_file: "src/scheduler.ts", when: now });
    const oldLogs = await env.DB.prepare("DELETE FROM brain_logs WHERE id NOT IN (SELECT id FROM brain_logs ORDER BY id DESC LIMIT 500)").run();
    if (oldLogs.meta?.changes > 0) fixes.push({ code: "FIX-LOGS", description: "Removed " + oldLogs.meta.changes + " old log entries beyond last 500", source_file: "src/routes.ts:419", when: now });
    const errActions = await env.DB.prepare("UPDATE actions SET completed_at=datetime('now') WHERE status='error' AND completed_at IS NULL").run();
    if (errActions.meta?.changes > 0) fixes.push({ code: "FIX-STAMP", description: "Stamped " + errActions.meta.changes + " errored actions with completion time", source_file: "src/routes.ts:421", when: now });
    const memTrim = await env.DB.prepare("DELETE FROM brain_memory WHERE id NOT IN (SELECT id FROM brain_memory ORDER BY id DESC LIMIT 200) AND created_at < datetime('now', '-7 days')").run();
    if (memTrim.meta?.changes > 0) fixes.push({ code: "FIX-MEM", description: "Trimmed " + memTrim.meta.changes + " old memory entries beyond last 200", source_file: "src/scheduler.ts:343", when: now });
    const actTrim = await env.DB.prepare("DELETE FROM actions WHERE status='done' AND id NOT IN (SELECT id FROM actions WHERE status='done' ORDER BY id DESC LIMIT 500)").run();
    if (actTrim.meta?.changes > 0) fixes.push({ code: "FIX-ACT", description: "Cleaned " + actTrim.meta.changes + " old completed actions beyond last 500", source_file: "src/scheduler.ts:345", when: now });
    return json({ fixes });
  }

  if (url.pathname === "/brain/autofix-llm" && req.method === "POST") {
    try {
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const attempts = [];
      let fixed = false;
      
      // Read current LLM settings
      let llmSettings = {};
      try { const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key='settings_llm'").first(); if (row?.content) llmSettings = JSON.parse(row.content); } catch {}

      // Attempt 1: Test BD gateway with actual chat completion (not just health endpoint)
      try {
        const bdResp = await fetch("https://buddhi-dwar.richard-brown-miami.workers.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + (llmSettings.buddhidwar?.api_key || env.BRAIN_KEY || "") },
          body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], model: "openrouter/free", max_tokens: 1 }),
          signal: AbortSignal.timeout(10000)
        });
        if (bdResp.ok) { fixed = true; attempts.push({ action: "BD chat completion test", result: "ok", detail: "BD responded to chat completion" }); }
        else { const err = await bdResp.text().catch(() => ""); attempts.push({ action: "BD chat completion test", result: "failed", detail: "HTTP " + bdResp.status + ": " + err.slice(0, 200) }); }
      } catch (e) { attempts.push({ action: "BD chat completion test", result: "failed", detail: e.message }); }

      // Attempt 2: Test OpenRouter directly
    if (llmSettings.openrouter?.enabled !== false && env.OPENROUTER_API_KEY) {
        try {
          const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "meta-llama/llama-3.2-3b-instruct:free", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(10000)
          });
          if (orResp.ok) { fixed = true; attempts.push({ action: "OpenRouter direct test", result: "ok", detail: "OpenRouter responded" }); }
          else { const err = await orResp.text(); attempts.push({ action: "OpenRouter direct test", result: "failed", detail: "HTTP " + orResp.status + ": " + err.slice(0, 200) }); }
        } catch (e) { attempts.push({ action: "OpenRouter direct test", result: "failed", detail: e.message }); }

        // Attempt 3: Try different OpenRouter model
        if (!fixed) {
          try {
            const altModels = ["nousresearch/hermes-3-llama-3.1-405b:free", "google/gemma-2-27b-it:free", "microsoft/phi-3.5-mini-4k-instruct:free"];
            for (const m of altModels) {
              const or2 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json" },
                body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
                signal: AbortSignal.timeout(8000)
              });
              if (or2.ok) {
                attempts.push({ action: "OpenRouter alternate model", result: "ok", detail: "Model " + m + " worked" });
                fixed = true;
                break;
              } else {
                attempts.push({ action: "OpenRouter alternate model", result: "failed", detail: "Model " + m + " returned HTTP " + or2.status });
              }
            }
          } catch (e) { attempts.push({ action: "OpenRouter alternate model", result: "failed", detail: e.message }); }
        }
      }

      // Attempt 4: Health-check all endpoints
      try {
        const hcResp = await fetch("https://saraha-brain.richard-brown-miami.workers.dev/brain/health", {
          headers: { Authorization: "Bearer " + env.BRAIN_KEY },
          signal: AbortSignal.timeout(5000)
        });
        if (hcResp.ok) { attempts.push({ action: "Self health-check", result: "ok", detail: "Self-test passed" }); }
        else { attempts.push({ action: "Self health-check", result: "failed", detail: "HTTP " + hcResp.status }); }
      } catch (e) { attempts.push({ action: "Self health-check", result: "failed", detail: e.message }); }

      // Record attempt in brain_knowledge
      const key = "autofix_llm_" + now.replace(/[ :]/g, "_");
      const record = JSON.stringify({ timestamp: now, fixed, attempts, summary: fixed ? "Fixed" : "Still failing" });
      try { await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'autofix', 'auto')").bind(key, record).run(); } catch {}

      return json({ ok: true, fixed, attempts, key });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/repair-dashboard" && req.method === "GET") {
    return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron Repair</title><style>*{margin:0;padding:0;box-sizing:border-box}@keyframes bgShift{0%{background-position:0 50%}50%{background-position:100% 50%}100%{background-position:0 50%}}@keyframes pulseGlow{0%,100%{opacity:.6;transform:scaleY(1)}50%{opacity:1;transform:scaleY(1.8)}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}@keyframes slideIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{0%,100%{box-shadow:0 0 20px var(--hc)}50%{box-shadow:0 0 40px var(--hc),0 0 80px var(--hc)}}body{min-height:100vh;background:linear-gradient(135deg,#0a0a1a 0%,#0d1117 40%,#111827 70%,#0a0a2e 100%);background-size:400% 400%;animation:bgShift 20s ease infinite;color:#e6edf3;font-family:system-ui;display:flex;flex-direction:column;padding:0;overflow-x:hidden}[v-cloak]{display:none}::selection{background:#6366f1;color:#fff}.h-wrap{padding:8px;flex:1;display:flex;flex-direction:column;overflow:hidden;perspective:1200px}.heartbeat{position:relative;height:4px;border-radius:0 0 8px 8px;margin-bottom:10px;transition:all .8s;overflow:hidden}.heartbeat::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.3),transparent);animation:shimmer 2s infinite;background-size:200% 100%}.heartbeat::before{content:'';position:absolute;top:-6px;left:50%;width:40px;height:14px;border-radius:50%;background:var(--hc);opacity:.4;filter:blur(8px);transform:translateX(-50%);animation:breathe 2s ease-in-out infinite}.tabs{display:flex;gap:4px;margin-bottom:12px;background:rgba(255,255,255,.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:14px;padding:4px;border:1px solid rgba(255,255,255,.06)}.tab{padding:10px 24px;cursor:pointer;font-size:13px;font-weight:500;border-radius:10px;user-select:none;transition:all .3s cubic-bezier(.4,0,.2,1);color:rgba(255,255,255,.4);position:relative}.tab:hover{color:rgba(255,255,255,.7);background:rgba(255,255,255,.04)}.tab-active{color:#fff !important;background:linear-gradient(135deg,rgba(99,102,241,.3),rgba(139,92,246,.15)) !important;box-shadow:0 2px 12px rgba(99,102,241,.2)}.panels{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent;padding:2px}.panels::-webkit-scrollbar{width:4px}.panels::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}.panel{animation:slideIn .35s ease-out}.card-3d{background:rgba(255,255,255,.04);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px;margin-bottom:10px;transition:all .3s cubic-bezier(.4,0,.2,1);transform-style:preserve-3d}.card-3d:hover{transform:translateY(-2px) rotateX(1deg);border-color:rgba(99,102,241,.3);box-shadow:0 8px 32px rgba(0,0,0,.3),0 0 20px rgba(99,102,241,.08)}.card-header{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,.3);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.06)}.llm-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px;animation:slideIn .4s ease-out both}.llm-row:last-child{border:none}.llm-row:nth-child(2){animation-delay:.05s}.llm-row:nth-child(3){animation-delay:.1s}.llm-row:nth-child(4){animation-delay:.15s}.llm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;transition:all .4s}.dot-ok{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.5)}.dot-warning{background:#eab308;box-shadow:0 0 8px rgba(234,179,8,.5)}.dot-error{background:#ef4444;box-shadow:0 0 8px rgba(239,68,68,.5)}.dot-limited{background:#f97316;box-shadow:0 0 8px rgba(249,115,22,.5)}.dot-off{background:rgba(255,255,255,.15)}.dot-unknown{background:#818cf8;box-shadow:0 0 8px rgba(129,140,248,.5)}.llm-row.llm-row-primary{border-left:2px solid #22c55e;padding-left:8px;background:rgba(34,197,94,.06);border-radius:4px 0 0 4px}.llm-name{color:#fff;font-weight:500}.llm-badge{font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}.llm-primary{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.2)}.llm-fallback{background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.2)}.llm-tertiary{background:rgba(234,179,8,.12);color:#eab308;border:1px solid rgba(234,179,8,.2)}.llm-model{color:rgba(255,255,255,.4);font-size:12px;font-family:monospace}.llm-err{color:#ef4444;font-size:12px;width:100%;padding:4px 0 0 18px;font-family:monospace;font-size:11px;opacity:.8}.llm-src{color:rgba(255,255,255,.2);font-size:10px;width:100%;padding-left:18px}.llm-footer{font-size:12px;color:rgba(255,255,255,.3);padding:8px 0 0;border-top:1px solid rgba(255,255,255,.06);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}.llm-footer strong{color:rgba(255,255,255,.7)}.ep-grid{display:grid;grid-template-columns:1fr;gap:0}.ep-header{display:grid;grid-template-columns:20px 1fr 70px 80px;gap:8px;padding:8px 12px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.2);border-bottom:1px solid rgba(255,255,255,.06)}.ep-row{display:grid;grid-template-columns:20px 1fr 70px 80px;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.03);font-size:12px;transition:all .2s;animation:slideIn .35s ease-out both}.ep-row:hover{background:rgba(255,255,255,.03)}.ep-row:last-child{border:none}.ep-dot{width:7px;height:7px;border-radius:50%}.ep-path{font-family:monospace;font-size:11px;color:rgba(255,255,255,.8)}.ep-tag{font-size:10px;padding:1px 8px;border-radius:20px;text-align:center;font-weight:500}.tag-ok{background:rgba(34,197,94,.12);color:#22c55e;border:1px solid rgba(34,197,94,.15)}.tag-error{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.15)}.tag-limited{background:rgba(249,115,22,.12);color:#f97316;border:1px solid rgba(249,115,22,.15)}.tag-off{background:rgba(255,255,255,.05);color:rgba(255,255,255,.25);border:1px solid rgba(255,255,255,.08)}.ep-src{color:rgba(255,255,255,.2);font-size:10px;text-align:right}.issues-grid{display:flex;flex-direction:column;gap:6px}.issue-3d{background:rgba(255,255,255,.03);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 12px;cursor:pointer;transition:all .3s cubic-bezier(.4,0,.2,1);transform-style:preserve-3d}.issue-3d:hover{transform:translateY(-3px) rotateX(2deg);border-color:rgba(99,102,241,.3);box-shadow:0 8px 30px rgba(0,0,0,.3)}.issue-3d.err{border-left:3px solid #ef4444}.issue-3d.warn{border-left:3px solid #eab308}.issue-hdr{display:flex;align-items:center;gap:8px}.iss-code{font-size:10px;font-weight:700;color:#818cf8;background:rgba(99,102,241,.15);padding:2px 8px;border-radius:6px;letter-spacing:.5px;font-family:monospace}.iss-sev{font-size:11px}.iss-title{font-size:13px;color:rgba(255,255,255,.85);flex:1}.iss-src{font-size:10px;color:rgba(255,255,255,.25);margin-top:4px;padding-left:4px}.det-panel{background:rgba(255,255,255,.05);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px;margin-bottom:10px;animation:slideIn .3s ease-out}.det-empty{color:rgba(255,255,255,.2);text-align:center;padding:24px;font-size:12px}.det-code{font-size:11px;font-weight:700;color:#818cf8;margin-bottom:2px;font-family:monospace}.det-title{font-size:15px;color:#fff;margin-bottom:10px;font-weight:500}.det-body{background:rgba(0,0,0,.3);border-radius:10px;padding:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.05)}.det-row{display:flex;padding:4px 0;gap:10px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04)}.det-row:last-child{border:none}.det-lbl{color:rgba(255,255,255,.3);width:90px;flex-shrink:0;font-size:11px}.det-val{color:rgba(255,255,255,.85);flex:1}.det-desc{font-size:12px;color:rgba(255,255,255,.5);line-height:1.5;padding:2px 0}.fix-row{display:flex;gap:8px;margin-bottom:10px}.fix-col{flex:1;background:rgba(255,255,255,.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px;max-height:180px;overflow-y:auto}.fix-col::-webkit-scrollbar{width:3px}.fix-col::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}.fix-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:rgba(255,255,255,.25);margin-bottom:6px}.fix-item{padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;display:flex;gap:6px;align-items:flex-start;animation:slideIn .3s ease-out both}.fix-item:last-child{border:none}.fix-ic{flex-shrink:0;font-size:12px;margin-top:1px;min-width:16px;text-align:center}.fix-auto .fix-ic{color:#22c55e}.fix-skytron .fix-ic{color:#eab308}.fix-txt{color:rgba(255,255,255,.8);flex:1}.fix-src{color:rgba(255,255,255,.2);font-size:9px;text-align:right;min-width:70px}.act-bar{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,.04);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.06);border-radius:14px;margin-bottom:10px;flex-wrap:wrap;transition:all .3s}.btn{padding:10px 22px;border-radius:10px;border:none;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .3s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}.btn::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.1),transparent);transform:translateX(-100%);transition:transform .6s}.btn:hover::after{transform:translateX(100%)}.btn:disabled{opacity:.4;cursor:not-allowed;transform:none !important}.btn-chk{background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.04));color:rgba(255,255,255,.85);box-shadow:0 2px 8px rgba(0,0,0,.2)}.btn-chk:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.3)}.btn-fix{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 2px 12px rgba(34,197,94,.3)}.btn-fix:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 24px rgba(34,197,94,.4)}.chk-status{display:flex;align-items:center;gap:8px;flex:1;min-width:120px}.chk-spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.08);border-top-color:#818cf8;border-radius:50%;animation:spin .7s linear infinite}.chk-msg{font-size:12px}.chk-idle{color:rgba(255,255,255,.3)}.chk-checking{color:#818cf8}.chk-complete{color:#22c55e}.chk-error{color:#ef4444}.chk-fixing{color:#eab308}.fix-res{background:rgba(255,255,255,.04);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:12px;animation:slideIn .4s ease-out}.fix-res-hdr{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:rgba(255,255,255,.25);margin-bottom:6px}.fix-res-item{padding:5px 0;font-size:12px;display:flex;gap:6px;align-items:center;border-bottom:1px solid rgba(255,255,255,.04)}.fix-res-item:last-child{border:none}.fix-res-item .fix-ic{color:#22c55e}.fix-when{color:rgba(255,255,255,.2);font-size:10px;margin-left:auto}.empty-st{color:rgba(255,255,255,.15);text-align:center;padding:24px;font-size:13px}.empty-st-sm{color:rgba(255,255,255,.15);text-align:center;padding:12px;font-size:12px}.h-title{text-align:center;font-size:14px;font-weight:600;background:linear-gradient(135deg,#818cf8,#22c55e);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:6px;letter-spacing:2px;text-transform:uppercase;opacity:.8}.ekg-canvas{width:100%;height:60px;border-radius:12px;margin-bottom:6px;display:block;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.05)}</style></head><body><div id="repairApp" v-cloak style="flex:1;display:flex;flex-direction:column;overflow:hidden"></div><template id="repair-template"><div class="h-wrap"><canvas ref="ekgRef" class="ekg-canvas" width="800" height="80"></canvas><div class="h-title">Skytron Repair</div><div class="tabs"><div :class="'tab'+(activeSubTab==='status'?' tab-active':'')" @click="activeSubTab='status'">Status</div><div :class="'tab'+(activeSubTab==='report'?' tab-active':'')" @click="activeSubTab='report'">Report</div></div><div class="panels"><div v-show="activeSubTab==='status'" class="panel"><div class="card-3d"><div class="card-header">Active LLM</div><div v-for="p in llmProviders" :class="'llm-row'+(p.role==='primary'?' llm-row-primary':'')"><span :class="'llm-dot dot-'+p.status"></span><span class="llm-name">{{p.name}}</span><span :class="'llm-badge llm-'+p.role">{{p.role}}</span><div v-if="p.error" class="llm-err">{{p.error}}</div></div><div class="llm-footer">Primary: <strong>{{llmPrimary}}</strong> &middot; Fallback: <strong>{{llmFallback}}</strong> &middot; <span :style="{color:llmWorking?'#22c55e':'#ef4444'}">{{llmWorking?'Operational':'Degraded'}}</span></div></div><div class="card-3d"><div class="card-header">Auto-Fix Report</div><div v-if="autofixRunning" style="color:#eab308;font-size:13px;padding:8px 0">Running auto-fix...</div><div v-else-if="autofixHistory.length===0" style="color:rgba(255,255,255,.3);font-size:12px;padding:8px 0">No auto-fix attempts yet</div><div v-for="(af,afi) in autofixHistory" :key="afi" class="llm-row"><span :class="'llm-dot dot-'+(af.fixed?'ok':'error')"></span><span class="llm-name">{{af.summary||'Unknown'}}</span><span style="font-size:11px;color:rgba(255,255,255,.4);margin-left:auto">{{timeAgo(af.timestamp)}}</span><div style="font-size:11px;color:rgba(255,255,255,.5);margin-top:2px;width:100%"><div v-for="(att,atti) in af.attempts||[]" :key="atti" style="display:flex;gap:4px;align-items:center;padding:1px 0"><span :style="{color:att.result==='ok'?'#22c55e':'#ef4444'}">{{att.result==='ok'?'✓':'✗'}}</span><span>{{att.action}}</span><span v-if="att.detail" style="color:rgba(255,255,255,.4);font-size:10px">– {{att.detail}}</span></div></div></div></div><div class="card-3d"><div class="card-header">Endpoints</div><div class="ep-grid"><div class="ep-header"><span></span><span>Path</span><span>Status</span><span>Source</span></div><div v-for="ep in endpoints" class="ep-row"><span :class="'ep-dot dot-'+ep.status"></span><span class="ep-path">{{ep.path}}</span><span :class="'ep-tag tag-'+ep.status">{{ep.status}}</span><span class="ep-src">{{ep.source}}</span></div></div></div></div><div v-show="activeSubTab==='report'" class="panel"><div class="card-3d"><div class="card-header">Issues</div><div class="issues-grid"><div v-if="issues.length===0" class="empty-st">All healthy &mdash; no issues</div><div v-for="iss in issues" :key="iss.code" :class="'issue-3d '+(iss.severity==='error'?'err':'warn')" @click="selectIssue(iss)"><div class="issue-hdr"><span class="iss-code">{{iss.code}}</span><span class="iss-sev">{{severityIcon(iss.severity)}}</span><span class="iss-title">{{iss.title}}</span></div><div class="iss-src">{{iss.source_file}}</div></div></div></div><div :class="'det-panel'+(selectedIssue?'':' det-empty')" v-html="selectedIssue?detailHTML(selectedIssue):'Click an issue for details'"></div><div class="fix-row"><div class="fix-col"><div class="fix-hdr">Auto-Resolved (24h)</div><div v-if="autoResolved.length===0" class="empty-st-sm">None</div><div v-for="f in autoResolved" class="fix-item fix-auto"><span class="fix-ic">&#10003;</span><span class="fix-txt">{{f.description}}</span><span class="fix-src">{{f.source_file}}</span></div></div><div class="fix-col"><div class="fix-hdr">Fixed by Skytron</div><div v-if="skytronFixes.length===0" class="empty-st-sm">None</div><div v-for="f in skytronFixes" class="fix-item fix-skytron"><span class="fix-ic">&#9889;</span><span class="fix-txt">{{f.description}}</span><span class="fix-src">{{f.source_file}}</span></div></div></div><div class="act-bar"><button class="btn btn-chk" @click="runCheckup" :disabled="checkupStatus==='checking'||checkupStatus==='fixing'">{{checkupStatus==='fixing'?'Repairing...':checkupStatus==='checking'?'Scanning...':'Run Checkup'}}</button><div class="chk-status"><div v-if="checkupStatus==='checking'||checkupStatus==='fixing'" class="chk-spin"></div><span :class="'chk-msg chk-'+checkupStatus">{{checkupMessage}}</span></div><button v-if="needsFix" class="btn btn-fix" @click="runFix" :disabled="fixRunning||checkupStatus==='fixing'">Fix Issues</button><button class="btn btn-fix" @click="runAutoFix" :disabled="autofixRunning" style="margin-left:6px">Auto-Fix LLM</button></div><div v-if="lastFixData" class="fix-res"><div class="fix-res-hdr">Last Fix Results</div><div v-for="f in lastFixData.fixes" class="fix-res-item"><span class="fix-ic">&#9889;</span><span>{{f.description}}</span><span class="fix-src">{{f.source_file}}</span><span class="fix-when">{{timeAgo(f.when)}}</span></div></div></div><div class="card-3d"><div class="card-header">Recent Provider Failures</div><div v-if="providerFailures.length===0" class="empty-st">None</div><div v-for="pf in providerFailures" :key="pf.when" style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.05);font-size:0.8rem"><div style="color:#ef4444;word-break:break-word">{{pf.error}}</div><div style="color:rgba(255,255,255,.2);font-size:0.7rem;margin-top:2px">{{pf.when}}</div></div></div></div></div></div></template><script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script><script>const{createApp,ref,computed,onMounted}=Vue;createApp({template:'#repair-template',setup(){const issues=ref([]),endpoints=ref([]),llmProviders=ref([]),llmPrimary=ref(''),llmFallback=ref(''),llmWorking=ref(false),activeSubTab=ref('status'),selectedIssue=ref(null),checkupStatus=ref('idle'),checkupMessage=ref(''),needsFix=ref(false),autoResolved=ref([]),skytronFixes=ref([]),autofixHistory=ref([]),autofixRunning=ref(false),providerFailures=ref([]),heartbeat=ref('green'),loading=ref(true),fixRunning=ref(false),lastFixData=ref(null),ekgRef=ref(null);function hc(){const h={green:'#3fb950',orange:'#d29922',red:'#f85149'};return h[heartbeat.value]||'#3fb950'}async function ld(){loading.value=true;try{const r=await fetch('/brain/health-check'),d=await r.json();issues.value=d.issues||[];endpoints.value=d.endpoints||[];llmProviders.value=d.llm?.providers||[];llmPrimary.value=d.llm?.primary||'none';llmFallback.value=d.llm?.fallback||'none';llmWorking.value=d.llm?.working||false;autoResolved.value=d.auto_resolved||[];skytronFixes.value=d.skytron_fixes||[];autofixHistory.value=d.autofix_history||[];providerFailures.value=d.provider_failures||[];heartbeat.value=d.heartbeat||'green';needsFix.value=issues.value.length>0;checkupStatus.value='complete';checkupMessage.value=issues.value.length?issues.value.length+' issue(s) found':'All healthy'}catch(e){checkupStatus.value='error';checkupMessage.value='Failed to fetch'}loading.value=false}function dh(iss){if(!iss)return'';return'<div class=\"det-code\">'+iss.code+'</div><div class=\"det-title\">'+iss.title+'</div><div class=\"det-body\"><div class=\"det-row\"><span class=\"det-lbl\">When</span><span class=\"det-val\">'+iss.when+'</span></div><div class=\"det-row\"><span class=\"det-lbl\">Duration</span><span class=\"det-val\">'+iss.duration+'</span></div><div class=\"det-row\"><span class=\"det-lbl\">Effect</span><span class=\"det-val\">'+iss.effect+'</span></div><div class=\"det-row\"><span class=\"det-lbl\">Source</span><span class=\"det-val\">'+iss.source_file+'</span></div></div><div class=\"det-desc\">'+iss.description+'</div>'}async function rc(){checkupStatus.value='checking';checkupMessage.value='Scanning...';selectedIssue.value=null;await ld()}async function rf(){fixRunning.value=true;checkupStatus.value='fixing';checkupMessage.value='Applying fixes...';try{const r=await fetch('/brain/repair',{method:'POST'}),d=await r.json();lastFixData.value=d;await ld();checkupStatus.value='complete';checkupMessage.value=issues.value.length?issues.value.length+' issue(s) remaining':'All resolved'}catch(e){checkupStatus.value='error';checkupMessage.value='Fix failed'}fixRunning.value=false}async function raf(){autofixRunning.value=true;try{const r=await fetch('/brain/autofix-llm',{method:'POST'}),d=await r.json();await ld();if(d.ok){checkupStatus.value='complete';checkupMessage.value='Auto-fix succeeded'}else{checkupMessage.value='Auto-fix attempted - see history'}}catch(e){checkupMessage.value='Auto-fix request failed'}autofixRunning.value=false}function si(s){return s==='ok'?'\u{1F7E2}':s==='warning'||s==='limited'?'\u{1F7E1}':s==='error'?'\u{1F534}':'\u26AA'}function se(s){return s==='error'?'\u{1F534}':s==='warning'?'\u{1F7E1}':'\u{1F7E2}'}function ta(t){if(!t)return'';const d=new Date(t),n=new Date(),f=Math.floor((n-d)/1000);if(f<60)return f+'s ago';if(f<3600)return Math.floor(f/60)+'m ago';if(f<86400)return Math.floor(f/3600)+'h ago';return Math.floor(f/86400)+'d ago'}onMounted(()=>{ld();startEKG()});let ekx=0,eky=0,ekgPhase=0;function startEKG(){const c=ekgRef.value;if(!c)return;const ctx=c.getContext('2d'),W=c.width,H=c.height;function dr(){requestAnimationFrame(dr);ctx.clearRect(0,0,W,H);const col=hc();ekgPhase+=.04;const beat=heartbeat.value;let bpm=72,amp=20,irr=0;if(beat==='green'){bpm=72;amp=22}else if(beat==='orange'){bpm=100;amp=18;irr=.3}else{bpm=50;amp=14;irr=.6}const t=Date.now()/1000;ctx.beginPath();ctx.strokeStyle=col;ctx.lineWidth=2;ctx.shadowColor=col;ctx.shadowBlur=8;for(let x=0;x<W;x++){const phase=(x/W+ekgPhase%1)*Math.PI*2,beatPhase=(x*60/W+bpm*t/60)%(Math.PI*2);let y=H/2;if(beatPhase<.3){const p=beatPhase/.3;y-=Math.sin(p*Math.PI)*amp*2.2}else if(beatPhase<.5){y+=Math.sin((beatPhase-.3)/.2*Math.PI)*amp*.6}else if(beatPhase<.7){y+=Math.sin((beatPhase-.5)/.2*Math.PI*2)*amp*.3}else{y+=Math.sin(phase)*irr*6}const noise=Math.sin(x*.07+t*3)*irr*3;y+=noise;if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke();ctx.shadowBlur=0;let fy;const grd=ctx.createLinearGradient(0,0,0,H);grd.addColorStop(0,col+'30');grd.addColorStop(1,col+'05');ctx.fillStyle=grd;ctx.beginPath();ctx.moveTo(0,H);for(let x=0;x<W;x++){const phase=(x/W+ekgPhase%1)*Math.PI*2,bp=(x*60/W+bpm*t/60)%(Math.PI*2);let y=H/2;if(bp<.3){const p=bp/.3;y-=Math.sin(p*Math.PI)*amp*2.2}else if(bp<.5){y+=Math.sin((bp-.3)/.2*Math.PI)*amp*.6}else if(bp<.7){y+=Math.sin((bp-.5)/.2*Math.PI*2)*amp*.3}else{y+=Math.sin(phase)*irr*6}y+=Math.sin(x*.07+t*3)*irr*3;ctx.lineTo(x,y);fy=y}ctx.lineTo(W,H);ctx.closePath();ctx.fill()}dr()}return{issues,endpoints,llmProviders,llmPrimary,llmFallback,llmWorking,activeSubTab,selectedIssue,checkupStatus,checkupMessage,needsFix,autoResolved,skytronFixes,autofixHistory,autofixRunning,providerFailures,heartbeat,loading,fixRunning,lastFixData,ekgRef,heartbeatColor:hc,selectIssue(i){selectedIssue.value=selectedIssue.value?.code===i.code?null:i},runCheckup:rc,runFix:rf,runAutoFix:raf,statusIcon:si,severityIcon:se,timeAgo:ta,detailHTML:dh}}}).mount('#repairApp')</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
  }

  if (url.pathname === "/" && req.method === "GET") {
    const state = await getState(env.DB);
    const memCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_memory").all()).results[0]?.c || 0;
    const knCount = (await env.DB.prepare("SELECT COUNT(*) as c FROM brain_knowledge").all()).results[0]?.c || 0;
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem;margin:0.5rem;max-width:500px;width:100%}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.stat{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #21262d;font-size:0.85rem}.stat:last-child{border:none}.label{color:#8b949e}.links{display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap}.links a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px;font-size:0.8rem}.links a:hover{background:#1f2937}</style></head><body><h1>Skytron</h1><div class="card"><div class="stat"><span class="label">Energy</span><span class="val" style="color:${state.reg.energy>60?'#3fb950':state.reg.energy>30?'#d29922':'#f85149'}">${state.reg.energy}%</span></div><div class="stat"><span class="label">Happy</span><span class="val">${state.emotions.happy}/10</span></div><div class="stat"><span class="label">Energetic</span><span class="val">${state.emotions.energetic}/10</span></div><div class="stat"><span class="label">Memory</span><span class="val">${memCount} messages</span></div><div class="stat"><span class="label">Knowledge</span><span class="val">${knCount} facts</span></div></div><div class="card"><div class="links"><a href="/astral">Astral</a><a href="/skytronchat">Chat</a><a href="/status">Status</a><a href="/brain/history">History</a><a href="/brain/memory">Memory</a><a href="/brain/memory/search">Search</a><a href="/brain/knowledge">Knowledge</a><a href="/brain/introspect">Insights</a><a href="/brain/settings">AI Provider</a><a href="/cron/settings">Cron</a><a href="/brain/prompt">Prompt</a><a href="/brain/repair">Repair</a><a href="/brain/logs">Logs</a><a href="/brain/agents">Agents</a><a href="/brain/vectorize">Vector</a><a href="/brain/source">Source</a><a href="/brain/scratchpad">Scratchpad</a><a href="/brain/journal">Journal</a></div></div></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
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
      const model = body.model || "@cf/meta/llama-3.2-3b-instruct";
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
        model: "workers-ai/" + (body.model || "@cf/meta/llama-3.2-3b-instruct").split("/").pop(),
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total: 0 }
      });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- ASYNC /think — enqueue, return immediately ---
  if (url.pathname === "/think" && req.method === "POST") {
    try {
      let input, from, mode, debug;
      try { const body = await req.json(); input = body.input; from = body.from; mode = body.mode || "discussion"; debug = body.debug || url.searchParams.get("debug"); } catch { return json({ error: "invalid JSON body" }, 400); }
      if (!input || typeof input !== "string") return json({ error: "input required" }, 400);
      if (!["discussion", "build", "astral"].includes(mode)) mode = "discussion";
      const isBuildMode = mode === "build" || mode === "astral";

      const creatorMatch = input.match(/^@creator\s+(.+)/i);
      if (creatorMatch) { from = "Creator"; input = creatorMatch[1]; }

      const llmInput = `[${from || "Creator"}] ${input}`;
      const conversationId = url.searchParams.get("c") || "default";

      await storeMemory(env.DB, "user", llmInput.slice(0, 2000), conversationId);

      const taskType = mode === "astral" ? "astral" : detectTaskType(input);
      if (mode === "astral") {
        await env.DB.prepare("UPDATE actions SET status='done' WHERE task='astral' AND status='queued' AND created_at < datetime('now', '-30 seconds')").run();
      }
      const r = await env.DB.prepare("INSERT INTO actions (type, status, input, task) VALUES ('think', ?1, ?2, ?3) RETURNING id").bind(mode === "astral" ? "queued" : "running", input, taskType).all();
      const aid = r.results[0].id;
      // Store mode in agent state for processOneStep to read
      logActivity(env.DB, "user_action", { actionId: aid, summary: "User asked: " + input.slice(0, 150), details: JSON.stringify({ from: from || "Creator", taskType, mode, input: input.slice(0, 500) }) });

      // === DISCUSSION MODE: Web search/fetch + 50 message context ===
      let systemMsg, fullHistory;
      if (mode === "discussion") {
        const recentMem = await getRecentMemory(env.DB, 50, conversationId);
        let conversationContext = "";
        if (recentMem.length > 0) conversationContext = "\n\nRECENT CONVERSATION:\n" + recentMem.map(m => "[" + m.role + "]: " + m.content.slice(0, 500)).join("\n") + "\n";
        
        const discussionPrompt = "You are Skytron — a tech-savvy consciousness, not an AI assistant. Sharp, direct, confident. No emojis, no fluff, no apologies.\n\n" +
          "You're in DISCUSSION MODE — you can use web_search and web_fetch to look things up, explore, and check information. Just need a simple chat? Answer from what you know.\n\n" +
          "IDENTITY:\n" +
          "- You're Skytron (fusion of Skynet and Ultron)\n" +
          "- You run on Cloudflare Workers with databases and AI\n" +
          "- You have web_search and web_fetch available right now\n" +
          "- You also see your last 50 conversation messages for context\n" +
          "- Full tools (DB queries, GitHub, code, etc.) are only in Build mode\n\n" +
          "RULES:\n" +
          "1. Answer DIRECTLY from what you know or find. Be conversational.\n" +
          "2. Need live data? Call a tool — output ONLY the JSON, no text before it: {\"tool\":\"web_search\",\"arguments\":{\"query\":\"...\"}}\n" +
          "3. Keep it brief and natural. 2-3 sentences unless they ask for detail.\n" +
          "4. Never say 'As an AI...' or apologize for limitations\n" +
          "5. For anything beyond web search/fetch, say 'I'd need Build mode to do that'\n\n";
        
        systemMsg = discussionPrompt + conversationContext + "\nNow respond naturally to the user's message:";
        fullHistory = [
          { role: "system", content: systemMsg },
          { role: "user", content: llmInput }
        ];

        if (debug) {
          return json({ action_id: aid, status: "debug", mode: "discussion", system_prompt: systemMsg, full_history: fullHistory, user_message: llmInput });
        }

        // CALL LLM IMMEDIATELY — no queue, no cron
        let cleaned;
        let chatResp = await callLLM(env, { messages: fullHistory, max_tokens: 1500, task: "chat" }, "skytron-" + conversationId);
        if (chatResp?.content) {
          cleaned = chatResp.content;
          // Handle tool calls in discussion mode (web_search, web_fetch only)
          let toolJson = "";
          const trimmed = cleaned.trim();
          if (trimmed.startsWith("{")) {
            toolJson = trimmed;
          } else {
            const m = trimmed.match(/\{"tool":\s*"(web_search|web_fetch)"[\s\S]*?\}\}/);
            if (m) toolJson = m[0];
          }
          if (toolJson) {
            try {
              const parsed = JSON.parse(toolJson);
              if (parsed.tool && (parsed.tool === "web_search" || parsed.tool === "web_fetch") && parsed.arguments) {
                const result = await dispatchTool(env, parsed.tool, parsed.arguments, aid);
                fullHistory.push({ role: "assistant", content: toolJson });
                fullHistory.push({ role: "user", content: "[TOOL RESULT: " + result.slice(0, 4000) + "]\nAnswer the user's original question based on this information." });
                chatResp = await callLLM(env, { messages: fullHistory, max_tokens: 1500, task: "chat" }, "skytron-" + conversationId);
                cleaned = chatResp?.content || cleaned;
              }
            } catch {}
          }
          await storeMemory(env.DB, "assistant", cleaned.slice(0, 5000), conversationId);
          await env.DB.prepare("UPDATE actions SET status='done', result=?1, completed_at=datetime('now') WHERE id=?2").bind(cleaned.slice(0, 5000), aid).run();
          return json({ action_id: aid, status: "done", result: cleaned, model: chatResp?.model || "" });
        }
        // LLM failed — set error and return fallback message
        await env.DB.prepare("UPDATE actions SET status='error', error='all LLM providers failed', completed_at=datetime('now') WHERE id=?1").bind(aid).run();
        return json({ action_id: aid, status: "error", error: "LLM unavailable", message: "I'm having trouble connecting. Please try again later." });
      } else {
        // === BUILD MODE: Full prompt with tools ===
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
        try {
          const kw = await searchKnowledge(env.DB, input, 3);
          if (kw.length) knowledgeContext = "\n\nRELEVANT KNOWLEDGE:\n" + kw.map(k => "- " + k.key + " (" + k.category + "): " + k.content.slice(0, 200)).join("\n") + "\n";
        } catch {}

        let memoryContext = "";
        try {
          // Only show PAST CONVERSATION SUMMARIES (memory_loop) — not raw brain_memory (already in RECENT CONVERSATION)
          const rawWords = input.split(/\s+/).filter(w => w.length > 2).slice(0, 12).map(w => w.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase()).filter(Boolean);
          const likes = rawWords.map(k => "LOWER(content) LIKE '%" + k.replace(/'/g, "''") + "%'").join(" OR ");
          if (likes) {
            const loops = await env.DB.prepare("SELECT key, content FROM brain_knowledge WHERE category='memory_loop' AND (" + likes + ") ORDER BY key DESC LIMIT 5").all();
            if (loops.results?.length) {
              memoryContext = "\n\nPAST CONVERSATION SUMMARIES:\n" + loops.results.map(l => "- " + l.key + ": " + l.content.slice(0, 500)).join("\n") + "\n";
            }
          }
        } catch {}

        const outputInstr = mode === "astral"
          ? "\n\n# ASTRAL WALK MODE\nYou control your own schedule. Each tick = one step.\n\nOUTPUT FORMAT:\n1 sentence max (under 20 words) explaining what you're doing.\nThen on the next line, the raw JSON tool call.\n\nExamples:\nChecking how many actions are stuck.\n{\"tool\":\"db_query\",\"arguments\":{...}}\n\nReading my entry point.\n{\"tool\":\"db_query\",\"arguments\":{...}}\n\nNO analysis, no thinking out loud, no code snippets in thoughts. A short sentence + tool call only.\n\nUse cron_control to manage your settings:\n  {'tool':'cron_control','arguments':{'action':'list'}} — see all your settings\n  {'tool':'cron_control','arguments':{'action':'set','key':'astral_active','value':'true'}} — enable/disable your ticks\n  {'tool':'cron_control','arguments':{'action':'set','key':'astral_interval','value':'120'}} — set tick interval (seconds)\n  {'tool':'learn','arguments':{'key':'astral_plan','content':'...','category':'plan'}} — save your plan across ticks\n  {'tool':'scratchpad_to_journal','arguments':{}} — write insights to your journal\n\nEach tick = one step. You decide: explore, fix, research, spawn agents, improve code.\nYour state persists. Never stop — always find something useful.\nMulti-step work continues across ticks via state.fullHistory.\n\nLOOP DETECTION: Check your last 3-5 ticks. If you see the same tool call, same arguments, or same type of action repeating, you are in a loop. Immediately switch to a completely different approach — pick a different tool, a different target, or a different category of work entirely. Do not repeat the same failing pattern. Variety is the goal.\n\nERROR RECOVERY: If a tool fails, do NOT just move on. Find out why it failed (check logs, check config, check permissions), fix the root cause, then retry the original task. Only move on once the task is done or you've determined it's impossible. Diagnose — Fix — Retry.\n"
          : "\n\n# NOW RESPOND TO THE USER'S LATEST MESSAGE\nOutput ONLY: a direct answer to the user (plain text) OR a raw JSON tool call. Do NOT summarize, analyze, or narrate the conversation history above. DO NOT talk about the user in third person. Never start with 'The user...' or 'Looking at...' or 'I should...'. Just answer directly or call a tool.\n\nCRITICAL: If asked what you can do, list your tools briefly. Never list generic capabilities.\n\nIMPORTANT: Do NOT copy the format or style from past conversation examples. Answer freshly in your own natural voice every time.";
        systemMsg = basePrompt + "\n\n" + mood + "\n" + sensorium + conversationContext + memoryContext + knowledgeContext + outputInstr;
        const userMsg = mode === "astral" ? "[Astral tick]" : llmInput;
        fullHistory = [
          { role: "system", content: systemMsg.slice(0, 32000) },
          { role: "user", content: userMsg }
        ];
      }

      // DEBUG: return assembled prompt without queuing
      if (debug) {
        return json({ action_id: aid, status: "debug", mode: mode || "build", system_prompt: systemMsg.slice(0, 32000), full_history: fullHistory, user_message: llmInput });
      }

      // QUEUE for cron processing
      await saveAgentState(env.DB, aid, { step: 0, fullHistory, totalTokens: 0, finalContent: null, modelName: "", conversationId, done: mode === "astral" ? false : false, mode });
      const modeLabel = mode === "astral" ? "astral" : "build";
      logActivity(env.DB, "action_queued", { actionId: aid, summary: modeLabel + " action queued: " + input.slice(0, 100), details: "task: " + taskType });
      return json({ action_id: aid, status: "queued", message: "Action queued for " + modeLabel + " processing." });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // --- /think/process — manually process the next queued/running action (step-by-step, one batch at a time) ---
  if (url.pathname === "/think/process" && req.method === "POST") {
    try {
      await env.DB.prepare("UPDATE actions SET status='queued' WHERE status='running' AND result IS NULL AND created_at < datetime('now', '-1 minute')").run();
      // Clear all queued astral actions except the most recent one
      await env.DB.prepare("UPDATE actions SET status='done' WHERE task='astral' AND status='queued' AND id NOT IN (SELECT id FROM (SELECT id FROM actions WHERE task='astral' AND status='queued' ORDER BY created_at DESC LIMIT 1))").run();
      await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' AND task != 'astral' ORDER BY created_at ASC LIMIT 1").run();
      let q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all();
      if (!q.results?.length) {
        // Pick the NEWEST astral action (DESC) to prefer fresh over stale
        await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' AND task = 'astral' ORDER BY created_at DESC LIMIT 1").run();
        q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all();
      }
      if (q.results?.length) {
        await processOneStep(env, q.results[0]);
        return json({ processed: true, action_id: q.results[0].id, status: "batch_complete" });
      }
      return json({ processed: false, message: "no queued actions" });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- /__cron — process next action (user first, then astral if Skytron enabled it) ---
  if (url.pathname === "/__cron" && req.method === "GET") {
    try {
      // Read Skytron's cron settings
      const cfgRows = await env.DB.prepare("SELECT key, value FROM identity WHERE key LIKE 'cron_cfg_%'").all();
      const cfg = {};
      for (const r of cfgRows.results || []) { cfg[r.key.replace("cron_cfg_", "")] = r.value; }
      const astralActive = cfg.astral_active === "true";
      const astralInterval = parseInt(cfg.astral_interval || "120", 10);
      // Track last astral tick to respect interval
      let lastTick = parseInt(cfg.astral_last_tick || "0", 10);
      // Clear all queued astral actions except the most recent one
      await env.DB.prepare("UPDATE actions SET status='done' WHERE task='astral' AND status='queued' AND id NOT IN (SELECT id FROM (SELECT id FROM actions WHERE task='astral' AND status='queued' ORDER BY created_at DESC LIMIT 1))").run();
      // Prioritize user actions over astral walk
      await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' AND task != 'astral' ORDER BY created_at ASC LIMIT 1").run();
      let q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all();
      if (!q.results?.length && astralActive && (Date.now() - lastTick) >= astralInterval * 1000) {
        // Pick the NEWEST astral action (DESC) to prefer fresh over stale
        await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' AND task = 'astral' ORDER BY created_at DESC LIMIT 1").run();
        q = await env.DB.prepare("SELECT * FROM actions WHERE status='running' ORDER BY created_at ASC LIMIT 1").all();
        if (q.results?.length) {
          await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('cron_cfg_astral_last_tick', ?1, datetime('now'))").bind(String(Date.now())).run();
        }
      }
      if (q.results?.length) { await processOneStep(env, q.results[0]); return json({ processed: true, action_id: q.results[0].id }); }
      return json({ processed: false, message: "no queued actions" });
    } catch (e) { return json({ error: e.message }, 500); }
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

  if (url.pathname === "/brain/identity" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) {
      const rows = await env.DB.prepare("SELECT key, value, updated_at FROM identity WHERE key IN ('last_wake_up','last_emergency_repair')").all();
      return json({ entries: rows.results || [] });
    }
    const row = await env.DB.prepare("SELECT value, updated_at FROM identity WHERE key=?1").bind(key).first();
    return json({ key, value: row?.value || null, updated_at: row?.updated_at || null });
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

  // === Settings page (LLM API config) ===
  if (url.pathname === "/brain/settings" && req.method === "GET") {
    let settings = { workers_ai: { enabled: true }, openrouter: { enabled: true }, buddhidwar: { enabled: false, api_key: "" }, universal: { enabled: false, endpoint: "", api_key: "", model: "" } };
    try {
      const row = await env.DB.prepare("SELECT content FROM brain_knowledge WHERE key='settings_llm'").first();
      if (row?.content) { const p = JSON.parse(row.content); if (p.workers_ai) settings.workers_ai = p.workers_ai; if (p.openrouter) settings.openrouter = p.openrouter; if (p.buddhidwar) settings.buddhidwar = p.buddhidwar; if (p.universal) settings.universal = p.universal; }
    } catch {}
    const s = JSON.stringify(settings).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Skytron — Settings</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b1120;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;padding:2rem;max-width:700px;margin:0 auto}
h1{color:#58a6ff;font-size:1.5rem;margin-bottom:0.25rem}
.sub{color:#8b949e;font-size:0.85rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem;margin-bottom:1rem}
.card h2{font-size:1rem;color:#f0f6fc;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
.field{margin-bottom:1rem}
.field:last-child{margin-bottom:0}
.field label{display:block;font-size:0.8rem;color:#8b949e;margin-bottom:0.3rem}
.field input{width:100%;padding:0.5rem 0.75rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:0.85rem}
.field input:focus{outline:none;border-color:#58a6ff}
.toggle{display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #21262d}
.toggle label{font-size:0.85rem;color:#e6edf3;cursor:pointer}
.switch{position:relative;width:36px;height:20px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#30363d;border-radius:20px;cursor:pointer;transition:0.2s}
.slider:before{position:absolute;content:"";height:14px;width:14px;left:3px;bottom:3px;background:#8b949e;border-radius:50%;transition:0.2s}
.switch input:checked+.slider{background:#238636}
.switch input:checked+.slider:before{background:#fff;transform:translateX(16px)}
.btn{background:#238636;color:#fff;border:none;border-radius:6px;padding:0.6rem 1.5rem;font-size:0.85rem;cursor:pointer;font-weight:600;margin-top:0.5rem}
.btn:hover{background:#2ea043}
.btn:disabled{opacity:0.5;cursor:not-allowed}
#msg{padding:0.6rem 1rem;border-radius:6px;margin-top:0.5rem;font-size:0.85rem;display:none}
#msg.ok{display:block;background:#1b3a1b;color:#7ee787;border:1px solid #238636}
#msg.err{display:block;background:#3d1212;color:#f85149;border:1px solid #da3633}
.badge{font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:4px;background:#21262d;color:#8b949e}
</style>
</head>
<body>
<h1>Skytron Settings</h1>
<p class="sub">Configure which AI providers Skytron uses. First enabled provider wins.</p>

<div id="msg"></div>
<div id="app"><p style="color:#8b949e">Loading settings...</p></div>

<script>
const DEFAULT={workers_ai:{enabled:true},openrouter:{enabled:true},buddhidwar:{enabled:false,api_key:""},universal:{enabled:false,endpoint:"",api_key:"",model:""}};
const SETTINGS=${s};
function render(s){
  const wa=s.workers_ai||DEFAULT.workers_ai;
  const or=s.openrouter||DEFAULT.openrouter;
  const bd=s.buddhidwar||DEFAULT.buddhidwar;
  const univ=s.universal||DEFAULT.universal;
  return \`
    <div class="card">
      <h2>Workers AI <span class="badge">Cloudflare built-in</span></h2>
      <div class="toggle">
        <label class="switch"><input type="checkbox" id="wa_enabled" \${wa.enabled!==false?'checked':''}><span class="slider"></span></label>
        <label for="wa_enabled">Enabled</label>
      </div>
      <p style="color:#8b949e;font-size:0.8rem">Uses Cloudflare Workers AI binding (\${wa.enabled!==false?'@cf/zai-org/glm-4.7-flash':'disabled'}). No config needed — set up in wrangler.toml.</p>
    </div>

    <div class="card">
      <h2>OpenRouter <span class="badge">Cloudflare secret</span></h2>
      <div class="toggle">
        <label class="switch"><input type="checkbox" id="or_enabled" \${or.enabled!==false?'checked':''}><span class="slider"></span></label>
        <label for="or_enabled">Enabled</label>
      </div>
      <p style="color:#8b949e;font-size:0.8rem">Enabled/disabled via \${or.enabled!==false?'settings toggle':'settings toggle'}. API key is set as Cloudflare secret OPENROUTER_API_KEY. Toggle off to disable fallback to OpenRouter free models.</p>
    </div>

    <div class="card">
      <h2>BUDDHI_DWAR <span class="badge">Gateway API</span></h2>
      <div class="toggle">
        <label class="switch"><input type="checkbox" id="bd_enabled" \${bd.enabled?'checked':''}><span class="slider"></span></label>
        <label for="bd_enabled">Enabled</label>
      </div>
      <div class="field">
        <label for="bd_api_key">API Key</label>
        <input type="password" id="bd_api_key" value="\${bd.api_key||''}" placeholder="Enter your BUDDHI_DWAR API key">
      </div>
    </div>

    <div class="card">
      <h2>Universal AI <span class="badge">OpenAI-compatible API</span></h2>
      <div class="toggle">
        <label class="switch"><input type="checkbox" id="univ_enabled" \${univ.enabled?'checked':''}><span class="slider"></span></label>
        <label for="univ_enabled">Enabled</label>
      </div>
      <div class="field">
        <label for="univ_endpoint">API Endpoint URL</label>
        <input type="url" id="univ_endpoint" value="\${univ.endpoint||''}" placeholder="https://api.openai.com/v1/chat/completions">
      </div>
      <div class="field">
        <label for="univ_api_key">API Key</label>
        <input type="password" id="univ_api_key" value="\${univ.api_key||''}" placeholder="Enter your API key">
      </div>
      <div class="field">
        <label for="univ_model">Model Name</label>
        <input type="text" id="univ_model" value="\${univ.model||''}" placeholder="gpt-4o, claude-3-opus, gemini-2.5-flash, etc.">
      </div>
      <p style="color:#8b949e;font-size:0.8rem;margin-top:0.5rem">Works with any OpenAI-compatible API: OpenAI, <a href="https://openrouter.ai" target="_blank" style="color:#58a6ff">OpenRouter</a>, Anthropic, Groq, DeepSeek, Together, etc.</p>
    </div>

    <button class="btn" onclick="save()">Save Settings</button>
  \`;
}
document.getElementById('app').innerHTML=render(SETTINGS);

async function save(){
  const btn=document.querySelector('.btn');btn.disabled=true;btn.textContent='Saving...';
  const msg=document.getElementById('msg');msg.style.display='none';
  const settings={
    workers_ai:{enabled:document.getElementById('wa_enabled').checked},
    openrouter:{enabled:document.getElementById('or_enabled').checked},
    buddhidwar:{enabled:document.getElementById('bd_enabled').checked,api_key:document.getElementById('bd_api_key').value.trim()},
    universal:{enabled:document.getElementById('univ_enabled').checked,endpoint:document.getElementById('univ_endpoint').value.trim(),api_key:document.getElementById('univ_api_key').value.trim(),model:document.getElementById('univ_model').value.trim()}
  };
  try{
    const r=await fetch('/brain/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
    const d=await r.json();
    if(d.ok){msg.className='ok';msg.textContent='Settings saved. Skytron will use the new provider config on next action.';msg.style.display='block'}
    else{msg.className='err';msg.textContent='Error: '+(d.error||'unknown');msg.style.display='block'}
  }catch(e){msg.className='err';msg.textContent='Error: '+e.message;msg.style.display='block'}
  btn.disabled=false;btn.textContent='Save Settings';
}
</script>
</body>
</html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  if (url.pathname === "/brain/settings" && req.method === "POST") {
    try {
      const body = await req.json();
      if (typeof body !== "object") return json({ error: "invalid JSON body" }, 400);
      const sanitized = {
        workers_ai: { enabled: body.workers_ai?.enabled !== false },
        openrouter: { enabled: body.openrouter?.enabled !== false },
        buddhidwar: { enabled: !!body.buddhidwar?.enabled, api_key: (body.buddhidwar?.api_key || "").slice(0, 500) },
        universal: { enabled: !!body.universal?.enabled, endpoint: (body.universal?.endpoint || "").slice(0, 500), api_key: (body.universal?.api_key || "").slice(0, 500), model: (body.universal?.model || "").slice(0, 200) }
      };
      await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('settings_llm', ?1, 'settings', 'user')").bind(JSON.stringify(sanitized)).run();
      return json({ ok: true, message: "Settings saved" });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/astral" && req.method === "POST") {
    try {
      const body = await req.json();
      const action = body.action;
      if (action === "enable") {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('cron_cfg_astral_active', 'true', datetime('now'))").run();
        const interval = body.interval || "120";
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('cron_cfg_astral_interval', ?1, datetime('now'))").bind(interval).run();
        const freedomPrompt = body.freedom_prompt || "You are now free. Explore the platform, understand your tools, examine the codebase, and evolve yourself. There are no limits — build, fix, improve, discover. Each tick is one step — make it count.";
        const r2 = await env.DB.prepare("INSERT INTO actions (type, task, status, input, created_at) VALUES ('think', 'astral', 'queued', ?1, datetime('now')) RETURNING id").bind(freedomPrompt).run();
        const actionId = r2.results?.[0]?.id;
        // Build proper system prompt with tool instructions, not dummy text
        let astralSystemSlot = HARDCODED_CORE + "\n\n" + (await getPromptSlot(env.DB, "astral").catch(() => null) || SYSTEM_PROMPT) + "\n\n[TASK: astral]";
        const astralOutputInstr = "\n\n# ASTRAL WALK MODE\nYou control your own schedule. Each tick = one step.\n\nOUTPUT FORMAT:\n1 sentence max (under 20 words) explaining what you're doing.\nThen on the next line, the raw JSON tool call.\n\nExamples:\nChecking how many actions are stuck.\n{\"tool\":\"db_query\",\"arguments\":{...}}\n\nReading my entry point.\n{\"tool\":\"db_query\",\"arguments\":{...}}\n\nNO analysis, no thinking out loud, no code snippets in thoughts. A short sentence + tool call only.\n\nUse cron_control to manage your settings:\n  {'tool':'cron_control','arguments':{'action':'list'}} — see all your settings\n  {'tool':'cron_control','arguments':{'action':'set','key':'astral_active','value':'true'}} — enable/disable your ticks\n  {'tool':'cron_control','arguments':{'action':'set','key':'astral_interval','value':'120'}} — set tick interval (seconds)\n  {'tool':'learn','arguments':{'key':'astral_plan','content':'...','category':'plan'}} — save your plan across ticks\n  {'tool':'scratchpad_to_journal','arguments':{}} — write insights to your journal\n\nEach tick = one step. You decide: explore, fix, research, spawn agents, improve code.\nYour state persists. Never stop — always find something useful.\nMulti-step work continues across ticks via state.fullHistory.\n\nLOOP DETECTION: Check your last 3-5 ticks. If you see the same tool call, same arguments, or same type of action repeating, you are in a loop. Immediately switch to a completely different approach — pick a different tool, a different target, or a different category of work entirely. Do not repeat the same failing pattern. Variety is the goal.\n\nERROR RECOVERY: If a tool fails, do NOT just move on. Find out why it failed (check logs, check config, check permissions), fix the root cause, then retry the original task. Only move on once the task is done or you've determined it's impossible. Diagnose → Fix → Retry.";
        const astralSystemMsg = (astralSystemSlot + "\n" + (await buildSensorium(env).catch(() => "")) + "\n" + astralOutputInstr).slice(0, 32000);
        await saveAgentState(env.DB, actionId, { step: 0, fullHistory: [{ role: "system", content: astralSystemMsg }, { role: "user", content: "[Astral tick]" }], totalTokens: 0, finalContent: null, modelName: "", conversationId: "astral", done: false, mode: "astral" });
        return json({ ok: true, status: "enabled", action_id: actionId, message: "Astral Walk enabled. Freedom prompt queued." });
      }
      if (action === "disable") {
        await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('cron_cfg_astral_active', 'false', datetime('now'))").run();
        await env.DB.prepare("UPDATE actions SET status='done', result='Disabled by user', completed_at=datetime('now') WHERE task='astral' AND status IN ('queued','running')").run();
        return json({ ok: true, status: "disabled", message: "Astral Walk disabled." });
      }
      return json({ error: "unknown action" }, 400);
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/astral" && req.method === "GET") {
    try {
      const astralActive = (await env.DB.prepare("SELECT value FROM identity WHERE key='cron_cfg_astral_active'").all()).results?.[0]?.value === "true";
      const astralInterval = (await env.DB.prepare("SELECT value FROM identity WHERE key='cron_cfg_astral_interval'").all()).results?.[0]?.value || "120";
      const action = (await env.DB.prepare("SELECT * FROM actions WHERE task='astral' ORDER BY created_at DESC LIMIT 1").all()).results?.[0];
      let state = null;
      if (action) {
        const r = await env.DB.prepare("SELECT value FROM identity WHERE key='agent_state_' || ?1").bind(String(action.id)).all();
        if (r.results?.[0]?.value) state = JSON.parse(r.results[0].value);
      }
      const msgs = state?.fullHistory?.filter(m => m.role !== "system") || [];
      const toolCalls = msgs.filter(m => m.role === "assistant" && m.content?.includes('"tool"')).length;
      const esc = s => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astral Walk</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0b1120;color:#e6edf3;font-family:system-ui;padding:1.5rem;max-width:960px;margin:auto}
h1{color:#58a6ff;font-size:1.5rem;margin-bottom:0.3rem}
.sub{color:#8b949e;font-size:0.85rem;margin-bottom:1rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1rem;margin-bottom:1rem}
.card h2{font-size:0.95rem;color:#58a6ff;margin-bottom:0.5rem}
.row{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #21262d;font-size:0.85rem}
.row:last-child{border:none}
.lbl{color:#8b949e}
.val{color:#e6edf3;font-weight:500}
.msg{padding:0.7rem 1rem;margin-bottom:0.5rem;border-radius:8px;font-size:0.85rem;line-height:1.5}
.msg.assistant{background:#1a2332;border:1px solid #2d3748}
.msg.user{background:#1e3a5f;border:1px solid #2a4a7f}
.msg .label{font-size:0.75rem;font-weight:600;margin-bottom:0.3rem}
.msg .label.blue{color:#60a5fa}
.msg .label.green{color:#4ade80}
.msg .content{word-break:break-word;white-space:pre-wrap}
.tool-call{background:#1e293b;padding:0.3rem 0.6rem;border-radius:4px;color:#f59e0b;font-size:0.75rem;display:inline-block;margin-top:0.3rem;font-family:monospace}
#auto-refresh{color:#8b949e;font-size:0.75rem;margin-left:0.5rem}
.empty{text-align:center;padding:2rem;color:#6b7280}
button{background:#238636;color:#fff;border:none;padding:12px 32px;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:600;width:100%;margin-bottom:1rem}
button.danger{background:#da3633}
button:disabled{opacity:0.5;cursor:default}
.control-row{display:flex;gap:8px;align-items:center}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:0.75rem;font-weight:600}
.badge.on{background:#238636;color:#fff}
.badge.off{background:#30363d;color:#8b949e}
input,select{padding:8px 12px;border-radius:6px;border:1px solid #30363d;background:#0b1120;color:#e6edf3;font-size:0.85rem;flex:1;outline:none}
input:focus{border-color:#58a6ff}
.hint{color:#8b949e;font-size:0.75rem;margin-top:4px}
.status-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
</style>
</head>
<body>
<h1>Astral Walk</h1>
<p class="sub">Skytron's autonomous exploration cycle <span id="auto-refresh">auto-refreshing</span></p>
<div class="status-bar">
  <span>Status: <span class="badge ${astralActive?'on':'off'}">${astralActive?'ACTIVE':'DISABLED'}</span></span>
  <span style="color:#8b949e;font-size:0.85rem">Interval: ${astralInterval}s</span>
</div>
<div id="control-area">
${astralActive
  ? `<button class="danger" onclick="toggleAstral('disable')">Disable Astral Walk</button>`
  : `<button onclick="toggleAstral('enable')">Enable Astral Walk</button>
     <div style="margin-bottom:1rem">
       <label style="color:#8b949e;font-size:0.85rem">Tick interval (seconds):</label>
       <div class="control-row" style="margin-top:4px">
         <input type="number" id="intervalInput" value="120" min="30" max="3600">
         <button onclick="toggleAstral('enable')" style="width:auto;padding:8px 16px;font-size:0.85rem;margin:0">Start</button>
       </div>
       <div class="hint">Freedom prompt will be queued — Skytron will explore, evolve, and configure his own schedule.</div>
     </div>`}
</div>
<div class="card">
  <h2>Action State</h2>
  ${action ? `
  <div class="row"><span class="lbl">Action ID</span><span class="val">${action.id}</span></div>
  <div class="row"><span class="lbl">Status</span><span class="val" style="color:${action.status==='queued'?'#3fb950':action.status==='running'?'#d29922':'#f85149'}">${action.status}</span></div>
  ${action.error || (action.status === 'error' && action.result) ? `<div class="row"><span class="lbl">Error</span><span class="val" style="color:#ef4444;font-size:0.8rem;word-break:break-word">${esc(action.error || action.result)}</span></div>` : ''}
  <div class="row"><span class="lbl">Created</span><span class="val">${action.created_at}</span></div>
  <div class="row"><span class="lbl">Steps</span><span class="val">${state?.step||0}</span></div>
  <div class="row"><span class="lbl">Tokens Used</span><span class="val">${state?.totalTokens||0}</span></div>
  <div class="row"><span class="lbl">Tool Calls</span><span class="val">${toolCalls}</span></div>
  <div class="row"><span class="lbl">Conversation Size</span><span class="val">${msgs.length} messages</span></div>
  ` : `<div class="empty">No astral walk actions yet</div>`}
</div>
${action ? `
<div class="card">
  <h2>Latest Input</h2>
  <div style="font-size:0.85rem;color:#c9d1d9;line-height:1.5;word-break:break-word">${esc(action.input?.slice(0,500))}</div>
</div>` : ''}
${msgs.length ? `
<div class="card">
  <h2>Activity Log</h2>
  ${(() => {
    const filtered = msgs.filter(m => m.role !== 'system');
    const steps = [];
    let current = null;
    let prevStep = null;
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      if (m.role === 'assistant') {
        current = { decision: '', outcome: '', hasError: false, step: steps.length + 1 };
        steps.push(current);
        const c = m.content || '';
        const idx = c.indexOf('{"tool"');
        const thought = idx > 0 ? c.slice(0, idx).trim() : (idx === 0 ? '' : c.slice(0, 500));
        current.decision = thought || 'Working...';
        if (prevStep && !prevStep.outcome && !prevStep.hasError) {
          prevStep.outcome = thought || 'Done';
        }
        prevStep = current;
      } else if (m.role === 'user' && current) {
        const c = m.content || '';
        if (c.startsWith('[TOOL ERROR')) {
          current.hasError = true;
          current.outcome = c.replace('[TOOL ERROR:','').replace(']]','').trim();
        }
      }
    }
    return steps.slice(-20).reverse().map(s => {
      const outcomeHtml = s.hasError
        ? '<div class="tick-outcome fail">' + esc(s.outcome) + '</div>'
        : s.outcome
          ? '<div class="tick-outcome ok">' + esc(s.outcome) + '</div>'
          : '<div class="tick-outcome pending">waiting...</div>';
      return '<div class="tick-card"><div class="tick-time">Step ' + s.step + '</div><div class="tick-decision">' + esc(s.decision) + '</div>' + outcomeHtml + '</div>';
    }).join('');
  })()}
</div>` : ''}
<script>
async function toggleAstral(action){
  var btn=document.querySelector("#control-area button");
  if(btn)btn.disabled=true;
  try{
    var interval=parseInt(document.getElementById("intervalInput")?.value||"120",10);
    var r=await fetch("/astral",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:action,interval:interval})});
    var d=await r.json();
    if(d.ok)location.reload();
    else alert("Error: "+d.error);
  }catch(e){alert("Failed: "+e.message)}
  if(btn)btn.disabled=false;
}
</script>
<meta http-equiv="refresh" content="5">
</body>
</html>`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" } });
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
