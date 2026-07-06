# Discussion Mode Fix — Summary

## Problem
1. Discussion mode was not working — Skytron still tried to use tools even when they should be disabled
2. Replies took too long (25-30+ seconds) because it was using Workers AI which times out frequently
3. The system prompt always included tool definitions regardless of mode

## Root Cause
- In `routes.ts`, the system message was always built with HARDCODED_CORE (includes all tool definitions)
- In `agents.ts`, discussion mode was calling `callChatAgent` which used slow Workers AI
- Even in discussion mode, Skytron "saw" all the tools in the prompt and tried to use them

## Solution

### routes.ts (lines 500-570)
**BEFORE**: Always built full prompt with tools, knowledge, memory, etc.

**AFTER**: 
- If `mode === "discussion"`: Build minimal prompt WITHOUT tools
  - Just: identity + "NO TOOLS" message + recent 10 messages
  - Explicitly tells Skytron: "You're in DISCUSSION MODE — NO TOOLS available"
  - Suggests switching to Build mode if user needs live data
- If `mode === "build"`: Keep full prompt with tools (unchanged)

### agents.ts (lines 26-46)
**BEFORE**: Called `callChatAgent` (Workers AI, slow, times out)

**AFTER**: 
- Use `callLLM` directly with `model: "gemini-2.5-flash"` (BUDDHI_DWAR)
- Gemini is fastest provider (3-8 seconds vs 25-30 seconds)
- More reliable than Workers AI (doesn't time out as often)

## Expected Behavior After Fix

### Discussion Mode
✅ Fast response (3-8 seconds)
✅ No tool calls attempted
✅ Conversational, direct answers
✅ If user needs live data, suggests Build mode
✅ Uses recent conversation history for context

### Build Mode
✅ Unchanged — full tools, knowledge, memory (20-60 seconds for complex tasks)

## Testing

Created `test-discussion-mode.js` to verify logic:
- ✅ Has 'NO TOOLS' message
- ✅ No tool definitions in prompt
- ✅ Has conversation context
- ✅ Prompt is minimal (1124 chars vs 32000 chars in build mode)

## Deployment

Ready to deploy. Changes are backward compatible:
- Default mode is still "discussion" (safe)
- Build mode unchanged
- No breaking changes to API

## Files Modified
1. `src/routes.ts` — system prompt construction
2. `src/agents.ts` — discussion mode LLM call

## Next Steps
1. Deploy to production
2. Test with real user messages
3. Monitor response times (should see 3-8s in discussion mode)
4. Monitor for any tool call attempts in discussion mode (should be zero)
