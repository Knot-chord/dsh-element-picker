/**
 * dsh-element-ref — the browser half.
 *
 * One icon in the right sidebar's top-right control cluster starts a pick
 * session. A pick can then happen in DSH itself, in a sidebar browser page, in
 * the DSH agent browser, or in an external Edge/Chrome window — every surface
 * runs the same in-page agent (`agent.source.js`, served by the Host half), and
 * every result becomes a real composer reference chip through the composer's
 * own `slash/input-insert-reference` event.
 *
 * @module dsh-element-ref/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-element-ref',
  factory(require) {
    const React = require('react')
    const NS = 'dsh-element-ref'
    const ROUTE = '/element-ref'
    const SOURCE = 'element-ref'
    const BUTTON_ID = 'dsh-element-ref-strip'
    /** Bumped on every client-side change: diagnostics report which build is running. */
    const CLIENT_BUILD = 'c5'
    const STRIP_SKIP = '[data-element-ref-strip],[data-element-ref-menu],[data-dsh-element-ref]'
    /** The Agent-browser preview mirrors another page: it is chrome, not content. */
    const DSH_SKIP = STRIP_SKIP + ",[class*='dsh-ego-side']"
    const RECENT_KEY = 'dsh-element-ref:recent'
    const RECENT_MAX = 8
    const GUEST_POLL_MS = 180

    const CAP = { label: 56, desc: 48, selector: 180, page: 240, text: 80, frame: 120, url: 240 }

    /**
     * The one place that spells a reference block. `formatReference` writes it,
     * `parseUserBlock` reads it, and the sent-message rule is generated from it —
     * so the submitted text and its rendering cannot drift apart.
     *
     * The block has to answer "what is this and where is it" for a model that
     * cannot query the page, so a DSH pick leads with a semantic region and a
     * role/name locator instead of a positional CSS path.
     */
    const BLOCK = {
      element: '[引用元素]',
      link: '[引用链接]',
      fields: {
        page: '页面',
        title: '标签页',
        selector: '选择器',
        alternative: '备选',
        locator: '可定位',
        region: '位置',
        scale: '缩放',
        table: '表格',
        resource: '资源',
        excerpt: '摘录',
        nearby: '附近',
        owner: '所在',
        content: '内容',
        index: '序号',
        attrs: '属性',
        component: '组件',
        rect: '坐标',
        text: '文本',
        frame: '框架',
        url: '链接',
      },
    }

    /** Detail budget: everything is offered, then the highest-value lines are kept. */
    const DETAIL_RANK = { compact: 0, standard: 1, full: 2 }
    const DETAIL_BUDGET = { compact: 260, standard: 520, full: 1200 }
    let textDetail = 'standard'
    let textBudget = DETAIL_BUDGET.standard
    /** `quote` uses the composer's native quote card; `chip` uses a reference chip. */
    let referenceStyle = 'quote'
    /** Build stamp of the kernel the Host serves, so the page replaces a stale one. */
    let agentBuild = ''

    function textConfig() {
      return { detail: textDetail, budget: textBudget }
    }

    function setTextConfig(detail, budget) {
      if (DETAIL_RANK[detail] !== undefined) textDetail = detail
      const fallback = DETAIL_BUDGET[textDetail]
      textBudget = typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? Math.round(budget) : fallback
    }

    function setReferenceStyle(style) {
      referenceStyle = style === 'chip' ? 'chip' : 'quote'
    }

    const ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 9V6.5A1.5 1.5 0 0 1 5.5 5H8"/><path d="M16 5h2.5A1.5 1.5 0 0 1 20 6.5V9"/>' +
      '<path d="M20 15v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 19H5.5A1.5 1.5 0 0 1 4 17.5V15"/>' +
      '<path d="M12 8.5v7M8.5 12h7"/></svg>'

    const STYLES = [
      '[data-element-ref-strip]{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'padding:0 2px;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:6px}',
      '[data-element-ref-strip]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '[data-element-ref-strip][data-on]{color:var(--dsw-alias-state-business-primary)}',
      '[data-element-ref-strip]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '[data-element-ref-strip] svg{display:block;width:16px;height:16px}',
      '.dsh-element-ref-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;',
      'max-width:min(560px,80vw);padding:6px 12px;border-radius:8px;background:rgba(20,26,36,.95);color:#e8f3ff;',
      'font-size:12px;line-height:1.5;border:1px solid rgba(120,200,255,.35);opacity:0;pointer-events:none;',
      'transition:opacity .16s ease}',
      '.dsh-element-ref-toast[data-show]{opacity:1}',
      '.dsh-element-ref-menu{position:fixed;z-index:2147483647;min-width:250px;max-width:360px;padding:6px;',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);',
      'box-shadow:0 12px 32px rgba(0,0,0,.35);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dsh-element-ref-menu-title{padding:2px 6px 6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsh-element-ref-menu-row{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;border:0;',
      'background:transparent;border-radius:6px;padding:5px 8px;font:inherit;color:inherit;cursor:pointer;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-element-ref-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-element-ref-menu-row[data-static]{cursor:default;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-element-ref-menu-row[data-static]:hover{background:transparent}',
      '.dsh-element-ref-menu-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.5}',
      '.dsh-element-ref-menu-dot[data-ok]{background:var(--dsw-alias-state-business-primary);opacity:1}',
      // A reference block in a sent message renders as one chip: same metrics as
      // the composer's inline reference, its own classes (never the build hashes).
      '.dsh-element-ref-chip{display:inline-flex;align-items:baseline;gap:3px;max-width:240px;',
      'color:var(--dsw-alias-state-business-primary);vertical-align:baseline;user-select:none}',
      '.dsh-element-ref-chip[data-interactive]{cursor:pointer}',
      '.dsh-element-ref-chip[data-interactive]:hover{background:var(--dsw-alias-state-business-tertiary);',
      'border-radius:var(--dsw-radius-sm)}',
      '.dsh-element-ref-chip-glyph{flex:none;display:inline-flex;align-items:center;font-weight:500}',
      '.dsh-element-ref-chip-mark{font-size:13px;line-height:1;opacity:.85}',
      '.dsh-element-ref-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshElementRef = '1'
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ---------------------------------------------------------- pure format */

    function clip(value, max) {
      const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
      return text.length > max ? text.slice(0, max) : text
    }

    function parsePayload(ref) {
      try {
        const parsed = JSON.parse(String(ref))
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        return null
      }
    }

    function kindOf(payload) {
      return payload && payload.kind === 'link' ? 'link' : 'element'
    }

    /** Composer chip text: short, no newlines. */
    function chipLabel(payload) {
      if (!payload) return '引用'
      if (kindOf(payload) === 'link') return clip(payload.label || payload.url, CAP.label)
      return clip(payload.label || payload.desc || '元素', CAP.label)
    }

    /** Clipboard/persistence projection of a chip: one short line. */
    function clipboardOf(payload) {
      if (!payload) return ''
      return (kindOf(payload) === 'link' ? BLOCK.link : BLOCK.element) + ' ' + chipLabel(payload)
    }

    /**
     * What the model reads. Field order is information density; empty and
     * redundant fields are dropped, and every value has a hard cap.
     *
     * This is the ONLY writer of a reference block, and `parseUserBlock` below is
     * its reader: both use `BLOCK`, so the sent-message renderer cannot drift
     * away from the submitted text.
     * @param {object} payload
     * @returns {string} the reference block, newline-terminated
     */
    /**
     * Compose the model-facing block inside a character budget.
     *
     * Every field is offered, gated by the detail level, then taken in
     * information order until the budget is spent — so a rich element spends on
     * what a model can act on, and a huge one degrades by dropping the least
     * useful lines instead of overflowing the prompt.
     */
    function formatReference(payload, forceMarker) {
      if (!payload) return ''
      const F = BLOCK.fields
      const rank = DETAIL_RANK[textDetail]
      const lines = []
      const marker = referenceStyle === 'quote' && forceMarker !== true ? '' : BLOCK.element + ' '
      if (kindOf(payload) === 'link') {
        // Same marker rule as elements: the quote card already shows a quote mark.
        const linkMarker = referenceStyle === 'quote' && forceMarker !== true ? '' : BLOCK.link + ' '
        lines.push(linkMarker + clip(payload.label || payload.url || '', CAP.label))
        if (payload.url) lines.push(F.url + ': ' + clip(payload.url, CAP.url))
        if (payload.page && payload.page !== payload.url) lines.push(F.page + ': ' + clip(payload.page, CAP.page))
        if (payload.region) lines.push(F.region + ': ' + clip(payload.region, 90))
        if (payload.frame) lines.push(F.frame + ': ' + clip(payload.frame, CAP.frame))
        return lines.join('\n') + '\n'
      }
      const label = clip(payload.label || payload.desc || '元素', CAP.label)
      const role = clip(payload.role || '', 18)
      const state = clip(payload.state || '', 56)
      const qualify = [role, state].filter((part) => part !== '').join(', ')
      const head = marker + (qualify !== '' ? label + ' (' + qualify + ')' : label)
      const isWeb = payload.page !== undefined && payload.page !== '' && payload.source !== 'dsh'

      /** @type {{ order: number, text: string, minRank: number }[]} */
      const candidates = []
      const offer = (field, value, order, minRank = 0) => {
        if (value === undefined || value === '') return
        candidates.push({ order, minRank, text: F[field] + ': ' + value })
      }

      // A frame path is correctness, not decoration: it survives every level.
      offer('frame', payload.frame
        ? clip(payload.frameUrl ? payload.frame + ' → ' + payload.frameUrl : payload.frame, CAP.frame)
        : '', 5)
      if (isWeb) {
        offer('page', clip(payload.page, CAP.page), 10)
        offer('title', clip(payload.title, 80), 20, 1)
      }
      // Where it is and where it sits on screen are one thought for a reader: one line.
      // The box is in device pixels of the visible area (same units as a screenshot),
      // so zoom and page scaling do not make it a lie.
      const box = Array.isArray(payload.box) && payload.box.length === 4
        ? payload.box[0] + ',' + payload.box[1] + ' · ' + payload.box[2] + 'x' + payload.box[3]
        : ''
      const viewport = Array.isArray(payload.viewport) && payload.viewport.length === 2 &&
        payload.viewport[0] > 0 && payload.viewport[1] > 0
        ? '视口 ' + payload.viewport[0] + 'x' + payload.viewport[1]
        : ''
      const picture = box === '' ? '' : '画面 ' + box
      offer('region', [clip(payload.region, 90), picture, viewport].filter((part) => part !== '').join(' · '), 30)
      if (typeof payload.scale === 'number' && payload.scale > 0) offer('scale', 'x' + payload.scale, 125, 2)
      offer('table', clip(payload.table, 140), 40, 1)
      // The media the element points at: the only way to tell what a picture is.
      offer('owner', clip(payload.owner || '', 56), 35, 1)
      offer('resource', clip(payload.resource || '', 140), 45)
      if (!isWeb) offer('locator', clip(payload.locator, 90), 50)
      if (isWeb && payload.selector) {
        offer('selector', clip(payload.selector, CAP.selector), 50)
        // Two selectors in one block is a luxury: the model tries one and stops.
        if (payload.selectorAlt) offer('alternative', clip(payload.selectorAlt, CAP.selectorAlt), 60, 2)
      }

      const content = clip(payload.content || '', 90)
      const excerptCap = rank === 0 ? 160 : rank === 1 ? 300 : 400
      const excerpt = clip(payload.excerpt || '', excerptCap)
      // Child labels and the text excerpt often say the same thing; print it once.
      const redundant = content !== '' && excerpt !== '' && excerpt.indexOf(content) === 0
      // No human name means the content IS the identity: it must never be dropped for
      // budget, so it moves to the top level.
      const weakName = payload.labelKind === 'selector'
      if (content !== '' && !redundant) offer('content', content, 85, weakName ? 0 : 1)
      // An excerpt is for "read this to me": only when it says more than the label already did.
      if (excerpt !== '' && excerpt !== label && excerpt.length > 40 &&
        (content === '' || redundant || excerpt.length > content.length + 20)) {
        offer('excerpt', excerpt, 70, weakName ? 0 : 0)
      }
      offer('nearby', clip(payload.nearby, 80), 80, 1)
      const text = clip(payload.text || '', CAP.text)
      // `text` was printed here; it is almost always the label or the excerpt again,
      // so the excerpt owns the "read this" job and this line is gone.
      offer('index', clip(payload.index || '', 16), 100, 1)
      offer('attrs', clip(payload.attrs || '', 140), 110, 2)
      offer('component', clip(payload.component || '', 40), 120, 2)

      const kept = []
      let used = head.length
      for (const candidate of candidates.sort((left, right) => left.order - right.order)) {
        if (candidate.minRank > rank) continue
        if (used + candidate.text.length + 1 > textBudget) continue
        kept.push(candidate)
        used += candidate.text.length + 1
      }
      return [head, ...kept.map((candidate) => candidate.text)].join('\n') + '\n'
    }

    /** The inverse of `formatReference`: one block back into display data. */
    function parseUserBlock(raw) {
      const text = String(raw || '')
      const lines = text.split('\n')
      const head = lines[0] || ''
      // Quote mode drops the textual marker, so the kind is decided by the fields when
      // the header is bare: only a link block carries a `链接:` line.
      const bareLink = !head.startsWith(BLOCK.element) && !head.startsWith(BLOCK.link) &&
        lines.some((line) => line.startsWith(BLOCK.fields.url + ':'))
      const kind = head.startsWith(BLOCK.link) || bareLink ? 'link' : 'element'
      const stripped = head.startsWith(BLOCK.element)
        ? head.slice(BLOCK.element.length)
        : head.startsWith(BLOCK.link) ? head.slice(BLOCK.link.length) : head
      const body = stripped.trim()
      const data = {
        kind,
        label: stripDesc(body),
        desc: '',
        selector: '',
        page: '',
        context: '',
        text: '',
        frame: '',
        url: '',
        raw: text,
      }
      const byTitle = {}
      for (const key of Object.keys(BLOCK.fields)) byTitle[BLOCK.fields[key]] = key
      for (const line of lines.slice(1)) {
        const at = line.indexOf(': ')
        if (at <= 0) continue
        const field = byTitle[line.slice(0, at)]
        if (field === undefined) continue
        data[field] = line.slice(at + 2).trim()
      }
      if (data.frame !== '') {
        const arrow = data.frame.indexOf(' → ')
        if (arrow !== -1) data.frame = data.frame.slice(0, arrow)
      }
      return data
    }

    /** `label (button.btn)` → `label`; a label that merely ends in parentheses is kept. */
    function stripDesc(value) {
      return String(value || '').replace(/\s+\(([A-Za-z][\w.#:()-]*)\)$/u, '') || String(value || '')
    }

    /** One reference block as the model sees it: this is what the sent-message rule matches. */
    function sentTextPattern() {
      const fields = Object.keys(BLOCK.fields).map((key) => BLOCK.fields[key]).join('|')
      // The marker is optional: quote mode renders the block without [引用元素], and the
      // block is still recognised by its field lines.
      return new RegExp('(?:\\[引用(?:元素|链接)\\][^\\n]*|^[^\\n]+(?:\\([^)\\n]*\\))?)(?:\\n(?:' + fields + '):[^\\n]*){2,}', 'gmu')
    }

    const SENT_PATTERN = sentTextPattern()

    /* --------------------------------------------------------------- recent */

    function readRecent() {
      try {
        const list = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]')
        return Array.isArray(list) ? list.slice(0, RECENT_MAX) : []
      } catch (error) {
        return []
      }
    }

    function pushRecent(payload) {
      try {
        const entry = { at: Date.now(), label: chipLabel(payload), payload }
        const list = readRecent().filter((item) => formatReference(item.payload) !== formatReference(payload))
        list.unshift(entry)
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
      } catch (error) {
        /* storage is optional */
      }
    }

    /* ------------------------------------------------------------- host API */

    async function hostJson(path, body) {
      const init = body === undefined
        ? { cache: 'no-store' }
        : {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      const response = await fetch(ROUTE + path, init)
      if (!response.ok) throw new Error('element-ref host ' + response.status)
      return response.json()
    }

    /* ------------------------------------------------------------------ app */

    return {
      inject: ['slots', 'locale', 'inputTriggers', 'sessions'],
      __test: {
        formatReference, chipLabel, clipboardOf, clip, parsePayload, kindOf, parseUserBlock,
        sentTextPattern, setTextConfig, textConfig,
        setReferenceStyle: (style) => { referenceStyle = style === 'chip' ? 'chip' : 'quote' },
        referenceStyle: () => referenceStyle,
      },
      apply(ctx) {
        /** Per-session composer actions, captured from the invisible dock seat. */
        const bridge = new Map()
        /** Agent source text, fetched once per page load. */
        let agentText = ''
    let agentTextBuild = ''
        /** Latest host status (browser availability). */
        let hostStatus = null
        const state = {
          armed: false,
          token: '',
          since: 0,
          polling: false,
          pollTimer: 0,
          guestTimer: 0,
          guestBusy: false,
          seq: 0,
          guests: new Set(),
        }

        let t = (key) => key

        /* ------------------------------------------------------------ toast */

        let toastNode = null
        let toastTimer = 0
        /** `holdMs === 0` keeps the message up until hideToast(): the armed banner. */
        function toast(message, holdMs) {
          if (toastNode === null || toastNode.parentNode === null) {
            toastNode = document.createElement('div')
            toastNode.className = 'dsh-element-ref-toast'
            document.body.appendChild(toastNode)
          }
          toastNode.textContent = message
          toastNode.dataset.show = '1'
          clearTimeout(toastTimer)
          toastTimer = 0
          if (holdMs === 0) return
          toastTimer = setTimeout(() => {
            if (toastNode !== null) delete toastNode.dataset.show
          }, holdMs || 2200)
        }

        function hideToast() {
          clearTimeout(toastTimer)
          toastTimer = 0
          if (toastNode !== null) delete toastNode.dataset.show
        }

        /* --------------------------------------------------- session picking */

        function mainSession() {
          let listed = null
          try {
            listed = ctx.sessions.list.getSnapshot().byId
          } catch (error) {
            listed = null
          }
          let best = null
          for (const [sessionId, entry] of bridge) {
            if (entry === null || entry === undefined || entry.actions === null) continue
            const retained = listed && listed[sessionId] && listed[sessionId].retainedBy
              ? listed[sessionId].retainedBy.mainView
              : 0
            if (retained > 0) return { sessionId, actions: entry.actions }
            if (best === null || entry.at > best.at) best = { sessionId, actions: entry.actions, at: entry.at }
          }
          return best
        }

        /**
         * Insert one reference chip into the visible composer. This is the
         * composer's own insert event: it creates the shipped chip node, keeps
         * the span CAS, undo and the draft projection intact.
         * @param {object} payload
         * @returns {{ ok: boolean, reason?: string }}
         */
        /**
         * The composer's quote insertion leaves the caret *before* the new node, so the
         * next character would land in front of the reference. Walk it past the quote
         * card with arrow keys, observed through the DOM selection.
         */
        function caretAfterQuote() {
          try {
            // The quote node is <span data-composer-quote contenteditable="false">: the
            // selector has to be that attribute, not a made-up one.
            const quotes = document.querySelectorAll('[data-composer-quote]')
            const quote = quotes.length > 0 ? quotes[quotes.length - 1] : null
            if (!quote) return
            const editable = quote.closest('[contenteditable="true"]') || document.querySelector('[contenteditable="true"]')
            if (!editable) return
            editable.focus()
            const isAfter = () => {
              const selection = window.getSelection()
              if (!selection || selection.rangeCount === 0) return false
              const range = selection.getRangeAt(0)
              return (quote.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            }
            if (isAfter()) return
            // Lexical tracks the DOM selection, so placing it right after the quote node
            // is the direct fix; an arrow key is only the fallback when that is ignored.
            const range = document.createRange()
            range.setStartAfter(quote)
            range.collapse(true)
            const selection = window.getSelection()
            if (selection) {
              selection.removeAllRanges()
              selection.addRange(range)
            }
            if (isAfter()) return
            editable.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true, cancelable: true,
            }))
          } catch (error) {
            /* the caret is cosmetic: never fail the insertion over it */
          }
        }

        /**
         * Insert the reference through the best mechanism this DSH build offers, in a
         * fixed order, so a missing API can never mean "nothing happened":
         *   1. quote card   (`insertQuote`, 0.2.2 line)
         *   2. native chip  (`slash/input-insert-reference`)
         *   3. plain text   (`insertText` on the caret span)
         *   4. clipboard    (works everywhere; the user pastes it)
         */
        function insertReference(payload) {
          const target = mainSession()
          if (target === null) return { ok: false, reason: 'no-composer' }
          const actions = target.actions || {}
          const text = formatReference(payload).trimEnd()
          if (text === '') return { ok: false, reason: 'empty' }

          if (referenceStyle === 'quote' && typeof actions.insertQuote === 'function') {
            let quoted = false
            try {
              // DSH's signature is insertQuote(text, summary): the `labels` (remove
              // button) are filled in by the shell. Passing an object here put it into
              // `summary`, and the quote card rendered as an empty dark block.
              quoted = actions.insertQuote(text.replace(/\r\n?/gu, '\n')) === true
            } catch (error) {
              quoted = false
            }
            if (quoted) {
              caretAfterQuote()
              pushRecent(payload)
              return { ok: true, via: 'quote' }
            }
            // Older builds have no quote node: fall through to the other mechanisms.
          }

          let span = null
          try {
            span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : null
          } catch (error) {
            span = null
          }
          if (span !== null) {
            let actx = null
            try {
              actx = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(target.sessionId) : null
            } catch (error) {
              actx = null
            }
            if (actx) {
              const reference = {
                source: SOURCE,
                ref: JSON.stringify(payload),
                label: chipLabel(payload),
                clipboardText: clipboardOf(payload),
              }
              let applied = false
              try {
                applied = actx.bail(actx, 'slash/input-insert-reference', { reference, span }) === true
              } catch (error) {
                applied = false
              }
              if (applied) {
                pushRecent(payload)
                return { ok: true, via: 'chip' }
              }
            }
            // Plain text keeps the block readable even where chips and quotes are absent.
            let wrote = false
            try {
              wrote = actions.insertText(formatReference(payload, true), span) === true
            } catch (error) {
              wrote = false
            }
            if (wrote) {
              pushRecent(payload)
              return { ok: true, via: 'text' }
            }
          }
          try {
            void navigator.clipboard.writeText(formatReference(payload, true))
            pushRecent(payload)
            return { ok: true, via: 'clipboard' }
          } catch (error) {
            return { ok: false, reason: 'no-channel' }
          }
        }

        /* ------------------------------------------------------- agent agent */

        async function loadAgentText() {
          // Cache by build: a Host reload that ships a newer kernel must not be
          // papered over by the text this page fetched minutes ago.
          if (agentText !== '' && agentTextBuild !== '' && agentTextBuild === agentBuild) return agentText
          const response = await fetch(ROUTE + '/agent.js', { cache: 'no-store' })
          if (!response.ok) throw new Error('agent source unavailable: ' + response.status)
          agentText = await response.text()
          if (agentText === '') throw new Error('agent source empty')
          agentTextBuild = agentBuild
          return agentText
        }

        function installInWindow(text) {
          // Stamp the build so a page holding an older kernel replaces it: without
          // this, a reloaded plugin keeps serving the previous pickup behaviour.
          window.__dshRefBuild = agentBuild
          if (window.__dshRef && window.__dshRef.build === agentBuild) return
          const run = new Function(text)
          run()
          if (!window.__dshRef) throw new Error('agent did not install')
        }

        function armWindow() {
          if (!window.__dshRef) return false
          window.__dshRef.onpick = (payload) => { handlePick(payload, 'dsh') }
          window.__dshRef.onnotice = (notice) => {
            if (!notice || notice.at === state.noticeAt) return
            state.noticeAt = notice.at
            toast(notice.kind === 'error'
              ? t('pickFailed', { reason: String(notice.text || '') })
              : t('nothingHere'), 2600)
          }
          window.__dshRef.arm({ channel: 'dsh', omitPage: true, skip: [DSH_SKIP] })
          return true
        }

        function disarmWindow() {
          try {
            if (window.__dshRef) {
              window.__dshRef.onpick = null
              window.__dshRef.disarm()
            }
          } catch (error) {
            /* ignore */
          }
        }

        /**
         * DSH nests parts of its shell inside open shadow roots, and the sidebar
         * browser is one of them: a top-document query misses the <webview> entirely,
         * which is exactly "DSH elements pick fine, the built-in browser does not".
         * The scan is bounded and cached so the 180 ms pick poll stays cheap.
         */
        let guestCache = { at: 0, list: [] }
        /** Self-measurement: the only way to prove whether this plugin costs the UI frames. */
        const perf = { callbacks: 0, related: 0, syncs: 0, syncMs: 0, scans: 0, evals: 0 }
        /** Recent guest failures, reported to the Host so the cause is readable outside. */
        const guestErrors = []
        /** Per-view install retry clock (a 40 KB eval per 180 ms would be abusive). */
        const guestAttemptAt = new WeakMap()
        const GUEST_RETRY_MS = 1200
        const GUEST_SCAN_MS = 1000
        const GUEST_SCAN_NODES = 8000

        function deepQuery(selector, out, budgetRef) {
          const queue = [document]
          while (queue.length > 0) {
            const root = queue.shift()
            if (budgetRef.left <= 0) return
            let found = []
            try {
              found = root.querySelectorAll(selector)
            } catch (error) {
              continue
            }
            for (const node of found) out.push(node)
            let all = []
            try {
              all = root.querySelectorAll('*')
            } catch (error) {
              continue
            }
            for (const node of all) {
              budgetRef.left -= 1
              if (budgetRef.left <= 0) return
              if (node.shadowRoot !== null && node.shadowRoot !== undefined) queue.push(node.shadowRoot)
            }
          }
        }

        function guestList() {
          if (Date.now() - guestCache.at < GUEST_SCAN_MS) return guestCache.list
          perf.scans += 1
          const found = []
          deepQuery('webview[data-sidebar-browser-frame="webview"], webview', found, { left: GUEST_SCAN_NODES })
          const list = found.filter((node) => typeof node.executeJavaScript === 'function')
          guestCache = { at: Date.now(), list }
          return list
        }

        function evalGuest(view, code, timeoutMs) {
          perf.evals += 1
          let result = null
          try {
            result = view.executeJavaScript(code)
          } catch (error) {
            guestErrors.push('sync: ' + String((error && error.message) || error).slice(0, 160))
            return Promise.resolve(null)
          }
          const promise = result !== null && typeof result.then === 'function'
            ? result.catch((error) => {
              guestErrors.push('async: ' + String((error && error.message) || error).slice(0, 160))
              return null
            })
            : Promise.resolve(result)
          return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs || 600)),
          ])
        }

        /**
         * Install the kernel into one guest and *verify* it, instead of assuming the
         * eval worked. The previous version marked every view armed after a silent
         * failure, so the sidebar browser looked armed while receiving nothing.
         */
        async function armGuest(view, text) {
          const stamp = 'window.__dshRefBuild=' + JSON.stringify(agentBuild) + ';'
          const installed = await evalGuest(view, 'window.__dshRef ? String(window.__dshRef.build || "") : ""', 400)
          if (typeof installed === 'string' && installed !== '' && installed === agentBuild) {
            await evalGuest(view, 'window.__dshRef&&window.__dshRef.arm(' + JSON.stringify({ channel: 'webview', skip: [STRIP_SKIP] }) + ')', 800)
            state.guests.add(view)
            return true
          }
          if (text !== '') await evalGuest(view, stamp + text + '\n;true', 1400)
          const after = await evalGuest(view, 'window.__dshRef ? String(window.__dshRef.build || "") : ""', 400)
          if (typeof after !== 'string' || after === '') return false
          await evalGuest(view, 'window.__dshRef&&window.__dshRef.arm(' + JSON.stringify({ channel: 'webview', skip: [STRIP_SKIP] }) + ')', 800)
          state.guests.add(view)
          return true
        }

        /**
         * Report what the renderer actually sees. The DSH window cannot be inspected
         * from outside, so the client is the only witness: which elements look like a
         * guest, whether they expose executeJavaScript, and the exact failure text.
         */
        async function reportDiagnostics(extra) {
          const found = []
          deepQuery('webview, iframe[data-sidebar-browser-frame], iframe[data-html-preview]', found, { left: 4000 })
          const views = []
          for (const node of found) {
            let size = ''
            try {
              const rect = node.getBoundingClientRect()
              size = Math.round(rect.width) + 'x' + Math.round(rect.height)
            } catch (error) {
              size = ''
            }
            const probe = await evalGuest(node, '1+1', 500)
            const build = await evalGuest(node, 'String((window.__dshRef && window.__dshRef.build) || "")', 500)
            const tag = await evalGuest(node, 'String((window.__dshRef && window.__dshRef.version) || "")', 500)
            views.push({
              tag: node.tagName.toLowerCase(),
              frame: node.getAttribute('data-sidebar-browser-frame') || node.getAttribute('data-html-preview') || '',
              name: String(node.getAttribute('name') || '').slice(0, 24),
              exec: typeof node.executeJavaScript === 'function',
              connected: node.isConnected === true,
              inShadow: typeof node.getRootNode === 'function' ? node.getRootNode() !== document : null,
              src: String(node.getAttribute('src') || node.getAttribute('data-src') || '').slice(0, 90),
              size,
              probe,
              guestBuild: build,
              guestVersion: tag,
            })
          }
          void hostJson('/diag', {
            client: CLIENT_BUILD,
            build: agentBuild,
            agentLen: agentText.length,
            views,
            total: found.length,
            errors: guestErrors.slice(-8),
            armed: extra || null,
            perf: { callbacks: perf.callbacks, related: perf.related, syncs: perf.syncs, syncMs: Math.round(perf.syncMs * 10) / 10, scans: perf.scans, evals: perf.evals },
            ua: String(navigator.userAgent || '').slice(0, 140),
          }).catch(() => {})
        }

        /**
         * `executeJavaScript` throws until the guest is attached and its `dom-ready`
         * has fired ("The WebView must be attached to the DOM…"), so the kernel is
         * also injected on the guest's own lifecycle events, not just on our timer.
         */
        function watchGuest(view) {
          if (view.__dshRefWatched === true) return
          view.__dshRefWatched = true
          const retry = () => { void armGuest(view, agentText) }
          for (const event of ['dom-ready', 'did-finish-load', 'did-navigate', 'did-navigate-in-page']) {
            try {
              view.addEventListener(event, retry)
            } catch (error) {
              /* not a webview */
            }
          }
          // The guest document never reports that the pointer left it, but the host
          // does: the <webview> is a normal element in this document. That is the
          // presence signal the highlight needs, so no timeout heuristic is involved.
          const clear = () => {
            void evalGuest(view, 'window.__dshRef&&window.__dshRef.clearHighlight()', 300)
          }
          for (const event of ['mouseleave', 'mouseenter', 'blur']) {
            try {
              view.addEventListener(event, clear)
            } catch (error) {
              /* not a webview */
            }
          }
        }

        /**
         * Sample what each guest kernel has actually seen while a session is open:
         * zero counters means the guest page never delivered a pointer event, while
         * move>0 and up>0 with no pick means the event path works and describe failed.
         */
        async function sampleGuests(delay) {
          if (!state.armed) return
          const samples = []
          for (const view of guestList()) {
            const raw = await evalGuest(view, 'JSON.stringify(window.__dshRef ? window.__dshRef.read() : null)', 500)
            let data = null
            try {
              data = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null
            } catch (error) {
              data = null
            }
            // A synthetic pointermove answers "does the guest kernel hear anything at
            // all?" without picking anything (no click is dispatched).
            const probe = await evalGuest(view, `(function () {
              try {
                var api = window.__dshRef
                if (!api || !api.read) return 'no-kernel'
                var before = api.read()
                var el = document.elementFromPoint(120, 120) || document.body || document.documentElement
                if (!el) return 'no-element'
                var rect = el.getBoundingClientRect()
                el.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, cancelable: true, composed: true, pointerType: 'mouse',
                  clientX: Math.round(rect.left + 5), clientY: Math.round(rect.top + 5),
                }))
                var after = api.read()
                return JSON.stringify({
                  hasSeen: Boolean(after && after.seen),
                  before: (before && before.seen) || null,
                  after: (after && after.seen) || null,
                  target: el.tagName,
                })
              } catch (error) { return 'error: ' + String((error && error.message) || error) }
            })()`, 900)
            samples.push({ armed: state.guests.has(view), data, probe })
          }
          if (samples.length === 0) return
          void hostJson('/diag', { phase: 'sample', delay, samples, errors: guestErrors.slice(-8) }).catch(() => {})
        }

        async function armGuests(text) {
          const views = guestList()
          let armed = 0
          for (const view of views) {
            watchGuest(view)
            if (await armGuest(view, text)) armed += 1
          }
          return { found: views.length, armed }
        }

        /** Window focus is the second presence signal: leaving the app ends the guest box. */
        function clearGuestHighlights() {
          for (const view of guestList()) {
            void evalGuest(view, 'window.__dshRef&&window.__dshRef.clearHighlight()', 300)
          }
        }

        function disarmGuests() {
          for (const view of guestList()) {
            void evalGuest(view, 'window.__dshRef&&window.__dshRef.disarm()', 400)
          }
          state.guests.clear()
        }

        async function pollGuests() {
          if (!state.armed || state.guestBusy) return
          state.guestBusy = true
          try {
            for (const view of guestList()) {
              watchGuest(view)
              // Reads travel as a JSON string: a structured-clone failure inside
              // executeJavaScript rejects the whole call, which looks exactly like
              // "the guest never installed".
              const raw = await evalGuest(view, 'JSON.stringify(window.__dshRef ? window.__dshRef.read() : null)', 500)
              let snapshot = null
              try {
                snapshot = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null
              } catch (error) {
                snapshot = null
              }
              if (snapshot === null || typeof snapshot !== 'object') {
                // Not installed yet (or replaced by a stale kernel): install and verify,
                // but do not hammer a 40 KB injection every 180 ms.
                if (!state.guests.has(view)) {
                  const at = guestAttemptAt.get(view) || 0
                  if (Date.now() - at >= GUEST_RETRY_MS) {
                    guestAttemptAt.set(view, Date.now())
                    await armGuest(view, agentText)
                  }
                }
                continue
              }
              if (snapshot.picked) {
                const picked = snapshot.picked
                void evalGuest(view, 'window.__dshRef&&(window.__dshRef.onpick=null,window.__dshRef.disarm())', 400)
                state.guests.delete(view)
                handlePick(picked, 'webview')
                return
              }
              if (snapshot.notice && snapshot.notice.at !== state.noticeAt) {
                state.noticeAt = snapshot.notice.at
                toast(t('nothingHere'), 2600)
              }
              if (snapshot.active === false) {
                state.guests.delete(view)
              }
            }
          } finally {
            state.guestBusy = false
          }
        }

        /* ------------------------------------------------------- pick result */

        function stopEverything(reason) {
          state.seq += 1
          state.armed = false
          state.polling = false
          if (state.pollTimer !== 0) clearTimeout(state.pollTimer)
          if (state.guestTimer !== 0) clearInterval(state.guestTimer)
          state.pollTimer = 0
          state.guestTimer = 0
          disarmWindow()
          disarmGuests()
          const token = state.token
          state.token = ''
          if (token !== '') {
            void hostJson('/disarm', {}).catch(() => {})
          }
          paintStrip()
          hideToast()
          if (reason === 'user') toast(t('stopped'))
        }

        function handlePick(result, source) {
          if (!state.armed) return
          if (result === null || typeof result !== 'object' || result.cancelled === true) {
            stopEverything('cancelled')
            toast(t('cancelled'))
            return
          }
          const payload = { ...result, source: result.source && result.source !== 'page' ? result.source : source }
          const inserted = insertReference(payload)
          stopEverything('picked')
          if (inserted.ok) toast(t('inserted', { label: chipLabel(payload) }))
          else toast(t('insertFailed'))
        }

        /* ------------------------------------------------------------ arming */

        async function startArming() {
          if (state.armed) {
            stopEverything('user')
            return
          }
          const seq = ++state.seq
          const alive = () => state.armed && state.seq === seq
          // Refresh first: the kernel text is cached per build, and a Host reload
          // must be picked up by the very next arm instead of the next page load.
          await refreshStatus()
          let text = ''
          try {
            text = await loadAgentText()
          } catch (error) {
            toast(t('agentMissing'))
            return
          }
          if (state.seq !== seq) return
          state.armed = true
          state.since = 0
          state.token = ''
          state.polling = false
          state.guests.clear()
          let windowArmed = false
          try {
            installInWindow(text)
            windowArmed = armWindow()
          } catch (error) {
            windowArmed = false
          }
          let hostBrowsers = []
          let hostError = ''
          let extConnected = false
          try {
            const result = await hostJson('/arm', {})
            if (!alive()) return
            state.token = typeof result.token === 'string' ? result.token : ''
            hostBrowsers = Array.isArray(result.browsers) ? result.browsers : []
            extConnected = Boolean(result.extension && result.extension.connected === true)
            if (state.token !== '') {
              state.polling = true
              void pollHost()
            }
          } catch (error) {
            if (!alive()) return
            hostError = String(error && error.message ? error.message : error)
          }
          state.noticeAt = 0
          let guestCount = 0
          let guestFound = 0
          try {
            const guests = await armGuests(text)
            guestCount = guests.armed
            guestFound = guests.found
          } catch (error) {
            guestCount = 0
          }
          if (!alive()) return
          if (guestFound > 0) {
            // Keep polling while a guest exists: a late-loading page or a replaced
            // kernel gets picked up here instead of failing quietly.
            state.guestTimer = setInterval(() => { void pollGuests() }, GUEST_POLL_MS)
          }
          paintStrip()
          const armedCount = (windowArmed ? 1 : 0) + guestCount + hostBrowsers.filter((browser) => browser.ok === true).length + (extConnected ? 1 : 0)
          if (armedCount === 0) {
            stopEverything('nothing')
            toast(hostError !== '' ? t('agentMissing') : t('nothingToPick'), 4200)
            return
          }
          // Sticky banner: the armed surfaces stay visible for the whole session, so
          // clicking a window that is not listed does not feel like a silent failure.
          toast(armSummary({ windowArmed, guestCount, guestFound, hostBrowsers, hostError, extConnected }), 0)
          void reportDiagnostics({ guestFound, guestCount, windowArmed, extConnected })
          if (guestCount > 0) {
            for (const delay of [1500, 4000, 8000]) setTimeout(() => { void sampleGuests(delay) }, delay)
          }
        }

        function armingTargets(options) {
          const parts = []
          if (options.windowArmed) parts.push('DSH')
          if (options.guestCount > 0) parts.push('侧栏网页')
          else if (options.guestFound > 0) parts.push(t('guestFailed'))
          for (const browser of options.hostBrowsers) {
            if (browser.ok === true) parts.push(browser.label)
          }
          if (options.extConnected === true) parts.push('浏览器扩展')
          return parts
        }

        function armSummary(options) {
          const targets = armingTargets(options)
          if (targets.length === 0) return t('nothingToPick')
          // The kernel id makes "did the page pick up the new build" answerable at a
          // glance: a stale banner is the reason a fix can look like it did nothing.
          const build = agentBuild === '' ? '' : ' · v' + String(agentBuild).slice(0, 6)
          let head = t('armedOn', { targets: targets.join(' / ') }) + build
          if (options.hostError !== '') return head + ' · ' + t('hostDown')
          const ready = options.hostBrowsers.filter((browser) => browser.ok === true).length
          // No browser at all is still "the external channel has no entry": say it instead
          // of silently listing three of the four surfaces.
          if (ready === 0) return head + ' · ' + t('someBrowsersOff')
          const blank = options.hostBrowsers.filter((browser) => browser.ok === true && (browser.targets || []).length === 0)
          if (blank.length > 0) head += ' · ' + t('openAPage')
          return head
        }

        async function pollHost() {
          if (!state.polling) return
          let delay = 260
          try {
            const result = await hostJson(
              '/pick?token=' + encodeURIComponent(state.token) + '&since=' + String(state.since),
            )
            if (result.state === 'pick' && result.pick) {
              state.since = typeof result.revision === 'number' ? result.revision : state.since
              handlePick(result.pick, result.pick.source || 'page')
              return
            }
            if (result.state === 'ended' || result.state === 'replaced') {
              stopEverything('host-ended')
              toast(t(result.state === 'replaced' ? 'replaced' : 'expired'))
              return
            }
            if (typeof result.revision === 'number') state.since = Math.max(state.since, result.revision)
          } catch (error) {
            delay = 1200
          }
          if (state.polling) {
            state.pollTimer = setTimeout(() => { void pollHost() }, delay)
          }
        }

        /* ------------------------------------------------------- strip button */

        function isVisible(node) {
          if (!node || node.nodeType !== 1) return false
          const rect = node.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return true
          return node.offsetParent !== null
        }

        function ancestors(node) {
          const list = []
          let cur = node
          for (let depth = 0; cur && depth < 12; depth += 1) {
            list.push(cur)
            cur = cur.parentElement
          }
          return list
        }

        /**
         * Where the icon goes. Two seats, one trigger:
         *  - expanded: the right sidebar's top-right control cluster, left of the
         *    fullscreen/collapse controls (shipped `data-sidebar-right-*` attributes,
         *    with an aria-label fallback for a future build that renames them);
         *  - collapsed: the conversation header's corner seat, right of the
         *    "open right sidebar" button, so the trigger exists even while the
         *    panel is slid off-screen.
         */
        function locateStrip() {
          const firstVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(isVisible)[0] || null
          const expanded = document.querySelector('[data-sidebar-right-session][data-sidebar-right-open]') !== null
          const toggleAttribute = firstVisible('[data-sidebar-right-toggle]')
          let toggle = toggleAttribute
          if (toggle === null) {
            const collapse = /收起右侧边栏|Collapse right sidebar|收起侧边栏|Collapse sidebar/
            toggle = Array.from(document.querySelectorAll('button')).filter(
              (node) => isVisible(node) && collapse.test(node.getAttribute('aria-label') || ''),
            )[0] || null
          }
          if (!expanded) {
            const expand = firstVisible('[data-sidebar-right-expand]')
            if (expand !== null && expand.parentElement !== null) {
              return { host: expand.parentElement, before: expand.nextSibling, sample: expand.className }
            }
          }
          if (toggle === null) return null
          const mode = firstVisible('[data-sidebar-right-mode]')
          if (mode !== null) {
            const upMode = ancestors(mode)
            const upToggle = new Set(ancestors(toggle))
            for (const candidate of upMode) {
              if (!upToggle.has(candidate)) continue
              let child = mode
              while (child.parentElement && child.parentElement !== candidate) child = child.parentElement
              if (child.parentElement === candidate) return { host: candidate, before: child, sample: toggle.className }
            }
          }
          if (!toggle.parentElement) return null
          return { host: toggle.parentElement, before: toggle, sample: toggle.className }
        }

        function paintStrip() {
          const button = document.getElementById(BUTTON_ID)
          if (button === null) return
          if (state.armed) button.dataset.on = '1'
          else delete button.dataset.on
          const label = state.armed ? t('iconOn') : t('iconOff')
          button.title = label
          button.setAttribute('aria-label', label)
        }

        function syncStrip() {
          const place = locateStrip()
          const existing = document.getElementById(BUTTON_ID)
          if (place === null) {
            if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)
            return
          }
          if (existing !== null && existing.parentNode === place.host) {
            paintStrip()
            return
          }
          if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)
          const button = document.createElement('button')
          button.type = 'button'
          button.id = BUTTON_ID
          button.dataset.elementRefStrip = '1'
          button.className = place.sample || ''
          button.innerHTML = ICON
          button.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            void startArming()
          })
          button.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            event.stopPropagation()
            void showMenu(button)
          })
          place.host.insertBefore(button, place.before)
          paintStrip()
        }

        /* ------------------------------------------------------------- menu */

        let menuNode = null
        /** The outside-click listener must die with the menu, or every open leaks one. */
        let menuDismiss = null

        function closeMenu() {
          if (menuDismiss !== null) {
            document.removeEventListener('mousedown', menuDismiss, true)
            menuDismiss = null
          }
          if (menuNode !== null && menuNode.parentNode) menuNode.parentNode.removeChild(menuNode)
          menuNode = null
        }

        function menuRow(options) {
          const row = document.createElement(options.action === undefined ? 'div' : 'button')
          row.className = 'dsh-element-ref-menu-row'
          if (options.action === undefined) row.dataset.static = '1'
          else row.type = 'button'
          const dot = document.createElement('span')
          dot.className = 'dsh-element-ref-menu-dot'
          if (options.ok === true) dot.dataset.ok = '1'
          row.appendChild(dot)
          const label = document.createElement('span')
          label.style.flex = '1'
          label.textContent = options.label
          row.appendChild(label)
          if (options.detail) {
            const detail = document.createElement('span')
            detail.style.opacity = '0.6'
            detail.textContent = options.detail
            row.appendChild(detail)
          }
          if (options.action !== undefined) {
            row.addEventListener('click', (event) => {
              event.preventDefault()
              event.stopPropagation()
              options.action()
            })
          }
          return row
        }

        async function refreshStatus() {
          try {
            hostStatus = await hostJson('/status')
            applyTextConfig(hostStatus)
          } catch (error) {
            hostStatus = null
          }
          return hostStatus
        }

        /** The Host owns the detail/budget knobs; the formatter follows them. */
        function applyTextConfig(status) {
          if (status === null || status === undefined || status.config === undefined) return
          setTextConfig(status.config.textDetail, status.config.textBudget)
          setReferenceStyle(status.config.referenceStyle)
          if (typeof status.agentHash === 'string') agentBuild = status.agentHash
        }

        async function showMenu(anchor) {
          if (menuNode !== null) {
            closeMenu()
            return
          }
          await refreshStatus()
          const box = document.createElement('div')
          box.className = 'dsh-element-ref-menu'
          box.dataset.elementRefMenu = '1'
          const title = document.createElement('div')
          title.className = 'dsh-element-ref-menu-title'
          title.textContent = t('menuTargets')
          box.appendChild(title)

          box.appendChild(menuRow({ label: t('targetDsh'), ok: true, detail: t('alwaysOn') }))
          if (hostStatus === null) {
            box.appendChild(menuRow({ label: t('hostDown'), ok: false }))
          } else {
            for (const source of hostStatus.sources || []) {
              if (source.running === true) {
                box.appendChild(menuRow({ label: source.label, ok: true, detail: source.port ? String(source.port) : '' }))
              } else if (source.launchable === true) {
                box.appendChild(menuRow({
                  label: source.label,
                  ok: false,
                  detail: t('launchManagedHint'),
                  action: async () => {
                    closeMenu()
                    toast(t('launching'), 8000)
                    try {
                      const result = await hostJson('/launch', {})
                      toast(result.ok === true ? t('launched') : String(result.reason || t('launchFailed')), 5000)
                    } catch (error) {
                      toast(t('launchFailed'), 4000)
                    }
                  },
                }))
                box.appendChild(menuRow({
                  label: t('launchUserProfile'),
                  ok: false,
                  detail: hostStatus.userProfile && hostStatus.userProfile.running === true
                    ? t('launchUserRunning')
                    : t('launchUserHint'),
                  action: async () => {
                    closeMenu()
                    toast(t('launching'), 8000)
                    try {
                      const result = await hostJson('/launch', { profile: 'user' })
                      toast(result.ok === true ? t('launchedUser') : String(result.reason || t('launchFailed')), 7000)
                    } catch (error) {
                      toast(t('launchFailed'), 4000)
                    }
                  },
                }))
              } else {
                box.appendChild(menuRow({ label: source.label, ok: false, detail: String(source.reason || '') }))
              }
            }
          }

          // The extension bridge is how a browser the user already has gets covered.
          if (hostStatus !== null && hostStatus.extension !== undefined) {
            const bridge = hostStatus.extension
            if (bridge.connected === true) {
              box.appendChild(menuRow({ label: t('extConnected'), ok: true, detail: String(bridge.port) }))
            } else if (bridge.enabled !== true || bridge.listening !== true) {
              box.appendChild(menuRow({ label: t('extDown'), ok: false, detail: String(bridge.error || '') }))
            } else {
              box.appendChild(menuRow({
                label: t('extInstall'),
                ok: false,
                detail: t('extInstallHint'),
                action: async () => {
                  closeMenu()
                  const dir = bridge.dir || ''
                  try {
                    if (dir !== '') await navigator.clipboard.writeText(dir)
                  } catch (error) {
                    /* clipboard may be denied; the steps still name the folder */
                  }
                  toast(t('extSteps'), 14000)
                },
              }))
            }
          }

          const recent = readRecent()
          const recentTitle = document.createElement('div')
          recentTitle.className = 'dsh-element-ref-menu-title'
          recentTitle.textContent = t('menuRecent')
          box.appendChild(recentTitle)
          if (recent.length === 0) {
            box.appendChild(menuRow({ label: t('recentEmpty'), ok: false }))
          }
          for (const entry of recent.slice(0, 5)) {
            box.appendChild(menuRow({
              label: entry.label,
              ok: true,
              detail: new Date(entry.at).toLocaleTimeString(),
              action: () => {
                closeMenu()
                const inserted = insertReference(entry.payload)
                toast(inserted.ok ? t('inserted', { label: entry.label }) : t('insertFailed'))
              },
            }))
          }
          box.appendChild(menuRow({
            label: t('menuClearRecent'),
            ok: false,
            action: () => {
              try {
                window.localStorage.removeItem(RECENT_KEY)
              } catch (error) {
                /* ignore */
              }
              closeMenu()
            },
          }))

          const rect = anchor.getBoundingClientRect()
          box.style.left = Math.max(8, Math.min(window.innerWidth - 280, rect.right - 260)) + 'px'
          box.style.top = Math.max(8, rect.top - 8 - Math.min(420, 90 + (hostStatus ? (hostStatus.sources || []).length * 26 : 0) + recent.length * 26)) + 'px'
          document.body.appendChild(box)
          menuNode = box
          // closeMenu owns the removal, so closing via the icon, a pick or destroy all
          // release this listener instead of leaking one per menu open.
          menuDismiss = (event) => {
            if (menuNode !== null && !menuNode.contains(event.target)) closeMenu()
          }
          document.addEventListener('mousedown', menuDismiss, true)
        }

        /* ------------------------------------------------------------ flash */

        /**
         * Point at a reference again. `source` narrows the first try, but the
         * sent-message renderer only has the model text (which carries no
         * source), so an unknown source walks the surfaces in cost order.
         */
        async function flashPayload(payload) {
          if (payload === null || payload === undefined) return false
          const source = payload.source
          if (source === undefined || source === 'dsh') {
            try {
              if (window.__dshRef && window.__dshRef.flash(payload)) return true
            } catch (error) {
              /* try the next surface */
            }
            if (source === 'dsh') return false
          }
          if (source === undefined || source === 'webview') {
            for (const view of guestList()) {
              let current = ''
              try {
                current = typeof view.getURL === 'function' ? view.getURL() : ''
              } catch (error) {
                current = ''
              }
              if (current !== '' && payload.page && current !== payload.page) continue
              const result = await evalGuest(
                view,
                'window.__dshRef?window.__dshRef.flash(' + JSON.stringify(payload) + '):false',
                1200,
              )
              if (result === true) return true
            }
            if (source === 'webview') return false
          }
          try {
            const result = await hostJson('/flash', { payload })
            return result.ok === true
          } catch (error) {
            return false
          }
        }

        /* ------------------------------------------------------------ apply */

        ctx.effect(() => installStyles(), 'element-ref: styles')

        ctx.effect(() => typeof ctx.locale?.register === 'function' ? ctx.locale.register(NS, {
          zh: {
            iconOff: '引用：点一下开始选取（Esc 退出）',
            iconOn: '引用：选取中，点一下停止',
            stopped: '已停止选取',
            cancelled: '已取消选取',
            inserted: '已引用：{label}',
            insertedText: '已以纯文本引用（此版本无引用卡）：{label}',
            insertedClipboard: '此版本无法直接插入，已复制引用（Ctrl+V）：{label}',
            insertFailed: '没找到可插入的输入框 —— 先在会话输入框里点一下再试',
            agentMissing: '取不到拾取器脚本（宿主插件未启用？）',
            nothingToPick: '没有可拾取的目标：打开右侧栏网页、Agent 浏览器，或在右键菜单里启动外部浏览器',
            armedOn: '可选区域：{targets} · 点击元素引用，Esc 退出',
            hostDown: '宿主插件未响应（仅本机页面可用）',
            nothingHere: '此处没有可引用的元素（空白或超大容器）',
            pickFailed: '引用失败：{reason}',
            someBrowsersOff: '外部浏览器未连接：装扩展，或右键图标 →「点一下开独立窗口」',
            guestFailed: '侧栏网页：找到 webview 但注入失败',
            openAPage: '外部浏览器里先打开一个网页',
            replaced: '另一个窗口开始了新的选取，本次已结束',
            expired: '选取超时，已结束',
            launching: '正在启动浏览器（首次较慢）…',
            launched: '浏览器已启动，再点一次图标即可引用',
            launchedUser: '已用本机配置启动（调试端口已开），再点图标即可引用',
            launchFailed: '浏览器启动失败',
            launchManagedHint: '点一下开独立窗口',
            launchUserProfile: '用本机 Edge 配置启动',
            launchUserHint: '用你的登录态（需先退出 Edge）',
            launchUserRunning: 'Edge 正在运行，先退出它',
            extConnected: '浏览器扩展：已连接（可拾任何标签页）',
            extInstall: '浏览器扩展：未安装',
            extInstallHint: '一次安装后，你日常的 Edge / Chrome 里任何页面都能拾',
            extSteps: '扩展目录已复制。Edge 打开 edge://extensions → 打开「开发人员模式」→「加载解压缩的扩展」→ 粘贴该目录。装好后重新点图标即可。',
            extDown: '浏览器扩展端口未监听',
            menuTargets: '引用目标',
            menuRecent: '最近引用',
            menuClearRecent: '清空最近引用',
            targetDsh: 'DSH 界面',
            alwaysOn: '始终可用',
            recentEmpty: '还没有引用过',
          },
          en: {
            iconOff: 'Reference: click to start picking (Esc to exit)',
            iconOn: 'Reference: picking — click to stop',
            stopped: 'Picking stopped',
            cancelled: 'Picking cancelled',
            inserted: 'Referenced: {label}',
            insertedText: 'Inserted as plain text (no quote card in this build): {label}',
            insertedClipboard: 'Copied (this build cannot insert): {label}',
            insertFailed: 'No composer found — click inside the message box first',
            agentMissing: 'Picker source unavailable (is the host half enabled?)',
            nothingToPick: 'Nothing to pick from: open a sidebar page, the agent browser, or launch an external browser from the right-click menu',
            armedOn: 'Pick from: {targets} · click an element, Esc to exit',
            hostDown: 'Host half is not responding (local surfaces only)',
            guestFailed: 'side panel page: webview found but injection failed',
            nothingHere: 'nothing pickable here (empty area or a scroll container)',
            pickFailed: 'pick failed: {reason}',
            someBrowsersOff: 'External browser not connected: install the extension, or right-click the icon → “open a separate window”; the browser you are already using cannot be taken over',
            openAPage: 'open a page in that browser first',
            replaced: 'Another window started a new pick; this one ended',
            expired: 'Pick session expired',
            launching: 'Starting the browser (slow on first run)…',
            launched: 'Browser started — click the icon again to pick',
            launchedUser: 'Started with your own profile (debug port open) — click the icon again to pick',
            launchFailed: 'Could not start the browser',
            launchManagedHint: 'click to open a separate window',
            launchUserProfile: 'Start with your own Edge profile',
            launchUserHint: 'your logins (quit Edge first)',
            launchUserRunning: 'Edge is running — quit it first',
            extConnected: 'Browser extension: connected (any tab)',
            extInstall: 'Browser extension: not installed',
            extInstallHint: 'install once and every page in your own Edge / Chrome is pickable',
            extSteps: 'Extension folder copied. In Edge open edge://extensions → enable Developer mode → Load unpacked → paste that folder. Then click the icon again.',
            extDown: 'Extension bridge port is not listening',
            menuTargets: 'Pick targets',
            menuRecent: 'Recent references',
            menuClearRecent: 'Clear recent references',
            targetDsh: 'DSH interface',
            alwaysOn: 'always available',
            recentEmpty: 'Nothing yet',
          },
        }) : undefined, 'element-ref: dictionaries')
        // A locale service is not guaranteed on every supported build; a missing binder
        // must degrade to plain keys, not to a crash on the first toast.
        t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => String(key)

        // The only public way to reach the composer's caret: an invisible seat.
        ctx.effect(
          () => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
            { name: 'conversation.input.dock', id: 'element-ref-bridge', order: 900 },
            (props) => {
              const actions = props.inputActions || null
              const sessionId = props.sessionId
              React.useEffect(() => {
                if (actions === null) return undefined
                if (typeof sessionId !== 'string' || sessionId === '') return undefined
                bridge.set(sessionId, { actions, at: Date.now() })
                return () => {
                  const current = bridge.get(sessionId)
                  if (current !== undefined && current.actions === actions) bridge.delete(sessionId)
                }
              }, [actions, sessionId])
              return null
            },
          )),
          'element-ref: composer bridge',
        )

        /* ------------------------------------------------------ sent messages */

        /**
         * A submitted reference block renders as the same chip the composer
         * shows, instead of a wall of lines. Presentation only: the model text
         * is exactly what `formatReference` produced.
         */
        /**
         * References are quotations, not mentions: a quote mark reads as "this came
         * from somewhere else", which is exactly what a reference is. DSH's icon set
         * has no quote glyph (101 keys, none of them a quote), so the chip uses the
         * typographic mark the same way DSH's own composer marks a reference with `@`.
         */
        const CHIP_GLYPH = React.createElement('span', { className: 'dsh-element-ref-chip-mark' }, '❝')

        function SentReference(props) {
          const data = (props.node && props.node.data) || {}
          const label = data.label || '引用'
          const interactive = props.interactive === true && (data.selector !== '' || data.url !== '')
          const activate = interactive
            ? (event) => {
              event.preventDefault()
              event.stopPropagation()
              void flashPayload({ ...data, source: data.page !== '' ? undefined : 'dsh' })
            }
            : undefined
          return React.createElement(
            'span',
            {
              className: 'dsh-element-ref-chip',
              title: props.raw || label,
              'data-interactive': interactive ? '1' : undefined,
              onClick: activate,
            },
            React.createElement('span', { className: 'dsh-element-ref-chip-glyph', 'aria-hidden': true }, CHIP_GLYPH),
            React.createElement('span', { className: 'dsh-element-ref-chip-label' }, label),
          )
        }

        // The reader of `formatReference`, generated from the same block vocabulary.
        // `uiConversation` is optional for the plugin as a whole (the picker must not
        // die without it), so it arrives through a scoped injection instead of `inject`.
        let sentRule = 'pending'
        ctx.inject(['uiConversation'], (scope) => {
          scope.effect(() => {
            const conversation = scope.uiConversation
            if (conversation === undefined || conversation === null) {
              sentRule = 'no-service'
              return () => {}
            }
            try {
              const off = conversation.userText.register({
                id: 'element-ref',
                order: 35,
                match(text, from) {
                  // In quote style the reference IS a quote card; decorating it again
                  // would put our chip inside DSH's own quote preview.
                  if (referenceStyle !== 'chip') return undefined
                  SENT_PATTERN.lastIndex = from
                  const found = SENT_PATTERN.exec(text)
                  if (found === null) return undefined
                  const raw = found[0]
                  return { id: 'element-ref', start: found.index, end: found.index + raw.length, data: parseUserBlock(raw) }
                },
              })
              sentRule = 'registered'
              return typeof off === 'function' ? off : () => {}
            } catch (error) {
              sentRule = 'error: ' + String(error && error.message ? error.message : error).slice(0, 120)
              return () => {}
            }
          }, 'element-ref: sent-text rule')
        })

        ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => {
          try {
            return ctx.slots.register(
              { name: 'conversation.user.text.node', key: 'element-ref', priority: 100 },
              SentReference,
            )
          } catch (error) {
            return () => {}
          }
        }), 'element-ref: sent-text renderer')

        // Chip owner: the composer asks this codec at submit time for the model
        // text of every chip this source produced.
        ctx.effect(
          () => ctx.inputTriggers.registerSource({
            trigger: '@',
            name: SOURCE,
            order: 80,
            showGroupTitle: false,
            candidates() {
              return Promise.resolve([])
            },
            onPick() {
              return undefined
            },
            codec: {
              clipboardText: (ref) => clipboardOf(parsePayload(ref)),
              serialize: (ref) => Promise.resolve(formatReference(parsePayload(ref))),
            },
            openReference(session, reference) {
              const payload = parsePayload(reference && reference.ref)
              if (payload === null) return false
              void flashPayload(payload)
              return true
            },
          }),
          'element-ref: reference source',
        )

        const strip = {
          observer: null,
          timer: 0,
          start() {
            syncStrip()
            // Chat streaming, session rows and toasts mutate the DOM constantly. The
            // strip only cares about the sidebar anchors and about a guest appearing,
            // so unrelated mutations must cost nothing (they used to clear the guest
            // cache and force a whole-document rescan on every tick).
            this.observer = new MutationObserver((mutations) => {
              perf.callbacks += 1
              for (const mutation of mutations) {
                let related = false
                for (const node of mutation.addedNodes) {
                  if (isPickableShell(node)) { related = true; break }
                }
                if (!related) {
                  for (const node of mutation.removedNodes) {
                    if (isPickableShell(node)) { related = true; break }
                  }
                }
                if (related) {
                  perf.related += 1
                  // A panel that opens after the arm click brings its <webview> with it.
                  guestCache = { at: 0, list: [] }
                  schedule()
                  return
                }
              }
            })
            if (document.body !== null) this.observer.observe(document.body, { childList: true, subtree: true })
            window.addEventListener('resize', schedule)
            window.addEventListener('focus', schedule)
            window.addEventListener('blur', onWindowBlur)
          },
          destroy() {
            if (this.observer !== null) this.observer.disconnect()
            this.observer = null
            clearTimeout(this.timer)
            this.timer = 0
            window.removeEventListener('resize', schedule)
            window.removeEventListener('focus', schedule)
            window.removeEventListener('blur', onWindowBlur)
            closeMenu()
            const existing = document.getElementById(BUTTON_ID)
            if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)
          },
        }

        /** Window focus loss ends the guest highlight; named so destroy can remove it. */
        function onWindowBlur() {
          if (state.armed) clearGuestHighlights()
        }

        function schedule() {
          if (strip.timer !== 0) return
          strip.timer = setTimeout(() => {
            strip.timer = 0
            const started = performance.now()
            syncStrip()
            perf.syncs += 1
            perf.syncMs += performance.now() - started
          }, 200)
        }

        /** Only these nodes can change what the strip does: sidebar anchors and guests. */
        const SHELL_SELECTOR = 'webview, [data-sidebar-right-toggle], [data-sidebar-right-mode], [data-sidebar-right-expand]'
        function isPickableShell(node) {
          if (!node || node.nodeType !== 1) return false
          try {
            if (typeof node.matches === 'function' && node.matches(SHELL_SELECTOR)) return true
            if (typeof node.querySelector === 'function' && node.querySelector(SHELL_SELECTOR) !== null) return true
          } catch (error) {
            return false
          }
          return false
        }

        ctx.effect(() => {
          strip.start()
          // Seed the detail/budget knobs from the Host once; they rarely change.
          void refreshStatus()
          // Report the guest situation on boot (and once more after the panel has had
          // time to mount) so the cause is readable from outside without arming.
          const diagTimers = [2500, 9000].map((delay) => setTimeout(() => {
            void refreshStatus().then(() => reportDiagnostics({ phase: 'boot' }))
          }, delay))
          const perfTimer = setInterval(() => {
            if (document.visibilityState !== 'visible') return
            void hostJson('/diag', { phase: 'perf', perf: { callbacks: perf.callbacks, related: perf.related, syncs: perf.syncs, syncMs: Math.round(perf.syncMs * 10) / 10, scans: perf.scans, evals: perf.evals } }).catch(() => {})
          }, 15000)
          return () => {
            for (const timer of diagTimers) clearTimeout(timer)
            clearInterval(perfTimer)
            strip.destroy()
            stopEverything('disposed')
            if (toastNode !== null && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode)
            toastNode = null
          }
        }, 'element-ref: strip button')

        try {
          window.__dshElementRef = {
            arm: () => { void startArming() },
            disarm: () => { stopEverything('user') },
            insert: (payload) => insertReference(payload),
            format: formatReference,
            /** Support snapshot: which composers are known and which one a pick would target. */
            debug: () => {
              const target = mainSession()
              let mainView = []
              try {
                const listed = ctx.sessions.list.getSnapshot().byId || {}
                mainView = Object.keys(listed).filter((id) => (listed[id].retainedBy?.mainView ?? 0) > 0)
              } catch (error) {
                mainView = []
              }
              return {
                armed: state.armed,
                known: [...bridge.keys()],
                target: target === null ? null : target.sessionId,
                mainView,
                agents: guestList().length,
                sentRule,
              }
            },
          }
        } catch (error) {
          /* a frozen window is not fatal */
        }

        return undefined
      },
    }
  },
})































