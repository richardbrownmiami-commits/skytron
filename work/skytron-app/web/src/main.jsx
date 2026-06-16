import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
import './index.css'

window.onerror = (msg, url, line, col, err) => {
  if (msg && msg.includes && msg.includes("Java bridge method")) return true
  console.error('GLOBAL ERROR:', msg, err?.stack)
  return true
}
window.addEventListener('unhandledrejection', e => {
  console.error('UNHANDLED PROMISE:', e.reason?.stack || e.reason)
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

function mount() {
  const root = document.getElementById('root')
  if (!root) { console.error('ROOT NOT FOUND'); return }
  try {
    console.log('APP MOUNTING...')
    ReactDOM.createRoot(root).render(
      <ErrorBoundary>
        <HashRouter>
          <App />
        </HashRouter>
      </ErrorBoundary>
    )
    console.log('APP MOUNTED SUCCESSFULLY')
  } catch (e) {
    console.error('RENDER ERROR:', e.message)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
