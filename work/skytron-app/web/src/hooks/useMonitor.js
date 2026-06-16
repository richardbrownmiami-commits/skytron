import { useState, useEffect, useCallback } from 'react'
import { useSettings } from '../context/SettingsContext'
import { fetchPendingApprovals, approveTool, denyTool } from '../services/brain'

export function useMonitor() {
  const { settings } = useSettings()
  const [pending, setPending] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState({})
  const [error, setError] = useState(null)

  const fetchAll = useCallback(async () => {
    try {
      const data = await fetchPendingApprovals(settings.brainUrl)
      if (data) {
        setPending(data.pending || [])
        setHistory(data.history || [])
      }
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [settings.brainUrl])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => { const iv = setInterval(fetchAll, 10000); return () => clearInterval(iv) }, [fetchAll])

  const handleApprove = useCallback(async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: true }))
    try {
      await approveTool(settings.brainUrl, id)
      await fetchAll()
    } catch (err) {
      setError(err.message)
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }))
    }
  }, [settings.brainUrl, fetchAll])

  const handleDeny = useCallback(async (id) => {
    setActionLoading(prev => ({ ...prev, [id]: true }))
    try {
      await denyTool(settings.brainUrl, id)
      await fetchAll()
    } catch (err) {
      setError(err.message)
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }))
    }
  }, [settings.brainUrl, fetchAll])

  return {
    pending, history, loading, actionLoading, error,
    refresh: fetchAll, approve: handleApprove, deny: handleDeny,
  }
}
