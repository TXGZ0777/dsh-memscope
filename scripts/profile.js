import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseDocument, isSeq, isMap } from 'yaml'

const [mode, path] = process.argv.slice(2)
if (!['install', 'uninstall'].includes(mode) || !path) {
  throw new Error('Usage: node scripts/profile.js install|uninstall <cordis.patch.yml>')
}
const original = await readFile(path, 'utf8')
const document = parseDocument(original)
if (document.errors.length) throw document.errors[0]
if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML array')
const entries = document.contents.items
const targetIds = ['dsh-memscope']
for (let i = entries.length - 1; i >= 0; i--) {
  const entry = entries[i]
  if (!isMap(entry)) continue
  if (targetIds.includes(entry.get('id'))) entries.splice(i, 1)
  else {
    const insert = entry.get('insert')
    if (!isSeq(insert)) continue
    insert.items = insert.items.filter((item) => !isMap(item) || !targetIds.includes(item.get('id')))
    if (!insert.items.length) entries.splice(i, 1)
  }
}
function add(id, relative) {
  const name = fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/')
  document.contents.add(document.createNode({ insert: [{ id, name }] }))
}
if (mode === 'install') add('dsh-memscope', '../lib/index.js')
const updated = document.toString()
if (updated !== original) {
  await writeFile(`${path}.memscope-${Date.now()}.bak`, original, { flag: 'wx' })
  if (await readFile(path, 'utf8') !== original) throw new Error('Profile changed during update; retry')
  await writeFile(path, updated)
}
console.log(`Profile ${mode}: ${path}`)
