import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, test } from 'node:test'
import 'dotenv/config'

let serverProcess
let apiBase
let ownerCookie
let memberCookie
let ownerId
let memberId

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  const setCookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  return { response, data, setCookie }
}

async function deleteAccount(cookie) {
  if (!cookie) return
  await request('/api/actions', { method: 'POST', cookie, body: { type: 'delete-account', payload: {} } })
}

test('API persists accounts and enforces circle permissions and invite use', async (context) => {
  const port = await availablePort()
  apiBase = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  serverProcess.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk })
  serverProcess.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk })
  context.after(async () => {
    await deleteAccount(memberCookie)
    await deleteAccount(ownerCookie)
    serverProcess?.kill()
    if (serverProcess?.exitCode === null) await once(serverProcess, 'exit')
  })

  let ready = false
  const startupDeadline = Date.now() + 20_000
  while (Date.now() < startupDeadline && !ready) {
    if (serverProcess.exitCode !== null) throw new Error(`API process exited during startup: ${serverOutput}`)
    try {
      ready = (await fetch(`${apiBase}/api/health`)).ok
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert.equal(ready, true, `API failed to start: ${serverOutput}`)

  const suffix = randomUUID()
  const password = `FamilyPulse-Test-${randomUUID()}!`
  const ownerSignup = await request('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Integration Owner', email: `owner-${suffix}@example.test`, password },
  })
  assert.equal(ownerSignup.response.status, 200)
  assert.ok(ownerSignup.setCookie)
  ownerCookie = ownerSignup.setCookie
  ownerId = ownerSignup.data.accountId
  assert.equal(ownerSignup.data.store.accounts[0].passwordHash, '')

  const profile = {
    dateOfBirth: '1990-01-01', bloodType: 'O+', allergies: 'Test allergy', conditions: '',
    medications: '', doctor: 'Test clinic', insurance: '', notes: '', emergencyNumber: '',
  }
  const savedProfile = await request('/api/actions', {
    method: 'POST', cookie: ownerCookie, body: { type: 'update-profile', payload: { profile } },
  })
  assert.equal(savedProfile.data.store.accounts[0].profile.allergies, 'Test allergy')

  const inviteCode = 'ABCDEFGH'
  const invitePasscode = '123456'
  const tokenHash = createHash('sha256')
    .update(`familypulse-invite-v1:${inviteCode}:${invitePasscode}`)
    .digest('hex')
  const createdAt = Date.now()
  const createdInvite = await request('/api/actions', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      type: 'create-invite',
      payload: { tokenHash, createdAt, expiresAt: createdAt + 15 * 60 * 1000, circleId: savedProfile.data.store.circles[0].id },
    },
  })
  assert.equal(createdInvite.response.status, 200)

  const memberSignup = await request('/api/auth/join', {
    method: 'POST',
    body: { name: 'Integration Member', email: `member-${suffix}@example.test`, password, code: inviteCode, passcode: invitePasscode },
  })
  assert.equal(memberSignup.response.status, 200)
  memberCookie = memberSignup.setCookie
  memberId = memberSignup.data.accountId
  const hiddenOwner = memberSignup.data.store.accounts.find((account) => account.id === ownerId)
  assert.equal(hiddenOwner.profile.allergies, '')
  assert.equal(hiddenOwner.email, '')

  const sharedProfile = await request('/api/actions', {
    method: 'POST', cookie: ownerCookie, body: { type: 'update-permission', payload: { field: 'medical', checked: true } },
  })
  assert.equal(sharedProfile.response.status, 200)
  const memberState = await request('/api/state', { cookie: memberCookie })
  const sharedOwner = memberState.data.store.accounts.find((account) => account.id === ownerId)
  assert.equal(sharedOwner.profile.allergies, 'Test allergy')
  assert.equal(sharedOwner.profile.dateOfBirth, '')
  assert.equal(sharedOwner.email, '')

  const checkIn = await request('/api/actions', {
    method: 'POST', cookie: ownerCookie, body: { type: 'start-event', payload: {} },
  })
  assert.equal(checkIn.data.store.events.length, 1)
  const memberAfterCheckIn = await request('/api/state', { cookie: memberCookie })
  assert.equal(memberAfterCheckIn.data.store.notifications.length, 1)

  const reusedInvite = await request('/api/auth/join', {
    method: 'POST',
    body: { name: 'Second Member', email: `reused-${suffix}@example.test`, password, code: inviteCode, passcode: invitePasscode },
  })
  assert.equal(reusedInvite.response.status, 400)
})

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill()
    await once(serverProcess, 'exit')
  }
})