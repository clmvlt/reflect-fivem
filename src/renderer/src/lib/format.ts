// Formats de l'interface : nombres, tailles et dates dans la langue affichée (voir @shared/intl).

import { formatBytes, formatDate, formatNumber, quote } from '@shared/intl'

export function bytes(n: number): string {
  return formatBytes(n)
}

/** Nom cité : « Nom » en français (espaces insécables), “Name” en anglais. */
export function q(s: string): string {
  return quote(s)
}

/** URL d'une image d'un pack (servie par le processus principal, limitée à la bibliothèque). */
export function mediaUrl(packId: string, rel: string): string {
  return `pm-media://pack/${encodeURIComponent(packId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/** Image de la Marketplace, mise en cache par le processus principal. */
export function marketImageUrl(packId: string, imageId: string, thumb = false): string {
  return `pm-media://market/${encodeURIComponent(packId)}/${encodeURIComponent(imageId)}${thumb ? '?size=thumb' : ''}`
}

export function packImages(p: { cover: string | null; gallery?: string[] }): string[] {
  return [...new Set([p.cover, ...(p.gallery ?? [])].filter((x): x is string => !!x))]
}

/** Nombre dans la langue affichée (séparateurs de milliers). */
export function num(n: number): string {
  return formatNumber(n)
}

export function longDate(iso: string | null): string {
  return formatDate(iso)
}
