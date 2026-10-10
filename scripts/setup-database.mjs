import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { Client } from 'pg'

const host = process.env.PGHOST ?? 'localhost'
const port = Number(process.env.PGPORT ?? 5432)
const databaseName = 'familypulse'
const appRole = 'familypulse_app'
const envFile = new URL('../.env', import.meta.url)
const schemaFile = new URL('../server/schema.sql', import.meta.url)

function hiddenInput(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('Run npm run setup:db in a terminal to enter the administrator password securely.')
  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const onData = (data) => {
      for (const character of data.toString()) {
        if (character === '\u0003') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          reject(new Error('Setup cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdout.write('\n')
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
      }
    }
    stdin.on('data', onData)
  })
}

const readline = createInterface({ input: stdin, output: stdout })
let admin
let application

try {
  const { access } = await import('node:fs/promises')
  try {
    await access(envFile)
    throw new Error('.env already exists. Preserve its DATABASE_URL and rerun setup only after backing it up.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const adminUser = (await readline.question('PostgreSQL administrator role [postgres]: ')).trim() || 'postgres'
  readline.close()
  const adminPassword = await hiddenInput(`Password for ${adminUser} (hidden): `)
  const appPassword = randomBytes(32).toString('hex')
  admin = new Client({ host, port, database: 'postgres', user: adminUser, password: adminPassword })
  await admin.connect()

  await admin.query(`DO $setup$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
      CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}';
    ELSE
      ALTER ROLE ${appRole} WITH LOGIN PASSWORD '${appPassword}';
    END IF;
  END $setup$`)
  const { rows: [database] } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  if (!database) await admin.query(`CREATE DATABASE ${databaseName} OWNER ${appRole}`)
  else await admin.query(`ALTER DATABASE ${databaseName} OWNER TO ${appRole}`)
  await admin.end()
  admin = null

  application = new Client({ host, port, database: databaseName, user: appRole, password: appPassword })
  await application.connect()
  const { rows: tables } = await application.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  for (const { tablename } of tables) {
    const safeName = tablename.replaceAll('"', '""')
    await application.query(`ALTER TABLE public."${safeName}" OWNER TO ${appRole}`)
  }
  await application.query(await readFile(schemaFile, 'utf8'))
  await application.end()
  application = null

  const connectionString = `postgresql://${appRole}:${appPassword}@${host}:${port}/${databaseName}`
  await writeFile(envFile, `DATABASE_URL=${connectionString}\nAPI_PORT=3001\nNODE_ENV=development\n`, { flag: 'wx' })
  console.log(`Database ${databaseName} and its schema are ready. Local app credentials were saved to the git-ignored .env file.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  readline.close()
  await admin?.end().catch(() => {})
  await application?.end().catch(() => {})
}