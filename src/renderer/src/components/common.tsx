import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from 'i18next'
import type { PackManifest, TaskProgress } from '@shared/types'
import { useStore } from '../store'
import { bytes, mediaUrl, num, packImages, q } from '../lib/format'

/** Tâches dont la barre de progression porte un libellé (clés progress.task.*). */
const TASK_LABEL = ['apply', 'remove', 'delete', 'stash', 'clean', 'cache', 'screenshots', 'trash', 'download'] as const
type LabeledTask = (typeof TASK_LABEL)[number]
const isLabeled = (kind: TaskProgress['kind']): kind is LabeledTask => (TASK_LABEL as readonly string[]).includes(kind)

export function Progress({ task }: { task: TaskProgress }) {
  const { t } = useTranslation()
  const pct = task.total > 0 ? Math.min(100, Math.round((task.current / task.total) * 100)) : null
  const label = isLabeled(task.kind) ? t(`progress.task.${task.kind}`) : null
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
  return <img className="cover-img" src={mediaUrl(pack.id, src)} alt="" draggable={false} onError={() => setFailed(src)} />
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
    const ok = await window.api.confirm(t('app.packMenu.deleteTitle', { name: q(pack.name) }), t('app.packMenu.deleteDetail'), t('common.delete'))
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
