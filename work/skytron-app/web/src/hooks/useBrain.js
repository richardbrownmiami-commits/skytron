import { useState, useEffect, useCallback, useRef } from 'react'
import { useSettings } from '../context/SettingsContext'
import { fetchBrainStatus, fetchBrainPhase, fetchBrainActivity, fetchBrainStream } from '../services/brain'

export function useBrain() {
  const { settings } = useSettings()
  const [emotions, setEmotions] = useState(null)
  const [phase, setPhase] = useState(null)
  const [activity, setActivity] = useState([])
  const [stream, setStream] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [e, p, a, s] = await Promise.all([
        fetchBrainStatus(settings.brainUrl, settings.apiKey),
        fetchBrainPhase(settings.brainUrl),
        fetchBrainActivity(settings.brainUrl),
        fetchBrainStream(settings.brainUrl),
      ])
      if (e) setEmotions(e)
      if (p) setPhase(p)
      if (Array.isArray(a) && a.length) setActivity(a)
      if (Array.isArray(s) && s.length) setStream(s)
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
    emotions, phase, activity, stream,
    loading, error, autoRefresh,
    setAutoRefresh, refresh: fetchAll,
  }
}
