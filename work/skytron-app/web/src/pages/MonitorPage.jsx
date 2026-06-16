import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMonitor } from '../hooks/useMonitor'

const TOOL_SVG = {
  web_search: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
  github_read: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>,
  github_write: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
  fix_my_brain: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
  web_fetch: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
}

const TOOL_COLORS = {
  web_search: '#3B82F6', github_read: '#8B5CF6', github_write: '#EF4444',
  fix_my_brain: '#10B981', web_fetch: '#6366F1',
}

function ApprovalCard({ item, onApprove, onDeny, isLoading }) {
  const { t } = useTranslation()
  const icon = TOOL_SVG[item.tool_name] || <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
  const color = TOOL_COLORS[item.tool_name] || '#2E86AB'
  const isPending = item.status === 'pending'

  return (
    <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl p-4 space-y-3 animate-fadeIn">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: color + '22', color }}>
            {icon}
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text)]" style={{ color }}>{item.tool_name}</p>
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
            </p>
          </div>
        </div>
        <span className={`text-[10px] font-semibold uppercase px-2.5 py-1 rounded-full ${
          isPending ? 'bg-yellow-900/30 text-yellow-400' :
          item.status === 'approved' ? 'bg-green-900/30 text-green-400' :
          'bg-red-900/30 text-red-400'
        }`}>
          {isPending ? t('monitor.pending') : item.status === 'approved' ? t('monitor.approved') : t('monitor.denied')}
        </span>
      </div>

      {item.tool_input && (
        <div className="bg-[var(--color-bg)] rounded-xl p-3 border border-[var(--color-border)]">
          <p className="text-[10px] text-[var(--color-text-muted)] mb-1">{t('monitor.toolInput')}</p>
          <p className="text-xs text-[var(--color-text)] font-mono break-all">{item.tool_input}</p>
        </div>
      )}

      {isPending && (
        <div className="flex gap-2">
          <button
            onClick={() => onDeny(item.id)}
            disabled={isLoading}
            className="flex-1 bg-red-900/20 hover:bg-red-900/40 border border-red-800/50 text-red-400 rounded-xl py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isLoading ? '...' : <span className="flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>{t('monitor.deny')}</span>}
          </button>
          <button
            onClick={() => onApprove(item.id)}
            disabled={isLoading}
            className="flex-1 bg-green-900/20 hover:bg-green-900/40 border border-green-800/50 text-green-400 rounded-xl py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isLoading ? '...' : <span className="flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>{t('monitor.approve')}</span>}
          </button>
        </div>
      )}
    </div>
  )
}

export default function MonitorPage() {
  const { t } = useTranslation()
  const { pending, history, loading, actionLoading, error, approve, deny } = useMonitor()
  const [tab, setTab] = useState('pending')

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--color-text)]">{t('monitor.title')}</h1>
          {pending.length > 0 && (
            <span className="bg-[var(--color-warning)] text-black text-xs font-bold px-2.5 py-1 rounded-full">
              {pending.length} {t('monitor.pending')}
            </span>
          )}
        </div>

        <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 border border-[var(--color-border)]">
          <button
            onClick={() => setTab('pending')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${tab === 'pending' ? 'bg-[var(--color-bg-card)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-sec)] hover:text-[var(--color-text)]'}`}
          >
            {t('monitor.pending')} ({pending.length})
          </button>
          <button
            onClick={() => setTab('history')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${tab === 'history' ? 'bg-[var(--color-bg-card)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-sec)] hover:text-[var(--color-text)]'}`}
          >
            {t('monitor.history')} ({history.length})
          </button>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800/50 rounded-xl px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-sm text-[var(--color-text-sec)]">
            <svg className="animate-spin-slow w-8 h-8 mx-auto mb-2 text-[var(--color-brand)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p>{t('common.loading')}</p>
          </div>
        ) : tab === 'pending' ? (
          pending.length === 0 ? (
            <div className="text-center py-16">
              <svg className="w-14 h-14 mb-4 text-[var(--color-success)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <p className="text-[var(--color-text-sec)] text-sm">{t('monitor.noPending')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map(item => (
                <ApprovalCard key={item.id} item={item} onApprove={approve} onDeny={deny} isLoading={actionLoading[item.id]} />
              ))}
            </div>
          )
        ) : (
          history.length === 0 ? (
            <div className="text-center py-16">
              <svg className="w-14 h-14 mb-4 text-[var(--color-text-sec)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              <p className="text-[var(--color-text-sec)] text-sm">{t('monitor.noHistory')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {history.map(item => (
                <ApprovalCard key={item.id} item={item} onApprove={approve} onDeny={deny} isLoading={false} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
