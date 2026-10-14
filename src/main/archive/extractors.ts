// Extraction des archives .zip / .rar / .7z vers un dossier.
// Exécuté dans un worker thread : la décompression RAR (WASM) est synchrone et bloquerait l'interface.

import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import yauzl from 'yauzl'
import i18next from 'i18next'
import type { Msg } from '@shared/i18n'
import { decodeZipName, detectFormat, sanitizeEntryPath, type ArchiveFormat } from './sanitize'

export interface ExtractProgress {
  phase: 'list' | 'extract'
  files: number
  totalFiles: number
  bytes: number
  totalBytes: number
  current?: string
}

// Pas de @shared/i18n ici : il embarquerait les traductions dans le worker.
const msg = (key: string, params?: Msg['params']): Msg => (params ? { key, params } : { key })

const PASSWORD_MSG = msg('archive.errors.password')
const CORRUPT_MSG = msg('archive.errors.corrupt')
const SEVEN_ZIP_MSG = msg('archive.errors.sevenZipUnavailable')
const SPACE_MSG = msg('archive.errors.space')

/**
 * Erreur d'extraction. {@link text} : message à traduire. L'extraction tourne dans un worker où les traductions ne sont
 * pas chargées : le message y vaut la clé, et le processus principal le traduit à la réception (voir extractInWorker).
 */
export class ArchiveError extends Error {
  public text: Msg | null
  constructor(
    public code: 'password' | 'corrupt' | 'unsupported' | 'space' | 'volume' | 'unknown',
    text: Msg | string
  ) {
    super(typeof text === 'string' ? text : i18next.isInitialized ? (i18next.t as unknown as (key: string, params?: object) => string)(text.key, text.params) : text.key)
    this.text = typeof text === 'string' ? null : text
  }
}

export async function detectArchiveFormat(file: string): Promise<ArchiveFormat | null> {
  const h = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(16)
    await h.read(buf, 0, 16, 0)
    return detectFormat(buf)
  } finally {
    await h.close()
  }
}

export async function extractArchive(
  file: string,
  target: string,
  onProgress: (p: ExtractProgress) => void,
  sevenZipPath: string | null
): Promise<{ format: ArchiveFormat; files: number; bytes: number }> {
  const format = await detectArchiveFormat(file)
  if (!format) throw new ArchiveError('unsupported', msg('archive.errors.format'))
  await fs.mkdir(target, { recursive: true })
  if (format === 'zip') {
    try {
      return { format, ...(await extractZip(file, target, onProgress)) }
    } catch (err) {
      // Méthodes de compression non gérées par yauzl (Deflate64, LZMA, BZip2, Zstd...) : on passe par 7-Zip.
      if (err instanceof ArchiveError && err.code === 'unsupported' && sevenZipPath) {
        await fs.rm(target, { recursive: true, force: true })
        await fs.mkdir(target, { recursive: true })
        return { format, ...(await extract7z(file, target, onProgress, sevenZipPath)) }
      }
      throw err
    }
  }
  if (format === 'rar') return { format, ...(await extractRar(file, target, onProgress)) }
  if (!sevenZipPath) throw new ArchiveError('unsupported', SEVEN_ZIP_MSG)
  return { format, ...(await extract7z(file, target, onProgress, sevenZipPath)) }
}

// ---------------------------------------------------------------------------
// ZIP (yauzl, en flux : aucun fichier n'est chargé entièrement en mémoire)

const ZIP_METHODS = new Set([0, 8])

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false } as yauzl.Options,
      (err, zip) => (err || !zip ? reject(new ArchiveError('corrupt', CORRUPT_MSG)) : resolve(zip))
    )
  })
}

function listZip(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const out: yauzl.Entry[] = []
    zip.on('entry', (e: yauzl.Entry) => {
      out.push(e)
      zip.readEntry()
    })
    zip.on('end', () => resolve(out))
    zip.on('error', () => reject(new ArchiveError('corrupt', CORRUPT_MSG)))
    zip.readEntry()
  })
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new ArchiveError('unknown', msg('archive.errors.stream'))) : resolve(stream)))
  })
}

async function extractZip(file: string, target: string, onProgress: (p: ExtractProgress) => void): Promise<{ files: number; bytes: number }> {
  const zip = await openZip(file)
  try {
    const entries = await listZip(zip)
    const fileEntries = entries
      .map((e) => {
        const raw = e.fileName as unknown as Buffer | string
        const name = typeof raw === 'string' ? raw : decodeZipName(raw, (e.generalPurposeBitFlag & 0x800) !== 0)
        return { e, name }
      })
      .filter(({ name }) => !name.endsWith('/') && !name.endsWith('\\'))
    if (fileEntries.some(({ e }) => (e.generalPurposeBitFlag & 0x1) !== 0))
      throw new ArchiveError('password', PASSWORD_MSG)
    const bad = fileEntries.find(({ e }) => !ZIP_METHODS.has(e.compressionMethod))
    if (bad) throw new ArchiveError('unsupported', msg('archive.errors.zipMethod', { method: bad.e.compressionMethod }))

    const totalBytes = fileEntries.reduce((s, { e }) => s + e.uncompressedSize, 0)
    const totalFiles = fileEntries.length
    let bytes = 0
    let files = 0
    let lastEmit = 0
    const emit = (current?: string, force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < 150) return
      lastEmit = now
      onProgress({ phase: 'extract', files, totalFiles, bytes, totalBytes, current })
    }
    onProgress({ phase: 'list', files: 0, totalFiles, bytes: 0, totalBytes })

    for (const { e, name } of fileEntries) {
      const rel = sanitizeEntryPath(name)
      if (!rel) continue
      const dest = path.join(target, ...rel.split('/'))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      const stream = await openEntryStream(zip, e)
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length
          emit(rel)
          cb(null, chunk)
        }
      })
      await pipeline(stream, counter, createWriteStream(dest))
      files++
      emit(rel)
    }
    emit(undefined, true)
    return { files, bytes }
  } finally {
    zip.close()
  }
}

// ---------------------------------------------------------------------------
// RAR (node-unrar-js : unrar officiel compilé en WebAssembly, gère RAR4 et RAR5)

async function extractRar(file: string, target: string, onProgress: (p: ExtractProgress) => void): Promise<{ files: number; bytes: number }> {
  const { createExtractorFromFile } = await import('node-unrar-js')
  let rejected = 0
  const transform = (name: string): string => {
    const rel = sanitizeEntryPath(name)
    if (rel) return rel.split('/').join(path.sep)
    rejected++
    return path.join('_chemins_refuses', `fichier_${rejected}`)
  }
  let extractor
  try {
    extractor = await createExtractorFromFile({ filepath: file, targetPath: target, filenameTransform: transform })
  } catch (err) {
    throw mapRarError(err)
  }
  let totalBytes = 0
  let totalFiles = 0
  try {
    const list = extractor.getFileList()
    for (const h of list.fileHeaders) {
      if (h.flags.directory) continue
      if (h.flags.encrypted)
        throw new ArchiveError('password', PASSWORD_MSG)
      totalFiles++
      totalBytes += h.unpSize
    }
  } catch (err) {
    throw mapRarError(err)
  }
  onProgress({ phase: 'list', files: 0, totalFiles, bytes: 0, totalBytes })
  let files = 0
  let bytes = 0
  try {
    const { files: iter } = extractor.extract()
    for (const f of iter) {
      if (f.fileHeader.flags.directory) continue
      files++
      bytes += f.fileHeader.unpSize
      onProgress({ phase: 'extract', files, totalFiles, bytes, totalBytes, current: f.fileHeader.name })
    }
  } catch (err) {
    throw mapRarError(err)
  }
  return { files, bytes }
}

function mapRarError(err: unknown): Error {
  if (err instanceof ArchiveError) return err
  const reason = (err as { reason?: string }).reason ?? ''
  const message = (err as Error)?.message ?? String(err)
  if (/PASSWORD/.test(reason)) return new ArchiveError('password', PASSWORD_MSG)
  if (/EOPEN/.test(reason) && /volume/i.test(message)) return new ArchiveError('volume', msg('archive.errors.volume'))
  if (/BAD_DATA|BAD_ARCHIVE|UNKNOWN_FORMAT|EREAD/.test(reason)) return new ArchiveError('corrupt', CORRUPT_MSG)
  if (/EWRITE|ECREATE/.test(reason)) return new ArchiveError('space', SPACE_MSG)
  return new ArchiveError('unknown', msg('archive.errors.failed', { reason: reason || message }))
}

// ---------------------------------------------------------------------------
// 7z (7za.exe fourni par le paquet 7zip-bin)

function extract7z(
  file: string,
  target: string,
  onProgress: (p: ExtractProgress) => void,
  sevenZip: string
): Promise<{ files: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    // -p avec un mot de passe factice : une archive chiffrée échoue au lieu d'attendre une saisie.
    const child = spawn(sevenZip, ['x', file, `-o${target}`, '-y', '-bsp1', '-bso0', '-pPACKMANAGER'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let errText = ''
    child.stdout.on('data', (d: Buffer) => {
      const m = /(\d{1,3})%/.exec(d.toString())
      if (m) onProgress({ phase: 'extract', files: 0, totalFiles: 0, bytes: Number(m[1]), totalBytes: 100 })
    })
    child.stderr.on('data', (d: Buffer) => (errText += d.toString()))
    child.on('error', () => reject(new ArchiveError('unknown', SEVEN_ZIP_MSG)))
    child.on('close', async (code) => {
      if (code === 0 || code === 1) {
        const { count, size } = await countDir(target)
        resolve({ files: count, bytes: size })
      } else if (/Wrong password|password/i.test(errText)) {
        reject(new ArchiveError('password', PASSWORD_MSG))
      } else if (/not enough space|disk full/i.test(errText)) {
        reject(new ArchiveError('space', SPACE_MSG))
      } else {
        reject(new ArchiveError('corrupt', CORRUPT_MSG))
      }
    })
  })
}

async function countDir(dir: string): Promise<{ count: number; size: number }> {
  let count = 0
  let size = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const e of await fs.readdir(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        count++
        size += (await fs.stat(p)).size
      }
    }
  }
  return { count, size }
}
