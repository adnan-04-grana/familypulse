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
import medicalDocumentStyles from './medical-document.css?inline'
import {
  emptyStore, makeInviteCode, makeInvitePasscode, hashInviteCredentials,
  type Account, type AppNotification,
  type FamilyCircle, type LocalStore, type MemberPermissions,
  type SafetyEvent,
} from './store'
import './App.css'
import './medical-document.css'

type PageKey = 'dashboard' | 'my-health' | 'family-members' | 'join-family' | 'member-profile' | 'emergency-center' | 'live-monitoring' | 'medical-information' | 'locations' | 'emergency-history' | 'wearable-device' | 'notifications' | 'privacy-permissions' | 'family-settings' | 'emergency-contacts' | 'account-settings'
type AuthMode = 'signup' | 'login' | 'join' | 'forgot' | 'reset' | 'resend-verification'
type GeoPoint = { latitude: number; longitude: number; accuracy: number; timestamp: number }
type BatteryManagerLike = EventTarget & { level: number }
type InviteDraft = { code: string; passcode: string; expiresAt: number } | null
type ProfileField = { key: keyof Account['profile']; label: string; type?: string; options?: string[]; access?: 'basic' | 'medical' | 'emergency' }
type ApiState = { accountId: string; store: LocalStore; locations: (GeoPoint & { accountId: string })[]; presence: { accountId: string; lastSeenAt: number }[] }

function timestampNow() { return Date.now() }
const INVITE_LIFETIME_MS = 15 * 60 * 1000

async function apiRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? 'The FamilyPulse service could not complete this request.')
  return result
}

function decodeApplicationServerKey(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}
const SESSION_ACTIVITY_KEY = 'familypulse-session-last-active'
const SESSION_IDLE_LIMIT = 15 * 60 * 1000

type MedicalRescuePayload = {
  i: string
  n: string
  e?: string
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
    e: account.email,
    dob: account.profile.dateOfBirth || 'Not provided',
    bt: account.profile.bloodType || 'Not provided',
    a: account.profile.allergies || 'Not provided',
    c: account.profile.conditions || 'Not provided',
    med: account.profile.medications || 'Not provided',
    doc: account.profile.doctor || 'Not provided',
    ins: account.profile.insurance || 'Not provided',
    en: account.profile.emergencyNumber || 'Not provided',
    notes: account.profile.notes || 'No additional medical notes have been saved.',
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

function generateMedicalCard(rescueUrl: string, medicalId: string) {
  const qrOptions = {
    width: 280,
    margin: 4,
    color: { dark: '#173b33', light: '#ffffff' },
    errorCorrectionLevel: 'M' as const,
  }

  return Promise.all([
    QRCode.toDataURL(rescueUrl, qrOptions).catch(() => QRCode.toDataURL(medicalId, qrOptions)),
    new Promise<string>((resolve, reject) => {
      const canvas = document.createElement('canvas')
      try {
        JsBarcode(canvas, medicalId || 'FAMILYPULSE', {
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
      } catch (error) {
        reject(error)
      }
    }),
  ]).then(([qr, barcode]) => ({ qr, barcode }))
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
    'emergency-history': { title: 'Emergency history', eyebrow: 'SAFETY', description: 'Review manual safety events and responses shared with your circle.' },
  'wearable-device': { title: 'Wearable device', eyebrow: 'CONNECTED CARE', description: 'The FamilyPulse wristband and sensor experience is in development.' },
  notifications: { title: 'Notifications', eyebrow: 'YOUR SPACE', description: 'Review updates from your family circle.' },
  'privacy-permissions': { title: 'Privacy & permissions', eyebrow: 'SETTINGS', description: 'You decide what your family can see and when.' },
  'family-settings': { title: 'Family settings', eyebrow: 'SETTINGS', description: 'Shape how your Family Circle works.' },
  'emergency-contacts': { title: 'Emergency contacts', eyebrow: 'FAMILY CIRCLE', description: 'People to reach when someone may need help.' },
  'account-settings': { title: 'Account settings', eyebrow: 'SETTINGS', description: 'Manage your profile and FamilyPulse preferences.' },
}

function App() {
  const [store, setStore] = useState<LocalStore>(() => emptyStore())
  const [accountId, setAccountId] = useState<string | null>(() => sessionStorage.getItem('familypulse-session'))
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [authMode, setAuthMode] = useState<AuthMode>(() => new URLSearchParams(window.location.search).has('reset-password') ? 'reset' : 'signup')
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

  function applyRemoteState(remote: ApiState) {
    setStore(remote.store)
    setAccountId(remote.accountId)
    sessionStorage.setItem('familypulse-session', remote.accountId)
    const locations = remote.locations.map((point) => ({ ...point, timestamp: Number(point.timestamp) }))
    setGeoPoints(Object.fromEntries(locations.map((point) => [point.accountId, point])))
    setGeoAddresses(Object.fromEntries(locations.map((point) => [point.accountId, 'Location shared'])))
    setActiveMemberTimes(Object.fromEntries(remote.presence.map((item) => [item.accountId, item.lastSeenAt])))
  }

  async function refreshRemoteState() {
    const remote = await apiRequest<ApiState>('/api/state')
    applyRemoteState(remote)
  }

  async function syncPushSubscription() {
    if (!('serviceWorker' in navigator) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const { publicKey } = await apiRequest<{ publicKey: string | null }>('/api/push/config')
    if (!publicKey) return
    const registration = await navigator.serviceWorker.register('/sw.js')
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeApplicationServerKey(publicKey) })
    await apiRequest('/api/push/subscription', subscription.toJSON())
  }

  async function performAction(type: string, payload: Record<string, unknown> = {}) {
    try {
      const remote = await apiRequest<ApiState | { ok: true }>('/api/actions', { type, payload })
      if (type !== 'delete-account') applyRemoteState(remote as ApiState)
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The change could not be saved.')
      return false
    }
  }

  function updateStore(mutator: (current: LocalStore) => LocalStore) {
    const updated = mutator(store)
    const changedCircle = updated.circles.find((item) => store.circles.find((currentCircle) => currentCircle.id === item.id)?.escalationMinutes !== item.escalationMinutes)
    if (changedCircle) void performAction('update-escalation', { circleId: changedCircle.id, minutes: changedCircle.escalationMinutes })
    const currentContacts = store.accounts.find((item) => item.id === accountId)?.contacts ?? []
    const updatedContacts = updated.accounts.find((item) => item.id === accountId)?.contacts ?? []
    const removedContact = currentContacts.find((contact) => !updatedContacts.some((item) => item.id === contact.id))
    if (removedContact) void performAction('remove-contact', { contactId: removedContact.id })
  }

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      const url = new URL(window.location.href)
      const verificationToken = url.searchParams.get('verify-email')
      const resetToken = url.searchParams.get('reset-password')
      if (resetToken) {
        sessionStorage.removeItem('familypulse-session')
        setAccountId(null)
        setStore(emptyStore())
        setAuthMode('reset')
        setIsBootstrapping(false)
        return
      }
      if (verificationToken) {
        try {
          const remote = await apiRequest<ApiState>('/api/auth/verify-email', { token: verificationToken })
          if (cancelled) return
          applyRemoteState(remote)
          setAuthError('Email verified. Your account is ready.')
          url.searchParams.delete('verify-email')
          window.history.replaceState({}, '', url)
        } catch (error) {
          if (!cancelled) {
            setAuthMode('login')
            setAuthError(error instanceof Error ? error.message : 'That verification link is invalid or expired.')
          }
        }
      } else {
        try {
          const remote = await apiRequest<ApiState>('/api/state')
          if (!cancelled) applyRemoteState(remote)
        } catch {
          if (cancelled) return
          sessionStorage.removeItem('familypulse-session')
          sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
          setAccountId(null)
          setStore(emptyStore())
        }
      }
      if (!cancelled) setIsBootstrapping(false)
    }
    void bootstrap()
    return () => { cancelled = true }
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
    const heartbeatId = window.setInterval(() => { void refreshRemoteState().catch(() => undefined) }, 15_000)
    return () => {
      window.clearInterval(heartbeatId)
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
      void apiRequest('/api/location', point, 'PUT').catch(() => setLocationError('Location could not be shared with your family service.'))
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
        void performAction('set-location-sharing', { checked: false })
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

  function switchCircle(circleId: string) {
    if (!account || !joinedCircles.some((item) => item.id === circleId)) return
    void performAction('switch-circle', { circleId })
    setCircleSwitcherOpen(false)
    setPage('dashboard')
  }
  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3200)
    if (message === 'Desktop alerts enabled for this browser.') void syncPushSubscription().catch(() => undefined)
  }
  function handleLogout() {
    void apiRequest('/api/auth/logout', {}).catch(() => undefined)
    sessionStorage.removeItem('familypulse-session')
    sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
    setAccountId(null)
    setStore(emptyStore())
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
      void apiRequest('/api/auth/logout', {}).catch(() => undefined)
      sessionStorage.removeItem('familypulse-session')
      sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
      setAccountId(null)
      setStore(emptyStore())
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
    if (authMode === 'forgot' || authMode === 'resend-verification') {
      if (!email || email.length > 254) {
        setAuthError('Enter the email address for your account.')
        return
      }
      const endpoint = authMode === 'forgot' ? '/api/auth/forgot-password' : '/api/auth/resend-verification'
      try {
        const result = await apiRequest<{ message: string }>(endpoint, { email })
        setAuthError(result.message)
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'The request could not be completed.')
      }
      return
    }
    if (authMode === 'reset') {
      const token = new URLSearchParams(window.location.search).get('reset-password')
      if (!token || password.length < 12 || password.length > 128) {
        setAuthError('Use a valid reset link and a password between 12 and 128 characters.')
        return
      }
      try {
        await apiRequest<{ ok: true }>('/api/auth/reset-password', { token, password })
        const url = new URL(window.location.href)
        url.searchParams.delete('reset-password')
        window.history.replaceState({}, '', url)
        setAuthMode('login')
        setAuthError('Password reset. Sign in with your new password.')
      } catch (error) {
        setAuthError(error instanceof Error ? error.message : 'That reset link is invalid or expired.')
      }
      return
    }
    const minimumPasswordLength = authMode === 'login' ? 6 : 12
    if (!email || email.length > 254 || password.length < minimumPasswordLength || password.length > 128) {
      setAuthError(authMode === 'login' ? 'Enter a valid email and password.' : 'Use a valid email and a password between 12 and 128 characters.')
      return
    }
    const endpoint = authMode === 'signup' ? '/api/auth/signup' : authMode === 'join' ? '/api/auth/join' : '/api/auth/login'
    const payload: Record<string, string> = { email, password }
    if (authMode !== 'login') payload.name = String(form.get('name') ?? '').trim()
    if (authMode === 'join') {
      payload.code = String(form.get('inviteCode') ?? '').trim().toUpperCase()
      payload.passcode = String(form.get('invitePasscode') ?? '').trim()
    }
    try {
      const remote = await apiRequest<ApiState | { requiresVerification: true }>(endpoint, payload)
      if ('requiresVerification' in remote) {
        setAuthMode('login')
        setAuthError('Account created. Check your email for a verification link before signing in.')
        return
      }
      applyRemoteState(remote)
      sessionStorage.setItem(SESSION_ACTIVITY_KEY, String(timestampNow()))
      setPage('dashboard')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'The account request could not be completed.')
    }
  }
  async function createInvite() {
    if (!circle || !account) return
    const code = makeInviteCode()
    const passcode = makeInvitePasscode()
    const token = await hashInviteCredentials(code, passcode)
    const createdAt = timestampNow()
    const expiresAt = createdAt + INVITE_LIFETIME_MS
    if (await performAction('create-invite', { tokenHash: token, createdAt, expiresAt, circleId: circle.id })) {
      setInviteDraft({ code, passcode, expiresAt })
      setInviteModal('create')
    }
  }
  async function joinExistingCircle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) return
    const form = new FormData(event.currentTarget)
    const code = String(form.get('inviteCode') ?? '').trim().toUpperCase()
    const passcode = String(form.get('invitePasscode') ?? '').trim()
    const password = String(form.get('password') ?? '')
    if (!await performAction('join-circle', { code, passcode, password })) return
    setCircleSwitcherOpen(false)
    setSelectedMemberId(null)
    setPage('dashboard')
    notify('You joined the family circle.')
  }
  function handleRemoveMember(memberId: string) {
    if (!circle || !account || circle.ownerId !== account.id || memberId === account.id) return
    const person = store.accounts.find((item) => item.id === memberId)
    void performAction('remove-member', { circleId: circle.id, memberId })
    setSelectedMemberId(null)
    notify(`${person?.name ?? 'Member'} has been removed from this circle.`)
  }
  function saveProfile(profile: Account['profile']) {
    if (!account) return
    void performAction('update-profile', { profile })
  }
  function updatePermission(field: keyof MemberPermissions, checked: boolean) {
    if (!account) return
    void performAction('update-permission', { field, checked })
  }
  function saveContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) return
    const form = new FormData(event.currentTarget)
    const contact = { name: String(form.get('name') ?? '').trim(), relationship: String(form.get('relationship') ?? '').trim(), phone: String(form.get('phone') ?? '').trim() }
    void performAction('add-contact', { contact }).then((saved) => {
      if (!saved) return
      setContactModal(false)
      notify('Emergency contact saved to your account.')
    })
  }
  function toggleLocationSharing(checked: boolean) {
    if (!account) return
    if (checked && !navigator.geolocation) { setLocationError('This browser does not provide location services.'); return }
    setLocationError('')
    void performAction('set-location-sharing', { checked }).then((saved) => {
      if (!saved) return
      if (!checked) {
        setGeoPoints((currentPoints) => { const next = { ...currentPoints }; delete next[account.id]; return next })
        setGeoAddresses((currentAddresses) => { const next = { ...currentAddresses }; delete next[account.id]; return next })
        notify('Location sharing is off and your saved location was removed.')
      } else notify('Location sharing is on. Your coordinates remain for up to one hour and are visible only with location permission.')
    })
  }
  function startManualSafetyEvent() {
    if (!account || !circle) return
    void performAction('start-event').then((saved) => {
      if (!saved) return
      setPage('emergency-history')
      notify('Manual check-in saved and shared with your family circle.')
    })
  }
  function updateEvent(eventId: string, status: SafetyEvent['status']) {
    if (!account) return
    void performAction('update-event', { eventId, status }).then((saved) => {
      if (saved) notify(status === 'responding' ? 'You are marked as responding.' : `Check-in marked ${status}.`)
    })
  }
  function markNotificationsRead() {
    if (!account) return
    void performAction('mark-notifications-read')
  }
  function clearLocalData() {
    if (!window.confirm('Permanently delete your FamilyPulse account and personal data? This cannot be undone.')) return
    void performAction('delete-account').then((deleted) => {
      if (!deleted) return
      sessionStorage.removeItem('familypulse-session')
      sessionStorage.removeItem(SESSION_ACTIVITY_KEY)
      setStore(emptyStore())
      setAccountId(null)
      setGeoPoints({})
      setGeoAddresses({})
      setPage('dashboard')
      notify('Your account and personal data were deleted.')
    })
  }

  const rescueProfile = readMedicalRescuePayload()
  if (rescueProfile) return <MedicalRescuePage profile={rescueProfile} />
  if (isBootstrapping) return <main className="auth-shell"><div className="auth-brand"><span className="brand-mark"><HeartPulse size={19}/></span><span>family<span className="brand-pulse">pulse</span></span></div><p>Connecting to your FamilyPulse account…</p></main>
  if (!account) return <AuthScreen mode={authMode} setMode={(mode) => { setAuthMode(mode); setAuthError('') }} error={authError} onSubmit={handleAuth} />

  return <main className="app-shell">
    <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><span className="brand-mark"><HeartPulse size={18} /></span><span>family<span className="brand-pulse">pulse</span></span><button className="mobile-close icon-button" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}><X size={18} /></button></div>
      <div className="circle-switcher-wrap"><button className="circle-switcher" aria-expanded={circleSwitcherOpen} onClick={() => joinedCircles.length > 1 ? setCircleSwitcherOpen((isOpen) => !isOpen) : setPage('family-settings')}><span className="circle-avatar"><UsersRound size={16} /></span><span className="circle-copy"><strong>{circle?.name ?? 'My Family Circle'}</strong><small>{circleAccounts.length} {circleAccounts.length === 1 ? 'member' : 'members'}</small></span><ChevronDown size={15} /></button>{circleSwitcherOpen && joinedCircles.length > 1 && <div className="circle-switcher-menu" role="group" aria-label="Switch family circle">{joinedCircles.map((joinedCircle) => <button key={joinedCircle.id} className={joinedCircle.id === circle?.id ? 'selected' : ''} onClick={() => switchCircle(joinedCircle.id)}><strong>{joinedCircle.name}</strong><small>{joinedCircle.memberIds.length} {joinedCircle.memberIds.length === 1 ? 'member' : 'members'}</small></button>)}</div>}</div>
      <nav className="main-nav" aria-label="Main navigation">{['YOUR SPACE', 'FAMILY CIRCLE', 'SAFETY', 'SETTINGS'].map((group) => <div className="nav-group" key={group}><p className="nav-label">{group}</p>{navigation.filter((item) => item.group === group).map(({ label, key, icon: Icon }) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => { setPage(key); setMobileNavOpen(false); setCircleSwitcherOpen(false) }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{key === 'notifications' && alerts.some((item) => !item.read) && <span className="nav-safe-dot" />}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-mini"><ShieldCheck size={17} /><div><strong>Your family circle</strong><span>Care, connected</span></div></div><button className="account-row" onClick={handleLogout}><span className="account-avatar">{account.name.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{account.name}</strong><small>Sign out</small></span><LogOut size={16} /></button></div>
    </aside>
    {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
        <section className="main-panel"><header className="topbar"><button className="icon-button nav-toggle" aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((isOpen) => !isOpen)}><Menu size={20} /></button><div className="breadcrumb"><span>{circle?.name}</span><span className="breadcrumb-divider">/</span><strong>{current.title}</strong></div><div className="top-actions"><div className="session-tag"><span className="neutral-dot" />SECURE ACCOUNT</div><button className="icon-button top-search" aria-label="Search" onClick={() => notify('Search is not available yet.')}><Search size={18} /></button><button className="icon-button notification-button" aria-label="Notifications" onClick={() => { setPage('notifications'); markNotificationsRead() }}><Bell size={18} />{alerts.some((item) => !item.read) && <span />}</button><button className="top-user" onClick={() => setPage('account-settings')} aria-label="Account settings"><span>{account.name.slice(0, 1).toUpperCase()}</span><ChevronDown size={14} /></button></div></header>
      <div className="content-wrap"><div className="page-heading"><div><div className="eyebrow">{current.eyebrow}</div><h1>{current.title}</h1><p>{current.description}</p></div>{page === 'dashboard' && <button className="outline-button" onClick={() => setPage('family-members')}><UsersRound size={16} />Manage circle</button>}</div>
        {page === 'dashboard' ? <Dashboard account={account} members={circleAccounts} currentId={account.id} circle={circle} events={store.events.filter((item) => item.circleId === circle?.id && item.status === 'open')} geoPoints={geoPoints} geoAddresses={geoAddresses} batteryPercent={batteryPercent} activeMemberTimes={activeMemberTimes} onAdd={() => setInviteModal('create')} onNavigate={setPage} accountName={account.name} /> : page === 'join-family' ? <JoinFamilyPage onSubmit={joinExistingCircle} /> : <PageContent page={page} account={account} circle={circle} members={circleAccounts} selectedMember={selectedMember} invite={inviteDraft} events={store.events.filter((item) => item.circleId === circle?.id)} notifications={alerts} geoPoints={geoPoints} locationError={locationError} onAdd={() => setInviteModal('create')} onJoin={() => setInviteModal('join')} onSelectMember={(id) => { setSelectedMemberId(id); setPage('member-profile') }} onRemoveMember={handleRemoveMember} onSaveProfile={saveProfile} onOpenMedical={() => setPage('medical-information')} onPermissionChange={updatePermission} onSaveContact={() => setContactModal(true)} onRemoveContact={(contactId) => updateStore((currentStore) => ({ ...currentStore, accounts: currentStore.accounts.map((item) => item.id === account.id ? { ...item, contacts: item.contacts.filter((contact) => contact.id !== contactId) } : item) }))} onToggleLocation={toggleLocationSharing} onStartEvent={startManualSafetyEvent} onUpdateEvent={updateEvent} onUpdateEscalation={(minutes) => circle && updateStore((currentStore) => ({ ...currentStore, circles: currentStore.circles.map((item) => item.id === circle.id ? { ...item, escalationMinutes: minutes } : item) }))} onDeleteData={clearLocalData} onNotify={notify} />}
        <div className="medical-disclaimer"><ShieldCheck size={16}/><span>Keep health details organized and coordinate manual family check-ins in one place. For urgent medical or safety concerns, contact local emergency services.</span></div>
      </div>
    </section>
    {inviteModal && <InviteDialog mode={inviteModal} invite={inviteDraft} onClose={() => setInviteModal(null)} onCreate={createInvite} onNotify={notify} />}
    {contactModal && <ContactDialog onClose={() => setContactModal(false)} onSubmit={saveContact} />}
    {toast && <div className="toast" role="status"><ShieldCheck size={16}/>{toast}</div>}
  </main>
}

function AuthScreen({ mode, setMode, error, onSubmit }: { mode: AuthMode; setMode: (mode: AuthMode) => void; error: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  if (mode === 'forgot' || mode === 'reset' || mode === 'resend-verification') {
    const isReset = mode === 'reset'
    const isVerification = mode === 'resend-verification'
    return <main className="auth-shell">
      <div className="auth-brand"><span className="brand-mark"><HeartPulse size={19}/></span><span>family<span className="brand-pulse">pulse</span></span></div>
      <section className="auth-card auth-recovery-card">
        <span className="eyebrow">ACCOUNT RECOVERY</span>
        <h2>{isReset ? 'Choose a new password.' : isVerification ? 'Resend verification.' : 'Reset your password.'}</h2>
        <p className="auth-subtitle">{isReset ? 'Use a new password between 12 and 128 characters.' : isVerification ? 'We will send a fresh verification link if your account needs one.' : 'Enter your account email and we will send a reset link if it exists.'}</p>
        <form className="auth-form" onSubmit={onSubmit}>
          {!isReset && <label>Email address<input required name="email" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com"/></label>}
          {isReset && <label>New password<input required name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} placeholder="12 characters minimum"/></label>}
          {error && <div className="auth-error" role="status">{error}</div>}
          <button className="primary-button auth-submit" type="submit">{isReset ? 'Save new password' : isVerification ? 'Resend verification email' : 'Send reset link'}<ArrowRight size={15}/></button>
        </form>
        <button className="auth-back-link" type="button" onClick={() => setMode('login')}>Back to sign in</button>
      </section>
      <footer className="auth-footer"><span>FamilyPulse</span><span>For urgent help, contact local emergency services.</span></footer>
    </main>
  }

  return <>
    <StandardAuthScreen mode={mode} setMode={setMode} error={error} onSubmit={onSubmit}/>
    {mode === 'login' && <div className="auth-recovery-actions"><button type="button" onClick={() => setMode('forgot')}>Forgot password?</button><button type="button" onClick={() => setMode('resend-verification')}>Resend verification email</button></div>}
  </>
}

function StandardAuthScreen({ mode, setMode, error, onSubmit }: { mode: 'signup' | 'login' | 'join'; setMode: (mode: 'signup' | 'login' | 'join') => void; error: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  const heading = mode === 'signup' ? 'Start your circle.' : mode === 'join' ? 'Join your family.' : 'Good to see you.'
  return <main className="auth-shell"><div className="auth-brand"><span className="brand-mark"><HeartPulse size={19}/></span><span>family<span className="brand-pulse">pulse</span></span></div><div className="auth-layout"><section className="auth-story"><div className="story-kicker"><span className="live-dot"/>A little closer, when it matters</div><h1>Care feels better<br/>when it&apos;s <em>connected.</em></h1><p>A shared space for your family&apos;s health details, safety preferences, and the people who show up for one another.</p><div className="story-note"><ShieldCheck size={18}/><span>Built around consent, privacy, and responsible care.</span></div><div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-core"><HeartPulse size={30}/></div><span className="orbit-dot dot-one"/><span className="orbit-dot dot-two"/><span className="orbit-dot dot-three"/></div></section><section className="auth-card"><div className="auth-card-top"><span className="eyebrow">WELCOME TO FAMILYPULSE</span><div className="auth-mode-toggle"><button className={mode === 'signup' ? 'selected' : ''} onClick={() => setMode('signup')}>Create account</button><button className={mode === 'login' ? 'selected' : ''} onClick={() => setMode('login')}>Sign in</button></div></div><h2>{heading}</h2><p className="auth-subtitle">{mode === 'join' ? 'Use the separate invite code and passcode shared by a family member.' : mode === 'signup' ? 'Create your account and family circle.' : 'Sign in to your account.'}</p><form className="auth-form" onSubmit={onSubmit}>{mode !== 'login' && <label>Your name<input required name="name" autoComplete="name" maxLength={80} placeholder="Your name"/></label>}{mode === 'join' && <><label>Invite code<input required name="inviteCode" autoComplete="off" placeholder="8-character code" maxLength={8}/></label><label>Invite passcode<input required name="invitePasscode" autoComplete="off" inputMode="numeric" placeholder="6-digit passcode" maxLength={6}/></label></>}<label>Email address<input required name="email" type="email" autoComplete="email" maxLength={254} placeholder="you@example.com"/></label><label>Password<input required name="password" type="password" minLength={mode === 'login' ? 6 : 12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'login' ? 'Your password' : '12 characters minimum'}/></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="primary-button auth-submit" type="submit">{mode === 'signup' ? 'Create my account' : mode === 'join' ? 'Join family circle' : 'Sign in'}<ArrowRight size={17}/></button></form><div className="auth-shortcuts">{mode !== 'join' && <button onClick={() => setMode('join')}><KeyRound size={14}/>Have a family invite?</button>}{mode !== 'signup' && <button onClick={() => setMode('signup')}>Create a new circle</button>}</div></section></div><footer className="auth-footer"><span>FamilyPulse</span><span>Plan care together. For urgent help, contact local emergency services.</span></footer></main>
}

function Dashboard({ account, members, currentId, circle, events, geoPoints, geoAddresses, batteryPercent, activeMemberTimes, onAdd, onNavigate, accountName }: { account: Account; members: Account[]; currentId: string; circle: FamilyCircle | null; events: SafetyEvent[]; geoPoints: Record<string, GeoPoint>; geoAddresses: Record<string, string>; batteryPercent: number | null; activeMemberTimes: Record<string, number>; onAdd: () => void; onNavigate: (page: PageKey) => void; accountName: string }) {
  return <>
    <section className="welcome-strip"><div className="welcome-copy"><span className="welcome-greeting">A GOOD DAY TO CHECK IN</span><h2>Good morning, {accountName.split(' ')[0]}.</h2><p>Your circle is ready whenever you are.</p></div><div className="welcome-art" aria-hidden="true"><div className="welcome-ring ring-a"/><div className="welcome-ring ring-b"/><div className="welcome-heart"><HeartPulse size={27}/></div><span className="welcome-spark spark-a"/><span className="welcome-spark spark-b"/></div></section>
    <MedicalCodeOverview account={account} onOpenMedical={() => onNavigate('medical-information')} />
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
  if (page === 'family-members') return <section className="content-section"><div className="section-title-row"><div><h2>Your circle</h2><p>{members.length} {members.length === 1 ? 'member' : 'members'} in this circle.</p></div><button className="primary-button" onClick={props.onAdd}><Plus size={16}/>Generate invite</button></div>
    <div className="invite-explainer"><KeyRound size={18}/><span>Any circle member can create a single-use code and passcode that expire in 15 minutes. New accounts and existing members can join from any device connected to this service.</span></div>
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
  if (page === 'emergency-contacts') return <section className="content-section"><div className="section-title-row"><div><h2>Your emergency contacts</h2><p>Saved to your account. Calling is always a manual action.</p></div><button className="primary-button" onClick={props.onSaveContact}><Plus size={16}/>Add contact</button></div>{account.contacts.length === 0 ? <EmptyPanel title="No emergency contacts" description="Add a trusted contact name, relationship, and phone number." icon={<UserRound size={21}/>} action="Add contact" onAction={props.onSaveContact}/> : <div className="contact-list">{account.contacts.map((contact) => <div className="contact-row" key={contact.id}><span className="member-avatar"><UserRound size={16}/></span><div className="member-info"><strong>{contact.name}</strong><span>{contact.relationship}   -  {contact.phone}</span></div><a className="outline-button" href={`tel:${contact.phone.replace(/[^+\d]/g, '')}`}>Call</a><button className="icon-button" aria-label={`Remove ${contact.name}`} onClick={() => props.onRemoveContact(contact.id)}><Trash2 size={16}/></button></div>)}</div>}</section>
  if (page === 'locations') return <section className="content-section">
    <div className="map-toolbar"><div><span className="map-live-indicator"><span className={account.shareLocation && geoPoints[account.id] ? 'live-dot' : 'neutral-dot'}/>{account.shareLocation && geoPoints[account.id] ? 'LIVE FROM THIS DEVICE' : 'LOCATION NOT SHARED'}</span><span className="map-updated">{geoPoints[account.id] ? `Updated ${new Date(geoPoints[account.id].timestamp).toLocaleTimeString()}` : 'Turn on sharing to show your location'}</span></div><label className="map-consent-toggle"><span>Share my location</span><input type="checkbox" checked={account.shareLocation} onChange={(event) => props.onToggleLocation(event.target.checked)}/></label></div>
    {locationError && <div className="auth-error location-error" role="alert">{locationError}</div>}
    <div className="map-frame"><MapContainer center={geoPoints[account.id] ? [geoPoints[account.id].latitude, geoPoints[account.id].longitude] : [20, 0]} zoom={geoPoints[account.id] ? 14 : 2} scrollWheelZoom className="family-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><MapFollow point={account.shareLocation ? geoPoints[account.id] : undefined}/>{account.shareLocation && geoPoints[account.id] && <Marker position={[geoPoints[account.id].latitude, geoPoints[account.id].longitude]} icon={divIcon({ className: 'family-map-marker', html: '<span class="map-marker-pulse"></span>', iconSize: [26, 26], iconAnchor: [13, 13] })}><Popup><strong>{account.name} (you)</strong><br/>Current browser location<br/>Accuracy +/-{Math.round(geoPoints[account.id].accuracy)} m</Popup></Marker>}</MapContainer>{account.shareLocation && !geoPoints[account.id] && <div className="map-waiting"><MapPin size={17}/>Waiting for browser location permission...</div>}<button className="map-center-button" aria-label="Center map on me" disabled={!geoPoints[account.id] || !account.shareLocation} onClick={() => window.dispatchEvent(new CustomEvent('familypulse:map-center'))}><MapPin size={17}/></button><div className="map-attribution-note">Map tiles by OpenStreetMap</div></div>
    <div className="map-family-status"><div className="map-family-icon"><UsersRound size={17}/></div><div><strong>Family locations</strong><span>Locations shared by consenting circle members appear here while their updates are active. Saved coordinates expire after one hour.</span></div><span className="permission-state">CONSENT REQUIRED</span></div>
    <div className="map-privacy-note"><ShieldCheck size={15}/><span>Your location is shared with OpenStreetMap for street-name lookup after consent, saved for up to one hour, and deleted when sharing is turned off.</span></div>
  </section>
  if (page === 'emergency-center') return <section className="content-section"><div className="emergency-caution"><div className="caution-icon"><AlertCircle size={22}/></div><div><span className="eyebrow">MANUAL CHECK-INS ONLY</span><h2>Automatic medical event detection is unavailable.</h2>
    <p>You can create a manual family check-in and manage the response status below. It does not contact emergency services, dispatch help, or confirm anyone&apos;s medical condition. For urgent help, contact local emergency services now.</p></div></div><div className="manual-event-action"><div><strong>Need your family to check in?</strong><span>Create a manual request for circle members to contact you.</span></div><button className="primary-button" onClick={props.onStartEvent}><AlertCircle size={16}/>Request a check-in</button></div><div className="emergency-tools"><div><div className="tool-icon"><MapPin size={16}/></div><h3>Location readiness</h3><p>Keep one shareable family location and confirm consent before using it in a safety workflow.</p></div><div><div className="tool-icon"><UsersRound size={16}/></div><h3>Response roles</h3><p>Assign one circle owner and one backup contact to handle check-ins and escalation steps.</p></div></div><div className="settings-list"><div className="settings-row"><div><strong>Escalation reminder interval</strong><span>In-app guidance only; no calls or notifications are sent automatically.</span></div><select value={circle?.escalationMinutes ?? 5} onChange={(event) => props.onUpdateEscalation(Number(event.target.value))}><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option></select></div><div className="settings-row"><div><strong>Check-in rhythm</strong><span>Check-in updates are recorded whenever a member checks in.</span></div><span className="permission-state">EVERY CHECK-IN</span></div><div className="settings-row"><div><strong>Urgent contact guidance</strong><span>Manual events should trigger direct phone outreach, not automated dispatch.</span></div><span className="permission-state">LOCAL ONLY</span></div></div></section>
  if (page === 'emergency-history') return <section className="content-section"><div className="section-title-row"><div><h2>Manual safety history</h2><p>These are user-created check-ins, not detected medical events.</p></div></div>{events.length === 0 ? <EmptyPanel title="No check-ins in this circle" description="You can create a manual check-in from Emergency center. Nothing is generated automatically." icon={<Clock3 size={21}/>} /> : <div className="event-list">{events.map((event) => { const person = members.find((item) => item.id === event.memberId); const responder = members.find((item) => item.id === event.responseBy); return <article className="event-row" key={event.id}><span className={`event-status status-${event.status}`}>{event.status}</span><div className="event-copy"><strong>{person?.name ?? 'Circle member'} · {event.summary}</strong><span>{new Date(event.createdAt).toLocaleString()}{responder ? ` · ${responder.name} is responding` : ''}</span></div><div className="event-actions">{event.status === 'open' && event.memberId !== account.id && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'responding')}>I&apos;m responding</button>}{event.status !== 'resolved' && event.status !== 'cancelled' && event.memberId === account.id && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'cancelled')}>Cancel</button>}{event.status === 'responding' && <button className="outline-button" onClick={() => props.onUpdateEvent(event.id, 'resolved')}>Mark resolved</button>}</div></article> })}</div>}</section>
  if (page === 'notifications') return <section className="content-section"><div className="section-title-row"><div><h2>Family notifications</h2><p>Updates sync while FamilyPulse is open. Desktop alerts depend on this browser's notification permission.</p></div>{typeof Notification !== 'undefined' && Notification.permission === 'default' ? <button className="outline-button" onClick={async () => { const permission = await Notification.requestPermission(); props.onNotify(permission === 'granted' ? 'Desktop alerts enabled for this browser.' : 'Desktop alerts were not enabled. Check browser notification settings.') }}><Bell size={15}/>Enable desktop alerts</button> : <span className="permission-state">{typeof Notification === 'undefined' ? 'DESKTOP ALERTS UNAVAILABLE' : Notification.permission === 'granted' ? 'DESKTOP ALERTS ON' : 'CHECK BROWSER SETTINGS'}</span>}</div>{notifications.length === 0 ? <EmptyPanel title="You're all caught up" description="New manual check-ins shared with your family circle appear here." icon={<Bell size={21}/>} /> : <div className="notice-list">{notifications.map((notification) => <article className="notice-row" key={notification.id}><span className="notice-icon"><Bell size={16}/></span><div><strong>{notification.title}</strong><span>{notification.detail}</span><time>{new Date(notification.createdAt).toLocaleString()}</time></div></article>)}</div>}</section>
  if (page === 'privacy-permissions') return <section className="content-section"><div className="privacy-callout"><LockKeyhole size={20}/><div><strong>You control each information category.</strong><span>Permission changes apply to the member who is signed in. Circle members can see only the categories you allow.</span></div></div><div className="permission-list">{([['basic', 'Basic information', 'Name, date of birth, blood type and clinic'], ['medical', 'Medical information', 'Allergies, conditions, medications, insurance and notes'], ['emergency', 'Emergency information', 'Emergency phone number and response details'], ['location', 'Location sharing', 'Allows consenting circle members to view your active shared location'] ] as [keyof MemberPermissions, string, string][]).map(([key, title, note]) => <label className="permission-row permission-control" key={key}><div><strong>{title}</strong><span>{note}</span></div><input type="checkbox" checked={account.permissions[key]} onChange={(event) => props.onPermissionChange(key, event.target.checked)}/></label>)}</div><div className="inline-note"><LockKeyhole size={14}/>Your care details and sharing preferences are stored with your account.</div></section>
  if (page === 'family-settings') return <section className="content-section"><div className="settings-list"><div className="settings-row"><div><strong>Family Circle name</strong><span>{circle?.name}</span></div><span className="permission-state">{members.length} MEMBERS</span></div><div className="settings-row"><div><strong>Invite a member</strong><span>Create a single-use code and passcode that expire in 15 minutes. New or existing accounts can join.</span></div><button className="outline-button" onClick={props.onAdd}>Generate invite<Plus size={15}/></button></div>{circle?.ownerId === account.id && <><div className="settings-row"><div><strong>Manual reminder interval</strong><span>In-app guidance only; no calls or notifications are sent automatically.</span></div><select value={circle.escalationMinutes} onChange={(event) => props.onUpdateEscalation(Number(event.target.value))}><option value={2}>2 minutes</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option></select></div><div className="settings-row"><div><strong>Automatic emergency escalation</strong><span>Not connected; only manual check-in records are available.</span></div><span className="permission-state">NOT ACTIVE</span></div></>}{circle?.ownerId !== account.id && <div className="settings-row"><div><strong>Circle administration</strong><span>Only the circle owner can change reminder settings or remove members.</span></div><span className="permission-state">MEMBER</span></div>}</div>{circle?.ownerId === account.id && members.filter((member) => member.id !== account.id).length > 0 && <div className="settings-list"><div className="settings-heading">REMOVE MEMBERS</div>{members.filter((member) => member.id !== account.id).map((member) => <div className="settings-row" key={member.id}><div><strong>{member.name}</strong><span>Remove this account from the circle in this browser.</span></div><button className="icon-button danger-icon" aria-label={`Remove ${member.name}`} onClick={() => props.onRemoveMember(member.id)}><Trash2 size={16}/></button></div>)}</div>}</section>
  if (page === 'account-settings') return <section className="content-section"><div className="privacy-callout"><UserRound size={20}/><div><strong>{account.name}</strong><span>{account.email}</span></div></div><div className="settings-list"><div className="settings-row"><div><strong>Account preferences</strong><span>Manage your FamilyPulse profile and preferences.</span></div><span className="permission-state">ACCOUNT</span></div><div className="settings-row"><div><strong>Delete your FamilyPulse account</strong><span>Permanently removes your profile, contacts, memberships, and personal history.</span></div><button className="outline-button danger-button" onClick={props.onDeleteData}><Trash2 size={15}/>Delete account</button></div></div></section>
  return <EmptyPanel title="No screen available" description="Choose another section from the navigation." icon={<CircleHelpIcon/>}/>
}

function CircleHelpIcon() { return <ShieldCheck size={21}/> }

function MedicalCodeOverview({ account, onOpenMedical }: { account: Account; onOpenMedical: () => void }) {
  const [medicalCard, setMedicalCard] = useState<{ qr: string; barcode: string } | null>({ qr: '', barcode: '' })
  const medicalPayload = useMemo(() => buildMedicalPayload(account), [account])
  const rescueUrl = useMemo(() => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = `rescue=${encodeMedicalPayload(JSON.stringify(medicalPayload))}`
    return url.toString()
  }, [medicalPayload])

  useEffect(() => {
    let cancelled = false
    void generateMedicalCard(rescueUrl, account.medicalId)
      .then((card) => { if (!cancelled) setMedicalCard(card) })
      .catch(() => { if (!cancelled) setMedicalCard({ qr: '', barcode: '' }) })
    return () => { cancelled = true }
  }, [rescueUrl, account.medicalId])

  function downloadDataAsset(format: 'qr' | 'barcode') {
    if (!medicalCard || !medicalCard.qr && !medicalCard.barcode) return
    const link = document.createElement('a')
    const source = format === 'qr' ? medicalCard.qr : medicalCard.barcode
    if (!source) return
    link.href = source
    link.download = `${account.name.toLowerCase().replace(/\s+/g, '-')}-medical-${format}.png`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function openPdf() {
    const printWindow = window.open('', '_blank', 'width=980,height=1200')
    if (!printWindow) return
    const payload = buildMedicalPayload(account)
    const html = `
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>FamilyPulse Medical ID</title>
        <style>${medicalDocumentStyles}\n@page { size: auto; margin: 12mm; }</style>
      </head>
      <body class="medical-document-preview">
        <div class="medical-document-page">
          <div class="medical-document-header">
            <div class="medical-document-brand"><span class="medical-document-brand-mark">❤</span>family<span style="color: #285b49;">pulse</span></div>
            <span class="medical-document-tag">MEDICAL ID</span>
          </div>
          <div class="medical-document-content">
            <div class="medical-document-hero">
              <div class="medical-document-panel medical-document-meta">
                <strong>Emergency profile</strong>
                <h1>${escapeHtml(payload.n)}</h1>
                <p><strong>Email:</strong> ${escapeHtml(payload.e || 'Not provided')}<br/><strong>Medical ID:</strong> ${escapeHtml(payload.i)}</p>
              </div>
              <div class="medical-document-panel medical-document-code-box">
                <img src="${medicalCard?.qr || ''}" alt="QR code" />
                <div class="medical-document-code-value">${escapeHtml(payload.i)}</div>
              </div>
            </div>
            <div class="medical-document-grid">
              ${[['Date of birth', payload.dob], ['Blood type', payload.bt], ['Allergies', payload.a], ['Conditions', payload.c], ['Medications', payload.med], ['Doctor / clinic', payload.doc], ['Insurance', payload.ins], ['Emergency number', payload.en]].map(([label, value]) => `<div class="medical-document-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
            </div>
            <div class="medical-document-notes"><h2>Emergency contacts</h2>${payload.ec.length ? `<div class="medical-document-contact-list">${payload.ec.map(([name, relationship, phone]) => `<div class="medical-document-contact"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(relationship)}</span><a href="tel:${phone.replace(/[^+\d]/g, '')}">${escapeHtml(phone)}</a></div>`).join('')}</div>` : '<p>No emergency contacts have been saved.</p>'}</div>
            <div class="medical-document-notes"><h2>Barcode</h2><img class="medical-document-barcode" src="${medicalCard?.barcode || ''}" alt="Barcode" /></div>
            <div class="medical-document-notes"><h2>Medical notes</h2><p>${escapeHtml(payload.notes)}</p></div>
          </div>
        </div>
      </body>
      </html>
    `
    printWindow.document.write(html)
    printWindow.document.close()
    setTimeout(() => { try { printWindow.focus(); printWindow.print() } catch { /* no-op */ } }, 300)
  }

  return <section className="overview-medical-code" aria-label="Medical ID codes">
    <div className="overview-medical-code-id"><span>MEDICAL ID</span><strong>{account.medicalId}</strong><div className="overview-medical-code-actions"><button onClick={() => downloadDataAsset('qr')} disabled={!medicalCard || !medicalCard.qr}>Download QR</button><button onClick={() => downloadDataAsset('barcode')} disabled={!medicalCard || !medicalCard.barcode}>Download barcode</button><button onClick={openPdf}>Download PDF</button><button className="subtle-link" onClick={onOpenMedical}>Medical information<ArrowRight size={14}/></button></div></div>
    {medicalCard && medicalCard.qr ? <img className="overview-medical-qr" src={medicalCard.qr} alt="Medical ID QR code" /> : <div className="overview-medical-fallback">QR loading…</div>}
    {medicalCard && medicalCard.barcode ? <img className="overview-medical-barcode" src={medicalCard.barcode} alt="Medical ID barcode" /> : <div className="overview-medical-fallback-barcode">Barcode loading…</div>}
  </section>
}

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
  const medicalPayload = useMemo(() => buildMedicalPayload({ ...profile, profile: draft }), [profile, draft])
  const rescueUrl = useMemo(() => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = `rescue=${encodeMedicalPayload(JSON.stringify(medicalPayload))}`
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
        const card = await generateMedicalCard(rescueUrl.toString(), profile.medicalId)
        if (!cancelled) setMedicalCard(card)
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

  function openMedicalPdf() {
    if (!medicalCard) return
    const printWindow = window.open('', '_blank', 'width=980,height=1200')
    if (!printWindow) return
    const details = [
      ['Date of birth', medicalPayload.dob],
      ['Blood type', medicalPayload.bt],
      ['Allergies', medicalPayload.a],
      ['Conditions', medicalPayload.c],
      ['Medications', medicalPayload.med],
      ['Doctor / clinic', medicalPayload.doc],
      ['Insurance', medicalPayload.ins],
      ['Emergency number', medicalPayload.en],
    ]
    const html = `
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>FamilyPulse Medical ID</title>
        <style>${medicalDocumentStyles}\n@page { size: auto; margin: 12mm; }</style>
      </head>
      <body class="medical-document-preview">
        <div class="medical-document-page">
          <div class="medical-document-header">
            <div class="medical-document-brand"><span class="medical-document-brand-mark">❤</span>family<span style="color: #285b49;">pulse</span></div>
            <span class="medical-document-tag">MEDICAL ID</span>
          </div>
          <div class="medical-document-content">
            <div class="medical-document-hero">
              <div class="medical-document-panel medical-document-meta">
                <strong>Emergency profile</strong>
                <h1>${escapeHtml(medicalPayload.n)}</h1>
                <p><strong>Email:</strong> ${escapeHtml(medicalPayload.e || 'Not provided')}<br/><strong>Medical ID:</strong> ${escapeHtml(medicalPayload.i)}</p>
              </div>
              <div class="medical-document-panel medical-document-code-box">
                <img src="${medicalCard.qr}" alt="QR code" />
                <div class="medical-document-code-value">${escapeHtml(medicalPayload.i)}</div>
              </div>
            </div>
            <div class="medical-document-grid">
              ${details.map(([label, value]) => `<div class="medical-document-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
            </div>
            <div class="medical-document-notes"><h2>Emergency contacts</h2>${medicalPayload.ec.length ? `<div class="medical-document-contact-list">${medicalPayload.ec.map(([name, relationship, phone]) => `<div class="medical-document-contact"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(relationship)}</span><a href="tel:${phone.replace(/[^+\d]/g, '')}">${escapeHtml(phone)}</a></div>`).join('')}</div>` : '<p>No emergency contacts have been saved.</p>'}</div>
            <div class="medical-document-notes"><h2>Barcode</h2><img class="medical-document-barcode" src="${medicalCard.barcode}" alt="Barcode" /></div>
            <div class="medical-document-notes"><h2>Medical notes</h2><p>${escapeHtml(medicalPayload.notes)}</p></div>
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
    {ownProfile && medicalCard && <div className="medical-identity-card"><div className="medical-identity-header"><div><span className="eyebrow">PERSONAL MEDICAL ID</span><h3>{profile.medicalId}</h3></div><button className="outline-button" onClick={openMedicalPdf}>Open PDF</button></div></div>}
    {editing ? <div className="profile-form-grid">{fields.map((field) => <label className={field.type === 'textarea' ? 'wide-field' : ''} key={field.key}>{field.label}{field.type === 'select' ? <select value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)}>{field.options?.map((option) => <option key={option} value={option}>{option || 'Select blood type'}</option>)}</select> : field.type === 'textarea' ? <textarea rows={3} maxLength={2000} value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)} placeholder="Add only what you choose to store"/> : <input type={field.type ?? 'text'} maxLength={field.type === 'date' ? undefined : 120} value={draft[field.key]} onChange={(event) => updateField(field.key, event.target.value)} placeholder="Not added"/>}</label>)}</div> : <div className="saved-profile-grid">{fields.map((field) => { const visible = ownProfile || (field.access === 'basic' ? canSeeBasic : field.access === 'medical' ? canSeePrivate : profile.permissions.emergency); return <div className="saved-profile-item" key={field.key}><span>{field.label}</span><strong>{!visible ? 'Not shared' : profile.profile[field.key] || 'Not provided'}</strong></div> })}</div>}
    {ownProfile && editing && <div className="profile-form-actions"><span className="inline-note"><LockKeyhole size={14}/>Changes save to your FamilyPulse profile.</span><div><button className="outline-button" onClick={cancel}>Cancel</button><button className="primary-button" onClick={save}><Save size={15}/>Save medical information</button></div></div>}
  </section>
}

function MedicalRescuePage({ profile }: { profile: MedicalRescuePayload }) {
  const [medicalCard, setMedicalCard] = useState<{ qr: string; barcode: string } | null>(null)
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

  useEffect(() => {
    let cancelled = false
    void generateMedicalCard(window.location.href, profile.i)
      .then((card) => { if (!cancelled) setMedicalCard(card) })
      .catch(() => { if (!cancelled) setMedicalCard(null) })
    return () => { cancelled = true }
  }, [profile.i])

  return <main className="medical-document-page">
    <header className="medical-document-header">
      <div className="medical-document-brand"><span className="medical-document-brand-mark">❤</span>family<span style={{ color: '#285b49' }}>pulse</span></div>
      <span className="medical-document-tag">MEDICAL ID</span>
    </header>
    <div className="medical-document-content">
      <div className="medical-document-hero">
        <section className="medical-document-panel medical-document-meta">
          <strong>Emergency profile</strong>
          <h1>{profile.n}</h1>
          <p><strong>Email:</strong> {profile.e || 'Not provided'}<br/><strong>Medical ID:</strong> {profile.i}</p>
        </section>
        <section className="medical-document-panel medical-document-code-box">
          {medicalCard && <img src={medicalCard.qr} alt="QR code" />}
          <div className="medical-document-code-value">{profile.i}</div>
        </section>
      </div>
      <div className="medical-document-grid">
        {details.slice(0, 8).map(([label, value]) => <div className="medical-document-item" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <section className="medical-document-notes">
        <h2>Emergency contacts</h2>
        {profile.ec.length ? <div className="medical-document-contact-list">{profile.ec.map(([name, relationship, phone], index) => <div className="medical-document-contact" key={`${phone}-${index}`}><strong>{name}</strong><span>{relationship}</span><a href={`tel:${phone.replace(/[^+\d]/g, '')}`}>{phone}</a></div>)}</div> : <p>No emergency contacts have been saved.</p>}
      </section>
      <section className="medical-document-notes">
        <h2>Barcode</h2>
        {medicalCard && <img className="medical-document-barcode" src={medicalCard.barcode} alt="Barcode" />}
      </section>
      <section className="medical-document-notes"><h2>Medical notes</h2><p>{profile.notes}</p></section>
    </div>
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="member-modal" role="dialog" aria-modal="true" aria-labelledby="invite-title"><div className="modal-heading"><div><span className="eyebrow">FAMILY CIRCLE</span><h2 id="invite-title">{mode === 'create' ? 'Invite a family member' : 'Join with an invite'}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18}/></button></div><p>Share these one-time credentials with a person using this FamilyPulse service. No email or link is sent.</p>{mode === 'create' ? invite ? <div className="invite-credentials"><label>Invite code<div className="credential-value"><code>{invite.code}</code><button className="icon-button" aria-label="Copy invite code" onClick={() => copy(invite.code)}><Copy size={15}/></button></div></label><label>Separate passcode<div className="credential-value"><code>{invite.passcode}</code><button className="icon-button" aria-label="Copy passcode" onClick={() => copy(invite.passcode)}><Copy size={15}/></button></div></label><div className="inline-note"><Clock3 size={14}/>Expires {new Date(invite.expiresAt).toLocaleString()}. The first account to use both values joins this circle.</div><button className="primary-button invite-done" onClick={onClose}><Check size={16}/>Done</button></div> : <div className="modal-actions"><button className="outline-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={onCreate}><KeyRound size={16}/>Generate credentials</button></div> : <div className="invite-instructions"><p>Sign out, then choose  Have a family invite?  on the sign-in page. Create the new member account there using both values.</p><button className="outline-button" onClick={onClose}>Got it</button></div>}</section></div>
}

function ContactDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="member-modal" role="dialog" aria-modal="true" aria-labelledby="contact-title"><div className="modal-heading"><div><span className="eyebrow">EMERGENCY CONTACTS</span><h2 id="contact-title">Add a contact</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18}/></button></div><p>Saved to your account. This does not alert or call the contact automatically.</p><form onSubmit={onSubmit}><label>Full name<input required name="name" autoFocus maxLength={80} placeholder="Contact name"/></label><label>Relationship<input required name="relationship" maxLength={60} placeholder="e.g. Neighbor, caregiver"/></label><label>Phone number<input required name="phone" type="tel" autoComplete="tel" maxLength={32} placeholder="+1 555 000 0000"/></label><div className="modal-actions"><button className="outline-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><Plus size={16}/>Save contact</button></div></form></section></div>
}

export default App
