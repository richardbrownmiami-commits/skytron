import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { loadSettings, saveSettings } from '../services/storage'

const SettingsContext = createContext()

export function useSettings() {
  return useContext(SettingsContext)
}

export function SettingsProvider({ children }) {
  const [settings, setSettingsState] = useState(loadSettings)
  const { i18n } = useTranslation()

  const updateSettings = useCallback((updates) => {
    setSettingsState(prev => {
      const next = { ...prev, ...updates }
      saveSettings(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (settings.language) i18n.changeLanguage(settings.language)
  }, [settings.language, i18n])

  useEffect(() => {
    document.documentElement.dir = settings.language === 'ar' ? 'rtl' : 'ltr'
  }, [settings.language])

  useEffect(() => {
    const theme = settings.theme || 'dark'
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [settings.theme])

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}
