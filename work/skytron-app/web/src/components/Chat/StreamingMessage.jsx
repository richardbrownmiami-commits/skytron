import { useTranslation } from 'react-i18next'

export default function StreamingMessage({ content }) {
  const { t } = useTranslation()

  if (!content) {
    return (
      <div className="flex justify-start px-4 animate-fadeIn">
        <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl rounded-bl-md px-5 py-4">
          <div className="flex items-center gap-1.5">
            <span className="typing-dot w-2 h-2 rounded-full bg-[var(--color-brand)] inline-block" />
            <span className="typing-dot w-2 h-2 rounded-full bg-[var(--color-brand)] inline-block" />
            <span className="typing-dot w-2 h-2 rounded-full bg-[var(--color-brand)] inline-block" />
            <span className="ml-2 text-xs text-[var(--color-text-sec)]">{t('chat.thinking')}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start px-4 animate-fadeIn">
      <div className="bg-[var(--color-bg-card)] border border-[var(--color-border)] rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%] md:max-w-[70%]">
        <p className="text-sm whitespace-pre-wrap">{content}</p>
        <span className="inline-block w-2 h-4 bg-[var(--color-brand)] ml-0.5 animate-pulse" />
      </div>
    </div>
  )
}
