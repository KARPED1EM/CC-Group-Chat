#!/usr/bin/env bun
// Broker daemon entry. Tries to bind the username-derived port: if successful
// it is the single broker for this user; on `EADDRINUSE` another instance won
// the race and this process exits cleanly so the spawning client falls
// through to its retry-connect path.

import {
  ensureAuthToken,
  getBrokerPort,
  getDefaultStateDir,
  removeStateFile,
  STATE_FILE_VERSION,
  writeStateFile,
} from '@cc-group-chat/shared'
import { Broker } from './broker.ts'
import { startWsServer, type RunningWsServer } from './ws-server.ts'

const stateDir = getDefaultStateDir()
const port = getBrokerPort()
const authToken = await ensureAuthToken(stateDir)

const broker = new Broker({
  authToken,
  room: {
    hardCap: getEnvPositiveInt('CC_GROUP_CHAT_HARD_CAP'),
  },
  rateLimit: {
    maxPerWindow: getEnvPositiveInt('CC_GROUP_CHAT_RATE_LIMIT_MAX'),
    windowMs: getEnvPositiveInt('CC_GROUP_CHAT_RATE_LIMIT_WINDOW_MS'),
  },
  pushBatchMs: getEnvNonNegativeInt('CC_GROUP_CHAT_PUSH_BATCH_MS'),
})

let server: RunningWsServer
try {
  server = startWsServer(broker, { port })
} catch (err: unknown) {
  if (isEAddrInUse(err)) {
    console.error(`cc-group-chat broker: port ${port} already in use, exiting (another broker won the race)`)
    process.exit(0)
  }
  throw err
}

await writeStateFile(stateDir, {
  version: STATE_FILE_VERSION,
  pid: process.pid,
  port: server.port,
  startedAt: Date.now(),
})

console.error(`cc-group-chat broker listening on ${server.url} (pid ${process.pid})`)

let shuttingDown = false
async function shutdown(signal: string): Promise<never> {
  if (shuttingDown) process.exit(1)
  shuttingDown = true
  console.error(`cc-group-chat broker: ${signal} received, shutting down`)
  await server.stop()
  await removeStateFile(stateDir)
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })

function isEAddrInUse(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'EADDRINUSE'
}

function getEnvPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function getEnvNonNegativeInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}
