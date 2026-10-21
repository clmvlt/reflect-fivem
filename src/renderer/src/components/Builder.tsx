// « Créer ton pack » (compte connecté avec le droit « Peut créer un pack » : sinon la page n'est pas proposée, voir
// canUseBuilder) : le joueur compose son propre pack en choisissant chaque élément (route, végétation, sang...) parmi
// ceux de tous les packs de la Marketplace, règle son ambiance (outils ReShade, QuantV, NVE, ENB : un choix rapide, ou
// chaque outil réglé lui-même avec un style, voir BuilderAmbiance.tsx), enregistre ses créations sur son compte et les
// installe comme n'importe quel pack de la bibliothèque. Assistant par étapes (les groupes du catalogue,
// puis le récapitulatif), avec un panneau qui résume la composition, son poids sur ce PC et ses problèmes, revérifiés
// par l'API 400 ms après chaque changement. Vente (voir BuilderBilling.tsx) : « Mon offre » sur l'accueil, formule de
// chaque création, et achat proposé quand l'enregistrement le demande (nouvelle création sans pack libre, pack gratuit
// déjà modifié).
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AccountBilling,
  BuildPlan,
  BuilderBuild,
  BuilderBuildSummary,
  BuilderCatalog,
  BuilderCategory,
  BuilderComponentCard,
  BuilderPreview,
  BuilderProblem,
  BuilderSaveInput,
  BuilderTools,
  BuilderToolSettings,
  PackManifest,
  ToolKey,
  ToolMode
} from '@shared/types'
import { canUseBuilder } from '@shared/api'
import { deleteNote, needsPack, saleActive } from '@shared/billing'
import { estimate, VERDICT_LABEL, type PackPerformance } from '@shared/performance'
import {
  ambianceChoice,
  cleanTools,
  enableTool,
  isToolKey,
  noTools,
  recommendedTools,
  setTool,
  setToolMode,
  TOOL_KEYS,
  withKnownStyles,
  type AmbianceChoice,
  type ToolNote
} from '@shared/ambiance'
import { apiError, cleanError, useStore } from '../store'
import { bytes, longDate, num, q } from '../lib/format'
import { blockersOf, cardIndex, conflictsOf, shownProblems, draftOf, missingBases, NAME_MAX, newDraft, sameComposition, snapshot, SUMMARY, toggle, upgradeDraft, type CardRef, type Draft } from '../lib/builder'
import { Cover, EmptyState } from './common'
import { confirmDialog } from './Confirm'
import { DownloadInline, useDownload } from './Downloads'
import { useInstallTarget } from './InstallTarget'
import { popupMenu } from './Menu'
import { memText, usePerfConfirm, usePerformance, verdictReasons } from './Performance'
import { activate, blockedText, Check, ComponentModal, ComponentTile } from './BuilderParts'
import { AmbianceSection, toolName, toolSummary } from './BuilderAmbiance'
import { OfferPanel, PlanBadge, PlanBanner, useBilling, withPurchase, type PurchaseNeed } from './BuilderBilling'
import { onBillingChanged } from './Purchase'

/** Création à ouvrir depuis une autre page (fiche d'un pack, file des téléchargements). */
export interface BuilderRequest {
  buildId: string
  at: number
}

/** Créations par compte (limite de l'API, donnée par l'état de la vente quand il est connu). */
const MAX_BUILDS = 50

interface WizardState {
  draft: Draft
  saved: string
  step: string | null
  tabs: Record<string, string>
  /** Choix rapide de l'ambiance (Personnalisé : un panneau par outil). */
  ambiance: AmbianceChoice
  /** Image en jeu des aperçus des styles (null : celle par défaut), choisie à l'étape de l'ambiance. */
  reference: string | null
  /** Formule de la création enregistrée (null : nouvelle création). */
  plan: BuildPlan | null
}

/** Assistant en cours quand on passe à une autre page de l'application : retrouvé au retour. */
let kept: (WizardState & { account: number }) | null = null

const REFERENCE_KEY = 'builder.reference'

/** Image en jeu choisie pour les aperçus, retenue sur ce poste (repli sur celle par défaut si elle n'existe plus). */
function savedReference(): string | null {
  try {
    return localStorage.getItem(REFERENCE_KEY)
  } catch {
    return null
  }
}
/** Catalogues déjà lus, par langue : la page s'affiche tout de suite à son retour (puis le catalogue est revérifié). */
const catalogs = new Map<string, BuilderCatalog>()

/** Pack de la bibliothèque construit à partir de la création (le plus récent). */
export function builtPack(library: PackManifest[], buildId: string | null): PackManifest | null {
  if (!buildId) return null
  return library.filter((p) => p.built?.buildId === buildId).sort((a, b) => b.built!.builtAt.localeCompare(a.built!.builtAt))[0] ?? null
}

/** Étape qui porte les outils d'ambiance : celle de leurs catégories (null sans outil proposé). */
function toolsGroup(catalog: BuilderCatalog): string | null {
  if (!catalog.tools.length) return null
  const tool = catalog.tools[0]
  return catalog.categories.find((c) => c.tool === tool.key || c.key === tool.category)?.group ?? catalog.groups[0]?.key ?? null
}

/** Icône de l'entrée de la barre latérale : deux étincelles (créer) sur une pastille de la couleur d'accent. */
export function BuilderNavIcon() {
  return (
    <span className="nav-icon-tile" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M7 1.5c.3 2.6 1.9 4.2 4.5 4.5-2.6.3-4.2 1.9-4.5 4.5-.3-2.6-1.9-4.2-4.5-4.5C5.1 5.7 6.7 4.1 7 1.5z" />
        <path d="M12.5 9.5c.15 1.2.8 1.85 2 2-1.2.15-1.85.8-2 2-.15-1.2-.8-1.85-2-2 1.2-.15 1.85-.8 2-2z" />
      </svg>
    </span>
  )
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

/** Sans compte ou sans le droit, rien : l'application ne propose pas la page et la quitte si le droit est retiré. */
export function Builder({ request, onOpenLocal }: { request: BuilderRequest | null; onOpenLocal: (packId: string) => void }) {
  const { account } = useStore()
  if (!account || !canUseBuilder(account)) return null
  return <BuilderPage key={account.id} account={account.id} request={request} onOpenLocal={onOpenLocal} />
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

function BuilderPage({ account, request, onOpenLocal }: { account: number; request: BuilderRequest | null; onOpenLocal: (packId: string) => void }) {
  const { t } = useTranslation()
  const { catalog, error, reload } = useCatalog()
  const { billing, reload: reloadBilling } = useBilling()
  const resume = kept?.account === account ? kept : null
  const [view, setView] = useState<View>(() =>
    request ? (resume?.draft.id === request.buildId ? { kind: 'kept' } : { kind: 'open', id: request.buildId }) : resume ? { kind: 'kept' } : { kind: 'home' }
  )
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
  const common = { catalog, account, billing, reloadBilling, onExit: home, onOpenLocal }
  if (view.kind === 'open') return <BuildLoader key={view.id} id={view.id} {...common} />
  if (view.kind === 'new') {
    // Une nouvelle création démarre sur « Recommandé ».
    const draft = newDraft(t('builder.newName'), catalog)
    return <Wizard {...common} start={{ draft, saved: snapshot(draft), step: null, tabs: {}, ambiance: 'recommended', reference: savedReference(), plan: null }} />
  }
  if (view.kind === 'kept' && resume) {
    const index = cardIndex(catalog)
    const draft = upgradeDraft(resume.draft, (id) => index.get(id)?.category.key)
    return <Wizard {...common} start={{ ...resume, draft }} resumed />
  }
  return (
    <Home
      catalog={catalog}
      billing={billing}
      reloadBilling={reloadBilling}
      onNew={() => setView({ kind: 'new' })}
      onOpen={(id) => setView({ kind: 'open', id })}
      onOpenLocal={onOpenLocal}
    />
  )
}

// ---------------------------------------------------------------------------
// Accueil : nouveau pack, mes créations

function Home({
  catalog,
  billing,
  reloadBilling,
  onNew,
  onOpen,
  onOpenLocal
}: {
  catalog: BuilderCatalog
  billing: AccountBilling | null
  reloadBilling: () => void
  onNew: () => void
  onOpen: (id: string) => void
  onOpenLocal: (packId: string) => void
}) {
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
  // Achat fait, pack débloqué : formules des créations relues.
  useEffect(() => onBillingChanged(() => void load()), [load])
  /** Création supprimée ou dupliquée : les packs gratuits et les crédits ont pu changer. */
  const changed = (): void => {
    void load()
    reloadBilling()
  }
  const max = billing?.maxBuilds ?? MAX_BUILDS
  const full = (builds?.length ?? 0) >= max

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('builder.title')}</h1>
        {builds && <span className="page-note">{t('builder.home.count', { n: num(builds.length), max: num(max) })}</span>}
        <div className="spacer" />
        <button className="primary" onClick={onNew} disabled={full} title={full ? t('builder.home.full', { max: num(max) }) : undefined}>
          {t('builder.home.new')}
        </button>
      </header>
      {catalog.offline && (
        <div className="bar">
          <span className="bar-text">{t('builder.offline')}</span>
        </div>
      )}
      <p className="builder-lead">{t('builder.home.intro')}</p>
      <OfferPanel billing={billing} />
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
            <p className="add-text">{full ? t('builder.home.full', { max: num(max) }) : t('builder.home.newText')}</p>
          </article>
          {builds.map((b) => (
            <BuildCard key={b.id} build={b} billing={billing} onOpen={() => onOpen(b.id)} onOpenLocal={onOpenLocal} onChanged={changed} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Composition enregistrée telle quelle, sans les composants retirés (refusés à l'enregistrement). */
async function savedInput(id: string, name: string): Promise<BuilderSaveInput> {
  const draft = draftOf(await window.api.builderBuildGet(id))
  return { name, components: draft.components, tools: draft.tools }
}

function BuildCard({
  build,
  billing,
  onOpen,
  onOpenLocal,
  onChanged
}: {
  build: BuilderBuildSummary
  billing: AccountBilling | null
  onOpen: () => void
  onOpenLocal: (packId: string) => void
  onChanged: () => void
}) {
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
      // Une copie est une nouvelle création : sans pack libre, l'achat d'un pack de plus est proposé.
      const copy = await run(async () => {
        const input = await savedInput(build.id, name)
        return withPurchase(() => window.api.builderBuildSave(null, input), { need: needsPack(billing) ? 'pack' : null, request: () => ({ product: 'pack', blocked: true }) })
      })
      if (copy) {
        setMessage({ kind: 'info', text: t('builder.home.duplicated', { name: q(copy.name) }) })
        onChanged()
      }
    } else if (choice === 'delete') {
      // Pack gratuit : pas rendu ; pack payé : son crédit redevient libre.
      const note = deleteNote(build.plan, billing)
      const detail = [
        local ? t('builder.home.deleteDetailLocal') : t('builder.home.deleteDetail'),
        note === 'free' ? t('builder.billing.plan.deleteFree') : note === 'credit' ? t('builder.billing.plan.deleteCredit') : ''
      ]
      const ok = await confirmDialog(t('builder.home.deleteTitle', { name: q(build.name) }), detail.filter(Boolean).join(' '), t('common.delete'))
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
        <PlanBadge plan={build.plan} billing={billing} />
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
function BuildLoader({
  id,
  ...rest
}: {
  id: string
  catalog: BuilderCatalog
  account: number
  billing: AccountBilling | null
  reloadBilling: () => void
  onExit: () => void
  onOpenLocal: (packId: string) => void
}) {
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
  return (
    <Wizard
      {...rest}
      start={{ draft, saved: snapshot(draft), step: SUMMARY, tabs: {}, ambiance: ambianceChoice(draft.tools, rest.catalog), reference: savedReference(), plan: build.plan }}
    />
  )
}

// ---------------------------------------------------------------------------
// Assistant

type PreviewState = { data: BuilderPreview | null; loading: boolean; error: string | null }

/** Problèmes et estimation de la composition (composants et outils), demandés à l'API 400 ms après le dernier changement. */
function usePreview(components: string[], tools: BuilderTools): PreviewState {
  const { i18n } = useTranslation()
  const key = JSON.stringify({ components, tools: cleanTools(tools) })
  const [state, setState] = useState<PreviewState>({ data: null, loading: false, error: null })
  useEffect(() => {
    const input = JSON.parse(key) as { components: string[]; tools: BuilderTools }
    if (!input.components.length && TOOL_KEYS.every((k) => input.tools[k].mode === 'none')) {
      setState({ data: null, loading: false, error: null })
      return
    }
    let live = true
    setState((s) => ({ ...s, loading: true }))
    const timer = setTimeout(() => {
      window.api.builderPreview(input.components, input.tools).then(
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

function Wizard({
  catalog,
  account,
  billing,
  reloadBilling,
  start,
  resumed = false,
  onExit,
  onOpenLocal
}: {
  catalog: BuilderCatalog
  account: number
  billing: AccountBilling | null
  reloadBilling: () => void
  start: WizardState
  /** Assistant retrouvé en revenant sur la page (brouillon gardé). */
  resumed?: boolean
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
  const [ambiance, setAmbiance] = useState(start.ambiance)
  const [reference, setReference] = useState(start.reference)
  const [plan, setPlan] = useState(start.plan)
  const [note, setNote] = useState<{ tool: ToolKey; note: ToolNote } | null>(null)
  const [focus, setFocus] = useState<{ tool: ToolKey; at: number } | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Étapes : les groupes qui ont au moins une catégorie non vide hors outils (catégories vides masquées), celui qui porte
  // les outils d'ambiance, puis le récapitulatif.
  const ambianceGroup = useMemo(() => toolsGroup(catalog), [catalog])
  const groups = useMemo(
    () =>
      catalog.groups
        .map((group) => ({
          group,
          categories: group.categories
            .map((k) => catalog.categories.find((c) => c.key === k))
            .filter((c): c is BuilderCategory => !!c && !c.tool && c.components.length > 0),
          tools: group.key === ambianceGroup
        }))
        .filter((g) => g.categories.length > 0 || g.tools),
    [catalog, ambianceGroup]
  )
  const steps = [...groups.map((g) => g.group.key), SUMMARY]
  const [step, setStep] = useState(start.step && steps.includes(start.step) ? start.step : steps[0])
  const pageRef = useRef<HTMLDivElement>(null)
  /** Autre étape (boutons des étapes, « Précédent », « Étape suivante ») : elle s'ouvre en haut de la page. */
  const goTo = (key: string): void => {
    setStep(key)
    pageRef.current?.scrollTo({ top: 0 })
  }
  const chosen = draft.components.map((id) => index.get(id)?.card).filter((c): c is BuilderComponentCard => !!c)
  const preview = usePreview(draft.components, draft.tools)
  const dirty = snapshot(draft) !== saved
  const activeTools = catalog.tools.filter((tool) => draft.tools[tool.key].mode !== 'none').length

  useEffect(() => {
    kept = { account, draft, saved, step, tabs, ambiance, reference, plan }
  }, [account, draft, saved, step, tabs, ambiance, reference, plan])

  /** Formule de la création relue (modification utilisée, pack débloqué) : le bandeau suit. */
  const refreshPlan = async (id = draft.id): Promise<void> => {
    if (!id) return
    const b = await window.api.builderBuildGet(id).catch(() => null)
    if (b) setPlan(b.plan)
  }
  // Brouillon gardé (`resumed`) : sa formule a pu changer depuis (modification utilisée, pack débloqué ailleurs).
  const startId = resumed ? start.draft.id : null
  useEffect(() => {
    if (!startId) return
    let live = true
    window.api.builderBuildGet(startId).then(
      (b) => live && setPlan(b.plan),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [startId])

  const choose = (category: BuilderCategory, id: string | null): void => setDraft({ ...draft, components: toggle(draft.components, index, category, id) })
  const remove = (id: string): void => {
    const ref = index.get(id)
    if (ref) choose(ref.category, id)
    else setDraft({ ...draft, components: draft.components.filter((c) => c !== id) })
  }

  // ----- outils d'ambiance
  const applyTools = (result: { tools: BuilderTools; note: ToolNote | null }, tool: ToolKey): void => {
    setDraft({ ...draft, tools: result.tools })
    setNote(result.note ? { tool, note: result.note } : null)
    // Un changement fait hors de « Personnalisé » (action d'un problème) : le choix rapide suit.
    if (ambiance !== 'custom') setAmbiance(ambianceChoice(result.tools, catalog))
  }
  const onTool = (key: ToolKey, settings: BuilderToolSettings): void => applyTools(setTool(draft.tools, key, settings, catalog), key)
  const onMode = (key: ToolKey, mode: ToolMode): void => applyTools(setToolMode(draft.tools, key, mode, catalog), key)
  const chooseAmbiance = (choice: AmbianceChoice): void => {
    setAmbiance(choice)
    setNote(null)
    if (choice === 'basic') setDraft({ ...draft, tools: noTools() })
    else if (choice === 'recommended') setDraft({ ...draft, tools: recommendedTools(catalog) })
  }
  /** Panneau d'un outil (lien du récapitulatif, problème à régler) : étape de l'ambiance, en Personnalisé. */
  const openTool = (key: ToolKey): void => {
    if (ambianceGroup) setStep(ambianceGroup)
    setAmbiance('custom')
    setFocus({ tool: key, at: Date.now() })
  }
  /** Base demandée par un élément ou un problème (QuantV, ReShade, NVE) : l'outil est activé. */
  const enable = (base: string): void => {
    if (isToolKey(base) && catalog.tools.some((x) => x.key === base)) applyTools(enableTool(draft.tools, base, catalog), base)
  }
  /** Image en jeu des aperçus : gardée pour l'assistant et retenue sur ce poste. */
  const chooseReference = (id: string): void => {
    setReference(id)
    try {
      localStorage.setItem(REFERENCE_KEY, id)
    } catch {
      /* stockage indisponible : choix gardé pour cet assistant */
    }
  }
  const baseLabel = (base: string): string => {
    const tool = catalog.tools.find((x) => x.key === base)
    return tool ? toolName(tool) : (catalog.categories.find((c) => c.key === base)?.label ?? base)
  }
  // Fenêtre de détails : un élément d'outil se choisit comme « Importé d'un pack ».
  const detailsTool = details ? (index.get(details)?.category.tool ?? null) : null
  const detailsSelected = !!details && (detailsTool ? draft.tools[detailsTool].mode === 'pack' && draft.tools[detailsTool].component === details : draft.components.includes(details))
  const detailsRef = details ? index.get(details) : undefined
  const detailsBlocked = detailsRef ? blockedText(t, detailsTool ? conflictsOf(detailsRef.card, chosen) : blockersOf(detailsRef.card, detailsRef.category.single, chosen)) : null
  const toggleDetails = (): void => {
    if (!details) return
    if (detailsTool) {
      if (detailsSelected) onMode(detailsTool, 'none')
      else onTool(detailsTool, { ...draft.tools[detailsTool], mode: 'pack', component: details, style: null, techniques: {}, values: {} })
      return
    }
    const ref = index.get(details)
    if (ref) choose(ref.category, details)
  }

  // ----- enregistrement, installation
  const leave = async (): Promise<void> => {
    if (dirty && !(await confirmDialog(t('builder.leave.title'), t('builder.leave.detail'), t('builder.leave.ok')))) return
    onExit()
  }
  const input = (): BuilderSaveInput => ({ name: draft.name.trim() || t('builder.newName'), components: draft.components, tools: withKnownStyles(draft.tools, catalog) })
  const afterSave = (id: string, name: string): void => {
    const next = { ...draft, id, name, tools: withKnownStyles(draft.tools, catalog), removed: [] }
    setDraft(next)
    setSaved(snapshot(next))
    // Pack gratuit ou crédit pris par une nouvelle création, modification utilisée.
    reloadBilling()
  }
  /**
   * Achat à proposer avant d'enregistrer : nouvelle création sans pack libre, ou pack gratuit sans modification restante
   * dont les éléments ou les réglages ont changé (renommer seulement reste permis). Sinon, un refus 402 de l'API l'ouvre.
   */
  const purchaseNeed = (): PurchaseNeed | null => {
    if (!draft.id) return needsPack(billing) ? 'pack' : null
    return plan?.locked && saleActive(billing) && !sameComposition(snapshot(draft), saved) ? 'unlock' : null
  }
  /** Enregistrement (ou installation, qui enregistre d'abord) : l'achat demandé s'ouvre, puis l'action reprend. */
  const withSale = <T,>(action: () => Promise<T>): Promise<T | undefined> =>
    withPurchase(action, {
      need: purchaseNeed(),
      request: (need) =>
        need === 'unlock' && draft.id ? { product: 'unlock', build: { id: draft.id, name: draft.name.trim() || t('builder.newName') }, blocked: true } : { product: 'pack', blocked: true },
      paid: async (need) => {
        if (need === 'unlock') await refreshPlan()
      }
    })
  const save = async (): Promise<void> => {
    setBusy(true)
    const b = await run(() => withSale(() => window.api.builderBuildSave(draft.id, input())))
    setBusy(false)
    if (!b) return
    afterSave(b.id, b.name)
    setPlan(b.plan)
    setMessage({ kind: 'info', text: t('builder.saved', { name: q(b.name) }) })
  }
  const install = async (): Promise<void> => {
    const data = input()
    if (!(await confirmHeavy({ name: data.name, kind: 'pack', performance: preview.data?.estimate.performance }, t('builder.summary.installAnyway')))) return
    setBusy(true)
    const id = await run(() => withSale(() => window.api.builderInstall(draft.id, data)))
    setBusy(false)
    if (!id) return
    afterSave(id, data.name)
    void refreshPlan(id)
  }

  const groupOf = (key: string): (typeof groups)[number] | undefined => groups.find((g) => g.group.key === key)
  const countIn = (g: (typeof groups)[number]): number =>
    draft.components.filter((id) => g.categories.some((c) => c.key === index.get(id)?.category.key)).length + (g.tools ? activeTools : 0)
  const current = groupOf(step)
  const stepIndex = steps.indexOf(step)

  return (
    <div className="page builder-page" ref={pageRef}>
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
      <PlanBanner
        plan={plan}
        billing={billing}
        build={draft.id ? { id: draft.id, name: draft.name.trim() || t('builder.newName') } : null}
        onChanged={() => void refreshPlan()}
      />

      <nav className="builder-steps" aria-label={t('builder.stepsLabel')}>
        {steps.map((key, i) => {
          const g = groupOf(key)
          const count = g ? countIn(g) : draft.components.length + activeTools
          return (
            <button key={key} className={`builder-step ${key === step ? 'is-selected' : ''}`} aria-current={key === step ? 'step' : undefined} onClick={() => goTo(key)}>
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
              ambiance={
                current.tools ? (
                  <AmbianceSection
                    catalog={catalog}
                    index={index}
                    tools={draft.tools}
                    choice={ambiance}
                    note={note}
                    focus={focus}
                    chosen={chosen}
                    onChoice={chooseAmbiance}
                    onTool={onTool}
                    onMode={onMode}
                    onBase={enable}
                    onDetails={setDetails}
                    baseLabel={baseLabel}
                    reference={reference}
                    onReference={chooseReference}
                  />
                ) : null
              }
              tab={tabs[current.group.key]}
              onTab={(key) => setTabs((tb) => ({ ...tb, [current.group.key]: key }))}
              index={index}
              draft={draft}
              chosen={chosen}
              onChoose={choose}
              onDetails={setDetails}
              onBase={enable}
              baseLabel={baseLabel}
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
              onEnable={enable}
              onOpenTool={openTool}
              onOpenLocal={onOpenLocal}
            />
          )}
          <div className="builder-nav">
            {stepIndex > 0 && <button onClick={() => goTo(steps[stepIndex - 1])}>{t('builder.previous')}</button>}
            <div className="spacer" />
            {stepIndex < steps.length - 1 && (
              <button className="primary" onClick={() => goTo(steps[stepIndex + 1])}>
                {stepIndex === steps.length - 2 ? t('builder.toSummary') : t('builder.next')}
              </button>
            )}
          </div>
        </div>
        <RecapPanel catalog={catalog} index={index} draft={draft} preview={preview} ambianceGroup={ambianceGroup} onEnable={enable} onOpenTool={openTool} />
      </div>

      {details && (
        <ComponentModal id={details} card={detailsRef?.card ?? null} selected={detailsSelected} blocked={detailsBlocked} onToggle={toggleDetails} onClose={() => setDetails(null)} />
      )}
    </div>
  )
}

/**
 * Une étape : l'ambiance d'abord (étape des outils), puis une catégorie à la fois (sous-onglets avec le nombre de
 * choix). Les catégories des outils ne sont pas des grilles : leurs éléments sont les choix « Importé d'un pack ».
 */
function GroupStep({
  categories,
  ambiance,
  tab,
  onTab,
  index,
  draft,
  chosen,
  onChoose,
  onDetails,
  onBase,
  baseLabel
}: {
  categories: BuilderCategory[]
  ambiance: ReactNode
  tab: string | undefined
  onTab: (key: string) => void
  index: Map<string, CardRef>
  draft: Draft
  chosen: BuilderComponentCard[]
  onChoose: (category: BuilderCategory, id: string | null) => void
  onDetails: (id: string) => void
  onBase: (base: string) => void
  baseLabel: (base: string) => string
}) {
  const { t } = useTranslation()
  const category = categories.find((c) => c.key === tab) ?? categories[0]
  const countOf = (key: string): number => draft.components.filter((id) => index.get(id)?.category.key === key).length
  const picked = (id: string): boolean => draft.components.includes(id)
  return (
    <>
      {ambiance}
      {category && (
        <>
          {ambiance && (
            <div className="section-head">
              <h2>{t('builder.ambiance.more')}</h2>
            </div>
          )}
          <div className="chips builder-tabs" role="tablist">
            {categories.map((c) => {
              const n = countOf(c.key)
              const selected = c.key === category.key
              return (
                <button key={c.key} role="tab" aria-selected={selected} className={`chip ${selected ? 'is-selected' : ''}`} onClick={() => onTab(c.key)}>
                  {c.label}
                  {n > 0 && <span className="chip-count">{num(n)}</span>}
                </button>
              )
            })}
          </div>
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
                blockers={blockersOf(card, category.single, chosen)}
                missing={picked(card.id) ? missingBases(card, chosen, draft.tools) : []}
                baseLabel={baseLabel}
                onChoose={() => onChoose(category, card.id)}
                onDetails={() => onDetails(card.id)}
                onBase={onBase}
              />
            ))}
          </div>
        </>
      )}
    </>
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

/**
 * Problèmes (sans les conflits, voir shownProblems), les erreurs d'abord, chacun avec de quoi le régler : activer
 * l'outil ou la base qui manque (QuantV demande ReShade, un preset demande QuantV), choisir un autre style, revenir au
 * réglage d'un outil indisponible.
 */
function Problems({
  problems,
  catalog,
  tools,
  onEnable,
  onOpenTool
}: {
  problems: BuilderProblem[]
  catalog: BuilderCatalog
  tools: BuilderTools
  onEnable: (tool: string) => void
  onOpenTool: (tool: ToolKey) => void
}) {
  const { t } = useTranslation()
  const shown = shownProblems(problems)
  if (!shown.length) return null
  const sorted = shown.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  const action = (p: BuilderProblem): ReactNode => {
    const key = p.requires
    const tool = isToolKey(key) ? catalog.tools.find((x) => x.key === key) : undefined
    if (!tool || !isToolKey(key)) return null
    if (p.type === 'style')
      return (
        <button className="link" onClick={() => onOpenTool(key)}>
          {t('builder.problems.otherStyle')}
        </button>
      )
    if (p.type === 'tool')
      return (
        <button className="link" onClick={() => onOpenTool(key)}>
          {t('builder.problems.changeTool')}
        </button>
      )
    if ((p.type === 'needs-tool' || p.type === 'missing') && tools[key].mode === 'none')
      return (
        <button className="link" onClick={() => onEnable(key)}>
          {t('builder.problems.enable', { tool: toolName(tool) })}
        </button>
      )
    return null
  }
  return (
    <ul className="builder-problems">
      {sorted.map((p, i) => {
        const button = action(p)
        return (
          <li key={i} className={`builder-problem is-${p.severity}`}>
            <span className={`ins-level level-${p.severity === 'error' ? 'bad' : 'warn'}`}>{p.severity === 'error' ? t('builder.problems.error') : t('builder.problems.warning')}</span>
            <span className="builder-problem-text">
              {p.message || t('builder.problems.generic')}
              {button && <> {button}</>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function RecapPanel({
  catalog,
  index,
  draft,
  preview,
  ambianceGroup,
  onEnable,
  onOpenTool
}: {
  catalog: BuilderCatalog
  index: Map<string, CardRef>
  draft: Draft
  preview: PreviewState
  ambianceGroup: string | null
  onEnable: (tool: string) => void
  onOpenTool: (tool: ToolKey) => void
}) {
  const { t } = useTranslation()
  const p = preview.data
  const active = catalog.tools.filter((tool) => draft.tools[tool.key].mode !== 'none')
  // Ambiance : un outil par ligne (« ReShade : Cinéma, réglé par toi »), ou le jeu d'origine.
  const ambianceLines = active.length
    ? active.map((tool) => t('builder.tool.line', { tool: toolName(tool), summary: toolSummary(t, tool, draft.tools[tool.key], index) }))
    : [t('builder.recap.basic')]
  const byGroup = catalog.groups
    .map((g) => ({
      key: g.key,
      label: g.label,
      lines: [...(g.key === ambianceGroup ? ambianceLines : []), ...draft.components.filter((id) => index.get(id)?.category.group === g.key).map((id) => index.get(id)!.card.name)]
    }))
    .filter((g) => g.lines.length)
  const unknown = draft.components.filter((id) => !index.has(id)).map((id) => draft.names[id] ?? id)
  const empty = !draft.components.length && !active.length
  return (
    <aside className="builder-recap" aria-label={t('builder.recap.title')}>
      <div className="builder-recap-head">
        <h2>{t('builder.recap.title')}</h2>
        {preview.loading && <span className="muted small">{t('builder.recap.checking')}</span>}
      </div>
      <ul className="builder-recap-list">
        {byGroup.map((g) => (
          <li key={g.key}>
            <span className="muted small">{g.label}</span>
            {g.lines.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </li>
        ))}
        {unknown.length > 0 && (
          <li>
            <span className="muted small">{t('builder.recap.other')}</span>
            <span>{unknown.join(', ')}</span>
          </li>
        )}
      </ul>
      {empty ? (
        <p className="muted">{t('builder.recap.empty')}</p>
      ) : (
        <>
          <dl className="facts builder-facts">
            <dt>{t('builder.recap.size')}</dt>
            <dd>{p ? bytes(p.estimate.size) : '-'}</dd>
          </dl>
          {p && <PcEstimate perf={p.estimate.performance} />}
          {preview.error && <p className="warn-text small">{preview.error}</p>}
          {p && <Problems problems={p.problems} catalog={catalog} tools={draft.tools} onEnable={onEnable} onOpenTool={onOpenTool} />}
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
  onEnable,
  onOpenTool,
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
  onEnable: (tool: string) => void
  onOpenTool: (tool: ToolKey) => void
  onOpenLocal: (packId: string) => void
}) {
  const { t } = useTranslation()
  const { overview } = useStore()
  const dl = useDownload(draft.id)
  const local = builtPack(overview?.library ?? [], draft.id)
  const update = !!local && !!overview?.market.updates.includes(local.id)
  const p = preview.data
  const errors = p?.problems.filter((x) => x.severity === 'error') ?? []
  const unknown = draft.components.filter((id) => !index.has(id))
  const anything = draft.components.length > 0 || catalog.tools.some((tool) => draft.tools[tool.key].mode !== 'none')
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

      {catalog.tools.length > 0 && (
        <>
          <div className="section-head">
            <h2>{t('builder.summary.ambiance')}</h2>
          </div>
          <ul className="list compact">
            {catalog.tools.map((tool) => (
              <li key={tool.key} className="row">
                <span className="row-main">{t('builder.tool.line', { tool: toolName(tool), summary: toolSummary(t, tool, draft.tools[tool.key], index) })}</span>
                <button className="link" onClick={() => onOpenTool(tool.key)}>
                  {t('builder.summary.changeTool')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-head">
        <h2>{t('builder.summary.components')}</h2>
      </div>
      {!anything ? (
        <EmptyState icon="pack" title={t('builder.summary.emptyTitle')} text={t('builder.summary.emptyText')} compact />
      ) : !draft.components.length ? (
        <p className="muted">{t('builder.summary.noComponents')}</p>
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

      {anything && (
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
          {p &&
            (shownProblems(p.problems).length ? (
              <Problems problems={p.problems} catalog={catalog} tools={draft.tools} onEnable={onEnable} onOpenTool={onOpenTool} />
            ) : (
              <p className="ok-text">{t('builder.summary.noProblem')}</p>
            ))}
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
            <button className="primary" onClick={onInstall} disabled={busy || !anything || !checked || errors.length > 0 || upToDate}>
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
