self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    payload = { body: event.data?.text() ?? '' }
  }
  event.waitUntil(self.registration.showNotification(payload.title ?? 'FamilyPulse', {
    body: payload.body ?? 'Your family circle has an update.',
    icon: '/favicon.ico',
    data: { url: payload.url ?? '/' },
    tag: 'familypulse-update',
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).toString()
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => client.url.startsWith(self.location.origin))
    return existing ? existing.focus() : clients.openWindow(target)
  }))
})