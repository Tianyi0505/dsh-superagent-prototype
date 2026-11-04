import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const summaryFile = process.env.GITHUB_STEP_SUMMARY
const forced = (process.env.FORCE_BUMP || '').trim()

const attach = (err) => {
  const parts = [err?.message, err?.stdout?.toString?.(), err?.stderr?.toString?.()].filter(Boolean)
  return parts.join('\n').trim() || String(err)
}

const report = (title, text) => {
  const body = String(text).slice(0, 6000)
  console.error(`::error title=${title}::${body.replace(/\r?\n/g, '%0A').slice(0, 900)}`)
  if (summaryFile) appendFileSync(summaryFile, `\n### ${title}\n\n\`\`\`\n${body}\n\`\`\`\n`)
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()

const git = (...args) => run('git', args)

const publishedVersions = async (name) => {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`registry lookup failed: ${res.status} ${res.statusText}`)
  const body = await res.json()
  return Object.keys(body?.versions ?? {})
}

const compare = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

const release = async () => {
  const pkgPath = 'package.json'
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  const versions = await publishedVersions(pkg.name)
  const stable = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  const newest = stable.sort(compare).at(-1) ?? '0.0.0'
  const base = compare(pkg.version, newest) >= 0 ? pkg.version : newest

  const tags = git('tag', '--list', 'v[0-9]*')
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => compare(a.slice(1), b.slice(1)))
  const lastTag = tags.at(-1) ?? ''

  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const subjects = git('log', range, '--pretty=format:%s').split('\n').filter(Boolean)
  const bodies = git('log', range, '--pretty=format:%b')

  const isBreaking =
    /BREAKING[ -]CHANGE/.test(bodies) || subjects.some((s) => /^[a-z]+(\([^)]*\))?!:/.test(s))
  const isFeature = subjects.some((s) => /^feat(\([^)]*\))?:/.test(s))
  const isFix = subjects.some((s) => /^(fix|perf)(\([^)]*\))?:/.test(s))

  const [major, minor, patch] = base.split('.').map(Number)
  let next = ''
  if (isBreaking) next = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`
  else if (isFeature) next = major === 0 ? `0.${minor + 1}.0` : `${major}.${minor + 1}.0`
  else if (isFix) next = `${major}.${minor}.${patch + 1}`
  else if (forced === 'patch') next = `${major}.${minor}.${patch + 1}`
  else if (forced === 'minor') next = major === 0 ? `0.${minor + 1}.0` : `${major}.${minor + 1}.0`
  else if (forced === 'major') next = `${major + 1}.0.0`

  if (!next) {
    console.log(`No release-worthy commits since ${lastTag || 'the first commit'}; nothing to publish.`)
    return
  }

  if (git('tag', '--list', `v${next}`)) {
    console.log(`Tag v${next} already exists; nothing to publish.`)
    return
  }

  console.log(`Releasing ${base} -> ${next} (${lastTag || 'no previous tag'})`)

  pkg.version = next
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

  try {
    console.log(run('pnpm', ['build']))
  } catch (err) {
    throw new Error(`BUILD FAILED\n${attach(err)}`)
  }

  if (versions.includes(next)) {
    console.log(`${pkg.name}@${next} is already on the npm registry; skipping publish.`)
  } else {
    try {
      console.log(run('pnpm', ['publish', '--access', 'public', '--no-git-checks', '--tag', 'latest']))
    } catch (err) {
      throw new Error(`PUBLISH FAILED\n${attach(err)}`)
    }
  }

  git('tag', `v${next}`)
  git('push', 'origin', `v${next}`)

  const notes = subjects
    .filter((s) => !s.startsWith('chore(release)'))
    .map((s) => `- ${s}`)
    .join('\n')

  mkdirSync('dist', { recursive: true })
  run('npm', ['pack', '--pack-destination', 'dist', '--silent'])
  const tarball = join('dist', readdirSync('dist').find((f) => f.endsWith('.tgz')))

  run(
    'gh',
    ['release', 'create', `v${next}`, tarball, '--title', `v${next}`, '--notes', notes || `v${next}`, '--latest'],
  )
}

try {
  await release()
} catch (err) {
  report('Release failed', attach(err))
  process.exit(1)
}
