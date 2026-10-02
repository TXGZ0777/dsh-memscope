# dsh-memscope

Windows x64 的 **DeepSeek Harness 只读进程内存查看插件**。适配 DSH **0.1.7-rc.2**，纯 ESM JavaScript，无构建步骤。

> ## ⚠️ 能力与风险声明，请先读这段
>
> **本插件会读取其它进程的内存。** 这是它的全部意义，也是它的全部风险。
>
> - 它调用 Windows 的 `OpenProcess` / `ReadProcessMemory` 去**读取你指定的任意进程**，并会**枚举全系统进程**。
> - **只读**：不写内存、不扫描内存、不注入代码、不修改任何目标进程。
> - 权限只用 `PROCESS_QUERY_INFORMATION | PROCESS_VM_READ`，不申请写权限、不隐式提权。
> - 这个行为在系统层面与恶意软件的内存窃取手法**无法区分**，因此**杀毒软件可能会报警**。请自行判断是否信任本插件。
> - 读**以管理员运行**的进程时，DSH 本身需要以管理员运行；受保护的系统进程读不到，这是正常的。
> - **不要**拿系统进程、别人的程序或受反作弊保护的联机游戏当靶子。
>
> 上架到插件商场**不等于**经过安全审计。请阅读源码后再决定是否安装。

## 安装

源码仓库目前为私有仓库，本项目尚未由本次操作发布到 npm。
当前请按 [本地开发说明](DEVELOPMENT.md) 克隆并挂载。
下面的包名安装命令适用于将来正式发布到 npm 后：

```sh
dsh plugin --profile web add dsh-memscope
```

重启 DSH 后调用 `mem_ping` 确认加载。

需要 **Windows x64**（其它平台可以安装，但工具调用时会给出明确的平台错误）和 **DSH 0.1.7-rc.2**。

## 卸载

```sh
dsh plugin --profile web remove dsh-memscope
```

卸载会关闭本插件实例持有的全部进程句柄；旧的 `sessionId` 不可复用。

## 工具

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `mem_ping` | 无 | 版本字符串 |
| `mem_list_processes` | `nameContains?: string`；`limit?: integer`，默认 80，1–300 | `{ count, processes: [{ pid, parentPid, threads, name }] }` |
| `mem_open` | `pid: integer` | `{ sessionId, pid, access: 'read-only' }` |
| `mem_read` | `sessionId?: string` 或 `pid?: integer`；`address: string`；`size: integer`，1–4096 | `{ pid, address, size, bytesRead, hex, ascii }` |
| `mem_close` | `sessionId: string` | 关闭结果；未知 ID 返回友好提示 |

行为细节：

- 进程名过滤不区分大小写，结果按 PID 升序排列。
- `count` 是**过滤后的总数**，`processes` 才受 `limit` 限制。
- `mem_read` 的 `address` 支持十进制和 `0x` 十六进制字符串；两种目标同时传入时 `sessionId` 优先，都不给则报错。
- 只给 `pid` 时是**临时读取**：内部打开进程、读完立刻关闭，不留下句柄。
- `hex` 为小写、空格分隔的字节；ASCII 不可打印字节显示为 `.`。
- 读失败会返回**真实的 Win32 错误码**（例如 `299` 地址未映射、`87` 进程不存在、`998` 地址不可访问），便于判断原因。

## 能力边界

只读。**不做**这些事：

- ❌ 写内存（没有 `mem_write`）
- ❌ 扫描内存、未知初值过滤（没有 `mem_scan_*`）—— 这是 v0.3 的计划
- ❌ 枚举内存区域（没有 `mem_regions`）—— 这是 v0.2 的计划
- ❌ AOB 特征码、指针链、反汇编、断点
- ❌ 绕过任何进程保护、绕过反作弊
- ❌ 图形界面

因此：**读取地址必须由调用方自己提供**，本版本不会帮你搜索地址。单次最多读 4096 字节。

需要"找到金币存在哪个地址"这类能力，请用 Cheat Engine；本插件不替代它。

## 架构

`lib/win32.js` 是**唯一**加载和调用 Koffi（FFI）的文件，首次原生操作时才初始化；对外只导出普通 JS 函数，`lib/index.js` 只使用这些函数。FFI 结构体使用匿名类型并依赖 ABI 自动对齐，Win32 `BOOL` 统一按 32 位整数处理。

这样分层是为了让"换实现"只改一个文件，也让"谁打开了进程句柄"这个问题有唯一的收口。

## 安全

- 仅申请只读权限，见上文。
- 会话表是**插件实例作用域**的，插件卸载时通过 `ctx.effect` 关闭全部句柄。
- 临时读取路径在 `finally` 中关闭句柄。
- 关闭句柄失败时**不会覆盖**原始错误码，避免丢失诊断信息。

## 开发

见 [DEVELOPMENT.md](DEVELOPMENT.md)：本地挂载、测试方式、以及为什么本机上 `npm test` 与 `node --test` 行为不同。

## 许可证

[MIT](LICENSE)
