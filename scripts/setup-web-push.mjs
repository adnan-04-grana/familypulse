import { readFile, writeFile } from 'node:fs/promises'
import webPush from 'web-push'

const envFile = new URL('../.env', import.meta.url)
let contents = ''
try {
  contents = await readFile(envFile, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const keys = webPush.generateVAPIDKeys()
const updatedLines = contents.split(/\r?\n/).filter((line) => !/^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=/.test(line))
updatedLines.push(`VAPID_PUBLIC_KEY=${keys.publicKey}`, `VAPID_PRIVATE_KEY=${keys.privateKey}`, 'VAPID_SUBJECT=mailto:admin@example.com')
await writeFile(envFile, `${updatedLines.filter(Boolean).join('\n')}\n`)
console.log('Web Push keys saved to the git-ignored .env file. Copy them to your production host secret settings; do not commit or share the private key.')