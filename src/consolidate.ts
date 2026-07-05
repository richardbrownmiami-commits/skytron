// === Consolidation Pipeline: Phase 1 — Collect All Data to Scratchpad ===

const SCRATCHPAD_DDL = `CREATE TABLE IF NOT EXISTS consolidation_scratchpad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  record_id INTEGER,
  content TEXT NOT NULL,
  collected_at TEXT DEFAULT (datetime('now')),
  batch_id TEXT NOT NULL
)`;

const SOURCE_TABLES = [
  { name: 'brain_memory', select: 'id, role, content, conversation_id, created_at', idCol: 'id' },
  { name: 'actions', select: 'id, type, status, input, task, result, error, created_at, completed_at', idCol: 'id' },
  { name: 'activity_log', select: 'id, event_type, action_id, tool_name, summary, details, created_at', idCol: 'id' },
  { name: 'brain_knowledge', select: 'id, key, content, category, source, created_at', idCol: 'id' },
  { name: 'brain_vectors', select: 'id, ref_key, category, created_at', idCol: 'id' },
  { name: 'identity', select: 'rowid, key, value, updated_at', idCol: 'rowid' },
  { name: 'brain_agents', select: 'id, name, status, step, instruction, result, created_at, updated_at', idCol: 'id' },
];

export async function ensureScratchpadTable(env) {
  await env.DB.prepare(SCRATCHPAD_DDL).run();
}

export async function collectToScratchpad(env) {
  await ensureScratchpadTable(env);
  const batchId = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let totalRows = 0;
  const MAX_PER_TABLE = 20; // Collect max 20 per table per tick to stay within API limits

  for (const table of SOURCE_TABLES) {
    const maxKey = 'consolidate_last_' + table.name + '_id';
    const lastIdRow = await env.DB.prepare("SELECT value FROM identity WHERE key=?1").bind(maxKey).first();
    const lastId = parseInt(lastIdRow?.value) || 0;
    const idCol = table.idCol || 'id';

    const rows = await env.DB.prepare("SELECT " + table.select + " FROM " + table.name + " WHERE " + idCol + " > ?1 ORDER BY " + idCol + " ASC LIMIT ?2").bind(lastId, MAX_PER_TABLE).all();
    if (!rows.results?.length) continue;

    let newMaxId = lastId;
    const batch = [];
    for (const row of rows.results) {
      const rid = row[idCol] || 0;
      if (rid > newMaxId) newMaxId = rid;
      batch.push(env.DB.prepare(
        "INSERT INTO consolidation_scratchpad (source_table, record_id, content, batch_id) VALUES (?1, ?2, ?3, ?4)"
      ).bind(table.name, rid, JSON.stringify(row), batchId));
    }
    try {
      if (batch.length > 0) await env.DB.batch(batch);
      totalRows += batch.length;
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(maxKey, String(newMaxId)).run();
    } catch (e) {
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES (?1, ?2, datetime('now'))").bind(maxKey, String(newMaxId)).run();
      break;
    }
  }

    return { batchId, totalRows };
}

export async function getScratchpad(env, batchId = null) {
  if (batchId) {
    return await env.DB.prepare("SELECT * FROM consolidation_scratchpad WHERE batch_id=?1 ORDER BY source_table, record_id ASC").bind(batchId).all();
  }
  return await env.DB.prepare("SELECT * FROM consolidation_scratchpad ORDER BY source_table, record_id ASC").all();
}

export async function clearScratchpad(env) {
  await env.DB.prepare("DELETE FROM consolidation_scratchpad").run();
}

// Extract notable events from scratchpad rows → [{ date, topic, status, details }]
function extractEvents(rows) {
  const events = [];
  const seen = new Set();

  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.content); } catch { continue; }
    if (!data) continue;

    const date = (data.created_at || data.collected_at || row.collected_at || "").slice(0, 10);
    if (!date) continue;

    if (row.source_table === 'actions') {
      const task = (data.task || data.type || data.input || "").slice(0, 120);
      if (!task || task.length < 3) continue;
      const dedup = date + "|action|" + task.slice(0, 50);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let status = "ongoing";
      let details = "";
      if (data.status === "completed" || data.status === "done") { status = "done"; details = "Completed successfully."; }
      else if (data.status === "error" || data.error) { status = "failed"; details = (data.error || "Hit an error.").slice(0, 120); }
      else if (data.status === "running" || data.status === "queued") { status = "ongoing"; details = "Still in progress."; }
      else { status = "done"; details = "Completed."; }
      const topic = task.length > 60 ? task.slice(0, 57) + "..." : task;
      events.push({ date, topic, status, details, source: "action" });

    } else if (row.source_table === 'activity_log') {
      const summary = (data.summary || data.event_type || data.tool_name || "").slice(0, 120);
      if (!summary || summary.length < 3) continue;
      const dedup = date + "|log|" + summary.slice(0, 50);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let status = "done";
      let details = summary;
      if (summary.toLowerCase().includes("error") || summary.toLowerCase().includes("fail")) {
        status = "failed"; details = "Hit an error: " + summary;
      }
      events.push({ date, topic: summary, status, details, source: "log" });

    } else if (row.source_table === 'brain_knowledge') {
      if ((data.category === "lesson" || data.category === "auto_learned") && data.content && data.content.length > 10) {
        const dedup = date + "|learn|" + data.content.slice(0, 50);
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        events.push({ date, topic: "Learned: " + data.key, status: "done", details: data.content.slice(0, 200), source: "knowledge" });
      }

    } else if (row.source_table === 'brain_agents') {
      const agent = data.name || data.instruction || "";
      if (!agent || agent.length < 3) continue;
      const dedup = date + "|agent|" + agent.slice(0, 50);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let status = "done", details = "Agent ran.";
      if (data.status === "error") { status = "failed"; details = "Agent hit an error."; }
      else if (data.status === "running") { status = "ongoing"; details = "Agent is still running."; }
      events.push({ date, topic: agent.slice(0, 80), status, details, source: "agent" });
    }
  }

  // Merge similar events in same hour window
  const merged = [];
  const byDate = {};
  for (const e of events) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  for (const date of Object.keys(byDate).sort()) {
    const dayEvents = byDate[date];
    // Group by status within same date
    const done = dayEvents.filter(e => e.status === "done");
    const failed = dayEvents.filter(e => e.status === "failed");
    const ongoing = dayEvents.filter(e => e.status === "ongoing");
    if (done.length) merged.push({ date, topic: done.map(e => e.topic).join("; "), status: "done", details: done.length + " tasks completed." });
    if (failed.length) merged.push({ date, topic: failed.map(e => e.topic).join("; "), status: "failed", details: failed.map(e => e.details).join(" | ") });
    if (ongoing.length) merged.push({ date, topic: ongoing.map(e => e.topic).join("; "), status: "ongoing", details: "Still in progress." });
  }

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

// Build memory pack from scratchpad — deterministic, no LLM
export async function buildMemoryPack(env) {
  await ensureScratchpadTable(env);
  const scratch = await getScratchpad(env);
  if (!scratch.results?.length) return { ok: false, reason: "no scratchpad data" };

  const events = extractEvents(scratch.results);
  if (!events.length) return { ok: false, reason: "no events extracted" };

  let lines = ["# What I Remember About Our Work\n"];
  const pending = [];

  for (const e of events) {
    let line;
    if (e.status === "done") {
      line = "- " + e.topic + " (" + e.date + "): We worked on this and it completed. " + e.details;
      if (e.details !== "Completed successfully." && e.details !== "Completed." && e.details !== "1 tasks completed.0 tasks completed.")
        line = "- " + e.topic + " (" + e.date + "): We finished this. " + e.details;
    } else if (e.status === "failed") {
      line = "- " + e.topic + " (" + e.date + "): That hit a problem. " + e.details;
    } else {
      line = "- " + e.topic + " (" + e.date + "): Still ongoing. " + e.details;
      pending.push(e);
    }
    lines.push(line);
  }

  if (pending.length) {
    lines.push("\n## What's Still Pending\n");
    lines.push("If someone asks me what's pending or what I need reminding of, these are the ongoing items. I should figure it out from my own memory, not query a database.");
    for (const e of pending) {
      lines.push("- " + e.topic + " (" + e.date + "): " + e.details);
    }
  }

  const content = lines.join("\n");

  try {
    await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('memory_pack_main', ?1, 'memory_pack', 'learned')").bind(content).run();
    try { await env.DB.prepare("INSERT OR REPLACE INTO knowledge_fts (key, content, category) VALUES ('memory_pack_main', ?1, 'memory_pack')").bind(content).run(); } catch {}
    return { ok: true, events: events.length, chars: content.length, preview: content.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
