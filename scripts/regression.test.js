import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'
import { closeHandle, formatAddress, getMainModuleAddress, getMaxAddress, getProcessHandleCount,
  normalizeAddress, openProcessReadOnly, readBytes } from '../lib/win32.js'

// Direct execution avoids node --test's child-process pipe requirements.
let passed = 0
async function check(label, fn) {
  await fn()
  console.log(`PASS ${label}`)
  passed++
}
async function mount() {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    const fiber = ctx.plugin(plugin)
    await fiber
    assert.equal(ctx.tools.schemas().length, 5)
    return { ctx, fiber, dispose: () => ctx.fiber.dispose() }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
let callId = 0
const run = (instance, name, args = {}) => instance.ctx.tools.execute({
  name, arguments: args, callId: `test-${++callId}`, signal: new AbortController().signal,
})
async function call(instance, name, args) {
  const result = await run(instance, name, args)
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}

await check('anonymous FFI types survive three module evaluations', async () => {
  for (let i = 0; i < 3; i++) {
    const native = await import(`../lib/win32.js?reload=${i}`)
    assert.ok(native.listProcesses().some((p) => p.pid === process.pid))
  }
})
await check('address validation and read range overflow', () => {
  for (const address of [-1n, getMaxAddress() + 1n, Number.MAX_SAFE_INTEGER + 1, '0xZZ']) {
    assert.throws(() => normalizeAddress(address))
  }
  assert.equal(normalizeAddress('4096'), 0x1000n)
  assert.throws(() => readBytes(null, getMaxAddress(), 2, process.pid), /地址空间/)
})
await check('pre-aborted calls have no effects', async () => {
  const instance = await mount()
  try {
    const controller = new AbortController()
    controller.abort()
    const baseline = getProcessHandleCount()
    const result = await instance.ctx.tools.execute({ name: 'mem_open', arguments: { pid: process.pid }, callId: 'abort-test', signal: controller.signal })
    assert.equal(result.isError, true)
    assert.equal(getProcessHandleCount(), baseline)
  } finally { await instance.dispose() }
})
// The self branch runs through GetModuleHandleW; this is the only coverage of the
// cross-process branch (OpenProcess + K32EnumProcessModules), which every
// `module-base.js <PID>` user depends on.
await check('cross-process module base resolution and read', async () => {
  // stdio:'ignore' keeps spawn legal inside the restricted DSH sandbox, which
  // forbids the piped stdio used by node --test.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await once(child, 'spawn')
    const pid = child.pid
    assert.notEqual(pid, process.pid)
    // 'spawn' fires at CreateProcess time, before the new process has any
    // enumerable module. Poll instead of racing: a real regression still fails,
    // just after the deadline.
    const deadline = Date.now() + 5000
    let address
    for (;;) {
      try { address = getMainModuleAddress(pid); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await setTimeout(25)
      }
    }
    assert.notEqual(address, 0n)
    assert.ok(address <= getMaxAddress())
    const handle = openProcessReadOnly(pid)
    try {
      assert.equal(readBytes(handle, address, 2, pid).toString('hex'), '4d5a')
    } finally { closeHandle(handle) }
  } finally {
    child.kill()
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  }
})
await check('real Cordis, real ToolRuntime, isolated instances and native handle cleanup', async () => {
  const a = await mount()
  const b = await mount()
  try {
    const address = formatAddress(getMainModuleAddress())
    const baseline = getProcessHandleCount()
    const opened = await call(a, 'mem_open', { pid: process.pid })
    assert.equal(getProcessHandleCount(), baseline + 1)
    const args = { sessionId: opened.sessionId, address, size: 2 }
    assert.equal((await call(a, 'mem_read', args)).hex, '4d 5a')
    assert.equal((await run(b, 'mem_read', args)).isError, true)
    assert.equal((await call(a, 'mem_read', { pid: process.pid, address, size: 2 })).ascii, 'MZ')
    assert.equal(getProcessHandleCount(), baseline + 1)
    const failure = await run(a, 'mem_read', { pid: process.pid, address: '0x0', size: 2 })
    assert.equal(failure.isError, true)
    assert.match(JSON.stringify(failure.content), /错误码 [1-9]\d*/)
    assert.equal(getProcessHandleCount(), baseline + 1)
    assert.equal((await run(a, 'mem_read', { ...args, size: '2' })).isError, true)
    await a.fiber.dispose()
    assert.equal(getProcessHandleCount(), baseline)
    assert.equal(a.ctx.tools.schemas().length, 0)
    const other = await call(b, 'mem_open', { pid: process.pid })
    assert.notEqual(other.sessionId, opened.sessionId)
    await call(b, 'mem_close', { sessionId: other.sessionId })
    assert.equal(getProcessHandleCount(), baseline)
    await call(b, 'mem_open', { pid: process.pid })
    await call(b, 'mem_open', { pid: process.pid })
    assert.equal(getProcessHandleCount(), baseline + 2)
    await b.fiber.dispose()
    assert.equal(getProcessHandleCount(), baseline)
  } finally { await a.dispose(); await b.dispose() }
})
console.log(`${passed} regression groups passed (${process.version})`)
