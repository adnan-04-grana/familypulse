import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, Battery, Bell, Check, ChevronDown, Clock3,
  Copy, HeartPulse, Home, KeyRound, LockKeyhole, LogOut, MapPin, Menu,
  Droplets, Gauge, Pencil, Plus, Save, Search, Settings, ShieldCheck, ShieldPlus, Trash2, UserRound, UsersRound,
  Watch, X,
} from 'lucide-react'
import { divIcon } from 'leaflet'
import JsBarcode from 'jsbarcode'
import QRCode from 'qrcode'
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import {
  blankPermissions, blankProfile, emptyStore, hashPassword, makeId, makeInviteCode,
  makeInvitePasscode, makeMedicalCode, makePasswordSalt, hashInviteCredentials, PASSWORD_HASH_ITERATIONS, readStore, saveStore,
  type Account, type AppNotification, type CircleInvite, type EmergencyContact,
  type FamilyCircle, type LocalStore, type MemberPermissions,
  type SafetyEvent,
} from './store'
import './App.css'

type PageKey = 'dashboard' | 'my-health' | 'family-members' | 'join-family' | 'member-profile' | 'emergency-center' | 'live-monitoring' | 'medical-information' | 'locations' | 'emergency-history' | 'wearable-device' | 'notifications' | 'privacy-permissions' | 'family-settings' | 'emergency-contacts' | 'account-settings'
type GeoPoint = { latitude: number; longitude: number; accuracy: number; timestamp: number }
type BatteryManagerLike = EventTarget & { level: number }
type InviteDraft = { code: string; passcode: string; expiresAt: number } | null
type ProfileField = { key: keyof Account['profile']; label: string; type?: string; options?: string[]; access?: 'basic' | 'medical' | 'emergency' }

function timestampNow() { return Date.now() }
const INVITE_LIFETIME_MS = 15 * 60 * 1000

function isInviteActive(invite: CircleInvite, now = timestampNow()) {
  return typeof invite.createdAt === 'number'
    && invite.createdAt <= now
    && invite.expiresAt > now
    && invite.expiresAt <= invite.createdAt + INVITE_LIFETIME_MS
}
const SESSION_ACTIVITY_KEY = 'familypulse-session-last-active'
const SESSION_IDLE_LIMIT = 15 * 60 * 1000

type MedicalRescuePayload = {
  i: string
  n: string
  dob: string
  bt: string
  a: string
  c: string
  med: string
  doc: string
  ins: string
  en: string
  notes: string
  ec: [string, string, string][]
}

function buildMedicalPayload(account: Account): MedicalRescuePayload {
  return {
    i: account.medicalId,
    n: account.name,
    dob: account.profile.dateOfBirth || 'Not provided',
    bt: account.profile.bloodType || 'Not provided',
    a: account.profile.allergies || 'Not provided',
    c: account.profile.conditions || 'Not provided',
    med: account.profile.medications || 'Not provided',
    doc: account.profile.doctor || 'Not provided',
    ins: account.profile.insurance || 'Not provided',
    en: account.profile.emergencyNumber || 'Not provided',
    notes: account.profile.notes || 'Not provided',
    ec: account.contacts.map(({ name, relationship, phone }) => [name, relationship, phone] as [string, string, string]),
  }
}

function encodeMedicalPayload(value: string) {
  const bytes = gzipSync(strToU8(value))
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeMedicalPayload(value: string) {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return strFromU8(gunzipSync(bytes))
  } catch {
    return null
  }
}

function readMedicalRescuePayload(): MedicalRescuePayload | null {
  const prefix = '#rescue='
  if (!window.location.hash.startsWith(prefix)) return null
  try {
    const serialized = decodeMedicalPayload(window.location.hash.slice(prefix.length))
    if (!serialized) return null
    const payload: unknown = JSON.parse(serialized)
    if (!payload || typeof payload !== 'object' || typeof (payload as MedicalRescuePayload).n !== 'string' || !Array.isArray((payload as MedicalRescuePayload).ec)) return null
    return payload as MedicalRescuePayload
  } catch {
    return null
  }
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

async function lookupStreetName(point: GeoPoint) {
  const query = new URLSearchParams({ format: 'jsonv2', lat: String(point.latitude), lon: String(point.longitude), zoom: '18', addressdetails: '1' })
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${query}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('Street lookup failed.')
  const result = await response.json() as { address?: Record<string, string> }
  const address = result.address ?? {}
  const street = address.road ?? address.pedestrian ?? address.residential ?? address.footway ?? address.path
  const locality = address.suburb ?? address.neighbourhood ?? address.city_district ?? address.city ?? address.town ?? address.village
  return [street, locality].filter(Boolean).join(', ') || 'Street name unavailable'
}

const navigation: { label: string; key: PageKey; icon: typeof Home; group: string }[] = [
  { label: 'Overview', key: 'dashboard', icon: Home, group: 'YOUR SPACE' },
  { label: 'My health', key: 'my-health', icon: HeartPulse, group: 'YOUR SPACE' },
  { label: 'Family members', key: 'family-members', icon: UsersRound, group: 'FAMILY CIRCLE' },
  { label: 'Join a family', key: 'join-family', icon: KeyRound, group: 'FAMILY CIRCLE' },
  { label: 'Medical information', key: 'medical-information', icon: ShieldPlus, group: 'FAMILY CIRCLE' },
  { label: 'Emergency contacts', key: 'emergency-contacts', icon: UserRound, group: 'FAMILY CIRCLE' },
  { label: 'Emergency center', key: 'emergency-center', icon: AlertCircle, group: 'SAFETY' },
  { label: 'Live monitoring', key: 'live-monitoring', icon: Activity, group: 'SAFETY' },
  { label: 'Locations', key: 'locations', icon: MapPin, group: 'SAFETY' },
  { label: 'Emergency history', key: 'emergency-history', icon: Clock3, group: 'SAFETY' },
  { label: 'Wearable device', key: 'wearable-device', icon: Watch, group: 'SETTINGS' },
  { label: 'Privacy & permissions', key: 'privacy-permissions', icon: LockKeyhole, group: 'SETTINGS' },
  { label: 'Family settings', key: 'family-settings', icon: Settings, group: 'SETTINGS' },
  { label: 'Account settings', key: 'account-settings', icon: UserRound, group: 'SETTINGS' },
]

const pageDetails: Record<PageKey, { title: string; eyebrow: string; description: string }> = {
  dashboard: { title: 'Your family, at a glance.', eyebrow: 'FAMILY PULSE', description: 'A quieter way to look out for the people who matter.' },
  'my-health': { title: 'My health', eyebrow: 'YOUR SPACE', description: 'Your personal health information, in one private place.' },
  'family-members': { title: 'Family members', eyebrow: 'FAMILY CIRCLE', description: 'Invite people into your circle and choose what you share.' },
  'join-family': { title: 'Join a family', eyebrow: 'FAMILY CIRCLE', description: 'Join another family circle with its invite code and passcode.' },
  'member-profile': { title: 'Member profile', eyebrow: 'FAMILY CIRCLE', description: 'Health information shared with your circle.' },
  'emergency-center': { title: 'Emergency center', eyebrow: 'SAFETY', description: 'Set response preferences and manage manual safety check-ins.' },
  'live-monitoring': { title: 'Live monitoring', eyebrow: 'SAFETY', description: 'Connect a supported wearable to bring live health readings into your care view.' },
  'medical-information': { title: 'Medical information', eyebrow: 'FAMILY CIRCLE', description: 'Keep essential details organized and permission-controlled.' },
  locations: { title: 'Locations', eyebrow: 'SAFETY', description: 'Location sharing is optional and requires each person\'s consent.' },
  'emergency-history': { title: 'Emergency history', eyebrow: 'SAFETY', description: 'Review manual safety events and responses saved in this browser.' },
  'wearable-device': { title: 'Wearable device', eyebrow: 'CONNECTED CARE', description: 'The FamilyPulse wristband and sensor experience is in development.' },
  notifications: { title: 'Notifications', eyebrow: 'YOUR SPACE', description: 'Review updates generated in this browser.' },
  'privacy-permissions': { title: 'Privacy & permissions', eyebrow: 'SETTINGS', description: 'You decide what your family can see and when.' },
  'family-settings': { title: 'Family settings', eyebrow: 'SETTINGS', description: 'Shape how your Family Circle works.' },
  'emergency-contacts': { title: 'Emergency contacts', eyebrow: 'FAMILY CIRCLE', description: 'People to reach when someone may need help.' },
  'account-settings': { title: 'Account settings', eyebrow: 'SETTINGS', description: 'Manage your profile and FamilyPulse preferences.' },
}

function App() {
  const [store, setStore] = useState<LocalStore>(() => readStore())
  const [accountId, setAccountId] = useState<string | null>(() => sessionStorage.getItem('familypulse-session'))
  const [authMode, setAuthMode] = useState<'signup' | 'login' | 'join'>('signup')
  const [authError, setAuthError] = useState('')
  const [page, setPage] = useState<PageKey>('dashboard')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [circleSwitcherOpen, setCircleSwitcherOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(null)
  const [inviteModal, setInviteModal] = useState<'create' | 'join' | null>(null)
  const [contactModal, setContactModal] = useState(false)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [geoPoints, setGeoPoints] = useState<Record<string, GeoPoint>>({})
  const [geoAddresses, setGeoAddresses] = useState<Record<string, string>>({})
  const [batteryPercent, setBatteryPercent] = useState<number | null>(null)
  const [activeMemberTimes, setActiveMemberTimes] = useState<Record<string, number>>({})
  const [locationError, setLocationError] = useState('')

  useEffect(() => {
    try { saveStore(store) } catch (error) { console.warn(error instanceof Error ? error.message : 'Could not save local data.') }
  }, [store])

  useEffect(() => {
    function syncStore(event: StorageEvent) {
      if (event.key === null || event.key === 'familypulse-local-v1') setStore(readStore())
    }
    window.addEventListener('storage', syncStore)
    return () => window.removeEventListener('storage', syncStore)
  }, [])

  const account = store.accounts.find((item) => item.id === accountId) ?? null
  const circle = account ? store.circles.find((item) => item.id === account.circleId) ?? null : null
  const joinedCircles = useMemo(() => account ? store.circles.filter((item) => item.memberIds.includes(account.id)) : [], [account, store.circles])
  const circleAccounts = useMemo(() => circle ? store.accounts.filter((item) => circle.memberIds.includes(item.id)) : [], [circle, store.accounts])
  const current = pageDetails[page]
  const selectedMember = selectedMemberId ? circleAccounts.find((item) => item.id === selectedMemberId) ?? null : null
  const alerts = useMemo(() => account ? store.notifications.filter((item) => item.accountId === account.id) : [], [account, store.notifications])
  const activeAccountId = account?.id
  const isLocationSharing = account?.shareLocation
  const seenNotificationIds = useRef<Set<string> | null>(null)
  const pendingStreetLookup = useRef<{ accountId: string; point: GeoPoint } | null>(null)
  const streetLookupTimeout = useRef<number | null>(null)
  const lastStreetLookupAt = useRef(0)
  const streetLookupId = useRef(0)

  useEffect(() => {
    if (!activeAccountId) return
    const presenceKey = 'familypulse-presence-v1'
    const readPresence = () => {
      try {
        return JSON.parse(localStorage.getItem(presenceKey) ?? '{}') as Record<string, number>
      } catch {
        return {}
      }
    }
    const updatePresence = () => {
      const nextPresence = { ...readPresence(), [activeAccountId]: timestampNow() }
      try { localStorage.setItem(presenceKey, JSON.stringify(nextPresence)) } catch { /* Presence remains available in this tab. */ }
      setActiveMemberTimes(nextPresence)
    }
    const syncPresence = (event: StorageEvent) => {
      if (event.key === presenceKey) setActiveMemberTimes(readPresence())
    }
    updatePresence()
    const heartbeatId = window.setInterval(updatePresence, 30_000)
    window.addEventListener('storage', syncPresence)
    return () => {
      window.clearInterval(heartbeatId)
      window.removeEventListener('storage', syncPresence)
    }
  }, [activeAccountId])

  useEffect(() => {
    if (!account) {
      seenNotificationIds.current = null
      return
    }
    if (!seenNotificationIds.current) {
      seenNotificationIds.current = new Set(alerts.map((item) => item.id))
      return
    }
    const newAlerts = alerts.filter((item) => !seenNotificationIds.current?.has(item.id))
    newAlerts.forEach((item) => {
      seenNotificationIds.current?.add(item.id)
      notify(`New family alert: ${item.title}`)
      if ('Notification' in window && Notification.permission === 'granted') {
        const desktopAlert = new Notification(item.title, { body: item.detail })
        desktopAlert.onclick = () => {
          window.focus()
          setPage('notifications')
        }
      }
    })
  }, [account, alerts])

  useEffect(() => {
    if (!activeAccountId) return
    const browserNavigator = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }
    if (!browserNavigator.getBattery) return
    let battery: BatteryManagerLike | null = null
    let cancelled = false
    const updateBattery = () => {
      if (battery) setBatteryPercent(Math.round(battery.level * 100))
    }
    void browserNavigator.getBattery().then((manager) => {
      if (cancelled) return
      battery = manager
      updateBattery()
      manager.addEventListener('levelchange', updateBattery)
    }).catch(() => setBatteryPercent(null))
    return () => {
      cancelled = true
      battery?.removeEventListener('levelchange', updateBattery)
    }
  }, [activeAccountId])

  useEffect(() => {
    if (!activeAccountId || !isLocationSharing || !navigator.geolocation) return
    const updateLocation = (position: GeolocationPosition) => {
      setLocationError('')
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp }
      setGeoPoints((currentPoints) => ({ ...currentPoints, [activeAccountId]: point }))
      pendingStreetLookup.current = { accountId: activeAccountId, point }
      if (streetLookupTimeout.current === null) {
        const delay = Math.max(1000, 60_000 - (timestampNow() - lastStreetLookupAt.current))
        streetLookupTimeout.current = window.setTimeout(() => {
          streetLookupTimeout.current = null
          const pending = pendingStreetLookup.current
          if (!pending) return
          lastStreetLookupAt.current = timestampNow()
          const lookupId = ++streetLookupId.current
          void lookupStreetName(pending.point).then((streetName) => {
            if (lookupId === streetLookupId.current) setGeoAddresses((currentAddresses) => ({ ...currentAddresses, [pending.accountId]: streetName }))
          }).catch(() => {
            if (lookupId === streetLookupId.current) setGeoAddresses((currentAddresses) => ({ ...currentAddresses, [pending.accountId]: 'Street name unavailable' }))
          })
        }, delay)
      }
    }
    const handleLocationError = (error: GeolocationPositionError) => {
      setLocationError(error.code === error.PERMISSION_DENIED ? 'Location permission was denied. Enable browser location permission to use this feature.' : 'Could not determine your location. Check browser and device location settings.')
      if (error.code === error.PERMISSION_DENIED) {
        setGeoPoints((currentPoints) => { const next = { ...currentPoints }; delete next[activeAccountId]; return next })
        setGeoAddresses((currentAddresses) => { const next = { ...currentAddresses }; delete next[activeAccountId]; return next })
        updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === activeAccountId ? { ...item, shareLocation: false } : item) }))
      }
    }
    const options: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    const watchId = navigator.geolocation.watchPosition(updateLocation, handleLocationError, options)
    const hourlyRefreshId = window.setInterval(() => navigator.geolocation.getCurrentPosition(updateLocation, handleLocationError, options), 60 * 60 * 1000)
    return () => {
      navigator.geolocation.clearWatch(watchId)
      window.clearInterval(hourlyRefreshId)
      if (streetLookupTimeout.current !== null) window.clearTimeout(streetLookupTimeout.current)
      streetLookupTimeout.current = null
      pendingStreetLookup.current = null
      streetLookupId.current += 1
    }
  }, [activeAccountId, isLocationSharing])

  function updateStore(mutator: (current: LocalStore) => LocalStore) {
    setStore((currentStore) => mutator(currentStore))
  }
  function switchCircle(circleId: string) {
    if (!account || !joinedCircles.some((item) => item.id === circleId)) return
    updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, circleId } : item) }))
    setCircleSwitcherOpen(false)
    setPage('dashboard')
  }
  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
  }
  function handleLogout() {
    sessionStorage.removeItem('familypulse-session')
    sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
    setAccountId(null)
    setPage('dashboard')
    setSelectedMemberId(null)
    setGeoPoints({})
    setGeoAddresses({})
    setBatteryPercent(null)
  }
  useEffect(() => {
    if (!accountId) return
    let timeoutId: number
    const lockSession = () => {
      sessionStorage.removeItem('familypulse-session')
      sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
      setAccountId(null)
      setPage('dashboard')
      setSelectedMemberId(null)
      setGeoPoints({})
      setGeoAddresses({})
      setBatteryPercent(null)
    }
    const scheduleLock = () => {
      window.clearTimeout(timeoutId)
      let lastActivity = Number(sessionStorage.getItem(SESSION_ACTIVITY_KEY) ?? 0)
      if (lastActivity <= 0) {
        lastActivity = timestampNow()
        sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(lastActivity))
      }
      const remaining = SESSION_IDLE_LIMIT - (timestampNow() - lastActivity)
      timeoutId = window.setTimeout(lockSession, Math.max(0, remaining))
    }
    const recordActivity = () => {
      sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(timestampNow()))
      scheduleLock()
    }
    const lastActivity = Number(sessionStorage.getItem(SESSION_ACTIVITY_KEY) ?? 0)
    if (lastActivity > 0 && timestampNow() - lastActivity >= SESSION_IDLE_LIMIT) {
      lockSession()
      return
    }
    scheduleLock()
    window.addEventListener('pointerdown', recordActivity)
    window.addEventListener('keydown', recordActivity)
    window.addEventListener('touchstart', recordActivity)
    return () => {
      window.clearTimeout(timeoutId)
      window.removeEventListener('pointerdown', recordActivity)
      window.removeEventListener('keydown', recordActivity)
      window.removeEventListener('touchstart', recordActivity)
    }
  }, [accountId])
  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const minimumPasswordLength = authMode === 'login' ? 6 : 12
    if (!email || email.length > 254 || password.length < minimumPasswordLength || password.length > 128) {
      setAuthError(authMode === 'login' ? 'Enter a valid email and password.' : 'Use a valid email and a password between 12 and 128 characters.')
      return
    }
    if (authMode === 'signup') {
      const name = String(form.get('name') ?? '').trim()
      if (!name || name.length > 80) { setAuthError('Enter a name of 1 to 80 characters.'); return }
      if (store.accounts.some((item) => item.email === email)) { setAuthError('An account with this email already exists in this browser.'); return }
      const id = makeId('person')
      const circleId = makeId('circle')
      const salt = makePasswordSalt()
      const passwordHash = await hashPassword(password, salt)
      const newAccount: Account = { id, name, email, passwordSalt: salt, passwordHash, passwordIterations: PASSWORD_HASH_ITERATIONS, circleId, medicalId: makeMedicalCode(store.accounts.map((item) => item.medicalId)), profile: blankProfile(), profileSaved: false, permissions: blankPermissions(), contacts: [], shareLocation: false }
      const newCircle: FamilyCircle = { id: circleId, name: `${name.split(' ')[0]}'s Family Circle`, ownerId: id, memberIds: [id], escalationMinutes: 5 }
      updateStore((currentStore) => ({ ...currentStore, accounts: [...currentStore.accounts, newAccount], circles: [...currentStore.circles, newCircle] }))
      sessionStorage.setItem('familypulse-session', id)
      sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(timestampNow()))
      setAccountId(id)
      return
    }
    if (authMode === 'join') {
      const code = String(form.get('inviteCode') ?? '').trim().toUpperCase()
      const passcode = String(form.get('invitePasscode') ?? '').trim()
      const token = await hashInviteCredentials(code, passcode)
      const invite = store.invites.find((item) => isInviteActive(item) && (item.token ? item.token === token : item.code === code && item.passcode === passcode))
      if (!invite) { setAuthError('That invite code and passcode are invalid or expired.'); return }
      const name = String(form.get('name') ?? '').trim()
      if (!name || name.length > 80) { setAuthError('Enter a name of 1 to 80 characters.'); return }
      if (store.accounts.some((item) => item.email === email)) { setAuthError('An account with this email already exists in this browser.'); return }
      const id = makeId('person')
      const salt = makePasswordSalt()
      const passwordHash = await hashPassword(password, salt)
      const newAccount: Account = { id, name, email, passwordSalt: salt, passwordHash, passwordIterations: PASSWORD_HASH_ITERATIONS, circleId: invite.circleId, medicalId: makeMedicalCode(store.accounts.map((item) => item.medicalId)), profile: blankProfile(), profileSaved: false, permissions: blankPermissions(), contacts: [], shareLocation: false }
      updateStore((currentStore) => ({ ...currentStore, accounts: [...currentStore.accounts, newAccount], circles: currentStore.circles.map((item) => item.id === invite.circleId ? { ...item, memberIds: [...item.memberIds, id] } : item), invites: currentStore.invites.filter((item) => item !== invite) }))
      sessionStorage.setItem('familypulse-session', id)
      sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(timestampNow()))
      setAccountId(id)
      return
    }
    const found = store.accounts.find((item) => item.email === email)
    const passwordIterations = found?.passwordIterations ?? 120_000
    if (!found || found.passwordHash !== await hashPassword(password, found.passwordSalt, passwordIterations)) { setAuthError('No matching account in this browser. Use the same browser and profile where the account was created.'); return }
    if (passwordIterations < PASSWORD_HASH_ITERATIONS) {
      const passwordHash = await hashPassword(password, found.passwordSalt)
      updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === found.id ? { ...item, passwordHash, passwordIterations: PASSWORD_HASH_ITERATIONS } : item) }))
    }
    sessionStorage.setItem('familypulse-session', found.id)
    sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(timestampNow()))
    setAccountId(found.id)
  }
  async function createInvite() {
    if (!circle || !account) return
    const code = makeInviteCode()
    const passcode = makeInvitePasscode()
    const token = await hashInviteCredentials(code, passcode)
    const createdAt = timestampNow()
    const invite: CircleInvite = { token, createdAt, circleId: circle.id, createdBy: account.id, expiresAt: createdAt + INVITE_LIFETIME_MS }
    updateStore((currentStore) => ({ ...currentStore, invites: [...currentStore.invites, invite] }))
    setInviteDraft({ code, passcode, expiresAt: invite.expiresAt })
    setInviteModal('create')
  }
  async function joinExistingCircle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) return
    const form = new FormData(event.currentTarget)
    const code = String(form.get('inviteCode') ?? '').trim().toUpperCase()
    const passcode = String(form.get('invitePasscode') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const passwordIterations = account.passwordIterations ?? 120_000
    if (account.passwordHash !== await hashPassword(password, account.passwordSalt, passwordIterations)) {
      notify('That password does not match your account.')
      return
    }
    const token = await hashInviteCredentials(code, passcode)
    const invite = store.invites.find((item) => isInviteActive(item) && (item.token ? item.token === token : item.code === code && item.passcode === passcode))
    const targetCircle = invite ? store.circles.find((item) => item.id === invite.circleId) : null
    if (!invite || !targetCircle) {
      notify('That invite code and passcode are invalid or expired.')
      return
    }
    if (targetCircle.memberIds.includes(account.id)) {
      switchCircle(targetCircle.id)
      notify(`You are already a member of ${targetCircle.name}.`)
      return
    }
    const upgradedHash = passwordIterations < PASSWORD_HASH_ITERATIONS ? await hashPassword(password, account.passwordSalt) : account.passwordHash
    updateStore((currentStore) => ({
      ...currentStore,
      accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, circleId: targetCircle.id, passwordHash: upgradedHash, passwordIterations: PASSWORD_HASH_ITERATIONS } : item),
      circles: currentStore.circles.map((item) => item.id === targetCircle.id ? { ...item, memberIds: [...item.memberIds, account.id] } : item),
      invites: currentStore.invites.filter((item) => item !== invite),
    }))
    setCircleSwitcherOpen(false)
    setSelectedMemberId(null)
    setPage('dashboard')
    notify(`You joined ${targetCircle.name}.`)
  }
  function handleRemoveMember(memberId: string) {
    if (!circle || !account || circle.ownerId !== account.id || memberId === account.id) return
    const person = store.accounts.find((item) => item.id === memberId)
    const otherCircle = store.circles.find((item) => item.id !== circle.id && item.memberIds.includes(memberId))
    updateStore((currentStore) => ({ ...currentStore, circles: currentStore.circles.map((item) => item.id === circle.id ? { ...item, memberIds: item.memberIds.filter((id) => id !== memberId) } : item), accounts: currentStore.accounts.map((item) => item.id === memberId ? { ...item, circleId: otherCircle?.id ?? makeId('detached') } : item) }))
    setSelectedMemberId(null)
    notify(`${person?.name ?? 'Member'} has been removed from this circle.`)
  }
  function saveProfile(profile: Account['profile']) {
    if (!account) return
    updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, profile, profileSaved: true, medicalId: item.medicalId || makeMedicalCode(currentStore.accounts.map((storedAccount) => storedAccount.medicalId)) } : item) }))
  }
  function updatePermission(field: keyof MemberPermissions, checked: boolean) {
    if (!account) return
    updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, permissions: { ...item.permissions, [field]: checked } } : item) }))
  }
  function saveContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) return
    const form = new FormData(event.currentTarget)
    const contact: EmergencyContact = { id: makeId('contact'), name: String(form.get('name') ?? '').trim(), relationship: String(form.get('relationship') ?? '').trim(), phone: String(form.get('phone') ?? '').trim() }
    updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, contacts: [...item.contacts, contact] } : item) }))
    setContactModal(false)
    notify('Emergency contact saved locally.')
  }
  function toggleLocationSharing(checked: boolean) {
    if (!account) return
    if (checked && !navigator.geolocation) { setLocationError('This browser does not provide location services.'); return }
    setLocationError('')
    updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, shareLocation: checked } : item) }))
    if (!checked) { setGeoPoints((currentPoints) => { const next = { ...currentPoints }; delete next[account.id]; return next }); setGeoAddresses((currentAddresses) => { const next = { ...currentAddresses }; delete next[account.id]; return next }); notify('Location access turned off. The locally held location was removed.'); return }
    if (checked) notify('Requesting current location. OpenStreetMap receives coordinates to look up street names; they are not saved in this browser.')
  }
  function startManualSafetyEvent() {
    if (!account || !circle) return
    const joinedCircles = store.circles.filter((item) => item.memberIds.includes(account.id))
    const targetCircles = joinedCircles.length ? joinedCircles : [circle]
    const eventId = makeId('event')
    const createdAt = timestampNow()
    const events: SafetyEvent[] = targetCircles.map((item) => ({ id: eventId, circleId: item.id, memberId: account.id, createdBy: account.id, summary: 'Manual safety check-in requested', status: 'open', createdAt }))
    const recipients = new Set(targetCircles.flatMap((item) => item.memberIds))
    const detail = `${account.name} requested a check-in in ${targetCircles.map((item) => item.name).join(', ')}. Contact them directly to confirm their safety.`
    const notifications: AppNotification[] = Array.from(recipients, (targetAccountId) => ({ id: makeId('notice'), accountId: targetAccountId, title: 'Family safety check-in requested', detail, createdAt, read: false }))
    updateStore((currentStore) => ({ ...currentStore, events: [...events, ...currentStore.events], notifications: [...notifications, ...currentStore.notifications] }))
    setPage('emergency-history')
    notify(`Local alert recorded for ${recipients.size} circle member${recipients.size === 1 ? '' : 's'} across ${targetCircles.length} circle${targetCircles.length === 1 ? '' : 's'}. Other devices are not connected.`)
  }
  function updateEvent(eventId: string, status: SafetyEvent['status']) {
    if (!account) return
    updateStore((currentStore) => ({ ...currentStore, events: currentStore.events.map((item) => item.id === eventId ? { ...item, status, responseBy: status === 'responding' ? account.id : item.responseBy } : item) }))
    notify(status === 'responding' ? 'You are marked as responding.' : `Check-in marked ${status}.`)
  }
  function markNotificationsRead() {
    if (!account) return
    updateStore((currentStore) => ({ ...currentStore, notifications: currentStore.notifications.map((item) => item.accountId === account.id ? { ...item, read: true } : item) }))
  }
  function clearLocalData() {
    if (!window.confirm('Delete all FamilyPulse data stored for this browser, including accounts, profiles, invites, and history? This cannot be undone.')) return
    sessionStorage.removeItem('familypulse-session')
    sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
    localStorage.removeItem('familypulse-local-v1')
    setStore(emptyStore())
    setAccountId(null)
    setGeoPoints({})
    setGeoAddresses({})
    setPage('dashboard')
    notify('Local data deleted.')
  }

  const rescueProfile = readMedicalRescuePayload()
  if (rescueProfile) return <MedicalRescuePage profile={rescueProfile} />
  if (!account) return <AuthScreen mode={authMode} setMode={(mode) => { setAuthMode(mode); setAuthError('') }} error={authError} onSubmit={handleAuth} />

  return <main className="app-shell">
    <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><span className="brand-mark"><HeartPulse size={18} /></span><span>family<span className="brand-pulse">pulse</span></span><button className="mobile-close icon-button" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}><X size={18} /></button></div>
      <div className="circle-switcher-wrap"><button className="circle-switcher" aria-expanded={circleSwitcherOpen} onClick={() => joinedCircles.length > 1 ? setCircleSwitcherOpen((isOpen) => !isOpen) : setPage('family-settings')}><span className="circle-avatar"><UsersRound size={16} /></span><span className="circle-copy"><strong>{circle?.name ?? 'My Family Circle'}</strong><small>{circleAccounts.length} {circleAccounts.length === 1 ? 'member' : 'members'}</small></span><ChevronDown size={15} /></button>{circleSwitcherOpen && joinedCircles.length > 1 && <div className="circle-switcher-menu" role="group" aria-label="Switch family circle">{joinedCircles.map((joinedCircle) => <button key={joinedCircle.id} className={joinedCircle.id === circle?.id ? 'selected' : ''} onClick={() => switchCircle(joinedCircle.id)}><strong>{joinedCircle.name}</strong><small>{joinedCircle.memberIds.length} {joinedCircle.memberIds.length === 1 ? 'member' : 'members'}</small></button>)}</div>}</div>
      <nav className="main-nav" aria-label="Main navigation">{['YOUR SPACE', 'FAMILY CIRCLE', 'SAFETY', 'SETTINGS'].map((group) => <div className="nav-group" key={group}><p className="nav-label">{group}</p>{navigation.filter((item) => item.group === group).map(({ label, key, icon: Icon }) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => { setPage(key); setMobileNavOpen(false); setCircleSwitcherOpen(false) }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{key === 'notifications' && alerts.some((item) => !item.read) && <span className="nav-safe-dot" />}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-mini"><ShieldCheck size={17} /><div><strong>Your family circle</strong><span>Care, connected</span></div></div><button className="account-row" onClick={handleLogout}><span className="account-avatar">{account.name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{account.name}</strong><small>Sign out</small></span><LogOut size={16} /></button></div>
    </aside>
    {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
    <section className="main-panel"><header className="topbar"><button className="icon-button nav-toggle" aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((isOpen) => !isOpen)}><Menu size={20} /></button><div className="breadcrumb"><span>{circle?.name}</span><span className="breadcrumb-divider">/</span><strong>{current.title}</strong></div><div className="top-actions"><div className="session-tag"><span className="neutral-dot" />LOCAL PROFILE</div><button className="icon-button top-search" aria-label="Search" onClick={() => notify('Search is not available yet.')}><Search size={18} /></button><button className="icon-button notification-button" aria-label="Notifications" onClick={() => { setPage('notifications'); markNotificationsRead() }}><Bell size={18} />{alerts.some((item) => !item.read) && <span />}</button><button className="top-user" onClick={() => setPage('account-settings')} aria-label="Account settings"><span>{account.name.slice(0, 1).toUpperCase()}</span><ChevronDown size={14} /></button></div></header>
      <div className="content-wrap"><div className="page-heading"><div><div className="eyebrow">{current.eyebrow}</div><h1>{current.title}</h1><p>{current.description}</p></div>{page === 'dashboard' && <button className="outline-button" onClick={() => setPage('family-members')}><UsersRound size={16} />Manage circle</button>}</div>
        {page === 'dashboard' ? <Dashboard members={circleAccounts} currentId={account.id} circle={circle} events={store.events.filter((item) => item.circleId === circle?.id && item.status === 'open')} geoPoints={geoPoints} geoAddresses={geoAddresses} batteryPercent={batteryPercent} activeMemberTimes={activeMemberTimes} onAdd={() => setInviteModal('create')} onNavigate={setPage} accountName={account.name} /> : page === 'join-family' ? <JoinFamilyPage onSubmit={joinExistingCircle} /> : <PageContent page={page} account={account} circle={circle} members={circleAccounts} selectedMember={selectedMember} invite={inviteDraft} events={store.events.filter((item) => item.circleId === circle?.id)} notifications={alerts} geoPoints={geoPoints} locationError={locationError} onAdd={() => setInviteModal('create')} onJoin={() => setInviteModal('join')} onSelectMember={(id) => { setSelectedMemberId(id); setPage('member-profile') }} onRemoveMember={handleRemoveMember} onSaveProfile={saveProfile} onOpenMedical={() => setPage('medical-information')} onPermissionChange={updatePermission} onSaveContact={() => setContactModal(true)} onRemoveContact={(contactId) => updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, contacts: item.contacts.filter((contact) => contact.id !== contactId) } : item) }))} onToggleLocation={toggleLocationSharing} onStartEvent={startManualSafetyEvent} onUpdateEvent={updateEvent} onUpdateEscalation={(minutes) => circle && updateStore((currentStore) => ({ ...currentStore, circles: currentStore.circles.map((item) => item.id === circle.id ? { ...item, escalationMinutes: minutes } : item) }))} onDeleteData={clearLocalData} onNotify={notify} />}
        <div className="medical-disclaimer"><ShieldCheck size={16}/><span>Keep health details organized and coordinate manual family check-ins in one place. For urgent medical or safety concerns, contact local emergency services.</span></div>
      </div>
    </section>
    {inviteModal && <InviteDialog mode={inviteModal} invite={inviteDraft} onClose={() => setInviteModal(null)} onCreate={createInvite} onNotify={notify} />}
    {contactModal && <ContactDialog onClose={() => setContactModal(false)} onSubmit={saveContact} />}
    {toast && <div className="toast" role="status"><ShieldCheck size={16}/>{toast}</div>}
  </main>
}

function AuthScreen({ mode, setMode, error, onSubmit }: { mode: 'signup' | 'login' | 'join'; setMode: (mode: 'signup' | 'login' | 'join') => void; error: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const heading = mode === 'signup' ? 'Start your circle.' : mode === 'join' ? 'Join your family.' : 'Good to see you.'
  return <main className="auth-shell"><div className="auth-brand"><span className="brand-mark"><HeartPulse size={19}/></span><span>family<span className="brand-pulse">pulse</span></span></div><div className="auth-layout"><section className="auth-story"><div className="story-kicker"><span className="live-dot"/>A little closer, when it matters</div><h1>Care feels better<br/>when it&apos;s <em>connected.</em></h1><p>A shared space for your family&apos;s health details, safety preferences, and the people who show up for one another.</p><div className="story-note"><ShieldCheck size={18}/><span>Built around consent, privacy, and responsible care.</span></div><div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-core"><HeartPulse size={30}/></div><span className="orbit-dot dot-one"/><span className="orbit-dot dot-two"/><span className="orbit-dot dot-three"/></div></section><section className="auth-card"><div className="auth-card-top"><span className="eyebrow">WELCOME TO FAMILYPULSE</span><div className="auth-mode-toggle"><button className={mode === 'signup' ? 'selected' : ''} onClick={() => setMode('signup')}>Create account</button><button className={mode === 'login' ? 'selected' : ''} onClick={() => setMode('login')}>Sign in</button></div></div><h2>{heading}</h2><p className="auth-subtitle">{mode === 'join' ? 'Use the separate invite code and passcode shared by a family member.' : mode === 'signup' ? 'Create your account and family circle.' : 'Sign in to your account.'}</p><form className="auth-form" onSubmit={onSubmit}>{mode !== 'login' && <label>Your name<input required name="name" autoComplete="name" maxLength={80} placeholder="Your name"/></label>}{mode === 'join' && <><label>Invite code<input required name="inviteCode" autoComplete="off" placeholder="8-character code" maxLength={8}/></label><label>Invite passcode<input required name="invitePasscode" autoComplete="off" inputMode="numeric" placeholder="6-digit passcode" maxLength={6}/></label></>}<label>Email address<input required name="email" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com"/></label><label>Password<input required name="password" type="password" minLength={mode === 'login' ? 6 : 12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'login' ? 'Your password' : '12 characters minimum'}/></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="primary-button auth-submit" type="submit">{mode === 'signup' ? 'Create my account' : mode === 'join' ? 'Join family circle' : 'Sign in'}<ArrowRight size={17}/></button></form><div className="auth-shortcuts">{mode !== 'join' && <button onClick={() => setMode('join')}><KeyRound size={14}/>Have a family invite?</button>}{mode !== 'signup' && <button onClick={() => setMode('signup')}>Create a new circle</button>}</div></section></div><footer className="auth-footer"><span>FamilyPulse</span><span>Plan care together. For urgent help, contact local emergency services.</span></footer></main>
}

function Dashboard({ members, currentId, circle, events, geoPoints, geoAddresses, batteryPercent, activeMemberTimes, onAdd, onNavigate, accountName }: { members: Account[]; currentId: string; circle: FamilyCircle | null; events: SafetyEvent[]; geoPoints: Record<string, GeoPoint>; geoAddresses: Record<string, string>; batteryPercent: number | null; activeMemberTimes: Record<string, number>; onAdd: () => void; onNavigate: (page: PageKey) => void; accountName: string }) {
  return <>
    <section className="welcome-strip"><div className="welcome-copy"><span className="welcome-greeting">A GOOD DAY TO CHECK IN</span><h2>Good morning, {accountName.split(' ')[0]}.</h2><p>Your circle is ready whenever you are.</p></div><div className="welcome-art" aria-hidden="true"><div className="welcome-ring ring-a"/><div className="welcome-ring ring-b"/><div className="welcome-heart"><HeartPulse size={27}/></div><span className="welcome-spark spark-a"/><span className="welcome-spark spark-b"/></div></section>
    <section className="care-panel"><div className="care-header"><div><span className="eyebrow">CARE SNAPSHOT</span><h3>Family readiness</h3></div><button className="outline-button" onClick={() => onNavigate('family-settings')}><Settings size={14}/>Care preferences</button></div><div className="care-grid"><div className="care-stat"><strong>{members.length}</strong><span>People in the circle</span></div><div className="care-stat"><strong>{events.length ? 'Active' : 'Clear'}</strong><span>Safety status</span></div><div className="care-stat"><strong>{Math.min(3, members.length)}</strong><span>Emergency contacts</span></div><div className="care-stat"><strong>Every check-in</strong><span>Check-in rhythm</span></div></div><div className="care-checklist"><div><span className="check-pill">Ready</span><strong>Location sharing</strong><small>Consent-based and local only</small></div><div><span className="check-pill">Ready</span><strong>Medical record access</strong><small>Permissions controlled per person</small></div><div><span className="check-pill">Ready</span><strong>Escalation plan</strong><small>Manual response workflow in place</small></div></div></section>
    <CircleLiveStatus members={members} currentId={currentId} geoPoints={geoPoints} geoAddresses={geoAddresses} batteryPercent={batteryPercent} activeMemberTimes={activeMemberTimes}/>
    <div className="quick-actions"><button className="quick-action" onClick={() => onNavigate('my-health')}><HeartPulse size={15}/>Health</button><button className="quick-action" onClick={() => onNavigate('emergency-center')}><AlertCircle size={15}/>Emergency</button><button className="quick-action" onClick={() => onNavigate('emergency-contacts')}><UserRound size={15}/>Contacts</button><button className="quick-action" onClick={() => onNavigate('locations')}><MapPin size={15}/>Location</button></div>
    <section className="overview-heading"><div><h2>{circle?.name ?? 'Family overview'}</h2><p>Only the information each person permits is shown.</p></div><span className="connection-badge"><span className="neutral-dot"/>Wearables unavailable</span></section>
    <section className="member-list">{members.map((member) => <article className="member-row" key={member.id}><span className="member-avatar">{member.name.slice(0,1).toUpperCase()}</span><div className="member-info"><strong>{member.name}{member.id === currentId ? ' (you)' : ''}</strong><span>{member.id === circle?.ownerId ? 'Circle owner' : 'Circle member'} · {member.email}</span></div><span className="not-connected"><span className="neutral-dot"/>Wearable unavailable</span><button className="row-action" onClick={() => onNavigate(member.id === currentId ? 'my-health' : 'family-members')}>View<ArrowRight size={15}/></button></article>)}{circle?.ownerId === currentId && <button className="add-member-row" onClick={onAdd}><Plus size={16}/>Invite a family member with a code</button>}</section>
    <section className="dashboard-lower"><div className="lower-section"><div className="section-title-row"><div><h2>Safety at a glance</h2><p>{events.length ? 'Manual check-ins need attention.' : 'No active manual check-ins.'}</p></div><button className="subtle-link" onClick={() => onNavigate('emergency-center')}>Emergency center<ArrowRight size={15}/></button></div><div className="safety-summary"><div className="summary-icon"><ShieldCheck size={19}/></div><div><strong>{events.length ? `${events.length} open check-in${events.length === 1 ? '' : 's'}` : 'No open check-ins'}</strong><span>Automatic medical alerts are not available.</span></div><span className="safe-label">MANUAL ONLY</span></div></div><div className="lower-section device-section"><div className="section-title-row"><div><h2>Wearable connection</h2><p>Designed for care, not fitness.</p></div><Watch size={18} className="section-icon"/></div><div className="device-coming"><div className="coming-icon"><Watch size={18}/></div><div><span className="coming-label">COMING SOON</span><strong>FamilyPulse wristband</strong><span>No sensors or readings are active.</span></div><button className="arrow-button" aria-label="View wearable status" onClick={() => onNavigate('wearable-device')}><ArrowUpRight size={17}/></button></div></div></section>
  </>
}

function CircleLiveStatus({ members, currentId, geoPoints, geoAddresses, batteryPercent, activeMemberTimes }: { members: Account[]; currentId: string; geoPoints: Record<string, GeoPoint>; geoAddresses: Record<string, string>; batteryPercent: number | null; activeMemberTimes: Record<string, number> }) {
  return <section className="circle-live-panel">
    <div className="circle-live-heading"><div><span className="eyebrow">CIRCLE STATUS</span><h3>Location, battery &amp; health</h3></div><span className="circle-live-cadence"><Clock3 size={13}/>Hourly while sharing is on</span></div>
    <div className="circle-live-columns" aria-hidden="true"><span>MEMBER</span><span>STATUS</span><span>LIVE LOCATION</span><span>BATTERY</span><span>HEALTH</span></div>
    <div className="circle-live-list">{members.map((member) => {
      const isCurrentMember = member.id === currentId
      const isOnline = isCurrentMember || timestampNow() - (activeMemberTimes[member.id] ?? 0) < 90_000
      const point = member.shareLocation ? geoPoints[member.id] : undefined
      const location = point ? geoAddresses[member.id] ?? 'Finding street name...' : member.shareLocation ? isOnline ? 'Waiting for location' : 'Offline' : 'Sharing off'
      return <article className="circle-live-row" key={member.id}>
        <div className="circle-live-member"><span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><strong>{member.name}{isCurrentMember ? ' (you)' : ''}</strong></div>
        <span className={`circle-live-presence ${isOnline ? 'is-online' : 'is-offline'}`}><span/>{isOnline ? 'Active' : 'Offline'}</span>
        <div className="circle-live-value"><MapPin size={14}/><span>{location}{point && <small>Updated {new Date(point.timestamp).toLocaleTimeString()}</small>}</span></div>
        <div className="circle-live-value"><Battery size={15}/><span>{isCurrentMember && batteryPercent !== null ? `${batteryPercent}%` : 'Not shared'}</span></div>
        <div className="circle-live-value"><Activity size={14}/><span>{member.profileSaved ? 'Health profile on file' : 'No live readings'}</span></div>
      </article>
    })}</div>
    <p className="circle-live-note">OpenStreetMap receives shared coordinates to match locations to street names. Location refreshes hourly while FamilyPulse is open.</p>
  </section>
}

function JoinFamilyPage({ onSubmit }: { onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <section className="content-section join-family-section">
    <div className="privacy-callout"><KeyRound size={20}/><div><strong>Join with your existing account.</strong><span>Enter the one-time code and passcode from a circle member, then confirm your password.</span></div></div>
    <form className="join-family-form" onSubmit={onSubmit}>
      <label>Invite code<input required name="inviteCode" autoComplete="off" maxLength={8} pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}" placeholder="8-character code"/></label>
      <label>Invite passcode<input required name="invitePasscode" autoComplete="off" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" placeholder="6-digit passcode"/></label>
      <label>Confirm your account password<input required name="password" type="password" autoComplete="current-password" minLength={6} maxLength={128} placeholder="Your account password"/></label>
      <button className="primary-button" type="submit"><UsersRound size={16}/>Join family circle</button>
    </form>
    <p className="join-family-note">Invite codes expire 15 minutes after they are created and can be used once.</p>
  </section>
}

function PageContent(props: {
  page: PageKey; account: Account; circle: FamilyCircle | null; members: Account[]; selectedMember: Account | null; invite: InviteDraft;
  events: SafetyEvent[]; notifications: AppNotification[]; geoPoints: Record<string, GeoPoint>; locationError: string;
  onAdd: () => void; onJoin: () => void; onSelectMember: (id: string) => void; onRemoveMember: (id: string) => void;
  onSaveProfile: (profile: Account['profile']) => void; onPermissionChange: (field: keyof MemberPermissions, checked: boolean) => void;
  onOpenMedical: () => void;
  onSaveContact: () => void; onRemoveContact: (id: string) => void; onToggleLocation: (checked: boolean) => void;
  onStartEvent: () => void; onUpdateEvent: (id: string, status: SafetyEvent['status']) => void;
  onUpdateEscalation: (minutes: number) => void; onDeleteData: () => void; onNotify: (message: string) => void;
}) {
  const { page, account, circle, members, selectedMember, events, notifications, geoPoints, locationError } = props
  if (page === 'wearable-device' || page === 'live-monitoring') return <section className="coming-soon-panel"><div className="coming-soon-art"><div className="device-circle"><Watch size={36}/><span className="device-plus">+</span></div><span className="device-star star-left"> </span><span className="device-star star-right"> </span><span className="device-orbit"/></div><span className="coming-label">COMING SOON</span><h2>{page === 'live-monitoring' ? 'Live monitoring needs a wearable.' : 'A more thoughtful kind of wearable.'}</h2><p>No device, sensor readings, battery status, or automatic health alerts are simulated. This page remains unavailable until compatible, validated hardware exists.</p><div className="sensor-list"><span><HeartPulse size={15}/>Health sensors</span><span><Activity size={15}/>Movement tracking</span><span><MapPin size={15}/>Location sharing</span></div></section>
  if (page === 'my-health') return <MyHealthOverview account={account} onOpenMedical={props.onOpenMedical} />
  if (page === 'family-members') return <section className="content-section"><div className="section-title-row"><div><h2>Your circle</h2><p>{members.length} {members.length === 1 ? 'member' : 'members'} in this browser.</p></div><button className="primary-button" onClick={props.onAdd}><Plus size={16}/>Generate invite</button></div>
    <div className="invite-explainer"><KeyRound size={18}/><span>Any circle member can create a single-use code and passcode that expire in 15 minutes. New accounts and signed-in existing accounts can join this circle in this browser profile.</span></div>
    <div className="member-list page-member-list">{members.map((member) => <article className="member-row" key={member.id}><span className="member-avatar">{member.name.slice(0,1).toUpperCase()}</span><div className="member-info"><strong>{member.name}{member.id === account.id ? ' (you)' : ''}</strong><span>{member.id === circle?.ownerId ? 'Circle owner' : 'Circle member'} · {member.email}</span></div><span className="not-connected"><span className="neutral-dot"/>{member.id === account.id ? 'You' : 'Member'}</span><button className="row-action" onClick={() => props.onSelectMember(member.id)}>Profile<ArrowRight size={15}/></button></article>)}</div>
  </section>
  if (page === 'medical-information' || page === 'member-profile') {
    const profile = page === 'member-profile' ? selectedMember : account
    if (!profile) return <EmptyPanel title="Choose a family profile" description="Select a member from Family members to view their permitted information." icon={<UsersRound size={21}/>} action="View family members" onAction={() => props.onNotify('Open Family members from the navigation.')} />
    const ownProfile = profile.id === account.id
    const canSeePrivate = ownProfile || profile.permissions.medical
    const canSeeBasic = ownProfile || profile.permissions.basic
    const fields: ProfileField[] = [
      { key: 'dateOfBirth', label: 'Date of birth', type: 'date', access: 'basic' },
      { key: 'bloodType', label: 'Blood type', type: 'select', options: ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], access: 'basic' },
      { key: 'allergies', label: 'Allergies', type: 'textarea', access: 'medical' },
      { key: 'conditions', label: 'Medical conditions', type: 'textarea', access: 'medical' },
      { key: 'medications', label: 'Medications', type: 'textarea', access: 'medical' },
      { key: 'doctor', label: 'Doctor or clinic', access: 'basic' },
      { key: 'insurance', label: 'Insurance information', access: 'medical' },
      { key: 'emergencyNumber', label: 'Emergency contact number', type: 'tel', access: 'emergency' },
      { key: 'notes', label: 'Important medical notes', type: 'textarea', access: 'medical' },
    ]
    return <MedicalProfilePage key={`${page}-${profile.id}`} profile={profile} ownProfile={ownProfile} canSeeBasic={canSeeBasic} canSeePrivate={canSeePrivate} fields={fields} onSave={props.onSaveProfile} />
  }
  if (page === 'emergency-contacts') return <section className="content-section"><div className="section-title-row"><div><h2>Your emergency contacts</h2><p>Saved only in this browser. Calling is always a manual action.</p></div><button className="primary-button" onClick={props.onSaveContact}><Plus size={16}/>Add contact</button></div>{account.contacts.length === 0 ? <EmptyPanel title="No emergency contacts" description="Add a trusted contact name, relationship, and phone number." icon={<UserRound size={21}/>} action="Add contact" onAction={props.onSaveContact}/> : <div className="contact-list">{account.contacts.map((contact) => <div className="contact-row" key={contact.id}><span className="member-avatar"><UserRound size={16}/></span><div className="member-info"><strong>{contact.name}</strong><span>{contact.relationship}   -  {contact.phone}</span></div><a className="outline-button" href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}>Call</a><button className="icon-button" aria-label={`Remove ${contact.name}`} onClick={() => props.onRemoveContact(contact.id)}><Trash2 size={16}/></button></div>)}</div>}</section>
  if (page === 'locations') return <section className="content-section">
    <div className="map-toolbar"><div><span className="map-live-indicator"><span className={account.shareLocation && geoPoints[account.id] ? 'live-dot' : 'neutral-dot'}/>{account.shareLocation && geoPoints[account.id] ? 'LIVE FROM THIS DEVICE' : 'LOCATION NOT SHARED'}</span><span className="map-updated">{geoPoints[account.id] ? `Updated ${new Date(geoPoints[account.id].timestamp).toLocaleTimeString()}` : 'Turn on sharing to show your location'}</span></div><label className="map-consent-toggle"><span>Share my location</span><input type="checkbox" checked={account.shareLocation} onChange={(event) => props.onToggleLocation(event.target.checked)}/></label></div>
    {locationError && <div className="auth-error location-error" role="alert">{locationError}</div>}
    <div className="map-frame"><MapContainer center={geoPoints[account.id] ? [geoPoints[account.id].latitude, geoPoints[account.id].longitude] : [20, 0]} zoom={geoPoints[account.id] ? 14 : 2} scrollWheelZoom className="family-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><MapFollow point={account.shareLocation ? geoPoints[account.id] : undefined}/>{account.shareLocation && geoPoints[account.id] && <Marker position={[geoPoints[account.id].latitude, geoPoints[account.id].longitude]} icon={divIcon({ className: 'family-map-marker', html: '<span class="map-marker-pulse"></span>', iconSize: [26, 26], iconAnchor: [13, 13] })}><Popup><strong>{account.name} (you)</strong><br/>Current browser location<br/>Accuracy +/-{Math.round(geoPoints[account.id].accuracy)} m</Popup></Marker>}</MapContainer>{account.shareLocation && !geoPoints[account.id] && <div className="map-waiting"><MapPin size={17}/>Waiting for browser location permission...</div>}<button className="map-center-button" aria-label="Center map on me" disabled={!geoPoints[account.id] || !account.shareLocation} onClick={() => window.dispatchEvent(new CustomEvent('familypulse:map-center'))}><MapPin size={17}/></button><div className="map-attribution-note">Map tiles by OpenStreetMap</div></div>
    <div className="map-family-status"><div className="map-family-icon"><UsersRound size={17}/></div><div><strong>Family locations</strong><span>Live locations from other members need a secure service connecting their own phones. No member locations are fabricated or shared from this browser.</span></div><span className="permission-state">NOT CONNECTED</span></div>
    <div className="map-privacy-note"><ShieldCheck size={15}/><span>Your location is shared with OpenStreetMap for street-name lookup after consent, refreshed while FamilyPulse is open, and removed from memory when sharing is turned off or you sign out.</span></div>
  </section>
  if (page === 'emergency-center') return <section className="content-section"><div className="emergency-caution"><div className="caution-icon"><AlertCircle size={22}/></div><div><span className="eyebrow">MANUAL CHECK-INS ONLY</span><h2>Automatic medical event detection is unavailable.</h2>
    <p>You can create a manual family check-in and manage the response status below. It does not contact emergency services, dispatch help, or confirm anyone&apos;s medical condition. For urgent help, contact local emergency services now.</p></div></div><div className="manual-event-action"><div><strong>Need your family to check in?</strong><span>Create a manual request for circle members to contact you.</span></div><button className="primary-button" onClick={props.onStartEvent}><AlertCircle size={16}/>Request a check-in</button></div><div className="emergency-tools"><div><div className="tool-icon"><MapPin size={16}/></div><h3>Location readiness</h3><p>Keep one shareable family location and confirm consent before using it in a safety workflow.</p></div><div><div className="tool-icon"><UsersRound size={16}/></div><h3>Response roles</h3><p>Assign one circle owner and one backup contact to handle check-ins and escalation steps.</p></div></div><div className="settings-list"><div className="settings-row"><div><strong>Escalation reminder interval</strong><span>In-app guidance only; no calls or notifications are sent automatically.</span></div><select value={circle?.escalationMinutes ?? 5} onChange={(event) => props.onUpdateEscalation(Number(event.target.value))}><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option></select></div><div className="settings-row"><div><strong>Check-in rhythm</strong><span>Check-in updates are recorded whenever a member checks in.</span></div><span className="permission-state">EVERY CHECK-IN</span></div><div className="settings-row"><div><strong>Urgent contact guidance</strong><span>Manual events should trigger direct phone outreach, not automated dispatch.</span></div><span className="permission-state">LOCAL ONLY</span></div></div></section>
  if (page === 'emergency-history') return <section className="content-section"><div className="section-title-row"><div><h2>Manual safety history</h2><p>These are user-created check-ins, not detected medical events.</p></div></div>{events.length === 0 ? <EmptyPanel title="No check-ins in this circle" description="You can create a manual check-in from Emergency center. Nothing is generated automatically." icon={<Clock3 size={21}/>} /> : <div className="event-list">{events.map((event) => { const person = members.find((item) => item.id === event.memberId); const responder = members.find((item) => item.id === event.responseBy); return <article className="event-row" key={event.id}><span className={`event-status status-${event.status}`}>{event.status}</span><div className="event-copy"><strong>{person?.name ?? 'Circle member'} · {event.summary}</strong><span>{new Date(event.createdAt).toLocaleString()}{responder ? ` · ${responder.name} is responding` : ''}</span></div><div className="event-actions">{event.status === 'open' && event.memberId !== account.id && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'responding')}>I&apos;m responding</button>}{event.status !== 'resolved' && event.status !== 'cancelled' && event.memberId === account.id && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'cancelled')}>Cancel</button>}{event.status === 'responding' && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'resolved')}>Mark resolved</button>}</div></article> })}</div>}</section>
  if (page === 'notifications') return <section className="content-section"><div className="section-title-row"><div><h2>Browser notifications</h2><p>New alerts can appear on this device while FamilyPulse is open. Other devices need a connected push service.</p></div>{typeof Notification !== 'undefined' && Notification.permission === 'default' ? <button className="outline-button" onClick={async () => { const permission = await Notification.requestPermission(); props.onNotify(permission === 'granted' ? 'Desktop alerts enabled for this browser.' : 'Desktop alerts were not enabled. Check browser notification settings.') }}><Bell size={15}/>Enable desktop alerts</button> : <span className="permission-state">{typeof Notification === 'undefined' ? 'DESKTOP ALERTS UNAVAILABLE' : Notification.permission === 'granted' ? 'DESKTOP ALERTS ON' : 'CHECK BROWSER SETTINGS'}</span>}</div>{notifications.length === 0 ? <EmptyPanel title="You're all caught up" description="New manual check-ins created in this browser can appear here for circle members." icon={<Bell size={21}/>} /> : <div className="notice-list">{notifications.map((notification) => <article className="notice-row" key={notification.id}><span className="notice-icon"><Bell size={16}/></span><div><strong>{notification.title}</strong><span>{notification.detail}</span><time>{new Date(notification.createdAt).toLocaleString()}</time></div></article>)}</div>}</section>
  if (page === 'privacy-permissions') return <section className="content-section"><div className="privacy-callout"><LockKeyhole size={20}/><div><strong>You control each information category.</strong><span>Permission changes apply to the member who is signed in. Circle members may view shared categories in this same browser.</span></div></div><div className="permission-list">{([['basic', 'Basic information', 'Name, date of birth, blood type and clinic'], ['medical', 'Medical information', 'Allergies, conditions, medications, insurance and notes'], ['emergency', 'Emergency information', 'Emergency phone number and response details'], ['location', 'Location sharing', 'Allows consenting circle members in this browser to view your current location'] ] as [keyof MemberPermissions, string, string][]).map(([key, title, note]) => <label className="permission-row permission-control" key={key}><div><strong>{title}</strong><span>{note}</span></div><input type="checkbox" checked={account.permissions[key]} onChange={(event) => props.onPermissionChange(key, event.target.checked)}/></label>)}</div><div className="inline-note"><LockKeyhole size={14}/>Your care details and sharing preferences are managed from this browser.</div></section>
  if (page === 'family-settings') return <section className="content-section"><div className="settings-list"><div className="settings-row"><div><strong>Family Circle name</strong><span>{circle?.name}</span></div><span className="permission-state">{members.length} MEMBERS</span></div><div className="settings-row"><div><strong>Invite a member</strong><span>Create a single-use code and passcode that expire in 15 minutes. New or existing accounts can join.</span></div><button className="outline-button" onClick={props.onAdd}>Generate invite<Plus size={15}/></button></div>{circle?.ownerId === account.id && <><div className="settings-row"><div><strong>Manual reminder interval</strong><span>In-app guidance only; no calls or notifications are sent automatically.</span></div><select value={circle.escalationMinutes} onChange={(event) => props.onUpdateEscalation(Number(event.target.value))}><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option></select></div><div className="settings-row"><div><strong>Automatic emergency escalation</strong><span>Not connected; only manual check-in records are available.</span></div><span className="permission-state">NOT ACTIVE</span></div></>}{circle?.ownerId !== account.id && <div className="settings-row"><div><strong>Circle administration</strong><span>Only the circle owner can change reminder settings or remove members.</span></div><span className="permission-state">MEMBER</span></div>}</div>{circle?.ownerId === account.id && members.filter((member) => member.id !== account.id).length > 0 && <div className="settings-list"><div className="settings-heading">REMOVE MEMBERS</div>{members.filter((member) => member.id !== account.id).map((member) => <div className="settings-row" key={member.id}><div><strong>{member.name}</strong><span>Remove this account from the circle in this browser.</span></div><button className="icon-button danger-icon" aria-label={`Remove ${member.name}`} onClick={() => props.onRemoveMember(member.id)}><Trash2 size={16}/></button></div>)}</div>}</section>
  if (page === 'account-settings') return <section className="content-section"><div className="privacy-callout"><UserRound size={20}/><div><strong>{account.name}</strong><span>{account.email}</span></div></div><div className="settings-list"><div className="settings-row"><div><strong>Account preferences</strong><span>Manage your FamilyPulse profile and preferences.</span></div><span className="permission-state">ACCOUNT</span></div><div className="settings-row"><div><strong>Delete this browser&apos;s FamilyPulse data</strong><span>Removes every local account, circle, invite, profile, contact, and event.</span></div><button className="outline-button danger-button" onClick={props.onDeleteData}><Trash2 size={15}/>Delete local data</button></div></div></section>
  return <EmptyPanel title="No screen available" description="Choose another section from the navigation." icon={<CircleHelpIcon/>}/>
}

function CircleHelpIcon() { return <ShieldCheck size={21}/> }

function MyHealthOverview({ account, onOpenMedical }: { account: Account; onOpenMedical: () => void }) {
  const readings = [
    { label: 'Heart rate', value: '--', unit: 'BPM', detail: 'Live reading needs a paired wearable', icon: HeartPulse, style: 'health-metric-green' },
    { label: 'Device battery', value: '--', unit: '%', detail: 'No wearable connected', icon: Battery, style: 'health-metric-gray' },
    { label: 'Blood group', value: account.profile.bloodType || 'Not added', unit: '', detail: account.profile.bloodType ? 'From your saved medical profile' : 'Add this in Medical information', icon: Droplets, style: 'health-metric-red' },
    { label: 'Blood pressure', value: '--/--', unit: 'mmHg', detail: 'No validated monitor connected', icon: Gauge, style: 'health-metric-amber' },
  ]
  return <section className="health-overview"><div className="health-status-note"><ShieldCheck size={17}/><span>No health device is connected. Heart rate, device battery, and blood pressure are unavailable; no readings are simulated.</span></div><div className="health-metric-grid">{readings.map(({ label, value, unit, detail, icon: Icon, style }) => <article className={`health-metric ${style}`} key={label}><div className="health-metric-top"><span>{label}</span><Icon size={17}/></div><div className="health-metric-value">{value}<small>{unit}</small></div><p>{detail}</p></article>)}</div><div className="health-profile-link"><div><strong>Medical information</strong><span>{account.profileSaved ? 'Your profile is saved.' : 'Your profile has not been saved yet.'} Blood group and other details are managed there.</span></div><button className="outline-button" onClick={onOpenMedical}>{account.profileSaved ? 'View profile' : 'Add details'}<ArrowRight size={15}/></button></div><div className="inline-note"><LockKeyhole size={14}/>FamilyPulse is not measuring vital signs. Do not use this page for medical decisions.</div></section>
}

function MedicalProfilePage({ profile, ownProfile, canSeeBasic, canSeePrivate, fields, onSave }: { profile: Account; ownProfile: boolean; canSeeBasic: boolean; canSeePrivate: boolean; fields: ProfileField[]; onSave: (profile: Account['profile']) => void }) {
  const [draft, setDraft] = useState(profile.profile)
  const [editing, setEditing] = useState(ownProfile && !profile.profileSaved)
  const [medicalCard, setMedicalCard] = useState<{ qr: string; barcode: string } | null>(null)
  const canEdit = ownProfile
  const medicalPayload = JSON.stringify(buildMedicalPayload(profile))
  const rescueUrl = useMemo(() => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = `rescue=${encodeMedicalPayload(medicalPayload)}`
    return url.toString()
  }, [medicalPayload])

  useEffect(() => {
    if (!ownProfile) {
      setMedicalCard(null)
      return
    }
    let cancelled = false
    const renderCards = async () => {
      try {
        const [qr, barcode] = await Promise.all([
          QRCode.toDataURL(rescueUrl.toString(), {
            width: 280,
            margin: 4,
            color: { dark: '#173b33', light: '#ffffff' },
          }),
          new Promise<string>((resolve) => {
            const canvas = document.createElement('canvas')
            JsBarcode(canvas, profile.medicalId, {
              format: 'CODE128',
              width: 2,
              height: 94,
              displayValue: true,
              fontSize: 16,
              margin: 12,
              background: '#ffffff',
              lineColor: '#173b33',
              textMargin: 8,
            })
            resolve(canvas.toDataURL('image/png'))
          }),
        ])
        if (!cancelled) setMedicalCard({ qr, barcode })
      } catch {
        if (!cancelled) setMedicalCard({ qr: '', barcode: '' })
      }
    }
    void renderCards()
    return () => { cancelled = true }
  }, [rescueUrl, ownProfile, profile.medicalId])

  function updateField(field: keyof Account['profile'], value: string) {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  function save() {
    onSave(draft)
    setEditing(false)
  }
  function cancel() {
    setDraft(profile.profile)
    setEditing(false)
  }

  function downloadDataAsset(format: 'qr' | 'barcode', filename: string) {
    if (!medicalCard) return
    const source = format === 'qr' ? medicalCard.qr : medicalCard.barcode
    if (!source) return
    const link = document.createElement('a')
    link.href = source
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function openMedicalPdf() {
    if (!medicalCard) return
    const printWindow = window.open('', '_blank', 'width=980,height=1200')
    if (!printWindow) return
    const html = `
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>FamilyPulse Medical ID</title>
        <style>
          :root { --navy: #1c2f39; --green: #285b49; --soft: #edf5f0; --paper: #ffffff; --line: #dfe9e4; --muted: #71828a; }
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Arial, sans-serif; background: #f5f7f6; color: var(--navy); }
          .page { width: 100%; max-width: 860px; margin: 28px auto; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; box-shadow: 0 14px 36px rgba(13, 25, 23, 0.08); }
          .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; background: linear-gradient(180deg, #edf6f0 0%, #ffffff 100%); padding: 24px 28px; border-bottom: 1px solid var(--line); }
          .brand { display: flex; align-items: center; gap: 11px; font-size: 28px; font-weight: 700; color: var(--navy); }
          .brand-mark { display: inline-grid; place-items: center; width: 38px; height: 38px; margin-right: 2px; border-radius: 10px; background: #e2f0e8; color: var(--green); }
          .tag { display: inline-flex; align-items: center; justify-content: center; padding: 8px 12px; border-radius: 999px; background: #edf5f0; color: var(--green); font-size: 11px; font-weight: 700; letter-spacing: .7px; }
          .content { padding: 28px; }
          .hero { display: grid; grid-template-columns: 1.2fr .8fr; gap: 22px; }
          .panel { border: 1px solid var(--line); border-radius: 10px; padding: 18px; background: #fff; }
          .meta { display: grid; gap: 10px; }
          .meta strong { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .8px; }
          .meta h1 { margin: 0; font-size: 30px; color: var(--navy); }
          .meta p { margin: 0; color: #58706a; line-height: 1.6; }
          .code-box { display: flex; flex-direction: column; align-items: center; gap: 10px; }
          .code-box img { max-width: 100%; }
          .code-value { font-family: 'Consolas', monospace; letter-spacing: 2px; font-size: 18px; font-weight: 700; color: var(--green); }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 22px; }
          .item { border: 1px solid var(--line); border-radius: 8px; padding: 13px 14px; }
          .item span { display: block; font-size: 10px; letter-spacing: .8px; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }
          .item strong { display: block; color: var(--navy); font-size: 15px; line-height: 1.5; }
          .notes { margin-top: 22px; border: 1px solid var(--line); border-radius: 8px; padding: 15px 16px; background: #f9fbfa; }
          .notes h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
          .notes p { margin: 0; color: var(--navy); line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div class="brand"><span class="brand-mark">❤</span>family<span style="color: var(--green);">pulse</span></div>
            <span class="tag">MEDICAL ID</span>
          </div>
          <div class="content">
            <div class="hero">
              <div class="panel meta">
                <strong>Emergency profile</strong>
                <h1>${escapeHtml(profile.name)}</h1>
                <p><strong>Email:</strong> ${escapeHtml(profile.email)}<br/><strong>Medical ID:</strong> ${escapeHtml(profile.medicalId)}</p>
              </div>
              <div class="panel code-box">
                <img src="${medicalCard.qr}" alt="QR code" />
                <div class="code-value">${escapeHtml(profile.medicalId)}</div>
              </div>
            </div>
            <div class="grid">
              <div class="item"><span>Date of birth</span><strong>${escapeHtml(profile.profile.dateOfBirth || 'Not provided')}</strong></div>
              <div class="item"><span>Blood type</span><strong>${escapeHtml(profile.profile.bloodType || 'Not provided')}</strong></div>
              <div class="item"><span>Allergies</span><strong>${escapeHtml(profile.profile.allergies || 'Not provided')}</strong></div>
              <div class="item"><span>Conditions</span><strong>${escapeHtml(profile.profile.conditions || 'Not provided')}</strong></div>
              <div class="item"><span>Medications</span><strong>${escapeHtml(profile.profile.medications || 'Not provided')}</strong></div>
              <div class="item"><span>Doctor / clinic</span><strong>${escapeHtml(profile.profile.doctor || 'Not provided')}</strong></div>
              <div class="item"><span>Insurance</span><strong>${escapeHtml(profile.profile.insurance || 'Not provided')}</strong></div>
              <div class="item"><span>Emergency number</span><strong>${escapeHtml(profile.profile.emergencyNumber || 'Not provided')}</strong></div>
            </div>
            <div class="notes"><h3>Barcode</h3><img src="${medicalCard.barcode}" alt="Barcode" style="max-width: 100%; height: auto; display: block; margin-top: 8px;" /></div>
            <div class="notes"><h3>Medical notes</h3><p>${escapeHtml(profile.profile.notes || 'No additional medical notes have been saved.')}</p></div>
          </div>
        </div>
      </body>
      </html>
    `
    printWindow.document.write(html)
    printWindow.document.close()
    setTimeout(() => { try { printWindow.focus(); printWindow.print() } catch { /* no-op */ } }, 300)
  }

  return <section className={`content-section medical-profile-page ${editing ? 'is-editing' : 'is-saved'}`}>
    <div className="profile-page-heading"><div className="privacy-callout"><ShieldCheck size={20}/><div><strong>{ownProfile ? editing ? 'Edit your medical information.' : 'Your medical information is saved.' : `Information shared by ${profile.name}.`}</strong><span>{ownProfile ? editing ? 'Changes stay as a draft until you press Save.' : 'This read-only view shows the details currently saved in your browser.' : 'Only categories this member chose to share are visible.'}</span></div></div>{canEdit && !editing && <button className="outline-button" onClick={() => setEditing(true)}>Edit profile<Pencil size={14}/></button>}</div>
    {ownProfile && ((medicalCard && medicalCard.qr && medicalCard.barcode) || editing) && <div className="medical-identity-card"><div className="medical-identity-header"><div><span className="eyebrow">PERSONAL MEDICAL ID</span><h3>{profile.medicalId}</h3></div><button className="outline-button" onClick={openMedicalPdf}>Open PDF</button></div><div className="medical-identity-body"><div className="medical-identity-qr"><img src={medicalCard?.qr || ''} alt="Medical QR code" /></div><div className="medical-identity-code"><span>Unique medical ID</span><strong>{profile.medicalId}</strong><img src={medicalCard?.barcode || ''} alt="Medical barcode" /></div></div><div className="medical-identity-actions"><button className="outline-button" onClick={() => downloadDataAsset('qr', `${profile.name.toLowerCase().replace(/\s+/g, '-')}-medical-qr.png`)}>Download QR</button><button className="outline-button" onClick={() => downloadDataAsset('barcode', `${profile.name.toLowerCase().replace(/\s+/g, '-')}-medical-barcode.png`)}>Download barcode</button></div><p>Created once for this account and updated automatically when your medical information changes.</p></div>}
    {editing ? <div className="profile-form-grid">{fields.map((field) => <label className={field.type === 'textarea' ? 'wide-field' : ''} key={field.key}>{field.label}{field.type === 'select' ? <select value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)}>{field.options?.map((option) => <option key={option} value={option}>{option || 'Select blood type'}</option>)}</select> : field.type === 'textarea' ? <textarea rows={3} maxLength={2000} value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)} placeholder="Add only what you choose to store"/> : <input type={field.type ?? 'text'} maxLength={field.type === 'date' ? undefined : 120} value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)} placeholder="Not added"/>}</label>)}</div> : <div className="saved-profile-grid">{fields.map((field) => { const visible = ownProfile || (field.access === 'basic' ? canSeeBasic : field.access === 'medical' ? canSeePrivate : profile.permissions.emergency); return <div className="saved-profile-item" key={field.key}><span>{field.label}</span><strong>{!visible ? 'Not shared' : profile.profile[field.key] || 'Not provided'}</strong></div> })}</div>}
    {ownProfile && editing && <div className="profile-form-actions"><span className="inline-note"><LockKeyhole size={14}/>Changes save to your FamilyPulse profile.</span><div><button className="outline-button" onClick={cancel}>Cancel</button><button className="primary-button" onClick={save}><Save size={15}/>Save medical information</button></div></div>}
  </section>
}

function MedicalRescuePage({ profile }: { profile: MedicalRescuePayload }) {
  const details = [
    ['Date of birth', profile.dob],
    ['Blood type', profile.bt],
    ['Allergies', profile.a],
    ['Medical conditions', profile.c],
    ['Medications', profile.med],
    ['Doctor or clinic', profile.doc],
    ['Insurance', profile.ins],
    ['Emergency number', profile.en],
    ['Medical notes', profile.notes],
  ]

  return <main className="medical-rescue-page">
    <header className="medical-rescue-header">
      <div className="medical-rescue-brand"><span className="brand-mark"><HeartPulse size={18}/></span><span>family<span className="brand-pulse">pulse</span></span></div>
      <span className="tag">RESCUE MEDICAL ID</span>
    </header>
    <div className="medical-rescue-alert"><AlertCircle size={19}/><div><strong>Emergency medical profile</strong><span>For urgent help, contact local emergency services.</span></div></div>
    <section className="medical-rescue-identity"><span className="eyebrow">PERSON</span><h1>{profile.n}</h1><p>Medical ID <code>{profile.i}</code></p></section>
    <section className="medical-rescue-details" aria-label="Medical information">
      {details.map(([label, value]) => <div className="medical-rescue-detail" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className="medical-rescue-contacts"><h2>Emergency contacts</h2>{profile.ec.length ? <div>{profile.ec.map(([name, relationship, phone], index) => <article key={`${phone}-${index}`}><strong>{name}</strong><span>{relationship}</span><a href={`tel:${phone.replace(/[^+\d]/g, '')}`}>{phone}</a></article>)}</div> : <p>No emergency contacts provided.</p>}</section>
    <footer className="medical-rescue-footer">FamilyPulse · Information shared by the profile owner</footer>
  </main>
}

function MapFollow({ point }: { point?: GeoPoint }) {
  const map = useMap()
  const latitude = point?.latitude
  const longitude = point?.longitude
  useEffect(() => {
    const container = map.getContainer()
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false, debounceMoveend: true }))
    resizeObserver.observe(container)
    map.invalidateSize({ pan: false })
    return () => resizeObserver.disconnect()
  }, [map])
  useEffect(() => {
    if (latitude !== undefined && longitude !== undefined) map.setView([latitude, longitude], Math.max(map.getZoom(), 14), { animate: true })
  }, [map, latitude, longitude])
  useEffect(() => {
    const center = () => {
      if (latitude !== undefined && longitude !== undefined) map.flyTo([latitude, longitude], Math.max(map.getZoom(), 14))
    }
    window.addEventListener('familypulse:map-center', center)
    return () => window.removeEventListener('familypulse:map-center', center)
  }, [map, latitude, longitude])
  return null
}

function EmptyPanel({ title, description, icon, action, onAction }: { title: string; description: string; icon: React.ReactNode; action?: string; onAction?: () => void }) {
  return <div className="empty-panel"><div className="empty-panel-icon">{icon}</div><h2>{title}</h2><p>{description}</p>{action && onAction && <button className="outline-button" onClick={onAction}>{action}<ArrowRight size={15}/></button>}</div>
}

function InviteDialog({ mode, invite, onClose, onCreate, onNotify }: { mode: 'create' | 'join'; invite: InviteDraft; onClose: () => void; onCreate: () => void; onNotify: (message: string) => void }) {
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); onNotify('Copied to clipboard.') } catch { onNotify('Clipboard access is unavailable. Select and copy the value manually.') } }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="member-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title"><div className="modal-heading"><div><span className="eyebrow">FAMILY CIRCLE</span><h2 id="invite-title">{mode === 'create' ? 'Invite a family member' : 'Join with an invite'}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18}/></button></div><p>Invitations work only within this browser profile. No email or link is sent.</p>{mode === 'create' ? invite ? <div className="invite-credentials"><label>Invite code<div className="credential-value"><code>{invite.code}</code><button className="icon-button" aria-label="Copy invite code" onClick={() => copy(invite.code)}><Copy size={15}/></button></div></label><label>Separate passcode<div className="credential-value"><code>{invite.passcode}</code><button className="icon-button" aria-label="Copy passcode" onClick={() => copy(invite.passcode)}><Copy size={15}/></button></div></label><div className="inline-note"><Clock3 size={14}/>Expires {new Date(invite.expiresAt).toLocaleString()}. The first account to use both values joins this circle.</div><button className="primary-button invite-done" onClick={onClose}><Check size={16}/>Done</button></div> : <div className="modal-actions"><button className="outline-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={onCreate}><KeyRound size={16}/>Generate credentials</button></div> : <div className="invite-instructions"><p>Sign out, then choose  Have a family invite?  on the sign-in page. Create the new member account there using both values.</p><button className="outline-button" onClick={onClose}>Got it</button></div>}</section></div>
}

function ContactDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="member-modal" role="dialog" aria-modal="true" aria-labelledby="contact-title"><div className="modal-heading"><div><span className="eyebrow">EMERGENCY CONTACTS</span><h2 id="contact-title">Add a contact</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18}/></button></div><p>Stored locally. This does not alert or call the contact automatically.</p><form onSubmit={onSubmit}><label>Full name<input required name="name" autoFocus maxLength={80} placeholder="Contact name"/></label><label>Relationship<input required name="relationship" maxLength={60} placeholder="e.g. Neighbor, caregiver"/></label><label>Phone number<input required name="phone" type="tel" autoComplete="tel" maxLength={32} placeholder="+1 555 000 0000"/></label><div className="modal-actions"><button className="outline-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><Plus size={16}/>Save contact</button></div></form></section></div>
}

export default App
