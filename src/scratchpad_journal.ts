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
  status: string;
  what_happened: string;
  confirmed_facts?: string;
  not_confirmed?: string;
  what_i_should_remember?: string;
  recall_response: string;
  tags: string[];
  incidents?: string[];
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

function isIncidentalFailureEvent(e: NormalizedEvent): boolean {
  const text = e.summary.toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("max steps reached") ||
    text.includes("rate limit") ||
    text.includes("temporary error") ||
    text.includes("network error") ||
    text.includes("search failed")
  );
}

function isHardFailureEvent(e: NormalizedEvent): boolean {
  const text = e.summary.toLowerCase();
  return (
    text.includes("could not complete the task") ||
    text.includes("failed to implement") ||
    text.includes("implementation failed") ||
    text.includes("deployment failed") ||
    text.includes("prompt_edit invalid input") ||
    text.includes("stuck in repair loop") ||
    text.includes("aborted without completing")
  );
}

function extractIncidents(group: NormalizedEvent[]): string[] {
  const incidents = new Set<string>();
  for (const e of group) {
    const text = e.summary.toLowerCase();
    if (text.includes("timeout") || text.includes("timed out")) incidents.add("timeout");
    if (text.includes("max steps reached")) incidents.add("max_steps");
    if (text.includes("invalid input")) incidents.add("invalid_input");
    if (text.includes("rate limit")) incidents.add("rate_limit");
    if (text.includes("network error")) incidents.add("network_error");
    if (text.includes("tool error")) incidents.add("tool_error");
  }
  return [...incidents];
}

function inferJournalStatus(group: NormalizedEvent[]): string {
  let score = { completed: 0, tested: 0, built: 0, planned: 0, discussed: 0, unfinished: 0, failed: 0 };

  for (const e of group) {
    const text = e.summary.toLowerCase();

    if (isHardFailureEvent(e)) score.failed += 4;
    if (isIncidentalFailureEvent(e)) score.unfinished += 1;

    if (text.includes("plan") || text.includes("proposed") || text.includes("architecture") || text.includes("design"))
      score.planned += 3;

    if (e.event_type === "user_message" || e.event_type === "assistant_message")
      score.discussed += 1;

    if (text.includes("created") || text.includes("implemented") || text.includes("added tool") || text.includes("opened pr") || text.includes("wrote code"))
      score.built += 4;

    if (text.includes("tested successfully") || text.includes("confirmed working"))
      score.tested += 4;

    if (text.includes("completed") || text.includes("done") || text.includes("finished"))
      score.completed += 3;

    if (text.includes("not tested") || text.includes("unfinished") || text.includes("moved on") || text.includes("never returned") || text.includes("not confirmed"))
      score.unfinished += 3;
  }

  const hasPositiveWork = score.completed > 0 || score.tested > 0 || score.built > 0 || score.planned > 0;
  if (score.failed >= 4 && !hasPositiveWork) return "failed";

  if (score.completed >= 3) return "completed";
  if (score.tested >= 4) return "tested";
  if (score.built >= 4) return score.unfinished >= 2 ? "unfinished" : "built";
  if (score.planned >= 3) return "planned";
  if (score.unfinished >= 3) return "unfinished";
  return "discussed";
}

function buildWhatHappened(group: NormalizedEvent[], topic: string): string {
  const h = humanizeTopic(topic);
  const text = group.map(g => g.summary).join("\n").toLowerCase();
  const messages = group.filter(g => g.event_type === "user_message" || g.event_type === "assistant_message");
  const actions = group.filter(g => g.event_type.startsWith("action_"));
  const hasPlan = text.includes("plan") || text.includes("architecture") || text.includes("design") || text.includes("proposed") || text.includes("step");
  const hasImplementation = text.includes("created") || text.includes("implemented") || text.includes("built") || text.includes("wrote code") || text.includes("tool");
  const hasError = text.includes("error") || text.includes("fail") || text.includes("timeout");
  const hasCompleted = text.includes("completed") || text.includes("done") || text.includes("finished");

  let narrative = `We worked on ${h}`;
  if (messages.length > 1) {
    const userMsgs = messages.filter(m => m.event_type === "user_message");
    if (userMsgs.length) narrative += `. The creator asked about ${h}`;
  }
  if (hasPlan && !hasImplementation) narrative += `. We discussed and planned the work, including architecture and design steps`;
  if (hasImplementation && hasCompleted) narrative += `. We built and completed the implementation`;
  if (hasImplementation && !hasCompleted) narrative += `. We created or built something for ${h}`;
  if (hasError) narrative += `. We encountered errors during the work`;
  if (actions.length >= 3) narrative += `, with ${actions.length} tool actions performed`;
  narrative += `.`;

  if (messages.length) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.event_type === "user_message" && lastMsg.summary.length < 200) {
      narrative += ` The creator's last message was: "${lastMsg.summary.slice(0, 150)}".`;
    }
  }

  return narrative;
}

function buildConfirmedFacts(group: NormalizedEvent[], status: string): string | undefined {
  const done = group.filter(g => g.event_type === "action_done");
  const parts: string[] = [];

  if (done.length) parts.push(`${done.length} tool action(s) were completed successfully`);
  const text = group.map(g => g.summary).join("\n").toLowerCase();
  if (text.includes("architecture") || text.includes("design")) parts.push("Architecture or design was produced");
  if (text.includes("plan")) parts.push("A plan or implementation steps were outlined");

  const userMsgs = group.filter(g => g.event_type === "user_message");
  const assistMsgs = group.filter(g => g.event_type === "assistant_message");
  if (userMsgs.length) parts.push(`The creator participated with ${userMsgs.length} message(s)`);
  if (assistMsgs.length) parts.push(`I responded with ${assistMsgs.length} message(s)`);

  const implementations = group.filter(g => g.summary.toLowerCase().includes("created") || g.summary.toLowerCase().includes("implemented"));
  if (implementations.length) parts.push(`Implementation work was done`);

  if (!parts.length) {
    if (status === "completed" || status === "tested") return "The work was completed successfully with confirmed results.";
    if (status === "built") return "Implementation was created.";
    if (status === "planned") return "A plan or design proposal was produced during discussion.";
    return undefined;
  }
  return parts.join(". ") + ".";
}

function buildNotConfirmed(group: NormalizedEvent[], status: string, incidents: string[]): string | undefined {
  if (status === "completed" || status === "tested") return undefined;

  const gapParts: string[] = [];
  const text = group.map(g => g.summary).join("\n").toLowerCase();
  const hasImplementation = text.includes("created") || text.includes("implemented") || text.includes("built") || text.includes("wrote");
  const hasTested = text.includes("tested") || text.includes("test ") || text.includes("working") || text.includes("confirmed");
  const hasPlan = text.includes("plan") || text.includes("architecture") || text.includes("design") || text.includes("proposed");
  const hasAction = group.some(g => g.event_type.startsWith("action_"));
  const hasMovedOn = text.includes("moved on") || text.includes("moved to");

  if (hasMovedOn) gapParts.push("The topic changed before reaching closure — we switched away before confirming completion");
  if (hasPlan && !hasImplementation) gapParts.push("No confirmed implementation — the work is still at planning stage");
  if (hasImplementation && !hasTested) gapParts.push("Implementation exists but there is no confirmed test result — I cannot safely claim it was tested successfully");
  if (!hasAction && hasPlan) gapParts.push("The discussion ended without actionable steps — no tool actions were performed");
  if (!gapParts.length && hasPlan) gapParts.push("No confirmed implementation or testing appears in this episode");
  if (!gapParts.length && status === "failed") gapParts.push("The task could not be completed successfully");
  if (!gapParts.length) gapParts.push("Work was left incomplete — I should not claim it was finished");

  if (incidents.length) {
    gapParts.push(`Incidents encountered: ${incidents.join(", ")}`);
  }

  return gapParts.join(". ") + ".";
}

function buildWhatIShouldRemember(group: NormalizedEvent[], topic: string, status: string): string {
  const h = humanizeTopic(topic);
  const text = group.map(g => g.summary).join("\n").toLowerCase();
  const hasError = text.includes("error") || text.includes("fail") || text.includes("timeout");

  const reasonParts: string[] = [`This entry about ${h} is important because`];
  const reasons: string[] = [];

  if (hasError) reasons.push("it shows a failure pattern or risk I should remember");
  if (status === "planned") reasons.push("it represents work that was designed but not yet realized — a future opportunity");
  if (status === "completed") reasons.push("it represents a successfully completed task I can reference");
  if (status === "built" || status === "unfinished") reasons.push("it represents work-in-progress that may need follow-up");
  if (status === "failed") reasons.push("it is a cautionary memory of something that didn't work");
  if (status === "discussed") reasons.push("it was discussed but never actioned — a potential gap");

  reasonParts.push(reasons.length ? reasons.join(", ") + ".");
  reasonParts.push(`I should remember what state ${h} was left in and avoid overclaiming completion unless I find later evidence.`);

  return reasonParts.join(" ");
}

function buildTags(topic: string, status: string): string[] {
  const tags = new Set<string>();
  tags.add(topic);
  tags.add(status);
  if (status === "planned") tags.add("not_tested");
  if (status === "built") tags.add("not_tested");
  if (status === "unfinished") tags.add("needs_followup");
  if (status === "failed") tags.add("caution");
  if (status === "discussed") tags.add("no_action");
  return [...tags];
}

function buildRecallResponse(input: { date: string; topic: string; status: string; nextTopic?: string }): string {
  const h = humanizeTopic(input.topic);
  const statusDesc: Record<string, string> = {
    discussed: "we discussed it but I have no confirmation it was built or actioned",
    planned: "we planned it in detail but it was not confirmed built or tested",
    built: "we built or created it but testing was not confirmed",
    tested: "we tested it and it was confirmed working",
    completed: "we finished this work",
    failed: "we attempted it but it failed or got stuck",
    unfinished: "we worked on it but left it incomplete",
  };

  const desc = statusDesc[input.status] || `the status is ${input.status}`;

  let response = `Yes. On ${input.date}, we worked on ${h}. From my current memory, ${desc}.`;
  if (input.nextTopic) {
    response += ` After that, we moved to ${humanizeTopic(input.nextTopic)}. I should note that we may not have returned to close the loop on ${h}.`;
  }
  response += ` I should treat this as ${input.status} work unless I find a later completion or test record.`;

  return response;
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
    const incidents = extractIncidents(group);
    const whatHappened = buildWhatHappened(group, topic);
    const confirmedFacts = buildConfirmedFacts(group, status);
    const notConfirmed = buildNotConfirmed(group, status, incidents);
    const whatIShouldRemember = buildWhatIShouldRemember(group, topic, status);
    const tags = buildTags(topic, status);
    const nextTopic = inferNextTopic(group, events);
    const recallResponse = buildRecallResponse({ date: first.ts.slice(0, 10), topic, status, nextTopic });
    const dateStr = first.ts.slice(0, 10) + (last.ts.slice(0, 10) !== first.ts.slice(0, 10) ? ` to ${last.ts.slice(0, 10)}` : "");
    const shortSummary = `${title} — ${status}. ${dateStr}.`;
    out.push({
      journal_key: `${first.ts.slice(0, 10)}:${topic}`,
      date_start: first.ts,
      date_end: last.ts,
      topic, title, status,
      summary: shortSummary,
      what_happened: whatHappened,
      confirmed_facts: confirmedFacts,
      not_confirmed: notConfirmed,
      what_i_should_remember: whatIShouldRemember,
      recall_response: recallResponse,
      tags,
      incidents: incidents.length ? incidents : undefined,
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
      key: j.journal_key, topic: j.topic, status: j.status, summary: j.recall_response.slice(0, 120)
    }))
  };
}
