import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { AuthorProfile, AuthorSummary, MarketCategory, MarketKind, MarketPack, MarketPackDetail, MarketPage, MarketTag, PackManifest, TaskProgress } from '@shared/types'
import { MOD_GONE, PACK_GONE, type MarketQuery } from '@shared/api'
import { apiError, cleanError, useStore } from '../store'
import { bytes, longDate as date, marketImageUrl, num } from '../lib/format'
import { Gallery } from './Gallery'
import { Markdown } from './Markdown'
import { Avatar, EmptyState, Progress } from './common'
import { categoryLabel, localMod, ModMarketAction, useModCategories } from './Mods'
import { PerfBadge, PerfDetails, PerfFacts, usePerfConfirm, usePerformance, type PerfContext } from './Performance'
import { estimate, type PackPerformance } from '@shared/performance'

/** Vue ouverte dans la Marketplace : fiche d'un pack (ou d'un mod, catalog) ou page d'un auteur. */
export type MarketView = { kind: 'pack'; id: string; catalog?: MarketKind } | { kind: 'author'; slug: string }

interface Nav {
  onOpen: (view: MarketView) => void
  onOpenLocal: (id: string) => void
}

/** État d'un pack de la Marketplace par rapport à la bibliothèque. */
function localState(item: { id: string; sha256: string }, library: PackManifest[]): { local: PackManifest | null; update: boolean } {
  // Deux versions présentes (mise à jour pas encore installée) : la plus récente fait foi.
  const matches = library.filter((p) => p.marketplace?.id === item.id).sort((a, b) => b.marketplace!.downloadedAt.localeCompare(a.marketplace!.downloadedAt))
  const local = matches[0] ?? null
  return { local, update: !!local && !!item.sha256 && local.marketplace!.sha256 !== item.sha256 }
}

export function Marketplace({
  view,
  depth,
  catalog,
  onOpen,
  onBack,
  onOpenLocal,
  author,
  onAuthor
}: Nav & {
  view: MarketView | null
  depth: number
  /** Catalogue affiché : packs graphiques ou mods (choisi dans la barre latérale). */
  catalog: MarketKind
  onBack: () => void
  author: string | null
  onAuthor: (slug: string | null) => void
}) {
  const { t } = useTranslation()
  // Retour : à la liste depuis la première vue ouverte, sinon à la vue précédente (fiche ou auteur).
  const back = (
    <div className="back-row">
      <button className="link" onClick={onBack}>
        {depth > 1 ? t('marketplace.back') : t('marketplace.backToList')}
      </button>
    </div>
  )
  if (view?.kind === 'pack')
    return <MarketDetail key={`${view.catalog ?? 'pack'}:${view.id}`} id={view.id} catalog={view.catalog ?? 'pack'} back={back} onOpen={onOpen} onOpenLocal={onOpenLocal} />
  if (view?.kind === 'author') return <AuthorView key={view.slug} slug={view.slug} back={back} onOpen={onOpen} onOpenLocal={onOpenLocal} />
  return <MarketList key={catalog} catalog={catalog} author={author} onAuthor={onAuthor} onOpen={onOpen} onOpenLocal={onOpenLocal} />
}

/**
 * Rangée « Tous » puis un rond par auteur (photo, nom en dessous) : un auteur choisi n'affiche que ses packs (ou ses
 * mods). Absente tant qu'aucun pack n'est rattaché à un compte.
 */
function AuthorStrip({ authors, author, catalog, onAuthor }: { authors: AuthorSummary[]; author: string | null; catalog: MarketKind; onAuthor: (slug: string | null) => void }) {
  const { t } = useTranslation()
  if (!authors.length) return null
  return (
    <div className="author-strip" role="tablist" aria-label={t('marketplace.authors')}>
      <button role="tab" aria-selected={!author} className={`author-chip ${author ? '' : 'is-selected'}`} onClick={() => onAuthor(null)}>
        <span className="avatar author-all" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 16 16" fill="currentColor">
            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" />
            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" />
            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" />
            <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" />
          </svg>
        </span>
        <span className="author-chip-name">{catalog === 'mod' ? t('marketplace.allMods') : t('marketplace.allPacks')}</span>
      </button>
      {authors.map((a) => (
        <button
          key={a.id}
          role="tab"
          aria-selected={author === a.slug}
          className={`author-chip ${author === a.slug ? 'is-selected' : ''}`}
          title={
            catalog === 'mod'
              ? t('marketplace.authorChipMods', { name: a.displayName, count: a.modCount, n: num(a.modCount) })
              : t('marketplace.authorChipPacks', { name: a.displayName, count: a.packCount, n: num(a.packCount) })
          }
          onClick={() => onAuthor(author === a.slug ? null : a.slug)}
        >
          <Avatar url={a.avatarUrl} name={a.displayName} size={64} />
          <span className="author-chip-name">{a.displayName}</span>
        </button>
      ))}
    </div>
  )
}

const COMPATIBLE_KEY = 'market.compatible'

/** « Compatibles avec mon PC » : choix gardé d'un lancement à l'autre (sur ce poste seulement). */
function useCompatibleFilter(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(COMPATIBLE_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = useCallback((next: boolean) => {
    setOn(next)
    try {
      localStorage.setItem(COMPATIBLE_KEY, next ? '1' : '0')
    } catch {
      /* stockage indisponible : choix gardé jusqu'à la fermeture */
    }
  }, [])
  return [on, set]
}

/**
 * Filtre « Compatibles avec mon PC » : l'API garde les packs dont les besoins minimaux en 1080p tiennent sur la machine
 * (mémoire vidéo et classe de la carte, envoyées seulement dans ce cas), puis ceux qui restent trop lourds à la
 * résolution de l'utilisateur sont masqués ici. Null si la machine n'est pas connue.
 */
function compatibleQuery(ctx: PerfContext | null): { vram?: number; gpuClass?: number; keep: (item: MarketPack) => boolean } | null {
  if (!ctx) return null
  const m = ctx.machine
  if (m.gpuClass === null && m.vramMb === null) return null
  return {
    vram: m.vramMb ?? undefined,
    gpuClass: m.gpuClass ?? undefined,
    keep: (item) => estimate(ctx.profile.model, m, item.performance).verdict !== 'too-heavy'
  }
}

/** Recherche lancée 300 ms après la dernière frappe. */
function useSearch(current: string | undefined, apply: (q: string) => void): [string, (q: string) => void] {
  const [search, setSearch] = useState(current ?? '')
  useEffect(() => {
    if (search === (current ?? '')) return
    const t = setTimeout(() => apply(search), 300)
    return () => clearTimeout(t)
  }, [search, current, apply])
  return [search, setSearch]
}

/** Page de packs (ou de mods, query.kind) de l'API pour une recherche. */
function useMarketPage(query: MarketQuery): { page: MarketPage | null; error: string | null; loading: boolean; reload: () => void } {
  const [page, setPage] = useState<MarketPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const { i18n } = useTranslation()
  const key = JSON.stringify(query)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPage(await window.api.marketList(JSON.parse(key) as MarketQuery))
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setLoading(false)
    }
  }, [key])

  // Langue changée : page relue (textes et messages d'erreur de l'API).
  useEffect(() => {
    void load()
  }, [load, i18n.language])

  return { page, error, loading, reload: () => void load() }
}

function MarketList({
  catalog,
  author,
  onAuthor,
  onOpen,
  onOpenLocal
}: Nav & { catalog: MarketKind; author: string | null; onAuthor: (slug: string | null) => void }) {
  const { overview } = useStore()
  const { t, i18n } = useTranslation()
  const mods = catalog === 'mod'
  const [query, setQuery] = useState<MarketQuery>({ kind: catalog, sort: 'recent', page: 0 })
  const [tags, setTags] = useState<MarketTag[]>([])
  const [categories, setCategories] = useState<MarketCategory[]>([])
  const [authors, setAuthors] = useState<AuthorSummary[]>([])
  const [featured, setFeatured] = useState<MarketPack[]>([])
  const perf = usePerformance()
  const [compatible, setCompatible] = useCompatibleFilter()
  const compat = compatibleQuery(perf)
  const filter = compatible && compat ? compat : null
  const { page, error, loading, reload } = useMarketPage({
    ...query,
    author: author ?? undefined,
    ...(filter ? { vram: filter.vram, gpuClass: filter.gpuClass } : {})
  })
  const [search, setSearch] = useSearch(
    query.q,
    useCallback((q: string) => setQuery((old) => ({ ...old, q, page: 0 })), [])
  )

  useEffect(() => {
    if (mods) window.api.marketCategories().then(setCategories, () => setCategories([]))
    else window.api.marketTags('pack').then(setTags, () => setTags([]))
    window.api.marketAuthors({ sort: 'popular' }).then(
      // Auteurs qui ont publié dans ce catalogue.
      (p) => setAuthors(p.items.filter((a) => (mods ? a.modCount : a.packCount) > 0)),
      () => setAuthors([])
    )
    window.api.marketFeatured(catalog).then(setFeatured, () => setFeatured([]))
    // Langue changée : catégories (libellés de l'API) relues.
  }, [catalog, mods, i18n.language])

  if (!overview) return null
  const selected = authors.find((a) => a.slug === author) ?? null
  const chooseAuthor = (slug: string | null): void => {
    setQuery((q) => ({ ...q, page: 0 }))
    onAuthor(slug)
  }
  const searched = !!(query.q || query.tag || query.category)
  const filtered = searched || !!filter
  const total = page ? t(mods ? 'marketplace.mods' : 'marketplace.packs', { count: page.total, n: num(page.total) }) : ''

  return (
    <div className="page">
      <header className="page-head">
        <h1>Marketplace</h1>
        <span className="page-note">{total}</span>
        <div className="spacer" />
        <input className="search" type="search" placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={query.sort} onChange={(e) => setQuery({ ...query, sort: e.target.value as MarketQuery['sort'], page: 0 })} aria-label={t('marketplace.sort.label')}>
          <option value="recent">{t('marketplace.sort.recent')}</option>
          <option value="popular">{t('marketplace.sort.popular')}</option>
          <option value="name">{t('marketplace.sort.name')}</option>
        </select>
        <label className="switch compat-switch" title={compat ? t('marketplace.compatible.help') : t('marketplace.compatible.undetected')}>
          <input
            type="checkbox"
            checked={!!filter}
            disabled={!compat}
            onChange={(e) => {
              setCompatible(e.target.checked)
              setQuery((old) => ({ ...old, page: 0 }))
            }}
          />
          <span className="switch-track" />
          <span className="switch-text">{t('marketplace.compatible.label')}</span>
        </label>
      </header>
      {/* Du moment : seulement sur la liste complète, sans recherche ni filtre. */}
      {featured.length > 0 && !filtered && !author && <FeaturedBanner items={featured} library={overview.library} onOpen={onOpen} onOpenLocal={onOpenLocal} />}
      <AuthorStrip authors={authors} author={author} catalog={catalog} onAuthor={chooseAuthor} />
      {selected && (
        <div className="author-filter">
          <span className="muted">{t(mods ? 'marketplace.authorFilter.mods' : 'marketplace.authorFilter.packs', { name: selected.displayName })}</span>
          <button className="link" onClick={() => onOpen({ kind: 'author', slug: selected.slug })}>
            {t('marketplace.authorFilter.seePage')}
          </button>
        </div>
      )}

      {mods && categories.length > 0 && (
        <div className="chips">
          <button className={`chip ${query.category ? '' : 'is-selected'}`} onClick={() => setQuery({ ...query, category: undefined, page: 0 })}>
            {t('marketplace.allCategories')}
          </button>
          {categories.map((c) => (
            <button
              key={c.key}
              className={`chip ${query.category === c.key ? 'is-selected' : ''}`}
              disabled={!c.count && query.category !== c.key}
              onClick={() => setQuery({ ...query, category: query.category === c.key ? undefined : c.key, page: 0 })}
            >
              {c.label}
              <span className="chip-count">{num(c.count)}</span>
            </button>
          ))}
        </div>
      )}
      {!mods && tags.length > 1 && (
        <div className="chips">
          <button className={`chip ${query.tag ? '' : 'is-selected'}`} onClick={() => setQuery({ ...query, tag: undefined, page: 0 })}>
            {t('marketplace.allTags')}
          </button>
          {tags.map((tag) => (
            <button key={tag.tag} className={`chip ${query.tag === tag.tag ? 'is-selected' : ''}`} onClick={() => setQuery({ ...query, tag: query.tag === tag.tag ? undefined : tag.tag, page: 0 })}>
              {tag.tag}
            </button>
          ))}
        </div>
      )}

      <PackGrid
        page={page}
        error={error}
        loading={loading}
        reload={reload}
        current={query.page ?? 0}
        onPage={(p) => setQuery({ ...query, page: p })}
        keep={filter?.keep}
        empty={
          filter && !searched
            ? t(mods ? 'marketplace.empty.compatibleMod' : 'marketplace.empty.compatiblePack')
            : filtered
            ? t(mods ? 'marketplace.empty.noMatchMod' : 'marketplace.empty.noMatchPack')
            : author
              ? t(mods ? 'marketplace.empty.byAuthorMod' : 'marketplace.empty.byAuthorPack')
              : t(mods ? 'marketplace.empty.noneMod' : 'marketplace.empty.nonePack')
        }
        onOpen={onOpen}
        onOpenLocal={onOpenLocal}
      />
    </div>
  )
}

/** Cartes des packs (ou des mods) d'une page, avec la pagination. */
function PackGrid({
  page,
  error,
  loading,
  reload,
  current,
  onPage,
  empty,
  keep,
  onOpen,
  onOpenLocal
}: Nav & {
  page: MarketPage | null
  error: string | null
  loading: boolean
  reload: () => void
  current: number
  onPage: (page: number) => void
  empty: string
  /** Filtre local (« Compatibles avec mon PC ») : les autres éléments de la page sont masqués. */
  keep?: (item: MarketPack) => boolean
}) {
  const { overview, task } = useStore()
  const { t } = useTranslation()
  if (!overview) return null
  if (error)
    return (
      <div className="empty-state">
        <p>{error}</p>
        <p>
          <button onClick={reload}>{t('common.retry')}</button>
        </p>
      </div>
    )
  if (!page) return loading ? <p className="muted">{t('common.loading')}</p> : null
  const items = keep ? page.items.filter(keep) : page.items
  const hidden = page.items.length - items.length
  const hiddenNote = hidden > 0 && <p className="hint hidden-note">{t('marketplace.hidden', { count: hidden, n: num(hidden) })}</p>
  if (items.length === 0 && page.totalPages <= 1)
    return (
      <EmptyState icon="search" title={empty} compact>
        {hiddenNote}
      </EmptyState>
    )
  return (
    <>
      {hiddenNote}
      <div className="grid">
        {items.map((item) => (
          <MarketCard key={item.id} item={item} library={overview.library} task={task} onOpen={onOpen} onOpenLocal={onOpenLocal} />
        ))}
      </div>
      {page.totalPages > 1 && (
        <div className="pager">
          <button disabled={current === 0} onClick={() => onPage(current - 1)}>
            {t('common.previous')}
          </button>
          <span className="muted">{t('marketplace.page', { page: num(current + 1), total: num(page.totalPages) })}</span>
          <button disabled={current + 1 >= page.totalPages} onClick={() => onPage(current + 1)}>
            {t('common.next')}
          </button>
        </div>
      )}
    </>
  )
}

function FeaturedBadge({ kind, className = '' }: { kind: MarketKind; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={`featured-badge ${className}`}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" />
      </svg>
      {kind === 'mod' ? t('marketplace.featured.badgeMod') : t('marketplace.featured.badgePack')}
    </span>
  )
}

const openItem = (item: MarketPack): MarketView => ({ kind: 'pack', id: item.id, catalog: item.kind })

/**
 * Vitrine « Packs du moment » (ou « Mods du moment ») en haut de la Marketplace : une rangée de cartes horizontales
 * compactes (couverture, nom, auteur, résumé, action), qui défile de côté quand il y en a beaucoup.
 */
function FeaturedBanner({ items, library, onOpen, onOpenLocal }: Nav & { items: MarketPack[]; library: PackManifest[] }) {
  const { task } = useStore()
  const { t } = useTranslation()
  const kind = items[0]?.kind ?? 'pack'
  const title = t(kind === 'mod' ? 'marketplace.featured.mods' : 'marketplace.featured.packs', { count: items.length })
  return (
    <section className="featured" aria-label={title}>
      <div className="featured-head">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" />
        </svg>
        {title}
        <span className="featured-sub">{t('marketplace.featured.sub')}</span>
      </div>
      <div className="featured-row">
        {items.map((item) => {
          const mine = task?.kind === 'download' && task.detail === item.id ? task : null
          return (
            <article key={item.id} className="featured-item clickable" onClick={() => onOpen(openItem(item))}>
              <div className="featured-cover">
                {item.cover ? (
                  <img className="cover-img" src={marketImageUrl(item.id, item.cover.id, true, item.kind)} alt="" draggable={false} />
                ) : (
                  <div className="cover-empty">{item.name}</div>
                )}
              </div>
              <div className="featured-body">
                <div className="name" title={item.name}>
                  {item.name}
                </div>
                {item.author && (
                  <div className="meta">
                    <Trans i18nKey="marketplace.by" components={{ author: <AuthorLink item={item} onOpen={onOpen} /> }} />
                  </div>
                )}
                {item.summary && <p className="featured-summary">{item.summary}</p>}
                <div className="spacer" />
                <div className="featured-actions" onClick={(e) => e.stopPropagation()}>
                  {mine ? <Progress task={mine} /> : <MarketAction item={item} library={library} task={task} onOpenLocal={onOpenLocal} />}
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

/** « par Auteur » : ouvre la page de l'auteur quand le pack est rattaché à son compte. */
function AuthorLink({ item, onOpen, avatar = false }: { item: MarketPack; onOpen: (view: MarketView) => void; avatar?: boolean }) {
  const { t } = useTranslation()
  const profile = item.authorProfile
  if (!profile) return <>{item.author}</>
  return (
    <button
      className="link author-link"
      title={t('marketplace.authorPage', { name: profile.displayName })}
      onClick={(e) => {
        e.stopPropagation()
        onOpen({ kind: 'author', slug: profile.slug })
      }}
    >
      {avatar && <Avatar url={profile.avatarUrl} name={profile.displayName} size={20} />}
      {item.author}
    </button>
  )
}

function MarketCard({
  item,
  library,
  task,
  onOpen,
  onOpenLocal
}: Nav & {
  item: MarketPack
  library: PackManifest[]
  task: TaskProgress | null
}) {
  const [failed, setFailed] = useState(false)
  const categories = useModCategories()
  const { overview } = useStore()
  const { t } = useTranslation()
  const mine = task?.kind === 'download' && task.detail === item.id ? task : null
  // Mod : sa catégorie à la place des étiquettes.
  const label = item.kind === 'mod' ? categoryLabel(item.category, categories) : item.tags.slice(0, 3).join(', ')
  const others = [label, bytes(item.archiveSize), item.protected && t('marketplace.protected')].filter(Boolean).join(' · ')
  const inLibrary = item.kind === 'mod' && overview ? localMod(item.id, overview.mods) : null
  return (
    <article className={`card clickable ${item.featured ? 'is-featured' : ''}`} onClick={() => onOpen(openItem(item))}>
      <div className="cover">
        {item.featured && <FeaturedBadge kind={item.kind} className="on-cover" />}
        {item.cover && !failed ? (
          <img className="cover-img" src={marketImageUrl(item.id, item.cover.id, true, item.kind)} alt="" draggable={false} onError={() => setFailed(true)} />
        ) : (
          <div className="cover-empty">{item.name}</div>
        )}
      </div>
      <div className="card-body">
        <div className="name" title={item.name}>
          {item.name}
        </div>
        <div className="meta">
          {item.author && <AuthorLink item={item} onOpen={onOpen} />}
          {item.author && others && ' · '}
          {others}
        </div>
        <div className="meta meta-row">
          <PerfBadge perf={item.performance} />
        </div>
        <div className="card-foot" onClick={(e) => e.stopPropagation()}>
          {mine ? (
            <Progress task={mine} />
          ) : (
            <>
              {/* Mod déjà dans la bibliothèque : son état prend la place du nombre de téléchargements. */}
              {!inLibrary && (
                <span className="dl-count" title={t('marketplace.downloads', { count: item.downloadCount, n: num(item.downloadCount) })}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                    <path d="M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47z" />
                    <path d="M2 13h12v1.5H2z" />
                  </svg>
                  {num(item.downloadCount)}
                </span>
              )}
              <MarketAction item={item} library={library} task={task} onOpenLocal={onOpenLocal} />
            </>
          )}
        </div>
      </div>
    </article>
  )
}

/** Pack : Télécharger / Mettre à jour / Dans la bibliothèque. Mod : Installer / Mettre à jour / Activer / Désactiver. */
function MarketAction({
  item,
  library,
  task,
  onOpenLocal,
  wide = false
}: {
  item: { id: string; sha256: string; kind: MarketKind; name: string; performance?: PackPerformance | null }
  library: PackManifest[]
  task: TaskProgress | null
  onOpenLocal: (id: string) => void
  wide?: boolean
}) {
  const { run } = useStore()
  const { t } = useTranslation()
  const confirmHeavy = usePerfConfirm()
  if (item.kind === 'mod') return <ModMarketAction item={item} wide={wide} />
  const { local, update } = localState(item, library)
  const install = async (): Promise<void> => {
    // Nouvelle version d'un pack déjà choisi : pas de nouvelle confirmation.
    if (!update && !(await confirmHeavy(item, t('marketplace.action.downloadAnyway')))) return
    await run(() => window.api.marketInstall(item.id))
  }
  if (local && !update)
    return (
      <>
        <span className="state">{t('marketplace.action.inLibrary')}</span>
        <div className="spacer" />
        <button className={wide ? 'wide' : ''} onClick={() => onOpenLocal(local.id)}>
          {t('common.open')}
        </button>
      </>
    )
  return (
    <>
      {update && !wide && <span className="accent-text small">{t('marketplace.action.newVersion')}</span>}
      <div className="spacer" />
      <button className={`primary ${wide ? 'wide' : ''}`} onClick={() => void install()} disabled={!!task}>
        {update ? t('marketplace.action.update') : t('marketplace.action.download')}
      </button>
    </>
  )
}

function MarketDetail({ id, catalog, back, onOpen, onOpenLocal }: Nav & { id: string; catalog: MarketKind; back: ReactNode }) {
  const { overview, task, run } = useStore()
  const { t, i18n } = useTranslation()
  const categories = useModCategories()
  const [pack, setPack] = useState<MarketPackDetail | null>(null)
  // Message à afficher et code de l'API (PACK_GONE / MOD_GONE : fiche introuvable).
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null)

  const load = useCallback(async () => {
    try {
      setPack(await window.api.marketDetail(id, catalog))
      setError(null)
    } catch (e) {
      const err = apiError(e)
      setError({ message: err.message, code: err.code })
    }
  }, [id, catalog])

  // Langue changée : fiche relue (textes et messages d'erreur de l'API).
  useEffect(() => {
    void load()
  }, [load, i18n.language])

  if (!overview) return null
  if (error)
    return (
      <div className="page">
        {back}
        <div className="empty-state">
          <p>{error.message}</p>
          {/* Pack retiré ou inconnu de l'API (lien du site périmé) : réessayer ne servirait à rien. */}
          {error.code !== PACK_GONE && error.code !== MOD_GONE && (
            <p>
              <button onClick={() => void load()}>{t('common.retry')}</button>
            </p>
          )}
        </div>
      </div>
    )
  if (!pack)
    return (
      <div className="page">
        {back}
        <p className="muted">{t('common.loading')}</p>
      </div>
    )

  const mod = pack.kind === 'mod'
  const mine = task?.kind === 'download' && task.detail === pack.id ? task : null
  const { local, update } = mod ? { local: localMod(pack.id, overview.mods), update: false } : localState(pack, overview.library)
  const modUpdate = mod && !!local && !!pack.sha256 && local.marketplace!.sha256 !== pack.sha256
  const category = mod ? categoryLabel(pack.category, categories) : null

  return (
    <div className="page">
      {back}
      <div className="store">
        <Gallery
          key={pack.id}
          images={pack.images.map((image) => image.id)}
          youtubeId={pack.youtubeId}
          image={(imageId) => <img className="cover-img contain" src={marketImageUrl(pack.id, imageId, false, pack.kind)} alt="" draggable={false} />}
          thumb={(imageId) => marketImageUrl(pack.id, imageId, true, pack.kind)}
          empty={<div className="cover-empty">{pack.name}</div>}
        />

        <aside className="side">
          {pack.featured && <FeaturedBadge kind={pack.kind} />}
          <h1 className="pack-title">{pack.name}</h1>
          {pack.author && (
            <div className="tags by">
              <Trans i18nKey="marketplace.by" components={{ author: <AuthorLink item={pack} onOpen={onOpen} avatar /> }} />
            </div>
          )}
          {pack.summary && <p className="summary">{pack.summary}</p>}
          <div className={mod ? 'side-actions mod-actions' : 'side-actions row-actions'}>
            {mine ? <Progress task={mine} /> : <MarketAction item={pack} library={overview.library} task={task} onOpenLocal={onOpenLocal} wide />}
          </div>
          {update && !mine && <p className="hint">{t('marketplace.detail.updatePack')}</p>}
          {modUpdate && !mine && <p className="hint">{t('marketplace.detail.updateMod')}</p>}
          {pack.protected && <p className="hint">{t(mod ? 'common.protectedMod' : 'common.protectedPack')}</p>}
          <dl className="facts">
            {category && (
              <>
                <dt>{t('marketplace.detail.category')}</dt>
                <dd>{category}</dd>
              </>
            )}
            <dt>{t('marketplace.detail.size')}</dt>
            <dd>{bytes(pack.archiveSize)}</dd>
            {pack.version && (
              <>
                <dt>{t('marketplace.detail.version')}</dt>
                <dd>{pack.version}</dd>
              </>
            )}
            <dt>{t('marketplace.detail.updatedAt')}</dt>
            <dd>{date(pack.archiveUpdatedAt ?? pack.updatedAt)}</dd>
            <dt>{t('marketplace.detail.downloads')}</dt>
            <dd>{num(pack.downloadCount)}</dd>
            {pack.tags.length > 0 && (
              <>
                <dt>{t('marketplace.detail.tags')}</dt>
                <dd>{pack.tags.join(', ')}</dd>
              </>
            )}
            <PerfFacts perf={pack.performance} />
          </dl>
          <PerfDetails id={pack.id} kind={pack.kind} perf={pack.performance} />
          {/* Le site n'a pas encore de page pour les mods. */}
          {!mod && (
            <div className="side-links">
              <button onClick={() => void run(() => window.api.openSite(`/packs/${pack.slug}/`))}>{t('marketplace.detail.viewOnSite')}</button>
            </div>
          )}
        </aside>
      </div>

      {pack.description.trim() && (
        <>
          <div className="section-head">
            <h2>{t('marketplace.detail.description')}</h2>
          </div>
          <Markdown text={pack.description} />
        </>
      )}
    </div>
  )
}

/** Page d'un auteur : photo, nom, description, liens, ses packs et ses mods. */
function AuthorView({ slug, back, onOpen, onOpenLocal }: Nav & { slug: string; back: ReactNode }) {
  const { run } = useStore()
  const { t, i18n } = useTranslation()
  const [author, setAuthor] = useState<AuthorProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [packPage, setPackPage] = useState(0)
  const [modPage, setModPage] = useState(0)
  const packs = useMarketPage({ kind: 'pack', author: slug, sort: 'popular', page: packPage })
  const mods = useMarketPage({ kind: 'mod', author: slug, sort: 'popular', page: modPage })

  const load = useCallback(async () => {
    try {
      setAuthor(await window.api.marketAuthor(slug))
      setError(null)
    } catch (e) {
      setError(cleanError(e))
    }
  }, [slug])

  // Langue changée : page relue (textes et messages d'erreur de l'API).
  useEffect(() => {
    void load()
  }, [load, i18n.language])

  if (error)
    return (
      <div className="page">
        {back}
        <div className="empty-state">
          <p>{error}</p>
          <p>
            <button onClick={() => void load()}>{t('common.retry')}</button>
          </p>
        </div>
      </div>
    )
  if (!author)
    return (
      <div className="page">
        {back}
        <p className="muted">{t('common.loading')}</p>
      </div>
    )

  // Mods : section affichée dès qu'il en a publié (le compteur peut manquer avec une API plus ancienne).
  const hasMods = author.modCount > 0 || (mods.page?.total ?? 0) > 0
  const hasPacks = author.packCount > 0 || (packs.page?.total ?? 0) > 0 || !hasMods
  const stats = [
    t('marketplace.packs', { count: author.packCount, n: num(author.packCount) }),
    author.modCount > 0 && t('marketplace.mods', { count: author.modCount, n: num(author.modCount) }),
    t('marketplace.downloads', { count: author.downloads, n: num(author.downloads) }),
    author.createdAt && t('marketplace.author.memberSince', { date: date(author.createdAt) })
  ]
  return (
    <div className="page">
      {back}
      <header className="author-head">
        <Avatar url={author.avatarUrl} name={author.displayName} size={96} />
        <div className="author-id">
          <h1 className="pack-title">{author.displayName}</h1>
          <div className="muted">{stats.filter(Boolean).join(' · ')}</div>
          {author.links.length > 0 && (
            <div className="author-links">
              {author.links.map((l, i) => (
                <button key={i} title={l.url} onClick={() => void run(() => window.api.openLink(l.url))}>
                  {l.label || l.url}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      {author.bio.trim() && <p className="author-bio">{author.bio}</p>}

      {hasPacks && (
        <>
          <div className="section-head">
            <h2>{t('marketplace.author.packs')}</h2>
          </div>
          <PackGrid {...packs} current={packPage} onPage={setPackPage} empty={t('marketplace.empty.nonePack')} onOpen={onOpen} onOpenLocal={onOpenLocal} />
        </>
      )}
      {hasMods && (
        <>
          <div className="section-head">
            <h2>{t('marketplace.author.mods')}</h2>
          </div>
          <PackGrid {...mods} current={modPage} onPage={setModPage} empty={t('marketplace.empty.noneMod')} onOpen={onOpen} onOpenLocal={onOpenLocal} />
        </>
      )}
    </div>
  )
}
