export async function sendChatMessage({ apiKey, gatewayUrl, model, temperature, maxTokens, stream, messages, signal }) {
  const url = `${gatewayUrl}/v1/chat/completions`
  const body = { model, temperature, max_tokens: maxTokens, stream, messages }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${text ? ': ' + text.slice(0, 100) : ''}`)
  }

  return response
}

export async function* streamChatResponse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() || ''

      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue

        try {
          const json = JSON.parse(trimmed.slice(6))
          const content = json.choices?.[0]?.delta?.content || ''
          if (content) yield content
        } catch {}
      }
    }

    if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ')) {
        try {
          const json = JSON.parse(trimmed.slice(6))
          const content = json.choices?.[0]?.delta?.content || ''
          if (content) yield content
        } catch {}
      }
    }
  } finally {
    reader.releaseLock()
  }
}
