import { Worker } from 'node:worker_threads'
import { t } from 'i18next'
import type { Msg } from '@shared/i18n'
import workerPath from './extract.worker?modulePath'
import type { ExtractProgress } from './extractors'
import { ArchiveError } from './extractors'

/** Chemin de 7za.exe (dézippé hors de l'asar une fois l'application empaquetée). */
export function sevenZipPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p: string = require('7zip-bin').path7za
    // Un exécutable ne peut pas être lancé depuis l'archive asar : il est dézippé à côté (asarUnpack).
    return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  } catch {
    return null
  }
}

/** Extrait une archive dans un worker thread (l'interface reste fluide pendant les gros RAR). */
export function extractInWorker(
  file: string,
  target: string,
  onProgress: (p: ExtractProgress) => void,
  signal?: AbortSignal
): Promise<{ format: string; files: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { file, target, sevenZip: sevenZipPath() } })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      void worker.terminate()
    }
    signal?.addEventListener('abort', () => finish(() => reject(new ArchiveError('unknown', t('archive.errors.canceled')))))
    worker.on(
      'message',
      (msg: { type: string; progress?: ExtractProgress; result?: { format: string; files: number; bytes: number }; code?: string; text?: Msg | null; message?: string }) => {
        if (msg.type === 'progress' && msg.progress) onProgress(msg.progress)
        else if (msg.type === 'done' && msg.result) finish(() => resolve(msg.result!))
        // Message traduit ici : le worker n'a pas les traductions.
        else if (msg.type === 'error')
          finish(() => reject(new ArchiveError((msg.code as ArchiveError['code']) ?? 'unknown', msg.text ?? msg.message ?? t('common.error'))))
      }
    )
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(t('archive.errors.stopped', { code }))))
    })
  })
}
