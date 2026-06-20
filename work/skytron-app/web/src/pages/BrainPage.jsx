import { useTranslation } from 'react-i18next'
import { useBrain } from '../hooks/useBrain'
import { useState, useEffect } from 'react'
import { useSettings } from '../context/SettingsContext'

const PHASE_SVG = {
  awake: <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>,
  tired: <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>,
  curious: <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
  sleeping: <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646zM12 8v4l3 3" /></svg>,
  busy: <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
}
const PHASE_COLORS = { awake: '#2E86AB', tired: '#6B7280', curious: '#F18F01', sleeping: '#6366F1', busy: '#EF4444' }

function EmotionBar({ label, value, color }) {
  const pct = Math.min(100, Math.max(0, (value || 0) * 10))
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-[var(--color-text-sec)]">{label}</span>
        <span className="font-medium" style={{ color }}>{value || 0}/10</span>
      </div>
      <div className="h-2 bg-[var(--color-border)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}

function EnergyGauge({ energy }) {
  const pct = Math.min(100, Math.max(0, energy || 0))
  const color = pct > 60 ? '#10B981' : pct > 30 ? '#F59E0B' : '#EF4444'
  return (
    <div className="flex items-center gap-3 bg-[var(--color-bg)] rounded-xl p-3 border border-[var(--color-border)]">
      <svg className="w-6 h-6 text-[var(--color-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
      <div className="flex-1 space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-[var(--color-text-sec)]">Energy</span>
          <span className="font-bold" style={{ color }}>{pct}%</span>
        </div>
        <div className="h-3 bg-[var(--color-border)] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
        </div>
      </div>
    </div>
  )
}

export default function BrainPage() {
  const { t } = useTranslation()
  const { settings } = useSettings()
  const { emotions, phase, activity, stream, goals, tokenUsage, loading, error, autoRefresh, setAutoRefresh, refresh } = useBrain()
  const [proposals, setProposals] = useState([])
  const [feedback, setFeedback] = useState(null)

  const currentPhase = phase?.phase || emotions?.emotions?.current_phase || 'awake'
  const phaseIcon = PHASE_SVG[currentPhase] || PHASE_SVG.awake
  const phaseColor = PHASE_COLORS[currentPhase] || '#2E86AB'
  const e = emotions?.emotions || {}
  const energy = emotions?.energy || 0

  useEffect(() => {
    const brainUrl = settings?.brainUrl || 'https://saraha-brain.richard-brown-miami.workers.dev'
    Promise.all([
      fetch(`${brainUrl}/brain/proposals`).then(r => r.json()).catch(() => ({ entries: [] })),
      fetch(`${brainUrl}/brain/feedback`).then(r => r.json()).catch(() => null),
    ]).then(([p, f]) => {
      if (p?.entries) setProposals(p.entries.slice(0, 10))
      if (f) setFeedback(f)
    })
  }, [settings?.brainUrl])

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--color-text)]">{t('brain.title')}</h1>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-[var(--color-text-sec)] cursor-pointer">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="rounded border-[var(--color-border)]" />
              {t('brain.autoRefresh')}
            </label>
            <button onClick={refresh} className="text-sm text-[var(--color-brand-light)] hover:text-[var(--color-accent)] transition-colors" disabled={loading}>
              {t('brain.refresh')}
            </button>
          </div>
        </div>

        {loading && (
          <div className="text-center py-12 text-sm text-[var(--color-text-sec)]">
            <svg className="animate-spin-slow w-10 h-10 mx-auto mb-3 text-[var(--color-brand)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <p>{t('brain.loading')}</p>
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-800/50 rounded-xl px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <svg className="w-5 h-5 shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
            <span>{t('brain.error')}: {error}</span>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="w-8 h-8" style={{ color: phaseColor }}>{phaseIcon}</span>
                  <div>
                    <p className="text-xs text-[var(--color-text-sec)]">{t('brain.phase')}</p>
                    <p className="text-lg font-bold" style={{ color: phaseColor }}>{t(`brain.${currentPhase}`)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${energy > 0 ? 'bg-[var(--color-success)] animate-statusPulse' : 'bg-[var(--color-error)]'}`} />
                  <span className="text-xs text-[var(--color-text-sec)]">{energy > 0 ? t('brain.online') : t('brain.offline')}</span>
                </div>
              </div>

              <EnergyGauge energy={energy} />

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-[var(--color-text)]">{t('brain.emotions')}</h3>
                <EmotionBar label={t('brain.happy')} value={e.happy} color="#10B981" />
                <EmotionBar label={t('brain.energetic')} value={e.energetic} color="#F59E0B" />
                <EmotionBar label={t('brain.intelligent')} value={e.intelligent} color="#2E86AB" />
                <EmotionBar label={t('brain.bad')} value={e.bad} color="#EF4444" />
              </div>
            </div>

            {tokenUsage?.entries?.length > 0 && (
              <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">Daily Token Budget</h3>
                <div className="space-y-2">
                  <TokenBudgetBar entries={tokenUsage.entries} budget={tokenUsage.dailyBudget} />
                  <div className="flex justify-between text-xs text-[var(--color-text-sec)]">
                    <span>Today: {tokenUsage.entries[0]?.tokens || 0} / {tokenUsage.dailyBudget}</span>
                    <span>Budget: {tokenUsage.dailyBudget}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('brain.activity')}</h3>
              {activity.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)] text-center py-6">{t('brain.noActivity')}</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                  {activity.slice(0, 15).map((item, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-2 border-b border-[var(--color-border)]/50 last:border-0">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[var(--color-brand)] shrink-0" />
                      <div>
                        <p className="text-[var(--color-text)]">{typeof item === 'string' ? item : item.action || item.message || item.content || JSON.stringify(item).slice(0, 100)}</p>
                        {item.created_at && <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{new Date(item.created_at).toLocaleString()}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {stream.length > 0 && (
              <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('brain.stream')}</h3>
                <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-thin">
                  {stream.slice(0, 10).map((item, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-2 border-b border-[var(--color-border)]/50 last:border-0">
                      <span className="mt-1 w-4 h-4">
                        {item.mood === 'happy' ? <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> : item.mood === 'curious' ? <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg> : <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>}
                      </span>
                      <p className="text-[var(--color-text)] text-xs">{typeof item.content === 'string' ? item.content.slice(0, 200) : ''}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {goals.length > 0 && (
              <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">Active Goals</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                  {goals.slice(0, 10).map((g, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-2 border-b border-[var(--color-border)]/50 last:border-0">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${g.status === 'active' ? 'bg-green-400' : g.status === 'completed' ? 'bg-blue-400' : 'bg-gray-400'}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[var(--color-text)] text-xs font-medium">{g.title}</p>
                        {g.description && <p className="text-[var(--color-text-muted)] text-[10px] mt-0.5 truncate">{g.description}</p>}
                        <div className="flex items-center gap-2 mt-0.5">
                          {g.progress !== undefined && (
                            <div className="flex items-center gap-1">
                              <div className="w-16 h-1.5 bg-[var(--color-border)] rounded-full overflow-hidden">
                                <div className="h-full rounded-full bg-[var(--color-brand)]" style={{ width: `${g.progress}%` }} />
                              </div>
                              <span className="text-[10px] text-[var(--color-text-muted)]">{g.progress}%</span>
                            </div>
                          )}
                          <span className="text-[10px] text-[var(--color-text-muted)]">p{g.priority}</span>
                          {g.deadline && <span className="text-[10px] text-[var(--color-text-muted)]">due {new Date(g.deadline).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {feedback && (
              <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">Evolution Stats</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatCard label="Evolutions" value={feedback.evolutionCount} color="#10B981" />
                  <StatCard label="Approved 24h" value={feedback.approvals24h} color="#2E86AB" />
                  <StatCard label="Denied 24h" value={feedback.denials24h} color="#EF4444" />
                  <StatCard label="Cron" value={feedback.masterCron?.interval + 'min' || 'off'} color="#F59E0B" />
                </div>
                {feedback.killSwitch && (
                  <div className="mt-3 bg-red-900/30 border border-red-800/50 rounded-xl px-3 py-2 text-xs text-red-400">
                    Kill switch is ACTIVE - brain is not evolving
                  </div>
                )}
              </div>
            )}

            {proposals.length > 0 && (
              <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-5">
                <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">Recent Proposals</h3>
                <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                  {proposals.map((p, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm py-2 border-b border-[var(--color-border)]/50 last:border-0">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                        p.status === 'executed' ? 'bg-green-400' :
                        p.status === 'approved' ? 'bg-blue-400' :
                        p.status === 'pending' ? 'bg-yellow-400' :
                        p.status === 'failed' ? 'bg-red-400' : 'bg-gray-400'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[var(--color-text)] text-xs truncate">{p.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-[var(--color-text-muted)]">{p.status}</span>
                          {p.risk_pct > 0 && <span className="text-[10px] text-[var(--color-text-muted)]">risk: {p.risk_pct}%</span>}
                          {p.resource_type && <span className="text-[10px] text-[var(--color-brand)]">{p.resource_type}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-3 border border-[var(--color-border)]">
      <p className="text-[10px] text-[var(--color-text-muted)] uppercase">{label}</p>
      <p className="text-lg font-bold" style={{ color }}>{value}</p>
    </div>
  )
}

function TokenBudgetBar({ entries, budget }) {
  const today = entries[0]
  const used = today?.tokens || 0
  const pct = Math.min(100, (used / budget) * 100)
  const color = pct > 80 ? '#EF4444' : pct > 50 ? '#F59E0B' : '#10B981'
  return (
    <div>
      <div className="h-3 bg-[var(--color-border)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      {entries.slice(0, 7).reverse().map((d, i) => (
        <div key={i} className="flex justify-between text-[10px] text-[var(--color-text-muted)] mt-1">
          <span>{d.date?.slice(5)}</span>
          <span>{d.tokens}</span>
        </div>
      ))}
    </div>
  )
}
