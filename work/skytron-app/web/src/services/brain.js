export async function fetchBrainStatus(brainUrl, apiKey) {
  const headers = { 'Content-Type': 'application/json' }
  const res = await fetch(`${brainUrl}/brain/emotions`, { headers }).catch(() => null)
  return res?.ok ? res.json() : null
}

export async function fetchBrainPhase(brainUrl) {
  const res = await fetch(`${brainUrl}/brain/phase`).catch(() => null)
  return res?.ok ? res.json() : null
}

export async function fetchBrainActivity(brainUrl) {
  const res = await fetch(`${brainUrl}/brain/activity`).catch(() => null)
  return res?.ok ? res.json() : []
}

export async function fetchBrainStream(brainUrl) {
  const res = await fetch(`${brainUrl}/brain/stream`).catch(() => null)
  return res?.ok ? res.json() : []
}

export async function fetchPendingApprovals(brainUrl) {
  const res = await fetch(`${brainUrl}/monitor/api/pending`).catch(() => null)
  return res?.ok ? res.json() : []
}

export async function approveTool(brainUrl, id) {
  const res = await fetch(`${brainUrl}/monitor/api/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  return res.ok
}

export async function denyTool(brainUrl, id) {
  const res = await fetch(`${brainUrl}/monitor/api/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  return res.ok
}
