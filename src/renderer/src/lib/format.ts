// Formats de l'interface : nombres, tailles et dates dans la langue affichée (voir @shared/intl).

import { formatBytes, formatDate, formatDateTime, formatNumber, formatRelative, quote } from '@shared/intl'
import type { BuilderImageRef } from '@shared/types'

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

/** Image d'un composant de « Créer ton pack », mise en cache par le processus principal. */
export function builderImageUrl(componentId: string, imageId: string, thumb = false): string {
  return `pm-media://builder/${encodeURIComponent(componentId)}/${encodeURIComponent(imageId)}${thumb ? '?size=thumb' : ''}`
}

/** Image d'un style d'ambiance (l'adresse change avec l'image), mise en cache par le processus principal. */
export function builderStyleImageUrl(styleId: string, version: string, thumb = false): string {
  return `pm-media://builder-style/${encodeURIComponent(styleId)}/${encodeURIComponent(version)}${thumb ? '?size=thumb' : ''}`
}

/** Image de référence en jeu de l'aperçu des styles (l'adresse change avec l'image), mise en cache par le processus principal. */
export function builderReferenceImageUrl(referenceId: string, version: string, thumb = false): string {
  return `pm-media://builder-reference/${encodeURIComponent(referenceId)}/${encodeURIComponent(version)}${thumb ? '?size=thumb' : ''}`
}

/** Adresse d'une image de « Créer ton pack » : composant, style ou image de référence en jeu. */
export function builderImageRefUrl(ref: BuilderImageRef, thumb = false): string {
  if (ref.kind === 'style') return builderStyleImageUrl(ref.styleId, ref.version, thumb)
  if (ref.kind === 'reference') return builderReferenceImageUrl(ref.referenceId, ref.version, thumb)
  return builderImageUrl(ref.componentId, ref.imageId, thumb)
}

export function packImages(p: { cover: string | null; gallery?: string[] }): string[] {
  return [...new Set([p.cover, ...(p.gallery ?? [])].filter((x): x is string => !!x))]
}

/** Note moyenne au dixième (4,3 en français, 4.3 en anglais). */
export function ratingText(average: number): string {
  return formatNumber(average, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Nombre dans la langue affichée (séparateurs de milliers). */
export function num(n: number): string {
  return formatNumber(n)
}

export function longDate(iso: string | null): string {
  return formatDate(iso)
}

/** Date relative pour la semaine écoulée (« il y a 3 h »), sinon la date. */
export function ago(iso: string): string {
  return formatRelative(iso)
}

/** Date et heure complètes (infobulle). */
export function fullDate(iso: string): string {
  return formatDateTime(iso)
}
