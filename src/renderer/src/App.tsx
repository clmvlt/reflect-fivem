import { useEffect, useState } from 'react'
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

const NAV: { id: Page; label: string }[] = [
  { id: 'library', label: 'Bibliothèque' },
  { id: 'market', label: 'Marketplace' },
  { id: 'graphics', label: 'Graphismes' },
  { id: 'cleanup', label: 'Nettoyage' },
  { id: 'settings', label: 'Réglages' }
]

export function App() {
  const { overview, account, message, setMessage, run } = useStore()
  const [page, setPage] = useState<Page>('library')
  const [openPack, setOpenPack] = useState<string | null>(null)
  // Vues ouvertes dans la Marketplace (fiche, auteur...), la dernière affichée.
  const [marketStack, setMarketStack] = useState<MarketView[]>([])
  // Auteur choisi au-dessus de la liste des packs (null : tous les packs).
  const [marketAuthor, setMarketAuthor] = useState<string | null>(null)
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
      if (paths.length) {
        setPage('library')
        setOpenPack(null)
        void run(() => window.api.importPacks(paths))
      }
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

  // Lien « Installer via l'app » du site : fiche du pack dans la Marketplace, comme un clic sur sa carte.
  useEffect(
    () =>
      window.api.onOpenMarketPack((id) => {
        setPage('market')
        setOpenPack(null)
        setMarketStack([{ kind: 'pack', id }])
      }),
    []
  )

  // Barre latérale affichée dès le premier rendu ; les pages attendent l'état de l'application.
  const detail = openPack ? overview?.library.find((p) => p.id === openPack) : null
  const games = overview?.games
  const gameProblem = !games ? null : !games.fivem.valid ? 'FiveM introuvable' : !games.gta.valid ? 'GTA V introuvable' : games.gta.edition === 'enhanced' ? 'GTA V Enhanced' : null
  const go = (p: Page): void => {
    setPage(p)
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
          {NAV.map((n) => (
            <button key={n.id} className={`nav ${page === n.id ? 'is-selected' : ''}`} onClick={() => go(n.id)}>
              {n.label}
            </button>
          ))}
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
              <span className="ellipsis">{account ? account.displayName : 'Compte'}</span>
              {account?.mustChangePassword && <span className="nav-dot" title="Mot de passe à changer" />}
            </span>
          </button>
        </div>
      </aside>

      <main className="layer">
        {overview && (
          <>
            {page === 'library' && (detail ? <PackDetail pack={detail} onBack={() => setOpenPack(null)} /> : <Library onOpen={setOpenPack} />)}
            {page === 'market' && (
              <Marketplace
                view={marketStack[marketStack.length - 1] ?? null}
                depth={marketStack.length}
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
            <button className="close" onClick={() => setMessage(null)} aria-label="Fermer">
              ×
            </button>
          </div>
        )}
      </main>
      {dragging && <div className="drop">Déposez pour ajouter à la bibliothèque</div>}
    </div>
  )
}
