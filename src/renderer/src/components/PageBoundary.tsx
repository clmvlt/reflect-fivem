// Erreur d'affichage : sans limite d'erreur, React retire tout l'affichage quand un composant échoue (fenêtre vide, noire
// en thème sombre). Ici, l'erreur est notée dans le journal de l'application et la page est remplacée par un message
// avec « Réessayer » ; la barre latérale reste utilisable.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from 'i18next'

export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = (info.componentStack ?? '').trim().split('\n').slice(0, 6).join('\n')
    window.api.reportError(`${error.message}\n${error.stack ?? ''}\n${where}`).catch(() => undefined)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="page">
        <div className="empty-state">
          <p>
            <strong>{t('app.crash.title')}</strong>
          </p>
          <p className="muted">{t('app.crash.text')}</p>
          <p className="muted small">{error.message}</p>
          <p>
            <button onClick={() => this.setState({ error: null })}>{t('common.retry')}</button>
          </p>
        </div>
      </div>
    )
  }
}
