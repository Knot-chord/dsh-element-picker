/**
 * sync-installed.mjs — 把开发版同步成"载入的那份"。
 *
 *   node scripts/sync-installed.mjs            # 预览
 *   node scripts/sync-installed.mjs --apply    # 同步到 DSH 根目录下的载入版
 *
 * 三个地方三个用途：
 *   ① 开发版 本仓库
 *   ② 载入版 DSH 根目录/dsh-workspace/plugins/element-ref   —— DSH 真正加载的那份
 *   ③ 沙箱   DSH 根目录/dsh-workspace/compat/               —— 兼容性测试（复用）
 *
 * 只同步 `npm pack` 清单里的文件：载入版永远不会带 scripts/、dist/、.compat/ 这类开发产物。
 * 不依赖外部 tar：用 `npm pack --dry-run --json` 取清单后逐项拷贝（Node 24 + 中文路径下
 * execFileSync('tar') 会以 0xC0000409 崩溃）。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLED = process.env.DSH_ELEMENT_REF_INSTALLED || 'D:/Deepseek Hardness/dsh-workspace/plugins/element-ref'
const APPLY = process.argv.includes('--apply')

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
console.log('开发版 : ' + REPO + '  (' + pkg.name + '@' + pkg.version + ')')
console.log('载入版 : ' + INSTALLED)

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: REPO, encoding: 'utf8', shell: true, timeout: 180000 })
const parsed = JSON.parse(raw.slice(raw.indexOf('[')))
const packed = (parsed[0].files || []).map((entry) => entry.path.replaceAll('\\', '/'))
console.log('包内文件: ' + packed.length + ' 个（打包后 ' + Math.round((parsed[0].size || 0) / 1024) + ' KB）')

if (!APPLY) {
  console.log('\n（预览模式；加 --apply 会把上面这些文件同步到载入版）')
  process.exit(0)
}

// Node 的 cpSync 在目标目录已存在时会“拷进去”，对 extension/ 这类目录会套成
// extension/extension。所以按“文件”镜像：列出包内目录的前缀，逐个文件拷贝。
mkdirSync(INSTALLED, { recursive: true })
const dirPrefixes = packed
  .filter((relative) => existsSync(join(REPO, relative)) && statSync(join(REPO, relative)).isDirectory())
  .map((relative) => relative + '/')
const inScope = (relative) => packed.includes(relative) || dirPrefixes.some((prefix) => relative.startsWith(prefix))

let copied = 0
const mirror = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const source = join(dir, entry.name)
    const relative = source.slice(REPO.length + 1).replaceAll('\\', '/')
    if (entry.isDirectory()) { mirror(source); continue }
    if (!inScope(relative)) continue
    const target = join(INSTALLED, relative)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    copied += 1
  }
}
mirror(REPO)

// 清掉载入版里不在包内的旧文件（保持纯净）
let removed = 0
const prune = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const relative = path.slice(INSTALLED.length + 1).replaceAll('\\', '/')
    if (entry.isDirectory()) { prune(path); continue }
    if (!inScope(relative)) { rmSync(path, { force: true }); removed += 1 }
  }
}
prune(INSTALLED)

const total = (function count(dir) {
  let sum = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    sum += entry.isDirectory() ? count(join(dir, entry.name)) : 1
  }
  return sum
})(INSTALLED)

console.log('已同步：写入 ' + copied + ' 个，清掉过期 ' + removed + ' 个，载入版现共 ' + total + ' 个文件')
console.log('下一步：node scripts/check-pack.mjs（核对开发版与载入版逐字节一致）')


