# FamilyPulse

FamilyPulse helps families organize health details, emergency contacts, family circles, and manual care check-ins in one workspace.

Website: [https://adnan-04-grana.github.io/familypulse/](https://adnan-04-grana.github.io/familypulse/)

## Run locally

```sh
npm install
npm run setup:db
npm run setup:webpush
npm run dev
```

Before `setup:db`, enter the local PostgreSQL administrator password into a masked PowerShell prompt:

```powershell
$securePassword = Read-Host -Prompt 'Postgres password for user postgres (hidden)' -AsSecureString
$env:PGPASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
npm run setup:db
Remove-Item Env:PGPASSWORD
$securePassword.Dispose()
```

The database setup creates the `familypulse` schema, transfers its tables to a restricted `familypulse_app` role, and saves the generated connection string in the git-ignored `.env`. `setup:webpush` generates VAPID keys and adds them to that ignored file. Keep `.env` private. Open the local URL printed by Vite. The API listens on `127.0.0.1:3001`; Vite proxies `/api` requests to it. To create a production build, run `npm run build`.

GitHub Pages serves static files and cannot connect to PostgreSQL on your PC. A public or multi-device deployment needs the API and PostgreSQL hosted on an appropriately secured server, with the frontend configured to use that API.

## Render deployment

The `render.yaml` Blueprint describes one Node web service and a managed PostgreSQL database. In Render, create a Blueprint from this repository and review the service/database plans and charges before confirming. After creation, set `APP_BASE_URL` to the HTTPS URL Render assigns. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` in the service's private environment settings. Production startup requires these values and an HTTPS base URL; email verification is enforced.

For Web Push, run `npm run setup:webpush` locally, then copy `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` from your private `.env` into Render's environment settings. Never commit or share the private key. Without VAPID keys, the app keeps in-page polling and browser alerts but does not send background push notifications.

## Automatic GitHub updates

When this folder opens in VS Code, approve the `Auto-push saved changes` task once. It watches project files, waits 1.8 seconds after the last save, then commits and pushes the changes to `origin/main`. Rapid saves are grouped into one commit. Stop the watcher with `Ctrl+C` in its VS Code terminal. Review changes before saving; each save can publish unfinished work.

## Current capabilities

- Accounts, family circles, profiles, permissions, emergency contacts, invites, check-ins, notifications, sessions, and consented locations are stored in PostgreSQL.
- Passwords are hashed on the server using PBKDF2-SHA-256 with a per-account salt and 600,000 iterations. Sessions use random HttpOnly, SameSite cookies and lock after 15 minutes without activity.
- Production signups require email verification; password-reset links expire after 30 minutes and can only be used once. Configure SMTP to deliver these emails. Local development without SMTP logs one-time links in the API terminal.
- Members can generate a single-use invite code and separate passcode that expire after 15 minutes. Only a digest of the invite credentials is stored. Circle membership and profile permissions are checked by the API.
- Members can edit their own profile, choose per-category sharing permissions, and add/remove emergency contacts. Call actions require a person to activate the phone's `tel:` handler.
- My Health shows the saved blood group and clearly marks wearable-only heart rate, battery, and blood pressure as unavailable until a device is connected. Medical Information has an explicit Save action and a separate read-only saved view with Edit.
- Location sharing requires explicit browser permission and app consent. Shared coordinates are stored for at most one hour, visible only to consenting circle members, and deleted when sharing is turned off. OpenStreetMap receives coordinates for street-name lookup.
- Emergency check-ins are user-created only. They are stored in PostgreSQL and shared with circle members; active clients poll every 15 seconds and opted-in browsers can receive Web Push when VAPID keys are configured. They do not detect medical events or contact emergency services.
- The wearable and live-monitoring pages are marked Coming soon. No measurements or device status are simulated.
- The account settings page can permanently delete the signed-in account and its personal data.

FamilyPulse helps families organize health details and coordinate manual check-ins. For urgent help, contact local emergency services directly. Browser-local data from earlier versions is not automatically imported into PostgreSQL.

## Security boundary

- Browser sessions lock after 15 minutes without keyboard, pointer, or touch activity. New signup passwords must be 12–128 characters.
- Vite and the Express production server set a Content Security Policy, Permissions Policy, Referrer Policy, `X-Content-Type-Options`, and anti-framing headers; production additionally uses Helmet and HTTPS-only session cookies.
- Medical profiles and contacts are plaintext in PostgreSQL; restrict database and host access and use disk encryption/backups appropriate for health information. The app role is not a PostgreSQL administrator.
- Local development binds the API to loopback. Do not expose it directly to the internet; a public deployment needs HTTPS, production secrets, database network controls, backups, and operational/security review.
