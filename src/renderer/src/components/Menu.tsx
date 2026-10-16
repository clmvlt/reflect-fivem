import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItem } from '@shared/api'

interface Request {
  id: number
  items: MenuItem[]
  x: number
  y: number
  resolve: (choice: string | null) => void
}

/** Menu affiché par MenuHost (null tant qu'il n'est pas monté). */
let show: ((r: Request) => void) | null = null
let nextId = 0
/** Dernier clic (ou clic droit) dans la fenêtre : le menu s'ouvre à cet endroit. */
let lastPointer: { x: number; y: number; at: number } | null = null

/** Où ouvrir le menu : au dernier clic s'il vient d'avoir lieu, sinon sous l'élément qui a le focus (clavier). */
function anchor(): { x: number; y: number } {
  if (lastPointer && Date.now() - lastPointer.at < 1000) return lastPointer
  const r = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement.getBoundingClientRect() : null
  return r ? { x: r.left, y: r.bottom + 4 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
}

/**
 * Menu contextuel dans le style de l'application (clic droit, bouton ⋯), à l'endroit du clic. Renvoie l'identifiant
 * de l'élément choisi, ou null si le menu est fermé sans choix (clic ailleurs, Échap).
 */
export function popupMenu(items: MenuItem[]): Promise<string | null> {
  const open = show
  if (!open || !items.length) return Promise.resolve(null)
  const { x, y } = anchor()
  return new Promise((resolve) => open({ id: ++nextId, items, x, y, resolve }))
}

/** Affiche le menu demandé (un seul à la fois). Monté une seule fois, dans App. */
export function MenuHost() {
  const [request, setRequest] = useState<Request | null>(null)
  const current = useRef<Request | null>(null)
  current.current = request

  useEffect(() => {
    const onPointer = (e: MouseEvent): void => {
      lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() }
    }
    window.addEventListener('mousedown', onPointer, true)
    window.addEventListener('contextmenu', onPointer, true)
    show = (r) => {
      // Un nouveau menu remplace celui qui est ouvert.
      current.current?.resolve(null)
      setRequest(r)
    }
    return () => {
      show = null
      window.removeEventListener('mousedown', onPointer, true)
      window.removeEventListener('contextmenu', onPointer, true)
    }
  }, [])

  if (!request) return null
  const close = (choice: string | null): void => {
    request.resolve(choice)
    setRequest((r) => (r?.id === request.id ? null : r))
  }
  return createPortal(<Menu key={request.id} request={request} onClose={close} />, document.body)
}

function Menu({ request, onClose }: { request: Request; onClose: (choice: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Placé au point demandé, retourné vers la gauche ou le haut s'il dépasse de la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    let left = request.x
    let top = request.y
    if (left + width > window.innerWidth - margin) left = Math.max(margin, request.x - width)
    if (top + height > window.innerHeight - margin) top = Math.max(margin, request.y - height)
    setPos({ left, top })
  }, [request])

  // Focus sur le premier élément une fois le menu visible (un élément masqué ne peut pas le prendre) : flèches, Entrée.
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [pos])

  // Fermé sans choix : clic ailleurs, Échap, fenêtre quittée, redimensionnée ou page qui défile.
  useEffect(() => {
    const cancel = (): void => onClose(null)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) cancel()
    }
    const onScroll = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) cancel()
    }
    // Échap, même si le focus n'est pas dans le menu.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    let next: HTMLElement | undefined
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      return onClose(null)
    }
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length]
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length]
    else if (e.key === 'Home') next = items[0]
    else if (e.key === 'End') next = items[items.length - 1]
    else return
    e.preventDefault()
    next?.focus()
  }

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={pos ?? { left: request.x, top: request.y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {request.items.map((item, i) => (
        <div key={item.id} className="menu-group">
          {item.separator && i > 0 && <div className="menu-separator" role="separator" />}
          <button
            className={`menu-item ${item.danger ? 'is-danger' : ''}`}
            role="menuitem"
            disabled={item.enabled === false}
            onClick={() => onClose(item.id)}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
