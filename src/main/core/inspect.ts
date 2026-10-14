// Vérifications de compatibilité FiveM d'un pack importé (à partir des fichiers réels, pas seulement des noms).

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tm, type Msg } from '@shared/i18n'
import type { Destination, Insight } from '@shared/types'
import { inspectRpfHead, parsePe, parseVersion, versionAtLeast, type PeInfo } from './binary'
import type { PackContent } from './content'
import { base, ext, PROXY_DLLS, textMsg } from './knowledge'

/** À incrémenter quand les vérifications changent : les packs déjà importés sont revérifiés. */
export const INSIGHTS_VERSION = 5

/**
 * Vérification enregistrée dans le manifeste : {@link title} (nom de fichier, gardé tel quel, ou texte à traduire) et
 * {@link text} sont gardés sous forme de clé, avec leur traduction du moment comme texte de repli.
 */
export function insight(rel: string, level: Insight['level'], title: string | Msg, text: Msg, builds?: number[]): Insight {
  return {
    rel,
    level,
    ...(typeof title === 'string' ? { title } : { title: tm(title), titleMsg: title }),
    text: tm(text),
    textMsg: text,
    ...(builds ? { builds } : {})
  }
}

export interface InspectResult {
  insights: Insight[]
  reshadeVersion: string | null
}

const topLevel = (dest: Destination, dir: string): boolean => dest.root === 'fivem' && new RegExp(`^${dir}/[^/]+$`, 'i').test(dest.path)

export async function inspectPack(content: PackContent, installMap: { rel: string; dest: Destination }[]): Promise<InspectResult> {
  const insights: Insight[] = []
  let reshadeVersion: string | null = null
  const pe = async (rel: string): Promise<PeInfo | null> => {
    const buf = await content.read(rel)
    return buf ? parsePe(buf) : null
  }

  for (const { rel, dest } of installMap) {
    const name = base(rel)
    const lower = name.toLowerCase()
    const e = ext(lower)

    if (PROXY_DLLS.has(lower)) {
      if (dest.root === 'gta') {
        insights.push(insight(rel, 'warn', name, textMsg('insights.checks.proxyInGta')))
        continue
      }
      if (!topLevel(dest, 'plugins')) continue
      const info = await pe(rel)
      const product = (info?.productName ?? '').trim()
      const v = parseVersion(info?.productVersion ?? info?.fileVersion ?? null)
      const vs = v.join('.')
      if (/^reshade$/i.test(product)) {
        reshadeVersion = vs || null
        if (!versionAtLeast(v, [3, 1])) insights.push(insight(rel, 'bad', `ReShade ${vs}`, textMsg('insights.checks.tooOld')))
        else if (vs.startsWith('5.9.0')) insights.push(insight(rel, 'bad', `ReShade ${vs}`, textMsg('insights.checks.blocked')))
        else if (versionAtLeast(v, [5])) insights.push(insight(rel, 'ok', `ReShade ${vs}`, textMsg('insights.checks.accepted')))
        else insights.push(insight(rel, 'ok', `ReShade ${vs}`, textMsg('insights.checks.accepted')))
      } else if (/^enbseries$/i.test(product)) {
        const old = !versionAtLeast(v, [0, 3, 8, 7]) || /2019,\s*Boris/i.test(info?.copyright ?? '')
        insights.push(
          old
            ? insight(rel, 'bad', `ENBSeries ${vs}`, textMsg('insights.checks.tooOld'))
            : insight(rel, 'ok', `ENBSeries ${vs}`, textMsg('insights.checks.accepted'))
        )
      } else {
        insights.push(insight(rel, 'warn', name, textMsg('insights.checks.notReshadeEnb')))
      }
      continue
    }

    if (e === '.asi') {
      if (lower === 'openiv.asi') {
        insights.push(insight(rel, 'bad', name, textMsg('insights.checks.openiv')))
        continue
      }
      if (!topLevel(dest, 'plugins')) {
        insights.push(insight(rel, 'warn', name, textMsg('insights.checks.asiOutside')))
        continue
      }
      const info = await pe(rel)
      if (!info) continue
      if (!info.asiBuilds.length)
        insights.push(insight(rel, 'warn', name, textMsg('insights.checks.noBuild')))
      else
        insights.push(
          insight(
            rel,
            'info',
            name,
            textMsg('insights.checks.builds', { from: info.asiBuilds[0], to: info.asiBuilds[info.asiBuilds.length - 1] }),
            info.asiBuilds
          )
        )
      continue
    }

    if (e === '.rpf' && dest.root === 'fivem' && /^mods\//i.test(dest.path)) {
      if (!topLevel(dest, 'mods')) {
        insights.push(insight(rel, 'warn', name, textMsg('insights.checks.rpfSubfolder')))
        continue
      }
      const r = await inspectRpfHead((bytes) => content.head(rel, bytes))
      if (!r.valid) insights.push(insight(rel, 'bad', name, textMsg('insights.checks.rpfInvalid')))
      else if (r.encryption === 'AES' || r.encryption === 'NG' || r.encryption === 'UNKNOWN')
        insights.push(insight(rel, 'bad', name, textMsg('insights.checks.rpfEncrypted')))
      else if (r.hasAssembly === false) insights.push(insight(rel, 'warn', name, textMsg('insights.checks.rpfNoAssembly')))
      else if (r.encryption === 'CFXP') insights.push(insight(rel, 'ok', name, textMsg('insights.checks.rpfCfx')))
      else insights.push(insight(rel, 'ok', name, textMsg('insights.checks.rpfValid')))
      continue
    }

    if (lower === 'enbhelper.dll') {
      insights.push(insight(rel, 'info', name, textMsg('insights.checks.enbHelper')))
      continue
    }

    if (dest.root === 'fivem' && /^citizen\//i.test(dest.path) && !insights.some((i) => i.titleMsg?.key === CITIZEN_TITLE)) {
      insights.push(insight(rel, 'warn', textMsg(CITIZEN_TITLE), textMsg('insights.checks.citizenText')))
    }
  }
  return { insights, reshadeVersion }
}

const CITIZEN_TITLE = 'insights.checks.citizenTitle'

/**
 * Corrige un ReShade.ini exporté depuis le PC de l'auteur : les chemins absolus (C:\Users\auteur\...)
 * sont remplacés par des chemins relatifs au dossier plugins ou par le dossier temporaire de l'utilisateur.
 */
export async function fixReshadeIni(file: string): Promise<number> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return 0
  }
  const { text, changes } = fixReshadeIniText(raw)
  if (changes) await fs.writeFile(file, text, 'utf8')
  return changes
}

/** Voir {@link fixReshadeIni} : contenu corrigé et nombre de réglages corrigés. */
export function fixReshadeIniText(raw: string): { text: string; changes: number } {
  const isAbs = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p.trim()) || /^\\\\/.test(p.trim())
  let changes = 0
  const out = raw.split(/(\r?\n)/).map((line) => {
    const m = /^(\s*)([A-Za-z]+)(\s*=\s*)(.*)$/.exec(line)
    if (!m) return line
    const [, ind, key, eq, value] = m
    const set = (v: string): string => {
      changes++
      return `${ind}${key}${eq}${v}`
    }
    switch (key) {
      case 'IntermediateCachePath':
        return isAbs(value) ? set(path.join(os.tmpdir(), 'ReShade')) : line
      case 'EffectSearchPaths':
      case 'TextureSearchPaths': {
        const parts = value.split(',').filter(Boolean)
        if (!parts.some(isAbs)) return line
        const fixed = parts
          .map((p) => {
            if (!isAbs(p)) return p
            const i = p.toLowerCase().indexOf('reshade-shaders')
            return i >= 0 ? `.\\${p.slice(i)}` : null
          })
          .filter((p): p is string => !!p)
        const def = key === 'EffectSearchPaths' ? '.\\reshade-shaders\\Shaders\\**' : '.\\reshade-shaders\\Textures\\**'
        return set([...new Set(fixed.length ? fixed : [def])].join(','))
      }
      case 'PresetPath':
      case 'StartupPresetPath':
        return isAbs(value) ? set(`.\\${value.trim().split(/[\\/]/).pop()}`) : line
      case 'SavePath':
        return isAbs(value) ? set('.\\') : line
      default:
        return line
    }
  })
  return { text: out.join(''), changes }
}
