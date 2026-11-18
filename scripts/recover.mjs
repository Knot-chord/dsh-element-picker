/**
 * recover.mjs — 从 pnpm 在沙箱里留下的插件副本恢复仓库文件。
 *
 *   node scripts/recover.mjs                 # 预览：会补哪些文件
 *   node scripts/recover.mjs --apply         # 执行恢复（只补缺失，不覆盖较新的）
 *
 * 背景：`dsh plugin add <dir>` 用 file: 协议会把插件目录**复制**进 profile 的
 * node_modules，所以沙箱里存着一份快照；仓库文件被误删后可以从这里复原。
 * 只写缺失文件；同名文件已存在且更新时保留仓库版本。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 恢复源按可信度排序：载入版（纯净副本）优先，其次共享沙箱。
const SANDBOX_ROOTS = [
  process.env.DSH_ELEMENT_REF_INSTALLED || 'D:/Deepseek Hardness/dsh-workspace/plugins/element-ref',
  process.env.DSH_REF_COMPAT || 'D:/Deepseek Hardness/dsh-workspace/compat',
]
const APPLY = process.argv.includes('--apply')
const WANTED = [
  'agent.source.js', 'client.js', 'index.js', 'cdp.js', 'browsers.js',
  'package.json', 'cordis.patch.yml', 'README.md', 'icon.svg', '.gitignore',
]

/** Every copied plugin dir under the sandbox root, ranked by freshness. */
function candidates(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) { return }
    // 只认本插件：目录里有 package.json 且 name 是 dsh-element-ref，否则会把 node_modules
    // 里任何带 index.js + client.js 的第三方包都当成"快照"。
    const pkgPath = join(dir, 'package.json')
    let isOurs = false
    try {
      isOurs = JSON.parse(readFileSync(pkgPath, 'utf8')).name === 'dsh-element-ref'
    } catch (error) {
      isOurs = false
    }
    if (isOurs && entries.some((entry) => entry.name === 'index.js') && entries.some((entry) => entry.name === 'client.js')) {
      const newest = Math.max(...entries.map((entry) => {
        try { return statSync(join(dir, entry.name)).mtimeMs } catch (error) { return 0 }
      }))
      found.push({ dir, newest })
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.compat') continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  if (existsSync(root)) walk(root, 0)
  return found.sort((left, right) => right.newest - left.newest)
}

const list = SANDBOX_ROOTS.flatMap((source) => candidates(source)).sort((left, right) => right.newest - left.newest)
console.log('== 快照候选 == ' + SANDBOX_ROOTS.join(' | '))
for (const entry of list.slice(0, 5)) console.log(`  ${new Date(entry.newest).toISOString()}  ${entry.dir}`)
if (list.length === 0) {
  console.log('  没有找到可用快照')
  process.exit(1)
}
const best = list[0]

console.log('\n== 恢复计划（来源：' + best.dir + '）==')
const plan = []
for (const name of WANTED) {
  const source = join(best.dir, name)
  const target = join(REPO, name)
  const exists = existsSync(target)
  const fresh = exists ? statSync(target).mtimeMs : 0
  const sourceTime = existsSync(source) ? statSync(source).mtimeMs : 0
  const action = !existsSync(source) ? 'skip(no-source)' : !exists || sourceTime > fresh ? 'restore' : 'keep(newer)'
  plan.push({ name, source, target, action, exists, sourceTime, fresh })
  console.log(`  ${action.padEnd(14)} ${name}`)
}

if (!APPLY) {
  console.log('\n（预览模式；加 --apply 执行）')
  process.exit(0)
}

let restored = 0
for (const entry of plan) {
  if (entry.action !== 'restore') continue
  copyFileSync(entry.source, entry.target)
  restored += 1
  const bytes = statSync(entry.target).size
  console.log(`  restored ${entry.name} (${bytes} bytes)`)
}
console.log(`\n恢复 ${restored} 个文件。下一步：node scripts/test.mjs`)


