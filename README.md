# FamilyPulse

FamilyPulse helps families organize health details, emergency contacts, family circles, and manual care check-ins in one workspace.

Website: [https://adnan-04-grana.github.io/familypulse/](https://adnan-04-grana.github.io/familypulse/)

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. To create a production build, run `npm run build`.

## Automatic GitHub updates

When this folder opens in VS Code, approve the `Auto-push saved changes` task once. It watches project files, waits 1.8 seconds after the last save, then commits and pushes the changes to `origin/main`. Rapid saves are grouped into one commit. Stop the watcher with `Ctrl+C` in its VS Code terminal. Review changes before saving; each save can publish unfinished work.

## Current capabilities

- Accounts are stored in the browser's local storage. Passwords use PBKDF2-SHA-256 with a per-account salt and 600,000 iterations; older account hashes upgrade after a successful login.
- Members can generate a single-use invite code and separate passcode that expire after 15 minutes. New invite records store a digest rather than the displayed credentials. New or existing accounts can join in the same browser profile.
- Members can edit their own profile, choose per-category sharing permissions, and add/remove emergency contacts. Call actions require a person to activate the phone's `tel:` handler.
- My Health shows the saved blood group and clearly marks wearable-only heart rate, battery, and blood pressure as unavailable until a device is connected. Medical Information has an explicit Save action and a separate read-only saved view with Edit.
- Location sharing requires explicit browser permission. Coordinates remain in memory only, can be removed by switching sharing off, and are not transmitted to other devices.
- Emergency check-ins are user-created only. They update local history and in-browser notifications; they do not detect medical events, call emergency services, or send push alerts.
- The wearable and live-monitoring pages are marked Coming soon. No measurements or device status are simulated.
- The account settings page can delete all FamilyPulse data from the current browser.

FamilyPulse helps families organize health details and coordinate manual check-ins. For urgent help, contact local emergency services directly. A multi-device service can build on this frontend with secure accounts, shared data, reliable alert delivery, consent and audit controls, and any required clinical validation.

## Security boundary

- Browser sessions lock after 15 minutes without keyboard, pointer, or touch activity. New signup passwords must be 12–128 characters; existing accounts can still sign in and upgrade their password hash.
- Vite development and preview responses include a Content Security Policy, Permissions Policy, Referrer Policy, `X-Content-Type-Options`, and anti-framing headers. A production host must configure equivalent response headers.
- Medical profiles, contacts, family events, and notifications remain plaintext in browser `localStorage`. UI permissions do not protect data from same-origin script access or someone with access to the browser profile. At-rest protection requires a password-wrapped encrypted vault with account recovery, or a secured backend.
