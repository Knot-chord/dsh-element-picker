/**
 * Keeps the service worker alive while a page is open.
 *
 * MV3 suspends an idle worker, and a suspended worker cannot poll the Host — so a
 * pick session armed in DSH could sit unnoticed for up to 30 s (the alarm floor).
 * A long-lived port with a periodic message is the documented way to keep the worker
 * awake; only visible tabs send the heartbeat, so background tabs cost nothing.
 */
(() => {
  const INTERVAL = 20000
  let port = null

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'element-ref-keepalive' })
      port.onDisconnect.addListener(() => { port = null })
    } catch (error) {
      port = null
    }
  }

  function beat() {
    if (document.visibilityState !== 'visible') return
    if (port === null) connect()
    try {
      if (port !== null) port.postMessage({ at: Date.now() })
    } catch (error) {
      connect()
    }
  }

  connect()
  beat()
  setInterval(beat, INTERVAL)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') beat() })
})()
