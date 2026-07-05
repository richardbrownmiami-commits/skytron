import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { useSettings } from '../context/SettingsContext'

const STATUS_COLORS = {
  discussed: '#8b949e',
  planned: '#d29922',
  built: '#58a6ff',
  tested: '#3fb950',
  completed: '#3fb950',
  failed: '#f85149',
  unfinished: '#f85149',
  unverified: '#d29922',
  switched_away: '#8b949e',
  ongoing: '#58a6ff',
}

export default function JournalPage() {
  const { t } = useTranslation()
  const { settings } = useSettings()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    const brainUrl = settings?.brainUrl || 'https://saraha-brain.richard-brown-miami.workers.dev'
    fetch(`${brainUrl}/brain/journal`)
      .then(r => r.json())
      .then(data => {
        const parsed = (data.entries || []).map(row => {
          try { return JSON.parse(row.content) } catch { return null }
        }).filter(Boolean)
        setEntries(parsed)
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [settings?.brainUrl])

  const toggleExpand = (key) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center py-12 text-sm text-[var(--color-text-sec)]">
          <svg className="animate-spin-slow w-10 h-10 mx-auto mb-3 text-[var(--color-brand)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
          <p>Loading journal entries...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="bg-red-900/30 border border-red-800/50 rounded-xl px-4 py-3 text-sm text-red-400 flex items-center gap-2">
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
          <span>Could not reach brain: {error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[var(--color-text)]">Memory Journal</h1>
            <span className="text-xs text-[var(--color-text-sec)] bg-[var(--color-bg)] px-2 py-0.5 rounded-full">{entries.length} entries</span>
          </div>
        </div>

        {entries.length === 0 && (
          <div className="text-center py-16 text-sm text-[var(--color-text-sec)]">
            <svg className="w-12 h-12 mx-auto mb-3 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
            <p>No journal entries yet.</p>
            <p className="text-xs mt-1">Run the consolidation pipeline to generate entries.</p>
          </div>
        )}

        {entries.map((e, idx) => {
          const isExpanded = expanded[e.journal_key]
          const dateLabel = e.date_start?.slice(0, 10) +
            (e.date_end?.slice(0, 10) !== e.date_start?.slice(0, 10)
              ? ' to ' + e.date_end?.slice(0, 10)
              : '')
          const statusColor = STATUS_COLORS[e.status] || '#8b949e'

          return (
            <div key={e.journal_key || idx}
              className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden transition-all hover:border-[var(--color-border)]/80">
              <button
                onClick={() => toggleExpand(e.journal_key)}
                className="w-full text-left p-4 flex items-start justify-between gap-3 cursor-pointer hover:bg-[var(--color-bg-hover)]/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-[var(--color-text)]">{e.title || e.topic}</span>
                    <span style={{ background: statusColor, color: '#0b1120' }}
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide">{e.status}</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)]">{dateLabel}</p>
                  <p className="text-sm text-[var(--color-text-sec)] mt-1.5 line-clamp-2">{e.summary}</p>
                </div>
                <div className="shrink-0 mt-1">
                  <svg className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-[var(--color-border)]/50 pt-3 space-y-3">
                  <Section label="What happened">
                    {e.what_happened}
                  </Section>

                  {e.completed && (
                    <Section label="Confirmed facts" color="#3fb950">
                      {e.completed}
                    </Section>
                  )}

                  {e.unfinished && (
                    <Section label="Not confirmed / caution" color="#f85149">
                      {e.unfinished}
                    </Section>
                  )}

                  {e.incidents?.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Incidents</p>
                      <div className="flex flex-wrap gap-1">
                        {e.incidents.map(i => (
                          <span key={i} className="bg-red-900/40 text-red-400 text-[10px] px-1.5 py-0.5 rounded-full">{i}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  <Section label="Correct recall response">
                    On <strong>{dateLabel}</strong>, we worked on <strong>{e.title || e.topic}</strong>.
                    From my current memory, the status is <strong style={{ color: statusColor }}>{e.status}</strong>.
                    {e.completed && ` I can confirm: ${e.completed}.`}
                    {e.unfinished && ` I cannot safely claim: ${e.unfinished}.`}
                    {e.next_topic && ` After that, we moved to ${e.next_topic.replace(/_/g, ' ')}.`}
                  </Section>

                  {e.next_topic && (
                    <div className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                      Next: {e.next_topic.replace(/_/g, ' ')}
                    </div>
                  )}

                  <details className="text-xs text-[var(--color-text-muted)]">
                    <summary className="cursor-pointer hover:text-[var(--color-text-sec)]">{e.source_refs?.length || 0} source references</summary>
                    <div className="mt-1 max-h-32 overflow-y-auto grid grid-cols-3 gap-1">
                      {e.source_refs?.map((ref, i) => (
                        <span key={i} className="truncate text-[10px]">{ref}</span>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Section({ label, color, children }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: color || 'var(--color-text-muted)' }}>
        {label}
      </p>
      <p className="text-sm mt-0.5 text-[var(--color-text)]">{children}</p>
    </div>
  )
}
