import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Client } from 'pg'

const host = process.env.PGHOST ?? 'localhost'
const port = Number(process.env.PGPORT ?? 5432)
const databaseName = 'familypulse'
const appRole = 'familypulse_app'
const envFile = new URL('../.env', import.meta.url)
const schemaFile = new URL('../server/schema.sql', import.meta.url)

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

  const adminPassword = process.env.PGPASSWORD
  if (!adminPassword) throw new Error('Run setup:db from PowerShell with a masked PGPASSWORD prompt.')
  const appPassword = randomBytes(32).toString('hex')
  admin = new Client({ host, port, database: 'postgres', user: 'postgres', password: adminPassword })
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

  admin = new Client({ host, port, database: databaseName, user: 'postgres', password: adminPassword })
  await admin.connect()
  const { rows: tables } = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  for (const { tablename } of tables) {
    const safeName = tablename.replaceAll('"', '""')
    await admin.query(`ALTER TABLE public."${safeName}" OWNER TO ${appRole}`)
  }
  await admin.end()
  admin = null

  application = new Client({ host, port, database: databaseName, user: appRole, password: appPassword })
  await application.connect()
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
  await admin?.end().catch(() => {})
  await application?.end().catch(() => {})
}