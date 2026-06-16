const DEFAULTS = {
  apiKey: 'Saraha-Brain-Key',
  gatewayUrl: 'https://buddhi-dwar.richard-brown-miami.workers.dev',
  brainUrl: 'https://saraha-brain.richard-brown-miami.workers.dev',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.7,
  maxTokens: 4096,
  stream: true,
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem('saraha-settings')
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch { return { ...DEFAULTS } }
}

export function saveSettings(settings) {
  try { localStorage.setItem('saraha-settings', JSON.stringify(settings)) } catch {}
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem('saraha-conversations')
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveConversations(conversations) {
  const max = 50
  const trimmed = conversations.slice(-max)
  try { localStorage.setItem('saraha-conversations', JSON.stringify(trimmed)) } catch {}
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
