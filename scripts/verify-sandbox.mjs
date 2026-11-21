/**
 * verify-sandbox.mjs — 共享沙箱的完整性体检（只读）。
 *
 *   node scripts/verify-sandbox.mjs
 *
 * 沙箱只有一处：D:\dsh_data\sandbox\compat
 *   compat\dsh-home\            —— 唯一 DSH_HOME（profile: compat）
 *   compat\npm-cache\_npx\*\    —— 已装的 DSH 版本（复用，不新建）
 *
 * 检查：
 *   1. profile 三件套存在
 *   2. 本插件以 link 装进 compat profile，且目标可读
 *   3. 缓存里每个版本的包完整（版本号匹配、lib/bin.js 在、node_modules 非空）
 *   4. 本地 bin：--version 正常、--dump-config 生成且含 element-ref 行
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPAT = process.env.DSH_REF_COMPAT || 'D:/Deepseek Hardness/dsh-workspace/compat'
const HOME = join(COMPAT, 'dsh-home')
const CACHE = join(COMPAT, 'npm-cache')
const NPX = join(CACHE, '_npx')
const PROFILE = 'compat'
const profileDir = join(HOME, 'profiles', PROFILE)
const results = []
const record = (item, ok, detail = '') => {
  results.push({ item, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${item}${detail ? '  — ' + detail : ''}`)
}

console.log('== 共享沙箱 ==', COMPAT)
if (!existsSync(HOME)) {
  console.log('  没有 dsh-home：先跑一次 node scripts/compat.ps1')
  process.exit(1)
}
console.log('\n[profile ' + PROFILE + ']')
const trio = ['cordis.yml', 'cordis.patch.yml', 'package.json'].filter((name) => !existsSync(join(profileDir, name)))
record('profile 配置三件套', trio.length === 0, trio.length ? '缺少 ' + trio.join(',') : '')

const link = join(profileDir, 'node_modules', 'dsh-element-ref')
let linkNote = '未安装'
let linkOk = false
if (existsSync(link)) {
  try {
    const stat = lstatSync(link)
    const target = stat.isSymbolicLink() ? resolve(dirname(link), readlinkSync(link)) : link
    linkNote = '→ ' + target
    linkOk = existsSync(join(target, 'index.js')) && existsSync(join(target, 'client.js'))
  } catch (error) {
    linkNote = '读取失败 ' + (error.code || error.message)
  }
}
record('插件按 link 装入且目标可读', linkOk, linkNote)

const versions = existsSync(NPX)
  ? readdirSync(NPX, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const pkgPath = join(NPX, entry.name, 'node_modules/@deepseek-ai/dsh/package.json')
    let version = ''
    try { version = JSON.parse(readFileSync(pkgPath, 'utf8')).version } catch (error) { version = '' }
    return { hash: entry.name, version, dir: join(NPX, entry.name) }
  })
  : []
console.log('\n[已装 DSH 版本：' + versions.length + ' 个]')
for (const entry of versions) {
  console.log('\n  [' + (entry.version || entry.hash) + ']')
  record('  版本号可读', entry.version !== '', entry.dir)
  const bin = join(entry.dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  record('  lib/bin.js 存在', existsSync(bin))
  const entries = existsSync(join(entry.dir, 'node_modules')) ? readdirSync(join(entry.dir, 'node_modules')).length : 0
  record('  node_modules 非空', entries > 5, entries + ' 个顶层条目')
  const run = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 120000 })
  const printed = String(run.stdout || '').trim()
  record('  本地 bin 可执行', run.status === 0 && (entry.version === '' || printed === entry.version), 'printed=' + JSON.stringify(printed))
  const dump = spawnSync(process.execPath, [bin, '--profile', PROFILE, '--dump-config'], {
    encoding: 'utf8', timeout: 180000, env: { ...process.env, DSH_HOME: HOME, npm_config_cache: CACHE },
  })
  const text = String(dump.stdout || '') + String(dump.stderr || '')
  record('  --dump-config 成功', dump.status === 0, 'status=' + dump.status)
  record('  配置里含 element-ref 行', /element-ref/.test(text))
}
if (versions.length === 0) record('缓存里至少有一个 DSH 版本', false, '先跑 node scripts/compat.ps1')

const failed = results.filter((entry) => !entry.ok)
console.log('\n== 汇总 ==')
console.log('  ' + versions.length + ' 个版本 | 检查项 ' + results.length + ' | 失败 ' + failed.length)
for (const entry of failed) console.log('  FAIL ' + entry.item + ' — ' + entry.detail)
process.exit(failed.length === 0 ? 0 : 1)

