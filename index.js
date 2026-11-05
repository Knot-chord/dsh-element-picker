/**
 * dsh-element-picker — 宿主半边。
 *
 * DSH 之外的元素由 Windows UI Automation 读取：`native/os-pick.ps1` 常驻、监听全局
 * 热键，按下后读取光标下的控件并发到这里；客户端轮询同一份状态，把结果变成引用
 * chip。除此之外宿主只提供这两条回环 HTTP 路由，不注册任何服务。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'element-picker'
export const inject = ['webServer']

const ROUTE = '/element-picker/os'
const MAX_BODY = 64 * 1024
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** @param {import('node:http').ServerResponse} res */
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

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, hotkey?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const hotkey = typeof config.hotkey === 'string' && config.hotkey !== '' ? config.hotkey : 'Ctrl+Alt+P'

  /** @type {{ revision: number, pick: object | null }} */
  const state = { revision: 0, pick: null }
  const health = { helper: false, error: '', hotkey, startedAt: 0 }

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === `${ROUTE}/pick` && req.method === 'POST') {
        const pick = await readJson(req)
        state.pick = { ...pick, receivedAt: Date.now() }
        state.revision += 1
        health.error = ''
        sendJson(res, 200, { ok: true, revision: state.revision })
        return
      }

      if (url.pathname === `${ROUTE}/state` && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0')
        const fresh = Number.isFinite(since) && since < state.revision
        sendJson(res, 200, {
          revision: state.revision,
          hotkey,
          enabled,
          helper: health.helper,
          error: health.error,
          pick: fresh ? state.pick : null,
        })
        return
      }

      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error) })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'element-picker: OS pick routes',
  )

  ctx.effect(() => {
    if (!enabled) return () => {}
    const script = join(dirname(fileURLToPath(import.meta.url)), 'native', 'os-pick.ps1')
    if (!existsSync(script)) {
      health.error = 'native/os-pick.ps1 missing'
      return () => {}
    }

    let child = null
    let stopped = false
    let restart = null

    const start = () => {
      restart = null
      if (stopped || child !== null) return
      let origin = ''
      try {
        origin = ctx.webServer.getOrigin()
      } catch (error) {
        health.error = 'no web origin'
        return
      }
      try {
        child = spawn(
          POWERSHELL,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BaseUrl', origin, '-Hotkey', hotkey],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        health.error = String(error).slice(0, 200)
        return
      }
      health.helper = true
      health.startedAt = Date.now()
      child.unref()
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk) => {
        health.error = String(chunk).trim().slice(0, 200)
      })
      child.on('exit', () => {
        child = null
        health.helper = false
        if (!stopped) restart = setTimeout(start, 4000)
      })
    }

    start()

    return () => {
      stopped = true
      if (restart !== null) clearTimeout(restart)
      if (child !== null) {
        const dying = child
        child = null
        // Close the pipes first: killing a child whose stdio handles are still open
        // during host shutdown trips libuv's assertion on Windows.
        try {
          dying.stdout?.destroy()
          dying.stderr?.destroy()
          dying.kill()
        } catch (error) {
          /* already gone */
        }
      }
      health.helper = false
    }
  }, 'element-picker: OS pick helper')
}
