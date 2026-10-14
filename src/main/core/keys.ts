// Clés des packs protégés.
//  - Clé locale : aléatoire, propre à ce PC et à ce compte Windows (gardée chiffrée par Windows, DPAPI). Elle chiffre ce
//    que l'application écrit sur le disque pour un pack protégé (réglages modifiés en jeu, fichiers générés à
//    l'installation) et la clé de son paquet, gardée dans pack.json.
//  - Clé d'un paquet : remise par le serveur avec le paquet ; redemandée si la clé locale a changé (bibliothèque copiée
//    sur un autre PC, par exemple).

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MarketKind } from '@shared/types'
import { KEY_SIZE } from './sealed'
import { log } from '../util/log'

export interface PackKeys {
  /** Clé locale (32 octets). */
  local(): Promise<Buffer>
  /** Clé du paquet actuel d'un pack (ou d'un mod) de la Marketplace, et l'identifiant de ce paquet. */
  fetch(marketId: string, kind: MarketKind): Promise<{ packageId: string; key: Buffer }>
}

/** Chiffrement propre au compte de l'utilisateur, fourni par le système (safeStorage d'Electron : DPAPI sous Windows). */
export interface SystemProtection {
  available(): boolean
  protect(data: Buffer): Buffer
  unprotect(data: Buffer): Buffer
}

export class KeyRing implements PackKeys {
  private key: Promise<Buffer> | null = null

  constructor(
    private file: string,
    private system: SystemProtection,
    private fetcher: (marketId: string, kind: MarketKind) => Promise<{ packageId: string; key: Buffer }>
  ) {}

  local(): Promise<Buffer> {
    // Un échec (écriture impossible...) n'est pas gardé : l'essai suivant recommence.
    this.key ??= this.load().catch((err: unknown) => {
      this.key = null
      throw err
    })
    return this.key
  }

  fetch(marketId: string, kind: MarketKind): Promise<{ packageId: string; key: Buffer }> {
    return this.fetcher(marketId, kind)
  }

  private async load(): Promise<Buffer> {
    if (!this.system.available()) {
      // Rien n'est gardé : les clés des paquets seront redemandées au serveur au prochain lancement.
      log.warn('Chiffrement du système indisponible : clé locale des packs protégés valable pour cette session seulement')
      return randomBytes(KEY_SIZE)
    }
    const saved = await fs.readFile(this.file).catch(() => null)
    if (saved) {
      try {
        const key = this.system.unprotect(saved)
        if (key.length === KEY_SIZE) return key
      } catch {
        /* autre compte Windows, profil recréé */
      }
      log.warn('Clé locale des packs protégés illisible : nouvelle clé (réglages chiffrés précédents perdus)')
    }
    const key = randomBytes(KEY_SIZE)
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, this.system.protect(key))
    return key
  }
}
