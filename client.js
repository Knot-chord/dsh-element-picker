/**
 * dsh-element-picker — 「引用」。
 *
 * 右侧面板顶栏一个图标：点一下进入选取，鼠标划过哪个元素就框出哪个，点一下把它
 * 变成输入框里的原生引用 chip。⌥ 点取元素上的链接，⇧ 点取它携带的文件路径。
 *
 * 选取范围：DSH 自己的界面（含右侧面板）、同源 iframe（逐层 >>> 进去）、以及
 * 侧栏浏览器里的任意网页（Electron <webview>，用 executeJavaScript 在 guest 内部
 * 工作，跨源也能取）。
 *
 * chip 用 composer 自己的 ReferenceChipNode；提交时由我们注册的引用源 codec 展开成
 * 模型文本；点击 chip 回到元素/链接/路径。没有常驻面板、不起端口、不依赖扩展。
 */
window.__ModuleLoader__.load({
  id: 'dsh-element-picker',
  factory(require) {
    const React = require('react')
    const NS = 'dsh-element-picker'
    const BUTTON_ID = 'dsh-element-pick-btn'
    const FRAME_SEP = ' >>> '

    /** Captured from the composer's own inputActions via an invisible slot component. */
    const bridge = { actions: null }
    /** Translator bound in apply; used by factories that outlive that closure. */
    let translate = (key) => key

    const ANCHOR_COLLAPSE = /收起右侧边栏|Collapse right sidebar|收起侧边栏|Collapse sidebar/
    const ANCHOR_SPLIT = /分栏|拆分窗格|分屏|Split pane|^Split$/i

    const ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/>' +
      '<path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/>' +
      '<path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/>' +
      '<path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>' +
      '<circle cx="12" cy="12" r="2.2"/>' +
      '</svg>'

    const LINK_ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.1-2.1a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/>' +
      '<path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.1 2.1a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1"/>' +
      '</svg>'

    const FILE_ICON =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
      '<path d="M14 3v5h5"/>' +
      '</svg>'

    const STYLES = [
      '[data-dsh-ep-strip]{display:inline-flex;align-items:center;justify-content:center;flex:none;',
      'padding:0 2px;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:6px}',
      '[data-dsh-ep-strip]:hover{background:var(--dsw-alias-bg-layer-2)}',
      '[data-dsh-ep-strip][data-on]{color:var(--dsw-alias-brand-primary)}',
      '[data-dsh-ep-strip]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '[data-dsh-ep-strip] svg{display:block;width:16px;height:16px}',
      '.dsh-ep-box{position:fixed;z-index:2147483646;pointer-events:none;display:none;',
      'border:1px solid var(--dsw-alias-brand-primary, #6cf);border-radius:2px;',
      'background:rgba(90,180,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 0 16px rgba(90,180,255,0.35)}',
      '.dsh-ep-tip{position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:70vw;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 6px;border-radius:4px;',
      'background:#0b1220;color:#dff1ff;border:1px solid rgba(120,200,255,0.5);',
      'font:11px/1.4 ui-monospace,Menlo,Consolas,monospace}',
      '.dsh-ep-tip[data-warn]{background:#3a1d1d;color:#ffd9d9;border-color:rgba(255,140,140,0.6)}',
      '.dsh-ep-chip{display:inline-flex;align-items:baseline;gap:3px;max-width:240px;',
      'color:var(--dsw-alias-state-business-primary);vertical-align:baseline;padding:0 4px;',
      'border-radius:var(--dsw-radius-sm);cursor:pointer}',
      '.dsh-ep-chip:hover{background:var(--dsw-alias-state-business-tertiary)}',
      '.dsh-ep-chip-icon{display:inline-flex;flex:none;align-self:center}',
      '.dsh-ep-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ep-flash{position:fixed;z-index:2147483646;pointer-events:none;border-radius:2px;',
      'border:2px solid var(--dsw-alias-brand-primary, #4c8dff);background:rgba(90,180,255,0.18);',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.45),0 0 18px rgba(90,180,255,0.45);transition:opacity .3s ease}',
      '.dsh-ep-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;',
      'padding:6px 12px;border-radius:8px;background:rgba(20,26,36,0.94);color:#e8f3ff;font-size:12px;',
      'border:1px solid rgba(120,200,255,0.35);opacity:0;pointer-events:none;transition:opacity .18s ease}',
      '.dsh-ep-toast[data-show]{opacity:1}',
    ].join('')

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshElementPicker = '1'
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ------------------------------------------------------------------ DOM */

    function docOf(node) {
      return (node && node.ownerDocument) || document
    }

    function classesOf(node) {
      if (!node.classList) return []
      return Array.from(node.classList).filter((name) => name.indexOf('dsh-ep') !== 0)
    }

    function labelOf(node) {
      const classes = classesOf(node).slice(0, 3).join('.')
      return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (classes ? '.' + classes : '')
    }

    function ownText(node) {
      let text = ''
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) text += child.nodeValue
      }
      return text.replace(/\s+/g, ' ').trim().slice(0, 90)
    }

    function shortLabel(node) {
      const classes = classesOf(node)
      const base = node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (classes.length ? '.' + classes[0] : '')
      const text = ownText(node) || (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      return text ? base + ' · ' + text.slice(0, 32) : base
    }

    /** Chain of frame elements from the top document down to the node's document. */
    function framesOf(node) {
      const chain = []
      let doc = node.ownerDocument
      let guard = 0
      while (doc && doc !== document && guard < 8) {
        guard += 1
        const view = doc.defaultView
        const frame = view ? view.frameElement : null
        if (!frame) break
        chain.unshift(frame)
        doc = frame.ownerDocument
      }
      return chain
    }

    function selectorFor(node) {
      if (!node || node.nodeType !== 1) return ''
      const doc = docOf(node)
      if (node.id) {
        try {
          if (doc.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id)
        } catch (error) { /* fall through */ }
      }
      const path = []
      let cur = node
      while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
        let seg = cur.tagName.toLowerCase()
        if (cur.id) {
          try {
            if (doc.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) {
              path.unshift('#' + CSS.escape(cur.id))
              break
            }
          } catch (error) { /* ignore */ }
        }
        const classes = classesOf(cur).slice(0, 2)
        if (classes.length) seg += '.' + classes.map((name) => CSS.escape(name)).join('.')
        const parent = cur.parentElement
        if (parent) {
          const same = Array.from(parent.children).filter((child) => child.tagName === cur.tagName)
          if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
        }
        path.unshift(seg)
        try {
          if (doc.querySelectorAll(path.join(' > ')).length === 1) break
        } catch (error) { /* keep walking */ }
        cur = cur.parentElement
      }
      return path.join(' > ')
    }

    /** The node's rect translated into the top document's viewport coordinates. */
    function topRect(node) {
      const rect = node.getBoundingClientRect()
      let x = rect.left
      let y = rect.top
      let doc = node.ownerDocument
      let guard = 0
      while (doc && doc !== document && guard < 8) {
        guard += 1
        const view = doc.defaultView
        const frame = view ? view.frameElement : null
        if (!frame) break
        const frameRect = frame.getBoundingClientRect()
        x += frameRect.left
        y += frameRect.top
        doc = frame.ownerDocument
      }
      return { x, y, width: rect.width, height: rect.height }
    }

    /** The top document plus every same-origin frame document, recursively. */
    function reachableDocuments(root = document, out = [], depth = 0) {
      if (out.indexOf(root) === -1) out.push(root)
      if (depth > 6) return out
      let frames = []
      try {
        frames = Array.from(root.querySelectorAll('iframe, frame'))
      } catch (error) {
        frames = []
      }
      for (const frame of frames) {
        let inner = null
        try {
          inner = frame.contentDocument
        } catch (error) {
          inner = null
        }
        if (inner && inner.documentElement) reachableDocuments(inner, out, depth + 1)
      }
      return out
    }

    function visibleComposer() {
      const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
      const candidates = nodes.filter((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 80 && rect.height > 12 && rect.bottom > 0 && rect.top < window.innerHeight + 240
      })
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
      return candidates[0] || null
    }

    function insertIntoComposer(text) {
      const target = visibleComposer()
      if (target === null) return false
      target.focus()

      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        const next = target.value ? target.value.replace(/\s*$/, '') + '\n\n' + text : text
        setter.call(target, next)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.setSelectionRange(next.length, next.length)
        return true
      }

      try {
        const selection = target.ownerDocument.getSelection()
        const range = document.createRange()
        range.selectNodeContents(target)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (error) { /* caret placement is best effort */ }

      const before = target.textContent || ''
      const payload = (before.trim() === '' ? '' : '\n\n') + text
      let inserted = false
      try {
        inserted = document.execCommand('insertText', false, payload)
      } catch (error) {
        inserted = false
      }
      if (!inserted) target.textContent = before + payload
      target.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    /* --------------------------------------------------------------- kinds */

    const KINDS = {
      element: { prefix: '[引用元素]', source: 'element-picker', glyph: () => ICON },
      url: { prefix: '[引用网址]', source: 'element-picker:url', glyph: () => LINK_ICON },
      file: { prefix: '[引用文件]', source: 'element-picker:file', glyph: () => FILE_ICON },
    }

    function kindOf(value) {
      return KINDS[value] === undefined ? 'element' : value
    }

    function glyphFor(kind) {
      return KINDS[kindOf(kind)].glyph().replace('width="16" height="16"', 'width="14" height="14"')
    }

    function parsePayload(ref) {
      try {
        const parsed = JSON.parse(String(ref))
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        return null
      }
    }

    /** One payload → the block the model reads, without the trailing newline. */
    function fieldsOf(payload) {
      const kind = kindOf(payload.kind)
      const lines = [KINDS[kind].prefix + ' ' + (payload.label || '')]
      if (kind === 'element') {
        if (payload.selector) lines.push('选择器: ' + payload.selector)
        if (payload.page) lines.push('页面: ' + payload.page)
        if (payload.frame) lines.push('框架: ' + payload.frame)
        if (payload.text) lines.push('文本: ' + payload.text)
      } else if (kind === 'url') {
        if (payload.url) lines.push('链接: ' + payload.url)
      } else if (kind === 'file') {
        if (payload.path) lines.push('路径: ' + payload.path)
      }
      return lines.join('\n')
    }

    /** Submit-time model form; the trailing newline keeps later typing out of the block. */
    function decodeRef(ref) {
      const payload = parsePayload(ref)
      if (payload === null) return '[引用元素] ' + String(ref)
      return fieldsOf(payload) + '\n'
    }

    /** Nearest ancestor carrying an href/src, resolved against its document base. */
    function urlOf(node) {
      let current = node
      for (let depth = 0; current && current.nodeType === 1 && depth < 4; depth += 1) {
        const raw = current.getAttribute('href') || current.getAttribute('data-url') || current.getAttribute('src')
        if (typeof raw === 'string' && raw !== '' && !raw.startsWith('#') && !raw.startsWith('javascript:')) {
          try {
            const url = new URL(raw, docOf(current).baseURI || location.href).href
            const text = ownText(current) || current.getAttribute('title') || url
            return { url, label: text.slice(0, 60) }
          } catch (error) { /* not a URL */ }
        }
        current = current.parentElement
      }
      return null
    }

    /** Nearest ancestor carrying a filesystem path. */
    function pathOf(node) {
      let current = node
      for (let depth = 0; current && current.nodeType === 1 && depth < 4; depth += 1) {
        const raw =
          current.getAttribute('data-path') ||
          current.getAttribute('data-file') ||
          current.getAttribute('data-src') ||
          current.getAttribute('title')
        const href = current.getAttribute('href') || ''
        const path =
          typeof raw === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)/.test(raw.trim())
            ? raw.trim()
            : href.startsWith('file://')
              ? decodeURIComponent(href.slice(7))
              : ''
        if (path !== '') {
          const parts = path.split(/[\\/]/u).filter(Boolean)
          return { path, label: parts.length > 0 ? parts[parts.length - 1] : path }
        }
        current = current.parentElement
      }
      return null
    }

    /** Payload for one pick; a kind with nothing to carry falls back to the element. */
    function buildPayload(kind, node, page) {
      if (kind === 'url') {
        const found = urlOf(node)
        if (found !== null) return { kind: 'url', label: found.label, url: found.url }
      }
      if (kind === 'file') {
        const found = pathOf(node)
        if (found !== null) return { kind: 'file', label: found.label, path: found.path }
      }
      const chain = framesOf(node)
      const selector = selectorFor(node)
      const full =
        chain.length === 0 ? selector : chain.map((frame) => selectorFor(frame)).join(FRAME_SEP) + FRAME_SEP + selector
      const top = chain.length === 0 ? null : chain[chain.length - 1]
      return {
        kind: 'element',
        label: shortLabel(node),
        selector: full,
        page: page || location.href,
        frame: top === null ? '' : top.getAttribute('src') || top.getAttribute('data-src') || '',
        text: ownText(node),
      }
    }

    /* -------------------------------------------------------------- editor */

    /** Find the composer's Lexical editor through the composer DOM's React fiber. */
    function findEditor() {
      const root = document.querySelector('[contenteditable="true"]')
      if (root === null) return null
      const key = Object.keys(root).find(
        (name) => name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0,
      )
      if (key === undefined) return null
      let fiber = root[key]
      for (let depth = 0; fiber && depth < 90; depth += 1) {
        const props = fiber.memoizedProps
        if (props && typeof props === 'object') {
          const value = props.value
          if (value && typeof value === 'object' && typeof value.update === 'function' && value._nodes) return value
          if (props.editor && typeof props.editor.update === 'function' && props.editor._nodes) return props.editor
        }
        fiber = fiber.return
      }
      return null
    }

    /** The composer's own `reference-chip` node class from the editor's node map. */
    function chipClassOf(editor) {
      const nodes = editor._nodes
      const entry = nodes instanceof Map ? nodes.get('reference-chip') : nodes['reference-chip']
      const klass = entry && (entry.klass || entry)
      return klass && typeof klass.importJSON === 'function' ? klass : null
    }

    /** Insert a real composer chip at the draft selection. */
    function commitChip(payload) {
      const editor = findEditor()
      if (editor === null) return false
      try {
        patchChipDecorate()
      } catch (error) { /* chips still work through the shipped renderer */ }
      const Chip = chipClassOf(editor)
      if (Chip === null) return false
      const kind = kindOf(payload.kind)
      const refData = { ...payload, kind }
      delete refData.clipboard
      try {
        const root = document.querySelector('[contenteditable="true"]')
        if (root !== null && typeof root.focus === 'function') root.focus()
        editor.update(() => {
          const node = Chip.importJSON({
            type: 'reference-chip',
            version: 1,
            source: KINDS[kind].source,
            ref: JSON.stringify(refData),
            label: payload.label || '',
            appearance: kind === 'file' ? 'file' : undefined,
            clipboardText: payload.clipboard || fieldsOf({ ...payload, kind }),
            invalid: false,
          })
          const state = editor.getEditorState()
          const selection = state ? state._selection : null
          if (selection === null || typeof selection.insertNodes !== 'function') {
            throw new Error('no composer selection')
          }
          selection.insertNodes([node])
        })
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * Plain-text insertion for when no chip can be made: prefer the composer's own
     * inputActions (paste rules, undoable), fall back to a DOM edit.
     */
    function commitReference(text) {
      const actions = bridge.actions
      if (actions !== null && typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
        try {
          const span = actions.captureInsertion()
          if (actions.insertText(text, span) === true) return true
        } catch (error) { /* fall through to the DOM path */ }
      }
      return insertIntoComposer(text)
    }

    /* ---------------------------------------------------------------- chip */

    let chipPatch = null
    let nativeChipClasses = null

    /**
     * The shipped chip's CSS-module class names are build hashes; read them out of
     * the injected stylesheets so our chip looks exactly like a native one, and
     * fall back to our own classes if a future build renames the tags.
     */
    function chipClassNames() {
      if (nativeChipClasses !== null) return nativeChipClasses
      const readCss = (tagId) => {
        const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')
        return tag === null ? '' : tag.textContent || ''
      }
      const pick = (css, suffix) => {
        const match = new RegExp('\\.([A-Za-z0-9_-]+)_' + suffix + '\\s*\\{').exec(css)
        return match === null ? '' : match[1] + '_' + suffix
      }
      const chipCss = readCss('@deepseek-ai/dsh-client-ui-conversation/ReferenceChip.module.css')
      nativeChipClasses = {
        reference: pick(readCss('@deepseek-ai/dsh-client-ui-conversation/composer-editor.module.css'), 'reference'),
        chip: pick(chipCss, 'chip'),
        icon: pick(chipCss, 'icon'),
        label: pick(chipCss, 'label'),
      }
      return nativeChipClasses
    }

    /**
     * The chip's glyph comes from a fixed appearance vocabulary with no entry for
     * our kinds, so take the node over for our own sources — our chip body, our
     * per-kind glyph — and let every other source fall through untouched.
     */
    function patchChipDecorate() {
      if (chipPatch !== null) return true
      const editor = findEditor()
      if (editor === null) return false
      const Chip = chipClassOf(editor)
      if (Chip === null) return false
      const original = Chip.prototype.decorate
      if (typeof original !== 'function') return false
      Chip.prototype.decorate = function patchedDecorate() {
        try {
          const source = this.__source
          if (typeof source === 'string' && source.indexOf('element-picker') === 0) {
            const payload = parsePayload(this.__ref)
            const kind = kindOf(payload === null ? 'element' : payload.kind)
            const names = chipClassNames()
            const native = names.reference !== '' && names.chip !== ''
            return React.createElement(
              'span',
              {
                className: native ? names.reference + ' ' + names.chip : 'dsh-ep-chip',
                'data-kind': kind,
                title: this.__label || '',
              },
              React.createElement('span', {
                className: native ? names.icon : 'dsh-ep-chip-icon',
                dangerouslySetInnerHTML: { __html: glyphFor(kind) },
              }),
              React.createElement('span', { className: native ? names.label : 'dsh-ep-chip-label' }, this.__label || ''),
            )
          }
        } catch (error) { /* fall through to the shipped chip */ }
        return original.call(this)
      }
      chipPatch = { Chip, original }
      return true
    }

    function unpatchChipDecorate() {
      if (chipPatch === null) return
      try {
        chipPatch.Chip.prototype.decorate = chipPatch.original
      } catch (error) { /* class already replaced */ }
      chipPatch = null
    }

    /* -------------------------------------------------------------- locate */

    function flashBox(rect) {
      const node = document.createElement('div')
      node.className = 'dsh-ep-flash'
      node.style.left = rect.x + 'px'
      node.style.top = rect.y + 'px'
      node.style.width = rect.width + 'px'
      node.style.height = rect.height + 'px'
      document.body.appendChild(node)
      setTimeout(() => {
        node.style.opacity = '0'
      }, 900)
      setTimeout(() => {
        if (node.parentNode) node.parentNode.removeChild(node)
      }, 1300)
    }

    function flashInDocument(doc, selector) {
      let node = null
      try {
        node = doc.querySelector(selector)
      } catch (error) {
        return false
      }
      if (node === null) return false
      try {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      } catch (error) {
        try {
          node.scrollIntoView()
        } catch (inner) { /* detached */ }
      }
      flashBox(topRect(node))
      return true
    }

    const WEBVIEW_FLASH =
      '(function (sel) { try { var el = document.querySelector(sel); if (!el) return "miss"; ' +
      'el.scrollIntoView({ block: "center", inline: "nearest" }); var r = el.getBoundingClientRect(); ' +
      'var d = document.createElement("div"); d.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;' +
      'border:2px solid #4c8dff;background:rgba(90,180,255,0.18);border-radius:2px;left:" + r.left + "px;top:" + r.top + ' +
      '"px;width:" + r.width + "px;height:" + r.height + "px;transition:opacity .3s ease"; ' +
      'document.documentElement.appendChild(d); setTimeout(function () { d.style.opacity = "0"; }, 900); ' +
      'setTimeout(function () { d.remove(); }, 1300); return "ok"; } catch (e) { return "err"; } })'

    /** Clicking a reference points back at what it names. */
    function flashReference(payload) {
      const raw = payload && payload.selector
      if (typeof raw !== 'string' || raw === '') return false
      const parts = raw.split(FRAME_SEP).map((part) => part.trim()).filter(Boolean)
      if (parts.length === 0) return false
      let doc = document
      for (let step = 0; step < parts.length - 1; step += 1) {
        let frame = null
        try {
          frame = doc.querySelector(parts[step])
        } catch (error) {
          frame = null
        }
        if (frame === null || frame.contentDocument == null) return false
        doc = frame.contentDocument
      }
      const leaf = parts[parts.length - 1]
      if (flashInDocument(doc, leaf)) return true
      const views = Array.from(document.querySelectorAll('webview')).filter(
        (node) => typeof node.executeJavaScript === 'function',
      )
      for (const view of views) {
        try {
          if (payload.page && typeof view.getURL === 'function') {
            const current = view.getURL() || ''
            if (current !== '' && current !== payload.page) continue
          }
          const result = view.executeJavaScript(WEBVIEW_FLASH + '(' + JSON.stringify(leaf) + ')')
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (error) { /* guest not ready */ }
      }
      return false
    }

    /* ------------------------------------------------------------- actions */

    let toastNode = null
    let toastTimer = 0

    function toast(message) {
      if (toastNode === null || toastNode.parentNode === null) {
        toastNode = document.createElement('div')
        toastNode.className = 'dsh-ep-toast'
        document.body.appendChild(toastNode)
      }
      toastNode.textContent = message
      toastNode.dataset.show = '1'
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        if (toastNode !== null) toastNode.dataset.show = ''
      }, 1600)
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).catch(() => {})
          return true
        }
      } catch (error) { /* clipboard unavailable */ }
      return false
    }

    function openUrl(url) {
      const views = Array.from(document.querySelectorAll('webview')).filter(
        (node) => typeof node.loadURL === 'function',
      )
      for (const view of views) {
        try {
          view.loadURL(url)
          toast(translate('openedUrl'))
          return true
        } catch (error) { /* guest not ready */ }
      }
      copyText(url)
      toast(translate('copiedUrl'))
      return true
    }

    /** Clicking a reference routes by kind: locate, navigate, or copy. */
    function openPayload(payload) {
      if (payload === null || typeof payload !== 'object') return false
      const kind = kindOf(payload.kind)
      if (kind === 'url' && payload.url) return openUrl(payload.url)
      if (kind === 'file' && payload.path) {
        copyText(payload.path)
        toast(translate('copiedPath'))
        return true
      }
      return flashReference(payload)
    }

    /* ------------------------------------------------------- sent messages */

    /**
     * Sent-message side: recognize a reference block in the user's text and render
     * it as one inline chip instead of its raw lines. Only presentation changes.
     */
    const REFERENCE_RULE = {
      id: 'element',
      order: 35,
      match(text, from) {
        const pattern = /\[引用(元素|网址|文件)\][^\n]*(?:\n(?:选择器|页面|框架|文本|链接|路径):[^\n]*)*/gu
        pattern.lastIndex = from
        const found = pattern.exec(text)
        if (found === null) return undefined
        const raw = found[0]
        const kind = found[1] === '网址' ? 'url' : found[1] === '文件' ? 'file' : 'element'
        const lines = raw.split('\n')
        const label = lines[0].replace(/^\[引用(?:元素|网址|文件)\]\s*/u, '').trim()
        const data = { kind, label, selector: '', page: '', frame: '', text: '', url: '', path: '', raw }
        for (const line of lines.slice(1)) {
          const field = /^(选择器|页面|框架|文本|链接|路径):\s*(.*)$/u.exec(line)
          if (field === null) continue
          if (field[1] === '选择器') data.selector = field[2]
          else if (field[1] === '页面') data.page = field[2]
          else if (field[1] === '框架') data.frame = field[2]
          else if (field[1] === '文本') data.text = field[2]
          else if (field[1] === '链接') data.url = field[2]
          else data.path = field[2]
        }
        return { id: 'element', start: found.index, end: found.index + raw.length, data }
      },
    }

    function ElementReference(props) {
      const node = props.node || {}
      const data = node.data || {}
      const label = data.label || ''
      const kind = kindOf(data.kind)
      const usable =
        (kind === 'element' && data.selector) || (kind === 'url' && data.url) || (kind === 'file' && data.path)
      const clickable = props.interactive === true && Boolean(usable)
      const glyph = KINDS[kind].glyph().replace('width="16" height="16"', 'width="12" height="12"')
      return React.createElement(
        'span',
        {
          className: 'dsh-ep-chip',
          title: props.raw || data.raw || label,
          'data-kind': kind,
          onClick: clickable ? () => openPayload(data) : undefined,
        },
        React.createElement('span', { className: 'dsh-ep-chip-icon', dangerouslySetInnerHTML: { __html: glyph } }),
        React.createElement('span', { className: 'dsh-ep-chip-label' }, label),
      )
    }

    /* -------------------------------------------------------- webview agent */

    const WEBVIEW_AGENT = [
      '(function () {',
      '  if (window.__dshEpAgent) return "ready";',
      '  var state = { active: false, hover: null, picked: null };',
      '  function cls(el) {',
      '    var out = [];',
      '    for (var i = 0; i < el.classList.length; i += 1) {',
      '      var name = el.classList[i];',
      '      if (name.indexOf("dsh-ep") !== 0) out.push(name);',
      '    }',
      '    return out;',
      '  }',
      '  function labelOf(el) {',
      '    var c = cls(el).slice(0, 3).join(".");',
      '    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (c ? "." + c : "");',
      '  }',
      '  function selectorOf(el) {',
      '    if (el.id) {',
      '      try { if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id); } catch (e) {}',
      '    }',
      '    var path = [];',
      '    var cur = el;',
      '    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {',
      '      var seg = cur.tagName.toLowerCase();',
      '      if (cur.id) {',
      '        try {',
      '          if (document.querySelectorAll("#" + CSS.escape(cur.id)).length === 1) { path.unshift("#" + CSS.escape(cur.id)); break; }',
      '        } catch (e) {}',
      '      }',
      '      var cs = cls(cur).slice(0, 2);',
      '      for (var i = 0; i < cs.length; i += 1) seg += "." + CSS.escape(cs[i]);',
      '      var parent = cur.parentElement;',
      '      if (parent) {',
      '        var same = [];',
      '        for (var j = 0; j < parent.children.length; j += 1) { if (parent.children[j].tagName === cur.tagName) same.push(parent.children[j]); }',
      '        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";',
      '      }',
      '      path.unshift(seg);',
      '      try { if (document.querySelectorAll(path.join(" > ")).length === 1) break; } catch (e) {}',
      '      cur = cur.parentElement;',
      '    }',
      '    return path.join(" > ");',
      '  }',
      '  function textOf(el) {',
      '    var out = "";',
      '    for (var i = 0; i < el.childNodes.length; i += 1) { if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].nodeValue; }',
      '    out = out.replace(/\\s+/g, " ").trim().slice(0, 90);',
      '    if (!out) out = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90);',
      '    return out;',
      '  }',
      '  function describe(el) {',
      '    var r = el.getBoundingClientRect();',
      '    return { label: labelOf(el), selector: selectorOf(el), text: textOf(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };',
      '  }',
      '  function detach() {',
      '    state.active = false;',
      '    state.hover = null;',
      '    document.removeEventListener("mousemove", onMove, true);',
      '    document.removeEventListener("click", onClick, true);',
      '    document.removeEventListener("keydown", onKey, true);',
      '    document.removeEventListener("mouseout", onOut, true);',
      '  }',
      '  function onMove(e) {',
      '    if (!state.active) return;',
      '    var el = e.target;',
      '    if (!el || el.nodeType !== 1) return;',
      '    state.hover = describe(el);',
      '  }',
      '  function onClick(e) {',
      '    if (!state.active) return;',
      '    var el = e.target;',
      '    if (!el || el.nodeType !== 1) return;',
      '    e.preventDefault();',
      '    e.stopPropagation();',
      '    state.picked = describe(el);',
      '    detach();',
      '  }',
      '  function onKey(e) { if (e.key === "Escape") detach(); }',
      '  function onOut(e) { if (!e.relatedTarget) state.hover = null; }',
      '  window.__dshEpAgent = {',
      '    start: function () {',
      '      if (state.active) return "started";',
      '      state.active = true;',
      '      state.hover = null;',
      '      state.picked = null;',
      '      document.addEventListener("mousemove", onMove, true);',
      '      document.addEventListener("click", onClick, true);',
      '      document.addEventListener("keydown", onKey, true);',
      '      document.addEventListener("mouseout", onOut, true);',
      '      return "started";',
      '    },',
      '    stop: function () { detach(); state.picked = null; return "stopped"; },',
      '    reset: function () { state.picked = null; state.hover = null; return "reset"; },',
      '    read: function () { return { active: state.active, hover: state.hover, picked: state.picked }; },',
      '  };',
      '  return "ready";',
      '})()',
    ].join('\n')

    function buildWebviewReference(picked, url) {
      return fieldsOf({
        kind: 'element',
        label: picked.label,
        selector: picked.selector ? 'webview' + FRAME_SEP + picked.selector : '',
        page: url || '',
        text: picked.text || '',
      })
    }

    /* --------------------------------------------------------------- picker */

    /** Hover highlight + one-click capture across the top document and same-origin frames. */
    function createPicker(t) {
      let box = null
      let tip = null
      let active = false
      let hovered = null
      let warnTimer = 0
      let scanTimer = 0
      const bound = new Map()
      let viewTimer = 0
      let viewHover = null
      let pollBusy = false
      let lastGuestKey = ''
      const startedViews = new Set()
      const attemptAt = new Map()

      function ensureUi() {
        if (box !== null) return
        box = document.createElement('div')
        box.className = 'dsh-ep-box'
        tip = document.createElement('div')
        tip.className = 'dsh-ep-tip'
        document.body.appendChild(box)
        document.body.appendChild(tip)
      }

      function paint(node) {
        if (node === null) {
          box.style.display = 'none'
          if (warnTimer === 0) tip.style.display = 'none'
          return
        }
        const rect = topRect(node)
        box.style.left = rect.x + 'px'
        box.style.top = rect.y + 'px'
        box.style.width = rect.width + 'px'
        box.style.height = rect.height + 'px'
        box.style.display = 'block'
        if (warnTimer !== 0) return
        tip.textContent = labelOf(node)
        delete tip.dataset.warn
        tip.style.left = Math.max(6, Math.min(rect.x, window.innerWidth - 320)) + 'px'
        tip.style.top = Math.max(6, rect.y - 22) + 'px'
        tip.style.display = 'block'
      }

      function warn(message) {
        ensureUi()
        clearTimeout(warnTimer)
        warnTimer = setTimeout(() => {
          warnTimer = 0
          paint(hovered)
        }, 1800)
        tip.textContent = message
        tip.dataset.warn = '1'
        tip.style.left = Math.max(6, Math.min(window.innerWidth - 320, box.offsetLeft)) + 'px'
        tip.style.top = Math.max(6, Number.parseFloat(box.style.top || '0') - 22) + 'px'
        tip.style.display = 'block'
      }

      function targetOf(event, doc) {
        let found = null
        try {
          found = doc.elementFromPoint(event.clientX, event.clientY)
        } catch (error) {
          found = null
        }
        if (found === null || found.nodeType !== 1) return null
        if (found.closest('.dsh-ep-box') || found.closest('.dsh-ep-tip')) return null
        if (found.closest('[data-dsh-ep-strip]')) return null
        return found
      }

      function onMove(event, doc) {
        const next = targetOf(event, doc)
        if (next !== null && next.tagName === 'WEBVIEW') {
          hovered = null
          return
        }
        if (next === hovered) return
        hovered = next
        paint(next)
      }

      function onClick(event, doc) {
        const target = targetOf(event, doc)
        if (target === null) return
        event.preventDefault()
        event.stopPropagation()
        let payload = null
        try {
          const wanted = event.altKey ? 'url' : event.shiftKey ? 'file' : 'element'
          payload = buildPayload(wanted, target, doc === document ? location.href : '')
        } catch (error) {
          payload = null
        }
        hovered = null
        stop()
        if (payload !== null) {
          const reference = fieldsOf(payload)
          payload.clipboard = reference
          if (commitChip(payload)) return
          if (commitReference(reference)) return
        }
        ensureUi()
        warn(payload === null ? t('pickFailed') : t('noComposer'))
      }

      function onKey(event) {
        if (event.key !== 'Escape' || !active) return
        event.preventDefault()
        event.stopPropagation()
        stop()
      }

      function bindDocument(doc) {
        if (bound.has(doc)) return
        const handlers = {
          mousemove: (event) => onMove(event, doc),
          click: (event) => onClick(event, doc),
          keydown: onKey,
        }
        for (const [type, handler] of Object.entries(handlers)) doc.addEventListener(type, handler, true)
        bound.set(doc, handlers)
      }

      function scan() {
        if (!active) return
        for (const doc of reachableDocuments()) bindDocument(doc)
      }

      function unbindAll() {
        for (const [doc, handlers] of bound) {
          for (const [type, handler] of Object.entries(handlers)) {
            try {
              doc.removeEventListener(type, handler, true)
            } catch (error) { /* frame already gone */ }
          }
        }
        bound.clear()
      }

      /* ---- electron <webview> guests: cross-origin pages stay pickable ---- */

      function webviewList() {
        return Array.from(document.querySelectorAll('webview')).filter(
          (node) => typeof node.executeJavaScript === 'function',
        )
      }

      function evalIn(view, code, timeoutMs = 800) {
        try {
          const result = view.executeJavaScript(code)
          const promise = result && typeof result.then === 'function' ? result.catch(() => null) : Promise.resolve(result)
          return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))])
        } catch (error) {
          return Promise.resolve(null)
        }
      }

      function paintGuest(view, hover) {
        ensureUi()
        if (warnTimer !== 0) return
        let base = null
        try {
          base = view.getBoundingClientRect()
        } catch (error) {
          base = null
        }
        if (base === null) return
        const x = Math.round(base.left + hover.rect.x)
        const y = Math.round(base.top + hover.rect.y)
        const w = Math.round(hover.rect.w)
        const h = Math.round(hover.rect.h)
        const key = x + ':' + y + ':' + w + ':' + h + ':' + hover.label
        if (key === lastGuestKey) return
        lastGuestKey = key
        box.style.left = x + 'px'
        box.style.top = y + 'px'
        box.style.width = w + 'px'
        box.style.height = h + 'px'
        box.style.display = 'block'
        tip.textContent = hover.label
        delete tip.dataset.warn
        tip.style.left = Math.max(6, Math.min(x, window.innerWidth - 320)) + 'px'
        tip.style.top = Math.max(6, y - 22) + 'px'
        tip.style.display = 'block'
      }

      async function pollWebviews() {
        if (!active || pollBusy) return
        pollBusy = true
        try {
          for (const view of webviewList()) {
            const snapshot = await evalIn(view, 'window.__dshEpAgent ? window.__dshEpAgent.read() : null', 500)

            if (snapshot === null || typeof snapshot !== 'object') {
              const now = Date.now()
              if (now - (attemptAt.get(view) || 0) < 1200) continue
              attemptAt.set(view, now)
              const injected = await evalIn(view, WEBVIEW_AGENT, 1500)
              if (injected === 'ready') {
                await evalIn(view, 'window.__dshEpAgent.start()', 800)
                startedViews.add(view)
              }
              continue
            }

            if (snapshot.picked) {
              const picked = snapshot.picked
              let url = ''
              try {
                url = (typeof view.getURL === 'function' && view.getURL()) || view.getAttribute('src') || ''
              } catch (error) {
                url = view.getAttribute('src') || ''
              }
              await evalIn(view, 'window.__dshEpAgent && window.__dshEpAgent.reset()', 500)
              hovered = null
              viewHover = null
              lastGuestKey = ''
              stop()
              const reference = buildWebviewReference(picked, url)
              const label = picked.text ? picked.label + ' · ' + picked.text.slice(0, 32) : picked.label
              const payload = {
                kind: 'element',
                label,
                selector: picked.selector,
                page: url,
                text: picked.text,
                clipboard: reference,
              }
              if (!commitChip(payload) && !commitReference(reference)) {
                ensureUi()
                warn(t('noComposer'))
              }
              return
            }

            if (snapshot.active === false) {
              if (!startedViews.has(view)) {
                await evalIn(view, 'window.__dshEpAgent && window.__dshEpAgent.start()', 800)
                startedViews.add(view)
              } else {
                viewHover = null
                lastGuestKey = ''
                stop()
                return
              }
              continue
            }

            if (snapshot.hover) {
              viewHover = view
              paintGuest(view, snapshot.hover)
              return
            }
          }

          if (viewHover !== null) {
            viewHover = null
            lastGuestKey = ''
            paint(null)
          }
        } finally {
          pollBusy = false
        }
      }

      function start() {
        if (active) return
        try {
          patchChipDecorate()
        } catch (error) { /* chips still work through the shipped renderer */ }
        ensureUi()
        active = true
        hovered = null
        viewHover = null
        startedViews.clear()
        tip.textContent = t('hint')
        delete tip.dataset.warn
        tip.style.left = '16px'
        tip.style.top = '16px'
        tip.style.display = 'block'
        scan()
        scanTimer = setInterval(scan, 1000)
        viewTimer = setInterval(pollWebviews, 150)
        pollWebviews()
      }

      function stop() {
        if (!active) return
        active = false
        hovered = null
        clearInterval(scanTimer)
        scanTimer = 0
        clearInterval(viewTimer)
        viewTimer = 0
        for (const view of webviewList()) {
          evalIn(view, 'window.__dshEpAgent && window.__dshEpAgent.stop()')
        }
        startedViews.clear()
        attemptAt.clear()
        viewHover = null
        pollBusy = false
        lastGuestKey = ''
        unbindAll()
        if (warnTimer === 0 && tip !== null) tip.style.display = 'none'
        if (box !== null) box.style.display = 'none'
      }

      function destroy() {
        stop()
        clearTimeout(warnTimer)
        for (const node of [box, tip]) {
          if (node !== null && node.parentNode) node.parentNode.removeChild(node)
        }
        box = null
        tip = null
      }

      return { start, stop, destroy, isActive: () => active }
    }

    /* ---------------------------------------------------------- strip button */

    /**
     * The right panel's tab strip has no extension seat, so the icon is inserted
     * into the same strip chrome, left of the panel's own controls, and re-inserted
     * whenever React re-renders the strip without it.
     */
    function createStripButton(t, picker) {
      let observer = null
      let interval = 0
      let frame = 0

      /** Several session surfaces live in the DOM at once; only one is painted. */
      function isVisible(node) {
        if (node === null || node.nodeType !== 1) return false
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return true
        return node.offsetParent !== null
      }

      function locate() {
        const all = Array.from(document.querySelectorAll('button'))
        const toggles = all.filter((node) => node.hasAttribute('data-sidebar-right-toggle'))
        const labelled = all.filter((node) => ANCHOR_COLLAPSE.test(node.getAttribute('aria-label') || ''))
        const candidates = toggles.length > 0 ? toggles : labelled
        const visible = candidates.filter(isVisible)
        const toggle = visible.length > 0 ? visible[0] : null

        if (toggle !== null) {
          const sample = toggle.className || ''
          let cluster = toggle.parentElement
          let depth = 0
          while (cluster !== null && depth < 4 && cluster.querySelector('[data-sidebar-right-mode]') === null) {
            cluster = cluster.parentElement
            depth += 1
          }
          if (cluster !== null) {
            const mode = cluster.querySelector('[data-sidebar-right-mode]')
            let before = mode
            while (before !== null && before.parentElement !== cluster) before = before.parentElement
            if (before !== null) return { host: cluster, before, sample }
            if (cluster.parentElement !== null) return { host: cluster.parentElement, before: cluster, sample }
          }
          if (toggle.parentElement !== null) return { host: toggle.parentElement, before: toggle, sample }
        }

        const split =
          all.filter((node) => ANCHOR_SPLIT.test(node.getAttribute('aria-label') || '')).filter(isVisible)[0] || null
        if (split !== null && split.parentElement !== null) {
          return { host: split.parentElement, before: split.nextSibling, sample: split.className || '' }
        }
        return null
      }

      function paint() {
        const button = document.getElementById(BUTTON_ID)
        if (button === null) return
        if (picker.isActive()) button.dataset.on = '1'
        else delete button.dataset.on
        button.title = picker.isActive() ? t('btnOn') : t('btn')
        button.setAttribute('aria-label', t('btn'))
      }

      function sync() {
        frame = 0
        const place = locate()
        const existing = document.getElementById(BUTTON_ID)

        if (place === null) {
          if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)
          return
        }
        if (existing !== null && existing.parentNode === place.host) {
          paint()
          return
        }
        if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)

        const button = document.createElement('button')
        button.type = 'button'
        button.id = BUTTON_ID
        button.dataset.dshEpStrip = '1'
        button.className = place.sample || ''
        button.innerHTML = ICON
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (picker.isActive()) picker.stop()
          else picker.start()
          paint()
        })
        place.host.insertBefore(button, place.before)
        paint()
      }

      function schedule() {
        if (frame !== 0) return
        frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sync) : setTimeout(sync, 16)
      }

      function start() {
        const boot = () => {
          sync()
          observer = new MutationObserver(schedule)
          if (document.body !== null) observer.observe(document.body, { childList: true, subtree: true })
          window.addEventListener('resize', schedule)
          interval = setInterval(schedule, 3000)
        }
        if (document.body !== null) boot()
        else document.addEventListener('DOMContentLoaded', boot, { once: true })
      }

      function destroy() {
        if (observer !== null) observer.disconnect()
        observer = null
        clearInterval(interval)
        interval = 0
        window.removeEventListener('resize', schedule)
        const existing = document.getElementById(BUTTON_ID)
        if (existing !== null && existing.parentNode) existing.parentNode.removeChild(existing)
      }

      return { start, destroy, paint }
    }

    /* ------------------------------------------------------------------ app */

    return {
      inject: ['slots', 'locale', 'inputTriggers', 'uiConversation'],
      apply(ctx) {
        // A hot swap can orphan the previous instance's overlay and leave a guest
        // agent capturing clicks; clear both before this instance draws anything.
        for (const stale of Array.from(document.querySelectorAll('.dsh-ep-box, .dsh-ep-tip'))) {
          if (stale.parentNode) stale.parentNode.removeChild(stale)
        }
        for (const view of Array.from(document.querySelectorAll('webview'))) {
          try {
            const result = view.executeJavaScript(
              'typeof window.__dshEpAgent === "object" ? window.__dshEpAgent.stop() : "none"',
            )
            if (result && typeof result.catch === 'function') result.catch(() => {})
          } catch (error) { /* guest not ready */ }
        }

        ctx.effect(() => installStyles(), 'dsh-element-picker: styles')
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: {
                btn: '引用：点一下开始选取（Esc 退出）',
                btnOn: '引用：选取中，点一下停止',
                hint: '点元素引用它；⌥ 点取链接、⇧ 点取文件路径；Esc 退出',
                noComposer: '没找到输入框 —— 先点一下输入框再试',
                pickFailed: '这个元素取不到引用信息',
                openedUrl: '已在侧栏打开这个链接',
                copiedUrl: '链接已复制',
                copiedPath: '路径已复制',
              },
              en: {
                btn: 'Reference: click to start picking (Esc to exit)',
                btnOn: 'Reference: picking — click to stop',
                hint: 'Click an element; ⌥-click for its link, ⇧-click for its file path; Esc to exit',
                noComposer: 'No composer found — click the composer first',
                pickFailed: 'Could not read this element',
                openedUrl: 'Opened the link in the sidebar',
                copiedUrl: 'Link copied',
                copiedPath: 'Path copied',
              },
            }),
          'dsh-element-picker: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        translate = t

        // Invisible seat in the composer dock: the only way public code reaches the
        // composer's own `inputActions`.
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                { name: 'conversation.input.dock', id: 'element-picker-input-bridge', order: 900 },
                (props) => {
                  const actions = props.inputActions || null
                  React.useEffect(() => {
                    bridge.actions = actions
                    return () => {
                      if (bridge.actions === actions) bridge.actions = null
                    }
                  }, [actions])
                  return null
                },
              ),
            ),
          'dsh-element-picker: input bridge',
        )

        // One owner per chip kind: the slash pipeline asks each owner's codec at
        // submit time and routes composer chip clicks into openReference.
        for (const kind of Object.keys(KINDS)) {
          ctx.effect(
            () => {
              try {
                return ctx.inputTriggers.registerSource({
                  trigger: '@',
                  name: KINDS[kind].source,
                  order: 60 + Object.keys(KINDS).indexOf(kind),
                  codec: { serialize: (ref) => Promise.resolve(decodeRef(ref)) },
                  openReference: (session, reference) => openPayload(parsePayload(reference && reference.ref)),
                })
              } catch (error) {
                // A hot swap may race the previous registration's disposal.
                return () => {}
              }
            },
            'dsh-element-picker: source ' + kind,
          )
        }

        // Sent messages: match the block back into a chip instead of raw text.
        ctx.effect(
          () => {
            try {
              const off = ctx.uiConversation.userText.register(REFERENCE_RULE)
              return typeof off === 'function' ? off : () => {}
            } catch (error) {
              return () => {}
            }
          },
          'dsh-element-picker: sent-text rule',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.user.text.node', () => {
              try {
                return ctx.slots.register(
                  { name: 'conversation.user.text.node', key: 'element', priority: 100 },
                  ElementReference,
                )
              } catch (error) {
                return () => {}
              }
            }),
          'dsh-element-picker: sent-text renderer',
        )

        const picker = createPicker(t)
        const strip = createStripButton(t, picker)
        ctx.effect(
          () => () => {
            strip.destroy()
            picker.destroy()
            unpatchChipDecorate()
          },
          'dsh-element-picker: teardown',
        )
        strip.start()
        patchChipDecorate()
      },
    }
  },
})
