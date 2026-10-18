// « Créer ton pack » : le joueur connecté compose son propre pack en choisissant chaque élément (route, végétation,
// sang, preset ReShade, base QuantV...) parmi ceux de tous les packs de la Marketplace, règle son ReShade, enregistre
// ses créations sur son compte et les installe comme n'importe quel pack de la bibliothèque. Assistant par étapes (les
// groupes du catalogue, puis le récapitulatif), avec un panneau qui résume la composition, son poids sur ce PC et ses
// problèmes, revérifiés par l'API 400 ms après chaque changement.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BuilderBase,
  BuilderBuild,
  BuilderBuildSummary,
  BuilderCatalog,
  BuilderCategory,
  BuilderComponentCard,
  BuilderComponentDetail,
  BuilderPerformance,
  BuilderPreset,
  BuilderPreview,
  BuilderProblem,
  BuilderReshade,
  BuilderSaveInput,
  PackManifest
} from '@shared/types'
import { SIGNED_OUT } from '@shared/api'
import { EMBEDDED_PERFORMANCE_MODEL, estimate, tierLabel, VERDICT_LABEL, type PackPerformance } from '@shared/performance'
import { apiError, cleanError, useStore } from '../store'
import { builderImageUrl, bytes, longDate, num, q } from '../lib/format'
import {
  BASE_CATEGORY,
  cardIndex,
  conflictsOf,
  draftOf,
  keepCommonControls,
  missingBases,
  NAME_MAX,
  newDraft,
  RESHADE,
  RESHADE_SETTINGS,
  snapshot,
  SUMMARY,
  toggle,
  type CardRef,
  type Draft
} from '../lib/builder'
import { Cover, EmptyState } from './common'
import { confirmDialog } from './Confirm'
import { DownloadInline, useDownload } from './Downloads'
import { Gallery } from './Gallery'
import { useInstallTarget } from './InstallTarget'
import { Markdown } from './Markdown'
import { popupMenu } from './Menu'
import { Modal } from './Modal'
import { memText, usePerfConfirm, usePerformance, verdictReasons } from './Performance'
import { ReshadePanel, reshadeChanges } from './BuilderReshade'

/** Création à ouvrir depuis une autre page (fiche d'un pack, file des téléchargements). */
export interface BuilderRequest {
  buildId: string
  at: number
}

/** Créations par compte (limite de l'API). */
const MAX_BUILDS = 50

interface WizardState {
  draft: Draft
  saved: string
  step: string | null
  tabs: Record<string, string>
}

/** Assistant en cours quand on passe à une autre page de l'application : retrouvé au retour. */
let kept: (WizardState & { account: number }) | null = null
/** Catalogues déjà lus, par langue : la page s'affiche tout de suite à son retour (puis le catalogue est revérifié). */
const catalogs = new Map<string, BuilderCatalog>()
/** Presets déjà lus, par composant et par langue. */
const presets = new Map<string, BuilderPreset>()

/** Pack de la bibliothèque construit à partir de la création (le plus récent). */
export function builtPack(library: PackManifest[], buildId: string | null): PackManifest | null {
  if (!buildId) return null
  return library.filter((p) => p.built?.buildId === buildId).sort((a, b) => b.built!.builtAt.localeCompare(a.built!.builtAt))[0] ?? null
}

/** Icône de la page : des calques et un « + ». */
export function BuilderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 1.8 1.5 4.6 7 7.4l5.5-2.8z" />
      <path d="m1.5 8 5.5 2.8 2-1" />
      <path d="m1.5 11.3 5.5 2.8 2-1" />
      <path d="M12.5 9v5.5M9.75 11.75h5.5" />
    </svg>
  )
}

export function Builder({ request, onSignIn, onOpenLocal }: { request: BuilderRequest | null; onSignIn: () => void; onOpenLocal: (packId: string) => void }) {
  const { account } = useStore()
  if (account === undefined) return null
  if (!account) return <SignInPanel onSignIn={onSignIn} />
  return <BuilderPage key={account.id} account={account.id} request={request} onSignIn={onSignIn} onOpenLocal={onOpenLocal} />
}

/** Sans compte : ce que fait la page, et la connexion (retour ici ensuite). */
function SignInPanel({ onSignIn, expired = false }: { onSignIn: () => void; expired?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('builder.title')}</h1>
      </header>
      <section className="builder-welcome">
        <div className="builder-welcome-icon">
          <BuilderIcon size={30} />
        </div>
        <h2>{t('builder.signIn.title')}</h2>
        <p>{expired ? t('builder.signIn.expired') : t('builder.signIn.text')}</p>
        <ul className="builder-welcome-points">
          <li>{t('builder.signIn.choose')}</li>
          <li>{t('builder.signIn.tune')}</li>
          <li>{t('builder.signIn.install')}</li>
        </ul>
        <button className="primary" onClick={onSignIn}>
          {t('builder.signIn.action')}
        </button>
        <p className="hint">{t('builder.signIn.appOnly')}</p>
      </section>
    </div>
  )
}

/** Catalogue : copie déjà lue (ou celle du disque) tout de suite, puis revérifié auprès de l'API (304 : rien ne change). */
function useCatalog(): { catalog: BuilderCatalog | null; error: { message: string; code: string | null } | null; reload: () => void } {
  const { i18n } = useTranslation()
  const lang = i18n.language
  const [catalog, setCatalog] = useState<BuilderCatalog | null>(() => catalogs.get(lang) ?? null)
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    const show = (c: BuilderCatalog): void => {
      catalogs.set(lang, c)
      if (live) {
        setCatalog(c)
        setError(null)
      }
    }
    void (async () => {
      try {
        const known = catalogs.get(lang)
        const first = known ?? (await window.api.builderCatalog(false))
        show(first)
        if (known || !first.checked) show(await window.api.builderCatalog(true))
      } catch (e) {
        if (live) setError(apiError(e))
      }
    })()
    return () => {
      live = false
    }
  }, [lang, attempt])
  return { catalog, error, reload: () => setAttempt((a) => a + 1) }
}

type View = { kind: 'home' } | { kind: 'new' } | { kind: 'open'; id: string } | { kind: 'kept' }

function BuilderPage({ account, request, onSignIn, onOpenLocal }: { account: number; request: BuilderRequest | null; onSignIn: () => void; onOpenLocal: (packId: string) => void }) {
  const { t } = useTranslation()
  const { catalog, error, reload } = useCatalog()
  const resume = kept?.account === account ? kept : null
  const [view, setView] = useState<View>(() =>
    request ? (resume?.draft.id === request.buildId ? { kind: 'kept' } : { kind: 'open', id: request.buildId }) : resume ? { kind: 'kept' } : { kind: 'home' }
  )
  // Connexion expirée ou session refusée : invitation à se reconnecter.
  if (error?.code === SIGNED_OUT) return <SignInPanel onSignIn={onSignIn} expired />
  if (!catalog)
    return (
      <div className="page">
        <header className="page-head">
          <h1>{t('builder.title')}</h1>
        </header>
        {error ? (
          <div className="empty-state">
            <p>{error.message}</p>
            <p>
              <button onClick={reload}>{t('common.retry')}</button>
            </p>
          </div>
        ) : (
          <p className="muted loading">{t('common.loading')}</p>
        )}
      </div>
    )
  const home = (): void => {
    kept = null
    setView({ kind: 'home' })
  }
  const common = { catalog, account, onExit: home, onOpenLocal }
  if (view.kind === 'open') return <BuildLoader key={view.id} id={view.id} {...common} />
  if (view.kind === 'new') {
    const draft = newDraft(t('builder.newName'))
    return <Wizard {...common} start={{ draft, saved: snapshot(draft), step: null, tabs: {} }} />
  }
  if (view.kind === 'kept' && resume) return <Wizard {...common} start={resume} />
  return <Home catalog={catalog} onNew={() => setView({ kind: 'new' })} onOpen={(id) => setView({ kind: 'open', id })} onOpenLocal={onOpenLocal} />
}

// ---------------------------------------------------------------------------
// Accueil : nouveau pack, mes créations

function Home({ catalog, onNew, onOpen, onOpenLocal }: { catalog: BuilderCatalog; onNew: () => void; onOpen: (id: string) => void; onOpenLocal: (packId: string) => void }) {
  const { t } = useTranslation()
  const [builds, setBuilds] = useState<BuilderBuildSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setBuilds(await window.api.builderBuilds())
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }, [])
  useEffect(() => {
    void load()
    // Révisions revérifiées à l'ouverture de la page : un composant mis à jour se propose comme une nouvelle version.
    window.api.builderStatus().then(
      () => undefined,
      () => undefined
    )
  }, [load])
  const full = (builds?.length ?? 0) >= MAX_BUILDS

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('builder.title')}</h1>
        {builds && <span className="page-note">{t('builder.home.count', { n: num(builds.length), max: num(MAX_BUILDS) })}</span>}
        <div className="spacer" />
        <button className="primary" onClick={onNew} disabled={full} title={full ? t('builder.home.full', { max: num(MAX_BUILDS) }) : undefined}>
          {t('builder.home.new')}
        </button>
      </header>
      {catalog.offline && (
        <div className="bar">
          <span className="bar-text">{t('builder.offline')}</span>
        </div>
      )}
      <p className="builder-lead">{t('builder.home.intro')}</p>
      <div className="section-head">
        <h2>{t('builder.home.mine')}</h2>
      </div>
      {error ? (
        <div className="empty-state">
          <p>{error}</p>
          <p>
            <button onClick={() => void load()}>{t('common.retry')}</button>
          </p>
        </div>
      ) : !builds ? (
        <p className="muted loading">{t('common.loading')}</p>
      ) : (
        <div className="grid">
          <article className={`card add-card ${full ? 'is-disabled' : 'clickable'}`} onClick={full ? undefined : onNew}>
            <div className="add-icon" aria-hidden>
              <BuilderIcon size={22} />
            </div>
            <div className="name">{t('builder.home.newTitle')}</div>
            <p className="add-text">{full ? t('builder.home.full', { max: num(MAX_BUILDS) }) : t('builder.home.newText')}</p>
          </article>
          {builds.map((b) => (
            <BuildCard key={b.id} build={b} onOpen={() => onOpen(b.id)} onOpenLocal={onOpenLocal} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Composition enregistrée telle quelle, sans les composants retirés (refusés à l'enregistrement). */
async function savedInput(id: string, name: string): Promise<BuilderSaveInput> {
  const b = await window.api.builderBuildGet(id)
  return { name, components: b.components.filter((c) => c.available && c.id).map((c) => c.id!), reshade: b.reshade }
}

function BuildCard({ build, onOpen, onOpenLocal, onChanged }: { build: BuilderBuildSummary; onOpen: () => void; onOpenLocal: (packId: string) => void; onChanged: () => void }) {
  const { t } = useTranslation()
  const { overview, run, setMessage } = useStore()
  const dl = useDownload(build.id)
  const [renaming, setRenaming] = useState(false)
  const local = builtPack(overview?.library ?? [], build.id)
  const update = !!local && !!overview?.market.updates.includes(local.id)
  const active = !!local && overview?.state.active?.packId === local.id

  const rename = async (name: string): Promise<void> => {
    setRenaming(false)
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
    if (!clean || clean === build.name) return
    if (await run(async () => window.api.builderBuildSave(build.id, await savedInput(build.id, clean)))) onChanged()
  }
  const menu = async (e?: MouseEvent): Promise<void> => {
    e?.preventDefault()
    e?.stopPropagation()
    const choice = await popupMenu([
      { id: 'open', label: t('builder.home.menu.open') },
      { id: 'rename', label: t('builder.home.menu.rename') },
      { id: 'duplicate', label: t('builder.home.menu.duplicate') },
      { id: 'library', label: t('builder.home.menu.library'), enabled: !!local },
      { id: 'delete', label: t('common.delete'), separator: true, danger: true }
    ])
    if (choice === 'open') onOpen()
    else if (choice === 'rename') setRenaming(true)
    else if (choice === 'library' && local) onOpenLocal(local.id)
    else if (choice === 'duplicate') {
      const name = t('builder.home.copyName', { name: build.name }).slice(0, NAME_MAX)
      const copy = await run(async () => window.api.builderBuildSave(null, await savedInput(build.id, name)))
      if (copy) {
        setMessage({ kind: 'info', text: t('builder.home.duplicated', { name: q(copy.name) }) })
        onChanged()
      }
    } else if (choice === 'delete') {
      const ok = await confirmDialog(t('builder.home.deleteTitle', { name: q(build.name) }), local ? t('builder.home.deleteDetailLocal') : t('builder.home.deleteDetail'), t('common.delete'))
      if (ok && (await run(() => window.api.builderBuildDelete(build.id).then(() => true)))) onChanged()
    }
  }

  const facts = [
    t('builder.home.components', { count: build.componentCount, n: num(build.componentCount) }),
    build.unavailableCount > 0 && t('builder.home.unavailable', { count: build.unavailableCount, n: num(build.unavailableCount) }),
    t('builder.home.updatedAt', { date: longDate(build.updatedAt) })
  ]
  return (
    <article className={`card clickable ${active ? 'is-active' : ''}`} onClick={onOpen} onContextMenu={(e) => void menu(e)}>
      <div className="cover">{local ? <Cover pack={local} /> : <div className="cover-empty">{build.name}</div>}</div>
      <div className="card-body">
        {renaming ? (
          <RenameField value={build.name} onDone={(v) => void rename(v)} onCancel={() => setRenaming(false)} />
        ) : (
          <div className="name" title={build.name}>
            {build.name}
          </div>
        )}
        <div className="meta" title={facts.filter(Boolean).join(' · ')}>
          {facts.filter(Boolean).join(' · ')}
        </div>
        <div className="card-foot" onClick={(e) => e.stopPropagation()}>
          {dl ? (
            <DownloadInline d={dl} />
          ) : (
            <>
              {update ? (
                <span className="accent-text small">{t('builder.home.updateAvailable')}</span>
              ) : (
                <span className="state">{active ? t('builder.home.active') : local ? t('builder.home.inLibrary') : t('builder.home.notInstalled')}</span>
              )}
              <div className="spacer" />
              {update && <button onClick={() => void run(() => window.api.builderInstall(build.id))}>{t('builder.update')}</button>}
              <button className="more" onClick={(e) => void menu(e)} aria-label={t('builder.home.more')} title={t('builder.home.more')}>
                ⋯
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

function RenameField({ value, onDone, onCancel }: { value: string; onDone: (v: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(value)
  return (
    <input
      className="rename"
      autoFocus
      maxLength={NAME_MAX}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(name)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(name)
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

/** Création enregistrée, chargée puis ouverte sur son récapitulatif. */
function BuildLoader({ id, ...rest }: { id: string; catalog: BuilderCatalog; account: number; onExit: () => void; onOpenLocal: (packId: string) => void }) {
  const { t } = useTranslation()
  const [build, setBuild] = useState<BuilderBuild | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setBuild(await window.api.builderBuildGet(id))
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])
  if (!build)
    return (
      <div className="page">
        <div className="back-row">
          <button className="link" onClick={rest.onExit}>
            {t('builder.back')}
          </button>
        </div>
        {error ? (
          <div className="empty-state">
            <p>{error}</p>
            <p>
              <button onClick={() => void load()}>{t('common.retry')}</button>
            </p>
          </div>
        ) : (
          <p className="muted loading">{t('common.loading')}</p>
        )}
      </div>
    )
  const draft = draftOf(build)
  return <Wizard {...rest} start={{ draft, saved: snapshot(draft), step: SUMMARY, tabs: {} }} />
}

// ---------------------------------------------------------------------------
// Assistant

type PreviewState = { data: BuilderPreview | null; loading: boolean; error: string | null }

/** Problèmes et estimation de la composition, demandés à l'API 400 ms après le dernier changement. */
function usePreview(components: string[], reshade: BuilderReshade): PreviewState {
  const { i18n } = useTranslation()
  const key = JSON.stringify({ components, reshade })
  const [state, setState] = useState<PreviewState>({ data: null, loading: false, error: null })
  useEffect(() => {
    const input = JSON.parse(key) as { components: string[]; reshade: BuilderReshade }
    if (!input.components.length) {
      setState({ data: null, loading: false, error: null })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const timer = setTimeout(() => {
      window.api.builderPreview(input.components, input.reshade).then(
        (data) => live && setState({ data, loading: false, error: null }),
        (e) => live && setState((s) => ({ ...s, loading: false, error: cleanError(e) }))
      )
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, i18n.language])
  return state
}

/** Preset ReShade du composant choisi (effets, paramètres, réglages simples). */
function usePreset(id: string | null): { preset: BuilderPreset | null; error: string | null; retry: () => void } {
  const { i18n } = useTranslation()
  const cacheKey = `${id}:${i18n.language}`
  const [state, setState] = useState<{ key: string; preset: BuilderPreset | null; error: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!id) return
    let live = true
    window.api.builderPreset(id).then(
      (preset) => {
        presets.set(cacheKey, preset)
        if (live) setState({ key: cacheKey, preset, error: null })
      },
      (e) => live && setState({ key: cacheKey, preset: null, error: cleanError(e) })
    )
    return () => {
      live = false
    }
  }, [id, cacheKey, attempt])
  if (!id) return { preset: null, error: null, retry: () => undefined }
  const mine = state?.key === cacheKey ? state : null
  return { preset: mine?.preset ?? presets.get(cacheKey) ?? null, error: mine?.error ?? null, retry: () => setAttempt((a) => a + 1) }
}

function Wizard({
  catalog,
  account,
  start,
  onExit,
  onOpenLocal
}: {
  catalog: BuilderCatalog
  account: number
  start: WizardState
  onExit: () => void
  onOpenLocal: (packId: string) => void
}) {
  const { t } = useTranslation()
  const { run, setMessage } = useStore()
  const confirmHeavy = usePerfConfirm()
  const index = useMemo(() => cardIndex(catalog), [catalog])
  const [draft, setDraft] = useState(start.draft)
  const [saved, setSaved] = useState(start.saved)
  const [tabs, setTabs] = useState(start.tabs)
  const [details, setDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Étapes : les groupes qui ont au moins une catégorie non vide (catégories vides masquées), puis le récapitulatif.
  const groups = useMemo(
    () =>
      catalog.groups
        .map((group) => ({
          group,
          categories: group.categories.map((k) => catalog.categories.find((c) => c.key === k)).filter((c): c is BuilderCategory => !!c && c.components.length > 0)
        }))
        .filter((g) => g.categories.length > 0),
    [catalog]
  )
  const steps = [...groups.map((g) => g.group.key), SUMMARY]
  const [step, setStep] = useState(start.step && steps.includes(start.step) ? start.step : steps[0])
  const chosen = draft.components.map((id) => index.get(id)?.card).filter((c): c is BuilderComponentCard => !!c)
  const reshadeId = draft.components.find((id) => index.get(id)?.category.key === RESHADE) ?? null
  const preset = usePreset(reshadeId)
  // Autre preset choisi : ses réglages simples communs gardés une fois le preset lu.
  const [filterFor, setFilterFor] = useState<string | null>(null)
  useEffect(() => {
    const p = preset.preset
    if (!p || filterFor !== p.componentId) return
    setDraft((d) => ({ ...d, reshade: keepCommonControls(d.reshade, p) }))
    setFilterFor(null)
  }, [preset.preset, filterFor])
  const preview = usePreview(draft.components, draft.reshade)
  const dirty = snapshot(draft) !== saved

  useEffect(() => {
    kept = { account, draft, saved, step, tabs }
  }, [account, draft, saved, step, tabs])

  const choose = (category: BuilderCategory, id: string | null): void => {
    const components = toggle(draft.components, index, category, id)
    let reshade = draft.reshade
    if (category.key === RESHADE) {
      const next = components.find((c) => index.get(c)?.category.key === RESHADE) ?? null
      if (next !== reshadeId) {
        // Le mode avancé ne vaut que pour l'ancien preset ; les réglages simples sont triés une fois le nouveau lu.
        reshade = { controls: draft.reshade.controls, techniques: {}, values: {} }
        setFilterFor(next)
      }
    }
    setDraft({ ...draft, components, reshade })
  }
  const remove = (id: string): void => {
    const ref = index.get(id)
    if (ref) choose(ref.category, id)
    else setDraft({ ...draft, components: draft.components.filter((c) => c !== id) })
  }
  /** Ouvre la catégorie (base QuantV manquante...) dans son étape. */
  const goTo = (categoryKey: string): void => {
    const category = catalog.categories.find((c) => c.key === categoryKey && c.components.length)
    if (!category) return
    setStep(category.group)
    setTabs((tb) => ({ ...tb, [category.group]: category.key }))
  }
  const goToBase = (base: BuilderBase): void => goTo(BASE_CATEGORY[base])
  /** Réglages du preset choisi, dans l'étape de sa catégorie. */
  const openReshade = (): void => {
    const category = catalog.categories.find((c) => c.key === RESHADE)
    if (!category) return
    setStep(category.group)
    setTabs((tb) => ({ ...tb, [category.group]: RESHADE_SETTINGS }))
  }
  const leave = async (): Promise<void> => {
    if (dirty && !(await confirmDialog(t('builder.leave.title'), t('builder.leave.detail'), t('builder.leave.ok')))) return
    onExit()
  }
  const input = (): BuilderSaveInput => ({ name: draft.name.trim() || t('builder.newName'), components: draft.components, reshade: draft.reshade })
  const afterSave = (id: string, name: string): void => {
    const next = { ...draft, id, name, removed: [] }
    setDraft(next)
    setSaved(snapshot(next))
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    const b = await run(() => window.api.builderBuildSave(draft.id, input()))
    setBusy(false)
    if (!b) return
    afterSave(b.id, b.name)
    setMessage({ kind: 'info', text: t('builder.saved', { name: q(b.name) }) })
  }
  const install = async (): Promise<void> => {
    const data = input()
    if (!(await confirmHeavy({ name: data.name, kind: 'pack', performance: preview.data?.estimate.performance }, t('builder.summary.installAnyway')))) return
    setBusy(true)
    const id = await run(() => window.api.builderInstall(draft.id, data))
    setBusy(false)
    if (id) afterSave(id, data.name)
  }

  const groupOf = (key: string): (typeof groups)[number] | undefined => groups.find((g) => g.group.key === key)
  const countIn = (categories: BuilderCategory[]): number => draft.components.filter((id) => categories.some((c) => c.key === index.get(id)?.category.key)).length
  const current = groupOf(step)
  const stepIndex = steps.indexOf(step)
  const presetName = reshadeId ? (index.get(reshadeId)?.card.name ?? '') : ''

  return (
    <div className="page builder-page">
      <div className="back-row">
        <button className="link" onClick={() => void leave()}>
          {t('builder.back')}
        </button>
      </div>
      <header className="page-head builder-head">
        <h1 className="ellipsis" title={draft.name}>
          {draft.name.trim() || t('builder.newName')}
        </h1>
        {dirty && <span className="page-note">{t('builder.unsaved')}</span>}
        {catalog.offline && <span className="page-note">{t('builder.offlineShort')}</span>}
      </header>

      <nav className="builder-steps" aria-label={t('builder.stepsLabel')}>
        {steps.map((key, i) => {
          const g = groupOf(key)
          const count = g ? countIn(g.categories) : draft.components.length
          return (
            <button key={key} className={`builder-step ${key === step ? 'is-selected' : ''}`} aria-current={key === step ? 'step' : undefined} onClick={() => setStep(key)}>
              <span className="builder-step-num">{num(i + 1)}</span>
              <span className="builder-step-label">{g ? g.group.label : t('builder.summaryStep')}</span>
              {g && count > 0 && <span className="chip-count">{num(count)}</span>}
            </button>
          )
        })}
      </nav>

      <div className="builder-layout">
        <div className="builder-main">
          {current ? (
            <GroupStep
              categories={current.categories}
              tab={tabs[current.group.key]}
              onTab={(key) => setTabs((tb) => ({ ...tb, [current.group.key]: key }))}
              index={index}
              draft={draft}
              chosen={chosen}
              reshade={
                reshadeId && current.categories.some((c) => c.key === RESHADE) ? (
                  <ReshadePanel
                    preset={preset.preset}
                    name={presetName}
                    error={preset.error}
                    onRetry={preset.retry}
                    reshade={draft.reshade}
                    onChange={(reshade) => setDraft({ ...draft, reshade })}
                  />
                ) : null
              }
              onChoose={choose}
              onDetails={setDetails}
              onBase={goToBase}
              baseLabel={(b) => catalog.categories.find((c) => c.key === BASE_CATEGORY[b])?.label ?? b}
            />
          ) : (
            <Summary
              catalog={catalog}
              index={index}
              draft={draft}
              onName={(name) => setDraft({ ...draft, name })}
              preview={preview}
              dirty={dirty}
              busy={busy}
              onSave={() => void save()}
              onInstall={() => void install()}
              onRemove={remove}
              onDetails={setDetails}
              onBase={goToBase}
              onReshade={openReshade}
              onOpenLocal={onOpenLocal}
            />
          )}
          <div className="builder-nav">
            {stepIndex > 0 && <button onClick={() => setStep(steps[stepIndex - 1])}>{t('builder.previous')}</button>}
            <div className="spacer" />
            {stepIndex < steps.length - 1 && (
              <button className="primary" onClick={() => setStep(steps[stepIndex + 1])}>
                {stepIndex === steps.length - 2 ? t('builder.toSummary') : t('builder.next')}
              </button>
            )}
          </div>
        </div>
        <RecapPanel catalog={catalog} index={index} draft={draft} preview={preview} onBase={goToBase} />
      </div>

      {details && (
        <ComponentModal
          id={details}
          card={index.get(details)?.card ?? null}
          selected={draft.components.includes(details)}
          onToggle={() => {
            const ref = index.get(details)
            if (ref) choose(ref.category, details)
          }}
          onClose={() => setDetails(null)}
        />
      )}
    </div>
  )
}

/** Une étape : une catégorie à la fois (sous-onglets avec le nombre de choix), et les réglages ReShade. */
function GroupStep({
  categories,
  tab,
  onTab,
  index,
  draft,
  chosen,
  reshade,
  onChoose,
  onDetails,
  onBase,
  baseLabel
}: {
  categories: BuilderCategory[]
  tab: string | undefined
  onTab: (key: string) => void
  index: Map<string, CardRef>
  draft: Draft
  chosen: BuilderComponentCard[]
  /** Réglages du preset choisi (étape de la catégorie des presets), null sans preset. */
  reshade: ReactNode
  onChoose: (category: BuilderCategory, id: string | null) => void
  onDetails: (id: string) => void
  onBase: (base: BuilderBase) => void
  baseLabel: (base: BuilderBase) => string
}) {
  const { t } = useTranslation()
  const settings = tab === RESHADE_SETTINGS && !!reshade
  const category = categories.find((c) => c.key === tab) ?? categories[0]
  const countOf = (key: string): number => draft.components.filter((id) => index.get(id)?.category.key === key).length
  const picked = (id: string): boolean => draft.components.includes(id)
  return (
    <>
      <div className="chips builder-tabs" role="tablist">
        {categories.map((c) => {
          const n = countOf(c.key)
          const selected = !settings && c.key === category.key
          return (
            <button key={c.key} role="tab" aria-selected={selected} className={`chip ${selected ? 'is-selected' : ''}`} onClick={() => onTab(c.key)}>
              {c.label}
              {n > 0 && <span className="chip-count">{num(n)}</span>}
            </button>
          )
        })}
        {reshade && (
          <button role="tab" aria-selected={settings} className={`chip chip-settings ${settings ? 'is-selected' : ''}`} onClick={() => onTab(RESHADE_SETTINGS)}>
            {t('builder.reshade.tab')}
          </button>
        )}
      </div>
      {settings ? (
        reshade
      ) : (
        <>
          <p className="hint builder-hint">{category.single ? t('builder.category.single') : t('builder.category.multiple')}</p>
          <div className="grid builder-grid">
            {category.single && (
              <article
                className={`card clickable builder-card builder-none ${countOf(category.key) ? '' : 'is-selected'}`}
                role="button"
                tabIndex={0}
                aria-pressed={!countOf(category.key)}
                onClick={() => onChoose(category, null)}
                onKeyDown={(e) => activate(e, () => onChoose(category, null))}
              >
                <div className="cover">
                  <div className="cover-empty">{t('builder.card.none')}</div>
                  {!countOf(category.key) && <Check />}
                </div>
                <div className="card-body">
                  <div className="name">{t('builder.card.none')}</div>
                  <p className="builder-text">{t('builder.card.noneText', { category: q(category.label) })}</p>
                </div>
              </article>
            )}
            {category.components.map((card) => (
              <ComponentTile
                key={card.id}
                card={card}
                selected={picked(card.id)}
                conflicts={conflictsOf(card, chosen)}
                missing={picked(card.id) ? missingBases(card, chosen) : []}
                baseLabel={baseLabel}
                onChoose={() => onChoose(category, card.id)}
                onDetails={() => onDetails(card.id)}
                onBase={onBase}
              />
            ))}
          </div>
          {reshade && category.key === RESHADE && (
            <div className="builder-callout">
              <span>{t('builder.reshade.callout')}</span>
              <button onClick={() => onTab(RESHADE_SETTINGS)}>{t('builder.reshade.open')}</button>
            </div>
          )}
        </>
      )}
    </>
  )
}

/** Entrée ou Espace sur une carte : comme un clic. */
function activate(e: KeyboardEvent, fn: () => void): void {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
  e.preventDefault()
  fn()
}

function Check() {
  return (
    <span className="builder-check" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m3.5 8.5 3 3 6-7" />
      </svg>
    </span>
  )
}

/** Poids sur les performances : niveau et mémoire vidéo. */
function WeightBadge({ perf }: { perf: BuilderPerformance | null }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  if (!perf) return <span className="meta">{t('builder.card.notAnalyzed')}</span>
  const model = ctx?.profile.model ?? EMBEDDED_PERFORMANCE_MODEL
  return (
    <span className={`builder-tier tier-${perf.tier}`} title={t('builder.card.weightTitle')}>
      {tierLabel(model, perf.tier)}
      {perf.vramMb ? ` · ${memText(perf.vramMb)}` : ''}
    </span>
  )
}

function ComponentTile({
  card,
  selected,
  conflicts,
  missing,
  baseLabel,
  onChoose,
  onDetails,
  onBase
}: {
  card: BuilderComponentCard
  selected: boolean
  conflicts: BuilderComponentCard[]
  missing: BuilderBase[]
  baseLabel: (base: BuilderBase) => string
  onChoose: () => void
  onDetails: () => void
  onBase: (base: BuilderBase) => void
}) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <article
      className={`card clickable builder-card ${selected ? 'is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onChoose}
      onKeyDown={(e) => activate(e, onChoose)}
    >
      <div className="cover">
        {card.cover && !failed ? (
          <img className="cover-img" src={builderImageUrl(card.id, card.cover.id, true)} alt="" draggable={false} onError={() => setFailed(true)} />
        ) : (
          <div className="cover-empty">{card.name}</div>
        )}
        {selected && <Check />}
      </div>
      <div className="card-body">
        <div className="name" title={card.name}>
          {card.name}
        </div>
        {card.summary && <p className="builder-text">{card.summary}</p>}
        {card.credits && (
          <div className="meta" title={card.credits}>
            {t('builder.card.credits', { credits: card.credits })}
          </div>
        )}
        {card.requires.length > 0 && !missing.length && (
          <div className="meta">{t('builder.card.requires', { bases: card.requires.map(baseLabel).join(', ') })}</div>
        )}
        {missing.map((b) => (
          <div key={b} className="builder-note warn-text">
            {t('builder.card.missing', { base: baseLabel(b) })}{' '}
            <button className="link" onClick={stop(() => onBase(b))}>
              {t('builder.card.chooseBase')}
            </button>
          </div>
        ))}
        {conflicts.length > 0 && <div className="builder-note warn-text">{t('builder.card.conflict', { names: conflicts.map((c) => q(c.name)).join(', ') })}</div>}
        {card.unreadable && <div className="meta">{t('builder.card.unreadable')}</div>}
        <div className="card-foot">
          <WeightBadge perf={card.performance} />
          <span className="meta">{bytes(card.size)}</span>
          <div className="spacer" />
          <button onClick={stop(onDetails)}>{t('builder.card.details')}</button>
        </div>
      </div>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Récapitulatif (panneau permanent et dernière étape)

/** Estimation sur ce PC : verdict, mémoire vidéo et raisons (comparaison faite ici, la machine n'est pas envoyée). */
function PcEstimate({ perf }: { perf: PackPerformance | null }) {
  const { t } = useTranslation()
  const ctx = usePerformance()
  if (!perf) return <p className="muted small">{t('builder.recap.notEstimated')}</p>
  if (!ctx) return null
  const est = estimate(ctx.profile.model, ctx.machine, perf)
  const vram = ctx.machine.vramMb
  return (
    <div className="builder-pc">
      <div className="builder-pc-head">
        <span>{t('builder.recap.onThisPc')}</span>
        <span className={`perf-tag v-${est.verdict}`}>{VERDICT_LABEL[est.verdict]}</span>
      </div>
      {est.vram && (
        <p>
          {vram !== null
            ? t('performance.details.vramWithCard', { min: memText(est.vram.min), card: memText(vram) })
            : t('performance.details.vram', { min: memText(est.vram.min) })}
        </p>
      )}
      {verdictReasons(ctx, est).map((r, i) => (
        <p key={i}>{r}</p>
      ))}
    </div>
  )
}

function Problems({ problems, onBase }: { problems: BuilderProblem[]; onBase: (base: BuilderBase) => void }) {
  const { t } = useTranslation()
  if (!problems.length) return null
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  return (
    <ul className="builder-problems">
      {sorted.map((p, i) => (
        <li key={i} className={`builder-problem is-${p.severity}`}>
          <span className={`ins-level level-${p.severity === 'error' ? 'bad' : 'warn'}`}>{p.severity === 'error' ? t('builder.problems.error') : t('builder.problems.warning')}</span>
          <span className="builder-problem-text">
            {p.message || t('builder.problems.generic')}
            {p.requires && (
              <>
                {' '}
                <button className="link" onClick={() => onBase(p.requires!)}>
                  {t('builder.card.chooseBase')}
                </button>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RecapPanel({ catalog, index, draft, preview, onBase }: { catalog: BuilderCatalog; index: Map<string, CardRef>; draft: Draft; preview: PreviewState; onBase: (base: BuilderBase) => void }) {
  const { t } = useTranslation()
  const p = preview.data
  const byGroup = catalog.groups
    .map((g) => ({ label: g.label, names: draft.components.filter((id) => index.get(id)?.category.group === g.key).map((id) => index.get(id)!.card.name) }))
    .filter((g) => g.names.length)
  const unknown = draft.components.filter((id) => !index.has(id)).map((id) => draft.names[id] ?? id)
  return (
    <aside className="builder-recap" aria-label={t('builder.recap.title')}>
      <div className="builder-recap-head">
        <h2>{t('builder.recap.title')}</h2>
        {preview.loading && <span className="muted small">{t('builder.recap.checking')}</span>}
      </div>
      {draft.components.length === 0 ? (
        <p className="muted">{t('builder.recap.empty')}</p>
      ) : (
        <>
          <ul className="builder-recap-list">
            {byGroup.map((g) => (
              <li key={g.label}>
                <span className="muted small">{g.label}</span>
                <span>{g.names.join(', ')}</span>
              </li>
            ))}
            {unknown.length > 0 && (
              <li>
                <span className="muted small">{t('builder.recap.other')}</span>
                <span>{unknown.join(', ')}</span>
              </li>
            )}
          </ul>
          <dl className="facts builder-facts">
            <dt>{t('builder.recap.size')}</dt>
            <dd>{p ? bytes(p.estimate.size) : '—'}</dd>
          </dl>
          {p && <PcEstimate perf={p.estimate.performance} />}
          {preview.error && <p className="warn-text small">{preview.error}</p>}
          {p && <Problems problems={p.problems} onBase={onBase} />}
        </>
      )}
    </aside>
  )
}

function Summary({
  catalog,
  index,
  draft,
  onName,
  preview,
  dirty,
  busy,
  onSave,
  onInstall,
  onRemove,
  onDetails,
  onBase,
  onReshade,
  onOpenLocal
}: {
  catalog: BuilderCatalog
  index: Map<string, CardRef>
  draft: Draft
  onName: (name: string) => void
  preview: PreviewState
  dirty: boolean
  busy: boolean
  onSave: () => void
  onInstall: () => void
  onRemove: (id: string) => void
  onDetails: (id: string) => void
  onBase: (base: BuilderBase) => void
  onReshade: () => void
  onOpenLocal: (packId: string) => void
}) {
  const { t } = useTranslation()
  const { overview } = useStore()
  const dl = useDownload(draft.id)
  const changes = reshadeChanges(draft.reshade)
  const local = builtPack(overview?.library ?? [], draft.id)
  const update = !!local && !!overview?.market.updates.includes(local.id)
  const p = preview.data
  const errors = p?.problems.filter((x) => x.severity === 'error') ?? []
  const unknown = draft.components.filter((id) => !index.has(id))
  const checked = !!p && !preview.loading
  const upToDate = !!local && !dirty && !update
  const installLabel = !local ? t('builder.summary.install') : upToDate ? t('builder.summary.upToDate') : t('builder.update')

  return (
    <section className="builder-summary">
      <label className="field">
        <span className="field-label">{t('builder.summary.name')}</span>
        <input className="input" maxLength={NAME_MAX} value={draft.name} placeholder={t('builder.newName')} onChange={(e) => onName(e.target.value)} />
        <span className="field-hint">{t('builder.summary.nameHint', { n: num(NAME_MAX - draft.name.length) })}</span>
      </label>

      <div className="section-head">
        <h2>{t('builder.summary.components')}</h2>
      </div>
      {draft.components.length === 0 ? (
        <EmptyState icon="pack" title={t('builder.summary.emptyTitle')} text={t('builder.summary.emptyText')} compact />
      ) : (
        <div className="builder-summary-list">
          {catalog.categories
            .map((c) => ({ category: c, ids: draft.components.filter((id) => index.get(id)?.category.key === c.key) }))
            .filter((x) => x.ids.length)
            .map(({ category, ids }) => (
              <div key={category.key} className="builder-summary-category">
                <div className="muted small">{category.label}</div>
                <ul className="list compact">
                  {ids.map((id) => {
                    const card = index.get(id)!.card
                    return (
                      <li key={id} className="row">
                        <span className="row-main ellipsis">{card.name}</span>
                        <span className="meta">{bytes(card.size)}</span>
                        <button className="link" onClick={() => onDetails(id)}>
                          {t('builder.card.details')}
                        </button>
                        <button className="link" onClick={() => onRemove(id)}>
                          {t('builder.summary.remove')}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                {category.key === RESHADE && (
                  <div className="builder-summary-reshade">
                    <span className="muted small">
                      {changes ? t('builder.summary.reshadeChanged', { count: changes, n: num(changes) }) : t('builder.summary.reshadeAsIs')}
                    </span>
                    <button className="link small" onClick={onReshade}>
                      {t('builder.reshade.open')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          {unknown.length > 0 && (
            <div className="builder-summary-category">
              <div className="muted small">{t('builder.recap.other')}</div>
              <ul className="list compact">
                {unknown.map((id) => (
                  <li key={id} className="row">
                    <span className="row-main ellipsis">{draft.names[id] ?? id}</span>
                    <button className="link" onClick={() => onRemove(id)}>
                      {t('builder.summary.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {draft.removed.length > 0 && (
        <div className="bar bar-warning">
          <span className="bar-text">
            {t('builder.summary.removed', { count: draft.removed.length, names: draft.removed.map((c) => q(c.name)).join(', ') })}
          </span>
        </div>
      )}

      {draft.components.length > 0 && (
        <>
          <div className="section-head">
            <h2>{t('builder.summary.check')}</h2>
            {preview.loading && <span className="muted small">{t('builder.recap.checking')}</span>}
          </div>
          {preview.error && (
            <div className="bar bar-error">
              <span className="bar-text">{preview.error}</span>
            </div>
          )}
          {p && (p.problems.length ? <Problems problems={p.problems} onBase={onBase} /> : <p className="ok-text">{t('builder.summary.noProblem')}</p>)}
          {p && (
            <dl className="facts builder-facts">
              <dt>{t('builder.recap.size')}</dt>
              <dd>{bytes(p.estimate.size)}</dd>
              <dt>{t('builder.recap.files')}</dt>
              <dd>{num(p.estimate.fileCount)}</dd>
            </dl>
          )}
          {p && <PcEstimate perf={p.estimate.performance} />}
        </>
      )}

      <div className="builder-actions">
        {dl ? (
          <DownloadInline d={dl} />
        ) : (
          <>
            <button onClick={onSave} disabled={busy || !dirty}>
              {t('common.save')}
            </button>
            <button className="primary" onClick={onInstall} disabled={busy || !draft.components.length || !checked || errors.length > 0 || upToDate}>
              {installLabel}
            </button>
          </>
        )}
      </div>
      {errors.length > 0 && !dl && <p className="hint">{t('builder.summary.fixErrors')}</p>}
      {!local && !dl && <p className="hint">{t('builder.summary.installHint')}</p>}
      {local && <LocalPack pack={local} update={update && !dl} performance={p?.estimate.performance ?? null} onOpenLocal={onOpenLocal} />}
    </section>
  )
}

/** Pack construit à partir de la création : l'ouvrir dans la bibliothèque, ou l'installer dans le jeu. */
function LocalPack({ pack, update, performance, onOpenLocal }: { pack: PackManifest; update: boolean; performance: PackPerformance | null; onOpenLocal: (packId: string) => void }) {
  const { t } = useTranslation()
  const { overview, task, changeGame } = useStore()
  const { choose, picker } = useInstallTarget()
  const confirmHeavy = usePerfConfirm()
  const active = overview?.state.active?.packId === pack.id
  const pending = overview?.game.pending?.packId === pack.id
  const installInGame = async (): Promise<void> => {
    const target = await choose(pack)
    if (target === null) return
    if (!(await confirmHeavy({ name: pack.name, kind: 'pack', performance }, t('packDetail.installAnyway')))) return
    await changeGame(() => window.api.applyPack(pack.id, target))
  }
  return (
    <div className="builder-local">
      <div className="builder-local-cover">
        <Cover pack={pack} />
      </div>
      <div className="row-main">
        <div className="name">{pack.name}</div>
        <div className="meta">
          {active ? t('builder.local.active') : pending ? t('builder.local.pending') : t('builder.local.inLibrary')}
          {update && ` · ${t('builder.local.update')}`}
        </div>
      </div>
      <div className="actions">
        <button onClick={() => onOpenLocal(pack.id)}>{t('builder.local.open')}</button>
        {!active && !pending && (
          <button className="primary" onClick={() => void installInGame()} disabled={!!task}>
            {t('builder.local.installInGame')}
          </button>
        )}
      </div>
      {picker}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Détails d'un composant

function ComponentModal({ id, card, selected, onToggle, onClose }: { id: string; card: BuilderComponentCard | null; selected: boolean; onToggle: () => void; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const { run } = useStore()
  const [detail, setDetail] = useState<BuilderComponentDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.api.builderComponent(id).then(
      (d) => live && setDetail(d),
      (e) => live && setError(cleanError(e))
    )
    return () => {
      live = false
    }
  }, [id, i18n.language])
  const name = detail?.name ?? card?.name ?? ''
  return (
    <Modal
      className="builder-modal"
      title={name}
      onClose={onClose}
      actions={
        <>
          {card && (
            <button
              className={selected ? '' : 'primary'}
              data-autofocus
              onClick={() => {
                onToggle()
                onClose()
              }}
            >
              {selected ? t('builder.details.remove') : t('builder.details.choose')}
            </button>
          )}
          <button onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      {error ? (
        <p>{error}</p>
      ) : !detail ? (
        <p className="muted loading">{t('common.loading')}</p>
      ) : (
        <div className="builder-detail">
          <Gallery
            key={detail.id}
            images={detail.images.map((i) => i.id)}
            image={(imageId) => <img className="cover-img contain" src={builderImageUrl(detail.id, imageId)} alt="" draggable={false} />}
            thumb={(imageId) => builderImageUrl(detail.id, imageId, true)}
            empty={<div className="cover-empty">{detail.name}</div>}
          />
          {detail.summary && <p className="summary">{detail.summary}</p>}
          <dl className="facts">
            <dt>{t('builder.details.size')}</dt>
            <dd>{bytes(detail.size)}</dd>
            <dt>{t('builder.details.files')}</dt>
            <dd>{num(detail.fileCount)}</dd>
            <dt>{t('builder.details.weight')}</dt>
            <dd>
              <WeightBadge perf={detail.performance} />
            </dd>
            {detail.credits && (
              <>
                <dt>{t('builder.details.credits')}</dt>
                <dd className="builder-credits">{detail.credits}</dd>
              </>
            )}
            {detail.tags.length > 0 && (
              <>
                <dt>{t('builder.details.tags')}</dt>
                <dd>{detail.tags.join(', ')}</dd>
              </>
            )}
          </dl>
          {detail.unreadable && <p className="hint">{t('builder.details.unreadable')}</p>}
          {detail.description.trim() && <Markdown text={detail.description} />}
          {detail.sourceUrl && (
            <div className="side-links">
              <button onClick={() => void run(() => window.api.openLink(detail.sourceUrl!))}>{t('builder.details.source')}</button>
            </div>
          )}
          {detail.foundIn.length > 0 && (
            <>
              <div className="section-head">
                <h2>{t('builder.details.foundIn')}</h2>
              </div>
              <ul className="list compact">
                {detail.foundIn.map((s, i) => (
                  <li key={`${s.packId}-${i}`} className="row">
                    <span className="row-main">
                      <span>{s.packName}</span>
                      {s.packAuthor && <span className="meta"> · {t('packDetail.byAuthor', { author: s.packAuthor })}</span>}
                    </span>
                    {s.packSlug && (
                      <button className="link" onClick={() => void run(() => window.api.openSite(`/packs/${s.packSlug}/`))}>
                        {t('builder.details.viewPack')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
