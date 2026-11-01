// Options d'un mod de la Marketplace (couleur des flammes...), lues dans sa fiche et réglées dans l'application. Le choix du
// joueur (id de l'option -> valeur) est appliqué sur son PC : le mod d'origine n'est jamais modifié. Valeur d'une couleur :
// « #rrggbb », ou « #rrggbb,#rrggbb » pour un dégradé, du début à la fin de la vie de la particule.

import type { ModOption } from './types'

const OPTION_ID = /^[a-z0-9-]{1,32}$/
const TARGET_FILE = /^[A-Za-z0-9_.-]{1,60}\.ypt$/
const PARTICLE = /^[A-Za-z0-9_.-]{1,96}$/
const COLOR = /^#[0-9a-f]{6}$/i
/** En dessous, une flamme ne se voit plus : ces particules ajoutent leur couleur à l'image, et le noir n'y ajoute rien. */
const MIN_BRIGHTNESS = 0x30

/** Options valides d'une fiche ; une option inconnue (d'une API plus récente) ou incomplète est ignorée. */
export function parseModOptions(raw: unknown): ModOption[] {
  if (!Array.isArray(raw)) return []
  const out: ModOption[] = []
  for (const o of raw as Partial<ModOption>[]) {
    if (!o || o.type !== 'color' || typeof o.id !== 'string' || !OPTION_ID.test(o.id) || out.some((x) => x.id === o.id)) continue
    if (!o.label || typeof o.label !== 'object' || typeof o.label.fr !== 'string' || !Array.isArray(o.targets)) continue
    const targets = o.targets.filter(
      (x) => typeof x?.file === 'string' && TARGET_FILE.test(x.file) && Array.isArray(x.particles) && x.particles.length > 0 && x.particles.every((p) => typeof p === 'string' && PARTICLE.test(p))
    )
    if (targets.length) out.push({ id: o.id, type: 'color', label: o.label, targets })
  }
  return out
}

/** Nom d'une option dans la langue affichée (repli : le français, toujours présent). */
export function optionLabel(option: ModOption, language: string): string {
  return option.label[language.split('-')[0]] ?? option.label.fr
}

/** Couleur ou dégradé dont chaque teinte est assez lumineuse pour se voir en jeu. */
export function isUsableColor(value: string): boolean {
  const stops = value.split(',')
  return stops.length <= 2 && stops.every((c) => COLOR.test(c) && Math.max(...hexToBytes(c)) >= MIN_BRIGHTNESS)
}

/** Teintes de début et de fin d'une valeur (les mêmes pour une couleur unie). */
export function colorStops(value: string): [string, string] {
  const [start, end] = value.split(',')
  return [start, end ?? start]
}

/** Peinture d'une particule (voir rpfRecolor.ts) : sa couleur, et celle de sa fin de vie pour un dégradé. */
export function paintOf(value: string): { rgb: [number, number, number]; rgbEnd?: [number, number, number] } {
  const [start, end] = value.split(',')
  return end ? { rgb: colorToRgb(start), rgbEnd: colorToRgb(end) } : { rgb: colorToRgb(start) }
}

/** Fond CSS d'un aperçu de cette valeur. */
export function colorCss(value: string): string {
  const [start, end] = colorStops(value)
  return start === end ? start : `linear-gradient(to right, ${start}, ${end})`
}

function hexToBytes(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** Couleur des images clés des particules : rouge, vert, bleu de 0 à 1. */
export function colorToRgb(value: string): [number, number, number] {
  const [r, g, b] = hexToBytes(value)
  return [r / 255, g / 255, b / 255]
}

/** Choix qui s'appliquent encore : options toujours proposées par le mod, couleurs valides. */
export function usableValues(options: ModOption[], values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const o of options) {
    const value = values?.[o.id]
    if (typeof value === 'string' && isUsableColor(value)) out[o.id] = value.toLowerCase()
  }
  return out
}
