import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DownloadKind, MarketKind } from '@shared/types'
import { canUseBuilder } from '@shared/api'
import { useStore } from './store'
import { Library } from './components/Library'
import { PackDetail } from './components/PackDetail'
import { Cleanup } from './components/Cleanup'
import { SettingsView } from './components/SettingsView'
import { InstancesView } from './components/InstancesView'
import { Graphics } from './components/Graphics'
import { Marketplace, type MarketView } from './components/Marketplace'
import { Builder, BuilderIcon, type BuilderRequest } from './components/Builder'
import { AccountView } from './components/AccountView'
import { Avatar } from './components/common'
import { UpdatePanel } from './components/UpdatePanel'
import { DiscordIcon, DiscordView } from './components/DiscordView'
import { GameControl } from './components/GameControl'
import { MaintenanceBanner, MaintenanceScreen, useMaintenance } from './components/Maintenance'
import { WhatsNew } from './components/WhatsNew'
import { DownloadBar } from './components/Downloads'
import { ConfirmHost } from './components/Confirm'
import { MenuHost } from './components/Menu'
import icon from './assets/icon.png'

/** instances : page des instances FiveM, ouverte depuis les réglages. */
type Page = 'library' | 'market' | 'builder' | 'graphics' | 'cleanup' | 'discord' | 'account' | 'settings' | 'instances'

/** Bibliothèque et Marketplace s'ouvrent sur les packs ; Packs et Mods s'affichent en dessous quand l'une est ouverte. */
const SUB_NAV: { kind: MarketKind; label: 'packs' | 'mods' }[] = [
  { kind: 'pack', label: 'packs' },
  { kind: 'mod', label: 'mods' }
]

const NAV: Exclude<Page, 'instances'>[] = ['library', 'market', 'builder', 'graphics', 'cleanup', 'settings']

export function App() {
  const { t } = useTranslation()
  const { overview, account, links, whatsNew, dismissWhatsNew, message, setMessage, run } = useStore()
  const [page, setPage] = useState<Page>('market')
  const [openPack, setOpenPack] = useState<string | null>(null)
  // Vues ouvertes dans la Marketplace (fiche, auteur...), la dernière affichée.
  const [marketStack, setMarketStack] = useState<MarketView[]>([])
  // Auteur choisi au-dessus de la liste des packs (null : tous les packs).
  const [marketAuthor, setMarketAuthor] = useState<string | null>(null)
  // Packs graphiques ou mods : choisi dans la barre latérale, sous Bibliothèque et Marketplace.
  const [catalog, setCatalog] = useState<MarketKind>('pack')
  const where = useRef({ page, catalog })
  where.current = { page, catalog }
  // Création de « Créer ton pack » à ouvrir (fiche d'un pack construit, file des téléchargements).
  const [builderRequest, setBuilderRequest] = useState<BuilderRequest | null>(null)
  // Connexion demandée depuis une fiche (pour noter, commenter) : page de la fiche, où revenir une fois connecté.
  const [signInFrom, setSignInFrom] = useState<Page | null>(null)
  const [dragging, setDragging] = useState(false)
  const maintenance = useMaintenance()

  // Glisser-déposer d'archives (ou de dossiers) n'importe où dans la fenêtre.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.api.getPathForFile(f))
        .filter(Boolean)
      if (!paths.length) return
      // Un .rpf seul est un mod ; une archive déposée sur l'onglet Mods aussi.
      const onMods = where.current.catalog === 'mod' && (where.current.page === 'library' || where.current.page === 'market')
      const mods = paths.filter((p) => onMods || /\.rpf$/i.test(p))
      const packs = paths.filter((p) => !mods.includes(p))
      setPage('library')
      setOpenPack(null)
      setCatalog(packs.length ? 'pack' : 'mod')
      // Une seule opération à la fois : les packs d'abord, sinon les mods.
      if (packs.length) void run(() => window.api.importPacks(packs))
      else void run(() => window.api.importMods(mods))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [run])

  // Lien « Installer via l'app » du site : fiche du pack (ou du mod) dans la Marketplace, comme un clic sur sa carte.
  useEffect(
    () =>
      window.api.onOpenMarketPack((id, kind) => {
        setPage('market')
        setOpenPack(null)
        setCatalog(kind)
        setMarketAuthor(null)
        setMarketStack([{ kind: 'pack', id, catalog: kind }])
      }),
    []
  )

  // Lien Discord retiré depuis le site : sa page n'a plus de bouton pour rejoindre le serveur.
  useEffect(() => {
    if (page === 'discord' && !links.discord) setPage('library')
  }, [page, links.discord])

  useEffect(() => {
    if (!account || !signInFrom) return
    setSignInFrom(null)
    if (page === 'account') setPage(signInFrom)
  }, [account, signInFrom, page])

  // « Créer ton pack » : seulement avec un compte qui a le droit « Peut créer un pack ». Déconnexion ou droit retiré
  // (compte relu après un refus de l'API) pendant que la page est ouverte : retour à la Marketplace. Le brouillon en
  // cours reste gardé pour la prochaine ouverture.
  const builderAllowed = canUseBuilder(account)
  useEffect(() => {
    if (page !== 'builder' || account === undefined || builderAllowed) return
    setPage('market')
    setBuilderRequest(null)
    if (account) setMessage({ kind: 'info', text: t('builder.errors.notAllowed') })
  }, [page, account, builderAllowed, setMessage, t])

  // Barre latérale affichée dès le premier rendu ; les pages attendent l'état de l'application.
  const detail = openPack ? overview?.library.find((p) => p.id === openPack) : null
  const games = overview?.games
  // Plusieurs instances FiveM : celle qui est active, rappelée dans la barre latérale.
  const currentInstance = (overview?.instances.length ?? 0) > 1 ? overview?.instances.find((i) => i.current) : undefined
  const updates = overview?.market.updates.length ?? 0
  // Mises à jour en ligne, par genre (sous la Bibliothèque).
  const updatesOf = (kind: MarketKind): number =>
    (kind === 'mod' ? (overview?.mods ?? []) : (overview?.library ?? [])).filter((p) => overview?.market.updates.includes(p.id)).length
  const gameProblem = !games ? null : !games.fivem.valid
      ? t('app.gameProblem.fivemMissing')
      : !games.gta.valid
        ? t('app.gameProblem.gtaMissing')
        : games.gta.edition === 'enhanced'
          ? t('app.gameProblem.gtaEnhanced')
          : null
  const go = (p: Page, kind: MarketKind = 'pack'): void => {
    setPage(p)
    setCatalog(kind)
    setMarketAuthor(null)
    setOpenPack(null)
    setMarketStack([])
    setSignInFrom(null)
    setBuilderRequest(null)
  }
  const openLocal = (id: string): void => {
    setPage('library')
    setOpenPack(id)
  }
  const openAuthor = (slug: string): void => {
    setPage('market')
    setMarketStack([{ kind: 'author', slug }])
  }
  /** Fiche Marketplace d'un pack (ou d'un mod) de la bibliothèque (notes et commentaires). */
  const openMarketPack = (id: string, kind: MarketKind = 'pack'): void => {
    setPage('market')
    setOpenPack(null)
    setCatalog(kind)
    setMarketStack([{ kind: 'pack', id, catalog: kind }])
  }
  /** Création de « Créer ton pack » ouverte dans l'assistant (sans le droit : rien). */
  const openBuild = (buildId: string): void => {
    if (!builderAllowed) return
    setPage('builder')
    setOpenPack(null)
    setBuilderRequest({ buildId, at: Date.now() })
  }
  /**
   * Fiche d'un téléchargement de la file : pack ou mod de la Marketplace, ou création (dans l'assistant ; sans le droit,
   * le pack construit de la bibliothèque s'il existe).
   */
  const openDownload = (id: string, kind: DownloadKind): void => {
    if (kind !== 'build') return openMarketPack(id, kind)
    if (builderAllowed) return openBuild(id)
    const built = overview?.library.find((p) => p.built?.buildId === id)
    if (built) openLocal(built.id)
  }
  /** Connexion depuis une fiche de la Marketplace ou de la bibliothèque (la fiche reste ouverte pour le retour). */
  const signIn = (): void => {
    setSignInFrom(page)
    setPage('account')
  }
  // Maintenance (sauf pour l'admin) : écran de maintenance à la place des pages qui passent par le serveur. La connexion
  // reste possible (l'API la permet) : un admin peut se connecter pour ne plus être bloqué.
  const serverPage = page === 'market' || page === 'builder' || (page === 'account' && !!account)
  const maintenanceScreen = maintenance.blocked && serverPage && maintenance.ongoing && maintenance.state
  // Nouveautés : jamais par-dessus un écran qui bloque (chargement, maintenance, connexion au compte) ; montrées ensuite.
  const showWhatsNew = !!whatsNew && !!overview && !maintenanceScreen && !(page === 'account' && !account)


  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={icon} alt="" />
          <span>
            Reflect <span className="brand-sub">FiveM</span>
          </span>
        </div>
        <nav>
          {NAV.filter((id) => id !== 'builder' || builderAllowed).map((id) => {
            const open = page === id && (id === 'library' || id === 'market')
            const selected = page === id || (id === 'settings' && page === 'instances')
            return (
              <div key={id} className="nav-group">
                <button className={`nav ${open ? 'is-open' : selected ? 'is-selected' : ''}`} aria-expanded={open || undefined} onClick={() => go(id)}>
                  {id === 'builder' ? (
                    <span className="nav-icon">
                      <BuilderIcon />
                      {t('app.nav.builder')}
                    </span>
                  ) : (
                    t(`app.nav.${id}`)
                  )}
                  {/* Packs et mods de la bibliothèque dont une nouvelle version est en ligne. */}
                  {id === 'library' && !open && updates > 0 && (
                    <span className="nav-badge" title={t('app.updatesAvailable', { count: updates })}>
                      {updates}
                    </span>
                  )}
                </button>
                {open &&
                  SUB_NAV.map((s) => {
                    const count = id === 'library' ? updatesOf(s.kind) : 0
                    return (
                      <button key={s.kind} className={`nav nav-sub ${catalog === s.kind ? 'is-selected' : ''}`} onClick={() => go(id, s.kind)}>
                        {t(`app.nav.${s.label}`)}
                        {count > 0 && (
                          <span className="nav-badge" title={t('app.updatesAvailable', { count })}>
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}
              </div>
            )
          })}
        </nav>
        <div className="side-bottom">
          {currentInstance && (
            <button className="side-instance" onClick={() => go('instances')} title={t('instances.view.sidebarTitle')}>
              <span className="ellipsis">{t('instances.view.sidebar', { name: currentInstance.name })}</span>
            </button>
          )}
          <GameControl />
          <UpdatePanel />
          {gameProblem && (
            <button className="side-status" onClick={() => go('settings')}>
              {gameProblem}
            </button>
          )}
          {links.discord && (
            <button className={`nav side-discord ${page === 'discord' ? 'is-selected' : ''}`} onClick={() => go('discord')}>
              <span className="nav-account">
                <span className="avatar discord-nav-icon" style={{ width: 24, height: 24 }} aria-hidden>
                  <DiscordIcon size={14} />
                </span>
                <span className="ellipsis">{t('app.nav.discord')}</span>
              </span>
            </button>
          )}
          {/* Compte : tout en bas de la barre latérale. */}
          <button className={`nav side-account ${page === 'account' ? 'is-selected' : ''}`} onClick={() => go('account')}>
            <span className="nav-account">
              {account ? (
                <Avatar url={account.avatarUrl} name={account.displayName} size={24} />
              ) : (
                <span className="avatar" style={{ width: 24, height: 24 }} aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="5" r="3" />
                    <path d="M2 14.5c0-3 2.7-5 6-5s6 2 6 5z" />
                  </svg>
                </span>
              )}
              <span className="ellipsis">{account ? account.displayName : t('app.nav.account')}</span>
              {account?.mustChangePassword && <span className="nav-dot" title={t('app.passwordToChange')} />}
            </span>
          </button>
        </div>
      </aside>

      <main className="layer">
        <MaintenanceBanner info={maintenance} screen={!!maintenanceScreen} />
        {maintenanceScreen && <MaintenanceScreen ongoing={maintenance.ongoing!} state={maintenance.state!} />}
        {overview && !maintenanceScreen && (
          <>
            {page === 'library' &&
              (detail ? (
                <PackDetail
                  key={detail.id}
                  pack={detail}
                  onBack={() => setOpenPack(null)}
                  onOpenMarket={(id) => openMarketPack(id)}
                  onEditBuild={openBuild}
                  onSignIn={signIn}
                />
              ) : (
                <Library kind={catalog} onOpen={setOpenPack} onOpenMarket={openMarketPack} onBrowse={(k) => go('market', k)} />
              ))}
            {page === 'market' && (
              <Marketplace
                view={marketStack[marketStack.length - 1] ?? null}
                depth={marketStack.length}
                catalog={catalog}
                onOpen={(v) => setMarketStack((s) => [...s, v])}
                onBack={() => setMarketStack((s) => s.slice(0, -1))}
                onOpenLocal={openLocal}
                author={marketAuthor}
                onAuthor={setMarketAuthor}
                onSignIn={signIn}
              />
            )}
            {page === 'builder' && <Builder key={builderRequest?.at ?? 'page'} request={builderRequest} onOpenLocal={openLocal} />}
            {page === 'graphics' && <Graphics />}
            {page === 'cleanup' && <Cleanup />}
            {page === 'discord' && <DiscordView />}
            {page === 'account' && <AccountView onOpenAuthor={openAuthor} onBack={
                  signInFrom
                    ? () => {
                        setSignInFrom(null)
                        setPage(signInFrom)
                      }
                    : undefined
                } />}
            {page === 'settings' && <SettingsView onManageInstances={() => go('instances')} />}
            {page === 'instances' && <InstancesView onBack={() => go('settings')} />}
          </>
        )}

        {message && (
          <div className={`bar bar-${message.kind} floating`} role="status">
            <span className="bar-text">{message.text}</span>
            <button className="close" onClick={() => setMessage(null)} aria-label={t('common.close')}>
              ×
            </button>
          </div>
        )}
        {/* Téléchargements : bande en bas de la page, qui ne recouvre rien (la page se raccourcit d'autant). */}
        <DownloadBar onOpen={openDownload} />
      </main>
      <ConfirmHost />
      <MenuHost />
      {showWhatsNew && <WhatsNew whatsNew={whatsNew} onClose={dismissWhatsNew} />}
      {dragging && <div className="drop">{catalog === 'mod' && (page === 'library' || page === 'market') ? t('app.drop.mods') : t('app.drop.library')}</div>}
    </div>
  )
}
