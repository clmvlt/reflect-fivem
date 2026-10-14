import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as tr } from 'i18next'
import type { Destination, Insight, PackComponent, PackManifest } from '@shared/types'
import type { ComponentFile } from '@shared/api'
import { useStore } from '../store'
import { bytes, longDate, mediaUrl, num, packImages } from '../lib/format'
import { asiBuildText, LEVEL_LABEL, levelOf, type Level } from '@shared/insights'
import { Cover, packMenuAction, Progress, RenameInput } from './common'
import { Gallery } from './Gallery'
import { Markdown } from './Markdown'
import { msText, optionCostText, PerfFacts, usePerfConfirm, usePerformance, usePerformanceDetail } from './Performance'
import { costOnMachine, installedPerformance, optionFor, presetFor } from '@shared/performance'

/** Destinations proposées (évaluées à l'affichage : libellé « Ne pas installer » traduit). */
const destinations = (): { key: string; label: string; dest: Destination | null }[] => [
  { key: 'fivem:mods', label: 'FiveM › mods', dest: { root: 'fivem', path: 'mods' } },
  { key: 'fivem:plugins', label: 'FiveM › plugins', dest: { root: 'fivem', path: 'plugins' } },
  { key: 'fivem:citizen', label: 'FiveM › citizen', dest: { root: 'fivem', path: 'citizen' } },
  { key: 'fivem:addons', label: 'FiveM › addons', dest: { root: 'fivem', path: 'addons' } },
  { key: 'fivem:', label: 'FiveM.app', dest: { root: 'fivem', path: '' } },
  { key: 'gta:', label: 'GTA V', dest: { root: 'gta', path: '' } },
  { key: 'none', label: tr('packDetail.content.dontInstall'), dest: null }
]

const keyOf = (d: Destination | null): string => (d ? `${d.root}:${d.path}` : 'none')
const labelOf = (d: Destination): string => `${d.root === 'fivem' ? 'FiveM' : 'GTA V'}${d.path ? ` › ${d.path.split('/').join(' › ')}` : ''}`

export function PackDetail({ pack, onBack, onOpenMarket }: { pack: PackManifest; onBack: () => void; onOpenMarket: (marketId: string) => void }) {
  const { t } = useTranslation()
  const { overview, task, run, changeGame } = useStore()
  const perfCtx = usePerformance()
  const confirmHeavy = usePerfConfirm()
  const [renaming, setRenaming] = useState(false)
  const [fetched, setFetched] = useState<{ marketId: string; youtubeId: string | null } | null>(null)
  const marketId = pack.marketplace?.id

  // Pack téléchargé avant l'ajout des vidéos : on la cherche sur sa fiche.
  useEffect(() => {
    if (!marketId || pack.youtubeId !== undefined) return
    let live = true
    window.api.marketDetail(marketId).then(
      (d) => live && setFetched({ marketId, youtubeId: d.youtubeId }),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [marketId, pack.youtubeId])
  const video = pack.youtubeId !== undefined ? pack.youtubeId : fetched && fetched.marketId === marketId ? fetched.youtubeId : null
  // Pack de la Marketplace : son analyse, pour le comparer à la machine avec le preset et les options choisis.
  const perfDetail = usePerformanceDetail(pack.marketplace && pack.marketplace.kind !== 'mod' ? pack.marketplace.id : null, 'pack')

  if (!overview) return null
  const active = overview.state.active?.packId === pack.id
  const mine = task && task.detail === pack.id ? task : null
  const build = overview.games.fivem.buildNumber ? Number(overview.games.fivem.buildNumber) : null
  const installable = pack.components.filter((c) => c.enabled && c.destination)
  const modified = pack.components.some((c) => keyOf(c.destination) !== keyOf(c.suggested) || c.enabled !== (c.suggested !== null && !c.optional))
  const images = packImages(pack)
  const imported = longDate(pack.importedAt)
  const market = pack.marketplace
  const updateAvailable = overview.market.updates.includes(pack.id)
  const gone = overview.market.gone.includes(pack.id)
  const downloading = task?.kind === 'download' && market && task.detail === market.id ? task : null
  const report = perfDetail?.report ?? null
  // undefined : rien à montrer (pas de fiche, API plus ancienne, analyse en cours de chargement) ; null : pas analysé.
  const installedPerf =
    perfDetail === undefined || perfDetail === null
      ? undefined
      : report
        ? installedPerformance(report, { preset: pack.reshadePreset, components: installable.map((c) => c.source) })
        : null
  /** Coût d'un preset ReShade sur la machine (null s'il n'est pas dans l'analyse). */
  const presetCost = (rel: string): string => {
    const preset = report && perfCtx ? presetFor(report, rel) : null
    return preset && perfCtx ? ` (+${msText(costOnMachine(perfCtx.profile.model, perfCtx.machine, preset.costMs))})` : ''
  }
  const install = async (): Promise<void> => {
    if (!(await confirmHeavy({ name: pack.name, kind: 'pack', performance: installedPerf }, t('packDetail.installAnyway')))) return
    await changeGame(() => window.api.applyPack(pack.id))
  }

  return (
    <div className="page">
      <div className="back-row">
        <button className="link" onClick={onBack}>
          {t('packDetail.back')}
        </button>
      </div>

      <div className="store">
        <Gallery
          key={pack.id}
          images={images}
          youtubeId={video}
          image={(rel) => <Cover pack={pack} rel={rel} />}
          thumb={(rel) => mediaUrl(pack.id, rel)}
          empty={<div className="cover-empty">{t('packDetail.media.none')}</div>}
          actions={(current) => (
            <div className="media-actions">
              {current && current !== images[0] && (
                <button className="link" onClick={() => void run(() => window.api.setCover(pack.id, current))}>
                  {t('packDetail.media.useAsCover')}
                </button>
              )}
              <button className="link" onClick={() => void run(() => window.api.setCoverFromFile(pack.id))}>
                {images.length ? t('packDetail.media.chooseOther') : t('packDetail.media.choose')}
              </button>
            </div>
          )}
        />

        <aside className="side">
          {renaming ? <RenameInput pack={pack} onDone={() => setRenaming(false)} className="rename big" /> : <h1 className="pack-title">{pack.name}</h1>}
          {pack.author && <div className="tags">{t('packDetail.byAuthor', { author: pack.author })}</div>}
          {pack.features.length > 0 && <div className="tags">{pack.features.join(' · ')}</div>}

          {market && updateAvailable && (
            <div className="side-update">
              {downloading ? (
                <Progress task={downloading} />
              ) : (
                <>
                  <span>{t('packDetail.updateAvailable')}</span>
                  <button onClick={() => void run(() => window.api.marketInstall(market.id))} disabled={!!task}>
                    {t('packDetail.update')}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="side-actions">
            {mine ? (
              <Progress task={mine} />
            ) : active ? (
              <>
                <div className="state big">{t('packDetail.installed')}</div>
                <button className="wide" onClick={() => void changeGame(() => window.api.removeActive())} disabled={!!task}>
                  {t('packDetail.removeFromGame')}
                </button>
              </>
            ) : overview.game.pending?.packId === pack.id ? (
              <>
                <div className="state big">{t('packDetail.pending')}</div>
                <p className="hint">{t('packDetail.pendingHint')}</p>
                <button className="wide" onClick={() => void run(() => window.api.cancelPending())}>
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button className="primary wide" onClick={() => void install()} disabled={!!task || !installable.length}>
                {t('packDetail.install')}
              </button>
            )}
          </div>

          <dl className="facts">
            <dt>{t('packDetail.facts.size')}</dt>
            <dd>{bytes(pack.contentSize)}</dd>
            <dt>{t('packDetail.facts.installedFiles')}</dt>
            <dd>{num(installable.reduce((s, c) => s + c.fileCount, 0))}</dd>
            <dt>{t('packDetail.facts.added')}</dt>
            <dd>{imported}</dd>
            <dt>{t('packDetail.facts.source')}</dt>
            <dd className="ellipsis" title={pack.sourceArchive}>
              {pack.captured ? t('packDetail.facts.captured') : market ? (market.version ? t('packDetail.facts.marketVersion', { version: market.version }) : t('packDetail.facts.market')) : pack.sourceArchive}
            </dd>
            {(pack.reshadePresets?.length ?? 0) > 0 && (
              <>
                <dt>{t('packDetail.facts.preset')}</dt>
                <dd>
                  {pack.reshadePresets!.length > 1 ? (
                    <select
                      className="preset-select"
                      value={pack.reshadePreset ?? ''}
                      disabled={!!task}
                      title={active ? t('packDetail.facts.presetNextInstall') : t('packDetail.facts.presetAuto')}
                      onChange={(e) => void run(() => window.api.setReshadePreset(pack.id, e.target.value))}
                    >
                      {pack.reshadePresets!.map((p) => (
                        <option key={p} value={p}>
                          {p.split('/').pop()!.replace(/\.ini$/i, '')}
                          {presetCost(p)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="ellipsis" title={t('packDetail.facts.presetAuto')}>
                      {pack.reshadePresets![0].split('/').pop()!.replace(/\.ini$/i, '')}
                      {presetCost(pack.reshadePresets![0])}
                    </span>
                  )}
                </dd>
              </>
            )}
            <PerfFacts perf={installedPerf} />
          </dl>

          {gone && <p className="hint">{t('packDetail.gone')}</p>}
          {pack.protected && <p className="hint">{t(pack.kind === 'mod' ? 'common.protectedMod' : 'common.protectedPack')}</p>}

          <div className="side-links">
            {market && !gone && (
              <button onClick={() => onOpenMarket(market.id)} title={t('packDetail.rateTitle')}>
                {t('packDetail.rate')}
              </button>
            )}
            {!pack.protected && <button onClick={() => void run(() => window.api.openPackFolder(pack.id))}>{t('packDetail.openFolder')}</button>}
            <button
              className="more"
              aria-label={t('packDetail.moreOptions')}
              title={t('packDetail.moreOptions')}
              onClick={async () => {
                if (await packMenuAction(pack, run)) setRenaming(true)
              }}
            >
              ⋯
            </button>
          </div>
        </aside>
      </div>

      {pack.description?.trim() && (
        <>
          <div className="section-head">
            <h2>{t('packDetail.description')}</h2>
          </div>
          <Markdown text={pack.description} />
        </>
      )}

      <Compatibility insights={pack.insights ?? []} build={build} />

      <div className="section-head">
        <h2>{t('packDetail.content.title')}</h2>
        {modified && (
          <button onClick={() => void run(() => window.api.updatePack(pack.id, { resetComponents: true }))} disabled={active}>
            {t('packDetail.content.reset')}
          </button>
        )}
      </div>
      <ul className="list">
        {pack.components.map((c) => (
          <ComponentRow
            key={c.id}
            packId={pack.id}
            c={c}
            locked={active || !!task}
            cost={(() => {
              // Dossier optionnel analysé : son surcoût, compté dans le verdict quand il est activé.
              const o = report && perfCtx ? optionFor(report, c.source) : null
              return o && perfCtx ? optionCostText(perfCtx, o.summary) : null
            })()}
          />
        ))}
      </ul>
      {active && <p className="hint">{t('packDetail.content.lockedHint')}</p>}

      {pack.userConfigCount > 0 && (
        <div className="section-note">
          <span>{t('packDetail.userConfigs', { count: pack.userConfigCount, n: num(pack.userConfigCount) })}</span>
          <button onClick={() => void run(() => window.api.resetUserConfigs(pack.id))}>{t('packDetail.resetUserConfigs')}</button>
        </div>
      )}
    </div>
  )
}

function Compatibility({ insights, build }: { insights: Insight[]; build: number | null }) {
  const { t } = useTranslation()
  if (!insights.length) return null
  const isRpf = (i: Insight): boolean => /\.rpf$/i.test(i.rel)
  const rpfOk = insights.filter((i) => isRpf(i) && levelOf(i, build) === 'ok')
  const signed = rpfOk.filter((i) => (i.textMsg ? i.textMsg.key === 'insights.checks.rpfCfx' : /Cfx/.test(i.text))).length
  const rows: { title: string; level: Level; text: string }[] = []
  if (rpfOk.length)
    rows.push({
      title: t('packDetail.compat.rpfTitle', { count: rpfOk.length, n: num(rpfOk.length) }),
      level: 'ok',
      text: signed ? t('packDetail.compat.validSigned', { count: signed, n: num(signed) }) : t('packDetail.compat.valid')
    })
  for (const i of insights) {
    if (isRpf(i) && levelOf(i, build) === 'ok') continue
    const level = levelOf(i, build)
    const text = i.builds?.length && build ? asiBuildText(i.builds, build) : i.text
    rows.push({ title: i.title, level, text })
  }
  const rank: Record<Level, number> = { bad: 0, warn: 1, ok: 2, info: 3 }
  rows.sort((a, b) => rank[a.level] - rank[b.level])

  return (
    <>
      <div className="section-head">
        <h2>{t('packDetail.compat.title')}</h2>
      </div>
      <ul className="list compact">
        {rows.map((r, k) => (
          <li key={k} className="row">
            <span className="ins-title">{r.title}</span>
            <span className={`ins-level level-${r.level}`}>{LEVEL_LABEL[r.level]}</span>
            <span className="ins-text">{r.text}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

function ComponentRow({ packId, c, locked, cost }: { packId: string; c: PackComponent; locked: boolean; cost: string | null }) {
  const { t } = useTranslation()
  const { run } = useStore()
  const [files, setFiles] = useState<ComponentFile[] | null>(null)
  const [open, setOpen] = useState(false)

  const options = destinations()
  for (const extra of [c.suggested, c.destination]) {
    if (extra && !options.some((o) => o.key === keyOf(extra))) options.splice(options.length - 1, 0, { key: keyOf(extra), label: labelOf(extra), dest: extra })
  }

  const toggle = async (): Promise<void> => {
    if (!open && !files) setFiles((await run(() => window.api.getComponentFiles(packId, c.id))) ?? [])
    setOpen(!open)
  }
  const setDest = (key: string): void => {
    const opt = options.find((o) => o.key === key)
    if (!opt) return
    setFiles(null)
    setOpen(false)
    void run(() => window.api.updatePack(packId, { components: [{ id: c.id, destination: opt.dest }] }))
  }

  return (
    <li className={`comp ${c.enabled && c.destination ? '' : 'is-off'}`}>
      <div className="row">
        <input
          type="checkbox"
          checked={c.enabled && !!c.destination}
          disabled={locked || !c.destination}
          onChange={(e) => void run(() => window.api.updatePack(packId, { components: [{ id: c.id, enabled: e.target.checked }] }))}
          aria-label={t('packDetail.content.installPart')}
        />
        <button className="comp-label" onClick={() => void toggle()} title={t('packDetail.content.showFiles')}>
          <span className="chevron">{open ? '▾' : '▸'}</span>
          <span className="row-main">
            <span className="name">{c.label}</span>
            <span className="meta">
              {t('packDetail.content.files', { count: c.fileCount, n: num(c.fileCount) })} · {bytes(c.size)}
              {c.kind === 'unknown'
                ? ` · ${t('packDetail.content.unknown')}`
                : c.kind === 'unsupported'
                  ? ` · ${t('packDetail.content.unsupported')}`
                  : c.optional
                    ? ` · ${t('packDetail.content.optional')}`
                    : ''}
              {cost && <span title={t('packDetail.content.costTitle')}> · {cost}</span>}
            </span>
          </span>
        </button>
        <select value={keyOf(c.destination)} onChange={(e) => setDest(e.target.value)} disabled={locked}>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {open && files && (
        <div className="files">
          {files.slice(0, 300).map((f) => (
            <div key={f.rel} className="file">
              <span className="file-src">{f.rel}</span>
              <span className="file-dst">{f.dest ?? t('packDetail.content.notInstalled')}</span>
            </div>
          ))}
          {files.length > 300 && <div className="file">{t('packDetail.content.moreFiles', { count: files.length - 300, n: num(files.length - 300) })}</div>}
        </div>
      )}
    </li>
  )
}
