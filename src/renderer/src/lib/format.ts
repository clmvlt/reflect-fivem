// Formats de l'interface : nombres, tailles et dates dans la langue affichée (voir @shared/intl).

import { formatBytes, formatDate, formatNumber, quote } from '@shared/intl'

export function bytes(n: number): string {
  return formatBytes(n)
}

/** Nom cité : « Nom » en français (espaces insécables), “Name” en anglais. */
export function q(s: string): string {
  return quote(s)
}

/** URL d'une image d'un pack ou d'un mod (servie par le processus principal, limitée à sa bibliothèque). */
export function mediaUrl(packId: string, rel: string, kind: 'pack' | 'mod' = 'pack'): string {
  return `pm-media://${kind}/${encodeURIComponent(packId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

/** Image de la Marketplace, mise en cache par le processus principal. */
export function marketImageUrl(packId: string, imageId: string, thumb = false, kind: 'pack' | 'mod' = 'pack'): string {
  const params = new URLSearchParams()
  if (thumb) params.set('size', 'thumb')
  if (kind === 'mod') params.set('kind', 'mod')
  const query = params.toString()
  return `pm-media://market/${encodeURIComponent(packId)}/${encodeURIComponent(imageId)}${query ? `?${query}` : ''}`
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
