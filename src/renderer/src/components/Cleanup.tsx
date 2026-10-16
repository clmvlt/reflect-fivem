import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ForeignItem } from '@shared/types'
import { formatList } from '@shared/intl'
import { useStore } from '../store'
import { bytes, num, q } from '../lib/format'
import { Progress } from './common'
import { confirmDialog } from './Confirm'

const key = (i: ForeignItem): string => `${i.root}:${i.path}`

function groupOf(i: ForeignItem): string {
  if (i.root === 'gta') return 'GTA V'
  return `FiveM › ${i.path.split('/')[0]}`
}

export function Cleanup() {
  const { t } = useTranslation()
  const { overview, task, run, changeGame } = useStore()
  const [items, setItems] = useState<ForeignItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cache, setCache] = useState<{ size: number } | null | undefined>(undefined)
  // Nettoyer le jeu : retirer aussi les mods de la bibliothèque des mods (sinon ils restent activés).
  const [withMods, setWithMods] = useState(false)

  const scan = useCallback(async () => {
    const list = (await run(() => window.api.scanForeign())) ?? []
    setItems(list)
    setSelected(new Set(list.filter((i) => i.recommended).map(key)))
    setCache(undefined)
    setCache((await run(() => window.api.cacheInfo())) ?? null)
  }, [run])

  // Analyse à l'ouverture et après chaque opération.
  useEffect(() => {
    if (!task) void scan()
  }, [task, scan])

  const mods = useMemo(() => (items ?? []).filter((i) => i.category !== 'screenshot' && i.category !== 'log'), [items])
  const shots = useMemo(() => (items ?? []).filter((i) => i.category === 'screenshot'), [items])
  const groups = useMemo(() => {
    const g = new Map<string, ForeignItem[]>()
    for (const i of mods) g.set(groupOf(i), [...(g.get(groupOf(i)) ?? []), i])
    return [...g.entries()]
  }, [mods])

  const sel = mods.filter((i) => selected.has(key(i)))
  const toggle = (list: ForeignItem[], on: boolean): void => {
    const n = new Set(selected)
    for (const i of list) {
      if (on) n.add(key(i))
      else n.delete(key(i))
    }
    setSelected(n)
  }
  const mine = (target: string) => (task && task.detail === target ? task : null)

  const clearCache = async (): Promise<void> => {
    const ok = await confirmDialog(t('cleanup.cache.confirm'), t('cleanup.cache.confirmDetail'), t('cleanup.cache.clear'))
    if (ok) await run(() => window.api.clearCache())
  }
  const shotsSize = shots.reduce((s, i) => s + i.size, 0)
  const trashShots = async (): Promise<void> => {
    const ok = await confirmDialog(
      t('cleanup.shots.confirm', { count: shots.length }),
      t('cleanup.shots.confirmDetail', { size: bytes(shotsSize) }),
      t('common.delete')
    )
    if (ok) await run(() => window.api.trashScreenshots())
  }

  // Remise d'origine du jeu : pack installé + mods installés à la main (+ vos mods, sur demande).
  const active = overview?.state.active ?? null
  const recommended = mods.filter((i) => i.recommended)
  const enabledMods = (overview?.state.mods ?? []).filter((m) => m.enabled)
  const removeMods = withMods && enabledMods.length > 0
  const nothingToClean = !active && !recommended.length && !removeMods
  const cleanSummary = formatList(
    [
      active ? t('cleanup.game.summary.pack', { name: q(active.packName) }) : null,
      recommended.length ? t('cleanup.game.summary.manualMods', { count: recommended.length }) : null,
      removeMods
        ? enabledMods.length > 1
          ? t('cleanup.game.summary.enabledMods', { n: num(enabledMods.length) })
          : t('cleanup.game.summary.enabledMod', { name: q(enabledMods[0].name) })
        : null
    ].filter((s): s is string => !!s)
  )
  const cleanGame = async (): Promise<void> => {
    const kept =
      enabledMods.length && !removeMods
        ? enabledMods.length > 1
          ? t('cleanup.game.confirm.modsStayEnabled', { n: num(enabledMods.length) })
          : t('cleanup.game.confirm.modStaysEnabled')
        : null
    // Phrases complètes mises bout à bout.
    const detail = [
      t('cleanup.game.removes', { summary: cleanSummary }),
      t('cleanup.game.confirm.stash'),
      removeMods ? t('cleanup.game.confirm.modsKept') : null,
      kept,
      t('cleanup.game.confirm.shotsUntouched')
    ]
      .filter(Boolean)
      .join(' ')
    const ok = await confirmDialog(t('cleanup.game.confirm.title'), detail, t('cleanup.game.action'))
    if (ok) await changeGame(() => window.api.cleanGame(removeMods))
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('cleanup.title')}</h1>
        <div className="spacer" />
        <button onClick={() => void scan()} disabled={!!task}>
          {t('common.refresh')}
        </button>
      </header>

      <ul className="list">
        <li className="row">
          <div className="row-main">
            <div className="name">{t('cleanup.game.title')}</div>
            <div className="meta">
              {items === null ? t('cleanup.scanning') : nothingToClean ? t('cleanup.game.nothing') : t('cleanup.game.removes', { summary: cleanSummary })}
            </div>
            {enabledMods.length > 0 && (
              <label className="check-line small">
                <input type="checkbox" checked={withMods} onChange={(e) => setWithMods(e.target.checked)} />
                {enabledMods.length > 1
                  ? t('cleanup.game.withModsMany', { n: num(enabledMods.length) })
                  : t('cleanup.game.withModOne', { name: q(enabledMods[0].name) })}
              </label>
            )}
          </div>
          {mine('game') ? (
            <Progress task={mine('game')!} />
          ) : (
            <div className="actions">
              <button onClick={() => void cleanGame()} disabled={!!task || nothingToClean || items === null}>
                {t('cleanup.game.action')}
              </button>
            </div>
          )}
        </li>
      </ul>

      <div className="section-head">
        <h2>{t('cleanup.foreign.title')}</h2>
      </div>
      {items === null ? (
        <p className="empty">{t('cleanup.scanning')}</p>
      ) : !mods.length ? (
        <p className="empty">{t('cleanup.foreign.none')}</p>
      ) : (
        <>
          <ul className="list">
            {groups.map(([label, list]) => (
              <li key={label} className="group">
                <label className="row group-head">
                  <input type="checkbox" checked={list.every((i) => selected.has(key(i)))} onChange={(e) => toggle(list, e.target.checked)} />
                  <span className="name">{label}</span>
                  <span className="meta right">{t('cleanup.foreign.groupMeta', { count: list.length, size: bytes(list.reduce((s, i) => s + i.size, 0)) })}</span>
                </label>
                {list.map((i) => (
                  <label key={key(i)} className="row item">
                    <input type="checkbox" checked={selected.has(key(i))} onChange={(e) => toggle([i], e.target.checked)} />
                    <span className="item-path">{i.root === 'fivem' ? i.path.split('/').slice(1).join('/') : i.path}</span>
                    <span className="meta item-label">{i.label}</span>
                    <span className="meta right">{i.isDir ? t('cleanup.foreign.dirMeta', { count: i.fileCount, size: bytes(i.size) }) : bytes(i.size)}</span>
                  </label>
                ))}
              </li>
            ))}
          </ul>
          <div className="section-actions">
            {mine('foreign') ? (
              <Progress task={mine('foreign')!} />
            ) : (
              <>
                <span className="meta">{t('cleanup.foreign.selected', { count: sel.length, size: bytes(sel.reduce((s, i) => s + i.size, 0)) })}</span>
                <button onClick={() => void changeGame(() => window.api.stashForeign(sel.map((i) => ({ root: i.root, path: i.path, isDir: i.isDir }))))} disabled={!sel.length || !!task}>
                  {t('cleanup.foreign.stash')}
                </button>
              </>
            )}
          </div>
          <p className="hint">{t('cleanup.foreign.hint')}</p>
        </>
      )}

      {shots.length > 0 && (
        <>
          <div className="section-head">
            <h2>{t('cleanup.shots.title')}</h2>
          </div>
          <ul className="list">
            <li className="row">
              <div className="row-main">
                <div className="name">{t('cleanup.shots.count', { count: shots.length })}</div>
                <div className="meta">{bytes(shotsSize)}</div>
              </div>
              {mine('screenshots') ? (
                <Progress task={mine('screenshots')!} />
              ) : (
                <div className="actions">
                  <button onClick={() => void run(() => window.api.openScreenshots('plugins'))}>{t('common.open')}</button>
                  <button onClick={() => void run(() => window.api.moveScreenshots())} disabled={!!task} title={t('cleanup.shots.moveTitle')}>
                    {t('cleanup.shots.move')}
                  </button>
                  <button onClick={() => void trashShots()} disabled={!!task}>
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </li>
          </ul>
        </>
      )}

      {overview?.games.fivem.valid && (
        <>
          <div className="section-head">
            <h2>{t('cleanup.cache.title')}</h2>
          </div>
          <ul className="list">
            <li className="row">
              <div className="row-main">
                <div className="name">{cache === undefined ? t('cleanup.cache.computing') : cache?.size ? bytes(cache.size) : t('cleanup.cache.empty')}</div>
                <div className="meta">{t('cleanup.cache.help')}</div>
              </div>
              {mine('cache') ? (
                <Progress task={mine('cache')!} />
              ) : (
                <div className="actions">
                  <button onClick={() => void clearCache()} disabled={!!task || !cache?.size}>
                    {t('cleanup.cache.clear')}
                  </button>
                </div>
              )}
            </li>
          </ul>
        </>
      )}
    </div>
  )
}
