import { useState, useEffect, useCallback, useRef } from 'react'
import { useSettings } from '../context/SettingsContext'
import { fetchBrainStatus, fetchBrainPhase, fetchBrainActivity, fetchBrainStream, fetchBrainGoals, fetchBrainTokenUsage } from '../services/brain'

export function useBrain() {
  const { settings } = useSettings()
  const [emotions, setEmotions] = useState(null)
  const [phase, setPhase] = useState(null)
  const [activity, setActivity] = useState([])
  const [stream, setStream] = useState([])
  const [goals, setGoals] = useState([])
  const [tokenUsage, setTokenUsage] = useState({ entries: [], dailyBudget: 10000 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [e, p, a, s, g, t] = await Promise.all([
        fetchBrainStatus(settings.brainUrl),
        fetchBrainPhase(settings.brainUrl),
        fetchBrainActivity(settings.brainUrl),
        fetchBrainStream(settings.brainUrl),
        fetchBrainGoals(settings.brainUrl),
        fetchBrainTokenUsage(settings.brainUrl),
      ])
      if (e) setEmotions(e)
      if (p) setPhase(p)
      if (Array.isArray(a) && a.length) setActivity(a)
      if (Array.isArray(s) && s.length) setStream(s)
      if (g?.entries) setGoals(g.entries)
      if (t) setTokenUsage(t)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [settings.brainUrl, settings.apiKey])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchAll, 15000)
      return () => clearInterval(intervalRef.current)
    } else {
      clearInterval(intervalRef.current)
    }
  }, [autoRefresh, fetchAll])

  return {
    emotions, phase, activity, stream, goals, tokenUsage,
    loading, error, autoRefresh,
    setAutoRefresh, refresh: fetchAll,
  }
}
