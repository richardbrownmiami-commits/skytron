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

  // Skip common noise patterns
  const NOISE_WORDS = new Set(["chat", "conversation", "default", "tick", "heartbeat", "status_check"]);

  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.content); } catch { continue; }
    if (!data) continue;

    const date = (data.created_at || data.collected_at || row.collected_at || "").slice(0, 10);
    if (!date) continue;

    if (row.source_table === 'actions') {
      const rawTask = (data.task || data.type || "").trim();
      // Skip noise
      if (!rawTask || rawTask.length < 3 || NOISE_WORDS.has(rawTask.toLowerCase())) continue;
      const input = (data.input || "").replace(/["']/g, "").slice(0, 80).trim();
      let topic = rawTask;
      if (input && input !== rawTask) topic = rawTask + (rawTask.length > 40 ? "" : (": " + input));
      const dedup = date + "|" + topic.slice(0, 60);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let status = "done", details = "";
      if (data.status === "error" || data.error) { status = "failed"; details = (data.error || "").slice(0, 100); }
      else if (data.status === "running" || data.status === "queued") { status = "ongoing"; details = "Still in progress."; }
      events.push({ date, topic: topic.slice(0, 70), status, details, sortKey: date + "_" + (data.id || 0) });

    } else if (row.source_table === 'activity_log') {
      const summary = (data.summary || data.event_type || data.tool_name || "").trim();
      if (!summary || summary.length < 5 || NOISE_WORDS.has(summary.toLowerCase().split(" ")[0])) continue;
      const dedup = date + "|log|" + summary.slice(0, 60);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const isError = summary.toLowerCase().includes("error") || summary.toLowerCase().includes("fail");
      events.push({
        date, topic: summary.slice(0, 70),
        status: isError ? "failed" : "done",
        details: isError ? "Hit an error." : "",
        sortKey: date + "_" + (data.id || 0)
      });

    } else if (row.source_table === 'brain_knowledge') {
      if ((data.category === "lesson" || data.category === "auto_learned") && data.content && data.content.length > 20) {
        const dedup = date + "|learn|" + data.key;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        events.push({
          date, topic: "Learned: " + data.key, status: "done", details: "",
          sortKey: date + "_" + (data.id || 0)
        });
      }
    }
  }

  // Sort by date then id
  events.sort((a, b) => (a.sortKey || a.date).localeCompare(b.sortKey || b.date));

  // Keep last 15, merge same-date same-status into one line
  const recent = events.slice(-15);
  const merged = [];
  const groups = {};
  for (const e of recent) {
    const key = e.date + "|" + e.status;
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  for (const key of Object.keys(groups).sort()) {
    const list = groups[key];
    const e = list[0];
    const topics = list.map(x => x.topic);
    // If 3+ similar items on same date, summarize
    const topic = topics.length > 2 ? topics[0] + " (+" + (topics.length - 1) + " more)" : topics.join("; ");
    merged.push({ date: e.date, topic: topic.slice(0, 90), status: e.status, details: e.details });
  }

  return merged;
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
    if (e.status === "failed") {
      line = "- " + e.topic + " (" + e.date + "): " + (e.details || "Didn't go right.");
    } else if (e.status === "ongoing") {
      line = "- " + e.topic + " (" + e.date + "): Still ongoing.";
      pending.push(e);
    } else {
      line = "- " + e.topic + " (" + e.date + "): Done.";
    }
    lines.push(line);
  }

  if (pending.length) {
    lines.push("\n## What's Still Pending\n");
    lines.push("If someone asks me what's pending, these are the ongoing items.");
    for (const e of pending) {
      lines.push("- " + e.topic + " (" + e.date + "): Not finished yet.");
    }
  }

  const content = lines.join("\n");

  try {
    await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES ('memory_pack_auto', ?1, 'memory_pack', 'learned')").bind(content).run();
    try { await env.DB.prepare("INSERT OR REPLACE INTO knowledge_fts (key, content, category) VALUES ('memory_pack_auto', ?1, 'memory_pack')").bind(content).run(); } catch {}
    return { ok: true, key_used: "memory_pack_auto", events: events.length, chars: content.length, preview: content.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
