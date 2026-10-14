// Client HTTP commun des requêtes vers l'API : toutes partent du processus principal avec la langue affichée
// (Accept-Language), dans laquelle l'API répond (« detail » des erreurs, catégories, modèle de performance, analyses).
//
// Maintenance : pendant une maintenance prévue par l'admin, l'API répond 503 problem+json { code: "maintenance",
// maintenance } à toute requête d'un non-admin (sauf /maintenance, /locales, /auth/** et /app/**). serverFetch la lève
// en MaintenanceError et la signale au service des maintenances (onMaintenanceError) : ce n'est pas une perte de réseau,
// ni une erreur à réessayer en boucle, ni une raison de déconnecter le compte.

import { t } from 'i18next'
import { currentLocale } from '@shared/i18n'
import { parseMaintenance, type Maintenance } from '@shared/maintenance'

/** Erreur renvoyée par l'API : `detail` (message à afficher) et `code` facultatif. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message)
  }
}

export const MAINTENANCE_CODE = 'maintenance'

/** Requête refusée pendant une maintenance (503 « maintenance ») : le service est fermé, pas le réseau. */
export class MaintenanceError extends ApiError {
  constructor(
    message: string,
    /** Maintenance en cours (null si l'API ne l'a pas jointe). */
    public maintenance: Maintenance | null,
    /** En-tête Retry-After : secondes jusqu'à la fin prévue. */
    public retryAfter: number | null
  ) {
    super(message, 503, MAINTENANCE_CODE)
  }
}

/** En-têtes de la requête, complétés par Accept-Language (sauf s'il est déjà donné). */
export function withLanguage(init: RequestInit = {}, locale = currentLocale()): RequestInit {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', locale)
  return { ...init, headers }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** fetch donné (net.fetch d'Electron, ou celui d'un test) qui envoie la langue affichée. */
export function languageFetch(fetch: Fetch): Fetch {
  return (url, init) => fetch(url, withLanguage(init))
}

/** Retry-After en secondes (nombre de secondes, ou date HTTP) ; null s'il est absent ou illisible. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  if (/^\d+$/.test(header.trim())) return Number(header.trim())
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, Math.round((date - now) / 1000)) : null
}

/** Réponse 503 « maintenance » de l'API : l'erreur correspondante (corps lu sur une copie), sinon null. */
export async function maintenanceError(response: Response): Promise<MaintenanceError | null> {
  if (response.status !== 503) return null
  const problem = (await response.clone().json().catch(() => null)) as { code?: unknown; detail?: unknown; maintenance?: unknown } | null
  if (problem?.code !== MAINTENANCE_CODE) return null
  const detail = typeof problem.detail === 'string' && problem.detail.trim() ? problem.detail : t('maintenance.inProgress')
  return new MaintenanceError(detail, parseMaintenance(problem.maintenance), retryAfterSeconds(response.headers.get('Retry-After')))
}

const maintenanceListeners = new Set<(err: MaintenanceError) => void>()

/** Prévenu de chaque réponse 503 « maintenance » reçue par serverFetch. */
export function onMaintenanceError(listener: (err: MaintenanceError) => void): () => void {
  maintenanceListeners.add(listener)
  return () => {
    maintenanceListeners.delete(listener)
  }
}

/**
 * fetch des requêtes vers l'API : langue affichée, et réponse 503 « maintenance » levée en MaintenanceError (après
 * l'avoir signalée). Les autres réponses, erreurs comprises, sont rendues telles quelles.
 */
export function serverFetch(fetch: Fetch): Fetch {
  const send = languageFetch(fetch)
  return async (url, init) => {
    const response = await send(url, init)
    const err = await maintenanceError(response)
    if (!err) return response
    for (const listener of maintenanceListeners) {
      try {
        listener(err)
      } catch {
        /* un service qui échoue n'empêche pas l'erreur de remonter */
      }
    }
    throw err
  }
}
