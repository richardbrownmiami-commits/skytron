import StatusBar from './StatusBar'
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const ICONS = {
  chat: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>,
  brain: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>,
  monitor: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>,
  prompt: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  journal: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>,
  settings: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
}

const NAV = [
  { path: '/', icon: 'chat', key: 'nav.chat' },
  { path: '/brain', icon: 'brain', key: 'nav.brain' },
  { path: '/monitor', icon: 'monitor', key: 'nav.monitor' },
  { path: '/prompt', icon: 'prompt', key: 'nav.prompt' },
  { path: '/journal', icon: 'journal', key: 'nav.journal' },
  { path: '/settings', icon: 'settings', key: 'nav.settings' },
]

export default function Layout({ children }) {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const isRtl = i18n.language === 'ar'

  return (
    <div className="flex h-screen overflow-hidden" dir={isRtl ? 'rtl' : 'ltr'} style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <aside className="hidden md:flex w-60 bg-[var(--color-bg-card)] border-r border-[var(--color-border)] flex-col shrink-0">
        <div className="p-4 border-b border-[var(--color-border)]">
          <h1 className="text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
            <svg className="w-5 h-5 text-[var(--color-brand)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <span>{t('app.name')}</span>
          </h1>
          <p className="text-[10px] text-[var(--color-text-sec)] mt-0.5">{t('app.tagline')}</p>
        </div>

        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto scrollbar-thin">
          {NAV.map(item => {
            const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-[var(--color-brand)] text-white shadow-md'
                    : 'text-[var(--color-text-sec)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
                }`}
              >
                <span className="w-5 h-5 shrink-0">{ICONS[item.icon]}</span>
                <span>{t(item.key)}</span>
              </NavLink>
            )
          })}
        </nav>

        <div className="p-3 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-sec)]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
            <span>v1.0.0</span>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <StatusBar />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>

        <nav className="md:hidden flex items-center justify-around border-t border-[var(--color-border)] bg-[var(--color-bg-card)] px-1 py-1 safe-area-bottom shrink-0">
          {NAV.map(item => {
            const isActive = item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all min-w-[48px] ${
                  isActive
                    ? 'text-[var(--color-brand)]'
                    : 'text-[var(--color-text-muted)] active:text-[var(--color-text)]'
                }`}
              >
                <span className={`w-5 h-5 ${isActive ? 'text-[var(--color-brand)]' : ''}`}>{ICONS[item.icon]}</span>
                <span>{t(item.key)}</span>
              </NavLink>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
