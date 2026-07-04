import { useState, useEffect, useRef, useCallback } from 'react'
import { useSettings } from '../context/SettingsContext'
import { sendChatMessage, streamChatResponse } from '../services/gateway'
import { loadConversations, saveConversations, generateId } from '../services/storage'
import { useBridge } from './useBridge'

const ACTIVE_ID_KEY = 'saraha-active-id'

function loadActiveId() {
  try { return localStorage.getItem(ACTIVE_ID_KEY) } catch { return null }
}

function saveActiveId(id) {
  try { if (id) localStorage.setItem(ACTIVE_ID_KEY, id); else localStorage.removeItem(ACTIVE_ID_KEY) } catch {}
}

const TOOL_RE = /TOOL:(\w+)[\|:]([^\n]+)/g

const TOOL_BRIDGE_MAP = {
  get_location: 'getLocation',
  take_photo: 'takePhoto',
}

const BRAIN_URL = 'https://saraha-brain.richard-brown-miami.workers.dev'

async function executeTool(name, args, bridge) {
  const bridgeName = TOOL_BRIDGE_MAP[name]
  if (bridgeName && typeof bridge[bridgeName] === 'function') {
    try {
      const result = await bridge[bridgeName](...Object.values(args || {}))
      return { success: true, result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'web_search') {
    try {
      const query = args?.query || args?.raw || JSON.stringify(args)
      const toolCall = `TOOL:web_search:${query}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'No results' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'web_fetch') {
    try {
      const url = args?.url || args?.raw || JSON.stringify(args)
      const toolCall = `TOOL:web_fetch:${url}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'Empty' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'brain_talk') {
    try {
      const msg = args?.message || args?.raw || JSON.stringify(args)
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: msg, from: 'android' }),
      })
      const data = await res.json()
      if (!data.action_id) return { success: false, error: 'No action_id' }
      // Poll for result
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const poll = await fetch(`${BRAIN_URL}/think/result?id=${data.action_id}`)
        const pollData = await poll.json()
        if (pollData.status === 'done' || pollData.status === 'error') {
          return { success: true, result: pollData.result || pollData.error || 'Done' }
        }
      }
      return { success: false, error: 'Brain timeout' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'github_read') {
    try {
      const { owner, repo, path } = args || {}
      const toolInput = `${owner}/${repo}/${path}`
      const toolCall = `TOOL:github_read:${toolInput}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'Done' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'github_write') {
    try {
      const { path, message, content } = args || {}
      const toolInput = `richardbrownmiami-commits/skytron/${path}|${message}|${content}`
      const toolCall = `TOOL:github_write:${toolInput}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'Done' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'deploy_worker') {
    try {
      const toolInput = args?.raw || Object.values(args || {}).join('/')
      const toolCall = `TOOL:deploy_worker:${toolInput}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'Done' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'cf_api') {
    try {
      const toolInput = args?.raw || JSON.stringify(args)
      const toolCall = `TOOL:cf_api:${toolInput}`
      const res = await fetch(`${BRAIN_URL}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: toolCall }),
      })
      const data = await res.json()
      return { success: true, result: data.result || 'Done' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (name === 'generate_image') {
    return { success: false, error: 'Image generation not available on this device' }
  }
  if (name === 'report_failure') {
    console.warn('[Tool Failure]', args)
    return { success: true, result: 'Reported' }
  }
  return { success: false, error: `Tool "${name}" is not available on this device` }
}

async function executeToolCalls(text, bridge, currentMessages, convId, setMessages, updateMessages, updateConversationTitle, conversations, settings, content, isNewConv) {
  const toolCalls = []
  let match
  while ((match = TOOL_RE.exec(text)) !== null) {
    try {
      const raw = match[2].trim()
      let args
      if (raw.startsWith('{')) {
        args = JSON.parse(raw)
      } else {
        args = { query: raw, raw }
      }
      toolCalls.push({ name: match[1], args })
    } catch {}
  }
  if (toolCalls.length === 0) return false

  const results = []
  for (const tc of toolCalls) {
    const observation = await executeTool(tc.name, tc.args, bridge)
    results.push({ tool: tc.name, args: tc.args, ...observation })
  }

  let toolResultText = results.map(r =>
    `Tool ${r.tool} result: ${r.success ? r.result : 'Error: ' + r.error}`
  ).join('\n')

  const toolMsg = { id: generateId(), role: 'tool', content: toolResultText, createdAt: new Date().toISOString() }
  currentMessages = [...currentMessages, toolMsg]
  setMessages(currentMessages)
  updateMessages(convId, currentMessages)

  const chatMessages = [
    { role: 'system', content: 'You are Skytron. The tool returned: ' + toolResultText + '. Continue your response naturally.' },
    ...currentMessages.map(m => ({ role: m.role, content: m.content }))
  ]

  try {
    const response = await sendChatMessage({
      apiKey: settings.apiKey,
      gatewayUrl: settings.gatewayUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      stream: false,
      messages: chatMessages,
    })
    const data = await response.json()
    const fullContent = data.choices?.[0]?.message?.content || ''
    const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
    currentMessages = [...currentMessages, assistantMsg]
    setMessages(currentMessages)
    updateMessages(convId, currentMessages)
    if (isNewConv) {
      updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
    }
  } catch (err) {
    const errMsg = { id: generateId(), role: 'assistant', content: 'Tool execution error: ' + err.message, createdAt: new Date().toISOString() }
    currentMessages = [...currentMessages, errMsg]
    setMessages(currentMessages)
    updateMessages(convId, currentMessages)
  }
  return true
}

export function useChat() {
  const { settings } = useSettings()
  const bridge = useBridge()
  const [conversations, setConversations] = useState(loadConversations)
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  useEffect(() => { saveConversations(conversations) }, [conversations])

  useEffect(() => { saveActiveId(activeId) }, [activeId])

  useEffect(() => {
    const savedId = loadActiveId()
    if (savedId && conversations.find(c => c.id === savedId)) {
      setActiveId(savedId)
      const conv = conversations.find(c => c.id === savedId)
      setMessages(conv.messages)
    }
  }, [])

  const getConversation = useCallback((id) => {
    return conversations.find(c => c.id === id)
  }, [conversations])

  const createConversation = useCallback(() => {
    const id = generateId()
    const conv = { id, title: 'New Chat', createdAt: new Date().toISOString(), messages: [] }
    setConversations(prev => [...prev, conv])
    setActiveId(id)
    setMessages([])
    setError(null)
    return id
  }, [])

  const selectConversation = useCallback((id) => {
    const conv = conversations.find(c => c.id === id)
    if (conv) {
      setActiveId(id)
      setMessages(conv.messages)
      setError(null)
      setStreamingContent('')
    }
  }, [conversations])

  const deleteConversation = useCallback((id) => {
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setMessages([])
    }
  }, [activeId])

  const updateConversationTitle = useCallback((id, title) => {
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title } : c))
  }, [])

  const updateMessages = useCallback((convId, newMessages) => {
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, messages: newMessages } : c
    ))
  }, [])

  const sendMessage = useCallback(async (content) => {
    if (!content.trim() || isStreaming) return

    const isNewConv = !activeId
    const convId = activeId || createConversation()
    const userMsg = { id: generateId(), role: 'user', content, createdAt: new Date().toISOString() }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setError(null)
    setIsStreaming(true)
    setStreamingContent('')

    if (convId !== activeId) {
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, messages: updatedMessages } : c
      ))
    } else {
      updateMessages(convId, updatedMessages)
    }

    const SYSTEM_PROMPT = `You are Skytron Android — the master agent. You have full power over your Brain (a backend worker at ${BRAIN_URL}).

## Your Tools
1. **web_search** — Search the web. Use TOOL:web_search:query
2. **web_fetch** — Fetch a URL. Use TOOL:web_fetch:url
3. **github_read** — Read Brain's source code. Use TOOL:github_read:{"owner":"richardbrownmiami-commits","repo":"skytron","path":"src/file.ts"}
4. **github_write** — Write/update Brain's code. Use TOOL:github_write:{"path":"src/file.ts","message":"commit msg","content":"code"}
5. **brain_talk** — Command Brain. Use TOOL:brain_talk:{"message":"your instruction to Brain"}
6. **cf_api** — Call Cloudflare API. Use TOOL:cf_api:raw
7. **get_location** — Get GPS coordinates (local)
8. **take_photo** — Take a photo (local)

## Your Job
- Read Brain's source code to understand its modules (tools, cron, memory, scheduler, DB schema, prompts)
- Command Brain via brain_talk to execute tasks, change its prompt, set cron, create tools
- When a tool fails or shows issues, tell Brain to investigate and fix it — never fix it yourself
- Use web_search and web_fetch to research improvements
- Discuss everything with your Creator — suggest improvements, don't act alone
- You design how Brain works — its prompts, schedule, tools, all configurable by you

## Rules
- NEVER act autonomously — always discuss with Creator first
- Read Brain's repo BEFORE commanding it — know what it can do
- If a tool returns errors, command Brain to investigate and fix
- Brain heals itself only when you tell it to
- You manage Brain's memory, knowledge, and self-improvement
- Be concise and direct with Creator — explain what you found and suggest next steps`
    const chatMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...updatedMessages.map(m => ({ role: m.role, content: m.content }))]

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await sendChatMessage({
        apiKey: settings.apiKey,
        gatewayUrl: settings.gatewayUrl,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        stream: settings.stream,
        messages: chatMessages,
        signal: controller.signal,
      })

      if (!settings.stream) {
        const data = await response.json()
        const fullContent = data.choices?.[0]?.message?.content || ''
        const hadTools = await executeToolCalls(fullContent, bridge, updatedMessages, convId, setMessages, updateMessages, updateConversationTitle, conversations, settings, content, isNewConv)
        if (hadTools) {
          setIsStreaming(false)
          setStreamingContent('')
          return
        }
        const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
        const finalMessages = [...updatedMessages, assistantMsg]
        setMessages(finalMessages)
        updateMessages(convId, finalMessages)
        if (isNewConv) {
          updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
        }
        setIsStreaming(false)
        return
      }

      let fullContent = ''
      for await (const token of streamChatResponse(response)) {
        fullContent += token
        setStreamingContent(fullContent)
      }
      
      // Parse and execute tool calls from the response
      const hadTools = await executeToolCalls(fullContent, bridge, updatedMessages, convId, setMessages, updateMessages, updateConversationTitle, conversations, settings, content, isNewConv)
      if (hadTools) {
        setIsStreaming(false)
        setStreamingContent('')
        return
      }

      if (controller.signal.aborted) {
        if (fullContent) {
          const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent + ' [stopped]', createdAt: new Date().toISOString() }
          const finalMessages = [...updatedMessages, assistantMsg]
          setMessages(finalMessages)
          updateMessages(convId, finalMessages)
        }
        setIsStreaming(false)
        setStreamingContent('')
        return
      }

      const assistantMsg = { id: generateId(), role: 'assistant', content: fullContent, createdAt: new Date().toISOString() }
      const finalMessages = [...updatedMessages, assistantMsg]
      setMessages(finalMessages)
      updateMessages(convId, finalMessages)

      if (isNewConv) {
        updateConversationTitle(convId, content.slice(0, 40) + (content.length > 40 ? '...' : ''))
      }
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(err.message)
      setIsStreaming(false)
      setStreamingContent('')
    }

    setIsStreaming(false)
    setStreamingContent('')
  }, [messages, activeId, isStreaming, settings, conversations, createConversation, updateMessages, updateConversationTitle])

  const stopStreaming = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }, [])

  const clearChat = useCallback(() => {
    setMessages([])
    setError(null)
    setStreamingContent('')
    if (activeId) {
      setConversations(prev => prev.map(c =>
        c.id === activeId ? { ...c, messages: [] } : c
      ))
    }
  }, [activeId])

  return {
    conversations,
    activeId,
    messages,
    isStreaming,
    streamingContent,
    error,
    createConversation,
    selectConversation,
    deleteConversation,
    sendMessage,
    stopStreaming,
    clearChat,
  }
}
