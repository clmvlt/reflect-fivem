// Exécution d'un plan avec les droits administrateur (dossier GTA V dans Program Files).
// L'application relance son propre exécutable avec « --pm-exec-plan=<fichier> » via une demande UAC.
// L'empreinte SHA-256 du plan est passée en argument : le processus élevé refuse un fichier modifié entre-temps.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { t } from 'i18next'
import { currentLocale } from '@shared/i18n'
import { executePlan, type ExecProgress, type Plan, type PlanResult } from './executor'
import { runPowerShell } from '../util/win'

export const EXEC_FLAG = '--pm-exec-plan='
export const HASH_FLAG = '--pm-plan-sha256='
/** Langue affichée, pour les messages du processus élevé. */
export const LOCALE_FLAG = '--pm-locale='

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Sans réponse à la demande UAC (fenêtre restée derrière, souvent seulement un bouclier dans la barre des tâches) : abandon. */
const ELEVATION_TIMEOUT_MS = 5 * 60 * 1000
/** Annulation demandée au processus administrateur : temps laissé pour défaire ce qui a été fait. */
const CANCEL_GRACE_MS = 2 * 60 * 1000

/**
 * {@link signal} annule le plan : le processus administrateur (qu'on ne peut pas arrêter sans droits) reçoit la demande
 * par un fichier, et défait lui-même ce qu'il a fait. S'il n'a pas encore démarré, sa demande UAC est abandonnée.
 */
export async function executePlanElevated(plan: Plan, jobsDir: string, onProgress: (p: ExecProgress) => void, signal?: AbortSignal): Promise<PlanResult> {
  await fs.mkdir(jobsDir, { recursive: true })
  // Demandes d'annulation des plans précédents, gardées au cas où leur processus aurait démarré trop tard.
  for (const f of await fs.readdir(jobsDir)) if (f.endsWith('.cancel')) await fs.rm(path.join(jobsDir, f), { force: true }).catch(() => undefined)
  const planFile = path.join(jobsDir, `${plan.id}.plan.json`)
  const progressFile = `${planFile}.progress`
  const resultFile = `${planFile}.result.json`
  const cancelFile = `${planFile}.cancel`
  const body = JSON.stringify(plan)
  await fs.writeFile(planFile, body, 'utf8')
  await fs.rm(progressFile, { force: true })
  await fs.rm(resultFile, { force: true })
  const sha = createHash('sha256').update(body).digest('hex')

  const exe = process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  args.push(`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`, `${LOCALE_FLAG}${currentLocale()}`)
  const argList = args.map((a) => psQuote(`"${a}"`)).join(',')

  const readResult = async (): Promise<PlanResult | null> => {
    try {
      return JSON.parse(await fs.readFile(resultFile, 'utf8')) as PlanResult
    } catch {
      return null
    }
  }

  // PM_NO_UAC=1 (tests uniquement) : même mécanisme inter-processus, sans demande d'élévation.
  const verb = process.env.PM_NO_UAC === '1' ? '' : '-Verb RunAs'
  const stopWaiting = new AbortController()
  let exited = false
  const launch = runPowerShell(
    // -ErrorAction Stop : sans lui, un refus de la demande UAC n'arrive pas jusqu'au catch.
    `try { $p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${argList} ${verb} -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; Write-Output ("EXIT:" + $p.ExitCode) } catch { Write-Output ("DENIED:" + $_.Exception.Message) }`,
    6 * 60 * 60 * 1000,
    stopWaiting.signal
  )
    .catch(() => '')
    .finally(() => {
      exited = true
    })

  /** Suit le processus administrateur ; renvoie le résultat sans attendre la fin de PowerShell quand il est connu. */
  const watch = async (): Promise<PlanResult | null> => {
    const launchedAt = Date.now()
    let started = false
    let cancelledAt = 0
    while (!exited) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const raw = await fs.readFile(progressFile, 'utf8')
        started = true
        const last = raw.trim().split('\n').pop()
        if (last) onProgress(JSON.parse(last) as ExecProgress)
      } catch {
        /* pas encore de progression */
      }
      const result = await readResult()
      if (result) return result
      if (signal?.aborted && !cancelledAt) {
        cancelledAt = Date.now()
        await fs.writeFile(cancelFile, '').catch(() => undefined)
      }
      if (!started && cancelledAt) return { ok: false, results: [], error: t('executor.cancelled'), rolledBack: true, cancelled: true }
      if (!started && Date.now() - launchedAt > ELEVATION_TIMEOUT_MS) return { ok: false, results: [], error: t('executor.errors.elevationTimeout'), rolledBack: true }
      if (cancelledAt && Date.now() - cancelledAt > CANCEL_GRACE_MS) return { ok: false, results: [], error: t('executor.errors.cancelUnconfirmed'), rolledBack: false }
    }
    return null
  }

  try {
    const known = await watch()
    if (known) return known
    if (/DENIED:/.test(await launch)) {
      return { ok: false, results: [], error: t('executor.errors.elevationDenied'), rolledBack: true }
    }
    return (await readResult()) ?? { ok: false, results: [], error: t('executor.errors.noResult'), rolledBack: false }
  } finally {
    stopWaiting.abort()
    await launch
    await fs.rm(planFile, { force: true }).catch(() => undefined)
    await fs.rm(progressFile, { force: true }).catch(() => undefined)
    await fs.rm(resultFile, { force: true }).catch(() => undefined)
  }
}

/**
 * Exécute un script PowerShell avec les droits administrateur (une demande UAC), et renvoie ce qu'il a écrit (null si
 * l'autorisation est refusée). Le script est écrit dans `jobsDir` ; le PowerShell élevé reçoit seulement un court
 * lanceur qui vérifie son empreinte SHA-256 avant de l'exécuter : un fichier modifié entre-temps est refusé.
 */
export async function runPowerShellElevated(script: string, jobsDir: string, timeoutMs = 30 * 60 * 1000): Promise<string | null> {
  await fs.mkdir(jobsDir, { recursive: true })
  const id = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const scriptFile = path.join(jobsDir, `${id}.ps1`)
  const outFile = path.join(jobsDir, `${id}.out.txt`)
  const body = Buffer.from(`$ErrorActionPreference = 'SilentlyContinue'\n${script}`, 'utf8')
  await fs.writeFile(scriptFile, body)
  const sha = createHash('sha256').update(body).digest('hex')
  const boot = [
    `$bytes = [IO.File]::ReadAllBytes(${psQuote(scriptFile)})`,
    `$sha = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })`,
    `if ($sha -ne '${sha}') { exit 3 }`,
    `$out = & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes))) | Out-String`,
    `[IO.File]::WriteAllText(${psQuote(outFile)}, $out, (New-Object Text.UTF8Encoding $false))`
  ].join('\n')
  const encoded = Buffer.from(boot, 'utf16le').toString('base64')
  // PM_NO_UAC=1 (tests uniquement) : même mécanisme, sans demande d'élévation.
  const verb = process.env.PM_NO_UAC === '1' ? '' : '-Verb RunAs'
  try {
    const out = await runPowerShell(
      `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' ${verb} -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop; Write-Output ("EXIT:" + $p.ExitCode) } catch { Write-Output ("DENIED:" + $_.Exception.Message) }`,
      timeoutMs
    )
    if (/DENIED:/.test(out)) return null
    if (/EXIT:3\b/.test(out)) throw new Error(t('executor.errors.planTampered'))
    try {
      return await fs.readFile(outFile, 'utf8')
    } catch {
      throw new Error(t('executor.errors.noResult'))
    }
  } finally {
    await fs.rm(scriptFile, { force: true }).catch(() => undefined)
    await fs.rm(outFile, { force: true }).catch(() => undefined)
  }
}

/** Point d'entrée du processus élevé. Retourne le code de sortie. */
export async function runElevatedWorker(argv: string[]): Promise<number> {
  const planArg = argv.find((a) => a.startsWith(EXEC_FLAG))
  const hashArg = argv.find((a) => a.startsWith(HASH_FLAG))
  if (!planArg || !hashArg) return 2
  const planFile = planArg.slice(EXEC_FLAG.length).replace(/^"|"$/g, '')
  const expected = hashArg.slice(HASH_FLAG.length).replace(/^"|"$/g, '')
  const resultFile = `${planFile}.result.json`
  const progressFile = `${planFile}.progress`
  const cancelFile = `${planFile}.cancel`
  // Demande UAC acceptée alors que l'application a déjà abandonné ce plan : plus rien à faire.
  if (!(await fs.access(planFile).then(() => true, () => false))) return 4
  const abort = new AbortController()
  const checkCancel = (): Promise<void> => fs.access(cancelFile).then(() => abort.abort(), () => undefined)
  let cancelWatch: NodeJS.Timeout | undefined
  try {
    const body = await fs.readFile(planFile, 'utf8')
    if (createHash('sha256').update(body).digest('hex') !== expected) {
      await fs.writeFile(resultFile, JSON.stringify({ ok: false, results: [], error: t('executor.errors.planTampered'), rolledBack: true }))
      return 3
    }
    const plan = JSON.parse(body) as Plan
    await checkCancel()
    cancelWatch = setInterval(() => void checkCancel(), 300)
    const result = await executePlan(
      plan,
      (p) => {
        void fs.appendFile(progressFile, `${JSON.stringify(p)}\n`).catch(() => undefined)
      },
      abort.signal
    )
    await fs.writeFile(resultFile, JSON.stringify(result))
    return result.ok ? 0 : 1
  } catch (err) {
    await fs.writeFile(resultFile, JSON.stringify({ ok: false, results: [], error: (err as Error).message, rolledBack: false })).catch(() => undefined)
    return 4
  } finally {
    clearInterval(cancelWatch)
  }
}
