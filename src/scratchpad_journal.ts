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
  date: string;
  narrative: string;
  topics: string[];
  status: string;
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
  if (t.includes("consolidate") || t.includes("scratchpad")) return "consolidation_pipeline";
  if (t.includes("image") && (t.includes("tool") || t.includes("generate"))) return "image_generation_tool";
  if (t.includes("weather")) return "weather";
  if (t.includes("pull request") || t.includes("pr ") || t.includes("github")) return "github_pr_ops";
  if (t.includes("memory_pack") || t.includes("memory pack") || t.includes("what i remember")) return "memory_pack";
  if (t.includes("journal")) return "journal";
  if (t.includes("build") || t.includes("deploy")) return "build_deploy";
  if (t.includes("knowledge") || t.includes("learn")) return "knowledge_management";
  return null;
}

function summarizeAction(c: any): string {
  const task = c.task || c.type || "";
  const input = (c.input || "").slice(0, 150);
  const result = (c.result || "").slice(0, 150);
  const error = c.error || "";
  if (error && error.length > 5) return `${task} failed: ${error.slice(0, 80)}`;
  if (result) return `${task}: ${input} \u2192 ${result}`;
  if (input) return `${task}: ${input}`;
  return task;
}

function summarizeKnowledge(c: any): string {
  return `${c.key || ""}: ${(c.content || "").slice(0, 200)}`;
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

function isGarbage(e: NormalizedEvent): boolean {
  const s = e.summary.trim().toLowerCase();
  if (s.length < 10) return true;
  if ((/^\d+$/).test(s) || (/^(yes|no|ok|okay|sure|fine|great|hello|hi|hey|thanks|thank you|nope|yep)$/i).test(s.trim())) return true;
  if (e.source_table === "activity_log") {
    if (s.includes("sensorium") || s.includes("energy check") || (e.event_type === "activity" && (s.includes("tick") || s.includes("idle")))) return true;
  }
  if (e.event_type === "action_failed") {
    if (s.includes("timeout") || s.includes("timed out") || s.includes("max steps") || s.includes("rate limit") || s.includes("connection error") || s.includes("stuck") || s.includes("auto-repaired") || s.includes("502") || s.includes("503") || s.includes("llm ")) return true;
  }
  if (e.source_table === "actions" && e.event_type === "action") {
    if (s.length > 0 && s.length < 15) return true;
    if (s.startsWith("ollama") || s.startsWith("model:")) return true;
  }
  return false;
}

function inferDayStatus(events: NormalizedEvent[]): string {
  let hasCompletion = false, hasBuild = false, hasFailure = false, hasPlan = false, onlyTalk = true;
  for (const e of events) {
    const s = e.summary.toLowerCase();
    if (e.event_type === "action_done") onlyTalk = false;
    if (s.includes("completed") || s.includes("finished") || s.includes("deployed")) hasCompletion = true;
    if (s.includes("created") || s.includes("implemented") || s.includes("built") || s.includes("wrote code")) hasBuild = true;
    if (s.includes("failed") || s.includes("error")) hasFailure = true;
    if (s.includes("plan") || s.includes("proposed") || s.includes("architecture")) hasPlan = true;
  }
  if (hasFailure && !hasCompletion && !hasBuild) return "rough";
  if (hasCompletion) return "productive";
  if (hasBuild) return "built";
  if (hasPlan && !onlyTalk) return "planned";
  if (onlyTalk && events.length <= 3) return "light";
  return "mixed";
}

function buildDayNarrative(events: NormalizedEvent[]): string {
  const learned: string[] = [];
  const convPhrases: string[] = [];
  const toolPhrases: string[] = [];
  const errorPhrases: string[] = [];

  const dedup = new Set<string>();

  for (const e of events) {
    const dk = e.source_table + ":" + e.source_record_id;
    if (dedup.has(dk)) continue;
    dedup.add(dk);

    if (e.event_type === "lesson" || e.event_type === "knowledge") {
      const key = e.details?.key || "";
      if (/checkpoint|identity_.*|personality|lesson_\d{4}|memory.?loop|\bstats[_\s\d]|[_.]rule\b/.test(key)) continue;
      const desc = (e.details?.content || e.summary).slice(0, 80).replace(/\s+/g, " ").trim();
      const label = key ? key.replace(/^(learned_|source_)/, "").replace(/_/g, " ") : desc.slice(0, 50);
      if (label.length > 8 && !learned.includes(label)) learned.push(label);
    } else if (e.event_type === "user_message") {
      let text = e.summary;
      const m = text.match(/^\[([^\]]+)\]\s*/);
      if (m) text = text.slice(m[0].length);
      const short = text.length > 100 ? text.slice(0, 100) + "..." : text;
      if (short.length > 15 && !convPhrases.some(p => short.includes(p.slice(0, 20)))) convPhrases.push(short);
    } else if (e.event_type === "action_done") {
      const task = (e.details?.task || e.details?.type || "").toLowerCase();
      if (!task || task === "chat" || task === "think") continue;
      const phrase = e.summary.slice(0, 80).replace(/\s+/g, " ").trim();
      if (phrase.startsWith("{") || /^(yes|no|i|we|here)[": ]/i.test(phrase)) continue;
      if (phrase.length > 10 && !toolPhrases.some(p => p.startsWith(task))) toolPhrases.push(phrase);
    } else if (e.event_type === "action_failed") {
      const task = (e.details?.task || e.details?.type || "").toLowerCase();
      if (task === "chat" || task === "think") continue;
      const phrase = e.summary.slice(0, 60);
      if (!errorPhrases.some(p => p.includes(phrase.split(":")[0]))) errorPhrases.push(phrase);
    }
  }

  const parts: string[] = [];
  if (learned.length) {
    const sample = learned.slice(0, 4).map(l => l.length > 50 ? l.slice(0, 50) + "..." : l);
    parts.push(`Learned about ${sample.join(", ")}${learned.length > 4 ? `, and ${learned.length - 4} more` : ""}.`);
  }
  if (convPhrases.length) {
    const sample = convPhrases.slice(0, 3).map(c => `"${c.length > 60 ? c.slice(0, 60) + "..." : c}"`);
    parts.push(`Discussed topics like ${sample.join(", ")}${convPhrases.length > 3 ? ` (${convPhrases.length} total)` : ""}.`);
  }
  if (toolPhrases.length) {
    const sample = toolPhrases.slice(0, 3).map(t => t.length > 60 ? t.slice(0, 60) + "..." : t);
    parts.push(`Tools used: ${sample.join("; ")}${toolPhrases.length > 3 ? ` (${toolPhrases.length} total)` : ""}.`);
  }
  if (errorPhrases.length) {
    parts.push(`Issues: ${errorPhrases.slice(0, 2).join("; ")}${errorPhrases.length > 2 ? ` (${errorPhrases.length} total)` : ""}.`);
  }
  return parts.join(" ");
}

export async function buildJournalEntries(events: NormalizedEvent[]): Promise<JournalEntry[]> {
  const filtered = events.filter(e => !isGarbage(e));
  const days = new Map<string, NormalizedEvent[]>();
  for (const e of filtered) {
    const day = e.ts.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(e);
  }

  const sortedDays = [...days.keys()].sort();
  const out: JournalEntry[] = [];

  for (const day of sortedDays) {
    const dayEvents = days.get(day)!.sort((a, b) => a.ts.localeCompare(b.ts));
    const topics = [...new Set(dayEvents.map(e => e.topic).filter(Boolean))] as string[];
    const status = inferDayStatus(dayEvents);
    const narrative = buildDayNarrative(dayEvents);
    if (!narrative.trim()) continue;
    out.push({
      date: day,
      narrative,
      topics: topics.length ? topics : ["general"],
      status,
      source_refs: dayEvents.map(e => `${e.source_table}:${e.source_record_id}`).filter(Boolean)
    });
  }
  return out;
}

export async function saveJournalToKnowledge(env: any, entries: JournalEntry[]) {
  await env.DB.prepare("DELETE FROM brain_knowledge WHERE category='journal'").run();
  const stmts: any[] = [];
  for (const entry of entries) {
    const key = `journal_${entry.date}`;
    stmts.push(env.DB.prepare(
      "INSERT INTO brain_knowledge (key, category, content) VALUES (?1, 'journal', ?2)"
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
  const journal = await buildJournalEntries(events);
  await saveJournalToKnowledge(env, journal);

  return {
    ok: true,
    raw_rows: rows.length,
    deduped_rows: deduped.length,
    event_count: events.length,
    journal_count: journal.length,
    journal_preview: journal.slice(-15).map(j => ({
      date: j.date, topics: j.topics, status: j.status,
      preview: j.narrative.slice(0, 150) + "..."
    }))
  };
}

function condenseEventsForLLM(filtered: NormalizedEvent[]): string {
  const days = new Map<string, string[]>();
  for (const e of filtered) {
    const day = e.ts.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    const time = e.ts.slice(11, 16);
    if (e.event_type === "user_message") {
      let text = e.summary;
      const m = text.match(/^\[([^\]]+)\]\s*/);
      if (m) text = text.slice(m[0].length);
      if (text.length > 150) text = text.slice(0, 150) + "...";
      days.get(day)!.push(`${time} User: ${text}`);
    } else if (e.event_type === "action_done") {
      const task = (e.details?.task || e.details?.type || "").toLowerCase();
      if (task && task !== "chat" && task !== "think") {
        const s = e.summary.slice(0, 80);
        if (!s.startsWith("{") && !/^(yes|no|i|we|here)[": ]/i.test(s)) days.get(day)!.push(`${time} Tool ${task}: ${s}`);
      }
    } else if (e.event_type === "lesson" || e.event_type === "knowledge") {
      const key = e.details?.key || "";
      if (!/checkpoint|identity|personality|lesson_\d{4}|memory.?loop|\bstats[_\s\d]|[_.]rule\b/.test(key)) {
        days.get(day)!.push(`${time} Learned: ${key.replace(/^(learned_|source_)/, "").replace(/_/g, " ").slice(0, 60)}`);
      }
    }
  }
  const out: string[] = [];
  for (const [day, evts] of [...days.entries()].sort()) {
    const sample = evts.length > 15 ? [...evts.slice(0, 8), "  ...", ...evts.slice(-5)] : evts;
    out.push(`--- ${day} ---\n` + sample.join("\n"));
  }
  return out.join("\n\n");
}

export async function buildMemoryPack(env: any) {
  const raw = await getScratchpad(env);
  const rows: ScratchpadRow[] = raw.results || raw || [];
  if (!rows.length) return { ok: false, reason: "no scratchpad data" };

  const deduped = dedupeRows(rows);
  const events = deduped.map(normalizeRow).filter(Boolean) as NormalizedEvent[];
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const filtered = events.filter(e => !isGarbage(e));
  if (!filtered.length) return { ok: false, reason: "nothing meaningful in scratchpad" };

  const condensed = condenseEventsForLLM(filtered);
  const prompt = `You are an AI assistant reflecting on your recent activity. Write a short memory summary in first person ("I"). Cover what you worked on, what you completed, what's still pending, and any problems. Keep it to 3-6 natural sentences, no bullet points.\n\n${condensed}\n\nWrite your memory summary now:`;

  let content = "";

  if (env.AI) {
    try {
      const result = await Promise.race([
        env.AI.run("@cf/zai-org/glm-4.7-flash", { messages: [{ role: "user", content: prompt }], max_tokens: 500 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))
      ]);
      const text = typeof result?.response === "string" ? result.response : (result?.choices?.[0]?.message?.content || "");
      if (text && text.trim().length > 20) content = text.trim();
    } catch {} // WA failed, fall through to template
  }

  if (!content) {
    const days = new Map<string, NormalizedEvent[]>();
    for (const e of filtered) {
      const day = e.ts.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(e);
    }
    const parts: string[] = [];
    for (const [day, dayEvents] of [...days.entries()].sort()) {
      const topics = [...new Set(dayEvents.map(e => e.topic).filter(Boolean))] as string[];
      const convMsgs = dayEvents.filter(e => e.event_type === "user_message");
      const tools = [...new Set(dayEvents.filter(e => e.event_type === "action_done").map(e => (e.details?.task || e.details?.type || "").toLowerCase()).filter(t => t && t !== "chat" && t !== "think"))];
      const learned = [...new Set(dayEvents.filter(e => e.event_type === "lesson" || e.event_type === "knowledge").map(e => e.details?.key || "").filter(k => !/checkpoint|identity|personality|lesson_\d{4}|memory.?loop|\bstats[_\s\d]|[_.]rule\b/.test(k)).map(k => k.replace(/^(learned_|source_)/, "").replace(/_/g, " ").slice(0, 40)))];
      const convSnippets = convMsgs.slice(0, 2).map(e => { let t = e.summary; const m = t.match(/^\[([^\]]+)\]\s*/); if (m) t = t.slice(m[0].length); return t.length > 60 ? t.slice(0, 60) + "..." : t; });
      const desc = [];
      if (topics.length) desc.push(`worked on ${topics.slice(0, 5).join(", ")}`);
      if (convMsgs.length) desc.push(`${convMsgs.length} conversations`);
      if (tools.length) desc.push(`${tools.length} tools used: ${tools.slice(0, 3).join(", ")}`);
      if (learned.length) desc.push(`learned: ${learned.slice(0, 3).join(", ")}`);
      parts.push(`${day}: ${desc.join("; ")}.`);
      if (convSnippets.length) parts.push(`  Asked about: ${convSnippets.join(" | ")}`);
    }
    content = "What I remember:\n" + parts.join("\n");
  }

  await env.DB.prepare("INSERT OR REPLACE INTO brain_knowledge (key, category, content) VALUES ('memory_pack_main', 'memory_pack', ?1)").bind(content).run();

  return { ok: true, generator: content.startsWith("Recent") ? "template" : "llm", preview: content.slice(0, 300) };
}
