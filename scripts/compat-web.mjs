/**
 * compat-web.mjs — 在一个指定版本的 DSH 上把 Web UI 真跑起来，再用无头 Edge 打开页面，
 * 检查本插件的**客户端半边**是否真的加载（而不只是"配置能生成"）。
 *
 *   node scripts/compat-web.mjs 0.2.1-rc.5
 *   node scripts/compat-web.mjs 0.2.2-rc.3 --keep      # 不关服务，便于手工看
 *
 * 隔离：DSH_HOME 落在 .compat/sandboxes/<version>；浏览器用临时 profile；结束时全部清理。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
const keep = process.argv.includes('--keep')
if (!version) {
  console.log('usage: node scripts/compat-web.mjs <dsh-version> [--keep]')
  process.exit(1)
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// One shared sandbox under the DSH install tree: the same dsh-home and npm-cache that
// compat.ps1 uses. No per-version sandbox directories.
const COMPAT = process.env.DSH_REF_COMPAT || 'D:/Deepseek Hardness/dsh-workspace/compat'
const CACHE = join(COMPAT, 'npm-cache')
const home = join(COMPAT, 'dsh-home')
const port = 38000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const env = { ...process.env, DSH_HOME: home, npm_config_cache: CACHE }

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, shell: process.platform === 'win32', ...options })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', (error) => resolve({ code: -1, out: String(error) }))
  })
}

const report = { version, home, server: '?', html: '?', hostRoute: '?', clientJs: '?', strip: '?', detail: '' }
const dsh = (args) => run('npx', ['--yes', `@deepseek-ai/dsh@${version}`, ...args])

// 1. web profile + 安装插件
// The template step returns 1 in some builds even though it creates the profile, so the
// outcome is judged by whether the profile exists, not by the exit code.
const step = await dsh(['--from-default-profile', 'web', '--dump-config'])
if (!existsSync(join(home, 'profiles', 'web'))) report.detail += 'profile-create failed; '
const install = await dsh(['plugin', '--profile', 'web', 'add', ROOT])
if (install.code !== 0) report.detail += 'plugin-add failed; '

// 2. 起 web 服务
const server = spawn('npx', ['--yes', `@deepseek-ai/dsh@${version}`, '--profile', 'web', '--port', String(port), '--no-open'], {
  env, shell: process.platform === 'win32',
})
let serverOut = ''
server.stdout?.on('data', (chunk) => { serverOut += chunk })
server.stderr?.on('data', (chunk) => { serverOut += chunk })

/** `dsh web` prints a tokenised URL; the bare port only ever answers "authentication required". */
function printedUrl() {
  const matches = [...serverOut.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/\S*/g)].map((match) => match[0].trim())
  const tokenised = matches.find((url) => url.includes('?'))
  return tokenised || matches[0] || ''
}

let html = ''
let pageUrl = `http://127.0.0.1:${port}/`
for (let attempt = 0; attempt < 180; attempt += 1) {
  try {
    const fromLog = printedUrl()
    if (fromLog !== '') pageUrl = fromLog
    // Any HTTP answer means the server is up; a tokenised URL is what actually boots
    // the shell, and the bare port answers "authentication required".
    const response = await fetch(pageUrl)
    report.server = 'PASS'
    if (response.status === 200) html = await response.text()
    break
  } catch (error) { /* not up yet */ }
  await sleep(1000)
}
if (report.server !== 'PASS') report.detail += 'server never answered; '
report.html = html.includes('dsh-element-ref') ? 'PASS' : (html === '' ? 'n/a(js-shell)' : 'MISSING')

// 3. 宿主路由
try {
  const status = await (await fetch(`http://127.0.0.1:${port}/element-ref/status`)).json()
  report.hostRoute = status && status.enabled === true ? 'PASS' : 'FAIL'
} catch (error) {
  report.hostRoute = 'FAIL'
}

// 4. 无头浏览器：客户端 JS 是否真的执行
if (report.server === 'PASS') {
  const edge = [
    join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ].find((path) => existsSync(path))
  if (!edge) {
    report.detail += 'edge not found; '
  } else {
    const profile = mkdtempSync(join(tmpdir(), 'ref-compat-'))
    const browser = spawn(edge, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--disable-gpu', '--no-default-browser-check', 'about:blank',
    ], { stdio: 'ignore' })
    try {
      let pageWs = ''
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })
          if (created.ok) {
            const target = await created.json()
            pageWs = target.webSocketDebuggerUrl || ''
            if (pageWs !== '') break
          }
        } catch (error) { /* warming up */ }
        await sleep(500)
      }
      if (pageWs === '') {
        report.detail += 'cdp target missing; '
      } else {
        await sleep(3500)
        const socket = new WebSocket(pageWs)
        const pending = new Map()
        let counter = 0
        const call = (method, params) => new Promise((resolve) => {
          const id = ++counter
          pending.set(id, resolve)
          socket.send(JSON.stringify({ id, method, params: params || {} }))
        })
        await new Promise((resolve) => { socket.onopen = resolve })
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message.result || message.error || {})
            pending.delete(message.id)
          }
        }
        const evaluate = async (expression) => {
          const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
          return result?.result?.value
        }
        const hasApi = await evaluate('typeof window.__dshElementRef === "object" && typeof window.__dshElementRef.format === "function"')
        const strip = await evaluate('document.querySelectorAll("[data-element-ref-strip]").length')
        report.clientJs = hasApi === true ? 'PASS' : 'FAIL'
        report.strip = String(strip)
        if (hasApi !== true) report.detail += 'client api missing (auth screen?); '
        try { socket.close() } catch (error) { /* closing */ }
      }
    } finally {
      if (!keep) {
        try { browser.kill() } catch (error) { /* gone */ }
        try { rmSync(profile, { recursive: true, force: true }) } catch (error) { /* locked */ }
      }
    }
  }
}

if (!keep) {
  try { server.kill() } catch (error) { /* gone */ }
  await sleep(800)
}
if (keep) console.log(`server kept on http://127.0.0.1:${port}/ (DSH_HOME=${home})`)
console.log(JSON.stringify(report))
process.exit(report.clientJs === 'PASS' ? 0 : report.server === 'PASS' ? 2 : 1)







