#!/usr/bin/env node
// Lance la publication d'une version sur GitHub Actions, sans rien committer.
//
//   npm run release                  vérifie, pousse le tag vX.Y.Z (version de package.json) et suit la publication
//   npm run release -- --dry-run     affiche ce qui serait fait, sans rien pousser
//   npm run release -- --no-watch    pousse le tag sans attendre la fin de la publication
//
// La version publiée est celle du dernier commit (package.json de HEAD). Le workflow .github/workflows/release.yml
// compile, signe, crée la release GitHub et met la version en ligne sur reflect-fivem.com.
//
// Nouveautés : notes/X.Y.Z.md du dernier commit, découpé en rubriques par deploy/deploy.py (modèle : notes/modele.md).
// Le découpage est vérifié ici avant de pousser le tag. L'annonce sur Discord se fait ensuite depuis l'administration
// du site (bouton « Notifier la mise à jour »).

import { execFileSync, spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const watch = !args.includes('--no-watch')
const allowDirty = args.includes('--allow-dirty')
const SITE = 'https://reflect-fivem.com'
const SITE_API = `${SITE}/api`

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const step = (m) => console.log(`\n${color('1;36', `==> ${m}`)}`)
const info = (m) => console.log(`    ${m}`)
const ok = (m) => console.log(`    ${color('32', 'OK')} ${m}`)
const warn = (m) => console.log(`    ${color('33', 'ATTENTION')} ${m}`)
class Stop extends Error {}
const fail = (m) => {
  console.error(`    ${color('31', 'ERREUR')} ${m}`)
  return new Stop(m)
}

/** Commande sans shell ; renvoie la sortie, ou null en cas d'échec si quiet. */
function run(cmd, cmdArgs, { quiet = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (quiet) return null
    throw fail(`${cmd} ${cmdArgs.join(' ')} : ${(err.stderr || err.message).toString().trim().split('\n')[0]}`)
  }
}

/** Commande dont la sortie s'affiche directement (push, suivi du workflow). */
function live(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit' })
  if (result.error) throw fail(`${cmd} introuvable`)
  return result.status ?? 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Rubriques des nouveautés : même découpage que deploy/deploy.py (split_changelog), qui envoie les notes à l'API.
const SECTION_NAMES = { features: 'Nouveautés', improvements: 'Améliorations', fixes: 'Corrections de bugs', other: 'Autres changements' }
const SECTION_TITLES = {
  features: ['nouveautes', 'nouveaute', 'nouvelles fonctionnalites', 'fonctionnalites', 'new features', 'features'],
  improvements: ['ameliorations', 'amelioration', 'improvements'],
  fixes: ['corrections', 'correction', 'corrections de bugs', 'corrections de bug', 'correctifs', 'bug fixes', 'fixes'],
  other: ['autres', 'autre', 'autres changements', 'divers', 'other', 'other changes']
}
/** Limites de l'API (PUT /admin/releases/{id}/changelog). */
const LIMITS = { items: 50, item: 500, summary: 5000 }

/** Rubrique d'un titre (minuscules, sans accents ni ponctuation), null s'il n'en désigne aucune. */
function sectionOf(title) {
  const plain = title.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim()
  return Object.keys(SECTION_TITLES).find((key) => SECTION_TITLES[key].includes(plain)) ?? null
}

/** Introduction (texte avant le premier titre), points par rubrique et titres inconnus (rangés dans « Autres »). */
function splitChangelog(markdown) {
  const changelog = { summary: '', features: [], improvements: [], fixes: [], other: [] }
  const summary = []
  const unknown = []
  let section = null
  let open = false
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/)
    if (heading) {
      section = sectionOf(heading[1])
      if (!section) {
        unknown.push(heading[1])
        section = 'other'
      }
      open = false
      continue
    }
    if (!section) {
      summary.push(line)
      continue
    }
    if (!line.trim()) {
      open = false
      continue
    }
    const items = changelog[section]
    const bullet = line.match(/^(?:[-*+•]|\d+[.)])\s+(.*)$/)
    if (bullet) items.push(bullet[1].trim())
    else if (items.length && (open || /^\s/.test(line))) items[items.length - 1] += ` ${line.trim()}`
    else items.push(line.trim())
    open = true
  }
  changelog.summary = summary.join('\n').trim()
  for (const key of Object.keys(SECTION_NAMES)) changelog[key] = changelog[key].filter(Boolean)
  return { changelog, unknown }
}

/** Nouveautés du dernier commit vérifiées avant de pousser le tag : titres reconnus, limites de l'API. */
function checkNotes(version) {
  const markdown = run('git', ['show', `HEAD:notes/${version}.md`], { quiet: true })
  if (markdown === null) {
    warn(`notes/${version}.md absent : les nouveautés seront la liste des commits depuis la version précédente (« ${SECTION_NAMES.other} »)`)
    return
  }
  const { changelog, unknown } = splitChangelog(markdown)
  if (unknown.length)
    throw fail(`notes/${version}.md : titre(s) inconnu(s) ${unknown.map((t) => `« ${t} »`).join(', ')}. ` +
      `Titres des rubriques : ${Object.values(SECTION_NAMES).map((t) => `« ## ${t} »`).join(', ')} (voir notes/modele.md)`)
  if (changelog.summary.length > LIMITS.summary) throw fail(`notes/${version}.md : introduction trop longue (${LIMITS.summary} caractères au plus)`)
  for (const [key, name] of Object.entries(SECTION_NAMES)) {
    if (changelog[key].length > LIMITS.items) throw fail(`notes/${version}.md : « ${name} » a ${changelog[key].length} points (${LIMITS.items} au plus)`)
    const long = changelog[key].find((item) => item.length > LIMITS.item)
    if (long) throw fail(`notes/${version}.md : point trop long dans « ${name} » (${LIMITS.item} caractères au plus) : ${long.slice(0, 60)}…`)
  }
  const parts = [changelog.summary ? 'introduction' : null, ...Object.entries(SECTION_NAMES).filter(([key]) => changelog[key].length).map(([key, name]) => `${name} : ${changelog[key].length}`)]
  if (!parts.some(Boolean)) throw fail(`notes/${version}.md est vide`)
  if (Object.keys(SECTION_NAMES).every((key) => !changelog[key].length))
    warn(`notes/${version}.md n'a aucune rubrique : tout le texte sera l'introduction (voir notes/modele.md)`)
  ok(`nouveautés : notes/${version}.md (${parts.filter(Boolean).join(', ')})`)
}

/** Rappel de fin : l'annonce Discord n'est plus faite par la publication. */
function discordReminder() {
  info(`annonce Discord : à faire depuis ${SITE}/admin/versions (bouton « Notifier la mise à jour » de la version)`)
}

async function main() {
  step('Vérifications')
  run('git', ['rev-parse', '--show-toplevel'])
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') throw fail('HEAD détaché : placez-vous sur une branche')
  if (branch !== 'main') warn(`publication depuis la branche ${branch} (et non main)`)

  const dirty = run('git', ['status', '--porcelain']).split('\n').filter(Boolean)
  if (dirty.length && !allowDirty) {
    for (const line of dirty.slice(0, 10)) info(line)
    throw fail(`${dirty.length} fichier(s) modifié(s) non committé(s) : ils ne feraient pas partie de la version. ` +
      'Committez-les d’abord (ou relancez avec --allow-dirty).')
  }

  const version = JSON.parse(run('git', ['show', 'HEAD:package.json'])).version
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw fail(`version invalide dans package.json : ${version}`)
  const tag = `v${version}`
  ok(`version ${version} (package.json du dernier commit)`)

  const remoteUrl = run('git', ['remote', 'get-url', 'origin'])
  const repo = remoteUrl.match(/github\.com[:/](.+?)(\.git)?$/)?.[1]
  if (!repo) throw fail(`dépôt GitHub introuvable (origin = ${remoteUrl})`)

  run('git', ['fetch', '--quiet', '--tags', 'origin'])
  const remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  if (remoteTag || run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { quiet: true })) {
    throw fail(`la version ${version} est déjà publiée (tag ${tag}) : montez la version dans package.json puis committez`)
  }
  ok(`tag ${tag} libre`)

  checkNotes(version)

  const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { quiet: true })
  const ahead = upstream ? Number(run('git', ['rev-list', '--count', `${upstream}..HEAD`])) : null
  if (upstream === null) info(`la branche ${branch} n'est pas encore sur GitHub : elle sera poussée`)
  else if (ahead > 0) info(`${ahead} commit(s) pas encore poussé(s) : ils seront poussés`)
  else ok(`branche ${branch} à jour sur GitHub`)

  if (dryRun) {
    step('Simulation terminée : rien n’a été poussé')
    info(`ferait : ${upstream === null || ahead > 0 ? `git push, puis ` : ''}git tag -a ${tag} && git push origin ${tag}`)
    return
  }

  step(`Lancement de la publication ${tag}`)
  if (upstream === null) {
    if (live('git', ['push', '-u', 'origin', branch]) !== 0) throw fail('push de la branche impossible')
  } else if (ahead > 0) {
    if (live('git', ['push']) !== 0) throw fail('push impossible')
  }
  const head = run('git', ['rev-parse', 'HEAD'])
  run('git', ['tag', '-a', tag, '-m', `Version ${version}`])
  if (live('git', ['push', 'origin', tag]) !== 0) {
    run('git', ['tag', '-d', tag], { quiet: true })
    throw fail(`push du tag ${tag} impossible (tag local supprimé, vous pouvez relancer)`)
  }
  ok(`tag ${tag} poussé : GitHub Actions compile et publie`)
  const actionsUrl = `https://github.com/${repo}/actions/workflows/release.yml`

  if (!watch) {
    info(`suivi : ${actionsUrl}`)
    discordReminder()
    return
  }
  if (run('gh', ['--version'], { quiet: true }) === null) {
    warn('gh (GitHub CLI) absent : suivez la publication sur GitHub')
    info(actionsUrl)
    return
  }

  step('Suivi de la publication')
  let runId = null
  for (let i = 0; i < 30 && !runId; i++) {
    await sleep(3000)
    const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', 'release.yml', '--limit', '10',
      '--json', 'databaseId,headBranch,headSha']) || '[]')
    runId = runs.find((r) => r.headBranch === tag || r.headSha === head)?.databaseId ?? null
  }
  if (!runId) {
    warn('exécution introuvable pour l’instant')
    info(actionsUrl)
    return
  }
  info(`https://github.com/${repo}/actions/runs/${runId}`)
  const status = live('gh', ['run', 'watch', String(runId), '--repo', repo, '--exit-status', '--interval', '15'])
  if (status !== 0) throw fail(`publication en échec : https://github.com/${repo}/actions/runs/${runId}`)

  step('Vérification')
  const release = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'url', '-q', '.url'], { quiet: true })
  if (release) ok(`release GitHub : ${release}`)
  try {
    const latest = await (await fetch(`${SITE_API}/app/releases/latest`)).json()
    if (latest.version === version) ok(`reflect-fivem.com propose la version ${version} : les applications installées la prendront seules`)
    else warn(`reflect-fivem.com propose encore la version ${latest.version} (secrets de publication manquants ?)`)
  } catch {
    warn('reflect-fivem.com injoignable pour la vérification')
  }
  step(`Version ${version} publiée`)
  discordReminder()
}

main().catch((err) => {
  if (!(err instanceof Stop)) console.error(err)
  process.exit(1)
})
