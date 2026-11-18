/**
 * dsh-element-ref — the Host half.
 *
 * Owns everything the browser cannot do for itself: reading the agent browser's
 * state file, starting an external browser with a debugging port, and holding
 * one short-lived CDP pick session. The browser half drives the UI and inserts
 * the chip; this half only answers four questions:
 *
 *   GET  /element-ref/agent.js   the picker source (also used for CDP injection)
 *   GET  /element-ref/status     which browsers can be picked from right now
 *   POST /element-ref/arm        start a pick session, arm every browser target
 *   GET  /element-ref/pick       long-poll-free pickup of one result
 *   POST /element-ref/disarm     end the session
 *   POST /element-ref/flash      point at a referenced element again
 *   POST /element-ref/launch     start the plugin-managed browser
 *
 * No child helper process, no global hotkey, no UIA: a pick is armed and
 * settled over CDP, and the card is inserted by the composer's own reference
 * event.
 *
 * @module dsh-element-ref
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpBrowser, flashExpression, pickTargetFor, probePort } from './cdp.js'
import {
  findAgentBrowser, findAttachedBrowsers, findManagedBrowser, launchBrowser, managedProfileDir, profileInUse,
  resolveExecutable, userProfileDir,
} from './browsers.js'

export const name = 'element-ref'
export const inject = ['webServer']

const ROUTE = '/element-ref'
const MAX_BODY = 64 * 1024
const PICK_GRACE_MS = 15000

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Read row config defensively: a bad value falls back instead of failing the mount. */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const ports = Array.isArray(config.attachPorts)
    ? config.attachPorts.filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
    : [9222, 9223]
  return {
    enabled: config.enabled !== false,
    agentBrowser: config.agentBrowser !== false,
    edge: config.edge === 'off' ? 'off' : 'auto',
    edgeExecutable: typeof config.edgeExecutable === 'string' ? config.edgeExecutable : '',
    edgeProfileDir: typeof config.edgeProfileDir === 'string' ? config.edgeProfileDir : '',
    attachPorts: ports.length > 0 ? ports : [9222],
    sessionTtlMs: clamp(config.sessionTtlMs, 10000, 600000, 120000),
    maxTargets: clamp(config.maxTargets, 1, 40, 12),
    textDetail: config.textDetail === 'compact' || config.textDetail === 'full' ? config.textDetail : 'standard',
    textBudget: clamp(config.textBudget, 120, 4000, 520),
    extension: config.extension !== false,
    extensionPort: clamp(config.extensionPort, 1024, 65535, 45917),
    referenceStyle: config.referenceStyle === 'chip' ? 'chip' : 'quote',
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh')
  const profileDir = config.edgeProfileDir !== '' ? config.edgeProfileDir : managedProfileDir(home)

  let script = ''
  try {
    script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.source.js'), 'utf8')
  } catch (error) {
    console.error('[element-ref] picker agent source is missing:', error)
  }
  /** Short fingerprint of the kernel the Host serves, so the extension can spot a stale copy. */
  const agentHash = script === '' ? '' : createHash('sha256').update(script).digest('hex').slice(0, 16)

  /** One pick session at a time; a second arm replaces the first. */
  const session = {
    active: false,
    token: '',
    startedAt: 0,
    expiresAt: 0,
    browsers: [],
    connections: [],
    pick: null,
    revision: 0,
    reason: '',
    timer: 0,
    graceTimer: 0,
    reconcileTimer: 0,
  }

  /** Last diagnostics blob the client reported (why the guest channel failed). */
  let diagnostics = null
  const generation = 'g' + Date.now().toString(36) + randomBytes(3).toString('hex')

  function clearTimers() {
    if (session.timer !== 0) clearTimeout(session.timer)
    if (session.graceTimer !== 0) clearTimeout(session.graceTimer)
    if (session.reconcileTimer !== 0) clearInterval(session.reconcileTimer)
    session.timer = 0
    session.graceTimer = 0
    session.reconcileTimer = 0
  }

  /** Drop every CDP connection; the session itself may stay alive to be read. */
  function closeBrowsers() {
    if (session.reconcileTimer !== 0) clearInterval(session.reconcileTimer)
    session.reconcileTimer = 0
    const connections = session.connections
    session.connections = []
    for (const connection of connections) {
      void connection.disarm().catch(() => {})
    }
    for (const browser of session.browsers) {
      if (browser.ok === true && browser.targets.length > 0) browser.closed = true
    }
  }

  function endSession(reason) {
    clearTimers()
    closeBrowsers()
    session.active = false
    session.reason = reason
    session.token = ''
  }

  /** One browser target answered: this is a one-shot session. */
  function settle(payload) {
    if (!session.active) return
    session.pick = { ...payload, receivedAt: Date.now() }
    session.revision += 1
    session.reason = payload && payload.cancelled === true ? 'cancelled' : 'picked'
    closeBrowsers()
    if (session.graceTimer !== 0) clearTimeout(session.graceTimer)
    session.graceTimer = setTimeout(() => { endSession('grace-expired') }, PICK_GRACE_MS)
    if (typeof session.graceTimer.unref === 'function') session.graceTimer.unref()
    try {
      ctx.emit('element-ref/pick', payload)
    } catch (error) {
      /* no listener is fine */
    }
  }

  /** Which CDP endpoints exist right now, without arming anything. */
  async function inspectSources() {
    const sources = []
    if (config.agentBrowser) {
      const agent = await findAgentBrowser()
      sources.push({ ...agent, kind: 'agent', launchable: false })
    }
    if (config.edge !== 'off') {
      const attached = await findAttachedBrowsers(config.attachPorts)
      for (const browser of attached) sources.push({ ...browser, kind: 'attach', launchable: false })
      const managed = await findManagedBrowser(profileDir)
      const alreadyListed = attached.some((browser) => browser.port === managed.port)
      if (managed.running && !alreadyListed) {
        sources.push({ id: 'edge', label: 'Edge（引用模式）', running: true, port: managed.port, kind: 'edge', launchable: false })
      } else if (!managed.running) {
        const executable = resolveExecutable(config.edgeExecutable)
        sources.push({
          id: 'edge',
          label: executable === null ? '外部浏览器' : '外部浏览器（' + executable.product + '）',
          running: false,
          kind: 'edge',
          launchable: executable !== null,
          reason: executable === null ? 'no browser executable found' : managed.reason,
        })
      }
    }
    return sources
  }

  /** Arm every discoverable browser target for one pick session. */
  async function armSession() {
    endSession('replaced')
    session.browsers = []
    session.connections = []
    session.pick = null
    session.reason = ''
    session.revision = 0
    session.token = randomBytes(9).toString('hex')
    session.startedAt = Date.now()
    session.expiresAt = session.startedAt + config.sessionTtlMs
    session.active = true
    session.timer = setTimeout(() => { endSession('expired') }, config.sessionTtlMs)
    if (typeof session.timer.unref === 'function') session.timer.unref()

    if (script === '') {
      return { token: session.token, expiresAt: session.expiresAt, browsers: [] }
    }

    const sources = await inspectSources()
    const seenPorts = new Set()
    for (const source of sources) {
      if (source.running !== true) {
        // Report why an external browser is not pickable, so the client can point
        // at the right-click menu instead of silently offering fewer targets.
        session.browsers.push({
          id: source.id,
          label: source.label,
          kind: source.kind,
          port: source.port || 0,
          ok: false,
          reason: source.reason || '',
          launchable: source.launchable === true,
          targets: [],
          closed: false,
        })
        continue
      }
      if (seenPorts.has(source.port)) continue
      seenPorts.add(source.port)
      const channel = source.kind === 'agent' ? 'agent' : 'edge'
      const connection = new CdpBrowser({
        id: source.id,
        label: source.label,
        port: source.port,
        script,
        build: agentHash,
        options: { channel, skip: ['[data-dsh-element-ref]'] },
      })
      const status = {
        id: source.id,
        label: source.label,
        kind: source.kind,
        port: source.port,
        ok: false,
        reason: '',
        launchable: false,
        targets: [],
        closed: false,
      }
      session.browsers.push(status)
      try {
        await connection.open()
        connection.onClosed = () => { status.closed = true }
        connection.onEvent((event) => {
          if (event.name === 'Runtime.bindingCalled') {
            const params = event.params || {}
            if (params.name !== '__dshRefPick') return
            let payload = null
            try {
              payload = JSON.parse(String(params.payload || '{}'))
            } catch (error) {
              payload = null
            }
            if (payload === null || typeof payload !== 'object') return
            settle({ ...payload, source: channel })
            return
          }
          if (event.name === 'Target.targetCreated' || event.name === 'Target.targetInfoChanged') {
            const info = event.params?.targetInfo
            if (!info || info.type !== 'page') return
            status.targets = collectTargets(connection, status, info)
            if (session.active) {
              void connection.attach(info.targetId).catch(() => {})
            }
            return
          }
          if (event.name === 'Target.attachedToTarget') {
            const info = event.params?.targetInfo
            if (!info) return
            if (info.type === 'iframe') {
              // OOPIF: the agent arms inside it and reports its own frame URL.
              void connection.setupSession(event.sessionId, 'iframe', info.targetId).catch(() => {})
            }
            return
          }
          if (event.name === 'Target.targetDestroyed') {
            const targetId = event.params?.targetId
            if (typeof targetId === 'string') {
              status.targets = status.targets.filter((entry) => entry.id !== targetId)
            }
          }
        })
        const targets = await connection.arm()
        status.ok = true
        status.reason = ''
        status.targets = targets
          .filter((target) => target.id)
          .slice(0, config.maxTargets)
          .map((target) => ({ id: target.id, url: String(target.url || '').slice(0, 300), title: String(target.title || '').slice(0, 120) }))
        session.connections.push(connection)
      } catch (error) {
        status.ok = false
        status.reason = String(error && error.message ? error.message : error).slice(0, 200)
        try {
          connection.close()
        } catch (inner) {
          /* already gone */
        }
      }
      if (!session.active) break
    }

    // Safety net for anything the attach events missed (a tab that was blank when
    // the session armed, then navigated): re-scan every armed browser.
    if (session.connections.length > 0) {
      session.reconcileTimer = setInterval(() => {
        if (!session.active) return
        for (const connection of session.connections) void connection.reconcile()
      }, 1500)
      if (typeof session.reconcileTimer.unref === 'function') session.reconcileTimer.unref()
    }

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      extension: { connected: extConnected(), port: config.extensionPort },
      browsers: session.browsers.map((browser) => ({
        id: browser.id,
        label: browser.label,
        kind: browser.kind,
        ok: browser.ok,
        reason: browser.reason,
        launchable: browser.launchable === true,
        targets: browser.targets,
      })),
    }
  }

  function collectTargets(connection, status, info) {
    if (!connection.worthArming(info.url)) return status.targets
    const next = status.targets.filter((entry) => entry.id !== info.targetId)
    next.push({ id: info.targetId, url: String(info.url || '').slice(0, 300), title: String(info.title || '').slice(0, 120) })
    return next.slice(0, config.maxTargets)
  }

  /** Re-point at a referenced element in whichever browser still has that page. */
  async function flashInBrowser(payload) {
    const sources = await inspectSources()
    const seen = new Set()
    for (const source of sources) {
      if (source.running !== true || seen.has(source.port)) continue
      seen.add(source.port)
      let connection = null
      let sessionId = ''
      try {
        connection = new CdpBrowser({ id: source.id, label: source.label, port: source.port, script: '', options: {} })
        await connection.open()
        const { targetInfos } = await connection.send('Target.getTargets')
        const pages = (targetInfos || [])
          .filter((info) => info.type === 'page' && connection.worthArming(info.url))
          .map((info) => ({ id: info.targetId, url: String(info.url || ''), title: String(info.title || '') }))
        if (pages.length === 0) continue
        const target = pickTargetFor(pages, payload.page)
        if (target === null) continue
        const attached = await connection.send('Target.attachToTarget', { targetId: target.id, flatten: true })
        sessionId = attached.sessionId
        const result = await connection.send('Runtime.evaluate', {
          expression: flashExpression(payload), awaitPromise: false, returnByValue: true,
        }, sessionId)
        const value = result?.result?.value
        if (value === 'ok') return { ok: true, browser: source.label }
        if (typeof value === 'string' && value !== 'miss') return { ok: false, reason: value }
      } catch (error) {
        /* try the next browser */
      } finally {
        if (connection !== null) {
          if (sessionId !== '') {
            try {
              await connection.send('Target.detachFromTarget', { sessionId })
            } catch (error) {
              /* ignore */
            }
          }
          connection.close()
        }
      }
    }
    return { ok: false, reason: 'page-not-open' }
  }

  /** Whether the user's own browser profile can be started with a debug port. */
  function userProfileStatus() {
    try {
      const executable = resolveExecutable(config.edgeExecutable)
      if (executable === null) return { available: false, running: false, product: '' }
      const dir = userProfileDir(executable.product)
      if (dir === '') return { available: false, running: false, product: executable.product }
      return { available: true, running: profileInUse(dir), product: executable.product }
    } catch (error) {
      return { available: false, running: false, product: '' }
    }
  }

  /**
   * The extension bridge: a fixed loopback port a browser extension can poll.
   * It exists because an already-running browser cannot open a debugging port —
   * the extension is the only way to reach the browser the user actually uses.
   */
  const extensionDir = join(dirname(fileURLToPath(import.meta.url)), 'extension')
  const ext = { server: null, listening: false, error: '', lastSeenAt: 0, info: null }
  const extConnected = () => Date.now() - ext.lastSeenAt < 5000

  /** Only an extension origin may read this port from the browser; a web page gets no grant. */
  function extCors(req, res) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Cache-Control', 'no-store')
  }

  function extHandle(req, res) {
    try {
      extCors(req, res)
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      ext.lastSeenAt = Date.now()
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (path === '/state') {
        sendJson(res, 200, {
          armed: session.active,
          token: session.active ? session.token : '',
          detail: config.textDetail,
          budget: config.textBudget,
          // Lets the extension notice that its packaged agent is older than the Host's.
          agentHash: agentHash,
        })
        return
      }
      if (path === '/agent.js') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.end(script)
        return
      }
      if (path === '/ping' && req.method === 'POST') {
        void readJson(req).then((body) => {
          ext.info = body !== null && typeof body === 'object'
            ? {
              version: String(body.version || '').slice(0, 20),
              hash: String(body.hash || '').slice(0, 32),
              stale: body.stale === true,
              at: Date.now(),
            }
            : null
          sendJson(res, 200, { ok: true })
        }).catch((error) => { sendJson(res, 400, { ok: false, reason: String(error) }) })
        return
      }
      if (path === '/pick' && req.method === 'POST') {
        void readJson(req).then((body) => {
          const payload = body !== null && typeof body === 'object' && typeof body.payload === 'object' && body.payload !== null
            ? body.payload
            : null
          if (payload === null || !session.active || body.token !== session.token) {
            sendJson(res, 409, { ok: false, reason: 'no-active-session' })
            return
          }
          settle({ ...payload, source: 'extension' })
          sendJson(res, 200, { ok: true })
        }).catch((error) => { sendJson(res, 400, { ok: false, reason: String(error) }) })
        return
      }
      sendJson(res, 404, { ok: false })
    } catch (error) {
      sendJson(res, 500, { ok: false, reason: String(error) })
    }
  }

  function startExtensionServer() {
    if (config.extension !== true) return
    const server = createServer((req, res) => { extHandle(req, res) })
    server.on('error', (error) => {
      ext.listening = false
      ext.error = String(error && error.message ? error.message : error).slice(0, 160)
    })
    server.listen(config.extensionPort, '127.0.0.1', () => {
      ext.listening = true
      ext.error = ''
    })
    if (typeof server.unref === 'function') server.unref()
    ext.server = server
  }

  /** Whether the client module is in the graph the page will load on its next boot. */
  function clientModuleState() {
    try {
      const modules = ctx.get('clientModules')
      if (modules === undefined || modules === null) return 'unknown'
      const path = typeof modules.clientPath === 'function' ? modules.clientPath('dsh-element-ref') : undefined
      return typeof path === 'string' && path !== '' ? 'registered' : 'missing'
    } catch (error) {
      return 'unknown'
    }
  }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (path === `${ROUTE}/agent.js` && req.method === 'GET') {
        if (script === '') {
          sendJson(res, 500, { error: 'agent source missing' })
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(script)
        return
      }

      if (path === `${ROUTE}/status` && req.method === 'GET') {
        const sources = await inspectSources()
        sendJson(res, 200, {
          generation,
          enabled: config.enabled,
          client: clientModuleState(),
          diagnostics,
          config: {
            agentBrowser: config.agentBrowser,
            edge: config.edge,
            edgeProfileDir: profileDir,
            sessionTtlMs: config.sessionTtlMs,
            textDetail: config.textDetail,
            textBudget: config.textBudget,
            referenceStyle: config.referenceStyle,
          },
          userProfile: userProfileStatus(),
          agentHash,
          extension: {
            port: config.extensionPort,
            enabled: config.extension,
            listening: ext.listening,
            connected: extConnected(),
            lastSeenSecondsAgo: ext.lastSeenAt === 0 ? -1 : Math.round((Date.now() - ext.lastSeenAt) / 1000),
            info: ext.info,
            dir: extensionDir,
            error: ext.error,
          },
          sources,
          active: session.active
            ? {
              token: session.token,
              expiresAt: session.expiresAt,
              browsers: session.browsers.map((browser) => ({
                id: browser.id, label: browser.label, ok: browser.ok, reason: browser.reason, targets: browser.targets.length,
              })),
            }
            : null,
        })
        return
      }

      if (path === `${ROUTE}/arm` && req.method === 'POST') {
        if (!config.enabled) {
          sendJson(res, 200, { ok: false, reason: 'disabled', token: '', browsers: [] })
          return
        }
        const result = await armSession()
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (path === `${ROUTE}/pick` && req.method === 'GET') {
        const token = url.searchParams.get('token') || ''
        const since = Number(url.searchParams.get('since') || '0')
        if (!session.active) {
          sendJson(res, 200, { state: 'ended', reason: session.reason, generation })
          return
        }
        if (token !== '' && token !== session.token) {
          sendJson(res, 200, { state: 'replaced', generation })
          return
        }
        const fresh = Number.isFinite(since) && since < session.revision
        sendJson(res, 200, {
          state: fresh && session.pick !== null ? 'pick' : 'armed',
          generation,
          revision: session.revision,
          expiresAt: session.expiresAt,
          pick: fresh ? session.pick : null,
        })
        return
      }

      if (path === `${ROUTE}/diag` && req.method === 'POST') {
        void readJson(req).then((body) => {
          diagnostics = body !== null && typeof body === 'object' ? { ...body, at: Date.now() } : null
          sendJson(res, 200, { ok: true })
        }).catch((error) => { sendJson(res, 400, { ok: false, reason: String(error) }) })
        return
      }
      if (path === `${ROUTE}/disarm` && req.method === 'POST') {
        endSession('disarmed')
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === `${ROUTE}/flash` && req.method === 'POST') {
        const body = await readJson(req)
        const payload = body && typeof body.payload === 'object' && body.payload !== null ? body.payload : null
        if (payload === null) {
          sendJson(res, 400, { ok: false, reason: 'payload required' })
          return
        }
        sendJson(res, 200, await flashInBrowser(payload))
        return
      }

      if (path === `${ROUTE}/launch` && req.method === 'POST') {
        if (config.edge === 'off') {
          sendJson(res, 200, { ok: false, reason: '外部浏览器支持已关闭（config.edge）' })
          return
        }
        const body = await readJson(req)
        const wantUserProfile = body !== null && body !== undefined && body.profile === 'user'
        const executable = resolveExecutable(config.edgeExecutable)
        if (executable === null) {
          sendJson(res, 200, { ok: false, reason: '找不到可启动的浏览器，请在 config.edgeExecutable 指定路径' })
          return
        }
        let launchProfile = config.edgeProfileDir !== '' ? config.edgeProfileDir : managedProfileDir(home)
        if (wantUserProfile) {
          const userProfile = userProfileDir(executable.product)
          if (userProfile === '') {
            sendJson(res, 200, { ok: false, reason: '这个浏览器没有可识别的本机配置目录' })
            return
          }
          launchProfile = userProfile
        }
        // The user's own profile needs no port file of ours: pin the standard
        // debugging port so the attach probe finds it on the next arm.
        const launched = await launchBrowser({
          executable: executable.path,
          profileDir: launchProfile,
          port: wantUserProfile ? config.attachPorts[0] : 0,
        })
        if (launched.ok !== true) {
          sendJson(res, 200, { ok: false, reason: launched.reason })
          return
        }
        let version = null
        try {
          version = await probePort(launched.port)
        } catch (error) {
          version = null
        }
        sendJson(res, 200, {
          ok: true,
          port: launched.port,
          already: launched.already === true,
          profile: wantUserProfile ? 'user' : 'plugin',
          browser: String(version?.Browser || launched.browser || executable.product),
          profileDir: launchProfile,
        })
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'element-ref: routes',
  )
  ctx.effect(() => {
    startExtensionServer()
    return () => {
      const server = ext.server
      ext.server = null
      ext.listening = false
      if (server !== null) {
        try {
          server.close()
        } catch (error) {
          /* already closed */
        }
      }
    }
  }, 'element-ref: extension bridge')
  ctx.effect(
    () => () => { endSession('disposed') },
    'element-ref: session teardown',
  )
}




