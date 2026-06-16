import { Routes, Route, Navigate } from 'react-router-dom'
import { SettingsProvider } from './context/SettingsContext'
import Layout from './components/Layout/Layout'
import ChatPage from './pages/ChatPage'
import BrainPage from './pages/BrainPage'
import MonitorPage from './pages/MonitorPage'
import PromptPage from './pages/PromptPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <SettingsProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/brain" element={<BrainPage />} />
          <Route path="/monitor" element={<MonitorPage />} />
          <Route path="/prompt" element={<PromptPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </SettingsProvider>
  )
}
