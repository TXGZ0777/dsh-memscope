import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireKoffi = createLazyRequire('koffi', import.meta.url)
let native

function api() {
  if (native) return native
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('dsh-memscope v0.1 requires Windows x64')
  }
  const koffi = requireKoffi()
  const k32 = koffi.load('kernel32.dll')
  // Anonymous types survive module re-evaluation and coexist with other plugins.
  const entry = koffi.struct({
    dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t',
    th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32_t', cntThreads: 'uint32_t',
    th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t', dwFlags: 'uint32_t',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  })
  const pointerBits = koffi.sizeof('void *') * 8
  // v0.1 is read-only: the only process access ever requested is
  // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. No write, no allocation,
  // no region enumeration, no injection primitive is bound at all.
  native = {
    pointerBits,
    maxAddress: (1n << BigInt(pointerBits)) - 1n,
    entrySize: koffi.sizeof(entry),
    pointerAddress: (pointer) => pointer == null ? 0n : koffi.address(pointer),
    snapshot: k32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t, uint32_t)'),
    first: k32.func('__stdcall', 'Process32FirstW', 'int32_t', ['void *', koffi.inout(koffi.pointer(entry))]),
    next: k32.func('__stdcall', 'Process32NextW', 'int32_t', ['void *', koffi.inout(koffi.pointer(entry))]),
    open: k32.func('void * __stdcall OpenProcess(uint32_t, int32_t, uint32_t)'),
    close: k32.func('int32_t __stdcall CloseHandle(void *)'),
    error: k32.func('uint32_t __stdcall GetLastError()'),
    read: k32.func('int32_t __stdcall ReadProcessMemory(void *, const void *, _Out_ void *, size_t, _Out_ size_t *)'),
    module: k32.func('void * __stdcall GetModuleHandleW(const char16_t *)'),
    modules: k32.func('int32_t __stdcall K32EnumProcessModules(void *, _Out_ void *, uint32_t, _Out_ uint32_t *)'),
    current: k32.func('void * __stdcall GetCurrentProcess()'),
    count: k32.func('int32_t __stdcall GetProcessHandleCount(void *, _Out_ uint32_t *)'),
  }
  return native
}

export function getMaxAddress() { return api().maxAddress }

/** A null handle, or INVALID_HANDLE_VALUE (all bits set at pointer width). */
function isInvalidHandle(n, handle) {
  if (handle == null) return true
  const address = n.pointerAddress(handle)
  return address === 0n || BigInt.asUintN(n.pointerBits, address) === n.maxAddress
}

export function normalizePid(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) throw new Error(`PID 无效：${pid}`)
  return pid
}

export function normalizeSize(size) {
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error('读取长度必须是 1 到 4096 的整数')
  return size
}

export function normalizeAddress(address) {
  let value
  if (typeof address === 'bigint') value = address
  else if (typeof address === 'number' && Number.isSafeInteger(address)) value = BigInt(address)
  else if (typeof address === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(address.trim())) value = BigInt(address.trim())
  else throw new Error(`地址无效：${address}`)
  if (value < 0n || value > getMaxAddress()) throw new Error(`地址超出指针范围：${address}`)
  return value
}

export function validateRead(address, size) {
  const length = normalizeSize(size)
  const start = normalizeAddress(address)
  if (start + BigInt(length - 1) > getMaxAddress()) throw new Error('读取范围超出指针地址空间')
  return { address: start, size: length }
}

export function formatAddress(address) { return `0x${normalizeAddress(address).toString(16).toUpperCase()}` }

export function listProcesses() {
  const n = api()
  const snapshot = n.snapshot(0x00000002, 0)
  const snapshotError = n.error()
  if (isInvalidHandle(n, snapshot)) {
    throw new Error(`列出进程失败，系统进程快照，错误码 ${snapshotError}`)
  }
  let failure
  let result
  try {
    const entry = { dwSize: n.entrySize }
    const processes = []
    let ok = n.first(snapshot, entry)
    while (ok) {
      processes.push({ pid: entry.th32ProcessID, parentPid: entry.th32ParentProcessID,
        threads: entry.cntThreads, name: entry.szExeFile })
      ok = n.next(snapshot, entry)
    }
    const error = n.error()
    if (error !== 18) throw new Error(`列出进程失败，系统进程快照，错误码 ${error}`)
    result = processes.sort((a, b) => a.pid - b.pid)
  } catch (error) { failure = error }
  failure = closeHandlePreserving(snapshot, failure)
  if (failure) throw failure
  return result
}

export function openProcessReadOnly(pid) {
  normalizePid(pid)
  const n = api()
  const handle = n.open(0x0400 | 0x0010, 0, pid)
  const error = n.error()
  if (isInvalidHandle(n, handle)) {
    throw new Error(`打开进程失败，PID ${pid}，错误码 ${error}`)
  }
  return handle
}

export function closeHandle(handle) {
  if (handle == null || handle === 0n) return
  const n = api()
  if (!n.close(handle)) {
    const error = n.error()
    throw new Error(`关闭句柄失败，句柄 ${String(handle)}，错误码 ${error}`)
  }
}

/**
 * Close a handle from a cleanup path without hiding an in-flight failure.
 * A close failure on its own still surfaces; when `primary` is already set the
 * two causes are merged, so a failed close can never replace the original
 * Win32 error code the caller actually needs.
 */
export function closeHandlePreserving(handle, primary) {
  try {
    closeHandle(handle)
    return primary
  } catch (closeError) {
    if (primary === undefined) return closeError
    return new AggregateError([primary, closeError], '清理进程句柄失败，已保留原始错误')
  }
}

export function readBytes(handle, address, size, pid) {
  const request = validateRead(address, size)
  const n = api()
  const buffer = Buffer.alloc(request.size)
  const read = [0]
  if (!n.read(handle, request.address, buffer, request.size, read)) {
    const error = n.error()
    throw new Error(`读内存失败 @ ${formatAddress(request.address)}，PID ${pid}，错误码 ${error}`)
  }
  return buffer.subarray(0, Number(read[0]))
}

// Diagnostic helpers keep all native calls behind this module's JS interface.
export function getMainModuleAddress(pid = process.pid) {
  normalizePid(pid)
  const n = api()
  if (pid === process.pid) {
    const pointer = n.module(null)
    if (pointer == null) {
      const error = n.error()
      throw new Error(`读取主模块基址失败，PID ${pid}，错误码 ${error}`)
    }
    return n.pointerAddress(pointer)
  }
  const handle = openProcessReadOnly(pid)
  let failure
  let address
  try {
    const buffer = Buffer.alloc(8)
    const needed = [0]
    if (!n.modules(handle, buffer, buffer.length, needed)) {
      const error = n.error()
      throw new Error(`读取主模块基址失败，PID ${pid}，错误码 ${error}`)
    }
    if (needed[0] < 8) {
      // A process that has only just been created (or is already exiting) can
      // report zero enumerable modules even though the call itself succeeded.
      throw new Error(`PID ${pid} 没有可用主模块（进程可能刚启动或正在退出）`)
    }
    address = buffer.readBigUInt64LE()
  } catch (error) { failure = error }
  failure = closeHandlePreserving(handle, failure)
  if (failure) throw failure
  return address
}

export function getProcessHandleCount() {
  const n = api()
  const count = [0]
  if (!n.count(n.current(), count)) {
    const error = n.error()
    throw new Error(`读取句柄数量失败，PID ${process.pid}，错误码 ${error}`)
  }
  return count[0]
}
