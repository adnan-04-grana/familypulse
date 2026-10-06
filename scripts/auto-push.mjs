import { spawn, spawnSync } from 'node:child_process'
import { watch, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const remoteUrl = 'https://github.com/adnan-04-grana/familypulse'
const debounceMs = 1800
const retryMs = 30_000
const ignoredDirectories = new Set(['.git', '.vscode', 'node_modules', 'dist', 'dist-ssr', 'coverage'])

function findGit() {
  const candidates = [process.env.GIT_EXECUTABLE, 'git']
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const localAppData = process.env.LOCALAPPDATA
    candidates.push(path.join(programFiles, 'Git', 'cmd', 'git.exe'))
    if (localAppData) {
      const desktopRoot = path.join(localAppData, 'GitHubDesktop')
      try {
        const appFolders = readdirSync(desktopRoot).filter((name) => name.startsWith('app-')).sort().reverse()
        for (const appFolder of appFolders) {
          candidates.push(path.join(desktopRoot, appFolder, 'resources', 'app', 'git', 'cmd', 'git.exe'))
        }
      } catch {
        // GitHub Desktop is optional.
      }
    }
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (spawnSync(candidate, ['--version'], { cwd: projectRoot, stdio: 'ignore', windowsHide: true }).status === 0) return candidate
    } catch {
      // Try the next Git location.
    }
  }
  throw new Error('Git was not found. Install Git or set GIT_EXECUTABLE before starting auto-push.')
}

const git = findGit()

function runGit(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(git, args, {
      cwd: projectRoot,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: false,
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function verifyRepository() {
  const root = await runGit(['rev-parse', '--show-toplevel'], true)
  const branch = await runGit(['branch', '--show-current'], true)
  const origin = await runGit(['remote', 'get-url', 'origin'], true)
  const author = await runGit(['var', 'GIT_AUTHOR_IDENT'], true)
  const expectedRemote = new Set([remoteUrl, `${remoteUrl}.git`])
  if (root.code !== 0 || path.resolve(root.stdout.trim()).toLowerCase() !== projectRoot.toLowerCase()) {
    throw new Error('Git repository root does not match this project folder.')
  }
  if (branch.stdout.trim() !== 'main') throw new Error('Automatic publishing only runs from the main branch.')
  if (origin.code !== 0 || !expectedRemote.has(origin.stdout.trim())) throw new Error(`origin must be ${remoteUrl}`)
  if (author.code !== 0) throw new Error('Git author name/email are not configured.')
  const staged = await runGit(['diff', '--cached', '--quiet'])
  if (staged.code !== 0) throw new Error('The Git index already has staged changes. Commit or unstage them before enabling auto-push.')
}

const pendingPaths = new Set()
let debounceTimer = null
let retryTimer = null
let syncing = false
let paused = false
let watcher

function shouldIgnore(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true
  if (normalized.split('/').some((segment) => ignoredDirectories.has(segment))) return true
  return normalized.endsWith('.swp') || normalized.endsWith('.tmp') || normalized.endsWith('~')
}

function scheduleSync() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void syncChanges()
  }, debounceMs)
}

async function pushChanges() {
  let result = await runGit(['push', '-u', 'origin', 'main'])
  if (result.code === 0) {
    console.log('Auto-push complete: main is up to date on GitHub.')
    return
  }
  console.log('Remote changed since the last sync; rebasing origin/main before retrying the push.')
  const integration = await runGit(['pull', '--rebase', 'origin', 'main'])
  if (integration.code !== 0) {
    paused = true
    watcher?.close()
    console.error('Auto-push paused because remote changes could not be rebased cleanly. Resolve the Git conflict, then restart the task.')
    return
  }
  result = await runGit(['push', '-u', 'origin', 'main'])
  if (result.code === 0) {
    console.log('Auto-push complete after rebasing origin/main.')
    return
  }
  console.error(`GitHub push failed. The commit is local; retrying in ${retryMs / 1000} seconds.`)
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      void pushChanges()
    }, retryMs)
  }
}

async function syncChanges() {
  if (paused || syncing || pendingPaths.size === 0) return
  syncing = true
  const paths = [...pendingPaths]
  pendingPaths.clear()
  try {
    const staged = await runGit(['diff', '--cached', '--quiet'])
    if (staged.code !== 0) {
      console.error('Auto-push paused: existing staged changes need review before they can be included.')
      return
    }
    const add = await runGit(['add', '-A', '--', ...paths])
    if (add.code !== 0) throw new Error('git add failed.')
    const stagedChanges = await runGit(['diff', '--cached', '--quiet'])
    if (stagedChanges.code === 0) return
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    const commit = await runGit(['commit', '-m', `Auto-sync: ${timestamp}`])
    if (commit.code !== 0) throw new Error('Automatic commit failed.')
    await pushChanges()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Auto-push failed.')
  } finally {
    syncing = false
    if (pendingPaths.size > 0) scheduleSync()
  }
}

await verifyRepository()
const initialStatus = await runGit(['status', '--porcelain'], true)
if (initialStatus.stdout.trim()) {
  const staged = await runGit(['diff', '--cached', '--quiet'])
  if (staged.code !== 0) throw new Error('Existing staged changes need review before auto-push can start.')
  pendingPaths.add('.')
  scheduleSync()
}

watcher = watch(projectRoot, { recursive: true }, (_eventType, filename) => {
  if (paused || !filename) return
  const relativePath = filename.toString().replaceAll('\\', '/')
  if (shouldIgnore(relativePath)) return
  pendingPaths.add(relativePath)
  scheduleSync()
})

console.log(`Watching ${projectRoot} for saves; changes will be committed and pushed to origin/main.`)
console.log('Press Ctrl+C to stop automatic publishing.')

function stop() {
  watcher.close()
  if (debounceTimer) clearTimeout(debounceTimer)
  if (retryTimer) clearTimeout(retryTimer)
  process.exit(0)
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
