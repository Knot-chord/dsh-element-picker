/**
 * purge-sandbox.mjs — 快速清空沙箱（保留 backup/）。
 *
 *   node scripts/purge-sandbox.mjs            # 预览要删什么
 *   node scripts/purge-sandbox.mjs --apply    # 执行
 *
 * 为什么不用 Node 递归 / PowerShell Remove-Item：
 *   沙箱里是 pnpm 的 node_modules（几万个小文件），逐条删除要几十分钟；
 *   而且 `Remove-Item -Recurse` / `rmdir /s` 会**顺着 junction 删到目标目录**
 *   （社区事故：PowerShell#26913、rimraf#299）。这里用 robocopy 把一个空目录
 *   /MIR 到目标：批量、多线程、把 junction 当条目删除，不进入目标。
 *
 * 护栏：目标必须位于沙箱根之下；解析后的真实路径不得落在仓库内。
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = process.env.DSH_REF_COMPAT || 'D:/Deepseek Hardness/dsh-workspace/compat/element-ref'
const APPLY = process.argv.includes('--apply')
const KEEP = ['backup']
const targets = ['sandboxes', 'npm-cache', 'compat-result.json'].map((name) => join(ROOT, name)).filter((path) => existsSync(path))

const realRoot = existsSync(ROOT) ? realpathSync(ROOT) : resolve(ROOT)
console.log('sandbox root: ' + realRoot)
console.log('repo        : ' + REPO)
if (REPO.toLowerCase().startsWith(realRoot.toLowerCase() + sep)) {
  console.log('refusing: the repo lives inside the sandbox root')
  process.exit(1)
}
for (const target of targets) {
  const real = existsSync(target) ? realpathSync(target) : resolve(target)
  if (!real.toLowerCase().startsWith(realRoot.toLowerCase() + sep)) {
    console.log('refusing: ' + target + ' resolves outside the sandbox root (' + real + ')')
    process.exit(1)
  }
  console.log('  target: ' + real)
}
if (targets.length === 0) {
  console.log('nothing to purge')
  process.exit(0)
}
if (!APPLY) {
  console.log('\n（预览模式；加 --apply 执行）')
  process.exit(0)
}

/**
 * Remove every reparse point inside a tree BEFORE deleting it.
 *
 * robocopy /MIR does not follow junctions that point *outside* the tree, but a junction
 * that points back INTO the repository makes it delete real repository files. So: unlink
 * each link first (a link is one entry, never recursion), and only then let robocopy run
 * over a tree that contains no reparse points at all.
 */
function stripReparsePoints(rootDir, budget = 200000) {
  let seen = 0
  let stripped = 0
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) { return }
    for (const entry of entries) {
      seen += 1
      if (seen > budget) return
      const path = join(dir, entry.name)
      let info = null
      try { info = lstatSync(path) } catch (error) { continue }
      const isLink = info.isSymbolicLink() || (() => {
        try { return realpathSync(path).toLowerCase() !== path.toLowerCase() } catch (error) { return true }
      })()
      if (isLink) {
        try {
          if (info.isDirectory()) rmdirSync(path)
          else unlinkSync(path)
          stripped += 1
        } catch (error) {
          console.log('  could not unlink ' + path + ': ' + (error.code || error.message))
        }
        continue
      }
      if (info.isDirectory()) walk(path)
    }
  }
  walk(rootDir)
  return stripped
}

console.log('== 1/2 先摘除 junction / symlink ==')
for (const target of targets) {
  const stripped = stripReparsePoints(target)
  console.log('  ' + stripped + ' 个链接已摘除：' + target)
}

const empty = join(ROOT, '.empty-purge')
mkdirSync(empty, { recursive: true })
const started = Date.now()
for (const target of targets) {
  console.log('purging ' + target)
  await new Promise((done) => {
    // robocopy 的退出码 1..7 表示成功（有差异），8 以上才是错误。
    const child = spawn('robocopy', [empty, target, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:0', '/W:0', '/MT:16'], {
      stdio: 'ignore', windowsHide: true,
    })
    child.on('close', (code) => {
      console.log('  robocopy exit ' + code)
      done()
    })
    child.on('error', (error) => {
      console.log('  robocopy failed: ' + error.message)
      done()
    })
  })
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 1 })
    console.log('  shell removed')
  } catch (error) {
    console.log('  shell left: ' + (error.code || error.message))
  }
}
try { rmSync(empty, { recursive: true, force: true }) } catch (error) { /* ignore */ }
console.log('\ndone in ' + ((Date.now() - started) / 1000).toFixed(1) + 's (kept: ' + KEEP.join(', ') + ')')

