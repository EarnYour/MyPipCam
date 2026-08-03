import { useMemo, useState, type DragEvent } from 'react'
import type { LibraryBrowseFilter } from '../shared/libraryFolders'
import type { LibraryFolder, RecordingMeta } from '../shared/types'

type Props = {
  folders: LibraryFolder[]
  items: RecordingMeta[]
  filter: LibraryBrowseFilter
  dropTarget: LibraryBrowseFilter | null
  onSelect: (filter: LibraryBrowseFilter) => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onDragOverFilter: (filter: LibraryBrowseFilter | null) => void
  onDropRecording: (recordingId: string, filter: LibraryBrowseFilter) => void
}

function countFor(
  items: RecordingMeta[],
  filter: LibraryBrowseFilter,
): number {
  if (filter === 'all') return items.length
  if (filter === 'unfiled') return items.filter((i) => !i.folderId).length
  return items.filter((i) => i.folderId === filter).length
}

export function LibrarySidebar({
  folders,
  items,
  filter,
  dropTarget,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDragOverFilter,
  onDropRecording,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const counts = useMemo(
    () => ({
      all: countFor(items, 'all'),
      unfiled: countFor(items, 'unfiled'),
      byId: Object.fromEntries(
        folders.map((f) => [f.id, countFor(items, f.id)]),
      ) as Record<string, number>,
    }),
    [folders, items],
  )

  async function submitCreate() {
    const name = draft.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await onCreate(name)
      setDraft('')
      setCreating(false)
    } finally {
      setBusy(false)
    }
  }

  async function submitRename(id: string) {
    const name = renameDraft.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await onRename(id, name)
      setRenamingId(null)
    } finally {
      setBusy(false)
    }
  }

  function dropProps(target: LibraryBrowseFilter) {
    const acceptsDrop = target !== 'all'
    return {
      onDragOver: (e: DragEvent) => {
        if (!acceptsDrop) return
        if (!e.dataTransfer.types.includes('application/x-mypipcam-recording')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOverFilter(target)
      },
      onDragLeave: () => {
        onDragOverFilter(null)
      },
      onDrop: (e: DragEvent) => {
        if (!acceptsDrop) return
        e.preventDefault()
        const id = e.dataTransfer.getData('application/x-mypipcam-recording')
        onDragOverFilter(null)
        if (id) onDropRecording(id, target)
      },
    }
  }

  return (
    <aside className="library-sidebar" aria-label="Library folders">
      <div className="library-sidebar-head">
        <h2>Folders</h2>
        <button
          type="button"
          className="ghost library-sidebar-new"
          title="New folder"
          onClick={() => {
            setCreating(true)
            setDraft('')
          }}
        >
          New
        </button>
      </div>

      <nav className="library-folder-nav">
        <button
          type="button"
          className={`library-folder-item ${filter === 'all' ? 'active' : ''}`}
          onClick={() => onSelect('all')}
        >
          <span className="library-folder-name">All</span>
          <span className="library-folder-count">{counts.all}</span>
        </button>
        <button
          type="button"
          className={`library-folder-item ${filter === 'unfiled' ? 'active' : ''} ${
            dropTarget === 'unfiled' ? 'drop-target' : ''
          }`}
          onClick={() => onSelect('unfiled')}
          {...dropProps('unfiled')}
        >
          <span className="library-folder-name">Unfiled</span>
          <span className="library-folder-count">{counts.unfiled}</span>
        </button>

        {folders.map((folder) => (
          <div
            key={folder.id}
            className={`library-folder-row ${filter === folder.id ? 'active' : ''} ${
              dropTarget === folder.id ? 'drop-target' : ''
            }`}
            {...dropProps(folder.id)}
          >
            {renamingId === folder.id ? (
              <input
                className="library-folder-rename"
                value={renameDraft}
                disabled={busy}
                autoFocus
                aria-label="Rename folder"
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => void submitRename(folder.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitRename(folder.id)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setRenamingId(null)
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <button
                type="button"
                className="library-folder-item library-folder-item-grow"
                onClick={() => onSelect(folder.id)}
              >
                <span className="library-folder-name">{folder.name}</span>
                <span className="library-folder-count">
                  {counts.byId[folder.id] ?? 0}
                </span>
              </button>
            )}
            {renamingId !== folder.id && (
              <div className="library-folder-actions">
                <button
                  type="button"
                  className="ghost"
                  title="Rename folder"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(folder.id)
                    setRenameDraft(folder.name)
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="danger"
                  title="Delete folder"
                  onClick={(e) => {
                    e.stopPropagation()
                    void onDelete(folder.id)
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </nav>

      {creating && (
        <div className="library-folder-create">
          <input
            type="text"
            placeholder="Folder name"
            value={draft}
            disabled={busy}
            autoFocus
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitCreate()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setCreating(false)
              }
            }}
          />
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !draft.trim()}
              onClick={() => void submitCreate()}
            >
              Create
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
