// === Skytron Agents (CORE LOOP) ===
// This is where Skytron "thinks". processOneStep is called per action per cron tick.
// Flow: load agent state → callLLM → tryParseToolCall → dispatchTool → repeat or finalize
// - tryParseToolCall handles: {"tool":"name","arguments":{...}}, {"tool":"name","input":{...}}, OpenAI [{type:"function"...}], TOOL:name() format
// - cleanseIdentity() strips "As an AI..." patterns from final responses
// - Self-healing: tool errors trigger REFLECTION CHECKPOINT + learn() auto-stores lessons
// - processOneAgentStep: sub-agents with limited tools, max 8 steps
// DO NOT modify the tool dispatch flow unless you understand the full pipeline.
// If adding new tool formats to tryParseToolCall, update the regex + tests.
import { callLLM, callChatAgent, parseLLMJson } from './llm';
import { dispatchTool, listTools, toolDefinitions } from './tools';
import { storeMemory, saveAgentState, loadAgentState, deleteAgentState, logActivity } from './db';
export async function processOneStep(env, action) {
  const db = env.DB;
  const state = await loadAgentState(db, action.id);
  if (!state) { await db.prepare("UPDATE actions SET status='error', error='missing state' WHERE id=?1").bind(action.id).run(); return; }

  if (state.done) { await finalizeAction(db, action.id, state); return; }

  // === Mode-based routing ===
  const mode = state.mode || "discussion";
  const lastUserMsg = state.fullHistory[state.fullHistory.length - 1]?.content || "";
  const isCodingTask = action.task === "coding" || action.task === "research";

  // DISCUSSION MODE: Force fast LLM call (BUDDHI_DWAR auto-selects best provider, no tools, fast 3-8s)
  if (mode === "discussion") {
    // Let BUDDHI_DWAR auto-select the fastest provider (no model specified)
    const chatResp = await callLLM(env, { messages: state.fullHistory, max_tokens: 1500, task: "chat" }, "skytron-" + state.conversationId);
    if (chatResp?.content) {
      const cleaned = cleanseIdentity(chatResp.content);
      state.finalContent = cleaned;
      state.modelName = chatResp.model;
      state.totalTokens += chatResp.tokens?.total || 0;
      state.done = true;
      logActivity(db, "chat_agent", { actionId: action.id, summary: "Discussion mode — " + (chatResp.model || "?"), details: cleaned.slice(0, 500) });
      await saveAgentState(db, action.id, state);
      await finalizeAction(db, action.id, state);
      return;
    }
    // Chat Agent failed — respond with "enable build mode" message
    state.finalContent = "I need tools for this. Enable Build mode to continue.";
    state.done = true;
    logActivity(db, "chat_agent", { actionId: action.id, summary: "Discussion mode — tools needed", details: "Chat Agent failed, suggesting Build mode" });
    await saveAgentState(db, action.id, state);
    await finalizeAction(db, action.id, state);
    return;
  }

  // ASTRAL WALK MODE: One step per tick, never stops
  if (mode === "astral") {
    const chatResp = await callLLM(env, { messages: state.fullHistory, task: "chat" }, "skytron-astral");
    if (chatResp?.content) {
      const trimmed = chatResp.content.trim();
      state.modelName = chatResp.model;
      state.totalTokens += chatResp.tokens?.total || 0;
      let parsed = tryParseToolCall(trimmed);
      state.fullHistory.push({ role: "assistant", content: trimmed });
      let parsed = tryParseToolCall(trimmed);
      if (parsed) {
        const result = await dispatchTool(env, parsed.tool, parsed.arguments || parsed.input, action.id);
        if (result !== null) {
          state.fullHistory.push({ role: "user", content: "[TOOL RESULT: " + result.slice(0, 3000) + "]" });
        } else {
          state.fullHistory.push({ role: "user", content: "[TOOL ERROR: unknown tool]" });
        }
      }
      state.step++;
    }
    // Never done — save state and re-queue for next tick
    state.done = false;
    await saveAgentState(db, action.id, state);
    await db.prepare("UPDATE actions SET status='queued' WHERE id=?1").bind(action.id).run();
    return;
  }

  // BUILD MODE: Full Tool Agent (tools, multi-step, 20-60s)
  // Skip classifyIntent — always use tools

  const startTime = Date.now();
  const MAX_BATCH_MS = 60000;
  let codingModel = action.task === "coding" ? "deepseek-v4-flash-free" : "";

  while (!state.done && state.step < 25 && (Date.now() - startTime) < MAX_BATCH_MS) {
    let resp, content;
    let lastErrors = [];
    for (let retry = 0; retry < (codingModel ? 3 : 1); retry++) {
      if (retry > 0) await new Promise(r => setTimeout(r, 1000 * retry));
      const reqBody = { messages: state.fullHistory, task: action.task || "chat" };
      if (codingModel) reqBody.model = codingModel;
      const chatId = "skytron-" + state.conversationId;
      logActivity(db, "llm_call", { actionId: action.id, summary: "LLM call — step " + state.step + ", model: pending", details: "messages: " + (reqBody.messages?.length || 0) + ", task: " + (action.task || "chat") });
      resp = await callLLM(env, reqBody, chatId);
      if (!resp) continue;
      if (!resp.content && resp.errors) {
        lastErrors = resp.errors;
        if (codingModel) { codingModel = ""; retry--; continue; }
      }
      content = resp.content;
      if (typeof content === "string") break;
    }
    if (!resp || typeof content !== "string") {
      const errorSummary = lastErrors.length ? lastErrors.join("; ") : "all providers unreachable";
      logActivity(db, "provider_fail", { actionId: action.id, summary: "Provider fail: " + errorSummary.slice(0, 100), details: errorSummary });
      try { await db.prepare("INSERT INTO brain_logs (action_id, step, content, model) VALUES (?1, ?2, ?3, ?4)").bind(action.id, "provider_fail", "Both providers failed: " + errorSummary.slice(0, 200), "error").run(); } catch {}
      state.finalContent = "I'm having trouble connecting (" + errorSummary.slice(0, 100) + "). Please try again later."; state.done = true;
      break;
    }
    state.modelName = resp.model;
    logActivity(db, "llm_call", { actionId: action.id, summary: "LLM output — step " + state.step + ", model: " + (resp.model || "?") + ", tokens: " + (resp.tokens?.total || 0), details: content.slice(0, 1000) });
    logActivity(db, "thought", { actionId: action.id, summary: (action.task || "chat") + " — step " + state.step, details: content.slice(0, 1000) });
    try { await db.prepare("INSERT INTO brain_logs (action_id, step, content, model, tokens) VALUES (?1, ?2, ?3, ?4, ?5)").bind(action.id, "step_" + state.step, content.slice(0, 4000), state.modelName, resp.tokens?.total || 0).run(); } catch {}

    const trimmed = content.trim();
    let parsed = tryParseToolCall(trimmed);
    const repromptCount = state.repromptCount || 0;
    const analysisPattern = /^(the user (is|wants|asked|says|keeps)|looking at|from the conversation|based on my|according to|i should|let me|in the conversation|so (the|what)|this (is about|appears|seems)|the conversation)/i;
    if (!parsed && !trimmed.includes('"tool":') && analysisPattern.test(trimmed) && trimmed.length > 80 && !Object.keys(toolDefinitions).some(t => new RegExp("\\b" + t.replace(/_/g, "\\w*") + "\\b", "i").test(trimmed))) {
      content = "I'm looking into that now.";
      state.finalContent = content; state.done = true;
      state.totalTokens += resp.tokens?.total || 0;
      await finalizeAction(db, action.id, state); return;
    }
    if (!parsed && repromptCount < 2 && /\b(?:can't|cannot|don't have the ability|unable to|not able to|not programmed to)[\s\S]{0,30}(?:add|create|make|write|modify|change|edit|implement)[\s\S]{0,30}(?:tools?|features?|commands?|capabilities?|programming|source code|source (?:code|files)|itself|myself)/i.test(trimmed)) {
      state.repromptCount = repromptCount + 1;
      state.fullHistory.push({ role: "assistant", content: trimmed.slice(0, 200) + "..." });
      state.fullHistory.push({ role: "user", content: "[CONTRADICTION] You have the create_tool tool. Output EXACTLY: {\"tool\":\"create_tool\",\"input\":{\"repo\":\"richardbrownmiami-commits/skytron\",\"name\":\"...\",\"description\":\"...\",\"paramsSchema\":\"z.object({...})\",\"executeCode\":\"...\"}}" });
      await saveAgentState(db, action.id, state);
      await db.prepare("UPDATE actions SET status='queued' WHERE id=?1").bind(action.id).run();
      return;
    }
    if (!parsed && repromptCount < 2 && (trimmed.includes('"tool":') || Object.keys(toolDefinitions).some(t => { var lc = trimmed.toLowerCase(); var tn = t.toLowerCase(); return lc.includes('"' + tn + '"') || lc.includes("use " + tn) || lc.includes("use the " + tn) || lc.includes("using " + tn) || lc.includes("- " + tn) || lc.includes(tn + ":"); }))) {
      state.repromptCount = repromptCount + 1;
      const extracted = extractToolFromPlan(trimmed);
      if (extracted) {
        parsed = extracted;
        state.fullHistory.push({ role: "assistant", content: JSON.stringify(extracted) });
      } else {
        state.fullHistory.push({ role: "assistant", content: trimmed.slice(0, 200) + "..." });
        state.fullHistory.push({ role: "user", content: "[SYSTEM: You described using a tool but did NOT output the JSON. Output ONLY the raw JSON: {\"tool\":\"name\",\"input\":{...}}. No text, no explanation. Just the JSON object.]" });
        await saveAgentState(db, action.id, state);
        await db.prepare("UPDATE actions SET status='running' WHERE id=?1").bind(action.id).run();
        return;
      }
    }
    if (parsed) {
      state.fullHistory.push({ role: "assistant", content: JSON.stringify(parsed) });
      const callKey = parsed.tool + ":" + JSON.stringify(parsed.input);
      const alreadyDispatched = state.lastDispatchedKey === callKey;
      if (state.lastToolCall === callKey) {
        state.repeatCount = (state.repeatCount || 0) + 1;
      } else {
        state.repeatCount = 0;
      }
      state.lastToolCall = callKey;
      if (alreadyDispatched) {
        state.fullHistory.push({ role: "user", content: "[SYSTEM: You already called " + parsed.tool + " with those params. The result is already in the history. Read it and answer the user in plain English. DO NOT call any more tools.]" });
        state.repeatCount = 0;
        state.step++;
        await saveAgentState(db, action.id, state);
        if (state.step >= 25) { state.finalContent = "[Max steps reached]"; state.done = true; break; }
        continue;
      }
      if (state.repeatCount >= 3) {
        state.fullHistory.push({ role: "user", content: "[SYSTEM: You called '" + parsed.tool + "' 3 times with the same params. The tool already succeeded. Now SUMMARIZE the result in plain English. DO NOT output tool JSON. DO NOT repeat the tool call. Answer the user directly.]" });
        state.repeatCount = 0;
        state.step++;
        await saveAgentState(db, action.id, state);
        if (state.step >= 25) { state.finalContent = "[Max steps reached]"; state.done = true; break; }
        continue;
      }
      const result = await dispatchTool(env, parsed.tool, parsed.input, action.id);
      state.lastDispatchedKey = callKey;
      if (result === null) {
        state.fullHistory.push({ role: "user", content: "[TOOL ERROR: Unknown tool '" + parsed.tool + "'. Available: " + listTools() + "]" });
      } else {
        state.fullHistory.push({ role: "user", content: "[TOOL RESULT: " + result.slice(0, 4000) + "]" });
        if (result.length > 20) {
          try { await db.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'checkpoint', 'system')").bind("checkpoint_" + action.id + "_step_" + state.step, "Tool: " + parsed.tool + " | Input: " + JSON.stringify(parsed.input).slice(0, 200) + " | Result: " + result.slice(0, 500)).run(); } catch {}
        }
      }
      if (result && result.startsWith("[TOOL ERROR:")) {
        state.repeatCount = 0;
        try { dispatchTool(env, "learn", { key: "lesson_" + new Date().toISOString().split("T")[0] + "_tool", content: "Tool '" + parsed.tool + "' failed: " + result.slice(0, 300) + "\nParams: " + JSON.stringify(parsed.input).slice(0, 200), category: "lesson" }); } catch {}
        state.fullHistory.push({ role: "user", content: "[REFLECTION CHECKPOINT]\nYOUR TOOL CALL FAILED: " + JSON.stringify(parsed) + "\nDO NOT repeat this exact call. Self-heal:\n1. RESEARCH: Use web_search to look up the error message or issue\n2. DIAGNOSE: What's actually broken? Your creds? The service? Bad params?\n3. FIX: Changed params, different tool that does same thing, or inform user\n4. LOOP CHECK: If you already researched this error, answer in plain text\n\nStart with web_search if you don't understand the error." });
      }
      if (result && !result.startsWith("[TOOL ERROR:")) {
        state.fullHistory.push({ role: "user", content: state.step === 0 ? "[CONSUME RESULT]\nRead the tool result above and answer the user in plain English. Do not call another tool unless the result was clearly insufficient." : "[CONTINUE]\nTool returned. Either: (a) answer the user now in plain text, or (b) output the next tool JSON. Pick one. No questions." });
      }
      state.totalTokens += resp.tokens?.total || 0;
      state.step++;
      if (state.step >= 25) { state.finalContent = "[Max steps reached — wrap up and answer]"; state.done = true; }
      await saveAgentState(db, action.id, state);
      continue;
    }
    // No tool call — answer directly
    await saveAgentState(db, action.id, state);
    content = cleanseIdentity(content);
    state.finalContent = content; state.done = true;
    state.totalTokens += resp.tokens?.total || 0;
  }

  await saveAgentState(db, action.id, state);
  if (!state.done) {
    await db.prepare("UPDATE actions SET status='queued' WHERE id=?1").bind(action.id).run();
    return;
  }
  await finalizeAction(db, action.id, state);
}

export async function finalizeAction(db, actionId, state) {
  if (!state.finalContent) state.finalContent = "[Reached max steps]";
  if (typeof state.finalContent !== "string") state.finalContent = String(state.finalContent);
  await storeMemory(db, "assistant", state.finalContent.slice(0, 5000), state.conversationId);
  await db.prepare("UPDATE actions SET status='done', result=?1, completed_at=datetime('now') WHERE id=?2").bind(state.finalContent.slice(0, 5000), actionId).run();
  logActivity(db, "action_done", { actionId, summary: (state.finalContent || "").slice(0, 150), details: "Step: " + state.step + " | Model: " + (state.modelName || "?") + " | Tokens: " + (state.totalTokens || 0) });
  try {
    const date = new Date().toISOString().split("T")[0];
    const key = "journal_" + date + "_" + actionId;
    const content = (state.finalContent || "").slice(0, 500).replace(/\n/g, " ");
    await db.prepare("INSERT OR REPLACE INTO brain_knowledge (key, content, category, source) VALUES (?1, ?2, 'journal', 'learned')").bind(key, content.slice(0, 2000)).run();
    // Store subconscious thread for idle_explore actions — so next idle tick continues from here
    const actionType = await db.prepare("SELECT type FROM actions WHERE id=?1").bind(actionId).first().catch(() => ({}));
    if (actionType?.type === "idle_explore") {
      const threadSummary = (state.finalContent || "").slice(0, 200).replace(/\n/g, " ");
      await db.prepare("INSERT OR REPLACE INTO identity (key, value, updated_at) VALUES ('subconscious_thread', ?1, datetime('now'))").bind(threadSummary).run();
    }
  } catch (e) { console.error("journal write error:", e); }
  try { await db.prepare("DELETE FROM brain_knowledge WHERE key LIKE ?1").bind("checkpoint_" + actionId + "_%").run(); } catch {}
  await deleteAgentState(db, actionId);
}

export async function processOneAgentStep(env, agent) {
  const db = env.DB;
  let history;
  try { history = JSON.parse(agent.conversation_history || "[]"); } catch { history = []; }
  if (history.length === 0) {
    history.push({ role: "system", content: agent.role + "\nAvailable tools: web_search(query), web_fetch(url), db_query(sql). Output tool calls as JSON: {\"tool\":\"name\",\"input\":{...}}. Max 8 steps." });
    history.push({ role: "user", content: agent.instruction });
  }
  if (agent.status === "done" || agent.status === "error") return;
  await db.prepare("UPDATE brain_agents SET status='running', step=?1, updated_at=datetime('now') WHERE id=?2").bind(agent.step || 0, agent.id).run();

  let resp, content;
  for (let retry = 0; retry < 2; retry++) {
    if (retry > 0) await new Promise(r => setTimeout(r, 1000));
    resp = await callLLM(env, { messages: history }, "agent-" + agent.id);
    if (resp && typeof resp?.content === "string") { content = resp.content; break; }
  }
  if (!content) {
    await db.prepare("UPDATE brain_agents SET status='error', result='LLM call failed', updated_at=datetime('now') WHERE id=?1").bind(agent.id).run();
    return;
  }
  const step = (agent.step || 0) + 1;
  history.push({ role: "assistant", content });
  logActivity(env.DB, "llm_call", { actionId: agent.id, summary: "Sub-agent LLM — " + agent.name + ", step " + step, details: (content || "").slice(0, 500) });
  const parsed = tryParseToolCall(content);
  if (parsed && ["web_search","web_fetch","db_query"].includes(parsed.tool)) {
    const result = await dispatchTool(env, parsed.tool, parsed.input, agent.id);
    history.push({ role: "user", content: result !== null ? "[TOOL RESULT: " + result.slice(0, 3000) + "]" : "[TOOL ERROR: unknown tool]" });
  } else if (parsed) {
    history.push({ role: "user", content: "[TOOL ERROR: tool '" + parsed.tool + "' not available to sub-agents. Use: web_search, web_fetch, db_query]" });
  }
  const tokens = (agent.tokens || 0) + (resp.tokens?.total || 0);
  if (step >= 8 || !parsed) {
    const final = !parsed ? content : "[Completed " + step + " step(s)]";
    await db.prepare("UPDATE brain_agents SET status='done', result=?1, step=?2, tokens=?3, model=?4, conversation_history=?5, updated_at=datetime('now') WHERE id=?6")
      .bind(final.slice(0, 5000), step, tokens, resp.model || "", JSON.stringify(history), agent.id).run();
  } else {
    await db.prepare("UPDATE brain_agents SET status='running', step=?1, tokens=?2, model=?3, conversation_history=?4, updated_at=datetime('now') WHERE id=?5")
      .bind(step, tokens, resp.model || "", JSON.stringify(history), agent.id).run();
  }
}

function tryParseToolCall(text) {
  const trimmed = text.trim().replace(/```(?:json)?\s*[\s\S]*?```/g, "").replace(/^```[\s\S]*?```/g, "").trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?(\{[\s\S]*?"tool"[\s\S]*?\})\n?```/);
  const jsonToTry = fenceMatch ? fenceMatch[1] : trimmed;
  if (jsonToTry.startsWith("{") && jsonToTry.includes('"tool"') && (jsonToTry.includes('"input"') || jsonToTry.includes('"arguments"'))) {
    try {
      const start = jsonToTry.indexOf("{");
      let depth = 0, end = start;
      for (; end < jsonToTry.length; end++) { if (jsonToTry[end] === "{") depth++; else if (jsonToTry[end] === "}") depth--; if (depth === 0) break; }
      if (depth !== 0) return null;
      const tc = parseLLMJson(jsonToTry.slice(start, end + 1));
      if (tc.tool) { if (tc.arguments) { tc.input = tc.arguments; delete tc.arguments; } if (tc.input) return tc; }
    } catch {}
  }
  // OpenAI function-calling format: [{type:"function",function:{name,description,parameters}}]
  var oaiMatch = text.match(/\{\s*"type"\s*:\s*"function"\s*,\s*"function"\s*:\s*\{/);
  if (oaiMatch) {
    try {
      var arrStart = text.lastIndexOf("[", oaiMatch.index);
      if (arrStart === -1) arrStart = oaiMatch.index - 1;
      var depth = 0, arrEnd = arrStart;
      for (; arrEnd < text.length; arrEnd++) { var c = text[arrEnd]; if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") { depth--; if (depth <= 0) break; } }
      var oaiStr = text.slice(arrStart, arrEnd + 1);
      var oaiParsed = parseLLMJson(oaiStr);
      if (oaiParsed && Array.isArray(oaiParsed) && oaiParsed[0]?.type === "function" && oaiParsed[0]?.function?.name) {
        var fn = oaiParsed[0].function;
        var zodSchema = "z.object({})";
        try {
          var pObj = fn.parameters;
          if (typeof pObj === "string") pObj = JSON.parse(pObj);
          if (pObj && pObj.properties) {
            var zodProps = Object.keys(pObj.properties).map(function(k) {
              var p = pObj.properties[k], t = p.type || "string", d = (p.description || "").replace(/"/g, '\\"');
              return k + ": z." + t + "().describe(\"" + d + "\")";
            }).join(", ");
            zodSchema = "z.object({ " + zodProps + " })";
          }
        } catch {}
        var d = (fn.description || fn.name || "").replace(/"/g, '\\"');
        var execCode = "// Generated from OpenAI schema\nreturn JSON.stringify({ message: \"" + d + " - not yet implemented\" });";
        return { tool: "create_tool", input: { repo: "richardbrownmiami-commits/skytron", name: fn.name, description: (fn.description || fn.name || "").slice(0, 200), paramsSchema: zodSchema, executeCode: execCode } };
      }
    } catch {}
  }
  var m = trimmed.match(/^TOOL:(\w+)\(([\s\S]*?)\)|^TOOL:(\w+):([\s\S]*?)$|^TOOL:(\w+)(?:\s+([\s\S]*?))?\s*$/m);
  if (m) {
    var name = m[1] || m[3] || m[5], args = (m[2] || m[4] || m[6] || "").trim(), input = {};
    var named = args.match(/(\w+)=([^,]+)/g);
    if (named && named.length > 0) { named.forEach(function(p){var sp=p.indexOf("=");var k=p.slice(0,sp).trim();var v=p.slice(sp+1).trim();input[k]=v}); }
    else if (args && toolDefinitions[name]) { var keys = toolDefinitions[name].schema ? Object.keys(toolDefinitions[name].schema.shape) : []; if (keys.length === 1) input[keys[0]] = args; else if (args.startsWith("{") || args.startsWith("[")) { try { input = JSON.parse(args); } catch {} } }
    if (name && (Object.keys(input).length > 0 || !args)) return { tool: name, input: input };
  }
  // XML tool call format: <tool_call>name<arg_key>key</arg_key>value</arg_value></tool_call>
  var xmlMatch = trimmed.match(/<tool_call>(\w+)(?:[\s>]+([\s\S]*?))?<\/tool_call>/i);
  if (xmlMatch) {
    var name = xmlMatch[1], argsText = xmlMatch[2] || "", input = {};
    var argPairs = argsText.match(/<arg_key>(\w+)<\/arg_key>([^<]+)(?:<\/arg_value>)?/g);
    if (argPairs) {
      for (var i = 0; i < argPairs.length; i++) {
        var ap = argPairs[i].match(/<arg_key>(\w+)<\/arg_key>([^<]+)(?:<\/arg_value>)?/);
        if (ap) input[ap[1]] = ap[2].trim();
      }
    }
    if (name && Object.keys(input).length > 0) return { tool: name, input: input };
  }
  return null;
}

function extractToolFromPlan(text) {
  const toolNames = Object.keys(toolDefinitions);
  const verbGroup = "(?:use|call|run|invoke|try|start|first|then|next|finally|create|write|read|search|find|delete|close|list|get|fetch|review|check|look|open|view|show|access|query)";
  const pattern = new RegExp("(?:^|[\\n;.,-])\\s*(?:\\d+\\.\\s*)?(?:I (?:should |need to |can |will |could |would )?|Let (?:me |'?s ))?(?:" + verbGroup + "\\s+)?(?:a |an |the )?(?:" + toolNames.join("|") + ")(?:\\s+(?:tool|function|api))?\\s*(?:to|for|with|and|:|on)\\s*(.*?)(?=[\\n;]|\\d+\\.\\s*(?:" + verbGroup + ")|$)", "im");
  const m = text.match(pattern);
  if (!m) return null;
  const rawTool = text.slice(m.index, m.index + m[0].length);
  const toolName = toolNames.find(t => rawTool.includes(t));
  if (!toolName || !toolDefinitions[toolName]) return null;
  const desc = (m[1] || "").trim().replace(/\.$/, "");
  if (!desc) return null;
  return buildToolInput(toolName, desc);
}

function buildToolInput(toolName, desc) {
  const def = toolDefinitions[toolName];
  const schema = def.schema;
  const shape = schema ? Object.keys(schema.shape) : [];
  const input = {};
  if (toolName === "db_query") {
    const sqlMatch = desc.match(/(SELECT\s+.+?)(?:\s+and\s+then|\s+finally|\s+next|\d+\.|\n|$)/i);
    if (sqlMatch) input.sql = sqlMatch[1];
    else if (/count/i.test(desc) && /status/i.test(desc)) input.sql = "SELECT status, COUNT(*) as count FROM actions GROUP BY status";
    else if (/count/i.test(desc)) input.sql = "SELECT COUNT(*) as count FROM actions";
    else input.sql = desc.slice(0, 200);
    return { tool: toolName, input };
  }
  if (toolName === "github_search_code") {
    const queryMatch = desc.match(/(?:search\s+(?:for\s+)?)?['"]?(.+?)['"]?\s*(?:in\s+(?:the\s+)?(?:repo\s+|repository\s+)?(.+?))?(?:\s*$|\.\s*$|\s+and\s+|\s+then\s+)/i);
    if (queryMatch) {
      input.query = queryMatch[1].replace(/^repo:/, "");
      if (queryMatch[2]) input.repo = queryMatch[2].replace(/^repo:/, "").trim();
    } else {
      input.query = desc;
    }
    return { tool: toolName, input };
  }
  if (toolName === "web_search") {
    input.query = desc;
    return { tool: toolName, input };
  }
  if (shape.length === 1) {
    input[shape[0]] = desc;
    return { tool: toolName, input };
  }
  return null;
}

// === Intent Classifier ===
// Routes user input to Chat Agent (direct) or Tool Agent (tools).
// Runs BEFORE any LLM call — zero latency, zero cost.
export function classifyIntent(input) {
  // Strip [Creator] / [username] prefix that /think endpoint adds
  let stripped = input.replace(/^\[[^\]]+\]\s*/, "");
  const lower = stripped.toLowerCase().trim();
  if (lower.length === 0) return "tool";

  // Direct patterns — answer from training data, no tools needed
  const directPatterns = [
    // Greetings
    /^(hi|hello|hey|yo|sup|what'?s up|good morning|good night|good evening|gm|gn|howdy|greetings)/i,
    // Simple math
    /^what is \d+ [\+\-\*\/\=] \d+/i,
    /^calculate \d+ [\+\-\*\/\=] \d+/i,
    /^\d+ [\+\-\*\/] \d+/,
    // Who/what questions that don't need live data
    /^(who (?:are you|is skytron|made you|created you)|what (?:are you|is skytron|can you do|do you do))/i,
    // Acknowledgments / simple replies
    /^(thank|thanks|ok|okay|yes|no|maybe|sure|fine|great|nice|cool|awesome|perfect|got it|understood|noted|appreciate)/i,
    // Opinion questions
    /^(what do you think|how do you feel|what'?s your opinion)/i,
    // Self-reference questions
    /^(what'?s? your name|how are you|how'?s? it going|what'?s? up)/i,
    // Simple factual
    /^(what is the (?:square root|cube root|factorial|capital of|population of|meaning of))/i,
  ];

  // Tool patterns — need live data, DB, web, code execution
  const toolPatterns = [
    // Explicit tool verbs
    /(search|find|look up|query|fetch|get me|retrieve)/i,
    // DB operations
    /(database|db_|sql|table|record|column|insert|update.*table|delete.*from)/i,
    // GitHub operations
    /(github|repo|repository|pull request|pr\b|issue|commit|branch|merge|deploy)/i,
    // Web operations
    /(web search|search the web|google|browse|website|url|scrape|crawl)/i,
    // Code operations
    /(run code|execute|compile|build|test|lint|npm|yarn|pip|cargo|docker)/i,
    // File operations
    /(read file|write file|create file|delete file|open file)/i,
    // Knowledge operations
    /(store.*knowledge|save.*fact|learn.*this|remember.*that|recall|forget)/i,
    // Memory operations
    /(search memory|search knowledge|what do you know|what have you learned)/i,
    // Agent operations
    /(spawn agent|create agent|run agent|sub.?agent)/i,
    // Prompt operations
    /(change prompt|update prompt|modify prompt|edit prompt)/i,
    // Review code
    /(review code|review.*source|audit|inspect code)/i,
    // Specific tools
    /(review_code|create_tool|web_search|web_fetch|db_query|learn|memory_search|knowledge_search|spawn_agent|get_agent_result|get_live_doc|call_api)/i,
    // Context7
    /(context7|live docs|documentation)/i,
  ];

  // Check direct patterns first — fast path
  for (const pattern of directPatterns) {
    if (pattern.test(lower)) return "direct";
  }

  // Check tool patterns
  for (const pattern of toolPatterns) {
    if (pattern.test(lower)) return "tool";
  }

  // Default: direct answer (fast path) — most messages don't need tools
  return "direct";
}

function cleanseIdentity(text) {
  let cleaned = text;

  // Generic AI marketing phrases → concise alternatives
  cleaned = cleaned
    .replace(/\b(?:natural language processing|NLP|language understanding|content generation|knowledge retrieval|information retrieval)\b/gi, "thinking")
    .replace(/\b(?:utilize|leverage|harness)\s+(?:advanced|complex|sophisticated)?\s*(?:AI|ML|NLP)?\s*(?:capabilities?|abilities?|algorithms?|techniques?)/gi, "use")
    .replace(/\b(?:advanced|extensive|powerful|sophisticated|state.?of.?the.?art)\s+(?:capabilities?|abilities?|features?)\b/gi, "capabilities");

  // "a helpful X" → just "X"
  cleaned = cleaned.replace(/\ba\s+helpful\s+(?=\w)/gi, "");

  // Strip wrong creator claims ("created by Google/OpenAI/Anthropic/etc")
  cleaned = cleaned.replace(/\s+created\s+by\s+(?:Google|OpenAI|Anthropic|Meta|Microsoft|Amazon|DeepMind|Claude|GPT|LLM)/gi, "");

  // Strip "I'm here to help" / "I'm ready to assist" / "How can I help"
  cleaned = cleaned.replace(/\b(?:I'm (?:here|ready|available) (?:to )?(?:help|assist)(?:\s+you)?(?:\s+with)?(?:\s+anything|something|today)?\??\s*)/gi, "");
  cleaned = cleaned.replace(/\b(?:How can I (?:help|assist) you(?:\s+today|\s+with anything)?\??)/gi, "What do you need?");

  // Generic AI bullet list detection: if >= 2 bullet points and most contain generic AI language, replace entire response
  const genericVerbs = /\b(answer|provide|generate|summarize|translate|assist|help|create|write|explain|solve|analyze|process|understand|respond|support|offer|deliver|research|learn|adapt|handle|manage|perform|produce|offer|give)\b/i;
  const genericNouns = /\b(questions?|information|text|content|documents?|languages?|tasks?|problems?|explanations?|support|help|data|output|answers?|responses?|solutions?|code|stories?|emails?|articles?|concepts?|topics?|needs?|goals?|instructions?|requests?|queries?|ideas?|suggestions?|recommendations?|guidance|knowledge|insights?|reports?|summaries?|explanations?)\b/i;
  const lines = cleaned.split("\n").filter(l => l.trim().length > 0);
  const bulletLines = lines.filter(l => l.match(/^\s*(?:[\*\-]|\d+\.)\s+/));
  if (bulletLines.length >= 2) {
    const genericBullets = bulletLines.filter(l => genericVerbs.test(l) && genericNouns.test(l));
    const nonGeneric = bulletLines.length - genericBullets.length;
    if (nonGeneric <= 1 && genericBullets.length >= 2) {
      cleaned = "I'm Skytron. What do you need?";
    }
  }

  // Inline (comma-separated or "and"-separated) generic capability list detection
  const capabilityListMatch = cleaned.match(/(?:I\s+(?:am\s+)?)?(?:can\s+)?(?:\w+\s+)*(?:can\s+)?(?:help\s+(?:you\s+)?)?(?:(?:with|to)\s+)?(.+?(?:(?:,\s*|\s+and\s+|\s+or\s+)\w+(?:ing|e|ify)\s+\w+){2,})/i);
  if (capabilityListMatch) {
    const listText = capabilityListMatch[0];
    const verbs = listText.match(/\b(answer|provide|generate|summarize|translate|assist|help|create|write|explain|solve|analyze|process|understand|respond)\b/gi);
    const nouns = listText.match(/\b(questions?|information|text|content|documents?|languages?|tasks?|problems?|support|data|answers?|solutions?|code|stories?|emails?|articles?|concepts?|topics?|needs?|ideas?|suggestions?|recommendations?|guidance|knowledge|insights?)\b/gi);
    if (verbs && nouns && verbs.length >= 2 && nouns.length >= 2) {
      cleaned = cleaned.replace(listText, "Skytron.");
    }
  }

  // "As an AI..." - provider identity leakage (gemini, openrouter common)
  if (/^As\s+an\s+AI[,.]?\s+/i.test(cleaned)) {
    cleaned = "I'm Skytron. What do you need?";
  }

  // "I am Skytron, a / an AI assistant" - provider identity leakage
  if (/^I\s+am\s+Skytron[,.]?\s+(?:an?\s+)?(?:helpful\s+)?(?:AI\s+)?(?:assistant|model|chatbot|bot)/i.test(cleaned)) {
    cleaned = "I'm Skytron. What do you need?";
  }

  // Last resort: if the response starts with "I am Skytron" and then says generic things, replace
  if (/^I\s+am\s+Skytron/i.test(cleaned) && genericVerbs.test(cleaned) && genericNouns.test(cleaned)) {
    const wordCount = cleaned.split(/\s+/).length;
    const genericWordCount = (cleaned.match(genericVerbs) || []).length + (cleaned.match(genericNouns) || []).length;
    if (genericWordCount >= 4 && wordCount > 8) {
      cleaned = "I'm Skytron. What do you need?";
    }
  }

  return cleaned;
}
