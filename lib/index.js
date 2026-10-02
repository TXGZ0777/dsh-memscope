import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { closeHandle, closeHandlePreserving, formatAddress, listProcesses, normalizePid,
  openProcessReadOnly, readBytes, validateRead } from './win32.js'

export const name = 'dsh-memscope'
export const inject = ['tools']

const field = (type) => ({ type, required: true })
const object = (properties) => ({ type: 'object', additionalProperties: false, properties })
const output = (schema, render = (value) => JSON.stringify(value, null, 2)) => ({
  schema, render: (_args, value) => [{ type: 'text', text: render(value) }],
})

export function apply(ctx) {
  const sessions = new Map()
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    const errors = []
    for (const session of sessions.values()) {
      const failure = closeHandlePreserving(session.handle)
      if (failure) errors.push(failure)
    }
    sessions.clear()
    if (errors.length) throw new AggregateError(errors, '释放进程句柄失败')
  })

  function register(definition) {
    const execute = definition.execute
    ctx.tools.register(defineTool({ ...definition, async execute(args, exec) {
      if (disposed) throw new Error('插件实例已卸载')
      exec?.signal?.throwIfAborted()
      return execute(args)
    } }))
  }

  register({
    name: 'mem_ping', description: '确认 dsh-memscope 插件已加载。', parameters: {},
    output: output({ type: 'string' }, (value) => value),
    execute: () => 'dsh-memscope v0.1.0 已加载。',
  })

  register({
    name: 'mem_list_processes', description: '列出 Windows 进程，可按进程名过滤，按 PID 升序返回。',
    parameters: {
      nameContains: { type: 'string', description: '进程名包含的文本，不区分大小写。' },
      limit: { type: 'integer', description: '返回上限，默认 80，范围 1 到 300。' },
    },
    output: output(object({ count: field('integer'), processes: { type: 'array', required: true,
      items: object({ pid: field('integer'), parentPid: field('integer'), threads: field('integer'), name: field('string') }) } })),
    execute(args) {
      const limit = args.limit ?? 80
      if (!Number.isInteger(limit) || limit < 1 || limit > 300) throw new Error('limit 必须是 1 到 300 的整数')
      const filter = args.nameContains?.toLowerCase() ?? ''
      const processes = listProcesses().filter((p) => p.name.toLowerCase().includes(filter))
      return { count: processes.length, processes: processes.slice(0, limit) }
    },
  })

  register({
    name: 'mem_open', description: '以只读权限打开 PID，返回本插件实例的 sessionId。',
    parameters: { pid: { ...field('integer'), description: '目标进程 PID。' } },
    output: output(object({ sessionId: field('string'), pid: field('integer'), access: field('string') })),
    execute(args) {
      const pid = normalizePid(args.pid)
      const sessionId = `mem-${randomUUID()}`
      const handle = openProcessReadOnly(pid)
      try { sessions.set(sessionId, { pid, handle }) } catch (error) {
        throw closeHandlePreserving(handle, error)
      }
      return { sessionId, pid, access: 'read-only' }
    },
  })

  register({
    name: 'mem_read', description: '按地址读取 1 到 4096 字节。sessionId 优先；仅传 pid 时临时打开并关闭进程。',
    parameters: {
      sessionId: { type: 'string', description: 'mem_open 返回的会话 ID。' },
      pid: { type: 'integer', description: '临时读取的进程 PID。' },
      address: { ...field('string'), description: '0x 十六进制或十进制地址字符串。' },
      size: { ...field('integer'), description: '读取长度，1 到 4096 字节。' },
    },
    output: output(object({ pid: field('integer'), address: field('string'), size: field('integer'),
      bytesRead: field('integer'), hex: field('string'), ascii: field('string') })),
    execute(args) {
      if (args.sessionId == null && args.pid == null) throw new Error('mem_read 需要 sessionId 或 pid')
      const request = validateRead(args.address, args.size)
      let target
      const temporary = args.sessionId == null
      if (temporary) {
        const pid = normalizePid(args.pid)
        target = { pid, handle: openProcessReadOnly(pid) }
      } else {
        target = sessions.get(args.sessionId)
        if (!target) throw new Error(`sessionId 不存在或已关闭：${args.sessionId}`)
      }
      let failure
      let value
      try {
        const bytes = readBytes(target.handle, request.address, request.size, target.pid)
        value = { pid: target.pid, address: formatAddress(request.address), size: request.size,
          bytesRead: bytes.length, hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
          ascii: [...bytes].map((b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('') }
      } catch (error) { failure = error }
      // Cleanup must never replace the Win32 code that explains the real failure.
      if (temporary) failure = closeHandlePreserving(target.handle, failure)
      if (failure) throw failure
      return value
    },
  })

  register({
    name: 'mem_close', description: '关闭 mem_open 创建的会话和进程句柄。',
    parameters: { sessionId: { ...field('string'), description: '要关闭的会话 ID。' } },
    output: output({ type: 'string' }, (value) => value),
    execute(args) {
      const session = sessions.get(args.sessionId)
      if (!session) return `sessionId 不存在或已关闭：${args.sessionId}`
      // Drop the session even when the close fails, so a dead handle can never
      // stay registered and be reused by a later mem_read.
      let failure
      try { closeHandle(session.handle) } catch (error) { failure = error }
      sessions.delete(args.sessionId)
      if (failure) throw failure
      return `已关闭 ${args.sessionId}（PID ${session.pid}）`
    },
  })
}
