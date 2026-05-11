#!/usr/bin/env bun
// Broker daemon entry point. Brings up the WS server, advertises its address
// via the shared state file, and removes the file on graceful shutdown.

import {
  getDefaultStateDir,
  removeStateFile,
  STATE_FILE_VERSION,
  writeStateFile,
} from '@cc-group-chat/shared'
import { Broker } from './broker.ts'
import { startWsServer } from './ws-server.ts'

const broker = new Broker()
const server = startWsServer(broker)
const stateDir = getDefaultStateDir()

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
