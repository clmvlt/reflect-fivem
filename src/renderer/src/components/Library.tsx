import { useMemo, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { PackManifest, RootId, TaskProgress } from '@shared/types'
import { useStore } from '../store'
import { bytes, num } from '../lib/format'
import { problemCount } from '@shared/insights'
import { Cover, packMenuAction, packMeta, Progress, RenameInput } from './common'

export function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const { overview, task, run } = useStore()
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

  const note = (library ?? []).length
    ? t('libraryView.packsNote', { count: library!.length, n: num(library!.length), size: bytes(library!.reduce((s, p) => s + p.contentSize, 0)) })
    : ''

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('libraryView.title')}</h1>
        <span className="page-note">{note}</span>
        <div className="spacer" />
        {(library ?? []).length > 3 && <input className="search" type="search" placeholder={t('common.search')} value={query} onChange={(e) => setQuery(e.target.value)} />}
        <button className="primary" onClick={() => void add()} disabled={!!task}>
          {t('libraryView.addPack')}
        </button>
      </header>

      {problems.map((p) => (
        <div key={p.which} className="bar bar-warning">
          <span className="bar-text">{p.text}</span>
          <button onClick={() => void choose(p.which)}>{t('libraryView.chooseFolder')}</button>
        </div>
      ))}

      {empty ? (
        <div className="empty-state">
          <p>{t('libraryView.empty.title')}</p>
          <p className="muted">{t('libraryView.empty.text')}</p>
        </div>
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
  update,
  task,
  onOpen
}: {
  pack: PackManifest
  active: boolean
  partial: boolean
  problems: number
  update: boolean
  task: TaskProgress | null
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const { run } = useStore()
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
              ) : update ? (
                <span className="accent-text small">{t('libraryView.card.update')}</span>
              ) : problems > 0 ? (
                <span className="warn-text small">{t('libraryView.card.problems', { count: problems, n: num(problems) })}</span>
              ) : null}
              <div className="spacer" />
              {active ? (
                <button onClick={() => void run(() => window.api.removeActive())} disabled={!!task}>
                  {t('common.remove')}
                </button>
              ) : (
                <button onClick={() => void run(() => window.api.applyPack(pack.id))} disabled={!!task}>
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
  const { run } = useStore()
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
              <button onClick={() => void run(() => window.api.stashForeign())} disabled={!!task} title={t('libraryView.foreign.removeTitle')}>
                {t('common.remove')}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
