// Fichiers chiffrés des packs protégés :
//  - le paquet chiffré reçu du serveur (.fpk), jamais extrait : chaque fichier du pack y est chiffré à part, lu en
//    mémoire (réglages, analyse) ou déchiffré directement à sa place dans le jeu ;
//  - les fichiers chiffrés sur ce PC avec la clé locale (réglages modifiés en jeu, fichiers générés à l'installation).
//
// Format du paquet (écrit par packs_api, encryption/PackageFormat.java) :
//   en-tête  32 octets   « FPMPACK1 », identifiant du paquet (16 octets), 8 octets nuls
//   fichiers             un flux chiffré par fichier
//   index                flux chiffré : {"v":1,"files":[{"p": chemin, "s": taille, "o": position, "l": longueur}]}
//   fin      16 octets   position et longueur de l'index (u64 gros-boutistes)
// Fichier chiffré local : « FPMSEAL1 », identifiant (16 octets), puis un flux chiffré.
//
// Flux chiffré : morceaux [longueur u32][AES-256-GCM(corps)], au moins un. Corps : 1 octet (0 brut, 1 deflate) puis
// 1 Mio au plus du fichier. Nonce : 4 octets nuls + numéro du morceau (u64) ; données associées : numéro (u64) + 1 pour
// le dernier morceau (un flux tronqué ou réordonné est refusé). Clé de chaque flux : HKDF-SHA256 de la clé du paquet
// (« fpm-pack/index », « fpm-pack/file/<n> ») ou de la clé locale (« fpm-seal/file ») : elle ne déchiffre que ce flux.
//
// Aucune dépendance à Electron : ce code tourne aussi dans le processus administrateur (executor.ts).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { t } from 'i18next'

const PACKAGE_MAGIC = Buffer.from('FPMPACK1', 'latin1')
const SEALED_MAGIC = Buffer.from('FPMSEAL1', 'latin1')
const PACKAGE_HEADER = 32
const PACKAGE_TRAILER = 16
const ID_SIZE = 16
const SEALED_HEADER = SEALED_MAGIC.length + ID_SIZE
const CHUNK = 1 << 20
const TAG = 16
export const KEY_SIZE = 32

export class SealedError extends Error {}

/** Message d'un fichier chiffré illisible (dans la langue courante, d'où l'appel au moment de l'erreur). */
const damaged = (): string => t('protection.damaged')

/** Flux chiffré dans un fichier : position, longueur et clé (hexadécimal, pour passer dans un plan d'installation). */
export interface SealedRef {
  offset: number
  length: number
  key: string
}

export function hkdf(key: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(info, 'utf8'), KEY_SIZE))
}

function nonce(index: number): Buffer {
  const b = Buffer.alloc(12)
  b.writeBigUInt64BE(BigInt(index), 4)
  return b
}

function aad(index: number, last: boolean): Buffer {
  const b = Buffer.alloc(9)
  b.writeBigUInt64BE(BigInt(index), 0)
  b[8] = last ? 1 : 0
  return b
}

// ---------------------------------------------------------------------------
// Flux chiffré

function sealChunk(key: Buffer, index: number, last: boolean, data: Buffer): Buffer {
  const packed = data.length ? deflateRawSync(data) : data
  const body = packed.length < data.length ? Buffer.concat([Buffer.of(1), packed]) : Buffer.concat([Buffer.of(0), data])
  const cipher = createCipheriv('aes-256-gcm', key, nonce(index))
  cipher.setAAD(aad(index, last))
  const sealed = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(sealed.length)
  return Buffer.concat([size, sealed])
}

function openChunk(key: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  let body: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce(index))
    decipher.setAAD(aad(index, last))
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG))
    body = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()])
  } catch {
    throw new SealedError(damaged())
  }
  if (body[0] === 0) return body.subarray(1)
  try {
    return inflateRawSync(body.subarray(1), { maxOutputLength: CHUNK })
  } catch {
    throw new SealedError(damaged())
  }
}

/** Chiffre des données en un flux (tenu en mémoire : petits fichiers). */
export function sealBytes(data: Buffer, key: Buffer): Buffer {
  const parts: Buffer[] = []
  let index = 0
  for (let at = 0; ; index++) {
    const end = Math.min(at + CHUNK, data.length)
    const last = end >= data.length
    parts.push(sealChunk(key, index, last, data.subarray(at, end)))
    if (last) return Buffer.concat(parts)
    at = end
  }
}

/** Morceaux déchiffrés d'un flux ; s'arrête quand {@link limit} octets au moins ont été rendus. */
async function* unsealChunks(file: string, ref: SealedRef, limit = Infinity): AsyncGenerator<Buffer> {
  const key = Buffer.from(ref.key, 'hex')
  const h = await fs.open(file, 'r')
  try {
    const end = ref.offset + ref.length
    const head = Buffer.alloc(4)
    let pos = ref.offset
    let given = 0
    for (let index = 0; pos < end && given < limit; index++) {
      if ((await h.read(head, 0, 4, pos)).bytesRead !== 4) throw new SealedError(damaged())
      const size = head.readUInt32BE(0)
      if (size < TAG + 1 || size > CHUNK + 1 + TAG || pos + 4 + size > end) throw new SealedError(damaged())
      const sealed = Buffer.alloc(size)
      if ((await h.read(sealed, 0, size, pos + 4)).bytesRead !== size) throw new SealedError(damaged())
      pos += 4 + size
      const data = openChunk(key, index, pos === end, sealed)
      given += data.length
      yield data
    }
  } finally {
    await h.close()
  }
}

/** Contenu déchiffré d'un flux ; avec {@link limit}, seulement ses premiers octets (au moins autant, s'il y en a). */
export async function unsealToBuffer(file: string, ref: SealedRef, limit?: number): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of unsealChunks(file, ref, limit)) parts.push(chunk)
  const all = Buffer.concat(parts)
  return limit === undefined ? all : all.subarray(0, limit)
}

/** Déchiffre un flux dans un nouveau fichier (échoue s'il existe déjà) ; un fichier incomplet est supprimé. */
export async function unsealToFile(file: string, ref: SealedRef, to: string): Promise<void> {
  const out = await fs.open(to, 'wx')
  try {
    for await (const chunk of unsealChunks(file, ref)) await out.write(chunk)
    await out.close()
  } catch (err) {
    await out.close().catch(() => undefined)
    await fs.unlink(to).catch(() => undefined)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Paquet chiffré (.fpk)

export interface PackageEntry {
  /** Chemin dans le pack, tel qu'écrit par le serveur (séparateur « / »). */
  path: string
  size: number
  ref: SealedRef
}

export interface PackageIndex {
  /** Identifiant du paquet (hexadécimal) : celui dont le serveur remet la clé. */
  id: string
  entries: PackageEntry[]
}

/** Identifiant d'un paquet, lu dans son en-tête (sans la clé) ; null si ce n'est pas un paquet chiffré. */
export async function packageId(file: string): Promise<string | null> {
  const h = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(PACKAGE_HEADER)
    if ((await h.read(head, 0, PACKAGE_HEADER, 0)).bytesRead !== PACKAGE_HEADER || !head.subarray(0, 8).equals(PACKAGE_MAGIC)) return null
    return head.subarray(8, 8 + ID_SIZE).toString('hex')
  } finally {
    await h.close()
  }
}

/** Index du paquet, déchiffré avec sa clé (une mauvaise clé échoue ici). */
export async function readPackageIndex(file: string, key: Buffer): Promise<PackageIndex> {
  const size = (await fs.stat(file)).size
  const h = await fs.open(file, 'r')
  let id: Buffer
  let indexOffset: number
  let indexLength: number
  try {
    const head = Buffer.alloc(PACKAGE_HEADER)
    const tail = Buffer.alloc(PACKAGE_TRAILER)
    await h.read(head, 0, PACKAGE_HEADER, 0)
    await h.read(tail, 0, PACKAGE_TRAILER, Math.max(0, size - PACKAGE_TRAILER))
    if (size < PACKAGE_HEADER + PACKAGE_TRAILER || !head.subarray(0, 8).equals(PACKAGE_MAGIC)) throw new SealedError(t('protection.notPackage'))
    id = Buffer.from(head.subarray(8, 8 + ID_SIZE))
    indexOffset = Number(tail.readBigUInt64BE(0))
    indexLength = Number(tail.readBigUInt64BE(8))
  } finally {
    await h.close()
  }
  if (indexOffset < PACKAGE_HEADER || indexLength <= 0 || indexOffset + indexLength > size - PACKAGE_TRAILER) throw new SealedError(damaged())
  const json = await unsealToBuffer(file, { offset: indexOffset, length: indexLength, key: hkdf(key, id, 'fpm-pack/index').toString('hex') })
  let index: { v?: unknown; files?: unknown }
  try {
    index = JSON.parse(json.toString('utf8')) as typeof index
  } catch {
    throw new SealedError(damaged())
  }
  if (index.v !== 1 || !Array.isArray(index.files)) throw new SealedError(t('protection.unknownVersion'))
  const entries = (index.files as { p?: unknown; s?: unknown; o?: unknown; l?: unknown }[]).map((f, i) => {
    const ok =
      typeof f.p === 'string' && [f.s, f.o, f.l].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) && (f.o as number) >= PACKAGE_HEADER && (f.o as number) + (f.l as number) <= indexOffset
    if (!ok) throw new SealedError(damaged())
    return { path: f.p as string, size: f.s as number, ref: { offset: f.o as number, length: f.l as number, key: hkdf(key, id, `fpm-pack/file/${i}`).toString('hex') } }
  })
  return { id: id.toString('hex'), entries }
}

// ---------------------------------------------------------------------------
// Fichiers chiffrés avec la clé locale

/** Écrit un fichier chiffré (remplacé d'un coup : jamais à moitié écrit). */
export async function writeSealedFile(file: string, data: Buffer, localKey: Buffer): Promise<void> {
  const id = randomBytes(ID_SIZE)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, Buffer.concat([SEALED_MAGIC, id, sealBytes(data, hkdf(localKey, id, 'fpm-seal/file'))]))
  await fs.rename(tmp, file)
}

/** Chiffre un fichier du disque (un réglage modifié en jeu) dans {@link file}, morceau par morceau. */
export async function sealFileFrom(source: string, file: string, localKey: Buffer): Promise<void> {
  const id = randomBytes(ID_SIZE)
  const key = hkdf(localKey, id, 'fpm-seal/file')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  const src = await fs.open(source, 'r')
  try {
    const out = await fs.open(tmp, 'w')
    try {
      const readChunk = async (): Promise<Buffer> => {
        const b = Buffer.alloc(CHUNK)
        let n = 0
        for (let got = -1; n < CHUNK && got !== 0; n += got) got = (await src.read(b, n, CHUNK - n, null)).bytesRead
        return b.subarray(0, n)
      }
      await out.write(Buffer.concat([SEALED_MAGIC, id]))
      let current = await readChunk()
      for (let index = 0; ; index++) {
        const next = current.length === CHUNK ? await readChunk() : Buffer.alloc(0)
        await out.write(sealChunk(key, index, next.length === 0, current))
        if (!next.length) break
        current = next
      }
    } finally {
      await out.close()
    }
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  } finally {
    await src.close()
  }
}

/** Flux d'un fichier chiffré localement, à installer ou à lire ; null si ce n'en est pas un. */
export async function sealedFileRef(file: string, localKey: Buffer): Promise<SealedRef | null> {
  const h = await fs.open(file, 'r')
  try {
    const size = (await h.stat()).size
    const head = Buffer.alloc(SEALED_HEADER)
    if (size <= SEALED_HEADER || (await h.read(head, 0, SEALED_HEADER, 0)).bytesRead !== SEALED_HEADER) return null
    if (!head.subarray(0, 8).equals(SEALED_MAGIC)) return null
    return { offset: SEALED_HEADER, length: size - SEALED_HEADER, key: hkdf(localKey, head.subarray(8), 'fpm-seal/file').toString('hex') }
  } finally {
    await h.close()
  }
}

export async function readSealedFile(file: string, localKey: Buffer): Promise<Buffer> {
  const ref = await sealedFileRef(file, localKey)
  if (!ref) throw new SealedError(t('protection.notSealed'))
  return unsealToBuffer(file, ref)
}

// ---------------------------------------------------------------------------
// Clé d'un paquet gardée sur le PC, chiffrée avec la clé locale

export function wrapKey(key: Buffer, localKey: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', localKey, iv)
  return Buffer.concat([iv, cipher.update(key), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

/** null si la clé locale n'est pas celle qui l'a chiffrée (autre PC, autre compte Windows). */
export function unwrapKey(wrapped: string, localKey: Buffer): Buffer | null {
  try {
    const raw = Buffer.from(wrapped, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', localKey, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(raw.length - TAG))
    const key = Buffer.concat([decipher.update(raw.subarray(12, raw.length - TAG)), decipher.final()])
    return key.length === KEY_SIZE ? key : null
  } catch {
    return null
  }
}
