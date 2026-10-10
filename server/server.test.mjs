import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, test } from 'node:test'
import webPush from 'web-push'
import 'dotenv/config'

let serverProcess
let apiBase
let ownerCookie
let memberCookie
let ownerId
let serverOutput = ''

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

async function waitForEmailToken(purpose) {
  const marker = `Local ${purpose} link for `
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const start = serverOutput.lastIndexOf(marker)
    if (start >= 0) {
      const end = serverOutput.indexOf('\n', start)
      const line = serverOutput.slice(start, end < 0 ? serverOutput.length : end)
      const urlStart = line.indexOf(': ', marker.length)
      if (urlStart >= 0) {
        const token = new URL(line.slice(urlStart + 2)).searchParams.get(purpose)
        if (token) return token
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`No ${purpose} link was logged by the test API.`)
}

test('API persists accounts and enforces circle permissions and invite use', async (context) => {
  const port = await availablePort()
  const vapidKeys = webPush.generateVAPIDKeys()
  apiBase = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      NODE_ENV: 'test',
      REQUIRE_EMAIL_VERIFICATION: 'true',
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverOutput = ''
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
  assert.equal(ownerSignup.response.status, 202)
  assert.equal(ownerSignup.data.requiresVerification, true)
  const ownerVerification = await request('/api/auth/verify-email', {
    method: 'POST', body: { token: await waitForEmailToken('verify-email') },
  })
  assert.equal(ownerVerification.response.status, 200)
  assert.ok(ownerVerification.setCookie)
  ownerCookie = ownerVerification.setCookie
  ownerId = ownerVerification.data.accountId
  assert.equal(ownerVerification.data.store.accounts[0].passwordHash, '')

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
  assert.equal(memberSignup.response.status, 202)
  const memberVerification = await request('/api/auth/verify-email', {
    method: 'POST', body: { token: await waitForEmailToken('verify-email') },
  })
  assert.equal(memberVerification.response.status, 200)
  memberCookie = memberVerification.setCookie
  const hiddenOwner = memberVerification.data.store.accounts.find((account) => account.id === ownerId)
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

  const pushConfig = await request('/api/push/config')
  assert.equal(pushConfig.data.publicKey, vapidKeys.publicKey)
  const endpoint = `https://push.example.test/${suffix}`
  const subscription = await request('/api/push/subscription', {
    method: 'POST',
    cookie: memberCookie,
    body: { endpoint, keys: { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') } },
  })
  assert.equal(subscription.response.status, 200)
  const removedSubscription = await request('/api/push/subscription', {
    method: 'DELETE', cookie: memberCookie, body: { endpoint },
  })
  assert.equal(removedSubscription.response.status, 200)

  const reusedInvite = await request('/api/auth/join', {
    method: 'POST',
    body: { name: 'Second Member', email: `reused-${suffix}@example.test`, password, code: inviteCode, passcode: invitePasscode },
  })
  assert.equal(reusedInvite.response.status, 400)

  const resetRequest = await request('/api/auth/forgot-password', {
    method: 'POST', body: { email: `owner-${suffix}@example.test` },
  })
  assert.equal(resetRequest.response.status, 200)
  assert.match(resetRequest.data.message, /If the account exists/)
  const resetToken = await waitForEmailToken('reset-password')
  const resetPassword = `FamilyPulse-Reset-${randomUUID()}!`
  const resetResult = await request('/api/auth/reset-password', {
    method: 'POST', body: { token: resetToken, password: resetPassword },
  })
  assert.equal(resetResult.response.status, 200)
  assert.equal((await request('/api/state', { cookie: ownerCookie })).response.status, 401)
  const ownerLogin = await request('/api/auth/login', {
    method: 'POST', body: { email: `owner-${suffix}@example.test`, password: resetPassword },
  })
  assert.equal(ownerLogin.response.status, 200)
  ownerCookie = ownerLogin.setCookie
  const reusedResetToken = await request('/api/auth/reset-password', {
    method: 'POST', body: { token: resetToken, password },
  })
  assert.equal(reusedResetToken.response.status, 400)
})

test('production server serves the SPA with security headers on the platform port', async (context) => {
  const port = await availablePort()
  const vapidKeys = webPush.generateVAPIDKeys()
  const productionProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      APP_BASE_URL: 'https://familypulse.example.test',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'false',
      SMTP_USER: 'test-user',
      SMTP_PASS: 'test-password',
      SMTP_FROM: 'FamilyPulse <noreply@example.test>',
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  productionProcess.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  productionProcess.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  context.after(async () => {
    productionProcess.kill()
    if (productionProcess.exitCode === null) await once(productionProcess, 'exit')
  })

  const origin = `http://127.0.0.1:${port}`
  let ready = false
  const startupDeadline = Date.now() + 20_000
  while (Date.now() < startupDeadline && !ready) {
    if (productionProcess.exitCode !== null) throw new Error(`Production API process exited during startup: ${output}`)
    try {
      ready = (await fetch(`${origin}/api/health`)).ok
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  assert.equal(ready, true, `Production API failed to start: ${output}`)

  const home = await fetch(origin)
  assert.equal(home.status, 200)
  assert.match(await home.text(), /FamilyPulse \| Connected family care/)
  assert.ok(home.headers.get('content-security-policy'))
  assert.ok(home.headers.get('permissions-policy'))
  assert.ok(home.headers.get('strict-transport-security'))
})

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill()
    await once(serverProcess, 'exit')
  }
})