import { useState, useRef, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useBridge } from "../../hooks/useBridge"

export default function ChatInput({ onSend, onStop, isStreaming }) {
  const { t } = useTranslation()
  const [input, setInput] = useState("")
  const [recording, setRecording] = useState(false)
  const textareaRef = useRef(null)
  const bridge = useBridge()

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isStreaming])

  const handleSend = () => {
    if (!input.trim() || isStreaming) return
    onSend(input)
    setInput("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px"
    }
  }

  const handleMic = async () => {
    if (recording) return
    setRecording(true)
    try {
      const granted = await bridge.requestPermission("microphone")
      if (!granted) { setRecording(false); return }
      const transcript = await bridge.startSTT()
      if (transcript && transcript.trim()) onSend(transcript)
    } catch {}
    setRecording(false)
  }

  const handleFilePicker = async () => {
    try {
      const uri = await bridge.pickFile()
      if (uri) onSend("[File](" + uri + ")")
    } catch {}
  }

  const handlePaste = async () => {
    try {
      const text = await bridge.getClipboard()
      if (text) { setInput(prev => prev + text); textareaRef.current?.focus() }
    } catch {}
  }

  const handleCamera = async () => {
    try {
      const granted = await bridge.requestPermission("camera")
      if (!granted) return
      const uri = await bridge.takePhoto()
      if (uri) onSend("[Photo](" + uri + ")")
    } catch {}
  }

  const ToolBtn = ({ onClick, title, children, active }) => (
    <button
      onClick={onClick}
      disabled={isStreaming}
      className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-sm transition-colors border ${
        active
          ? "bg-red-500 text-white animate-pulse border-red-500"
          : "bg-[var(--color-bg)] text-[var(--color-text-sec)] hover:text-[var(--color-text)] border-[var(--color-border)]"
      } disabled:opacity-40`}
      title={title}
    >
      {children}
    </button>
  )

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-card)] shrink-0 safe-area-bottom">
      <div className="px-3 pt-2 pb-2">
        {bridge.isAvailable && (
          <div className="flex items-center gap-1.5 mb-2">
            <ToolBtn onClick={handleMic} title={t("chat.voiceInput")} active={recording}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v3m-4 0h8" /></svg>
            </ToolBtn>
            <ToolBtn onClick={handleCamera} title={t("chat.takePhoto")}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </ToolBtn>
            <ToolBtn onClick={handleFilePicker} title="Attach file">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
            </ToolBtn>
            <ToolBtn onClick={handlePaste} title="Paste">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            </ToolBtn>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={t("chat.placeholder")}
              rows={1}
              disabled={isStreaming}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] placeholder-[var(--color-text-muted)] rounded-xl px-3 py-2.5 text-sm border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-brand)] resize-none transition-colors disabled:opacity-50"
              style={{ maxHeight: "120px" }}
            />
          </div>
          {isStreaming ? (
            <button onClick={onStop} className="shrink-0 bg-[var(--color-error)] hover:bg-red-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors">
              {t("chat.stop")}
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()} className="shrink-0 bg-[var(--color-brand)] hover:bg-[var(--color-brand-dark)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors">
              {t("chat.send")}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
