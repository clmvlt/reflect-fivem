// Lecture et modification des réglages graphiques de GTA V.
// Seules les valeurs modifiées sont réécrites : le reste du fichier (format, ordre, autres sections) est conservé à l'identique.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GRAPHICS_KEYS, GRAPHICS_SETTINGS, type GraphicsState, type GraphicsTarget } from '@shared/graphics'
import { t } from 'i18next'
import { exists } from '../util/fsx'

const INFO_KEYS = new Set(['ScreenWidth', 'ScreenHeight', 'RefreshRate'])

export function parseGraphics(xml: string): { values: Record<string, string>; videoCard: string | null; resolution: string | null } {
  const values: Record<string, string> = {}
  const info: Record<string, string> = {}
  for (const m of xml.matchAll(/<([A-Za-z_]\w*)\s+value="([^"]*)"\s*\/>/g)) {
    if (GRAPHICS_KEYS.has(m[1]) && !(m[1] in values)) values[m[1]] = m[2]
    else if (INFO_KEYS.has(m[1])) info[m[1]] = m[2]
  }
  const card = /<VideoCardDescription>([^<]*)<\/VideoCardDescription>/.exec(xml)?.[1]?.trim() || null
  const resolution = info.ScreenWidth && info.ScreenHeight ? `${info.ScreenWidth} × ${info.ScreenHeight}${info.RefreshRate ? ` · ${info.RefreshRate} Hz` : ''}` : null
  return { values, videoCard: card, resolution }
}

/** Résolution du jeu (ScreenWidth / ScreenHeight) ; null si elle manque ou n'est pas lisible. */
export function screenSize(xml: string): { width: number; height: number } | null {
  const value = (key: string): number => Number(new RegExp(`<${key}\\s+value="(\\d+)"\\s*/>`).exec(xml)?.[1] ?? NaN)
  const width = value('ScreenWidth')
  const height = value('ScreenHeight')
  return width >= 320 && height >= 200 ? { width, height } : null
}

/** Valide et met au format du jeu (les nombres à virgule sont écrits avec 6 décimales). */
export function normalizeValue(key: string, value: string): string {
  const def = GRAPHICS_SETTINGS.find((s) => s.key === key)
  if (!def) throw new Error(t('graphics.errors.unknown', { key }))
  if (def.kind === 'bool') {
    if (value !== 'true' && value !== 'false') throw new Error(t('graphics.errors.invalid', { label: def.label }))
    return value
  }
  if (def.kind === 'choice') {
    if (!def.options?.some((o) => o.value === value)) throw new Error(t('graphics.errors.invalid', { label: def.label }))
    return value
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < (def.min ?? 0) - 1e-9 || n > (def.max ?? 1) + 1e-9) throw new Error(t('graphics.errors.invalid', { label: def.label }))
  return n.toFixed(6)
}

export function applyGraphics(xml: string, changes: Record<string, string>): string {
  let out = xml
  for (const [key, raw] of Object.entries(changes)) {
    const value = normalizeValue(key, raw)
    const re = new RegExp(`(<${key}\\s+value=")[^"]*("\\s*/>)`)
    // Réglage absent du fichier : on ne l'ajoute pas, le jeu gère ses valeurs par défaut.
    if (re.test(out)) out = out.replace(re, `$1${value}$2`)
  }
  return out
}

export class GraphicsManager {
  constructor(private backupDir: string) {}

  /** Fichiers de réglages présents : FiveM (CitizenFX) et GTA V solo (Documents). */
  async targets(documentsDir: string): Promise<GraphicsTarget[]> {
    const out: GraphicsTarget[] = []
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    for (const p of [path.join(appData, 'CitizenFX', 'gta5_settings.xml'), path.join(localAppData, 'CitizenFX', 'gta5_settings.xml')]) {
      if (await exists(p)) {
        out.push({ id: 'fivem', label: t('graphics.targets.fivem'), path: p })
        break
      }
    }
    const sp = path.join(documentsDir, 'Rockstar Games', 'GTA V', 'settings.xml')
    if (await exists(sp)) out.push({ id: 'gta', label: t('graphics.targets.gta'), path: sp })
    return out
  }

  private backupFile(id: string): string {
    return path.join(this.backupDir, `${id}-origine.xml`)
  }

  async read(target: GraphicsTarget, targets: GraphicsTarget[]): Promise<GraphicsState> {
    const xml = await fs.readFile(target.path, 'utf8')
    const parsed = parseGraphics(xml)
    const st = await fs.stat(target.path)
    return {
      target,
      targets,
      values: parsed.values,
      videoCard: parsed.videoCard,
      resolution: parsed.resolution,
      hasBackup: await exists(this.backupFile(target.id)),
      readOnly: (st.mode & 0o200) === 0
    }
  }

  /** Enregistre les modifications ; l'original est sauvegardé une seule fois, avant la toute première modification. */
  async write(target: GraphicsTarget, changes: Record<string, string>): Promise<void> {
    const xml = await fs.readFile(target.path, 'utf8')
    const next = applyGraphics(xml, changes)
    if (next === xml) return
    await fs.mkdir(this.backupDir, { recursive: true })
    if (!(await exists(this.backupFile(target.id)))) await fs.copyFile(target.path, this.backupFile(target.id))
    await this.replace(target.path, next)
  }

  async restore(target: GraphicsTarget): Promise<void> {
    const b = this.backupFile(target.id)
    if (!(await exists(b))) throw new Error(t('graphics.errors.noBackup'))
    await this.replace(target.path, await fs.readFile(b, 'utf8'))
    await fs.rm(b, { force: true })
  }

  /** Écriture atomique ; un fichier mis en lecture seule par l'utilisateur le reste après la modification. */
  private async replace(file: string, content: string): Promise<void> {
    const st = await fs.stat(file)
    const readOnly = (st.mode & 0o200) === 0
    if (readOnly) await fs.chmod(file, 0o666)
    const tmp = `${file}.fpm-tmp`
    try {
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, file)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      if (readOnly) await fs.chmod(file, 0o444).catch(() => undefined)
    }
  }
}
