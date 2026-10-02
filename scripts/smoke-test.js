import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'
import { formatAddress, getMainModuleAddress } from '../lib/win32.js'

const tools = new Map()
const disposers = []
const ctx = {
  effect(setup) { disposers.push(setup()) },
  tools: { register(tool) {
    assert.ok(!tools.has(tool.name))
    tools.set(tool.name, tool)
  } },
}
const call = (name, args = {}) => tools.get(name).execute(args, { signal: new AbortController().signal })
let passed = 0
async function check(label, fn) {
  await fn()
  console.log(`PASS ${label}`)
  passed++
}

try {
  assert.equal(plugin.name, 'dsh-memscope')
  assert.deepEqual(plugin.inject, ['tools'])
  plugin.apply(ctx)
  // v0.1 is exactly five read-only tools. Nothing that writes, allocates,
  // enumerates regions or scans may ever appear here.
  assert.deepEqual([...tools.keys()], ['mem_ping', 'mem_list_processes', 'mem_open', 'mem_read', 'mem_close'])
  await check('mem_ping', async () => assert.match(await call('mem_ping'), /v0\.1\.0/))
  await check('mem_list_processes contains self', async () => {
    const value = await call('mem_list_processes', { nameContains: 'NoDe.ExE', limit: 300 })
    assert.ok(value.processes.some((p) => p.pid === process.pid))
    assert.ok(value.processes.every((p, i, all) => !i || all[i - 1].pid <= p.pid))
  })
  let sessionId
  await check('mem_open', async () => {
    const opened = await call('mem_open', { pid: process.pid })
    assert.match(opened.sessionId, /^mem-[0-9a-f-]{36}$/)
    assert.equal(opened.access, 'read-only')
    sessionId = opened.sessionId
  })
  const args = { sessionId, address: formatAddress(getMainModuleAddress()), size: 2 }
  await check('mem_read MZ', async () => {
    const value = await call('mem_read', args)
    assert.equal(value.hex, '4d 5a')
    assert.equal(value.ascii, 'MZ')
    assert.equal(value.bytesRead, 2)
    assert.equal(tools.get('mem_read').output.render(args, value)[0].type, 'text')
  })
  await check('oversized read rejected', () => assert.rejects(call('mem_read', { ...args, size: 99999 }), /4096/))
  await check('null address reports nonzero Win32 error', () => assert.rejects(call('mem_read', { ...args, address: '0x0' }), /错误码 [1-9]\d*/))
  await check('unknown session rejected', () => assert.rejects(call('mem_read', { ...args, sessionId: 'missing' }), /sessionId/))
  await check('missing target rejected', () => assert.rejects(call('mem_read', { address: args.address, size: 2 }), /mem_read 需要 sessionId 或 pid/))
  await check('temporary pid read', async () => assert.equal((await call('mem_read', { pid: process.pid, address: args.address, size: 2 })).hex, '4d 5a'))
  await check('mem_close and repeated close', async () => {
    assert.match(await call('mem_close', { sessionId }), /已关闭/)
    assert.match(await call('mem_close', { sessionId }), /不存在或已关闭/)
    await assert.rejects(call('mem_read', args), /sessionId/)
  })
  console.log(`${passed} smoke checks passed (${process.version})`)
} finally {
  for (const dispose of disposers.reverse()) await dispose()
}
