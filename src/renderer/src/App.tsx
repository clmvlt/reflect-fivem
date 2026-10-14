import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MarketKind } from '@shared/types'
import { useStore } from './store'
import { Library } from './components/Library'
import { PackDetail } from './components/PackDetail'
import { Cleanup } from './components/Cleanup'
import { SettingsView } from './components/SettingsView'
import { Graphics } from './components/Graphics'
import { Marketplace, type MarketView } from './components/Marketplace'
import { AccountView } from './components/AccountView'
import { Avatar } from './components/common'
import { UpdatePanel } from './components/UpdatePanel'
import icon from './assets/icon.png'

// Invitation du serveur Discord de support (discord.gg/rtBZAxqtsu).
const SUPPORT_INVITE = 'rtBZAxqtsu'

type Page = 'library' | 'market' | 'graphics' | 'cleanup' | 'account' | 'settings'

/** Bibliothèque et Marketplace s'ouvrent sur les packs ; Packs et Mods s'affichent en dessous quand l'une est ouverte. */
const SUB_NAV: { kind: MarketKind; label: 'packs' | 'mods' }[] = [
  { kind: 'pack', label: 'packs' },
  { kind: 'mod', label: 'mods' }
]

const NAV: Page[] = ['library', 'market', 'graphics', 'cleanup', 'settings']

export function App() {
  const { t } = useTranslation()
  const { overview, account, message, setMessage, run } = useStore()
  const [page, setPage] = useState<Page>('library')
  const [openPack, setOpenPack] = useState<string | null>(null)
  // Vues ouvertes dans la Marketplace (fiche, auteur...), la dernière affichée.
  const [marketStack, setMarketStack] = useState<MarketView[]>([])
  // Auteur choisi au-dessus de la liste des packs (null : tous les packs).
  const [marketAuthor, setMarketAuthor] = useState<string | null>(null)
  // Packs graphiques ou mods : choisi dans la barre latérale, sous Bibliothèque et Marketplace.
  const [catalog, setCatalog] = useState<MarketKind>('pack')
  const where = useRef({ page, catalog })
  where.current = { page, catalog }
  const [dragging, setDragging] = useState(false)

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

  // Barre latérale affichée dès le premier rendu ; les pages attendent l'état de l'application.
  const detail = openPack ? overview?.library.find((p) => p.id === openPack) : null
  const games = overview?.games
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
  }
  const openLocal = (id: string): void => {
    setPage('library')
    setOpenPack(id)
  }
  const openAuthor = (slug: string): void => {
    setPage('market')
    setMarketStack([{ kind: 'author', slug }])
  }
  /** Fiche Marketplace d'un pack (ou d'un mod) de la bibliothèque. */
  const openMarketPack = (id: string, kind: MarketKind = 'pack'): void => {
    setPage('market')
    setOpenPack(null)
    setCatalog(kind)
    setMarketStack([{ kind: 'pack', id, catalog: kind }])
  }

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
          {NAV.map((id) => {
            const open = page === id && (id === 'library' || id === 'market')
            return (
              <div key={id} className="nav-group">
                <button className={`nav ${open ? 'is-open' : page === id ? 'is-selected' : ''}`} aria-expanded={open || undefined} onClick={() => go(id)}>
                  {t(`app.nav.${id}`)}
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
          <UpdatePanel />
          {gameProblem && (
            <button className="side-status" onClick={() => go('settings')}>
              {gameProblem}
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
        {overview && (
          <>
            {page === 'library' &&
              (detail ? (
                <PackDetail pack={detail} onBack={() => setOpenPack(null)} />
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
              />
            )}
            {page === 'graphics' && <Graphics />}
            {page === 'cleanup' && <Cleanup />}
            {page === 'account' && <AccountView onOpenAuthor={openAuthor} />}
            {page === 'settings' && <SettingsView />}
          </>
        )}

        {/* Masqué pendant un message : il en couvrirait le bouton de fermeture. */}
        {!message && (
          <button className="support-link" onClick={() => void run(() => window.api.openDiscordInvite(SUPPORT_INVITE))}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2.1a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
            </svg>
            Support Discord
          </button>
        )}

        {message && (
          <div className={`bar bar-${message.kind} floating`} role="status">
            <span className="bar-text">{message.text}</span>
            <button className="close" onClick={() => setMessage(null)} aria-label={t('common.close')}>
              ×
            </button>
          </div>
        )}
      </main>
      {dragging && <div className="drop">{catalog === 'mod' && (page === 'library' || page === 'market') ? t('app.drop.mods') : t('app.drop.library')}</div>}
    </div>
  )
}
