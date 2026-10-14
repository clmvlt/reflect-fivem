// Détection et vérification des emplacements de FiveM et de GTA V.

import { createDecipheriv } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { t } from 'i18next'
import type { Check, FiveMInfo, GameCandidate, GamesInfo, GtaEdition, GtaInfo, GtaStore, Settings } from '@shared/types'
import { canWrite, exists, isDir, isFile } from '../util/fsx'
import { readRegistry, runningGameProcesses, type RegistrySnapshot } from '../util/win'

const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()

export function samePath(a: string | null, b: string | null): boolean {
  return !!a && !!b && norm(a) === norm(b)
}

// ---------------------------------------------------------------------------
// FiveM

/** Accepte le dossier FiveM (contenant FiveM.exe) ou directement FiveM.app. */
export async function normalizeFiveMPath(p: string): Promise<string> {
  const clean = p.replace(/[\\/]+$/, '')
  if (/fivem\.app$/i.test(clean)) return clean
  if (await isDir(path.join(clean, 'FiveM.app'))) return path.join(clean, 'FiveM.app')
  return clean
}

export async function readCitizenIni(fivemApp: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(fivemApp, 'CitizenFX.ini'), 'utf8')
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([^=;#[\]]+?)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

export async function inspectFiveM(p: string | null, source: string): Promise<FiveMInfo> {
  const info: FiveMInfo = { path: p, source, valid: false, writable: false, checks: [], gtaPathFromIni: null, buildNumber: null }
  if (!p) {
    info.checks.push({ id: 'found', label: t('games.checks.fivemFound'), ok: false, detail: t('games.checks.fivemNotFound') })
    return info
  }
  const dirOk = await isDir(p)
  info.checks.push({ id: 'exists', label: t('games.checks.exists'), ok: dirOk, detail: p })
  if (!dirOk) return info
  const citizen = await isDir(path.join(p, 'citizen'))
  const core =
    (await isFile(path.join(p, 'CoreRT.dll'))) || (await isFile(path.join(p, 'components.json'))) || (await isFile(path.join(p, 'FiveM.installroot')))
  info.checks.push({
    id: 'files',
    label: t('games.checks.fivemFiles'),
    ok: citizen && core,
    detail: citizen && core ? undefined : t('games.checks.fivemFilesInvalid')
  })
  const ini = await readCitizenIni(p)
  const hasIni = Object.keys(ini).length > 0
  info.checks.push({
    id: 'config',
    label: t('games.checks.citizenIni'),
    ok: hasIni,
    detail: hasIni ? undefined : t('games.checks.citizenIniMissing')
  })
  info.gtaPathFromIni = ini.IVPath || null
  info.buildNumber = ini.SavedBuildNumber || null
  info.writable = await canWrite(p)
  info.checks.push({ id: 'writable', label: t('games.checks.writable'), ok: info.writable, detail: info.writable ? undefined : t('games.checks.fivemNotWritable') })
  info.valid = citizen && core
  return info
}

async function fivemCandidates(reg: RegistrySnapshot): Promise<GameCandidate[]> {
  const out: GameCandidate[] = []
  const add = async (p: string | null | undefined, source: string): Promise<void> => {
    if (!p) return
    const n = await normalizeFiveMPath(p)
    if (out.some((c) => samePath(c.path, n))) return
    if (await isDir(n)) out.push({ path: n, source })
  }
  // Le protocole fivem:// est réécrit à chaque lancement : il pointe vers le FiveM.exe réellement utilisé (y compris portable).
  const proto = /"([^"]+?FiveM\.exe)"/i.exec(reg.fivemProtocol ?? '')?.[1]
  if (proto) await add(path.dirname(proto), t('games.source.protocol'))
  await add(reg.fivemLastRun, t('games.source.lastRun'))
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  await add(path.join(local, 'FiveM', 'FiveM.app'), t('games.source.default'))
  for (const u of reg.uninstall) if (/fivem/i.test(u.name) || /citizenfx/i.test(u.key)) await add(u.location, t('games.source.installed'))
  return out
}

// ---------------------------------------------------------------------------
// GTA V

export async function inspectGta(p: string | null, source: string): Promise<GtaInfo> {
  const info: GtaInfo = { path: p, source, valid: false, writable: false, checks: [], edition: 'unknown', store: 'unknown', version: null }
  if (!p) {
    info.checks.push({ id: 'found', label: t('games.checks.gtaFound'), ok: false, detail: t('games.checks.gtaNotFound') })
    return info
  }
  const dirOk = await isDir(p)
  info.checks.push({ id: 'exists', label: t('games.checks.exists'), ok: dirOk, detail: p })
  if (!dirOk) return info

  const legacyExe = await isFile(path.join(p, 'GTA5.exe'))
  const enhancedExe = await isFile(path.join(p, 'GTA5_Enhanced.exe'))
  info.edition = legacyExe ? 'legacy' : enhancedExe ? 'enhanced' : 'unknown'
  info.checks.push({
    id: 'executable',
    label: t('games.checks.executable'),
    ok: legacyExe || enhancedExe,
    detail: t(legacyExe ? 'games.checks.executableLegacy' : enhancedExe ? 'games.checks.executableEnhanced' : 'games.checks.executableMissing')
  })
  const rpfs = ['common.rpf', 'x64a.rpf', 'x64b.rpf', path.join('update', 'update.rpf'), path.join('x64', 'audio', 'audio_rel.rpf')]
  const missing: string[] = []
  for (const r of rpfs) if (!(await isFile(path.join(p, r)))) missing.push(r.replace(/\\/g, '/'))
  info.checks.push({
    id: 'files',
    label: t('games.checks.gtaFiles'),
    ok: missing.length === 0,
    detail: missing.length ? t('games.checks.gtaFilesMissing', { files: missing.join(', ') }) : undefined
  })
  if (info.edition === 'enhanced' || /v ?enhanced/i.test(path.basename(p)))
    info.checks.push({
      id: 'graphicsMods',
      label: t('games.checks.graphicsMods'),
      ok: false,
      detail: t('games.checks.graphicsModsEnhanced')
    })

  info.store = await detectStore(p)
  info.version = await readGtaVersion(p)
  info.writable = await canWrite(p)
  info.checks.push({
    id: 'writable',
    label: t('games.checks.writable'),
    ok: info.writable,
    detail: info.writable ? undefined : t('games.checks.gtaNotWritable')
  })
  info.valid = (legacyExe || enhancedExe) && missing.length === 0
  return info
}

async function detectStore(p: string): Promise<GtaStore> {
  if (/steamapps/i.test(p) || (await isFile(path.join(p, 'steam_api64.dll')))) return 'steam'
  if (/epic games/i.test(p) || (await isDir(path.join(p, '.egstore')))) return 'epic'
  if ((await isFile(path.join(p, 'PlayGTAV.exe'))) || /rockstar games/i.test(p)) return 'rockstar'
  return 'unknown'
}

async function readGtaVersion(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(p, 'versioninfo.txt'), 'utf8')
    const m = /GTA5(?:_Enhanced)?\.exe\s+([\d.]+)/i.exec(raw)
    if (m) return m[1]
  } catch {
    /* ignore */
  }
  return null
}

async function steamLibraries(steamPath: string | null): Promise<string[]> {
  const libs = new Set<string>()
  const roots = [steamPath, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].filter(Boolean) as string[]
  for (const root of roots) {
    const r = root.replace(/\//g, '\\')
    if (!(await isDir(r))) continue
    libs.add(r)
    try {
      const vdf = await fs.readFile(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'))
    } catch {
      /* ignore */
    }
  }
  return [...libs]
}

async function steamGameDir(lib: string, appId: string): Promise<string | null> {
  try {
    const acf = await fs.readFile(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`), 'utf8')
    const m = /"installdir"\s+"([^"]+)"/.exec(acf)
    if (m) return path.join(lib, 'steamapps', 'common', m[1])
  } catch {
    /* ignore */
  }
  return null
}

async function epicGtaDirs(): Promise<string[]> {
  const dir = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  const out: string[] = []
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.item')) continue
      try {
        const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
        if (/grand theft auto v|gta ?v/i.test(j.DisplayName ?? '') && j.InstallLocation) out.push(j.InstallLocation)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/** Rockstar Games Launcher : titles.dat (JSON chiffré en AES-256-CBC avec une clé et un IV nuls). */
async function rockstarTitles(): Promise<{ ti: string; il: string }[]> {
  try {
    const raw = await fs.readFile(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Rockstar Games', 'Launcher', 'titles.dat'))
    const d = createDecipheriv('aes-256-cbc', Buffer.alloc(32), Buffer.alloc(16))
    d.setAutoPadding(false)
    const plain = Buffer.concat([d.update(raw), d.final()]).subarray(16).toString('utf8')
    const json = JSON.parse(plain.slice(0, plain.lastIndexOf('}') + 1)) as { tl?: { ti: string; il: string }[] }
    return (json.tl ?? []).filter((title) => title.il)
  } catch {
    return []
  }
}

/**
 * Origine d'un dossier lu dans le registre de Rockstar : win.ts la donne sous la forme « Registre Rockstar (<valeur>) » ;
 * le nom de la valeur (InstallFolder...) est repris dans la langue affichée.
 */
function rockstarRegistrySource(source: string): string {
  const value = /^Registre Rockstar \((.+)\)$/.exec(source)?.[1]
  return value ? t('games.source.rockstarRegistry', { value }) : source
}

async function gtaCandidates(reg: RegistrySnapshot, iniPath: string | null): Promise<GameCandidate[]> {
  const out: GameCandidate[] = []
  const add = async (p: string | null | undefined, source: string): Promise<void> => {
    if (!p) return
    const clean = p.replace(/[\\/]+$/, '').replace(/^"|"$/g, '')
    if (out.some((c) => samePath(c.path, clean))) return
    if ((await isFile(path.join(clean, 'GTA5.exe'))) || (await isFile(path.join(clean, 'GTA5_Enhanced.exe')))) out.push({ path: clean, source })
  }
  await add(iniPath, t('games.source.citizenIni'))
  for (const title of await rockstarTitles()) {
    if (title.ti === 'gta5') await add(title.il, 'Rockstar Games Launcher')
    else if (title.ti === 'gta5_gen9') await add(title.il, 'Rockstar Games Launcher (Enhanced)')
  }
  for (const r of reg.rockstarPaths) {
    const source = rockstarRegistrySource(r.source)
    await add(r.path, r.enhanced ? t('games.source.enhanced', { source }) : source)
  }
  for (const lib of await steamLibraries(reg.steamPath)) {
    await add(await steamGameDir(lib, '271590'), 'Steam')
    await add(await steamGameDir(lib, '3240220'), 'Steam (Enhanced)')
  }
  for (const d of await epicGtaDirs()) await add(d, 'Epic Games')
  for (const u of reg.uninstall) if (/grand theft auto|gta v/i.test(u.name) || /271590|3240220/.test(u.key)) await add(u.location, t('games.source.installed'))
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  for (const d of ['Grand Theft Auto V', 'Grand Theft Auto V Legacy', 'Grand Theft Auto V Enhanced'])
    await add(path.join(pf, 'Rockstar Games', d), t('games.source.default'))
  await add(path.join(pf, 'Epic Games', 'GTAV'), t('games.source.defaultEpic'))
  return out
}

// ---------------------------------------------------------------------------

export async function detectGames(settings: Settings): Promise<GamesInfo> {
  const [reg, running] = await Promise.all([readRegistry(), runningGameProcesses()])
  const fivemCands = await fivemCandidates(reg)

  let fivemPath: string | null = null
  let fivemSource = ''
  if (settings.fivemPath) {
    fivemPath = await normalizeFiveMPath(settings.fivemPath)
    fivemSource = t('games.source.manual')
  } else if (fivemCands.length) {
    // Premier candidat valide
    for (const c of fivemCands) {
      if ((await isDir(path.join(c.path, 'citizen'))) || (await exists(path.join(c.path, 'CitizenFX.ini')))) {
        fivemPath = c.path
        fivemSource = c.source
        break
      }
    }
  }
  const fivem = await inspectFiveM(fivemPath, fivemSource || t('games.source.notFound'))

  const gtaCands = await gtaCandidates(reg, fivem.gtaPathFromIni)
  let gtaPath: string | null = null
  let gtaSource = ''
  if (settings.gtaPath) {
    gtaPath = settings.gtaPath
    gtaSource = t('games.source.manual')
  } else {
    // On privilégie le dossier réellement utilisé par FiveM, puis une édition Legacy.
    const legacy = []
    for (const c of gtaCands) if (await isFile(path.join(c.path, 'GTA5.exe'))) legacy.push(c)
    const pick = legacy[0] ?? gtaCands[0]
    if (pick) {
      gtaPath = pick.path
      gtaSource = pick.source
    }
  }
  const gta = await inspectGta(gtaPath, gtaSource || t('games.source.notFound'))
  const mismatch = !!fivem.gtaPathFromIni && !!gta.path && !samePath(fivem.gtaPathFromIni, gta.path)
  if (mismatch)
    gta.checks.push({
      id: 'sameFolder',
      label: t('games.checks.sameFolder'),
      ok: false,
      detail: t('games.checks.sameFolderMismatch', { path: fivem.gtaPathFromIni })
    } satisfies Check)

  return { fivem, gta, fivemCandidates: fivemCands, gtaCandidates: gtaCands, mismatch, runningProcesses: running }
}

export function gameEditionLabel(e: GtaEdition): string {
  return e === 'legacy' ? 'Legacy' : e === 'enhanced' ? 'Enhanced' : t('games.edition.unknown')
}
