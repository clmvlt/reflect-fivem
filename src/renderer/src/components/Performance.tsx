// Poids des packs et des mods sur les performances, comparé à la machine de l'utilisateur : badges des cartes, verdict
// et détail des fiches, confirmation avant d'installer un pack trop lourd, et panneau « Ma configuration ».
// La comparaison se fait ici (shared/performance.ts) : la configuration de la machine n'est pas envoyée à l'API.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import i18next, { t } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { HardwareOverride, Machine, MachineProfile, PackPerformance, PerfEstimate, PerformanceDetail } from '@shared/performance'
import { costOnMachine, estimate, machineOf, tierLabel, VERDICT_LABEL } from '@shared/performance'
import type { MarketKind } from '@shared/types'
import { cleanError } from '../store'
import { q } from '../lib/format'
import { formatNumber } from '@shared/intl'

// ---------------------------------------------------------------------------
// Machine et modèle, lus une fois puis partagés par toute l'interface

export interface PerfContext {
  profile: MachineProfile
  machine: Machine
}

let current: PerfContext | null = null
let loading: Promise<void> | null = null
/** Changé avec la langue : une réponse demandée dans l'ancienne langue n'est pas gardée. */
let generation = 0
const listeners = new Set<() => void>()

function publish(profile: MachineProfile): void {
  current = { profile, machine: machineOf(profile) }
  listeners.forEach((l) => l())
}

function load(): void {
  const gen = generation
  loading ??= window.api.machineProfile().then(
    (profile) => {
      if (gen === generation) publish(profile)
    },
    () => {
      // Échec passager : nouvel essai au prochain affichage.
      if (gen === generation) loading = null
    }
  )
}

// Langue changée : le modèle (libellés des niveaux et des classes de cartes, traduits par l'API) est redemandé.
i18next.on('languageChanged', () => {
  generation++
  current = null
  loading = null
  listeners.forEach((l) => l())
  if (listeners.size) load()
})

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Machine de l'utilisateur et modèle de comparaison (null tant qu'ils ne sont pas chargés). */
export function usePerformance(): PerfContext | null {
  const { i18n } = useTranslation()
  useEffect(load, [i18n.language])
  return useSyncExternalStore(subscribe, () => current)
}

/** Nouvelle détection de la carte graphique, ou correction à la main. */
async function updateProfile(fn: () => Promise<MachineProfile>): Promise<void> {
  publish(await fn())
}

// ---------------------------------------------------------------------------
// Textes

/** Mémoire en Mo : « 512 Mo », « 8 Go », « 1,5 Go » (« 512 MB », « 8 GB »). */
export function memText(mb: number): string {
  if (mb < 1024) return t('format.bytes.mb', { value: formatNumber(Math.round(mb)) })
  return t('format.bytes.gb', { value: formatNumber(mb / 1024, { maximumFractionDigits: 1 }) })
}

export function msText(ms: number): string {
  return t('performance.units.ms', { value: formatNumber(ms, { maximumFractionDigits: ms < 10 ? 1 : 0 }) })
}

/** Images par seconde estimées, arrondies (ce n'est qu'un ordre de grandeur). */
export function fpsText(fps: number): string {
  if (fps >= 200) return t('performance.fps.over', { value: formatNumber(200) })
  return t('performance.fps.about', { value: formatNumber(Math.max(5, Math.round(fps / 5) * 5)) })
}

function resolutionText(m: Machine): string {
  return m.width && m.height ? `${m.width} × ${m.height}` : m.resolution.key
}

/** Pourquoi ce verdict, en une ou deux phrases. */
export function verdictReasons(ctx: PerfContext, est: PerfEstimate): string[] {
  const { model } = ctx.profile
  const m = ctx.machine
  const out: string[] = []
  if (est.verdict === 'not-analyzed') return [t('performance.reasons.notAnalyzed')]
  if (est.verdict === 'unknown') return [t('performance.reasons.unknown')]
  const vramShort = est.vram && m.vramMb !== null && m.vramMb < (est.verdict === 'too-heavy' ? est.vram.min : est.vram.recommended)
  // Seuils du modèle : 25 ms = 40 images par seconde, 16,7 ms = 60.
  const playable = Math.round(1000 / model.minFrameMs)
  const target = Math.round(1000 / model.targetFrameMs)
  if (est.frameMs !== null) {
    const resolution = resolutionText(m)
    if (est.frameMs > model.minFrameMs) out.push(t('performance.reasons.belowPlayable', { fps: formatNumber(playable), resolution }))
    else if (est.frameMs > model.targetFrameMs)
      out.push(t('performance.reasons.belowTarget', { min: formatNumber(playable), max: formatNumber(target), resolution }))
  }
  if (vramShort && est.vram)
    out.push(
      est.verdict === 'too-heavy'
        ? t('performance.reasons.vramShort', { needed: memText(est.vram.min), card: memText(m.vramMb!) })
        : t('performance.reasons.vramTight', { needed: memText(est.vram.recommended), card: memText(m.vramMb!) })
    )
  if (est.gpuUnknown) out.push(t('performance.reasons.gpuUnknown'))
  if (est.vramUnknown) out.push(t('performance.reasons.vramUnknown'))
  return out
}

// ---------------------------------------------------------------------------
// Badges et verdict

/** Infobulle d'un verdict : niveau du pack, FPS estimés, raisons. */
function verdictTitle(ctx: PerfContext, perf: PackPerformance, est: PerfEstimate): string {
  return [
    t('performance.title.tier', { tier: tierLabel(ctx.profile.model, perf.tier) }),
    est.fps !== null && t('performance.title.fps', { fps: fpsText(est.fps) }),
    ...verdictReasons(ctx, est)
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Verdict pour la machine, discret (point de couleur et un mot), sur les cartes de la Marketplace ; le détail est dans
 * l'infobulle. Rien pour un pack pas encore analysé, une machine inconnue ou une API sans ce champ.
 */
export function PerfBadge({ perf }: { perf: PackPerformance | null | undefined }) {
  useTranslation()
  const ctx = usePerformance()
  if (!perf || !ctx) return null
  const est = estimate(ctx.profile.model, ctx.machine, perf)
  if (est.verdict === 'unknown' || est.verdict === 'not-analyzed') return null
  return (
    <span className={`perf-tag v-${est.verdict}`} title={verdictTitle(ctx, perf, est)}>
      {VERDICT_LABEL[est.verdict]}
    </span>
  )
}

/**
 * Confirmation avant d'installer un pack (ou un mod) trop lourd pour la machine. Ne bloque jamais : l'utilisateur peut
 * continuer. Renvoie true s'il faut installer.
 */
export function usePerfConfirm(): (item: { name: string; kind: MarketKind; performance?: PackPerformance | null }, okLabel: string) => Promise<boolean> {
  const ctx = usePerformance()
  return useCallback(
    async (item, okLabel) => {
      if (!ctx || !item.performance) return true
      const est = estimate(ctx.profile.model, ctx.machine, item.performance)
      if (est.verdict !== 'too-heavy') return true
      return window.api.confirm(
        t('performance.confirm.title', { name: q(item.name) }),
        t('performance.confirm.message', { reasons: verdictReasons(ctx, est).join(' ') }),
        okLabel
      )
    },
    [ctx]
  )
}

/** « Sur votre PC : Fluide · ≈ 80 FPS », une ligne de la liste des caractéristiques d'une fiche. */
export function PerfFacts({ perf }: { perf: PackPerformance | null | undefined }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  if (!perf || !ctx) return null
  const est = estimate(ctx.profile.model, ctx.machine, perf)
  if (est.verdict === 'unknown') return null
  return (
    <>
      <dt>{t('performance.facts.onYourPc')}</dt>
      <dd title={verdictTitle(ctx, perf, est)}>
        <span className={`perf-tag v-${est.verdict}`}>{VERDICT_LABEL[est.verdict]}</span>
        {est.fps !== null && <span className="muted">&nbsp;· {fpsText(est.fps)}</span>}
      </dd>
    </>
  )
}

// ---------------------------------------------------------------------------
// Détail d'une fiche de la Marketplace

/** Analyse détaillée (GET /…/performance) ; undefined pendant le chargement, null si l'API ne la fournit pas. */
export function usePerformanceDetail(id: string | null | undefined, kind: MarketKind): PerformanceDetail | null | undefined {
  const { i18n } = useTranslation()
  const [detail, setDetail] = useState<{ id: string; value: PerformanceDetail | null } | null>(null)
  // Analyse traduite par l'API : relue au changement de langue.
  useEffect(() => {
    if (!id) return
    let live = true
    window.api.marketPerformance(id, kind).then(
      (value) => live && setDetail({ id, value }),
      () => live && setDetail({ id, value: null })
    )
    return () => {
      live = false
    }
  }, [id, kind, i18n.language])
  if (!id) return null
  return detail?.id === id ? detail.value : undefined
}

/**
 * « Pourquoi ? » sous le verdict d'une fiche de la Marketplace, replié par défaut : raisons, mémoire vidéo comparée à
 * celle de la carte, et les points principaux de l'analyse.
 */
export function PerfDetails({ id, kind, perf }: { id: string; kind: MarketKind; perf: PackPerformance | null | undefined }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  const detail = usePerformanceDetail(perf ? id : null, kind)
  if (!perf || !ctx) return null
  const est = estimate(ctx.profile.model, ctx.machine, perf)
  if (est.verdict === 'unknown') return null
  const reasons = verdictReasons(ctx, est)
  const highlights = (detail?.report?.highlights ?? []).slice(0, 3)
  const vram = ctx.machine.vramMb
  return (
    <details className="perf-more">
      <summary>{t('performance.details.summary')}</summary>
      {reasons.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      {est.vram && (
        <p>
          {vram !== null
            ? t('performance.details.vramWithCard', { min: memText(est.vram.min), card: memText(vram) })
            : t('performance.details.vram', { min: memText(est.vram.min) })}
        </p>
      )}
      {highlights.length > 0 && (
        <ul>
          {highlights.map((h, i) => (
            <li key={i}>{h.text}</li>
          ))}
        </ul>
      )}
      <p className="muted">
        {kind === 'mod'
          ? perf.estimated
            ? t('performance.details.sourceModPartial')
            : t('performance.details.sourceMod')
          : perf.estimated
            ? t('performance.details.sourcePackPartial')
            : t('performance.details.sourcePack')}
      </p>
    </details>
  )
}

/** Surcoût d'une option : temps par image sur la machine, et mémoire vidéo. */
export function optionCostText(ctx: PerfContext, option: PackPerformance): string {
  const ms = costOnMachine(ctx.profile.model, ctx.machine, option.effectsMs, option.worldMs)
  return [ms >= 0.05 && `+${msText(ms)}`, option.vramMb > 0 && `+${memText(option.vramMb)}`].filter(Boolean).join(', ') || t('performance.option.negligible')
}

// ---------------------------------------------------------------------------
// Réglages graphiques : « Ma configuration »

const VRAM_CHOICES = [2, 3, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32]

export function MachinePanel() {
  const { t } = useTranslation()
  const ctx = usePerformance()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async (fn: () => Promise<MachineProfile>): Promise<void> => {
    setBusy(true)
    try {
      await updateProfile(fn)
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }
  const setOverride = (o: HardwareOverride): void => void apply(() => window.api.setMachineOverride(o))

  if (!ctx)
    return (
      <section>
        <div className="section-head">
          <h2>{t('hardware.title')}</h2>
        </div>
        <p className="muted">{t('hardware.detecting')}</p>
      </section>
    )

  const { model, hardware, override } = ctx.profile
  const m = ctx.machine
  const detected = hardware.gpu
  const cls = m.gpuClass === null ? null : model.gpuClasses.find((c) => c.level === m.gpuClass)
  const detectedVram = detected?.vramMb ?? null

  return (
    <section>
      <div className="section-head">
        <h2>{t('hardware.title')}</h2>
        <button onClick={() => void apply(() => window.api.refreshMachine())} disabled={busy}>
          {t('hardware.redetect')}
        </button>
      </div>
      {error && (
        <div className="bar bar-error">
          <span className="bar-text">{error}</span>
        </div>
      )}
      <ul className="list settings-list">
        <li className="row">
          <div className="row-main">
            <div>{t('hardware.gpu.title')}</div>
            <div className="meta meta-wrap">
              {detected ? detected.name : t('hardware.gpu.notDetected')}
              {cls
                ? ` · ${m.mobile ? t('hardware.gpu.classMobile', { label: cls.label }) : cls.label}`
                : detected
                  ? ` · ${t('hardware.gpu.unrecognized')}`
                  : ''}
              {override.gpuClass != null && ` · ${t('hardware.manual')}`}
            </div>
          </div>
          <select
            value={override.gpuClass ?? ''}
            disabled={busy}
            onChange={(e) => setOverride({ gpuClass: e.target.value === '' ? null : Number(e.target.value) })}
            aria-label={t('hardware.gpu.classLabel')}
            title={cls?.examples}
          >
            <option value="">
              {m.gpuClassSource === 'manual' || !detected
                ? t('hardware.auto')
                : cls
                  ? t('hardware.gpu.detectedAs', { label: cls.label })
                  : t('hardware.gpu.detectedUnknown')}
            </option>
            {model.gpuClasses.map((c) => (
              <option key={c.level} value={c.level} title={c.examples}>
                {c.label} ({c.examples.split(',')[0]})
              </option>
            ))}
          </select>
        </li>
        <li className="row">
          <div className="row-main">
            <div>{t('hardware.vram.title')}</div>
            <div className="meta meta-wrap">
              {m.vramMb !== null ? memText(m.vramMb) : t('hardware.vram.unknown')}
              {m.vramSource === 'manual'
                ? ` · ${t('hardware.manual')}`
                : detected?.source === 'wmi' && detectedVram
                  ? ` · ${t('hardware.vram.wmi', { limit: memText(4096) })}`
                  : ''}
            </div>
          </div>
          <select
            value={override.vramMb ?? ''}
            disabled={busy}
            onChange={(e) => setOverride({ vramMb: e.target.value === '' ? null : Number(e.target.value) })}
            aria-label={t('hardware.vram.title')}
          >
            <option value="">{detectedVram !== null ? t('hardware.vram.detected', { size: memText(detectedVram) }) : t('hardware.auto')}</option>
            {override.vramMb != null && !VRAM_CHOICES.some((g) => g * 1024 === override.vramMb) && (
              <option value={override.vramMb}>{memText(override.vramMb)}</option>
            )}
            {VRAM_CHOICES.map((g) => (
              <option key={g} value={g * 1024}>
                {memText(g * 1024)}
              </option>
            ))}
          </select>
        </li>
        <li className="row">
          <div className="row-main">
            <div>{t('hardware.ram')}</div>
          </div>
          <span className="muted">{memText(m.ramMb)}</span>
        </li>
        <li className="row">
          <div className="row-main">
            <div>{t('hardware.resolution.title')}</div>
            <div className="meta meta-wrap">
              {hardware.screen?.source === 'game'
                ? t('hardware.resolution.game')
                : hardware.screen
                  ? t('hardware.resolution.display')
                  : t('hardware.resolution.unknown')}
            </div>
          </div>
          <span className="muted">
            {resolutionText(m)} ({m.resolution.key})
          </span>
        </li>
      </ul>
      <p className="hint">{t('hardware.hint')}</p>
    </section>
  )
}
