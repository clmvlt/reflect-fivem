import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'

interface Request {
  id: number
  message: string
  detail: string
  okLabel: string
  resolve: (ok: boolean) => void
}

/** Fenêtre affichée par ConfirmHost (null tant qu'il n'est pas monté). */
let show: ((r: Request) => void) | null = null
let nextId = 0

/**
 * Demande de confirmation dans l'application (fenêtre modale, pas une boîte de dialogue de Windows). Renvoie true si
 * l'utilisateur confirme ; Échap ou Annuler renvoient false.
 */
export function confirmDialog(message: string, detail: string, okLabel: string): Promise<boolean> {
  if (!show) return window.api.confirm(message, detail, okLabel)
  const open = show
  return new Promise<boolean>((resolve) => open({ id: ++nextId, message, detail, okLabel, resolve }))
}

/** Affiche les demandes de confirmation, une à la fois, dans l'ordre. Monté une seule fois, dans App. */
export function ConfirmHost() {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<Request[]>([])

  useEffect(() => {
    show = (r) => setQueue((q) => [...q, r])
    return () => {
      show = null
    }
  }, [])

  const current = queue[0]
  if (!current) return null
  const answer = (ok: boolean): void => {
    current.resolve(ok)
    // Double clic : la demande suivante n'est pas retirée avec celle-ci.
    setQueue((q) => (q[0]?.id === current.id ? q.slice(1) : q))
  }
  return (
    <Modal
      key={current.id}
      className="confirm"
      title={current.message}
      onClose={() => answer(false)}
      actions={
        <>
          <button className="primary" data-autofocus onClick={() => answer(true)}>
            {current.okLabel}
          </button>
          <button onClick={() => answer(false)}>{t('common.cancel')}</button>
        </>
      }
    >
      {current.detail && <p className="confirm-detail">{current.detail}</p>}
    </Modal>
  )
}
