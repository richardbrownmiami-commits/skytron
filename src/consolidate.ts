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
    return await env.DB.prepare("SELECT * FROM consolidation_scratchpad WHERE batch_id=?1 ORDER BY source_table, id ASC").bind(batchId).all();
  }
  const lastBatch = await env.DB.prepare("SELECT batch_id FROM consolidation_scratchpad ORDER BY id DESC LIMIT 1").first();
  if (!lastBatch) return { results: [] };
  return await env.DB.prepare("SELECT * FROM consolidation_scratchpad WHERE batch_id=?1 ORDER BY source_table, id ASC").bind(lastBatch.batch_id).all();
}

export async function clearScratchpad(env) {
  await env.DB.prepare("DELETE FROM consolidation_scratchpad").run();
}
