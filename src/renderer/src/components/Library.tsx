import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketKind, MyDownload, PackManifest, RootId, TaskProgress } from '@shared/types'
import { useStore } from '../store'
import { bytes, num } from '../lib/format'
import { problemCount } from '@shared/insights'
import { Cover, EmptyState, packMenuAction, packMeta, Progress, RenameInput } from './common'
import { ModLibrary, useModActions } from './Mods'

export function Library({
  kind,
  onOpen,
  onOpenMarket,
  onBrowse
}: {
  /** Packs graphiques ou mods, choisi dans la barre latérale. */
  kind: MarketKind
  onOpen: (id: string) => void
  onOpenMarket: (marketId: string, kind?: MarketKind) => void
  /** Marketplace, sur les packs ou sur les mods. */
  onBrowse: (kind: MarketKind) => void
}) {
  const { t } = useTranslation()
  const { overview, task, run } = useStore()
  const modActions = useModActions()
  const [query, setQuery] = useState('')
  const library = overview?.library
  const activeId = overview?.state.active?.packId ?? null

  const packs = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (library ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.features.some((f) => f.toLowerCase().includes(q)))
    return list.sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0))
  }, [library, query, activeId])

  if (!overview) return null
  const { games, state, foreign } = overview
  const mods = kind === 'mod'
  const build = games.fivem.buildNumber ? Number(games.fivem.buildNumber) : null

  const add = async (): Promise<void> => {
    const paths = await window.api.pickArchives()
    if (paths.length) await run(() => window.api.importPacks(paths))
  }
  const choose = async (which: RootId): Promise<void> => {
    const p = await window.api.pickFolder(which === 'fivem' ? t('libraryView.pickFivem') : t('libraryView.pickGta'))
    if (p) await run(() => window.api.setGamePath(which, p))
  }

  const problems: { text: string; which: RootId }[] = []
  if (!games.fivem.valid) problems.push({ text: t('libraryView.problems.fivemMissing'), which: 'fivem' })
  if (!games.gta.valid) problems.push({ text: t('libraryView.problems.gtaMissing'), which: 'gta' })
  else if (games.gta.edition === 'enhanced') problems.push({ text: t('libraryView.problems.gtaEnhanced'), which: 'gta' })

  const importing = task?.kind === 'import' ? task : null
  const showForeign = !!foreign && !state.active && !query
  const empty = !(library ?? []).length && !showForeign && !importing

  const enabledMods = overview.state.mods.filter((m) => m.enabled).length
  const note = mods
    ? overview.mods.length
      ? enabledMods
        ? t('libraryView.modsNoteEnabled', { count: overview.mods.length, n: num(overview.mods.length), enabled: t('libraryView.enabledCount', { count: enabledMods, n: num(enabledMods) }) })
        : t('libraryView.modsNote', { count: overview.mods.length, n: num(overview.mods.length) })
      : ''
    : (library ?? []).length
      ? t('libraryView.packsNote', { count: library!.length, n: num(library!.length), size: bytes(library!.reduce((s, p) => s + p.contentSize, 0)) })
      : ''
  const searchable = (mods ? overview.mods : (library ?? [])).length > 3

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('libraryView.title')}</h1>
        <span className="page-note">{note}</span>
        <div className="spacer" />
        {searchable && <input className="search" type="search" placeholder={t('common.search')} value={query} onChange={(e) => setQuery(e.target.value)} />}
        {mods ? (
          <button className="primary" onClick={() => void modActions.importFiles()} disabled={!!task}>
            {t('libraryView.importMod')}
          </button>
        ) : (
          <button className="primary" onClick={() => void add()} disabled={!!task}>
            {t('libraryView.addPack')}
          </button>
        )}
      </header>

      {problems.map((p) => (
        <div key={p.which} className="bar bar-warning">
          <span className="bar-text">{p.text}</span>
          <button onClick={() => void choose(p.which)}>{t('libraryView.chooseFolder')}</button>
        </div>
      ))}

      <RateReminder onOpen={onOpenMarket} />

      {mods ? (
        <ModLibrary query={query} onOpenMarket={onOpenMarket} onBrowse={() => onBrowse('mod')} />
      ) : empty ? (
        <EmptyState
          icon="pack"
          title={t('libraryView.empty.title')}
          text={t('libraryView.empty.text')}
          formats={['.zip', '.rar', '.7z']}
        >
          <button className="primary" onClick={() => void add()} disabled={!!task}>
            {t('libraryView.addPack')}
          </button>
          <button onClick={() => onBrowse('pack')}>{t('libraryView.browseMarket')}</button>
        </EmptyState>
      ) : (
        <div className="grid">
          {importing && (
            <article className="card">
              <div className="cover">
                <div className="cover-empty">{importing.detail ?? importing.title}</div>
              </div>
              <div className="card-body">
                <div className="name">{importing.detail ?? importing.title}</div>
                <div className="meta">{importing.phase || t('libraryView.preparing')}</div>
                <div className="card-foot">
                  <Progress task={importing} />
                </div>
              </div>
            </article>
          )}
          {showForeign && <ForeignCard files={foreign!.files} size={foreign!.size} task={task} />}
          {packs.map((p) => (
            <PackCard
              key={p.id}
              pack={p}
              active={p.id === activeId}
              partial={p.id === activeId && !!state.active?.partial}
              problems={problemCount(p, build)}
              pending={overview.game.pending?.packId === p.id}
              update={overview.market.updates.includes(p.id)}
              task={task}
              onOpen={() => onOpen(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PackCard({
  pack,
  active,
  partial,
  problems,
  pending,
  update,
  task,
  onOpen
}: {
  pack: PackManifest
  active: boolean
  partial: boolean
  problems: number
  /** Sera installé à la fermeture de FiveM. */
  pending: boolean
  update: boolean
  task: TaskProgress | null
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const { run, changeGame } = useStore()
  const [renaming, setRenaming] = useState(false)
  const mine = task && task.detail === pack.id ? task : null

  const menu = async (e?: MouseEvent): Promise<void> => {
    e?.preventDefault()
    e?.stopPropagation()
    if (await packMenuAction(pack, run)) setRenaming(true)
  }

  return (
    <article className={`card clickable ${active ? 'is-active' : ''}`} onClick={onOpen} onContextMenu={(e) => void menu(e)}>
      <div className="cover">
        <Cover pack={pack} />
      </div>
      <div className="card-body">
        {renaming ? <RenameInput pack={pack} onDone={() => setRenaming(false)} /> : <div className="name" title={pack.name}>{pack.name}</div>}
        <div className="meta">{packMeta(pack)}</div>
        <div className="card-foot" onClick={(e) => e.stopPropagation()}>
          {mine ? (
            <Progress task={mine} />
          ) : (
            <>
              {active ? (
                <span className="state">{partial ? t('libraryView.card.partial') : t('libraryView.card.installed')}</span>
              ) : pending ? (
                <span className="state" title={t('libraryView.card.pendingTitle')}>
                  {t('libraryView.card.pending')}
                </span>
              ) : update ? (
                <span className="accent-text small">{t('libraryView.card.update')}</span>
              ) : problems > 0 ? (
                <span className="warn-text small">{t('libraryView.card.problems', { count: problems, n: num(problems) })}</span>
              ) : null}
              <div className="spacer" />
              {active ? (
                <button onClick={() => void changeGame(() => window.api.removeActive())} disabled={!!task}>
                  {t('common.remove')}
                </button>
              ) : pending ? (
                <button onClick={() => void run(() => window.api.cancelPending())}>{t('common.cancel')}</button>
              ) : (
                <button onClick={() => void changeGame(() => window.api.applyPack(pack.id))} disabled={!!task}>
                  {t('libraryView.card.install')}
                </button>
              )}
              <button className="more" onClick={(e) => void menu(e)} aria-label={t('libraryView.moreOptions')} title={t('libraryView.moreOptions')}>
                ⋯
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

function ForeignCard({ files, size, task }: { files: number; size: number; task: TaskProgress | null }) {
  const { t } = useTranslation()
  const { changeGame } = useStore()
  const mine = task && task.detail === 'foreign' ? task : null
  return (
    <article className="card is-active">
      <div className="cover">
        <div className="cover-empty">{t('libraryView.foreign.title')}</div>
      </div>
      <div className="card-body">
        <div className="name">{t('libraryView.foreign.title')}</div>
        <div className="meta">
          {t('libraryView.foreign.meta', { count: files, n: num(files), size: bytes(size) })}
        </div>
        <div className="card-foot">
          {mine ? (
            <Progress task={mine} />
          ) : (
            <>
              <span className="state">{t('libraryView.card.installed')}</span>
              <div className="spacer" />
              <button onClick={() => void changeGame(() => window.api.stashForeign())} disabled={!!task} title={t('libraryView.foreign.removeTitle')}>
                {t('common.remove')}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

const DISMISSED_KEY = 'rate-reminder-dismissed'

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** « Notez vos packs » : packs et mods de la bibliothèque téléchargés avec le compte et pas encore notés. */
function RateReminder({ onOpen }: { onOpen: (marketId: string, kind?: MarketKind) => void }) {
  const { t } = useTranslation()
  const { account, overview } = useStore()
  const [items, setItems] = useState<MyDownload[]>([])
  const [dismissed, setDismissed] = useState(readDismissed)
  const userId = account && !account.muted ? account.id : null
  // Relu quand un pack arrive dans la bibliothèque (téléchargement terminé).
  const libraryKey = [...(overview?.library ?? []), ...(overview?.mods ?? [])].map((p) => p.marketplace?.id ?? '').join()

  useEffect(() => {
    if (userId === null) return setItems([])
    let live = true
    window.api.myDownloads(0).then(
      (p) => live && setItems(p.items),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [userId, libraryKey])

  const todo = items.filter((d) => d.myRating === null && d.pack.localId && d.pack.authorProfile?.id !== userId && !dismissed.includes(d.pack.id))
  if (userId === null || !todo.length) return null
  const dismiss = (): void => {
    const next = [...dismissed, ...todo.map((d) => d.pack.id)].slice(-200)
    setDismissed(next)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      /* stockage indisponible : masqué pour cette session */
    }
  }
  return (
    <div className="bar rate-reminder">
      <span className="bar-text">{t('libraryView.rate.text')}</span>
      {todo.slice(0, 3).map((d) => (
        <button key={d.pack.id} className="rate-chip" title={t('libraryView.rate.chipTitle', { name: d.pack.name })} onClick={() => onOpen(d.pack.id, d.pack.kind)}>
          <span className="star-on" aria-hidden>
            ★
          </span>
          <span className="ellipsis">{d.pack.name}</span>
        </button>
      ))}
      {todo.length > 3 && <span className="muted small">{t('libraryView.rate.more', { count: todo.length - 3, n: num(todo.length - 3) })}</span>}
      <button className="close" onClick={dismiss} aria-label={t('libraryView.rate.hide')} title={t('libraryView.rate.hide')}>
        ×
      </button>
    </div>
  )
}
