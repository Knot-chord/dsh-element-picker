/**
 * dsh-element-ref — minimal Chrome DevTools Protocol client.
 *
 * One WebSocket per browser (not per tab): pages are attached as flattened
 * sessions, so a new tab opened while picking is armed is picked up through
 * `Target.setDiscoverTargets`, and a cross-origin iframe (OOPIF) is attached
 * from its page session and armed the same way — the same agent runs there and
 * reports the frame it lives in.
 *
 * Node's global WebSocket (undici) is used, so this module has no dependency
 * beyond Node builtins. Node/undici sends no Origin header, which is why a
 * browser started with a plain `--remote-debugging-port` accepts us without
 * `--remote-allow-origins`.
 *
 * @module dsh-element-ref/cdp
 */

const BINDING = '__dshRefPick'
const OPEN_TIMEOUT = 8000
const COMMAND_TIMEOUT = 8000

/** GET a JSON endpoint with a short timeout; null when it does not answer. */
export function httpJson(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return fetch(url, { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .finally(() => { clearTimeout(timer) })
}

/** A DevTools endpoint for this port, or null. */
export async function probePort(port) {
  const version = await httpJson(`http://127.0.0.1:${port}/json/version`)
  if (!version || typeof version.webSocketDebuggerUrl !== 'string') return null
  return version
}

/** One CDP browser connection with flattened page/iframe sessions. */
export class CdpBrowser {
  /**
   * @param {{ id: string, label: string, port: number, script: string, options: object }} options
   *   `script` is the agent source; `options` its arm() argument.
   */
  constructor(options) {
    this.id = options.id
    this.label = options.label
    this.port = options.port
    this.script = options.script
    this.build = typeof options.build === 'string' ? options.build : ''
    this.armOptions = options.options || {}
    this.socket = null
    this.closed = false
    this.armed = false
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.sessions = new Map()
    this.scripts = new Map()
    this.attached = new Set()
    this.targets = []
    this.onClosed = null
  }

  /** @param {(event: { name: string, params: object, sessionId: string }) => void} listener */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async open() {
    const version = await probePort(this.port)
    if (version === null) throw new Error('no devtools endpoint on port ' + this.port)
    this.version = version
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('devtools websocket timeout')) }, OPEN_TIMEOUT)
      if (typeof timer.unref === 'function') timer.unref()
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('devtools websocket error')) }, { once: true })
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('devtools websocket closed')) }, { once: true })
    })
    socket.addEventListener('message', (event) => { this.handleMessage(event) })
    socket.addEventListener('close', () => { this.handleClose() })
    socket.addEventListener('error', () => { this.handleClose() })
    return this
  }

  handleClose() {
    this.closed = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('devtools connection closed'))
    }
    this.pending.clear()
    if (typeof this.onClosed === 'function') {
      const notify = this.onClosed
      this.onClosed = null
      try {
        notify()
      } catch (error) {
        /* listener failure must not escape */
      }
    }
  }

  handleMessage(event) {
    let message = null
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch (error) {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message || 'devtools error'}`))
      } else entry.resolve(message.result || {})
      return
    }
    if (typeof message.method !== 'string') return
    // Every fresh default-world execution context is armed as it appears: a tab
    // that navigates (or that we attach to after the fact) never ends up without
    // the agent, no matter how the navigation raced our attach.
    if (message.method === 'Runtime.executionContextCreated' && this.armed === true && typeof message.sessionId === 'string') {
      const context = message.params ? message.params.context : null
      const mainWorld = context && context.auxData && context.auxData.isDefault === true
      if (mainWorld) {
        void this.send('Runtime.evaluate', { expression: this.installSource, contextId: context.id }, message.sessionId).catch(() => {})
      }
    }
    const payload = { name: message.method, params: message.params || {}, sessionId: message.sessionId || '' }
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch (error) {
        /* one listener must not break dispatch */
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed || this.socket === null) return Promise.reject(new Error('devtools connection closed'))
    const id = ++this.nextId
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('devtools command timeout: ' + method))
      }, COMMAND_TIMEOUT)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.socket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Script re-installed on every new document in a target. */
  get installSource() {
    const options = JSON.stringify({ ...this.armOptions, binding: BINDING })
    // The build stamp makes an already-installed page replace an older kernel
    // instead of silently keeping it (that failure looks like "new fields missing").
    const stamp = this.build === '' ? '' : `window.__dshRefBuild=${JSON.stringify(this.build)};`
    return `${stamp}${this.script}\n;window.__dshRef&&window.__dshRef.arm(${options});`
  }

  /**
   * Discover and arm every page target now.
   * @returns {Promise<Array<{ id: string, url: string, title: string, type: string }>>}
   */
  async arm() {
    this.armed = true
    await this.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = await this.send('Target.getTargets')
    for (const info of targetInfos || []) {
      if (info.type !== 'page') continue
      if (!this.worthArming(info.url)) continue
      const entry = { id: info.targetId, url: String(info.url || ''), title: String(info.title || ''), type: 'page' }
      if (!this.targets.some((target) => target.id === entry.id)) this.targets.push(entry)
      try {
        await this.attach(entry.id)
      } catch (error) {
        /* one stubborn tab must not block the rest */
      }
    }
    return this.targets
  }

  /**
   * Re-scan the browser while a session is armed: a tab that was blank at arm
   * time, or a tab opened later, gets attached here even if its events were
   * missed. Idempotent; safe to call on a timer.
   * @returns the live target list
   */
  async reconcile() {
    if (this.closed) return this.targets
    try {
      const { targetInfos } = await this.send('Target.getTargets')
      for (const info of targetInfos || []) {
        if (info.type !== 'page' || !this.worthArming(info.url)) continue
        const entry = { id: info.targetId, url: String(info.url || ''), title: String(info.title || ''), type: 'page' }
        const known = this.targets.find((target) => target.id === entry.id)
        if (known === undefined) this.targets.push(entry)
        else {
          known.url = entry.url
          known.title = entry.title
        }
        if (!this.attached.has(entry.id)) {
          try {
            await this.attach(entry.id)
          } catch (error) {
            /* retried on the next tick */
          }
        }
      }
    } catch (error) {
      /* connection dropped: the session's own teardown handles it */
    }
    return this.targets
  }

  /** DevTools pages, extension pages and empty tabs are not useful references. */
  worthArming(url) {
    const text = String(url || '')
    if (text === '' || text === 'about:blank') return false
    if (/^(devtools|chrome|edge|chrome-extension|chrome-untrusted|about):/i.test(text)) return false
    return true
  }

  async attach(targetId) {
    if (this.attached.has(targetId) || this.closed) return
    this.attached.add(targetId)
    const result = await this.send('Target.attachToTarget', { targetId, flatten: true })
    if (!result || typeof result.sessionId !== 'string') return
    await this.setupSession(result.sessionId, 'page', targetId)
  }

  async setupSession(sessionId, type, targetId) {
    if (this.sessions.has(sessionId)) return
    this.sessions.set(sessionId, { type, targetId })
    try {
      await this.send('Runtime.enable', {}, sessionId)
      await this.send('Page.enable', {}, sessionId)
      try {
        await this.send('Runtime.addBinding', { name: BINDING }, sessionId)
      } catch (error) {
        /* an older protocol without addBinding on this context */
      }
      try {
        const added = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: this.installSource }, sessionId)
        if (added && typeof added.identifier === 'string') this.scripts.set(sessionId, added.identifier)
      } catch (error) {
        /* page races a navigation: the evaluate below still arms the live document */
      }
      await this.send('Runtime.evaluate', { expression: this.installSource, awaitPromise: false }, sessionId)
      if (type === 'page') {
        try {
          await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
        } catch (error) {
          /* OOPIF support is optional */
        }
      }
    } catch (error) {
      this.sessions.delete(sessionId)
    }
  }

  /** Detach every target and close the connection. */
  async disarm() {
    this.armed = false
    if (this.closed) return
    const sessions = [...this.sessions.keys()]
    await Promise.all(sessions.map(async (sessionId) => {
      try {
        await this.send('Runtime.evaluate', { expression: 'window.__dshRef&&window.__dshRef.disarm()', awaitPromise: false }, sessionId)
      } catch (error) {
        /* target already gone */
      }
      const identifier = this.scripts.get(sessionId)
      if (identifier) {
        try {
          await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
        } catch (error) {
          /* target already gone */
        }
      }
      try {
        await this.send('Target.detachFromTarget', { sessionId })
      } catch (error) {
        /* target already gone */
      }
    }))
    this.sessions.clear()
    this.scripts.clear()
    this.attached.clear()
    this.close()
  }

  close() {
    this.armed = false
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch (error) {
        /* already closed */
      }
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('devtools connection closed'))
    }
    this.pending.clear()
  }
}

/** Best target for a page URL: exact match, then same origin, then the first page. */
export function pickTargetFor(targets, page) {
  const list = targets || []
  if (list.length === 0) return null
  let wanted = null
  try {
    wanted = page ? new URL(page) : null
  } catch (error) {
    wanted = null
  }
  if (wanted === null) return list[0]
  let sameOrigin = null
  for (const target of list) {
    let url = null
    try {
      url = target.url ? new URL(target.url) : null
    } catch (error) {
      url = null
    }
    if (url === null) continue
    if (url.href === wanted.href) return target
    if (sameOrigin === null && url.origin === wanted.origin) sameOrigin = target
  }
  return sameOrigin || list[0]
}

/** Self-contained locate-and-flash expression (no agent required on the page). */
export function flashExpression(payload) {
  const selector = JSON.stringify(String((payload && payload.selector) || ''))
  const frame = JSON.stringify(String((payload && payload.frame) || ''))
  return `(function (selector, frame) {
    try {
      var doc = document
      if (frame) {
        var steps = frame.split('>>>').map(function (s) { return s.trim() }).filter(Boolean)
        for (var i = 0; i < steps.length; i += 1) {
          var node = doc.querySelector(steps[i])
          if (!node) return 'no-frame'
          doc = node.contentDocument
          if (!doc) return 'cross-origin-frame'
        }
      }
      var parts = selector.split('>>>').map(function (s) { return s.trim() }).filter(Boolean)
      var root = doc
      var target = null
      for (var at = 0; at < parts.length; at += 1) {
        target = root.querySelector(parts[at])
        if (!target) return 'miss'
        if (at < parts.length - 1) {
          root = target.shadowRoot
          if (!root) return 'miss'
        }
      }
      target.scrollIntoView({ block: 'center', inline: 'nearest' })
      var rect = target.getBoundingClientRect()
      var marker = doc.createElement('div')
      marker.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border-radius:2px;' +
        'border:2px solid #4c8dff;background:rgba(76,141,255,0.18);transition:opacity .35s ease;' +
        'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'
      ;(doc.body || doc.documentElement).appendChild(marker)
      setTimeout(function () { marker.style.opacity = '0' }, 900)
      setTimeout(function () { if (marker.parentNode) marker.parentNode.removeChild(marker) }, 1400)
      return 'ok'
    } catch (error) {
      return 'error:' + String(error && error.message || error)
    }
  })(${selector}, ${frame})`
}

