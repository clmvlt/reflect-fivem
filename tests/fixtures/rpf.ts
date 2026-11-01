// Fausses archives .rpf et ressources .ypt pour les tests de recoloration.
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const BASE = 0x50000000
const COLOUR = 0x164aea72

/** Fausse ressource .ypt : des particules, chacune avec une couleur (RGBA min et max) en deux images clés. */
export function fakeYpt(particles: { name: string; rgba: [number, number, number, number] }[]): Buffer {
  const d = Buffer.alloc(0x1000 + particles.length * 0x1000)
  const ptr = (at: number, position: number): void => void d.writeUInt32LE(BASE + position, at)
  const dictionary = 0x100
  const list = 0x200
  ptr(0x38, dictionary)
  ptr(dictionary + 0x30, list)
  d.writeUInt16LE(particles.length, dictionary + 0x38)
  particles.forEach((p, i) => {
    const rule = 0x1000 + i * 0x1000
    ptr(list + i * 8, rule)
    const name = rule + 0x300
    d.write(`${p.name}\0`, name, 'latin1')
    ptr(rule + 0x120, name)
    const behaviours = rule + 0x400
    ptr(rule + 0x128, behaviours)
    d.writeUInt16LE(1, rule + 0x130)
    const behaviour = rule + 0x500
    ptr(behaviours, behaviour)
    d.writeUInt32LE(COLOUR, behaviour + 8)
    for (const [keyframes, values] of [
      [behaviour + 0x30, rule + 0xc00],
      [behaviour + 0xc0, rule + 0xd00]
    ]) {
      ptr(keyframes + 0x70, values)
      d.writeUInt16LE(2, keyframes + 0x78)
      for (let k = 0; k < 2; k++) {
        d.writeFloatLE(k, values + k * 32)
        p.rgba.forEach((c, n) => d.writeFloatLE(c, values + k * 32 + 16 + n * 4))
      }
    }
  })
  return d
}

/** Couleurs lues dans une fausse ressource : [particule, rgba de chaque image clé]. */
export function colorsOf(d: Buffer, index: number): number[][] {
  const rule = 0x1000 + index * 0x1000
  const out: number[][] = []
  for (const values of [rule + 0xc00, rule + 0xd00]) for (let k = 0; k < 2; k++) out.push([0, 1, 2, 3].map((n) => d.readFloatLE(values + k * 32 + 16 + n * 4)))
  return out
}

export type Entry = { name: string; plain?: Buffer; resource?: Buffer; rpf?: Buffer; big?: boolean }

/** Archive RPF7 sans dossiers : ressources (compressées), fichiers (compressés) et archives internes (stockées). */
export function fakeRpf(entries: Entry[], encryption = 0x4e45504f): Buffer {
  let names = '\0'
  const nameOffset = entries.map((e) => {
    const at = names.length
    names += `${e.name}\0`
    return at
  })
  const namesBytes = Buffer.from(names, 'latin1')
  const count = entries.length + 1
  const header = 16 + count * 16 + namesBytes.length
  let position = Math.ceil(header / 512) * 512
  const table = Buffer.alloc(count * 16)
  table.writeUInt32LE(0, 0)
  table.writeUInt32LE(0x7fffff00, 4)
  table.writeUInt32LE(1, 8)
  table.writeUInt32LE(entries.length, 12)
  const parts: Buffer[] = []
  entries.forEach((e, i) => {
    const o = (i + 1) * 16
    table.writeUInt16LE(nameOffset[i], o)
    let data: Buffer
    let size: number
    if (e.resource) {
      const packed = deflateRawSync(e.resource)
      const head = Buffer.alloc(16)
      head.write('RSC7', 0, 'latin1')
      head.writeUInt32LE(68, 4)
      size = head.length + packed.length
      if (e.big) {
        head[7] = size & 0xff
        head[14] = (size >>> 8) & 0xff
        head[5] = (size >>> 16) & 0xff
        head[2] = (size >>> 24) & 0xff
        size = 0xffffff
      }
      data = Buffer.concat([head, packed])
    } else if (e.rpf) {
      data = e.rpf
      size = 0
      table.writeUInt32LE(data.length, o + 8)
    } else {
      data = deflateRawSync(e.plain!)
      size = data.length
      table.writeUInt32LE(e.plain!.length, o + 8)
    }
    table.writeUIntLE(size, o + 2, 3)
    table.writeUIntLE(position / 512, o + 5, 3)
    if (e.resource) table[o + 7] |= 0x80
    const pad = (512 - (data.length % 512)) % 512
    parts.push(data, Buffer.alloc(pad))
    position += data.length + pad
  })
  const head = Buffer.alloc(16)
  head.writeUInt32LE(0x52504637, 0)
  head.writeUInt32LE(count, 4)
  head.writeUInt32LE(namesBytes.length, 8)
  head.writeUInt32LE(encryption, 12)
  return Buffer.concat([head, table, namesBytes, Buffer.alloc(Math.ceil(header / 512) * 512 - header), ...parts])
}

/** Entrées d'une archive, en suivant les archives internes : chemin -> contenu décompressé. */
export function readRpf(d: Buffer, base = 0, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const count = d.readUInt32LE(base + 4)
  const namesStart = base + 16 + count * 16
  for (let i = 1; i < count; i++) {
    const o = base + 16 + i * 16
    const at = namesStart + d.readUInt16LE(o)
    const name = d.toString('latin1', at, d.indexOf(0, at))
    let size = d.readUIntLE(o + 2, 3)
    const offset = base + (d.readUIntLE(o + 5, 3) & 0x7fffff) * 512
    if (d[o + 7] & 0x80) {
      if (offset % 512) throw new Error('ressource mal alignée')
      if (size === 0xffffff) size = d[offset + 7] + d[offset + 14] * 0x100 + d[offset + 5] * 0x10000 + d[offset + 2] * 0x1000000
      out.set(`${prefix}${name}`, inflateRawSync(d.subarray(offset + 16, offset + size)))
    } else if (size === 0) out.set(`${prefix}${name}`, d.subarray(offset, offset + d.readUInt32LE(o + 8)))
    else out.set(`${prefix}${name}`, inflateRawSync(d.subarray(offset, offset + size)))
    if (name.endsWith('.rpf')) for (const [k, v] of readRpf(d, offset, `${prefix}${name}/`)) out.set(k, v)
  }
  return out
}
