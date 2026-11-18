/**
 * End-to-end smoke test against a RUNNING DSH window (the plugin installed and
 * enabled). It exercises the real contract: the Host's routes, the CDP session,
 * the in-page agent and the payload it produces — everything except the
 * composer chip, which needs a person in the UI.
 *
 *   node scripts/smoke.mjs                     # use an already running browser
 *   node scripts/smoke.mjs --launch            # let the plugin start its own
 *   node scripts/smoke.mjs --port 9222         # pin a debugging port
 *   node scripts/smoke.mjs --origin http://127.0.0.1:10108
 *
 * With --launch the browser it started is closed again at the end.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CdpBrowser, flashExpression, pickTargetFor } from '../cdp.js'

const args = process.argv.slice(2)
function option(name, fallback) {
  const at = args.indexOf('--' + name)
  if (at === -1) return fallback
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) return true
  return value
}

const origin = String(option('origin', 'http://127.0.0.1:10108'))
const launch = option('launch', false) === true
const pinned = option('port', '')

const log = (...parts) => console.log('-', ...parts)
const fail = (message) => {
  console.error('FAIL:', message)
  process.exit(1)
}

async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(origin + '/element-ref' + path, init)
  const text = await response.text()
  if (!response.ok) fail(`${path} answered ${response.status}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch (error) {
    return fail(`${path} did not answer JSON: ${text.slice(0, 200)}`)
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/* 1. the Host half must be mounted */
const status = await api('/status')
log('status:', status.sources.map((source) => `${source.id}=${source.running ? 'up' : 'down'}`).join(' '))

/* 2. a debugging port, from the user or from the plugin */
let port = Number(pinned) || 0
let launchedByUs = false
if (!port && launch) {
  const started = await api('/launch', {})
  if (started.ok !== true) fail('launch failed: ' + String(started.reason))
  port = started.port
  launchedByUs = true
  log('launched', started.browser, 'on port', port)
}
if (!port) {
  const running = (status.sources || []).find((source) => source.running === true && source.port)
  if (running !== undefined) port = running.port
}
if (!port) fail('no debugging port: pass --port, or run with --launch to start the managed browser')
log('port', port)

/* 3. a page for the picker to live in */
const page = pathToFileURL(join(tmpdir(), 'element-ref-smoke.html'))
writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>element-ref smoke</title></head>
<body style="font:14px system-ui;padding:40px">
  <div id="wrap" data-testid="smoke-wrap">
    <button id="smoke-btn" class="btn primary">提交订单</button>
  </div>
  <iframe id="inner" style="width:320px;height:120px;border:1px solid #888;margin-top:16px"
    srcdoc="<body style='font:14px system-ui;padding:12px'><button id='inner-btn' class='inner'>内层按钮</button></body>"></iframe>
</body></html>`)

const browser = new CdpBrowser({ id: 'smoke', label: 'smoke', port, script: '', options: {} })
await browser.open()
const { targetInfos } = await browser.send('Target.getTargets')
const allPages = (targetInfos || [])
  .filter((info) => info.type === 'page')
  .map((info) => ({ id: info.targetId, url: String(info.url || ''), title: String(info.title || '') }))
const target = pickTargetFor(allPages.filter((entry) => browser.worthArming(entry.url)), page.href) || allPages[0]
if (target === undefined) fail('the browser has no page target')
const attached = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true })
const sessionId = attached.sessionId
await browser.send('Page.enable', {}, sessionId)
await browser.send('Runtime.enable', {}, sessionId)
// Remember what this tab was showing so the test leaves the browser as it found it.
const originalUrl = await browser.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
  .then((result) => String(result?.result?.value || ''))
  .catch(() => '')
await browser.send('Page.navigate', { url: page.href }, sessionId)
for (let attempt = 0; attempt < 40; attempt += 1) {
  const state = await browser.send('Runtime.evaluate', {
    expression: 'document.readyState + "|" + Boolean(document.getElementById("smoke-btn"))',
    returnByValue: true,
  }, sessionId)
  if (String(state?.result?.value).startsWith('complete|true')) break
  await sleep(100)
}
log('page ready')

/* 4. arm through the Host, then click the button like a person would */
const armed = await api('/arm', {})
if (armed.ok !== true) fail('arm refused: ' + String(armed.reason))
const token = String(armed.token || '')
if (token === '') fail('arm returned no token')
log('armed:', armed.browsers.map((entry) => `${entry.id}=${entry.ok ? 'ok' : entry.reason || 'failed'}`).join(' '))
const armedTargets = armed.browsers.flatMap((entry) => entry.targets || [])
if (armedTargets.length === 0) fail('the plugin armed no browser targets (is this port known to it?)')
log('targets:', armedTargets.map((entry) => entry.title || entry.url).join(' | ').slice(0, 200))

await sleep(400)
const clicked = await browser.send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(function () {
    var el = document.getElementById('smoke-btn')
    var rect = el.getBoundingClientRect()
    var options = { bubbles: true, cancelable: true, composed: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    el.dispatchEvent(new PointerEvent('pointerdown', options))
    el.dispatchEvent(new PointerEvent('pointerup', options))
    return 'clicked'
  })()`,
}, sessionId)
if (clicked?.exceptionDetails) fail('click threw: ' + JSON.stringify(clicked.exceptionDetails).slice(0, 200))

let pick = null
for (let attempt = 0; attempt < 50; attempt += 1) {
  const result = await api('/pick?token=' + encodeURIComponent(token) + '&since=0')
  if (result.state === 'pick' && result.pick) {
    pick = result.pick
    break
  }
  if (result.state === 'ended') fail('the session ended before a pick arrived: ' + String(result.reason))
  await sleep(100)
}
if (pick === null) fail('no pick arrived within 5s')
log('pick:', JSON.stringify(pick).slice(0, 400))

/* 5. the payload must be a usable reference */
const checks = [
  [typeof pick.label === 'string' && pick.label !== '', 'label'],
  [pick.kind === 'element', 'kind'],
  [String(pick.selector || '').includes('smoke-btn') || String(pick.selector || '').includes('button'), 'selector points at the button: ' + String(pick.selector)],
  [String(pick.page || '').startsWith('file://'), 'page'],
  [pick.source === 'agent' || pick.source === 'edge', 'source is a CDP browser: ' + String(pick.source)],
]
for (const [ok, name] of checks) if (!ok) fail('payload check failed: ' + name)

/* 6. flashing the reference must find it again */
const flashed = await api('/flash', { payload: { ...pick, page: page.href } })
if (flashed.ok !== true) fail('flash failed: ' + String(flashed.reason))
log('flash: ok')

/* 6b. a same-origin iframe is picked through its own document, with the frame recorded */
const innerSpot = await browser.send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(function () {
    var frame = document.getElementById('inner')
    var inner = frame && frame.contentDocument && frame.contentDocument.getElementById('inner-btn')
    if (!inner) return null
    var outer = frame.getBoundingClientRect()
    var rect = inner.getBoundingClientRect()
    return { x: Math.round(outer.left + rect.left + rect.width / 2), y: Math.round(outer.top + rect.top + rect.height / 2) }
  })()`,
}, sessionId)
const inner = innerSpot?.result?.value
if (!inner) fail('the smoke page did not expose the inner button')

const armed2 = await api('/arm', {})
if (armed2.ok !== true) fail('second arm refused')
const token2 = String(armed2.token || '')
await sleep(400)
await browser.send('Runtime.evaluate', {
  expression: `(function () {
    var options = { bubbles: true, cancelable: true, composed: true, clientX: ${inner.x}, clientY: ${inner.y} }
    var frame = document.getElementById('inner')
    var target = frame.contentDocument.getElementById('inner-btn')
    target.dispatchEvent(new PointerEvent('pointerdown', options))
    target.dispatchEvent(new PointerEvent('pointerup', options))
    return 'clicked'
  })()`,
}, sessionId)

let innerPick = null
for (let attempt = 0; attempt < 50; attempt += 1) {
  const result = await api('/pick?token=' + encodeURIComponent(token2) + '&since=0')
  if (result.state === 'pick' && result.pick) {
    innerPick = result.pick
    break
  }
  if (result.state === 'ended') fail('the iframe session ended before a pick arrived')
  await sleep(100)
}
if (innerPick === null) fail('no pick arrived for the same-origin iframe')
log('iframe pick:', JSON.stringify(innerPick).slice(0, 300))
if (innerPick.label !== '内层按钮') fail('iframe pick label: ' + String(innerPick.label))
if (!String(innerPick.frame || '').includes('inner')) fail('iframe pick did not record the frame: ' + String(innerPick.frame))
if (!String(innerPick.selector || '').includes('inner-btn')) fail('iframe pick selector: ' + String(innerPick.selector))
if (!String(innerPick.page || '').startsWith('file://')) fail('iframe pick kept the top page URL')
log('iframe reference:', JSON.stringify({ frame: innerPick.frame, frameUrl: innerPick.frameUrl }))

await api('/disarm', {})

/* 7. leave the machine as we found it */
if (originalUrl !== '' && !originalUrl.startsWith('file:') && !originalUrl.startsWith('about:')) {
  try {
    await browser.send('Page.navigate', { url: originalUrl }, sessionId)
    await sleep(1200)
  } catch (error) {
    /* the tab may be gone */
  }
}
if (launchedByUs) {
  try {
    await browser.send('Browser.close')
  } catch (error) {
    /* the window may already be gone */
  }
}
browser.close()
console.log('OK — host routes, CDP session, agent pick and flash all work')
process.exit(0)
