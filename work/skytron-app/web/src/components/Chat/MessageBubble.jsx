import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true, gfm: true })

export default function MessageBubble({ message, onCopy }) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const html = useMemo(() => {
    if (isUser) return null
    const raw = marked.parse(message.content || '')
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'img', 'del', 'ins', 'sub', 'sup'],
      ALLOWED_ATTR: ['href', 'target', 'class', 'src', 'alt'],
    })
  }, [message.content, isUser])

  if (isSystem) return null

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fadeIn px-4`}>
      <div className={`max-w-[85%] md:max-w-[70%] ${isUser ? 'order-1' : ''}`}>
        <div className={`group relative rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-[var(--color-brand)] text-white rounded-br-md'
            : 'bg-[var(--color-bg-card)] text-[var(--color-text)] border border-[var(--color-border)] rounded-bl-md'
        }`}>
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div
              className="markdown-body text-sm leading-relaxed"
              dangerouslySetInnerHTML={{ __html: html || '' }}
            />
          )}

          {!isUser && message.content && (
            <button
              onClick={() => onCopy?.(message.content)}
              className="absolute -bottom-7 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-xs text-[var(--color-text-sec)] hover:text-[var(--color-brand-light)] px-2 py-1"
            >
              {t('chat.copy')}
            </button>
          )}
        </div>

        <p className={`text-[10px] text-[var(--color-text-muted)] mt-1 ${isUser ? 'text-right' : 'text-left'} px-1`}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  )
}
