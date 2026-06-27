import { initSchema } from './db';
import { processOneStep, processOneAgentStep } from './agents';

export async function handleScheduled(controller, env) {
  try { await initSchema(env.DB, env); } catch {}
  try {
    const r = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='queued' ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
    if (r.results?.length) {
      await processOneStep(env, r.results[0]);
    } else {
      const s = await env.DB.prepare("UPDATE actions SET status='running' WHERE status='running' AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT 1 RETURNING *").all();
      if (s.results?.length) await processOneStep(env, s.results[0]);
    }
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NOT NULL AND updated_at < datetime('now', '-2 minutes')").run();
    await env.DB.prepare("UPDATE brain_agents SET status='queued', updated_at=datetime('now') WHERE status='running' AND updated_at IS NULL AND created_at < datetime('now', '-2 minutes')").run();
    const ar = await env.DB.prepare("SELECT * FROM brain_agents WHERE status='queued' ORDER BY created_at ASC LIMIT 1").all();
    if (ar.results?.length) {
      await processOneAgentStep(env, ar.results[0]);
    }
  } catch (e) { console.error("cron error:", e); }
  try {
    const lastClean = await env.DB.prepare("SELECT value FROM identity WHERE key='last_cleanup_date'").all();
    const today = new Date().toISOString().split("T")[0];
    if (lastClean.results?.[0]?.value !== today) {
      const deleted = await env.DB.prepare("DELETE FROM brain_memory WHERE id NOT IN (SELECT id FROM brain_memory ORDER BY id DESC LIMIT 200) AND created_at < datetime('now', '-7 days')").run();
      const logTrim = await env.DB.prepare("DELETE FROM brain_logs WHERE id NOT IN (SELECT id FROM brain_logs ORDER BY id DESC LIMIT 1000)").run();
      const actTrim = await env.DB.prepare("DELETE FROM actions WHERE status='done' AND id NOT IN (SELECT id FROM actions WHERE status='done' ORDER BY id DESC LIMIT 500)").run();
      const agentTrim = await env.DB.prepare("DELETE FROM brain_agents WHERE status IN ('done','error') AND id NOT IN (SELECT id FROM brain_agents WHERE status IN ('done','error') ORDER BY id DESC LIMIT 50)").run();
      await env.DB.prepare("INSERT OR REPLACE INTO identity (key,value,updated_at) VALUES ('last_cleanup_date',?1,datetime('now'))").bind(today).run();
      console.error("Cleanup: removed " + (deleted.meta?.changes||0) + " old memories, " + (logTrim.meta?.changes||0) + " logs, " + (actTrim.meta?.changes||0) + " actions, " + (agentTrim.meta?.changes||0) + " agents");
    }
  } catch (e) { console.error("cleanup error:", e); }
}
