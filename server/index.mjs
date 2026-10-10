import { createHash, randomBytes, timingSafeEqual, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import nodemailer from 'nodemailer'
import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg
const app = express()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_USER && process.env.SMTP_PASS)
const mailer = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null
const requireVerifiedEmail = process.env.NODE_ENV === 'production' || process.env.REQUIRE_EMAIL_VERIFICATION === 'true' || smtpConfigured
const sessionCookie = 'familypulse_session'
const inviteLifetimeMs = 15 * 60 * 1000
const passwordIterations = 600_000
const medicalAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const profileKeys = ['dateOfBirth', 'bloodType', 'allergies', 'conditions', 'medications', 'doctor', 'insurance', 'notes', 'emergencyNumber']
const permissionKeys = ['basic', 'medical', 'emergency', 'location']

function makeId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

function makeMedicalId() {
  const bytes = randomBytes(32)
  return Array.from(bytes, (byte) => medicalAlphabet[byte & 31]).join('')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function hashPassword(password, salt, iterations = passwordIterations) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256)
  return Buffer.from(bits).toString('hex')
}

async function matchesPassword(password, account) {
  const candidate = Buffer.from(await hashPassword(password, account.password_salt, account.password_iterations))
  const saved = Buffer.from(account.password_hash)
  return candidate.length === saved.length && timingSafeEqual(candidate, saved)
}

function readCookie(request, name) {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=')
    if (separator >= 0 && cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim())
  }
  return null
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900${secure}`)
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`)
}

async function createSession(client, accountId, response) {
  const token = randomBytes(32).toString('base64url')
  await client.query('INSERT INTO sessions (token_hash, account_id) VALUES ($1, $2)', [sha256(token), accountId])
  setSessionCookie(response, token)
}

async function issueEmailToken(client, accountId, purpose, lifetimeMs) {
  const token = randomBytes(32).toString('base64url')
  await client.query('UPDATE email_tokens SET consumed_at = now() WHERE account_id = $1 AND purpose = $2 AND consumed_at IS NULL', [accountId, purpose])
  await client.query(
    'INSERT INTO email_tokens (token_hash, account_id, purpose, expires_at) VALUES ($1, $2, $3, now() + $4 * interval \'1 millisecond\')',
    [sha256(token), accountId, purpose, lifetimeMs],
  )
  return token
}

async function sendAccountLink(email, purpose, token) {
  const parameter = purpose === 'verify-email' ? 'verify-email' : 'reset-password'
  const url = new URL('/', process.env.APP_BASE_URL ?? 'http://localhost:5173')
  url.searchParams.set(parameter, token)
  const subject = purpose === 'verify-email' ? 'Verify your FamilyPulse email' : 'Reset your FamilyPulse password'
  const instruction = purpose === 'verify-email' ? 'verify your email address' : 'choose a new password'
  const text = `Use this link to ${instruction}: ${url.toString()}\n\nIf you did not request this, you can ignore this message.`
  if (!mailer) {
    console.info(`Local ${purpose} link for ${email}: ${url.toString()}`)
    return
  }
  await mailer.sendMail({ from: process.env.SMTP_FROM, to: email, subject, text })
}

function fail(response, status, message) {
  response.status(status).json({ error: message })
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many account attempts. Try again in a few minutes.' },
})

function validText(value, maximum = 4000) {
  return typeof value === 'string' && value.length <= maximum
}

async function transaction(work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function insertAccount(client, { name, email, password }, activeCircleId = null) {
  const id = makeId('person')
  const salt = randomBytes(16).toString('hex')
  const passwordHash = await hashPassword(password, salt)
  const medicalId = makeMedicalId()
  await client.query(
    `INSERT INTO accounts (id, name, email, password_salt, password_hash, password_iterations, medical_id, active_circle_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, name, email, salt, passwordHash, passwordIterations, medicalId, activeCircleId],
  )
  return { id, medicalId }
}

function filterProfile(profile, permissions, own) {
  if (own) return Object.fromEntries(profileKeys.map((key) => [key, profile[key] ?? '']))
  const allowed = new Set()
  if (permissions.basic) ['dateOfBirth', 'bloodType', 'doctor'].forEach((key) => allowed.add(key))
  if (permissions.medical) ['allergies', 'conditions', 'medications', 'insurance', 'notes'].forEach((key) => allowed.add(key))
  if (permissions.emergency) allowed.add('emergencyNumber')
  return Object.fromEntries(profileKeys.map((key) => [key, allowed.has(key) ? profile[key] ?? '' : '']))
}

async function getState(accountId) {
  const { rows: [current] } = await pool.query('SELECT * FROM accounts WHERE id = $1', [accountId])
  if (!current) return null
  const { rows: circles } = await pool.query(
    `SELECT c.id, c.name, c.owner_id AS "ownerId", c.escalation_minutes AS "escalationMinutes",
            array_agg(cm.account_id ORDER BY cm.joined_at) AS "memberIds"
     FROM circles c JOIN circle_members cm ON cm.circle_id = c.id
     WHERE c.id IN (SELECT circle_id FROM circle_members WHERE account_id = $1)
     GROUP BY c.id ORDER BY c.created_at`,
    [accountId],
  )
  const memberIds = [...new Set([accountId, ...circles.flatMap((circle) => circle.memberIds)])]
  const { rows: accountRows } = memberIds.length
    ? await pool.query(
      `SELECT a.*, EXISTS (SELECT 1 FROM circle_members cm WHERE cm.account_id = a.id AND cm.circle_id = $2) AS in_active_circle
       FROM accounts a WHERE a.id = ANY($1::text[]) ORDER BY a.created_at`,
      [memberIds, current.active_circle_id],
    )
    : { rows: [] }
  const { rows: events } = circles.length
    ? await pool.query(
      `SELECT id, circle_id AS "circleId", member_id AS "memberId", created_by AS "createdBy", summary, status,
              created_at AS "createdAt", response_by AS "responseBy"
       FROM safety_events WHERE circle_id = ANY($1::text[]) ORDER BY created_at DESC`,
      [circles.map((circle) => circle.id)],
    )
    : { rows: [] }
  const { rows: notifications } = await pool.query(
    `SELECT id, account_id AS "accountId", title, detail, created_at AS "createdAt", read
     FROM notifications WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId],
  )
  const visibleLocations = circles.length
    ? await pool.query(
      `SELECT l.account_id AS "accountId", l.latitude, l.longitude, l.accuracy, l.updated_at AS timestamp
       FROM locations l JOIN accounts a ON a.id = l.account_id
       WHERE l.expires_at > now() AND l.account_id = ANY($1::text[])
         AND (l.account_id = $2 OR (a.share_location AND a.permissions->>'location' = 'true'))`,
      [memberIds, accountId],
    )
    : { rows: [] }
  const { rows: presenceRows } = memberIds.length
    ? await pool.query(
      `SELECT account_id AS "accountId", EXTRACT(EPOCH FROM max(last_seen_at)) * 1000 AS "lastSeenAt"
       FROM sessions WHERE account_id = ANY($1::text[]) AND last_seen_at > now() - interval '90 seconds'
       GROUP BY account_id`,
      [memberIds],
    )
    : { rows: [] }

  return {
    accountId,
    store: {
      accounts: accountRows.map((item) => {
        const permissions = item.permissions
        const own = item.id === accountId
        return {
          id: item.id,
          name: item.name,
          email: own || permissions.basic ? item.email : '',
          passwordSalt: '',
          passwordHash: '',
          passwordIterations: item.password_iterations,
          circleId: own ? current.active_circle_id : (item.in_active_circle ? current.active_circle_id : circles.find((circle) => circle.memberIds.includes(item.id))?.id ?? ''),
          medicalId: own ? item.medical_id : '',
          profile: filterProfile(item.profile, permissions, own),
          profileSaved: item.profile_saved,
          permissions,
          contacts: own ? item.contacts : [],
          shareLocation: item.share_location,
        }
      }),
      circles,
      invites: [],
      events,
      notifications,
    locations: visibleLocations.rows,
    presence: presenceRows.map((item) => ({ accountId: item.accountId, lastSeenAt: Number(item.lastSeenAt) })),
  }
}

app.disable('x-powered-by')
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'", "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
}))
app.use((_request, response, next) => {
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)')
  next()
})
app.use(express.json({ limit: '32kb' }))
app.use(async (request, response, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.get('origin')
    const requestHost = request.get('x-forwarded-host') ?? request.get('host')
    if (origin && new URL(origin).host !== requestHost) return fail(response, 403, 'Cross-origin request denied.')
  }
  next()
})

app.get('/api/health', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1')
    response.json({ ok: true })
  } catch (error) { next(error) }
})

app.post('/api/auth/signup', authLimiter, async (request, response, next) => {
  try {
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : ''
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const password = request.body.password
    if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return fail(response, 400, 'Enter a valid name, email, and password between 12 and 128 characters.')
    }
    const registration = await transaction(async (client) => {
      const { id } = await insertAccount(client, { name, email, password })
      const circleId = makeId('circle')
      await client.query('INSERT INTO circles (id, name, owner_id) VALUES ($1, $2, $3)', [circleId, `${name.split(' ')[0]}'s Family Circle`, id])
      await client.query('INSERT INTO circle_members (circle_id, account_id) VALUES ($1, $2)', [circleId, id])
      await client.query('UPDATE accounts SET active_circle_id = $1 WHERE id = $2', [circleId, id])
      if (requireVerifiedEmail) {
        const token = await issueEmailToken(client, id, 'verify-email', 24 * 60 * 60 * 1000)
        return { accountId: id, token }
      }
      await client.query('UPDATE accounts SET email_verified = TRUE WHERE id = $1', [id])
      await createSession(client, id, response)
      return { accountId: id, token: null }
    })
    if (registration.token) {
      await sendAccountLink(email, 'verify-email', registration.token)
      return response.status(202).json({ requiresVerification: true })
    }
    response.json(await getState(registration.accountId))
  } catch (error) { next(error) }
})

app.post('/api/auth/login', authLimiter, async (request, response, next) => {
  try {
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const password = request.body.password
    if (!email || typeof password !== 'string' || password.length > 128) return fail(response, 400, 'Enter a valid email and password.')
    const { rows: [account] } = await pool.query('SELECT * FROM accounts WHERE email = $1', [email])
    if (!account || !await matchesPassword(password, account)) return fail(response, 401, 'No matching account was found. Check your email and password.')
    if (requireVerifiedEmail && !account.email_verified) return fail(response, 403, 'Verify your email before signing in. You can request another verification link.')
    await transaction((client) => createSession(client, account.id, response))
    response.json(await getState(account.id))
  } catch (error) { next(error) }
})

app.post('/api/auth/verify-email', authLimiter, async (request, response, next) => {
  try {
    const token = request.body.token
    if (typeof token !== 'string' || token.length > 128) return fail(response, 400, 'That verification link is invalid or expired.')
    const accountId = await transaction(async (client) => {
      const { rows: [emailToken] } = await client.query(
        `SELECT account_id FROM email_tokens WHERE token_hash = $1 AND purpose = 'verify-email'
         AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(token)],
      )
      if (!emailToken) throw Object.assign(new Error('That verification link is invalid or expired.'), { status: 400 })
      await client.query('UPDATE email_tokens SET consumed_at = now() WHERE token_hash = $1', [sha256(token)])
      await client.query('UPDATE accounts SET email_verified = TRUE WHERE id = $1', [emailToken.account_id])
      await createSession(client, emailToken.account_id, response)
      return emailToken.account_id
    })
    response.json(await getState(accountId))
  } catch (error) { next(error) }
})

app.post('/api/auth/resend-verification', authLimiter, async (request, response, next) => {
  try {
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    if (email && email.length <= 254) {
      const { rows: [account] } = await pool.query('SELECT id FROM accounts WHERE email = $1 AND email_verified = FALSE', [email])
      if (account) {
        const token = await transaction((client) => issueEmailToken(client, account.id, 'verify-email', 24 * 60 * 60 * 1000))
        await sendAccountLink(email, 'verify-email', token)
      }
    }
    response.json({ ok: true, message: 'If the account needs verification, a link has been sent.' })
  } catch (error) { next(error) }
})

app.post('/api/auth/forgot-password', authLimiter, async (request, response, next) => {
  try {
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    if (email && email.length <= 254) {
      const { rows: [account] } = await pool.query('SELECT id FROM accounts WHERE email = $1 AND email_verified = TRUE', [email])
      if (account) {
        const token = await transaction((client) => issueEmailToken(client, account.id, 'reset-password', 30 * 60 * 1000))
        await sendAccountLink(email, 'reset-password', token)
      }
    }
    response.json({ ok: true, message: 'If the account exists, a password reset link has been sent.' })
  } catch (error) { next(error) }
})

app.post('/api/auth/reset-password', authLimiter, async (request, response, next) => {
  try {
    const { token, password } = request.body
    if (typeof token !== 'string' || token.length > 128 || typeof password !== 'string' || password.length < 12 || password.length > 128) return fail(response, 400, 'Use a valid reset link and a password between 12 and 128 characters.')
    await transaction(async (client) => {
      const { rows: [emailToken] } = await client.query(
        `SELECT account_id FROM email_tokens WHERE token_hash = $1 AND purpose = 'reset-password'
         AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha256(token)],
      )
      if (!emailToken) throw Object.assign(new Error('That password reset link is invalid or expired.'), { status: 400 })
      const salt = randomBytes(16).toString('hex')
      const passwordHash = await hashPassword(password, salt)
      await client.query('UPDATE accounts SET password_salt = $1, password_hash = $2, password_iterations = $3 WHERE id = $4', [salt, passwordHash, passwordIterations, emailToken.account_id])
      await client.query('UPDATE email_tokens SET consumed_at = now() WHERE token_hash = $1', [sha256(token)])
      await client.query('DELETE FROM sessions WHERE account_id = $1', [emailToken.account_id])
    })
    response.json({ ok: true })
  } catch (error) { next(error) }
})

app.post('/api/auth/join', authLimiter, async (request, response, next) => {
  try {
    const { name, email, password, code, passcode } = request.body
    const cleanName = typeof name === 'string' ? name.trim() : ''
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!cleanName || cleanName.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128 || typeof code !== 'string' || typeof passcode !== 'string') {
      return fail(response, 400, 'Enter a valid name, email, password, and invite credentials.')
    }
    const inviteHash = sha256(`familypulse-invite-v1:${code.trim().toUpperCase()}:${passcode.trim()}`)
    const accountId = await transaction(async (client) => {
      const { rows: [invite] } = await client.query(
        `SELECT * FROM invites WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
         AND created_at <= $2 AND expires_at <= created_at + $3 FOR UPDATE`,
        [inviteHash, Date.now(), inviteLifetimeMs],
      )
      if (!invite) throw Object.assign(new Error('That invite code and passcode are invalid or expired.'), { status: 400 })
      const { id } = await insertAccount(client, { name: cleanName, email: cleanEmail, password }, invite.circle_id)
      await client.query('INSERT INTO circle_members (circle_id, account_id) VALUES ($1, $2)', [invite.circle_id, id])
      await client.query('UPDATE invites SET consumed_at = now() WHERE id = $1', [invite.id])
      if (requireVerifiedEmail) {
        const token = await issueEmailToken(client, id, 'verify-email', 24 * 60 * 60 * 1000)
        return { accountId: id, token }
      }
      await client.query('UPDATE accounts SET email_verified = TRUE WHERE id = $1', [id])
      await createSession(client, id, response)
      return { accountId: id, token: null }
    })
      if (accountId.token) {
        await sendAccountLink(cleanEmail, 'verify-email', accountId.token)
      return response.status(202).json({ requiresVerification: true })
    }
      response.json(await getState(accountId.accountId))
  } catch (error) { next(error) }
})

app.use('/api', async (request, response, next) => {
  try {
    const token = readCookie(request, sessionCookie)
    if (!token) return fail(response, 401, 'Sign in to continue.')
    const tokenHash = sha256(token)
    const { rows: [session] } = await pool.query(
      `UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1
       AND last_seen_at > now() - interval '15 minutes' RETURNING account_id`,
      [tokenHash],
    )
    if (!session) {
      clearSessionCookie(response)
      return fail(response, 401, 'Your session expired. Sign in again.')
    }
    setSessionCookie(response, token)
    request.accountId = session.account_id
    next()
  } catch (error) { next(error) }
})

app.get('/api/state', async (request, response, next) => {
  try {
    const state = await getState(request.accountId)
    if (!state) return fail(response, 401, 'Account no longer exists.')
    response.json(state)
  } catch (error) { next(error) }
})

app.post('/api/auth/logout', async (request, response, next) => {
  try {
    const token = readCookie(request, sessionCookie)
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)])
    clearSessionCookie(response)
    response.json({ ok: true })
  } catch (error) { next(error) }
})

app.post('/api/actions', async (request, response, next) => {
  try {
    const { type, payload = {} } = request.body
    const accountId = request.accountId
    await transaction(async (client) => {
      const { rows: [account] } = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId])
      if (!account) throw Object.assign(new Error('Account no longer exists.'), { status: 401 })
      if (type === 'update-profile') {
        if (!payload.profile || typeof payload.profile !== 'object' || profileKeys.some((key) => !validText(payload.profile[key] ?? '', key === 'notes' ? 8000 : 2000))) throw Object.assign(new Error('Medical profile contains invalid values.'), { status: 400 })
        await client.query('UPDATE accounts SET profile = $1, profile_saved = TRUE WHERE id = $2', [payload.profile, accountId])
      } else if (type === 'update-permission') {
        if (!permissionKeys.includes(payload.field) || typeof payload.checked !== 'boolean') throw Object.assign(new Error('Invalid permission update.'), { status: 400 })
        const permissions = { ...account.permissions, [payload.field]: payload.checked }
        await client.query('UPDATE accounts SET permissions = $1 WHERE id = $2', [permissions, accountId])
        if (payload.field === 'location' && !payload.checked) await client.query('DELETE FROM locations WHERE account_id = $1', [accountId])
      } else if (type === 'add-contact') {
        const { name, relationship, phone } = payload.contact ?? {}
        if (![name, relationship, phone].every((value) => validText(value, 120)) || !name.trim() || !phone.trim()) throw Object.assign(new Error('Enter a valid emergency contact.'), { status: 400 })
        await client.query('UPDATE accounts SET contacts = contacts || $1::jsonb WHERE id = $2', [JSON.stringify([{ id: makeId('contact'), name: name.trim(), relationship: relationship.trim(), phone: phone.trim() }]), accountId])
      } else if (type === 'remove-contact') {
        await client.query(
          `UPDATE accounts SET contacts = COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(contacts) item WHERE item->>'id' <> $1), '[]'::jsonb) WHERE id = $2`,
          [payload.contactId, accountId],
        )
      } else if (type === 'set-location-sharing') {
        if (typeof payload.checked !== 'boolean') throw Object.assign(new Error('Invalid location setting.'), { status: 400 })
        await client.query('UPDATE accounts SET share_location = $1 WHERE id = $2', [payload.checked, accountId])
        if (!payload.checked) await client.query('DELETE FROM locations WHERE account_id = $1', [accountId])
      } else if (type === 'create-invite') {
        const { tokenHash, createdAt, expiresAt, circleId } = payload
        const { rowCount } = await client.query('SELECT 1 FROM circle_members WHERE circle_id = $1 AND account_id = $2', [circleId, accountId])
        const now = Date.now()
        if (!rowCount || typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) || createdAt < now - 30_000 || createdAt > now || expiresAt !== createdAt + inviteLifetimeMs) throw Object.assign(new Error('Could not create that invitation.'), { status: 400 })
        await client.query('INSERT INTO invites (id, token_hash, circle_id, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [makeId('invite'), tokenHash, circleId, accountId, createdAt, expiresAt])
      } else if (type === 'join-circle') {
        const { code, passcode, password } = payload
        if (typeof code !== 'string' || typeof passcode !== 'string' || typeof password !== 'string' || !await matchesPassword(password, account)) throw Object.assign(new Error('That password or invite is invalid.'), { status: 400 })
        const tokenHash = sha256(`familypulse-invite-v1:${code.trim().toUpperCase()}:${passcode.trim()}`)
        const { rows: [invite] } = await client.query('SELECT * FROM invites WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2 AND expires_at <= created_at + $3 FOR UPDATE', [tokenHash, Date.now(), inviteLifetimeMs])
        if (!invite) throw Object.assign(new Error('That invite code and passcode are invalid or expired.'), { status: 400 })
        await client.query('INSERT INTO circle_members (circle_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [invite.circle_id, accountId])
        await client.query('UPDATE accounts SET active_circle_id = $1 WHERE id = $2', [invite.circle_id, accountId])
        await client.query('UPDATE invites SET consumed_at = now() WHERE id = $1', [invite.id])
      } else if (type === 'switch-circle') {
        const { rowCount } = await client.query('SELECT 1 FROM circle_members WHERE circle_id = $1 AND account_id = $2', [payload.circleId, accountId])
        if (!rowCount) throw Object.assign(new Error('You are not a member of that circle.'), { status: 403 })
        await client.query('UPDATE accounts SET active_circle_id = $1 WHERE id = $2', [payload.circleId, accountId])
      } else if (type === 'remove-member') {
        const { rows: [circle] } = await client.query('SELECT c.id FROM circles c JOIN circle_members cm ON cm.circle_id = c.id WHERE c.id = $1 AND c.owner_id = $2 AND cm.account_id = $3', [payload.circleId, accountId, payload.memberId])
        if (!circle || payload.memberId === accountId) throw Object.assign(new Error('Only the circle owner can remove another member.'), { status: 403 })
        await client.query('DELETE FROM circle_members WHERE circle_id = $1 AND account_id = $2', [circle.id, payload.memberId])
        await client.query('UPDATE accounts SET active_circle_id = (SELECT circle_id FROM circle_members WHERE account_id = $1 ORDER BY joined_at LIMIT 1) WHERE id = $1 AND active_circle_id = $2', [payload.memberId, circle.id])
      } else if (type === 'update-escalation') {
        if (![2, 5, 10, 15].includes(payload.minutes)) throw Object.assign(new Error('Invalid reminder interval.'), { status: 400 })
        const { rowCount } = await client.query('UPDATE circles SET escalation_minutes = $1 WHERE id = $2 AND owner_id = $3', [payload.minutes, payload.circleId, accountId])
        if (!rowCount) throw Object.assign(new Error('Only the circle owner can change its reminder interval.'), { status: 403 })
      } else if (type === 'start-event') {
        const { rows: circles } = await client.query('SELECT c.id, c.name FROM circles c JOIN circle_members cm ON cm.circle_id = c.id WHERE cm.account_id = $1', [accountId])
        const { rows: recipients } = await client.query('SELECT DISTINCT account_id FROM circle_members WHERE circle_id = ANY($1::text[])', [circles.map((circle) => circle.id)])
        const eventId = makeId('event')
        const createdAt = Date.now()
        const detail = `${account.name} requested a check-in in ${circles.map((circle) => circle.name).join(', ')}. Contact them directly to confirm their safety.`
        for (const circle of circles) await client.query('INSERT INTO safety_events (id, circle_id, member_id, created_by, summary, status, created_at) VALUES ($1, $2, $3, $3, $4, $5, $6)', [eventId, circle.id, accountId, 'Manual safety check-in requested', 'open', createdAt])
        for (const recipient of recipients) await client.query('INSERT INTO notifications (id, account_id, title, detail, created_at) VALUES ($1, $2, $3, $4, $5)', [makeId('notice'), recipient.account_id, 'Family safety check-in requested', detail, createdAt])
      } else if (type === 'update-event') {
        if (!['responding', 'resolved', 'cancelled'].includes(payload.status)) throw Object.assign(new Error('Invalid check-in status.'), { status: 400 })
        const { rows: [event] } = await client.query('SELECT e.* FROM safety_events e JOIN circle_members cm ON cm.circle_id = e.circle_id AND cm.account_id = $2 WHERE e.id = $1 FOR UPDATE', [payload.eventId, accountId])
        if (!event) throw Object.assign(new Error('Check-in not found.'), { status: 404 })
        const allowed = payload.status === 'responding' ? event.member_id !== accountId && event.status === 'open' : payload.status === 'cancelled' ? event.member_id === accountId && event.status !== 'resolved' : event.member_id === accountId || event.response_by === accountId
        if (!allowed) throw Object.assign(new Error('You cannot change this check-in.'), { status: 403 })
        await client.query('UPDATE safety_events SET status = $1, response_by = CASE WHEN $1 = \'responding\' THEN $2 ELSE response_by END WHERE id = $3 AND circle_id = $4', [payload.status, accountId, event.id, event.circle_id])
      } else if (type === 'mark-notifications-read') {
        await client.query('UPDATE notifications SET read = TRUE WHERE account_id = $1', [accountId])
      } else if (type === 'delete-account') {
        await client.query('DELETE FROM accounts WHERE id = $1', [accountId])
      } else {
        throw Object.assign(new Error('Unknown action.'), { status: 400 })
      }
    })
    if (type === 'delete-account') {
      const token = readCookie(request, sessionCookie)
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)])
      clearSessionCookie(response)
      return response.json({ ok: true })
    }
    response.json(await getState(accountId))
  } catch (error) { next(error) }
})

app.put('/api/location', async (request, response, next) => {
  try {
    const { latitude, longitude, accuracy, timestamp } = request.body
    if (![latitude, longitude, accuracy, timestamp].every(Number.isFinite) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || accuracy < 0 || Math.abs(Date.now() - timestamp) > 60_000) return fail(response, 400, 'Invalid location update.')
    const { rowCount } = await pool.query('SELECT 1 FROM accounts WHERE id = $1 AND share_location = TRUE', [request.accountId])
    if (!rowCount) return fail(response, 403, 'Enable location sharing before sending a location.')
    await pool.query(
      `INSERT INTO locations (account_id, latitude, longitude, accuracy, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')
       ON CONFLICT (account_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       accuracy = EXCLUDED.accuracy, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`,
      [request.accountId, latitude, longitude, accuracy, timestamp],
    )
    response.json({ ok: true })
  } catch (error) { next(error) }
})

app.use(express.static(resolve(root, 'dist'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }))
app.get(/^(?!\/api(?:\/|$)).*/, (_request, response, next) => {
  response.sendFile(resolve(root, 'dist/index.html'), (error) => {
    if (error) next(error)
  })
})

app.use((error, _request, response, _next) => {
  if (error.code === '23505') return fail(response, 409, 'An account with this email already exists.')
  if (error.code === '23503') return fail(response, 400, 'That family circle could not be found.')
  console.error(error)
  fail(response, error.status ?? 500, error.status ? error.message : 'The request could not be completed.')
})

const schema = await readFile(resolve(root, 'server/schema.sql'), 'utf8')
if (process.env.NODE_ENV === 'production') {
  const requiredEnvironment = ['DATABASE_URL', 'APP_BASE_URL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
  const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name])
  if (missingEnvironment.length) throw new Error(`Missing required production configuration: ${missingEnvironment.join(', ')}`)
  if (new URL(process.env.APP_BASE_URL).protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS in production.')
}
await pool.query(schema)
await pool.query('DELETE FROM locations WHERE expires_at <= now()')
const locationCleanup = setInterval(() => {
  void pool.query('DELETE FROM locations WHERE expires_at <= now()').catch((error) => console.error('Location cleanup failed.', error))
}, 60_000)
locationCleanup.unref()
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'
app.listen(port, host, () => console.log(`FamilyPulse API listening on http://${host}:${port}`))