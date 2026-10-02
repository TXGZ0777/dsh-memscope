// Publish gate for the DSH plugin marketplace.
//
//   npm run preflight
//
// Everything here is a requirement that has actually blocked (or would block)
// publication, so it runs automatically before `npm publish` via prepublishOnly.
// It only reads files: no child processes, so it works inside the DSH sandbox.
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

const fail = (message) => failures.push(message)
const warn = (message) => warnings.push(message)

async function exists(relative) {
  try { await stat(path.join(root, relative)); return true } catch { return false }
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const PLACEHOLDER = /REPLACE_ME|TODO|CHANGEME|example\.com/i

// --- 1. identity fields the marketplace listing needs -----------------------
for (const field of ['name', 'version', 'description', 'license']) {
  const value = manifest[field]
  if (typeof value !== 'string' || !value.trim()) fail(`package.json 缺少 ${field}`)
  else if (PLACEHOLDER.test(value)) fail(`package.json 的 ${field} 仍是占位符：${value}`)
}
if (typeof manifest.author !== 'string' || PLACEHOLDER.test(manifest.author)) {
  fail(`package.json 的 author 缺失或仍是占位符：${manifest.author}`)
}
for (const field of ['repository', 'homepage', 'bugs']) {
  const url = typeof manifest[field] === 'string' ? manifest[field] : manifest[field]?.url
  if (!url) fail(`package.json 缺少 ${field}（商场条目需要公开仓库地址）`)
  else if (PLACEHOLDER.test(url)) fail(`package.json 的 ${field} 仍是占位符：${url}`)
  else if (!/github\.com/.test(url)) warn(`${field} 不是 GitHub 地址，商场 README 与截图抓取依赖 GitHub：${url}`)
}
if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
  fail('package.json 缺少 keywords（npm 检索与商场分类都用到）')
} else if (!manifest.keywords.includes('dsh-plugin')) {
  warn('keywords 建议包含 "dsh-plugin"，与精选列表的 GitHub topic 保持一致')
}

// --- 2. host compatibility declaration -------------------------------------
if (!manifest.engines?.dsh) {
  fail('package.json 缺少 engines.dsh —— 商场靠它展示宿主兼容性')
}
if (!manifest.peerDependencies?.['@deepseek-ai/dsh-tools']) {
  fail('缺少 @deepseek-ai/dsh-tools 的 peerDependencies（共享实例的 dsh 包应声明为 peer + dev）')
}
if (!manifest.devDependencies?.['@deepseek-ai/dsh-tools']) {
  warn('@deepseek-ai/dsh-tools 未声明为 devDependencies，本地测试将无法解析')
}
if (manifest.engines?.dsh && manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] &&
    manifest.engines.dsh !== manifest.peerDependencies['@deepseek-ai/dsh-tools']) {
  warn(`engines.dsh (${manifest.engines.dsh}) 与 dsh-tools peer 版本 (${manifest.peerDependencies['@deepseek-ai/dsh-tools']}) 不一致`)
}

// --- 3. os field blocks cross-platform install ------------------------------
if (manifest.os) {
  fail(`package.json 声明了 os=${JSON.stringify(manifest.os)}。npm/pnpm 会在其它平台报 EBADPLATFORM 拒绝安装，` +
       '而精选列表的准入检查就是"能用 dsh plugin add 装上"。请删除 os，只保留 lib/win32.js 里的运行时守卫。')
}
if (manifest.cpu) warn(`package.json 声明了 cpu=${JSON.stringify(manifest.cpu)}，同样会限制安装平台`)

// --- 4. bundle manifest and its patch --------------------------------------
const patchRel = manifest.dsh?.bundle?.patch
if (typeof patchRel !== 'string') fail('package.json 缺少 dsh.bundle.patch（没有它就不是可安装的 bundle）')
else {
  const patchPath = patchRel.replace(/^\.\//, '')
  if (!(await exists(patchPath))) fail(`dsh.bundle.patch 指向的文件不存在：${patchRel}`)
  else {
    const patch = await readFile(path.join(root, patchPath), 'utf8')
    if (!patch.includes(`name: ${manifest.name}`)) {
      fail(`${patchPath} 未按包名引用本插件（应含 "name: ${manifest.name}"）。` +
           '绝对路径只在开发期可用，商场安装靠包名解析。')
    }
    if (/name:\s*['"]?([A-Za-z]:[\\/]|\/)/.test(patch)) {
      fail(`${patchPath} 含绝对路径插件行，发布版本必须改为按包名引用`)
    }
  }
}

// --- 5. what actually ships -------------------------------------------------
const shipped = manifest.files ?? []
for (const required of ['lib/*.js', pathRel(patchRel)]) {
  if (!shipped.some((entry) => entry === required)) fail(`files 未包含 ${required}`)
}
function pathRel(value) { return typeof value === 'string' ? value.replace(/^\.\//, '') : value }
if (!(await exists('LICENSE'))) fail('缺少 LICENSE 文件（package.json 声明了 license 就必须有正文）')
else {
  const text = await readFile(path.join(root, 'LICENSE'), 'utf8')
  if (/<COPYRIGHT HOLDER>|REPLACE_ME|TODO/i.test(text)) fail('LICENSE 里的版权持有人仍是占位符')
}
if (!(await exists('README.md'))) fail('缺少 README.md（商场页面与详情页都读它）')

// --- 6. no development leftovers in the published tree ---------------------
const strays = []
for (const dir of ['lib', 'scripts', '']) {
  const base = path.join(root, dir)
  let entries
  try { entries = await readdir(base, { withFileTypes: true }) } catch { continue }
  for (const entry of entries) {
    if (entry.name === '.npm-cache') strays.push(`${dir ? `${dir}/` : ''}${entry.name}`)
    if (/\.bak|\.orig|\.tgz$/.test(entry.name)) strays.push(`${dir ? `${dir}/` : ''}${entry.name}`)
    if (/^probe.*\.mjs$/.test(entry.name)) strays.push(`${dir ? `${dir}/` : ''}${entry.name}`)
  }
}
if (strays.length) warn(`工作区仍有开发残留，发布前建议清理：${strays.join(', ')}`)

// --- 7. report --------------------------------------------------------------
for (const message of warnings) console.log(`WARN  ${message}`)
for (const message of failures) console.log(`FAIL  ${message}`)
if (failures.length) {
  console.log(`\npreflight 未通过：${failures.length} 项失败，${warnings.length} 项警告`)
  process.exit(1)
}
console.log(`\npreflight 通过（${warnings.length} 项警告）—— 可以发布 ${manifest.name}@${manifest.version}`)
