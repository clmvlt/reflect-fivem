// Configuration de la machine, pour comparer les packs à ce qu'elle peut faire tourner (voir shared/performance.ts).
//
// La carte graphique est lue dans le registre (une seconde environ par PowerShell) puis gardée en cache, sur le disque
// aussi : elle ne change presque jamais, et l'utilisateur peut demander une nouvelle détection. La mémoire vive et la
// résolution sont relues à chaque fois (la résolution change avec les réglages du jeu).
// Rien de tout cela n'est envoyé à l'API.

import os from 'node:os'
import type { DetectedGpu, HardwareInfo } from '@shared/performance'
import { readJson, writeJsonAtomic } from '../util/fsx'
import { log } from '../util/log'
import type { VideoAdapter } from '../util/win'

/**
 * Cartes sans mémoire propre ni rendu du jeu : pilote de base de Windows, écrans virtuels et déportés (bureau à
 * distance, machines virtuelles, écrans USB, partage d'écran).
 */
const VIRTUAL_ADAPTER =
  /microsoft basic|microsoft remote|remote display|virtual|hyper-v|vmware|virtualbox|parallels|qxl|citrix|parsec|spacedesk|displaylink|splashtop|teamviewer|indirect display|iddsample|meta.*monitor|duet display|luminon/i

/** Carte sans rendu du jeu (pilote de base, écran virtuel ou déporté). */
export function isVirtualAdapter(name: string): boolean {
  return VIRTUAL_ADAPTER.test(name)
}

/**
 * Carte utilisée pour jouer : celle qui a le plus de mémoire vidéo dédiée, parmi les cartes du registre (mémoire
 * exacte), sinon celles de Win32_VideoController (mémoire plafonnée à 4 Go : dernier recours). Une carte du registre
 * dont la mémoire n'est pas indiquée garde au moins son nom.
 */
export function chooseGpu(registry: VideoAdapter[], wmi: VideoAdapter[]): DetectedGpu | null {
  const best = (list: VideoAdapter[]): VideoAdapter | null =>
    list.filter((a) => a.name.trim() && !VIRTUAL_ADAPTER.test(a.name)).sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))[0] ?? null
  const toGpu = (a: VideoAdapter, source: DetectedGpu['source']): DetectedGpu => ({
    name: a.name.trim(),
    vramMb: a.memory ? Math.round(a.memory / 1024 / 1024) : null,
    source
  })
  const fromRegistry = best(registry)
  if (fromRegistry?.memory) return toGpu(fromRegistry, 'registry')
  const fromWmi = best(wmi)
  if (fromWmi?.memory) return toGpu(fromWmi, 'wmi')
  // Aucune mémoire lisible : le nom suffit à reconnaître la classe de la carte.
  const named = fromRegistry ?? fromWmi
  return named ? toGpu(named, fromRegistry ? 'registry' : 'wmi') : null
}

interface SavedGpu {
  schema: 1
  gpu: DetectedGpu | null
  detectedAt: string
}

export interface HardwareSources {
  /** Cartes graphiques lues par Windows (readVideoAdapters). */
  adapters: () => Promise<{ registry: VideoAdapter[]; wmi: VideoAdapter[] }>
  /** Résolution du jeu (gta5_settings.xml), null si elle n'est pas connue. */
  gameScreen: () => Promise<{ width: number; height: number } | null>
  /** Taille de l'écran principal en pixels réels (taille × facteur d'échelle). */
  displayScreen: () => { width: number; height: number } | null
}

export class Hardware {
  private gpu: Promise<SavedGpu> | null = null

  constructor(
    /** Cache de la carte détectée (hardware.json). */
    private file: string,
    private sources: HardwareSources
  ) {}

  /** Configuration de la machine ; `refresh` : détecte de nouveau la carte graphique. */
  async info(refresh = false): Promise<HardwareInfo> {
    if (refresh || !this.gpu) this.gpu = refresh ? this.detect() : this.cached()
    const [saved, screen] = await Promise.all([this.gpu, this.screen()])
    // Détection en échec : retentée à la prochaine demande.
    if (!saved.detectedAt) this.gpu = null
    return { gpu: saved.gpu, ramMb: Math.round(os.totalmem() / 1024 / 1024), screen, detectedAt: saved.detectedAt || null }
  }

  private async cached(): Promise<SavedGpu> {
    const saved = await readJson<SavedGpu | null>(this.file, null)
    if (saved?.schema === 1 && saved.gpu !== undefined && saved.detectedAt) return saved
    return this.detect()
  }

  private async detect(): Promise<SavedGpu> {
    let gpu: DetectedGpu | null = null
    try {
      const { registry, wmi } = await this.sources.adapters()
      gpu = chooseGpu(registry, wmi)
      log.info(gpu ? `Carte graphique : ${gpu.name}${gpu.vramMb ? `, ${gpu.vramMb} Mo` : ''} (${gpu.source})` : 'Carte graphique non détectée')
    } catch (err) {
      log.warn(`Détection de la carte graphique : ${(err as Error).message}`)
      // Échec passager (PowerShell trop lent...) : pas gardé, on réessaiera.
      return { schema: 1, gpu: null, detectedAt: '' }
    }
    const saved: SavedGpu = { schema: 1, gpu, detectedAt: new Date().toISOString() }
    await writeJsonAtomic(this.file, saved).catch(() => undefined)
    return saved
  }

  private async screen(): Promise<HardwareInfo['screen']> {
    const game = await this.sources.gameScreen().catch(() => null)
    if (game) return { ...game, source: 'game' }
    const display = this.sources.displayScreen()
    return display ? { ...display, source: 'display' } : null
  }
}
