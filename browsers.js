/**
 * dsh-element-ref — browser discovery and launch.
 *
 * Three sources of a CDP endpoint, in the order the user is most likely to
 * have one:
 *
 *   agent   the browser dsh-ego-browser started (its state dir holds browser.json)
 *   attach  a Chrome/Edge/Brave someone already started with --remote-debugging-port
 *   edge    the browser this plugin launched itself, with its own persistent profile
 *
 * Nothing here talks to the DOM; it only answers "which port answers as
 * DevTools, and how do I get one".
 *
 * @module dsh-element-ref/browsers
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probePort } from './cdp.js'

/** Browser executables this plugin knows how to start, in preference order. */
const CANDIDATES = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  brave: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
}

const LABELS = { edge: 'Edge', chrome: 'Chrome', brave: 'Brave' }

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch (error) {
    return false
  }
}

/** State directories ego-lite may use for its singleton browser. */
export function egoStateDirs(env = process.env) {
  const dirs = []
  if (typeof env.EGO_LINUX_STATE_DIR === 'string' && env.EGO_LINUX_STATE_DIR !== '') dirs.push(env.EGO_LINUX_STATE_DIR)
  const local = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA : ''
  if (local !== '') {
    dirs.push(join(local, 'ego-lite-linux'))
    dirs.push(join(local, 'ego-lite'))
  }
  dirs.push(join(homedir(), '.local', 'state', 'ego-lite-linux'))
  return [...new Set(dirs)]
}

/** The port a browser wrote into `<profile>/DevToolsActivePort`, or 0. */
export function readDevToolsPort(profileDir) {
  try {
    const text = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8')
    const port = Number(String(text).split('\n')[0].trim())
    return Number.isFinite(port) && port > 0 ? port : 0
  } catch (error) {
    return 0
  }
}

/** The DSH agent browser, when dsh-ego-browser has started it. */
export async function findAgentBrowser() {
  const tried = []
  for (const dir of egoStateDirs()) {
    const stateFile = join(dir, 'browser.json')
    if (!isFile(stateFile)) continue
    let state = null
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch (error) {
      state = null
    }
    if (!state || typeof state.port !== 'number' || state.port <= 0) {
      tried.push(`${stateFile}: no port`)
      continue
    }
    const version = await probePort(state.port)
    if (version === null) {
      tried.push(`${stateFile}: port ${state.port} is stale`)
      continue
    }
    return {
      id: 'agent',
      label: 'Agent 浏览器',
      running: true,
      port: state.port,
      browser: String(version.Browser || ''),
      pid: typeof state.pid === 'number' ? state.pid : 0,
    }
  }
  return {
    id: 'agent',
    label: 'Agent 浏览器',
    running: false,
    reason: tried.length > 0 ? tried[tried.length - 1] : 'agent browser is not running',
  }
}

/** Browsers that already listen on a debugging port. */
export async function findAttachedBrowsers(ports) {
  const found = []
  const seen = new Set()
  for (const port of ports || []) {
    if (typeof port !== 'number' || port <= 0 || seen.has(port)) continue
    seen.add(port)
    const version = await probePort(port)
    if (version === null) continue
    const browser = String(version.Browser || '')
    const product = /Edg\//.test(browser) ? 'edge' : /Brave/.test(browser) ? 'brave' : 'chrome'
    found.push({
      id: 'port-' + port,
      label: `${LABELS[product] || 'Chromium'} · ${port}`,
      running: true,
      port,
      browser,
    })
  }
  return found
}

/** Where this plugin keeps its own browser profile. */
export function managedProfileDir(dshHome) {
  return join(dshHome, 'element-ref', 'edge-profile')
}

/** The plugin-managed browser instance, if it is still alive. */
export async function findManagedBrowser(profileDir) {
  const port = readDevToolsPort(profileDir)
  if (port <= 0) return { running: false, reason: 'not launched yet' }
  const version = await probePort(port)
  if (version === null) return { running: false, reason: 'launched, but the endpoint is gone' }
  return { running: true, port, browser: String(version.Browser || '') }
}

/** First existing executable: the configured one, else Edge, Chrome, Brave. */
export function resolveExecutable(preferred) {
  if (typeof preferred === 'string' && preferred !== '' && isFile(preferred)) {
    return { path: preferred, product: /msedge/i.test(preferred) ? 'edge' : /brave/i.test(preferred) ? 'brave' : 'chrome' }
  }
  const local = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA : ''
  const localCandidates = local === '' ? [] : [
    ['edge', join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['brave', join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
  ]
  for (const [product, path] of localCandidates) {
    if (isFile(path)) return { path, product }
  }
  for (const product of ['edge', 'chrome', 'brave']) {
    for (const path of CANDIDATES[product]) {
      if (isFile(path)) return { path, product }
    }
  }
  return null
}

/** The real profile of the installed browser (opt-in: needs the browser closed). */
export function userProfileDir(product) {
  const local = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA : ''
  if (local === '') return ''
  if (product === 'edge') return join(local, 'Microsoft', 'Edge', 'User Data')
  if (product === 'chrome') return join(local, 'Google', 'Chrome', 'User Data')
  return ''
}

/** Whether a Chromium profile directory is held by a running instance. */
export function profileInUse(profileDir) {
  for (const name of ['SingletonLock', 'lockfile']) {
    if (existsSync(join(profileDir, name))) return true
  }
  return false
}

/**
 * Start a browser and return the port it listens on.
 * @param {{ executable: string, profileDir: string, port?: number, timeoutMs?: number, args?: string[] }} options
 *   `port` > 0 pins a fixed debugging port (used for the user's own profile, where
 *   the port file lives outside our data directory); omission asks the browser
 *   for an ephemeral port and reads `<profile>/DevToolsActivePort`.
 * @returns {Promise<{ ok: boolean, port?: number, pid?: number, reason?: string }>}
 */
export async function launchBrowser(options) {
  const executable = options.executable
  if (!isFile(executable)) return { ok: false, reason: 'executable not found: ' + executable }
  const profileDir = options.profileDir
  try {
    mkdirSync(profileDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'profile directory is not writable' }
  }
  const fixedPort = Number(options.port) > 0 ? Math.round(Number(options.port)) : 0
  if (fixedPort > 0) {
    const existing = await probePort(fixedPort)
    if (existing !== null) return { ok: true, port: fixedPort, already: true, browser: String(existing.Browser || '') }
    if (profileInUse(profileDir)) {
      return {
        ok: false,
        reason: '该浏览器正在使用这份配置。请完全退出它（含后台进程）后重试，或改用独立配置。',
      }
    }
  }
  // A live instance already answers on its port: never delete its port file or
  // start a second process that would just forward to it.
  const alive = await findManagedBrowser(profileDir)
  if (alive.running === true) {
    return { ok: true, port: alive.port, already: true, browser: alive.browser }
  }
  try {
    rmSync(join(profileDir, 'DevToolsActivePort'), { force: true })
  } catch (error) {
    /* ignore */
  }
  const args = [
    fixedPort > 0 ? `--remote-debugging-port=${fixedPort}` : '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--new-window',
    ...(Array.isArray(options.args) ? options.args : []),
  ]
  let child = null
  try {
    child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
  child.unref()
  const deadline = Date.now() + (options.timeoutMs || 20000)
  while (Date.now() < deadline) {
    const port = fixedPort > 0 ? fixedPort : readDevToolsPort(profileDir)
    if (port > 0) {
      const version = await probePort(port)
      if (version !== null) return { ok: true, port, pid: child.pid, browser: String(version.Browser || '') }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250) })
  }
  return {
    ok: false,
    reason: '该浏览器已在运行（新进程把请求转给了旧实例）。请完全退出它再试，或改用独立配置。',
  }
}
