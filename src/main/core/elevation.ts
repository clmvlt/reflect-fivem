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

export async function executePlanElevated(plan: Plan, jobsDir: string, onProgress: (p: ExecProgress) => void): Promise<PlanResult> {
  await fs.mkdir(jobsDir, { recursive: true })
  const planFile = path.join(jobsDir, `${plan.id}.plan.json`)
  const progressFile = `${planFile}.progress`
  const resultFile = `${planFile}.result.json`
  const body = JSON.stringify(plan)
  await fs.writeFile(planFile, body, 'utf8')
  await fs.rm(progressFile, { force: true })
  await fs.rm(resultFile, { force: true })
  const sha = createHash('sha256').update(body).digest('hex')

  const exe = process.execPath
  const args = app.isPackaged ? [] : [app.getAppPath()]
  args.push(`${EXEC_FLAG}${planFile}`, `${HASH_FLAG}${sha}`, `${LOCALE_FLAG}${currentLocale()}`)
  const argList = args.map((a) => psQuote(`"${a}"`)).join(',')

  let stop = false
  const poll = (async () => {
    while (!stop) {
      await new Promise((r) => setTimeout(r, 250))
      try {
        const raw = await fs.readFile(progressFile, 'utf8')
        const last = raw.trim().split('\n').pop()
        if (last) onProgress(JSON.parse(last) as ExecProgress)
      } catch {
        /* pas encore de progression */
      }
    }
  })()

  try {
    // PM_NO_UAC=1 (tests uniquement) : même mécanisme inter-processus, sans demande d'élévation.
    const verb = process.env.PM_NO_UAC === '1' ? '' : '-Verb RunAs'
    const out = await runPowerShell(
      `try { $p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${argList} ${verb} -Wait -PassThru -WindowStyle Hidden; Write-Output ("EXIT:" + $p.ExitCode) } catch { Write-Output ("DENIED:" + $_.Exception.Message) }`,
      6 * 60 * 60 * 1000
    )
    if (/DENIED:/.test(out)) {
      return { ok: false, results: [], error: t('executor.errors.elevationDenied'), rolledBack: true }
    }
    try {
      return JSON.parse(await fs.readFile(resultFile, 'utf8')) as PlanResult
    } catch {
      return { ok: false, results: [], error: t('executor.errors.noResult'), rolledBack: false }
    }
  } finally {
    stop = true
    await poll
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
  try {
    const body = await fs.readFile(planFile, 'utf8')
    if (createHash('sha256').update(body).digest('hex') !== expected) {
      await fs.writeFile(resultFile, JSON.stringify({ ok: false, results: [], error: t('executor.errors.planTampered'), rolledBack: true }))
      return 3
    }
    const plan = JSON.parse(body) as Plan
    const result = await executePlan(plan, (p) => {
      void fs.appendFile(progressFile, `${JSON.stringify(p)}\n`).catch(() => undefined)
    })
    await fs.writeFile(resultFile, JSON.stringify(result))
    return result.ok ? 0 : 1
  } catch (err) {
    await fs.writeFile(resultFile, JSON.stringify({ ok: false, results: [], error: (err as Error).message, rolledBack: false })).catch(() => undefined)
    return 4
  }
}
