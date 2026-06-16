import { useState, useEffect, useCallback } from 'react'
import { useBridge } from '../../hooks/useBridge'

export default function StatusBar() {
  const bridge = useBridge()
  const [battery, setBattery] = useState('?')
  const [network, setNetwork] = useState('?')
  const [syncStat, setSyncStat] = useState('{"pending":0,"failed":0}')
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    if (!bridge.isAvailable) return
    bridge.getBattery().then(setBattery).catch(() => {})
    bridge.getNetwork().then(setNetwork).catch(() => {})
    bridge.syncStat().then(setSyncStat).catch(() => {})
    const interval = setInterval(() => {
      bridge.getBattery().then(setBattery).catch(() => {})
      bridge.getNetwork().then(setNetwork).catch(() => {})
      bridge.syncStat().then(setSyncStat).catch(() => {})
    }, 30000)
    return () => clearInterval(interval)
  }, [bridge.isAvailable])

  const handleSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try { await bridge.syncNow(); await bridge.syncStat().then(setSyncStat) }
    catch {}
    setSyncing(false)
  }, [syncing, bridge.isAvailable])

  if (!bridge.isAvailable) return null
  const stat = JSON.parse(syncStat)
  const pending = stat.pending || 0
  const failed = stat.failed || 0

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-[var(--color-bg-card)] border-b border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]">
      <span className="flex items-center gap-1">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
        {battery}%
      </span>
      <span className="w-1 h-1 rounded-full bg-[var(--color-border)]" />
      <span className="flex items-center gap-1">
        {network === 'wifi' && <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" /></svg>}
        {network}
      </span>
      <span className="w-1 h-1 rounded-full bg-[var(--color-border)]" />
      <button onClick={handleSync} disabled={syncing} className="flex items-center gap-1 hover:text-[var(--color-text)] transition-colors disabled:opacity-50">
        <svg className={"w-3.5 h-3.5 " + (syncing ? "animate-spin" : "")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        <span>{pending > 0 ? pending + ' pending' : 'synced'}</span>
      </button>
      {failed > 0 && <span className="text-red-400 font-medium">{failed} failed</span>}
    </div>
  )
}