// Route handlers for all endpoints: /think (main conversation, POST), /think/result (poll), /skytronchat (UI), /brain/* (memory/knowledge/logs/agents/source/introspect/prompt), /status, /__cron.
import { HARDCODED_CORE, SYSTEM_PROMPT, PROMPT_SLOTS } from './constants';
import { initSchema, getPromptSlot, detectTaskType, getState, describeMood, storeMemory, getRecentMemory, searchKnowledge, semanticSearch, ensureVectorizeIndex, indexAllKnowledge, indexKnowledgeForSearch, saveAgentState } from './db';
import { processOneStep, processOneAgentStep } from './agents';
import { toolDefinitions } from './tools';

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

  if (url.pathname === "/brain/source") {
    return json({
      language: "TypeScript", runtime: "Cloudflare Workers (ES module)", file: "src/ (modular)",
      endpoints: ["/think","/status","/skytronchat","/","/brain/history","/brain/memory","/brain/memory/search","/brain/knowledge","/brain/prompt","/brain/prompt/reset","/brain/repair","/brain/logs","/brain/vectorize","/brain/introspect","/brain/source","/brain/agents"],
      tools: Object.keys(toolDefinitions),
      tables: ["identity","brain_memory","brain_knowledge","actions","brain_logs","brain_agents","knowledge_fts"],
      llm: "Workers AI (@cf/zai-org/glm-4.7-flash) + BUDDHI_DWAR (Groq + OpenCode Zen)",
      agent_loop: "Multi-step function-calling with Zod schema validation (max 15 steps). Sub-agents: spawn_agent + get_agent_result for parallel specialized tasks (max 8 steps, limited tools).",
      capabilities: ["conversation with 10-msg memory","web search","web fetch","DB introspection","prompt self-edit","code execution (38+ langs)","API calls","knowledge base (FTS5 + vector)","GitHub self-modification","live docs via Context7","emotions & energy","conversation history viewer","sub-agents for parallel tasks"]
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
    return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skytron</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1120;color:#e6edf3;font-family:system-ui;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem}.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem;margin:0.5rem;max-width:500px;width:100%}h1{color:#58a6ff;font-size:1.5rem;margin-bottom:1rem}.stat{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid #21262d;font-size:0.85rem}.stat:last-child{border:none}.label{color:#8b949e}.links{display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap}.links a{color:#58a6ff;text-decoration:none;padding:0.4rem 0.8rem;border:1px solid #30363d;border-radius:8px;font-size:0.8rem}.links a:hover{background:#1f2937}</style></head><body><h1>Skytron</h1><div class="card"><div class="stat"><span class="label">Energy</span><span class="val" style="color:${state.reg.energy>60?'#3fb950':state.reg.energy>30?'#d29922':'#f85149'}">${state.reg.energy}%</span></div><div class="stat"><span class="label">Happy</span><span class="val">${state.emotions.happy}/10</span></div><div class="stat"><span class="label">Energetic</span><span class="val">${state.emotions.energetic}/10</span></div><div class="stat"><span class="label">Memory</span><span class="val">${memCount} messages</span></div><div class="stat"><span class="label">Knowledge</span><span class="val">${knCount} facts</span></div></div><div class="card"><div class="links"><a href="/skytronchat">Chat</a><a href="/status">Status</a><a href="/brain/history">History</a><a href="/brain/memory">Memory</a><a href="/brain/memory/search?q=">Search</a><a href="/brain/knowledge">Knowledge</a><a href="/brain/introspect">Insights</a><a href="/brain/source">About</a></div></div></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
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
      const resp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/v1/providers/health", {
        headers: { Authorization: "Bearer " + env.BRAIN_KEY }
      });
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/usage" && req.method === "GET") {
    try {
      const days = parseInt(url.searchParams.get("days")) || 1;
      const resp = await env.BUDDHI_DWAR.fetch("https://buddhi-dwar/analytics?days=" + days, {
        headers: { Authorization: "Bearer " + env.BRAIN_KEY }
      });
      if (!resp.ok) return json({ error: "failed to fetch usage" }, 502);
      const data = await resp.json();
      return json({ usage: data });
    } catch (e) { return json({ error: e.message }, 500); }
  }

  if (url.pathname === "/brain/vectorize" && req.method === "POST") {
    try { await ensureVectorizeIndex(env); await indexAllKnowledge(env, env.DB); return json({ ok: true, indexed: true }); } catch (e) { return json({ error: e.message }, 500); }
  }

  // --- ASYNC /think — enqueue, return immediately ---
  if (url.pathname === "/think" && req.method === "POST") {
    try {
      let input, from;
      try { const body = await req.json(); input = body.input; from = body.from; } catch { return json({ error: "invalid JSON body" }, 400); }
      if (!input || typeof input !== "string") return json({ error: "input required" }, 400);

      const creatorMatch = input.match(/^@creator\s+(.+)/i);
      if (creatorMatch) { from = "Creator"; input = creatorMatch[1]; }

      const llmInput = `[${from || "Creator"}] ${input}`;
      const conversationId = url.searchParams.get("c") || "default";

      await storeMemory(env.DB, "user", llmInput.slice(0, 2000), conversationId);

      const taskType = detectTaskType(input);
      const r = await env.DB.prepare("INSERT INTO actions (type, status, input, task) VALUES ('think', 'queued', ?1, ?2) RETURNING id").bind(input, taskType).all();
      const aid = r.results[0].id;

      let slotContent = await getPromptSlot(env.DB, taskType);
      if (!slotContent) {
        const ov = await env.DB.prepare("SELECT value FROM identity WHERE key='prompt_override'").all().catch(() => ({}));
        slotContent = (ov.results?.[0]?.value && ov.results[0].value !== "null" && ov.results[0].value !== "DELETE|OVERRIDE") ? ov.results[0].value : SYSTEM_PROMPT;
      }
      const basePrompt = HARDCODED_CORE + "\n\n" + slotContent + "\n\n[TASK: " + taskType + "]";

      const stateData = await getState(env.DB);
      const mood = describeMood(stateData.emotions, stateData.reg.energy);
      const recentMem = await getRecentMemory(env.DB, 10, conversationId);

      let conversationContext = "";
      if (recentMem.length > 0) conversationContext = "\n\nRECENT CONVERSATION:\n" + recentMem.map(m => { var c = m.content.slice(0, 1000); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,100}?[\)\]\]]/g, "[TOOL CALL - see history page]"); return "[" + m.role + "]: " + c; }).join("\n") + "\n";

      let knowledgeContext = "";
      try {
        const kw = await searchKnowledge(env.DB, input, 3);
        if (kw.length) knowledgeContext = "\n\nRELEVANT KNOWLEDGE:\n" + kw.map(k => "- " + k.key + " (" + k.category + "): " + k.content.slice(0, 200)).join("\n") + "\n";
        const sem = await semanticSearch(env, input, 3);
        if (sem.length) knowledgeContext += "\nSEMANTIC MATCHES:\n" + sem.map(s => "- " + s.key + " (score: " + s.score.toFixed(2) + "): " + s.content.slice(0, 200)).join("\n") + "\n";
      } catch {}

      let memoryContext = "";
      try {
        const words = input.split(/\s+/).filter(w => w.length > 2).slice(0, 4).map(w => w.replace(/[^a-zA-Z0-9-]/g, "")).filter(Boolean);
        if (words.length) {
          const recentIds = recentMem.map(m => m.id).filter(id => id != null).join(",");
          const likes = words.map(k => "content LIKE '%" + k.replace(/'/g, "''") + "%'").join(" OR ");
          let sql = "SELECT role, content, created_at FROM brain_memory WHERE (" + likes + ")";
          if (recentIds) sql += " AND id NOT IN (" + recentIds + ")";
          sql += " ORDER BY id DESC LIMIT 8";
          const mr = await env.DB.prepare(sql).all();
          if (mr.results?.length) memoryContext = "\n\nPAST MEMORIES:\n" + mr.results.map(m => { var c = m.content.slice(0, 1000); c = c.replace(/TOOL:\w+[\(\[\[][\s\S]{0,100}?[\)\]\]]/g, "[TOOL CALL]"); return "[" + m.role + " " + (m.created_at || "") + "]: " + c; }).join("\n") + "\n";
        }
      } catch {}

      const systemMsg = basePrompt + "\n\n" + mood + conversationContext + memoryContext + knowledgeContext + "\n\n# NOW RESPOND TO THE USER'S LATEST MESSAGE\nOutput ONLY: a direct answer to the user (plain text) OR a raw JSON tool call. Do NOT summarize, analyze, or narrate the conversation history above. Do NOT talk about the user in third person. Never start with 'The user...' or 'Looking at...' or 'I should...'. Just answer directly or call a tool.\n\nCRITICAL: If asked what you can do, say something like: \"I have ~23 tools. What do you need?\" Never list generic capabilities like \"answer questions\" or \"provide information\". Answer in under 20 words.";
      const fullHistory = [
        { role: "system", content: systemMsg.slice(0, 32000) },
        { role: "user", content: llmInput }
      ];

      await saveAgentState(env.DB, aid, { step: 0, fullHistory, totalTokens: 0, finalContent: null, modelName: "", conversationId, done: false });

      ctx.waitUntil((async () => {
        try {
          await env.DB.prepare("UPDATE actions SET status='running' WHERE id=?1").bind(aid).run();
          await processOneStep(env, { id: aid });
        } catch (e) { console.error("background /think processing error:", e); }
        try {
          const ar = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 3").all();
          for (const agent of (ar.results || [])) {
            try { await processOneAgentStep(env, agent); } catch (e2) { console.error("post-action agent error:", e2); }
          }
        } catch (e3) { console.error("post-action agent query error:", e3); }
      })());

      return json({ action_id: aid, status: "queued", message: "Request queued. Poll /think/result?id=" + aid + " for result." });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
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
      .replace(/^As\s+an\s+AI[,.]?\s+.*/i, "I'm Skytron. I run on Cloudflare Workers with ~23 tools. What do you need?")
      .replace(/^I\s+am\s+Skytron[,.]?\s*(?:a\s+)?(?:helpful\s+)?(?:AI\s+)?(?:assistant|model|chatbot|bot)[,.]?\s*(?:I\s+)?(?:can|am|will|would|have).*/i, "I'm Skytron. I run on Cloudflare Workers with ~23 tools. What do you need?")
      .replace(/^I'm\s+Skytron[,.]?\s*(?:a\s+)?(?:helpful\s+)?(?:AI\s+)?(?:assistant|model|chatbot|bot)[,.]?\s*(?:I\s+)?(?:can|am|will|would|have).*/i, "I'm Skytron. I run on Cloudflare Workers with ~23 tools. What do you need?")
      .replace(/\b(?:an?\s+|as an?\s+)?(?:AI\s+(?:assistant|model|chatbot|bot)|language model|LLM)\b/gi, "")
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

  return json({ error: "not found" }, 404);
}
