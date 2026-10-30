import assert from 'node:assert/strict'
import { MemoryNotificationScheduler, NOTIFICATION_POLL_MS } from '../lib/notification-scheduler.js'

const directory = '/memory/global'
const userMessage = { role: 'user', source: { kind: 'user' } }
const memoryMessage = { role: 'user', source: { kind: 'memory' } }

// A change is checked only at a genuine user boundary while the agent is idle.
let checks = 0
const agent = { id: 'a1' }
const scheduler = new MemoryNotificationScheduler({
  directoriesOf: () => [directory],
  check: () => { checks += 1; return true },
})
scheduler.markChanged(directory)
assert.equal(await scheduler.onUserMessage(agent, memoryMessage), false, 'plugin notice is not a user boundary')
assert.equal(checks, 0)
assert.equal(await scheduler.onUserMessage(agent, userMessage), true)
assert.equal(await scheduler.onUserMessage(agent, userMessage), false, 'same revision is checked once')
assert.equal(checks, 1)

// The writer already advanced its own baseline; it should not receive a
// pending revision for that same directory.
const writerAgent = { id: 'writer' }
scheduler.markChanged(directory, writerAgent)
assert.equal(await scheduler.onUserMessage(writerAgent, userMessage), false, 'writer revision is already current')
assert.equal(checks, 1)

// Running agents share a fixed interval; the interval alone bounds how often a
// notice can arrive, so a change is checked by the very next tick. Becoming idle
// cancels the interval but does not flush; a later real user message reconciles.
const fastAgent = { id: 'a2' }
let fastChecks = 0
let intervalMs = 0
let intervalCallback
const oldSetInterval = globalThis.setInterval
const oldClearInterval = globalThis.clearInterval
globalThis.setInterval = (callback, delay) => { intervalCallback = callback; intervalMs = delay; return 1 }
globalThis.clearInterval = () => {}
try {
  const fast = new MemoryNotificationScheduler({
    directoriesOf: () => [directory],
    check: () => { fastChecks += 1; return true },
  })
  fast.setRunning(fastAgent, true)
  assert.equal(intervalMs, NOTIFICATION_POLL_MS)
  fast.markChanged(directory)
  await intervalCallback()
  assert.equal(fastChecks, 1, 'the next tick checks a fresh change — the interval alone bounds the rate')
  fast.markChanged(directory)
  fast.setRunning(fastAgent, false)
  await fast.poll()
  assert.equal(fastChecks, 1, 'no check occurs after the interval is stopped')
  await fast.onUserMessage(fastAgent, userMessage)
  assert.equal(fastChecks, 2, 'next user message checks the pending revision')
  fast.stop()

  // One tick covers every changed visible directory, however fresh each change is.
  const multiAgent = { id: 'a-multi' }
  const multiChecks = { count: 0 }
  const multiDirectories = ['/memory/global', '/memory/workspace']
  const multi = new MemoryNotificationScheduler({
    directoriesOf: () => multiDirectories,
    check: () => { multiChecks.count += 1; return true },
  })
  multi.setRunning(multiAgent, true)
  multi.markChanged(multiDirectories[0])
  multi.markChanged(multiDirectories[1])
  await multi.poll()
  assert.equal(multiChecks.count, 1, 'one tick produces one diff covering every changed directory')
  await multi.poll()
  assert.equal(multiChecks.count, 1, 'nothing new means no further diff')
  multi.stop()
} finally {
  globalThis.setInterval = oldSetInterval
  globalThis.clearInterval = oldClearInterval
}

// A concurrent user boundary queues one follow-up after the current diff. The
// first diff only consumes the revision captured before its async callback.
const concurrentAgent = { id: 'a3' }
const resolvers = []
let concurrentChecks = 0
let signalStarted
const started = new Promise((resolve) => { signalStarted = resolve })
const concurrent = new MemoryNotificationScheduler({
  directoriesOf: () => [directory],
  check: () => {
    concurrentChecks += 1
    signalStarted()
    return new Promise((resolve) => resolvers.push(resolve))
  },
})
concurrent.markChanged(directory)
const firstBoundary = concurrent.onUserMessage(concurrentAgent, userMessage)
await started
concurrent.markChanged(directory)
const nextBoundary = concurrent.onUserMessage(concurrentAgent, userMessage)
assert.equal(concurrentChecks, 1, 'no parallel check for the same agent')
resolvers.shift()(true)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(resolvers.length, 1, 'one new user boundary queues one follow-up check')
resolvers.shift()(true)
await Promise.all([firstBoundary, nextBoundary])
assert.equal(concurrentChecks, 2)
assert.equal(await concurrent.onUserMessage(concurrentAgent, userMessage), false, 'follow-up reconciled racing change')

// Failure leaves the change dirty; inbox discard can explicitly release a
// successfully checked revision for a later retry.
const retryAgent = { id: 'a4' }
let shouldFail = true
let retryChecks = 0
const retry = new MemoryNotificationScheduler({
  directoriesOf: () => [directory],
  check: () => {
    retryChecks += 1
    if (shouldFail) throw new Error('expected check failure')
    return true
  },
})
retry.markChanged(directory)
await assert.rejects(retry.onUserMessage(retryAgent, userMessage), /expected check failure/)
shouldFail = false
assert.equal(await retry.onUserMessage(retryAgent, userMessage), true)
retry.markChanged(directory)
await retry.onUserMessage(retryAgent, userMessage)
retry.retry(retryAgent)
assert.equal(await retry.onUserMessage(retryAgent, userMessage), true, 'release makes a checked change eligible again')

console.log('notification scheduler: all checks passed')
