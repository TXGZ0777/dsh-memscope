# 本地开发

本插件为 Windows x64、DSH 0.1.7-rc.2 开发，采用纯 ESM JavaScript，无构建步骤。
GitHub 仓库是公开仓库，可直接克隆，无需访问授权。

```powershell
git clone https://github.com/TXGZ0777/dsh-memscope.git
cd dsh-memscope
npm ci
```

## 挂载与卸载

在 DSH 使用的 `<DSH_HOME>/profiles/web/cordis.patch.yml` 中添加以下数组条目，
将路径替换为当前 checkout 的绝对路径：

```yaml
- insert:
    - id: dsh-memscope
      name: 'X:/桌面/CE-dsh-mcp/lib/index.js'
```

原文件若只有 `[]`，用条目替换它；保留其他插件配置。也可以使用带备份的脚本：

```powershell
node scripts/profile.js install "<DSH_HOME>/profiles/web/cordis.patch.yml"
node scripts/profile.js uninstall "<DSH_HOME>/profiles/web/cordis.patch.yml"
```

安装或修改源码后重启 DSH Desktop，并调用 `mem_ping`。删除插件条目即可卸载；
若没有其他条目，应保留 `[]`，不能让 YAML 只剩注释。

## 验证

```powershell
node scripts/smoke-test.js
node scripts/regression.test.js
node scripts/preflight.js
```

DSH 的受限 Windows 子进程环境可能禁止管道，`node --test` 派生测试进程时可能
报 `spawn EPERM`。直接运行上述脚本。普通终端也可以执行 `npm test`。
冒烟测试检查五个只读工具；回归测试检查真实 Cordis 执行、跨进程读取、实例隔离和句柄释放。
`preflight` 检查发布元数据，不会发布包。

DSH Desktop 与终端可能使用不同的 Node。查看 `node --version`，并优先用宿主的
Node 24.9.0 复核。本机路径示例：

```powershell
& 'D:\dsh\DSH Desktop\resources\app.asar.unpacked\node_modules\node\bin\node.exe' scripts/regression.test.js
```

## 版本管理

源码、测试、锁文件、安装配置和文档进入 Git。`node_modules`、本地凭据、日志、
内部提示词和 `docs/` 官方手册镜像仅保留在本地。
`lib/win32.js` 是唯一调用 Koffi 的文件；v0.1 保持只读，不含写入和扫描功能。
