// Machine de l'utilisateur (panneau « Ma configuration ») et coûts des options d'un pack ramenés à cette machine.
// Le calcul se fait ici (shared/performance.ts) : la configuration de la machine n'est pas envoyée à l'API.
import { useEffect, useState, useSyncExternalStore } from 'react'
import i18next, { t } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { HardwareOverride, Machine, MachineProfile, PackPerformance, PerformanceDetail } from '@shared/performance'
import { costOnMachine, machineOf } from '@shared/performance'
import type { MarketKind } from '@shared/types'
import { cleanError } from '../store'
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

function resolutionText(m: Machine): string {
  return m.width && m.height ? `${m.width} × ${m.height}` : m.resolution.key
}

// ---------------------------------------------------------------------------
// Analyse d'un pack de la Marketplace

/** Analyses déjà lues, par fiche et par langue : une fiche rouverte affiche la sienne tout de suite (puis la relit). */
const detailCache = new Map<string, PerformanceDetail | null>()

/** Analyse détaillée (GET /…/performance) ; undefined pendant le chargement, null si l'API ne la fournit pas. */
export function usePerformanceDetail(id: string | null | undefined, kind: MarketKind): PerformanceDetail | null | undefined {
  const { i18n } = useTranslation()
  const [detail, setDetail] = useState<{ id: string; value: PerformanceDetail | null } | null>(null)
  const key = `${kind}:${id}:${i18n.language}`
  // Analyse traduite par l'API : relue au changement de langue.
  useEffect(() => {
    if (!id) return
    let live = true
    window.api.marketPerformance(id, kind).then(
      (value) => {
        detailCache.set(key, value)
        if (live) setDetail({ id, value })
      },
      () => live && setDetail({ id, value: null })
    )
    return () => {
      live = false
    }
  }, [id, kind, key])
  if (!id) return null
  return detail?.id === id ? detail.value : detailCache.get(key)
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
