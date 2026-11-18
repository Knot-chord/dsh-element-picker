/**
 * check-pack.mjs — 发布前的"纯净性 + 一致性"检查。
 *
 *   node scripts/check-pack.mjs
 *
 * 两件事：
 *   纯净性：`npm pack --dry-run` 列出的文件必须恰好是运行时集合，不能带进
 *           开发产物（.compat / backup / node_modules / scripts / 日志）。
 *   一致性：包里每个运行时文件都必须与**当前载入 profile 的那一份**逐字节相同
 *           ——发布的那份和你在用的那份必须同一个构建。
 *
 * 任一项失败以非零退出；`prepublishOnly` 会自动先跑测试再跑它。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

/** 运行时会用到的文件：缺一个包就是残的。 */
const REQUIRED = [
  'index.js', 'client.js', 'cdp.js', 'browsers.js', 'agent.source.js',
  'cordis.patch.yml', 'package.json', 'LICENSE', 'NOTICE',
  'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'docs/DESIGN.md',
  'extension/manifest.json', 'extension/agent.js', 'extension/background.js',
  'extension/keepalive.js', 'extension/icons/16.png', 'extension/icons/128.png',
]
/** 绝不能出现在包里的东西。 */
const FORBIDDEN = [
  /^\.compat\//, /^backup\//, /^node_modules\//, /^\.git\//,
  /^scripts\//, /\.log$/, /^\.dsh-trash\//, /\.old-\d+$/,
]

let failures = 0
const fail = (message) => { failures += 1; console.log('  FAIL  ' + message) }
const pass = (message) => console.log('  PASS  ' + message)

console.log('== 1/3 打包清单 ==')
let packed = []
try {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO, encoding: 'utf8', shell: true, timeout: 180000 })
  const parsed = JSON.parse(raw.slice(raw.indexOf('[')))
  packed = (parsed[0].files || []).map((entry) => entry.path.replaceAll('\\', '/'))
  pass(`npm pack 列出 ${packed.length} 个文件（${Math.round((parsed[0].size || 0) / 1024)} KB 打包后）`)
} catch (error) {
  fail('npm pack --dry-run 失败：' + (error.message || error))
}

if (packed.length > 0) {
  const missing = REQUIRED.filter((name) => !packed.includes(name))
  if (missing.length === 0) pass('运行时文件齐全（' + REQUIRED.length + ' 项）')
  else fail('缺少运行时文件：' + missing.join(', '))

  const leaked = packed.filter((name) => FORBIDDEN.some((pattern) => pattern.test(name)))
  if (leaked.length === 0) pass('没有开发产物混进包（.compat / backup / node_modules / scripts / 日志）')
  else fail('包里混进开发产物：' + leaked.slice(0, 8).join(', '))
}

console.log('\n== 2/3 内核与扩展 ==')
const agentSource = join(REPO, 'agent.source.js')
const extensionAgent = join(REPO, 'extension/agent.js')
if (sha(agentSource) === sha(extensionAgent)) pass('extension/agent.js 与 agent.source.js 同源（' + sha(agentSource) + '）')
else fail('extension/agent.js 与 agent.source.js 不一致')

console.log('\n== 3/3 与已载入的那份对齐 ==')
const profileRoot = process.env.DSH_ELEMENT_REF_PROFILE
  || 'C:/Users/Z1234/.dsh/profiles/desktop/node_modules/dsh-element-ref'
let loadedRoot = ''
if (existsSync(profileRoot)) {
  try {
    const stat = lstatSync(profileRoot)
    loadedRoot = stat.isSymbolicLink() ? resolve(dirname(profileRoot), readlinkSync(profileRoot)) : profileRoot
  } catch (error) {
    loadedRoot = ''
  }
}
if (loadedRoot === '') {
  console.log('  SKIP  没找到已载入的插件（设置 DSH_ELEMENT_REF_PROFILE 可指定）')
} else if (loadedRoot.toLowerCase() !== REPO.toLowerCase()) {
  // 开发版与载入版是两份拷贝：这正是要核对的关系，不再跳过
  const drift = REQUIRED.filter((name) => {
    const local = join(REPO, name)
    return existsSync(local) && sha(local) !== sha(join(loadedRoot, name))
  })
  if (drift.length === 0) pass('载入版（' + loadedRoot + '）与开发版逐字节一致（' + REQUIRED.length + ' 项）')
  else fail('开发版与载入版不一致：' + drift.join(', ') + ' —— 先运行 node scripts/sync-installed.mjs --apply')
} else {
  const drift = REQUIRED.filter((name) => {
    const local = join(REPO, name)
    return existsSync(local) && sha(local) !== sha(join(loadedRoot, name))
  })
  if (drift.length === 0) pass('已载入的插件与本仓库逐字节一致（' + REQUIRED.length + ' 项）')
  else fail('已载入的插件与仓库不一致：' + drift.join(', '))
}

console.log('\n== 结果 ==')
if (failures === 0) {
  console.log('  ok — 可以发布')
  process.exit(0)
}
console.log('  ' + failures + ' 项失败，先修好再发布')
process.exit(1)


