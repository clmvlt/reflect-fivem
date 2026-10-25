// Nombres, tailles, dates et durées dans la langue affichée (Intl), pour l'interface et le processus principal.

import { t } from 'i18next'
import { currentLocale } from './i18n'

/** Étiquette BCP 47 de la langue affichée, pour Intl. */
export function intlLocale(): string {
  return currentLocale()
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(n)
}

/** Taille en octets : « 1,5 Go » en français, « 1.5 GB » en anglais (multiples de 1024). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return t('format.bytes.b', { value: formatNumber(Math.max(0, Math.round(n || 0))) })
  const units = ['kb', 'mb', 'gb', 'tb'] as const
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = v < 10 ? 1 : 0
  return t(`format.bytes.${units[i]}`, { value: formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits }) })
}

/** Mémoire vidéo en Mo : « 8 Go », « 512 Mo » (« 8 GB », « 512 MB »). */
export function formatMegabytes(mb: number): string {
  return formatBytes(mb * 1024 * 1024)
}

/**
 * Durée : « 45 s », « 3 min », « 2 h 5 min », puis jours et heures à l'heure près : « 2 j 5 h » (« 2 days 5 hr »).
 * `long` pour une phrase : « 4 jours », « 2 heures 5 minutes ».
 */
export function formatDuration(seconds: number, display: 'short' | 'long' = 'short'): string {
  const unit = (value: number, u: 'second' | 'minute' | 'hour' | 'day'): string => formatNumber(value, { style: 'unit', unit: u, unitDisplay: display })
  const pair = (a: number, ua: 'hour' | 'day', b: number, ub: 'minute' | 'hour'): string => (b ? `${unit(a, ua)} ${unit(b, ub)}` : unit(a, ua))
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return unit(s, 'second')
  // Arrondi à la minute avant le découpage : jamais « 1 h 60 min ».
  const minutes = Math.round(s / 60)
  if (minutes < 60) return unit(minutes, 'minute')
  if (minutes < 24 * 60) return pair(Math.floor(minutes / 60), 'hour', minutes % 60, 'minute')
  const hours = Math.round(s / 3600)
  return pair(Math.floor(hours / 24), 'day', hours % 24, 'hour')
}

const toDate = (iso: string | number | Date | null | undefined): Date | null => {
  if (iso === null || iso === undefined || iso === '') return null
  const d = iso instanceof Date ? iso : new Date(iso)
  return Number.isFinite(d.getTime()) ? d : null
}

/** Date seule : « 14 octobre 2026 » (options Intl pour un autre format). */
export function formatDate(iso: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  const d = toDate(iso)
  return d ? d.toLocaleDateString(intlLocale(), options) : ''
}

/** Date et heure : « 14 octobre 2026 à 10:30 » (options Intl pour un autre format). */
export function formatDateTime(iso: string | number | Date | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' }): string {
  const d = toDate(iso)
  return d ? d.toLocaleString(intlLocale(), options) : ''
}

/** Date relative pour la semaine écoulée (« il y a 3 h »), sinon la date. */
export function formatRelative(iso: string | number | Date | null | undefined, now = Date.now()): string {
  const d = toDate(iso)
  if (!d) return ''
  const s = Math.max(0, (now - d.getTime()) / 1000)
  if (s < 60) return t('format.justNow')
  const short = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'always', style: 'short' })
  if (s < 3600) return short.format(-Math.floor(s / 60), 'minute')
  if (s < 86400) return short.format(-Math.floor(s / 3600), 'hour')
  if (s < 7 * 86400) return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'always', style: 'long' }).format(-Math.floor(s / 86400), 'day')
  return formatDate(d)
}

/** Nom cité : « Nom » en français, “Name” en anglais. */
export function quote(s: string): string {
  return t('format.quote', { text: s })
}

/** Liste : « A, B et C » / « A, B, and C ». */
export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type }).format(items)
}
