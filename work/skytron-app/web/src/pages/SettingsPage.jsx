import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettings } from '../context/SettingsContext'
import { useBridge } from '../hooks/useBridge'

const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'à¤¹à¤¿à¤¨à¥à¤¦à¥€' },
]

const MODELS = [
  'auto',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'command-r-plus-08-2024',
  'mistral-small-latest',
  'openrouter/auto',
]

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { settings, updateSettings } = useSettings()
  const bridge = useBridge()
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <h1 className="text-xl font-bold text-[var(--color-text)]">{t('settings.title')}</h1>

        <Section title={t('settings.api')}>
          <Field label={t('settings.apiKey')} desc={t('settings.apiKeyDesc')}>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            />
          </Field>
          <Field label={t('settings.gatewayUrl')} desc={t('settings.gatewayUrlDesc')}>
            <input
              type="url"
              value={settings.gatewayUrl}
              onChange={(e) => updateSettings({ gatewayUrl: e.target.value })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            />
          </Field>
          <Field label={t('settings.brainUrl')} desc={t('settings.brainUrlDesc')}>
            <input
              type="url"
              value={settings.brainUrl}
              onChange={(e) => updateSettings({ brainUrl: e.target.value })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            />
          </Field>
        </Section>

        <Section title={t('settings.model')}>
          <Field label={t('settings.model')} desc={t('settings.modelDesc')}>
            <select
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            >
              {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={t('settings.temperature')} desc={t('settings.temperatureDesc')}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={settings.temperature}
                onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
                className="flex-1 accent-[var(--color-brand)]"
              />
              <span className="text-sm font-mono text-[var(--color-text)] w-8 text-right">{settings.temperature}</span>
            </div>
          </Field>
          <Field label={t('settings.maxTokens')} desc={t('settings.maxTokensDesc')}>
            <select
              value={settings.maxTokens}
              onChange={(e) => updateSettings({ maxTokens: parseInt(e.target.value) })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            >
              {[1024, 2048, 4096, 8192].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label={t('settings.stream')} desc={t('settings.streamDesc')}>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.stream}
                onChange={(e) => updateSettings({ stream: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-[var(--color-border)] rounded-full peer peer-checked:bg-[var(--color-brand)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </Field>
        </Section>

        <Section title={t('settings.appearance')}>
          <Field label={t('settings.theme')}>
            <div className="flex gap-2">
              {['dark', 'light', 'system'].map(theme => (
                <button
                  key={theme}
                  onClick={() => updateSettings({ theme })}
                  className={`px-4 py-2 text-sm rounded-xl border transition-colors ${
                    settings.theme === theme
                      ? 'bg-[var(--color-brand)] text-white border-[var(--color-brand)]'
                      : 'bg-[var(--color-bg)] text-[var(--color-text-sec)] border-[var(--color-border)] hover:border-[var(--color-brand)]'
                  }`}
                >
                  {t(`settings.${theme}`)}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t('settings.language')} desc={t('settings.languageDesc')}>
            <select
              value={i18n.language}
              onChange={(e) => { updateSettings({ language: e.target.value }); i18n.changeLanguage(e.target.value) }}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] rounded-xl px-4 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] transition-colors"
            >
              {LANGUAGES.map(l => (
                <option key={l.code} value={l.code}>{l.native} ({l.name})</option>
              ))}
            </select>
          </Field>
        </Section>

        <Section title={t('settings.data')}>
          <button
            onClick={() => {
              const data = { settings, conversations: JSON.parse(localStorage.getItem('saraha-conversations') || '[]') }
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a'); a.href = url; a.download = 'saraha-backup.json'; a.click()
              URL.revokeObjectURL(url)
            }}
            className="w-full bg-[var(--color-bg)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl py-2.5 text-sm transition-colors"
          >
            {t('settings.exportAll')}
          </button>
          <button
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'; input.accept = '.json'
              input.onchange = (e) => {
                const file = e.target.files[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = (ev) => {
                  try {
                    const data = JSON.parse(ev.target.result)
                    if (data.settings) updateSettings(data.settings)
                    if (data.conversations) localStorage.setItem('saraha-conversations', JSON.stringify(data.conversations))
                    window.location.reload()
                  } catch {}
                }
                reader.readAsText(file)
              }
              input.click()
            }}
            className="w-full bg-[var(--color-bg)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl py-2.5 text-sm transition-colors"
          >
            {t('settings.importData')}
          </button>
          <button
            onClick={() => { if (window.confirm(t('settings.confirmClear'))) { localStorage.clear(); window.location.reload() } }}
            className="w-full bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-800/50 rounded-xl py-2.5 text-sm transition-colors"
          >
            {t('settings.clearAll')}
          </button>
        </Section>

        <Section title={t('settings.about')}>
          <div className="text-center py-4">
            <svg className="w-12 h-12 mx-auto mb-3 text-[var(--color-brand)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <p className="text-lg font-bold text-[var(--color-text)]">{t('app.name')} Web</p>
            <p className="text-xs text-[var(--color-text-muted)]">{t('settings.version')} 1.0.0</p>
            <a href="https://github.com/richardbrownmiami-commits/saraha-app/releases/download/latest/app-release.apk" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 mt-3 px-5 py-2.5 bg-[var(--color-brand)] hover:bg-[var(--color-brand-dark)] text-white rounded-xl text-sm font-medium transition-colors shadow-md"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> Download APK (Android)</a>
            <p className="text-sm text-[var(--color-text-sec)] mt-2">{t('settings.description')}</p>
          </div>
        </Section>

        {saved && (
          <div className="fixed bottom-6 right-6 bg-[var(--color-success)] text-white px-4 py-2 rounded-xl text-sm shadow-lg animate-fadeIn">
            <span className="flex items-center gap-1"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg> {t('settings.saved')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/50">
        <h2 className="text-xs font-semibold text-[var(--color-brand)] uppercase tracking-wider">{title}</h2>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  )
}

function Field({ label, desc, children }) {
  return (
    <div className="space-y-2">
      <div>
        <label className="text-sm font-medium text-[var(--color-text)]">{label}</label>
        {desc && <p className="text-[11px] text-[var(--color-text-muted)]">{desc}</p>}
      </div>
      {children}
    </div>
  )
}
