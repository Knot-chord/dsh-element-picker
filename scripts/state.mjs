/**
 * state.mjs — 一眼看清"三个地方，三个用途"。
 *
 *   node scripts/state.mjs
 *
 *   ① 开发版   仓库（本目录）                               —— 改代码
 *   ② 载入版   DSH 根目录/dsh-workspace/plugins/element-ref  —— DSH 加载的那份（纯净副本）
 *   ③ 沙箱     DSH 根目录/dsh-workspace/compat/              —— 兼容性测试（复用，不新建）
 *
 * 只读，不修改任何东西。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLED = process.env.DSH_ELEMENT_REF_INSTALLED || 'D:/Deepseek Hardness/dsh-workspace/plugins/element-ref'
const COMPAT = process.env.DSH_REF_COMPAT || 'D:/Deepseek Hardness/dsh-workspace/compat'
const PROFILE_LINK = 'C:/Users/Z1234/.dsh/profiles/desktop/node_modules/dsh-element-ref'

const sha = (path) => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12) } catch (error) { return '?' }
}
const countFiles = (dir) => {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      try { if (!lstatSync(path).isSymbolicLink()) total += 1 } catch (error) { /* ignore */ }
    }
  }
  walk(dir)
  return total
}

/** ① 开发版 */
console.log('① 开发版（改代码的地方）')
console.log('   ' + REPO)
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const devFiles = ['index.js', 'client.js', 'cdp.js', 'browsers.js', 'agent.source.js', 'package.json']
console.log('   ' + pkg.name + '@' + pkg.version + ' · ' + countFiles(REPO) + ' 文件 · package.json hash ' + sha(join(REPO, 'package.json')))
for (const name of devFiles) if (!existsSync(join(REPO, name))) console.log('   MISS ' + name)

/** ② 载入版 */
console.log('\n② 载入版（DSH 真正加载的那份）')
console.log('   ' + INSTALLED)
if (!existsSync(INSTALLED)) {
  console.log('   不存在 —— 先运行 node scripts/sync-installed.mjs --apply')
} else {
  console.log('   ' + countFiles(INSTALLED) + ' 文件（应等于 npm pack 的数量）')
  const drift = devFiles.filter((name) => existsSync(join(REPO, name)) && sha(join(REPO, name)) !== sha(join(INSTALLED, name)))
  console.log('   与开发版差异: ' + (drift.length === 0 ? '无（逐字节一致）' : drift.join(', ')))
  if (existsSync(PROFILE_LINK)) {
    let target = PROFILE_LINK
    try { target = resolve(dirname(PROFILE_LINK), readlinkSync(PROFILE_LINK)) } catch (error) { /* real dir */ }
    const same = target.toLowerCase() === resolve(INSTALLED).toLowerCase()
    console.log('   desktop profile → ' + target + (same ? '  ✔ 指向载入版' : '  ✘ 不指向载入版'))
  }
}

/** ③ 沙箱 */
console.log('\n③ 沙箱（兼容性测试，复用现有）')
console.log('   ' + COMPAT)
const home = join(COMPAT, 'dsh-home')
const profiles = existsSync(join(home, 'profiles'))
  ? readdirSync(join(home, 'profiles'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : []
console.log('   dsh-home profiles: ' + (profiles.join(', ') || '(空)'))
const npx = join(COMPAT, 'npm-cache', '_npx')
const versions = existsSync(npx)
  ? readdirSync(npx, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    try { return JSON.parse(readFileSync(join(npx, entry.name, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version } catch (error) { return entry.name + '(损坏)' }
  })
  : []
console.log('   已装 DSH 版本: ' + (versions.join(', ') || '(无)'))
const link = join(home, 'profiles/compat/node_modules/dsh-element-ref')
if (existsSync(link)) {
  let target = link
  try { target = resolve(dirname(link), readlinkSync(link)) } catch (error) { /* real dir */ }
  console.log('   compat profile 里的插件 → ' + target)
} else {
  console.log('   compat profile 里未装插件（跑 node scripts/compat.ps1 会装上）')
}
