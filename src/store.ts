export type MedicalProfile = {
  dateOfBirth: string
  bloodType: string
  allergies: string
  conditions: string
  medications: string
  doctor: string
  insurance: string
  notes: string
  emergencyNumber: string
}

export type MemberPermissions = {
  basic: boolean
  medical: boolean
  emergency: boolean
  location: boolean
}

export type EmergencyContact = {
  id: string
  name: string
  relationship: string
  phone: string
}

export type Account = {
  id: string
  name: string
  email: string
  passwordSalt: string
  passwordHash: string
  passwordIterations?: number
  circleId: string
  profile: MedicalProfile
  profileSaved?: boolean
  permissions: MemberPermissions
  contacts: EmergencyContact[]
  shareLocation: boolean
}

export type FamilyCircle = {
  id: string
  name: string
  ownerId: string
  memberIds: string[]
  escalationMinutes: number
}

export type CircleInvite = {
  token?: string
  code?: string
  passcode?: string
  createdAt?: number
  circleId: string
  createdBy: string
  expiresAt: number
}

export type SafetyEvent = {
  id: string
  circleId: string
  memberId: string
  createdBy: string
  summary: string
  status: 'open' | 'responding' | 'resolved' | 'cancelled'
  createdAt: number
  responseBy?: string
}

export type AppNotification = {
  id: string
  accountId: string
  title: string
  detail: string
  createdAt: number
  read: boolean
}

export type LocalStore = {
  accounts: Account[]
  circles: FamilyCircle[]
  invites: CircleInvite[]
  events: SafetyEvent[]
  notifications: AppNotification[]
}

const STORAGE_KEY = 'familypulse-local-v1'

export function emptyStore(): LocalStore {
  return { accounts: [], circles: [], invites: [], events: [], notifications: [] }
}

export function readStore(): LocalStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyStore()
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return emptyStore()
    const store = value as Partial<LocalStore>
    return {
      accounts: Array.isArray(store.accounts) ? store.accounts : [],
      circles: Array.isArray(store.circles) ? store.circles : [],
      invites: Array.isArray(store.invites) ? store.invites : [],
      events: Array.isArray(store.events) ? store.events : [],
      notifications: Array.isArray(store.notifications) ? store.notifications : [],
    }
  } catch {
    return emptyStore()
  }
}

export function saveStore(store: LocalStore) {
  try {
    if (store.accounts.length === 0) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    throw new Error('Browser storage is unavailable or full. Export or clear local app data to continue.')
  }
}

export function makeId(prefix: string) {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function makeInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

export function makeInvitePasscode() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return String(((((bytes[0] * 256 + bytes[1]) * 256 + bytes[2]) * 256 + bytes[3]) >>> 0) % 1000000).padStart(6, '0')
}

export function makePasswordSalt() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const PASSWORD_HASH_ITERATIONS = 600_000

export async function hashPassword(password: string, salt: string, iterations = PASSWORD_HASH_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, material, 256)
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashInviteCredentials(code: string, passcode: string) {
  const secret = new TextEncoder().encode(`familypulse-invite-v1:${code.trim().toUpperCase()}:${passcode.trim()}`)
  const digest = await crypto.subtle.digest('SHA-256', secret)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function blankProfile(): MedicalProfile {
  return {
    dateOfBirth: '',
    bloodType: '',
    allergies: '',
    conditions: '',
    medications: '',
    doctor: '',
    insurance: '',
    notes: '',
    emergencyNumber: '',
  }
}

export function blankPermissions(): MemberPermissions {
  return { basic: false, medical: false, emergency: false, location: false }
}
