import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { t } from 'i18next'

/** Exécute un script PowerShell (sortie forcée en UTF-8 pour les chemins accentués). */
export function runPowerShell(script: string, timeoutMs = 20_000, signal?: AbortSignal): Promise<string> {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'SilentlyContinue'\n${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
    )
  })
}

export interface RegistrySnapshot {
  /** Chemins GTA V trouvés dans les clés Rockstar (InstallFolder, InstallFolderSteam, InstallFolderEpic...). */
  rockstarPaths: { path: string; source: string; enhanced: boolean }[]
  steamPath: string | null
  fivemLastRun: string | null
  /** Commande du protocole fivem:// (réécrite par FiveM à chaque lancement : pointe vers le FiveM.exe utilisé). */
  fivemProtocol: string | null
  uninstall: { name: string; location: string; key: string }[]
}

/**
 * Lit en une seule fois toutes les clés de registre utiles à la détection des jeux. Par l'API .NET plutôt que par
 * Get-ItemProperty / Get-ChildItem : bien plus rapide sur les centaines de clés « Uninstall ».
 */
export async function readRegistry(): Promise<RegistrySnapshot> {
  const script = String.raw`
$LM = [Microsoft.Win32.Registry]::LocalMachine
$CU = [Microsoft.Win32.Registry]::CurrentUser
function Val($hive, $key, $name) {
  $k = $hive.OpenSubKey($key)
  if (-not $k) { return $null }
  try { return $k.GetValue($name) } finally { $k.Close() }
}
$r = @{}
$paths = @()
$keys = @(
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\Grand Theft Auto V'; e = $false },
  @{ k = 'SOFTWARE\Rockstar Games\Grand Theft Auto V'; e = $false },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTAV'; e = $false },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTAV Enhanced'; e = $true },
  @{ k = 'SOFTWARE\WOW6432Node\Rockstar Games\GTA V Enhanced'; e = $true }
)
foreach ($entry in $keys) {
  $k = $LM.OpenSubKey($entry.k)
  if (-not $k) { continue }
  foreach ($v in 'InstallFolder','InstallFolderSteam','InstallFolderEpic','InstallFolderXboxPc') {
    $val = [string]$k.GetValue($v)
    if ($val) {
      if ($v -eq 'InstallFolderSteam') { $val = $val -replace '\\GTAV$','' }
      $paths += @{ path = $val; source = $v; enhanced = $entry.e }
    }
  }
  $k.Close()
}
$r.rockstarPaths = $paths
$s = Val $CU 'Software\Valve\Steam' 'SteamPath'
if (-not $s) { $s = Val $LM 'SOFTWARE\WOW6432Node\Valve\Steam' 'InstallPath' }
$r.steamPath = $s
$r.fivemLastRun = Val $CU 'Software\CitizenFX\FiveM' 'Last Run Location'
$r.fivemProtocol = Val $CU 'Software\Classes\FiveM.ProtocolHandler\shell\open\command' ''
$u = @()
foreach ($root in @(@($LM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'), @($LM, 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'), @($CU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall'))) {
  $k = $root[0].OpenSubKey($root[1])
  if (-not $k) { continue }
  foreach ($name in $k.GetSubKeyNames()) {
    $sub = $k.OpenSubKey($name)
    if (-not $sub) { continue }
    $dn = [string]$sub.GetValue('DisplayName')
    if ($dn -match 'Grand Theft Auto|FiveM|GTA V' -or $name -match 'Steam App (271590|3240220)|CitizenFX') {
      $u += @{ name = $dn; location = [string]$sub.GetValue('InstallLocation'); key = $name }
    }
    $sub.Close()
  }
  $k.Close()
}
$r.uninstall = $u
$r | ConvertTo-Json -Depth 4 -Compress
`
  const arr = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : [])
  try {
    const out = await runPowerShell(script)
    const json = JSON.parse(out.trim() || '{}')
    return {
      // Source : nom de la valeur lue (InstallFolder...), présentée dans la langue affichée.
      rockstarPaths: arr<RegistrySnapshot['rockstarPaths'][number]>(json.rockstarPaths).map((p) => ({ ...p, source: t('system.rockstarRegistry', { value: p.source }) })),
      steamPath: json.steamPath || null,
      fivemLastRun: json.fivemLastRun || null,
      fivemProtocol: json.fivemProtocol || null,
      uninstall: arr(json.uninstall)
    }
  } catch {
    return { rockstarPaths: [], steamPath: null, fivemLastRun: null, fivemProtocol: null, uninstall: [] }
  }
}

/** Carte graphique lue par Windows : nom et mémoire vidéo dédiée en octets (null si elle n'est pas indiquée). */
export interface VideoAdapter {
  name: string
  memory: number | null
}

/**
 * Cartes graphiques de la machine. `registry` : clés des pilotes d'affichage (DriverDesc, mémoire dédiée exacte dans
 * HardwareInformation.qwMemorySize). `wmi` : Win32_VideoController, lu seulement si aucune carte du registre n'indique sa
 * mémoire (AdapterRAM y est plafonné à 4 Go).
 */
export async function readVideoAdapters(): Promise<{ registry: VideoAdapter[]; wmi: VideoAdapter[] }> {
  const script = String.raw`
$LM = [Microsoft.Win32.Registry]::LocalMachine
$reg = @()
$root = $LM.OpenSubKey('SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}')
if ($root) {
  foreach ($name in $root.GetSubKeyNames()) {
    if ($name -notmatch '^\d{4}$') { continue }
    $k = $null
    try { $k = $root.OpenSubKey($name) } catch { continue }
    if (-not $k) { continue }
    $mem = $k.GetValue('HardwareInformation.qwMemorySize')
    if ($mem -eq $null) { $mem = $k.GetValue('HardwareInformation.MemorySize') }
    if ($mem -is [byte[]]) {
      if ($mem.Length -ge 8) { $mem = [BitConverter]::ToUInt64($mem, 0) } elseif ($mem.Length -ge 4) { $mem = [BitConverter]::ToUInt32($mem, 0) } else { $mem = $null }
    } elseif ($mem -is [int]) { $mem = [BitConverter]::ToUInt32([BitConverter]::GetBytes($mem), 0) }
    $m = $null
    if ($mem -ne $null) { $m = [string]$mem }
    $reg += @{ name = [string]$k.GetValue('DriverDesc'); memory = $m }
    $k.Close()
  }
  $root.Close()
}
$wmi = @()
if (-not ($reg | Where-Object { $_.memory -and $_.memory -ne '0' })) {
  foreach ($v in Get-CimInstance Win32_VideoController) {
    $m = $null
    if ($v.AdapterRAM) { $m = [string]$v.AdapterRAM }
    $wmi += @{ name = [string]$v.Name; memory = $m }
  }
}
ConvertTo-Json -InputObject @{ registry = @($reg); wmi = @($wmi) } -Depth 4 -Compress
`
  const arr = <T>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : [])
  const adapters = (x: unknown): VideoAdapter[] =>
    arr(x as { name?: unknown; memory?: unknown }[])
      .filter((a) => a && typeof a.name === 'string' && a.name.trim())
      .map((a) => {
        const memory = typeof a.memory === 'string' || typeof a.memory === 'number' ? Number(a.memory) : NaN
        return { name: (a.name as string).trim(), memory: Number.isFinite(memory) && memory > 0 ? memory : null }
      })
  const json = JSON.parse((await runPowerShell(script)).trim() || '{}') as { registry?: unknown; wmi?: unknown }
  return { registry: adapters(json.registry), wmi: adapters(json.wmi) }
}

/** Liste des processus en cours (noms d'exécutables). */
export function listProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const names = stdout
        .split(/\r?\n/)
        .map((l) => /^"([^"]+)"/.exec(l)?.[1])
        .filter((x): x is string => !!x)
      resolve([...new Set(names)])
    })
  })
}

const GAME_PROCESS = /^(fivem(_.*)?|gta5(_enhanced)?|gta5_be|playgtav|gtavlauncher|fivem_.*gtaprocess)\.exe$/i

export async function runningGameProcesses(): Promise<string[]> {
  return (await listProcesses()).filter((n) => GAME_PROCESS.test(n))
}

const DISCORD_PROCESS = /^discord(ptb|canary|development)?\.exe$/i

/** Application Discord ouverte (stable, PTB ou Canary). */
export async function discordRunning(): Promise<boolean> {
  return (await listProcesses()).some((n) => DISCORD_PROCESS.test(n))
}

/** Demande la fermeture de processus (taskkill), avec leurs processus enfants ; `force` : arrêt immédiat. */
export function killProcesses(names: string[], force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = [...(force ? ['/F'] : []), '/T', ...names.flatMap((n) => ['/IM', n])]
    execFile('taskkill.exe', args, { windowsHide: true }, () => resolve())
  })
}

/** Lance un programme indépendant de l'application (il continue si elle est fermée). */
export function launchDetached(exe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
