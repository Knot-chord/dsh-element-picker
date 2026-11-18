/**
 * DSH Element Reference — companion extension.
 *
 * The plugin cannot open a debugging port on a browser you already use, so the
 * extension is the bridge: it asks the Host whether a pick session is armed, puts
 * the page-side picker agent into the active tab, and posts the result back. No
 * debug port, no relaunch, the browser keeps its logins.
 *
 * Transport is plain loopback HTTP on a fixed port (see ../cordis.patch.yml,
 * extensionPort): the service worker polls /state while a session is open.
 */

const BASE = 'http://127.0.0.1:45917'
const POLL_ARMED = 300
const POLL_IDLE = 1500

/** Tabs currently carrying an armed agent. */
const armedTabs = new Set()
let sessionToken = ''
let timer = 0
let busy = false

async function readJson(path, init) {
  const response = await fetch(BASE + path, { cache: 'no-store', ...init })
  if (!response.ok) throw new Error('host ' + response.status)
  return response.json()
}

/**
 * Fingerprint of the packaged picker, compared with the Host's copy to flag staleness.
 * It is re-read from disk (not memoised for the worker's lifetime): a memoised hash made
 * the badge claim "up to date" for a file that had already been replaced.
 */
let localHash = ''
let localHashAt = 0
const LOCAL_HASH_MS = 5000

async function ensureLocalHash() {
  if (localHash !== '' && Date.now() - localHashAt < LOCAL_HASH_MS) return localHash
  try {
    const source = await (await fetch(chrome.runtime.getURL('agent.js'), { cache: 'no-store' })).text()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
    localHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
  } catch (error) {
    localHash = ''
  }
  localHashAt = Date.now()
  return localHash
}

/** The Host updated the picker: an unpacked extension must be reloaded to pick up a new packaged copy. */
async function syncStaleBadge(state) {
  const hostHash = state && typeof state.agentHash === 'string' ? state.agentHash : ''
  const mine = await ensureLocalHash()
  const stale = hostHash !== '' && mine !== '' && mine !== hostHash
  // Report what this build is, so the Host can answer "is this extension current?"
  try {
    await post('/ping', { version: chrome.runtime.getManifest().version, hash: mine, hostHash, stale })
  } catch (error) {
    /* host busy: the next tick reports again */
  }
  try {
    if (mine === '' || hostHash === '') {
      // Cannot decide yet: never leave a stale "!" from an earlier build.
      await chrome.action.setBadgeText({ text: '' })
      return
    }
    await chrome.action.setBadgeText(stale ? { text: '!' } : { text: '' })
    if (stale) {
      await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' })
      await chrome.action.setTitle({ title: 'DSH 元素引用：内核已更新，请在 edge://extensions 重新加载本扩展' })
    } else {
      await chrome.action.setTitle({ title: 'DSH 元素引用：在 DSH 里点图标开始选取' })
    }
  } catch (error) {
    /* badge unsupported */
  }
}

function post(path, body) {
  return readJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The page-side picker lives in the main world, so the page can see it (and it can see the page). */
async function armTab(tabId) {
  if (armedTabs.has(tabId)) return
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['agent.js'], world: 'MAIN' })
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [{ channel: 'extension', skip: ['[data-dsh-element-ref]'] }],
      func: (options) => { if (window.__dshRef) window.__dshRef.arm(options) },
    })
    armedTabs.add(tabId)
    // Verify what the page actually runs: the file on disk, the injected copy and the
    // Host's kernel must be one and the same build.
    try {
      const [check] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => String((window.__dshRef && window.__dshRef.build) || window.__dshRefBuild || ''),
      })
      const running = String(check?.result || '')
      const host = await ensureLocalHash()
      if (running !== '' && host !== '' && running !== host) {
        // The packaged copy is newer or older than what the Host serves.
        await post('/ping', {
          version: chrome.runtime.getManifest().version,
          hash: running,
          hostHash: host,
          stale: running !== host,
          tab: tabId,
        })
      }
    } catch (error) {
      /* verification is advisory */
    }
  } catch (error) {
    /* restricted page (chrome://, the web store, a PDF viewer): nothing to arm */
  }
}

async function disarmTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => { if (window.__dshRef) window.__dshRef.disarm() },
    })
  } catch (error) {
    /* tab closed */
  }
  armedTabs.delete(tabId)
}

async function disarmAll() {
  for (const tabId of [...armedTabs]) await disarmTab(tabId)
}

/**
 * The tabs a pick session may land in: the front tab of every window plus any tab
 * already armed. "Active tab" alone is not enough — the user may be picking in a
 * second window, and a service worker's idea of "last focused window" is stale.
 */
async function candidateTabIds() {
  const tabs = await chrome.tabs.query({ active: true })
  const ids = []
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue
    if (!/^(https?|file):/i.test(String(tab.url || ''))) continue
    ids.push(tab.id)
  }
  for (const tabId of armedTabs) {
    if (ids.indexOf(tabId) === -1) ids.push(tabId)
  }
  return ids
}

async function armCandidates() {
  for (const tabId of await candidateTabIds()) await armTab(tabId)
}

/** Read the pick out of every armed tab; the agent stores it so polling is enough. */
async function readCandidates() {
  for (const tabId of [...armedTabs]) {
    let result = null
    try {
      const output = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => (window.__dshRef ? window.__dshRef.read() : null),
      })
      result = output && output[0] ? output[0].result : null
    } catch (error) {
      armedTabs.delete(tabId)
      continue
    }
    if (!result || !result.picked) continue
    const payload = result.picked
    await disarmAll()
    try {
      await post('/pick', { token: sessionToken, payload })
    } catch (error) {
      /* the session ended meanwhile */
    }
    return
  }
}

async function tick() {
  if (busy) return
  busy = true
  try {
    const state = await readJson('/state')
    void syncStaleBadge(state)
    if (state && state.armed === true && typeof state.token === 'string' && state.token !== '') {
      sessionToken = state.token
      await armCandidates()
      await readCandidates()
      schedule(POLL_ARMED)
    } else if (armedTabs.size > 0 || sessionToken !== '') {
      sessionToken = ''
      await disarmAll()
      schedule(POLL_IDLE)
    } else {
      schedule(POLL_IDLE)
    }
  } catch (error) {
    // Host closed or moved: drop any armed agent so a dead session cannot leave one behind.
    if (armedTabs.size > 0) await disarmAll()
    sessionToken = ''
    schedule(POLL_IDLE)
  } finally {
    busy = false
  }
}

function schedule(delay) {
  if (timer !== 0) clearTimeout(timer)
  timer = setTimeout(tick, delay)
}

/**
 * A Manifest V3 service worker is suspended when idle, and a suspended worker
 * polls nothing. An alarm (the shortest chrome allows, 30s) and a click on the
 * toolbar icon both wake it, so the bridge is found again without the user
 * restarting the browser.
 */
function keepAwake() {
  try {
    chrome.alarms.create('element-ref-tick', { periodInMinutes: 0.5 })
  } catch (error) {
    /* alarms unavailable: the tab events below still wake the worker */
  }
  schedule(0)
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'element-ref-tick') schedule(0)
})
// The keepalive content script holds a port and beats every 20 s; receiving a
// message resets the worker's idle timer, which is what removes the arm latency.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'element-ref-keepalive') return
  port.onMessage.addListener(() => {})
})
chrome.action.onClicked.addListener(() => { schedule(0) })
chrome.runtime.onInstalled.addListener(() => { keepAwake() })
chrome.runtime.onStartup.addListener(() => { keepAwake() })
keepAwake()

// A pick session follows the window the user is looking at.
chrome.tabs.onActivated.addListener((info) => {
  if (sessionToken !== '') void armTab(info.tabId)
})
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (sessionToken !== '' && info.status === 'complete') void armTab(tabId)
})
