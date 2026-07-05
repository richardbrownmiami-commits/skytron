import { getScratchpad } from "./consolidate";

type ScratchpadRow = {
  id: number;
  source_table: string;
  record_id: number | null;
  content: string;
  collected_at?: string;
  batch_id?: string;
};

type NormalizedEvent = {
  source_table: string;
  source_record_id: number | null;
  event_type: string;
  ts: string;
  conversation_id?: string | null;
  action_id?: number | null;
  topic?: string | null;
  summary: string;
  details: any;
};

type JournalEntry = {
  journal_key: string;
  date_start: string;
  date_end?: string;
  topic: string;
  title: string;
  summary: string;
  status: string;
  what_happened: string;
  completed?: string;
  unfinished?: string;
  next_topic?: string;
  source_refs: string[];
};

function parseJsonSafe(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function pickTs(obj: any, fallback?: string): string {
  return obj?.created_at || obj?.updated_at || fallback || new Date().toISOString().slice(0, 19).replace("T", " ");
}

function detectTopic(text: string): string | null {
  const t = (text || "").toLowerCase();
  if (t.includes("self-hosted memory") || t.includes("local_memory") || t.includes("self hosted memory")) return "self_hosted_memory";
  if (t.includes("prompt_edit")) return "prompt_edit";
  if (t.includes("activity_log") || t.includes("activity log")) return "activity_log_inspection";
  if (t.includes("consolidate") || t.includes("scratchpad")) return "consolidation_pipeline";
  if (t.includes("image") && (t.includes("tool") || t.includes("generate"))) return "image_generation_tool";
  if (t.includes("weather")) return "weather";
  if (t.includes("pull request") || t.includes("pr ") || t.includes("github")) return "github_pr_ops";
  if (t.includes("source code") || t.includes("routes.ts") || t.includes("db.ts") || t.includes("source_")) return "source_ingestion";
  if (t.includes("memory_pack") || t.includes("memory pack") || t.includes("what i remember")) return "memory_pack";
  if (t.includes("journal")) return "journal";
  if (t.includes("hello world")) return "hello_world_tool";
  if (t.includes("build") || t.includes("deploy")) return "build_deploy";
  if (t.includes("knowledge") || t.includes("learn")) return "knowledge_management";
  return null;
}

function summarizeAction(c: any): string {
  const task = c.task || c.type || "";
  const input = (c.input || "").slice(0, 80);
  const result = (c.result || "").slice(0, 80);
  if (result) return `${task}: ${input} → ${result}`;
  if (input) return `${task}: ${input}`;
  return task;
}

function summarizeKnowledge(c: any): string {
  return `${c.key || ""}: ${(c.content || "").slice(0, 150)}`;
}

export function dedupeRows(rows: ScratchpadRow[]): ScratchpadRow[] {
  const map = new Map<string, ScratchpadRow>();
  for (const row of rows) {
    const key = `${row.source_table}:${row.record_id ?? "null"}`;
    const existing = map.get(key);
    if (!existing) { map.set(key, row); continue; }
    const oldTs = existing.collected_at || "";
    const newTs = row.collected_at || "";
    if (newTs > oldTs) map.set(key, row);
  }
  return [...map.values()];
}

export function normalizeRow(row: ScratchpadRow): NormalizedEvent | null {
  const c = parseJsonSafe(row.content);
  if (!c) return null;
  const ts = pickTs(c, row.collected_at);

  if (row.source_table === "brain_memory") {
    const role = c.role || "unknown";
    const text = String(c.content || "");
    if (!text || text.length < 5) return null;
    return {
      source_table: row.source_table,
      source_record_id: row.record_id,
      event_type: role === "user" ? "user_message" : "assistant_message",
      ts, conversation_id: c.conversation_id || null,
      topic: detectTopic(text),
      summary: text.slice(0, 500),
      details: c
    };
  }

  if (row.source_table === "actions") {
    const task = c.task || c.type || "";
    if (!task || task.length < 3) return null;
    return {
      source_table: row.source_table,
      source_record_id: row.record_id,
      event_type: c.status === "error" ? "action_failed" : c.status === "completed" || c.status === "done" ? "action_done" : "action",
      ts, action_id: c.id || null,
      topic: detectTopic(`${c.input || ""} ${task} ${c.result || ""} ${c.error || ""}`),
      summary: summarizeAction(c),
      details: c
    };
  }

  if (row.source_table === "activity_log") {
    const summary = c.summary || c.event_type || "";
    if (!summary || summary.length < 5) return null;
    return {
      source_table: row.source_table,
      source_record_id: row.record_id,
      event_type: c.event_type || "activity",
      ts, action_id: c.action_id || null,
      topic: detectTopic(`${summary} ${c.details || ""}`),
      summary: summary.slice(0, 300),
      details: c
    };
  }

  if (row.source_table === "brain_knowledge") {
    const key = c.key || "";
    const category = c.category || "";
    if (key.startsWith("source_") || category === "backup") return null;
    return {
      source_table: row.source_table,
      source_record_id: row.record_id,
      event_type: category === "lesson" ? "lesson" : category === "journal" ? "journal_entry" : "knowledge",
      ts,
      topic: detectTopic(`${key} ${c.content || ""}`),
      summary: summarizeKnowledge(c),
      details: c
    };
  }

  return null;
}

function humanizeTopic(topic: string): string {
  return topic.replace(/_/g, " ");
}

function inferGroupTopic(group: NormalizedEvent[]): string {
  const topics = group.map(g => g.topic).filter(Boolean) as string[];
  if (topics.length) {
    const freq: Record<string, number> = {};
    for (const t of topics) { freq[t] = (freq[t] || 0) + 1; }
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  }
  return "misc";
}

function makeTitle(topic: string): string {
  return humanizeTopic(topic).replace(/\b\w/g, c => c.toUpperCase());
}

function inferJournalStatus(group: NormalizedEvent[]): string {
  const text = group.map(g => `${g.summary} ${JSON.stringify(g.details)}`).join("\n").toLowerCase();
  const hasUser = group.some(g => g.event_type === "user_message");
  const hasAction = group.some(g => g.event_type.startsWith("action_"));
  const hasError = group.some(g => g.event_type === "action_failed") || text.includes("error") || text.includes("fail");
  const hasCompleted = group.some(g => g.event_type === "action_done") || text.includes("completed") || text.includes("done");
  const hasTested = text.includes("tested") || text.includes("test ") || text.includes("working");
  const hasNextTopic = text.includes("moved on") || text.includes("moved to") || text.includes("switched to");
  const hasPlan = text.includes("plan") || text.includes("proposed") || text.includes("step") || text.includes("todo");

  if (hasError) return "failed";
  if (hasPlan && !hasAction) return "planned";
  if (hasCompleted && hasTested) return "completed";
  if (hasCompleted && !hasTested) return "unfinished";
  if (hasNextTopic) return "unfinished";
  if (hasUser && !hasAction) return "discussed";
  return "ongoing";
}

function buildWhatHappened(group: NormalizedEvent[], topic: string): string {
  const main = group.filter(g => g.event_type !== "journal_entry" && g.event_type !== "knowledge");
  if (!main.length) return `We had activity related to ${humanizeTopic(topic)}.`;
  const desc = main.slice(0, 3).map(g => {
    if (g.event_type === "action_done") return `completed ${g.summary}`;
    if (g.event_type === "action_failed") return `tried ${g.summary} but hit an error`;
    if (g.event_type === "user_message") return `user said: ${g.summary.slice(0, 100)}`;
    if (g.event_type === "assistant_message") return `I responded about ${g.topic || "it"}`;
    return g.summary.slice(0, 100);
  }).join(". ");
  return `${humanizeTopic(topic)}: ${desc}.`;
}

function buildCompleted(group: NormalizedEvent[], status: string): string | undefined {
  if (status === "completed") {
    const done = group.filter(g => g.event_type === "action_done" || g.event_type === "assistant_message");
    if (done.length) return `${done.length} action(s) completed.`;
    return "Work appeared to complete successfully.";
  }
  if (status === "unfinished" || status === "failed") {
    const done = group.filter(g => g.event_type === "action_done");
    if (done.length) return `${done.length} action(s) completed before interruption.`;
  }
  return undefined;
}

function buildUnfinished(group: NormalizedEvent[], status: string): string | undefined {
  if (status === "unfinished" || status === "failed" || status === "planned" || status === "discussed") {
    const failed = group.find(g => g.event_type === "action_failed");
    if (failed) return `Hit an error: ${failed.summary.slice(0, 120)}`;
    if (!group.some(g => g.event_type.startsWith("action_"))) return "No confirmed action completed.";
    if (!group.some(g => g.summary.toLowerCase().includes("test"))) return "No confirmed test result in memory.";
    return "Work was left incomplete.";
  }
  return undefined;
}

function inferNextTopic(group: NormalizedEvent[], allEvents: NormalizedEvent[]): string | undefined {
  const last = group[group.length - 1];
  const idx = allEvents.indexOf(last);
  if (idx >= 0 && idx < allEvents.length - 1) {
    const next = allEvents[idx + 1];
    if (next.topic && next.topic !== group[0]?.topic) return next.topic;
  }
  return undefined;
}

function buildJournalSummary(input: { date: string; topic: string; status: string; whatHappened: string; completed?: string; unfinished?: string; nextTopic?: string }): string {
  const parts: string[] = [
    `On ${input.date}, we worked on ${humanizeTopic(input.topic)}.`,
    input.whatHappened
  ];
  if (input.completed) parts.push(`Completed: ${input.completed}.`);
  if (input.unfinished) parts.push(`Unfinished / uncertain: ${input.unfinished}.`);
  if (input.nextTopic) parts.push(`After that, we moved to ${humanizeTopic(input.nextTopic)}.`);
  parts.push(`Current memory status: ${input.status}.`);
  return parts.join(" ");
}

export function buildJournalEntries(events: NormalizedEvent[]): JournalEntry[] {
  const groups = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    const key = e.topic ? `${day}:${e.topic}` : e.conversation_id ? `${day}:conv:${e.conversation_id}` : e.action_id ? `${day}:action:${e.action_id}` : `${day}:misc`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const out: JournalEntry[] = [];
  for (const [groupKey, group] of groups) {
    group.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = group[0];
    const last = group[group.length - 1];
    const topic = first.topic || inferGroupTopic(group) || "misc";
    const title = makeTitle(topic);
    const status = inferJournalStatus(group);
    const whatHappened = buildWhatHappened(group, topic);
    const completed = buildCompleted(group, status);
    const unfinished = buildUnfinished(group, status);
    const nextTopic = inferNextTopic(group, events);
    const summary = buildJournalSummary({ date: first.ts.slice(0, 10), topic, status, whatHappened, completed, unfinished, nextTopic });
    out.push({
      journal_key: `${first.ts.slice(0, 10)}:${topic}`,
      date_start: first.ts,
      date_end: last.ts,
      topic, title, summary, status,
      what_happened: whatHappened,
      completed, unfinished,
      next_topic: nextTopic,
      source_refs: group.map(g => `${g.source_table}:${g.source_record_id}`).filter(Boolean)
    });
  }

  return out.sort((a, b) => a.date_start.localeCompare(b.date_start));
}

export async function saveJournalToKnowledge(env: any, entries: JournalEntry[]) {
  const stmts: any[] = [];
  for (const entry of entries) {
    const key = `journal_${entry.date_start.slice(0, 10)}_${entry.topic}`;
    stmts.push(env.DB.prepare(
      "INSERT OR REPLACE INTO brain_knowledge (key, category, content) VALUES (?1, 'journal', ?2)"
    ).bind(key, JSON.stringify(entry)));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

export async function buildScratchpadJournal(env: any) {
  const raw = await getScratchpad(env);
  const rows: ScratchpadRow[] = raw.results || raw || [];
  if (!rows.length) return { ok: false, reason: "no scratchpad data" };

  const deduped = dedupeRows(rows);
  const events = deduped.map(normalizeRow).filter(Boolean) as NormalizedEvent[];
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const journal = buildJournalEntries(events);
  await saveJournalToKnowledge(env, journal);

  return {
    ok: true,
    raw_rows: rows.length,
    deduped_rows: deduped.length,
    event_count: events.length,
    journal_count: journal.length,
    journal_preview: journal.slice(0, 20).map(j => ({
      key: j.journal_key, topic: j.topic, status: j.status, summary: j.summary.slice(0, 120)
    }))
  };
}
