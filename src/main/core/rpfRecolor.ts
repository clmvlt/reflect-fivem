// Recoloration de particules dans une archive .rpf de GTA V (format RPF7) : les effets d'un .ypt décrivent leur couleur par
// des images clés (comportement ptxu_Colour d'une particule), sans toucher aux textures. Seuls le rouge, le vert et le
// bleu de ces images clés changent ; la transparence, l'intensité et tout le reste de l'archive restent tels quels.
//
// Rouge, vert et bleu étant dans la ressource compressée, celle-ci est décompressée, modifiée, recompressée ; sa taille
// change, donc les archives qui l'englobent sont réécrites. Les fichiers non concernés sont repris octet pour octet.
// Formats d'après CodeWalker (RpfFile.cs, GameFiles/Resources/Particle.cs).

import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { constants, deflateRaw, inflateRaw } from 'node:zlib'

const deflateAsync = promisify(deflateRaw)
const inflateAsync = promisify(inflateRaw)

const RPF_MAGIC = 0x52504637
const ENCRYPTION_NONE = 0
const ENCRYPTION_OPEN = 0x4e45504f
const DIRECTORY = 0x7fffff00
const ENTRY = 16
const BLOCK = 512
const RESOURCE_HEADER = 16
/** Taille d'une ressource trop grosse pour l'index : la vraie est dans son en-tête (octets 7, 14, 5 et 2). */
const BIG_RESOURCE = 0xffffff
const MAX_DEPTH = 6
const MAX_RESOURCE = 1024 * 1024 * 1024

const VIRTUAL_BASE = 0x50000000
/** ParticleEffectsList : dictionnaire des règles de particules. */
const LIST_PARTICLE_RULES = 0x38
const DICTIONARY_ITEMS = 0x30
const RULE_NAME = 0x120
const RULE_BEHAVIOURS = 0x128
const BEHAVIOUR_TYPE = 0x08
const BEHAVIOUR_COLOUR = 0x164aea72
const COLOUR_RGBA_MIN = 0x30
const COLOUR_RGBA_MAX = 0xc0
const KEYFRAMES = 0x70
const KEYFRAME_SIZE = 0x20
const KEYFRAME_VALUE = 0x10

/** Particules à recolorer dans les ressources nommées {@link file} ; {@link rgb} : de 0 à 1. */
export interface Recolor {
  file: string
  particles: string[]
  rgb: [number, number, number]
}

export class RecolorError extends Error {
  constructor(public readonly code: 'encrypted' | 'damaged') {
    super(code)
  }
}

export interface RecolorResult {
  /** Nouvelle archive ; null si elle ne contient rien à recolorer. */
  data: Buffer | null
  /** Particules trouvées : « fichier/particule », en minuscules. */
  found: Set<string>
}

/** Clé d'une particule dans {@link RecolorResult.found}. */
export const particleKey = (file: string, particle: string): string => `${file}/${particle}`.toLowerCase()

/** Pointeur d'une ressource vers sa propre mémoire « system » : position dans ses données ; 0 : aucun. */
function pointer(d: Buffer, at: number): number | null {
  const low = d.readUInt32LE(at)
  if (low === 0 && d.readUInt32LE(at + 4) === 0) return null
  const position = low - VIRTUAL_BASE
  if (d.readUInt32LE(at + 4) !== 0 || position < 0 || position >= d.length) throw new RecolorError('damaged')
  return position
}

/** Liste de pointeurs : adresse (8 octets) puis nombre d'éléments (2 octets). */
function pointers(d: Buffer, at: number): number[] {
  const list = pointer(d, at)
  if (list === null) return []
  const out: number[] = []
  for (let i = d.readUInt16LE(at + 8) - 1; i >= 0; i--) {
    const item = pointer(d, list + i * 8)
    if (item !== null) out.unshift(item)
  }
  return out
}

function text(d: Buffer, at: number): string {
  const end = d.indexOf(0, at)
  return d.toString('latin1', at, end < 0 ? d.length : end)
}

function setColour(d: Buffer, keyframes: number, rgb: [number, number, number]): number {
  const values = pointer(d, keyframes + KEYFRAMES)
  if (values === null) return 0
  const count = d.readUInt16LE(keyframes + KEYFRAMES + 8)
  for (let i = 0; i < count; i++) {
    const at = values + i * KEYFRAME_SIZE + KEYFRAME_VALUE
    d.writeFloatLE(rgb[0], at)
    d.writeFloatLE(rgb[1], at + 4)
    d.writeFloatLE(rgb[2], at + 8)
  }
  return count
}

/**
 * Recolore un .ypt décompressé, sur place ; {@link colors} : particule (en minuscules) -> couleur. Renvoie les particules
 * trouvées et si des images clés ont changé. Le contenu d'un mod n'est pas sûr : une ressource incohérente est refusée.
 */
export function recolorParticles(d: Buffer, colors: Map<string, [number, number, number]>): { found: string[]; changed: boolean } {
  const found: string[] = []
  let changed = false
  try {
    const dictionary = pointer(d, LIST_PARTICLE_RULES)
    if (dictionary === null) throw new RecolorError('damaged')
    for (const rule of pointers(d, dictionary + DICTIONARY_ITEMS)) {
      const name = pointer(d, rule + RULE_NAME)
      if (name === null) continue
      const particle = text(d, name).toLowerCase()
      const rgb = colors.get(particle)
      if (!rgb) continue
      found.push(particle)
      for (const behaviour of pointers(d, rule + RULE_BEHAVIOURS)) {
        if (d.readUInt32LE(behaviour + BEHAVIOUR_TYPE) !== BEHAVIOUR_COLOUR) continue
        const count = setColour(d, behaviour + COLOUR_RGBA_MIN, rgb) + setColour(d, behaviour + COLOUR_RGBA_MAX, rgb)
        changed ||= count > 0
      }
    }
  } catch (err) {
    if (err instanceof RangeError) throw new RecolorError('damaged')
    throw err
  }
  return { found, changed }
}

interface Rebuilt {
  chunks: Buffer[]
  size: number
}

const padding = (position: number): number => (BLOCK - (position % BLOCK)) % BLOCK

class Rebuilder {
  /** Même ressource en plusieurs exemplaires (ptfx, ptfx_hi, ptfx_lo) : compressée une seule fois. */
  private done = new Map<string, Promise<Buffer | null>>()
  readonly found = new Set<string>()

  constructor(
    private d: Buffer,
    private byFile: Map<string, Map<string, [number, number, number]>>
  ) {}

  private recolored(name: string, raw: Buffer): Promise<Buffer | null> {
    const key = `${name}:${createHash('sha1').update(raw).digest('hex')}`
    let job = this.done.get(key)
    if (!job) {
      job = this.recolor(name, raw)
      this.done.set(key, job)
    }
    return job
  }

  private async recolor(name: string, raw: Buffer): Promise<Buffer | null> {
    let plain: Buffer
    try {
      plain = await inflateAsync(raw, { maxOutputLength: MAX_RESOURCE })
    } catch {
      throw new RecolorError('damaged')
    }
    const { found, changed } = recolorParticles(plain, this.byFile.get(name)!)
    for (const particle of found) this.found.add(particleKey(name, particle))
    return changed ? deflateAsync(plain, { level: constants.Z_BEST_COMPRESSION }) : null
  }

  /** Nouvelle version de l'archive à {@link base} ; null si rien n'y change. */
  async archive(base: number, length: number, depth: number): Promise<Rebuilt | null> {
    const d = this.d
    if (length < 16 || base + length > d.length) throw new RecolorError('damaged')
    const count = d.readUInt32LE(base + 4)
    const namesLength = d.readUInt32LE(base + 8)
    const tableStart = base + 16
    const namesStart = tableStart + count * ENTRY
    const headerSize = 16 + count * ENTRY + namesLength
    if (count === 0 || headerSize > length) throw new RecolorError('damaged')
    const table = Buffer.from(d.subarray(tableStart, namesStart))
    const names = d.subarray(namesStart, namesStart + namesLength)
    const start = headerSize + padding(headerSize)
    const parts: Buffer[] = []
    let position = start
    let changed = false

    for (let i = 0; i < count; i++) {
      const o = i * ENTRY
      if (table.readUInt32LE(o + 4) === DIRECTORY) continue
      const nameOffset = table.readUInt16LE(o)
      const end = names.indexOf(0, nameOffset)
      if (nameOffset >= namesLength || end < 0) throw new RecolorError('damaged')
      const name = names.toString('latin1', nameOffset, end).toLowerCase()
      let size = table.readUIntLE(o + 2, 3)
      const offset = (table.readUIntLE(o + 5, 3) & 0x7fffff) * BLOCK
      const resource = (table[o + 7] & 0x80) !== 0
      const at = base + offset
      let chunks: Buffer[]
      let bytes: number

      if (resource) {
        if (offset + RESOURCE_HEADER > length) throw new RecolorError('damaged')
        const big = size === BIG_RESOURCE
        const stored = big ? d[at + 7] + d[at + 14] * 0x100 + d[at + 5] * 0x10000 + d[at + 2] * 0x1000000 : size
        if (stored < RESOURCE_HEADER || offset + stored > length) throw new RecolorError('damaged')
        const next = this.byFile.has(name) ? await this.recolored(name, d.subarray(at + RESOURCE_HEADER, at + stored)) : null
        if (next) {
          const header = Buffer.from(d.subarray(at, at + RESOURCE_HEADER))
          bytes = RESOURCE_HEADER + next.length
          if (big || bytes >= BIG_RESOURCE) {
            header[7] = bytes & 0xff
            header[14] = (bytes >>> 8) & 0xff
            header[5] = (bytes >>> 16) & 0xff
            header[2] = (bytes >>> 24) & 0xff
            size = BIG_RESOURCE
          } else size = bytes
          chunks = [header, next]
          changed = true
        } else {
          bytes = stored
          chunks = [d.subarray(at, at + stored)]
        }
      } else {
        const uncompressed = table.readUInt32LE(o + 8)
        const stored = size || uncompressed
        if (offset + stored > length) throw new RecolorError('damaged')
        const nested = size === 0 && name.endsWith('.rpf') && depth < MAX_DEPTH ? await this.nested(at, stored, depth + 1) : null
        if (nested) {
          bytes = nested.size
          chunks = nested.chunks
          table.writeUInt32LE(bytes, o + 8)
          changed = true
        } else {
          bytes = stored
          chunks = [d.subarray(at, at + stored)]
        }
      }

      if (position / BLOCK > 0x7fffff) throw new RecolorError('damaged')
      const flag = table[o + 7] & 0x80
      table.writeUIntLE(size, o + 2, 3)
      table.writeUIntLE(position / BLOCK, o + 5, 3)
      table[o + 7] |= flag
      const pad = padding(position + bytes)
      parts.push(...chunks, Buffer.alloc(pad))
      position += bytes + pad
    }

    if (!changed) return null
    return { chunks: [d.subarray(base, tableStart), table, names, Buffer.alloc(start - headerSize), ...parts], size: position }
  }

  /** Archive interne : une archive chiffrée ou illisible reste telle quelle. */
  private nested(base: number, length: number, depth: number): Promise<Rebuilt | null> {
    const d = this.d
    if (length < 16 || d.readUInt32LE(base) !== RPF_MAGIC) return Promise.resolve(null)
    const encryption = d.readUInt32LE(base + 12)
    if (encryption !== ENCRYPTION_NONE && encryption !== ENCRYPTION_OPEN) return Promise.resolve(null)
    return this.archive(base, length, depth)
  }
}

/** Recolore des particules dans une archive .rpf en clair (voir {@link RecolorResult}) ; l'archive reçue n'est pas modifiée. */
export async function recolorRpf(archive: Buffer, recolors: Recolor[]): Promise<RecolorResult> {
  if (archive.length < 16 || archive.readUInt32LE(0) !== RPF_MAGIC) throw new RecolorError('damaged')
  const encryption = archive.readUInt32LE(12)
  if (encryption !== ENCRYPTION_NONE && encryption !== ENCRYPTION_OPEN) throw new RecolorError('encrypted')
  const byFile = new Map<string, Map<string, [number, number, number]>>()
  for (const r of recolors) {
    const file = r.file.toLowerCase()
    const colors = byFile.get(file) ?? new Map<string, [number, number, number]>()
    for (const particle of r.particles) colors.set(particle.toLowerCase(), r.rgb)
    byFile.set(file, colors)
  }
  const rebuilder = new Rebuilder(archive, byFile)
  let rebuilt: Rebuilt | null
  try {
    rebuilt = await rebuilder.archive(0, archive.length, 0)
  } catch (err) {
    if (err instanceof RangeError) throw new RecolorError('damaged')
    throw err
  }
  return { data: rebuilt && Buffer.concat(rebuilt.chunks, rebuilt.size), found: rebuilder.found }
}
