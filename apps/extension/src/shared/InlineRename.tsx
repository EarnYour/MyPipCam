import { useEffect, useRef, useState } from 'react'

type Props = {
  title: string
  onSave: (next: string) => Promise<void> | void
  className?: string
  as?: 'h1' | 'h2' | 'h3' | 'span'
}

/** Click-to-edit title that persists on blur/Enter. Escape cancels. */
export function InlineRename({ title, onSave, className, as: Tag = 'h3' }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(title)
  }, [title])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  async function commit() {
    const next = draft.trim()
    if (!next || next === title) {
      setDraft(title)
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      await onSave(next)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`inline-rename-input ${className ?? ''}`}
        value={draft}
        disabled={busy}
        aria-label="Rename"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(title)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <Tag className={`inline-rename ${className ?? ''}`}>
      <button
        type="button"
        className="inline-rename-btn"
        title="Click to rename"
        onClick={() => setEditing(true)}
      >
        {title}
      </button>
    </Tag>
  )
}
