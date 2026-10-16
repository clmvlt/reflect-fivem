import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Éléments qui peuvent prendre le focus dans la carte. */
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Fenêtre modale légère : voile sur toute l'application et carte centrée (titre, contenu qui défile, boutons). Le
 * focus va au bouton marqué data-autofocus (sinon à la carte), reste dans la carte (Tab) et revient où il était à la
 * fermeture ; Échap ferme comme le bouton principal. Un clic à côté ne ferme pas : la fenêtre se ferme par ses boutons.
 * Affichée à la fin de la page, au-dessus de tout, d'où qu'elle soit ouverte (barre latérale comprise).
 */
export function Modal({ title, onClose, actions, className, children }: { title: string; onClose: () => void; actions: ReactNode; className?: string; children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const target = card.current?.querySelector<HTMLElement>('[data-autofocus]') ?? card.current
    target?.focus()
    return () => previous?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !card.current) return
    const items = Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
    if (!items.length) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <div ref={card} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>,
    document.body
  )
}
