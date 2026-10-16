import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from 'i18next'
import type { PackManifest, TaskProgress } from '@shared/types'
import { useStore } from '../store'
import { bytes, mediaUrl, num, packImages, q } from '../lib/format'
import { confirmDialog } from './Confirm'

/** Tâches dont la barre de progression porte un libellé (clés progress.task.*). */
const TASK_LABEL = ['apply', 'remove', 'delete', 'stash', 'clean', 'cache', 'screenshots', 'trash', 'download'] as const
type LabeledTask = (typeof TASK_LABEL)[number]
const isLabeled = (kind: TaskProgress['kind']): kind is LabeledTask => (TASK_LABEL as readonly string[]).includes(kind)

export function Progress({ task }: { task: TaskProgress }) {
  const { t } = useTranslation()
  const pct = task.total > 0 ? Math.min(100, Math.round((task.current / task.total) * 100)) : null
  // Mods : premier mot du titre, traduit par le processus principal (« Activation », « Désactivation »...).
  const label = task.kind === 'mod' ? task.title.split(' ')[0] : isLabeled(task.kind) ? t(`progress.task.${task.kind}`) : null
  return (
    <div className="progress" title={task.phase}>
      {label && <span className="progress-label">{label}</span>}
      <div className="track">
        <div className={`fill ${pct === null ? 'is-waiting' : ''}`} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <span className="pct">{pct === null ? '' : t('progress.percent', { value: num(pct) })}</span>
    </div>
  )
}

export function packMeta(p: PackManifest): string {
  return [p.features.filter((f) => f !== 'ASI' && f !== 'RPF' && f !== 'Citizen').join(', '), bytes(p.contentSize)].filter(Boolean).join(' · ')
}

/** Image du pack, ou son nom sur fond neutre s'il n'en a pas. */
export function Cover({ pack, rel }: { pack: PackManifest; rel?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = rel ?? packImages(pack)[0]
  if (!src || failed === src) return <div className="cover-empty">{pack.name}</div>
  return <img className="cover-img" src={mediaUrl(pack.id, src, pack.kind)} alt="" draggable={false} onError={() => setFailed(src)} />
}

/** Photo d'un compte (pm-media://avatar/...), ou son initiale s'il n'en a pas. */
export function Avatar({ url, name, size }: { url: string | null; name: string; size: number }) {
  const [failed, setFailed] = useState<string | null>(null)
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) }
  if (url && failed !== url) return <img className="avatar" style={style} src={url} alt="" draggable={false} onError={() => setFailed(url)} />
  return (
    <span className="avatar" style={style} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** Menu natif d'un pack (clic droit ou ⋯). Retourne true si le renommage est demandé. */
export async function packMenuAction(pack: PackManifest, run: <T>(fn: () => Promise<T>) => Promise<T | undefined>): Promise<boolean> {
  const choice = await window.api.packMenu(pack.id)
  if (choice === 'rename') return true
  if (choice === 'image') await run(() => window.api.setCoverFromFile(pack.id))
  else if (choice === 'open') await run(() => window.api.openPackFolder(pack.id))
  else if (choice === 'delete') {
    const ok = await confirmDialog(t('app.packMenu.deleteTitle', { name: q(pack.name) }), t('app.packMenu.deleteDetail'), t('common.delete'))
    if (ok) await run(() => window.api.deletePack(pack.id))
  }
  return false
}

export function RenameInput({ pack, onDone, className = 'rename' }: { pack: PackManifest; onDone: () => void; className?: string }) {
  const { run } = useStore()
  const [name, setName] = useState(pack.name)
  const save = async (): Promise<void> => {
    onDone()
    const n = name.trim()
    if (n && n !== pack.name) await run(() => window.api.renamePack(pack.id, n))
  }
  return (
    <input
      className={className}
      autoFocus
      value={name}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void save()
        if (e.key === 'Escape') onDone()
      }}
    />
  )
}

/** Icônes des états vides (contour, 28 px). */
const ICON_PATHS: Record<'pack' | 'mod' | 'search', ReactNode> = {
  // Calques : un pack graphique.
  pack: (
    <>
      <path d="M12 3 3 7.5 12 12l9-4.5z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>
  ),
  // Pièce de puzzle : un mod.
  mod: (
    <path d="M9.5 3.5a2 2 0 0 1 4 0V5H17a1.5 1.5 0 0 1 1.5 1.5V10h1.5a2 2 0 0 1 0 4h-1.5v3.5A1.5 1.5 0 0 1 17 19h-3.5v-1.5a2 2 0 0 0-4 0V19H6a1.5 1.5 0 0 1-1.5-1.5V14H6a2 2 0 0 0 0-4H4.5V6.5A1.5 1.5 0 0 1 6 5h3.5z" />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5" />
    </>
  )
}

/**
 * État vide d'une liste : icône, titre, explication courte et actions. `formats` : extensions acceptées, affichées en
 * pastilles. `compact` : sans cadre (résultats de recherche).
 */
export function EmptyState({
  icon,
  title,
  text,
  formats,
  compact = false,
  children
}: {
  icon: keyof typeof ICON_PATHS
  title: string
  text?: ReactNode
  formats?: string[]
  compact?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className={`empty-panel ${compact ? 'is-compact' : ''}`}>
      <div className="empty-icon" aria-hidden>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {ICON_PATHS[icon]}
        </svg>
      </div>
      <div className="empty-title">{title}</div>
      {text && <p className="empty-text">{text}</p>}
      {formats && (
        <div className="empty-formats" aria-label={t('app.acceptedFormats')}>
          {formats.map((f) => (
            <span key={f} className="format-tag">
              {f}
            </span>
          ))}
        </div>
      )}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  )
}
