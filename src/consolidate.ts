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

// === Phase 2: Garbage Cleaning ===

const CLEANED_DDL = `CREATE TABLE IF NOT EXISTS cleaned_scratchpad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  record_id INTEGER,
  content TEXT NOT NULL,
  collected_at TEXT DEFAULT (datetime('now')),
  classification TEXT NOT NULL,
  reason TEXT
)`;

const GREET_PATTERN = /^(hello|hi|hey|howdy|greetings|yo)\b/i;

function classifyRow(table, content) {
  let c;
  try { c = JSON.parse(content); } catch { return { cls: 'keep', reason: '' }; }

  const ts = (c.created_at || c.updated_at || '').replace('T', ' ').slice(0, 19);
  const date = ts.slice(0, 10); // YYYY-MM-DD

  // --- sensorium (actions with [SENSORIUM] in input) ---
  if (table === 'actions' && (c.input || '').includes('[SENSORIUM]')) {
    return { cls: 'sensorium', reason: 'sensorium tick noise' };
  }

  // --- empty rows ---
  if (table === 'actions' && !c.input && !c.result && !c.error) {
    return { cls: 'empty', reason: 'empty action row' };
  }
  if (table === 'brain_memory' && !c.content) {
    return { cls: 'empty', reason: 'empty memory row' };
  }
  if (table === 'identity' && !c.value) {
    return { cls: 'empty', reason: 'empty identity row' };
  }

  // --- tool JSON blobs (activity_log entries that are just raw tool JSON) ---
  if (table === 'activity_log') {
    const isJsonBlob = (
      (c.event_type === 'tool_call' || c.event_type === 'tool_result' || c.event_type === 'llm_output' || c.event_type === 'llm_call') &&
      (!c.summary || c.summary.length < 15)
    );
    if (isJsonBlob) {
      return { cls: 'tool_json', reason: 'raw tool JSON blob' };
    }
  }

  // --- failed actions ---
  if (table === 'actions' && (c.status === 'error' || c.error)) {
    const reason = (c.error || c.result || 'unknown error').slice(0, 200);
    return { cls: 'failure', reason };
  }

  return { cls: 'keep', reason: '' };
}

export async function ensureCleanedTable(env) {
  await env.DB.prepare(CLEANED_DDL).run();
}

export async function cleanScratchpad(env) {
  await ensureCleanedTable(env);
  const all = await env.DB.prepare("SELECT * FROM consolidation_scratchpad ORDER BY source_table, record_id ASC").all();
  if (!all.results?.length) return { total: 0, classified: {} };

  const seen = {}; // dedup key: table+date+minute+contentHash
  const greetSeen = {}; // greetings per day: table+date
  const counts = { keep: 0, sensorium: 0, greeting: 0, failure: 0, tool_json: 0, duplicate: 0, empty: 0 };
  const batch = [];
  const toDelete = [];

  for (const row of all.results) {
    let c;
    try { c = JSON.parse(row.content); } catch { c = { content: row.content }; }

    const ts = (c.created_at || c.updated_at || row.collected_at || '').replace('T', ' ').slice(0, 19);
    const date = ts.slice(0, 10);
    const minuteKey = ts.slice(0, 16); // YYYY-MM-DD HH:MM (minute-level)

    let cls = 'keep';
    let reason = '';

    // 1) Classify
    const classified = classifyRow(row.source_table, row.content);
    cls = classified.cls;
    reason = classified.reason;

    // 2) Greeting detection (overrides classifyRow for brain_memory/actions)
    if (cls === 'keep' || cls === 'failure') {
      let text = '';
      if (row.source_table === 'brain_memory') text = c.content || '';
      else if (row.source_table === 'actions') text = c.input || '';
      if (text && GREET_PATTERN.test(text.trim())) {
        const greetKey = row.source_table + '|' + date;
        if (greetSeen[greetKey]) {
          cls = 'duplicate';
          reason = 'duplicate greeting (1/day)';
        } else {
          cls = 'greeting';
          reason = 'first greeting of ' + date;
          greetSeen[greetKey] = true;
        }
      }
    }

    // 3) Minute-level dedup for non-greeting, non-failure keeps
    if (cls === 'keep' && row.source_table !== 'brain_vectors' && row.source_table !== 'identity') {
      const contentSnippet = JSON.stringify(c).slice(0, 100);
      const dedupKey = row.source_table + '|' + minuteKey + '|' + contentSnippet;
      if (seen[dedupKey]) {
        cls = 'duplicate';
        reason = 'same-minute duplicate';
      }
      seen[dedupKey] = true;
    }

    counts[cls] = (counts[cls] || 0) + 1;
    batch.push(env.DB.prepare(
      "INSERT INTO cleaned_scratchpad (source_table, record_id, content, classification, reason) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(row.source_table, row.record_id, row.content, cls, reason));
  }

  // Batch insert cleaned rows
  if (batch.length > 0) {
    // Insert in chunks of 100 to avoid D1 limits
    for (let i = 0; i < batch.length; i += 100) {
      await env.DB.batch(batch.slice(i, i + 100));
    }
  }

  return { total: all.results.length, classified: counts };
}

export async function getCleaned(env, classification = null) {
  await ensureCleanedTable(env);
  if (classification) {
    return await env.DB.prepare("SELECT * FROM cleaned_scratchpad WHERE classification=?1 ORDER BY source_table, record_id ASC").bind(classification).all();
  }
  return await env.DB.prepare("SELECT * FROM cleaned_scratchpad ORDER BY source_table, record_id ASC").all();
}

export async function clearCleaned(env) {
  await env.DB.prepare("DELETE FROM cleaned_scratchpad").run();
}
