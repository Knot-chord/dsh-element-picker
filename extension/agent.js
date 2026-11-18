/**
 * dsh-element-ref — the in-page picker agent.
 *
 * This file is the ONE picker implementation. It is deliberately a classic
 * script (no modules, no imports) because the same bytes are used three ways:
 *
 *   1. DSH's own renderer  — injected by the client half
 *   2. a sidebar <webview> — webview.executeJavaScript(source) by the client half
 *   3. a CDP page target   — Runtime.evaluate / addScriptToEvaluateOnNewDocument
 *
 * It installs `window.__dshRef` and nothing else: no network, no storage, no
 * globals outside that one name. `arm()` draws a highlight and captures one
 * click; the result is handed back through `onpick`, a CDP runtime binding, or
 * `read()` (polling), whichever transport the host uses.
 *
 * @version 1
 */
(function () {
  'use strict'

  var VERSION = 1
  var Z_BOX = 2147483646
  var Z_TIP = 2147483647
  var MAX = { label: 60, desc: 80, selector: 200, selectorAlt: 240, page: 300, text: 90, frame: 200 }

  /** Re-injection is normal (script + evaluate + navigation): keep the live instance. */
  /**
   * Identity of this build. The Host stamps `window.__dshRefBuild` before evaluating
   * the source, so a page that already carries an older kernel replaces it instead of
   * silently keeping the old behaviour (which is exactly what a stale injection looks
   * like: new fields missing with no error anywhere).
   */
  var BUILD = (typeof window !== 'undefined' && typeof window.__dshRefBuild === 'string') ? window.__dshRefBuild : ''
  if (window.__dshRef && window.__dshRef.build === BUILD) return
  if (window.__dshRef && typeof window.__dshRef.disarm === 'function') {
    try {
      window.__dshRef.disarm()
    } catch (error) {
      /* replacing an older kernel: its listeners are the old ones */
    }
  }

  var state = {
    active: false,
    options: null,
    hover: null,
    picked: null,
    box: null,
    tip: null,
    lastMoveAt: 0,
    listeners: [],
    frameTimer: 0,
    tickTimer: 0,
    downTarget: null,
    /** Event counters: the cheapest way to tell "no pick" from "no events at all". */
    seen: { move: 0, down: 0, up: 0 },
    /** Last pointer position in client coordinates, for hit-testing the highlight. */
    pointer: null,
    /** Last tip text: an unchanged tooltip must not rewrite layout every frame. */
    tipText: '',
    /** One-shot message to the client (for example: nothing pickable here). */
    notice: null,
    /** Last thrown error, surfaced so a silent no-op is never a mystery. */
    lastError: '',
  }

  /* --------------------------------------------------------------- helpers */

  function clip(value, max) {
    var text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
    return text.length > max ? text.slice(0, max) : text
  }

  function escapeName(name) {
    try {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(name)
    } catch (error) {
      /* no CSS.escape */
    }
    return String(name).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '\\' + ch })
  }

  /** Build a class name that survives a rebuild: no CSS-module hashes, no CSS-in-JS noise. */
  function stableClass(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 32) return false
    if (/^[A-Za-z0-9]{4,8}_/.test(name)) return false
    if (name.indexOf('__') !== -1) return false
    if (/^(css|sc|jsx|svelte)-/.test(name)) return false
    if (/^[a-z]{1,6}-[0-9a-f]{5,}$/i.test(name)) return false
    if (/^_(jsx|r_|[a-z]+_)/.test(name)) return false
    if (/\d{5,}/.test(name)) return false
    return true
  }

  /** Ids produced by a framework or a counter are not addressable across builds. */
  function unstableId(id) {
    if (typeof id !== 'string' || id === '') return true
    if (/^[0-9]/.test(id)) return true
    if (/^(ember|react|radix|headlessui|mui|rc-|el-|vue|ext-gen|gwt-|yui_)/i.test(id)) return true
    if (/[0-9a-f]{8,}/i.test(id)) return true
    if (/\d{4,}/.test(id)) return true
    return false
  }

  var ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-name', 'data-field', 'data-id', 'name', 'aria-label']

  function rootOf(node) {
    try {
      return node.getRootNode ? node.getRootNode() : node.ownerDocument
    } catch (error) {
      return node.ownerDocument
    }
  }

  function queryCount(root, selector) {
    try {
      return root.querySelectorAll(selector).length
    } catch (error) {
      return 0
    }
  }

  function isRootElement(node, root) {
    if (root && root.nodeType === 9) return node === root.documentElement
    if (root && root.nodeType === 11) return node === root.host
    return false
  }

  /** One path segment: stable id, else a test attribute, else stable classes, else tag. */
  function segmentFor(node, withIndex) {
    if (!node || node.nodeType !== 1) return ''
    var tag = node.tagName.toLowerCase()
    if (node.id && !unstableId(node.id)) return '#' + escapeName(node.id)
    for (var index = 0; index < ATTRS.length; index += 1) {
      var name = ATTRS[index]
      var value = node.getAttribute(name)
      if (typeof value === 'string' && value !== '' && value.length <= 40 && value.indexOf('\n') === -1) {
        return tag + '[' + name + '="' + value.replace(/"/g, '\\"') + '"]'
      }
    }
    var segment = tag
    var classes = []
    try {
      var list = node.classList || []
      for (var at = 0; at < list.length && classes.length < 2; at += 1) {
        if (stableClass(list[at])) classes.push(list[at])
      }
    } catch (error) {
      classes = []
    }
    if (classes.length > 0) segment += '.' + classes.map(escapeName).join('.')
    if (withIndex) {
      var parent = node.parentElement
      if (parent) {
        var same = []
        for (var child = 0; child < parent.children.length; child += 1) {
          if (parent.children[child].tagName === node.tagName) same.push(parent.children[child])
        }
        if (same.length > 1) segment += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
    }
    return segment
  }

  /** Shortest unique locator plus a full structural fallback, both inside the node's own root. */
  function selectorsFor(node) {
    var root = rootOf(node)
    if (!root || typeof root.querySelectorAll !== 'function') return { primary: segmentFor(node, true), alt: '' }
    var found = []
    var push = function (selector) {
      if (found.indexOf(selector) === -1 && queryCount(root, selector) === 1) found.push(selector)
    }
    var suffix = []
    var cur = node
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 40; depth += 1) {
      suffix.unshift(segmentFor(cur, false))
      push(suffix.join(' > '))
      if (isRootElement(cur, root)) break
      cur = cur.parentElement
    }
    var full = []
    cur = node
    for (var step = 0; cur && cur.nodeType === 1 && step < 40; step += 1) {
      full.unshift(segmentFor(cur, true))
      push(full.join(' > '))
      if (isRootElement(cur, root)) break
      cur = cur.parentElement
    }
    return {
      primary: found.length > 0 ? found[0] : segmentFor(node, true),
      alt: found.length > 1 ? found[found.length - 1] : '',
    }
  }

  /** Selector that crosses open shadow roots, using `>>>` the way the agent reads it back. */
  function selectorWithShadow(node) {
    var parts = []
    var cur = node
    for (var guard = 0; cur && cur.nodeType === 1 && guard < 8; guard += 1) {
      parts.unshift(selectorsFor(cur).primary)
      var root = rootOf(cur)
      if (root && root.nodeType === 11 && root.host) {
        cur = root.host
        continue
      }
      break
    }
    return parts.join(' >>> ')
  }

  /** Page identity of the window that owns the element: top URL, iframe chain, frame URL. */
  function contextOf(view) {
    var frame = []
    var cur = view
    var top = view
    for (var guard = 0; cur && guard < 8; guard += 1) {
      try {
        top = cur.top
      } catch (error) {
        top = cur
      }
      var isTop = false
      try {
        isTop = cur === cur.top
      } catch (error) {
        isTop = true
      }
      if (isTop) break
      var element = null
      try {
        element = cur.frameElement
      } catch (error) {
        element = null
      }
      if (!element) break
      frame.unshift(selectorWithShadow(element))
      try {
        cur = cur.parent
      } catch (error) {
        break
      }
    }
    var page = ''
    try {
      page = top.location.href
    } catch (error) {
      try {
        page = view.location.href
      } catch (inner) {
        page = ''
      }
    }
    var frameUrl = ''
    if (frame.length > 0) {
      try {
        frameUrl = view.location.href
      } catch (error) {
        frameUrl = ''
      }
    }
    return { page: page, frame: frame.join(' >>> '), frameUrl: frameUrl }
  }

  /**
   * Text that a person would read: icon-font glyphs (private use area), zero
   * width joiners and script/style bodies are not text.
   */
  var INVISIBLE = /[\u200B-\u200F\u2028\u2029\uFE00-\uFE0F\uE000-\uF8FF]/g
  var NON_TEXT_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|MATH|IFRAME|OBJECT|EMBED|LINK|META|TITLE)$/
  var BLOCK_TAGS = /^(DIV|P|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|UL|OL|LI|TABLE|TR|TD|TH|H1|H2|H3|H4|H5|H6|DD|DT|BLOCKQUOTE|PRE|FORM|FIGURE|FIGCAPTION|HR|BR)$/

  function cleanText(value) {
    return String(value || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  }

  /** Readable text of a subtree, skipping code, icon glyphs and *invisible* text. */
  function visibleText(node, maxChars) {
    var out = ''
    var visited = 0
    var stack = [node]
    while (stack.length > 0 && out.length < maxChars && visited < 600) {
      var current = stack.pop()
      visited += 1
      if (current.nodeType === 3) {
        out += current.nodeValue || ''
        continue
      }
      if (current.nodeType !== 1) continue
      if (NON_TEXT_TAGS.test(current.tagName)) continue
      // Text a user cannot see (screen-reader-only labels, collapsed menus) is not the
      // page's name for anything; including it is how a banner link became "首页".
      if (current.getAttribute) {
        if (current.getAttribute('aria-hidden') === 'true') continue
        var inline = current.getAttribute('style')
        if (inline && /display\s*:\s*none/i.test(inline)) continue
      }
      if (current.hidden === true) continue
      // Block boundaries are word boundaries: without this, sibling blocks concatenate
      // into one unreadable run ("deepseek.comhttps://download.deepseek.com").
      if (BLOCK_TAGS.test(current.tagName)) out += ' '
      for (var index = current.childNodes.length - 1; index >= 0; index -= 1) stack.push(current.childNodes[index])
    }
    return clip(cleanText(out), maxChars)
  }

  function ownText(node) {
    var text = ''
    try {
      for (var index = 0; index < node.childNodes.length; index += 1) {
        var child = node.childNodes[index]
        if (child.nodeType === 3) text += child.nodeValue
      }
    } catch (error) {
      text = ''
    }
    return clip(cleanText(text), MAX.text)
  }

  /** A container is named by its own heading/link/button, not by the blob inside it. */
  function primaryTextOf(node, firstChildText) {
    var nodes = []
    try {
      nodes = node.querySelectorAll('h1, h2, h3, h4, h5, h6, a, button, [role="heading"], [role="link"], [role="button"]')
    } catch (error) {
      nodes = []
    }
    for (var index = 0; index < nodes.length && index < 6; index += 1) {
      if (nodes[index].querySelector('h1, h2, h3, h4, h5, h6, a, button')) continue
      var text = visibleText(nodes[index], MAX.label)
      if (text.length >= 2) return text
    }
    // Tree rows and list items put their name in a plain span, not in a heading or a
    // link: take the first child that carries a readable label, skipping timestamps
    // ("15小时") and meta tails, which are context rather than the name.
    var fallback = firstChildText || ''
    if (fallback !== '' && !looksLikeCode(fallback) &&
      !/^\d+\s*(秒|分钟|小时|天|周|月|年|s|m|h|d)$/.test(fallback) &&
      !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(fallback)) return fallback
    return ''
  }

  function describeTarget(node) {
    if (!node || node.nodeType !== 1) return ''
    var tag = node.tagName.toLowerCase()
    var classes = []
    try {
      for (var index = 0; index < node.classList.length && classes.length < 2; index += 1) {
        if (stableClass(node.classList[index])) classes.push(node.classList[index])
      }
    } catch (error) {
      classes = []
    }
    return tag + (node.id ? '#' + node.id : '') + (classes.length > 0 ? '.' + classes.join('.') : '')
  }

  var ROLE_BY_TAG = {
    A: 'link', BUTTON: 'button', INPUT: 'input', SELECT: 'combobox', TEXTAREA: 'textbox', OPTION: 'option',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', DIALOG: 'dialog', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row',
    TD: 'cell', TH: 'columnheader', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', LABEL: 'label', SUMMARY: 'summary', DETAILS: 'group',
  }

  /** Explicit ARIA role, else the tag's conventional role. */
  function roleOf(node) {
    var explicit = node.getAttribute && node.getAttribute('role')
    if (typeof explicit === 'string' && explicit !== '') return explicit.trim().toLowerCase()
    return ROLE_BY_TAG[node.tagName] || node.tagName.toLowerCase()
  }

  var STATE_ATTRS = ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-current', 'aria-busy']

  /** What the control currently *is*, not just what it says: expanded / pressed / disabled / value. */
  function stateOf(node) {
    var parts = []
    for (var index = 0; index < STATE_ATTRS.length; index += 1) {
      var attr = STATE_ATTRS[index]
      var value = node.getAttribute(attr)
      if (value !== null && value !== '') parts.push(attr + '=' + value)
    }
    if (node.disabled === true) parts.push('disabled')
    if (node.readOnly === true) parts.push('readonly')
    if (node.tagName === 'INPUT') {
      var type = String(node.getAttribute('type') || 'text').toLowerCase()
      if (type !== 'text' && type !== '') parts.push('type=' + type)
      if (type === 'checkbox' || type === 'radio') parts.push('checked=' + (node.checked === true))
      else if (typeof node.value === 'string' && node.value !== '') parts.push('value=' + clip(node.value, 24))
    }
    if (node.tagName === 'A' && typeof node.getAttribute('href') === 'string' && node.getAttribute('href') !== '') {
      parts.push('href=' + clip(node.getAttribute('href'), 60))
    }
    return parts.join(', ')
  }

  /** The first heading of an ancestor that is NOT the element's own title. */
  function regionHeadingOf(node, picked) {
    var children = node.children || []
    for (var index = 0; index < children.length && index < 14; index += 1) {
      var child = children[index]
      if (!/^H[1-6]$/.test(child.tagName)) continue
      // A card's own <h3> is the item's name, not the region it lives in.
      if (picked && child.contains(picked)) continue
      return clip(child.textContent, 28)
    }
    return ''
  }

  /** Landmark roles read as places, not as ARIA tokens. */
  var REGION_ROLE = {
    navigation: '导航', banner: '顶部栏', main: '主区域', complementary: '侧栏', contentinfo: '底部栏',
    dialog: '对话框', region: '区域', form: '表单', table: '表格', menu: '菜单', menubar: '菜单栏',
    tablist: '标签栏', list: '列表', toolbar: '工具栏', search: '搜索',
  }

  /** Our own overlay and trigger are not part of the page's context. */
  function isOurs(node) {
    try {
      return Boolean(node.closest && node.closest('[data-element-ref-strip],[data-element-ref-menu],[data-dsh-element-ref]'))
    } catch (error) {
      return false
    }
  }

  /** Ancestor landmarks and named sections: "会话视图 › 顶部工具区". */
  function regionOf(node) {
    var parts = []
    var named = false
    var cur = node.parentElement
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 9 && parts.length < 4; depth += 1) {
      var role = roleOf(cur)
      var aria = cur.getAttribute && cur.getAttribute('aria-label')
      var heading = regionHeadingOf(cur, node)
      var landmark = REGION_ROLE[role] !== undefined
      if (aria !== null && aria !== '') {
        parts.unshift(clip(aria, 24))
        named = true
      } else if (heading !== '') {
        parts.unshift(heading)
        named = true
      } else if (landmark) {
        parts.unshift(REGION_ROLE[role])
      }
      cur = cur.parentElement
    }
    // A bare container kind ("列表", "区域") tells a model nothing; better to say
    // nothing and let the position line carry the box.
    if (!named) return ''
    return parts.filter(Boolean).join(' › ')
  }

  /** Text of a leaf control, following a single wrapper level (button > span > text). */
  function leafText(node, depth) {
    var kids = node.children || []
    if (kids.length === 0) return visibleText(node, 26)
    if (kids.length === 1 && depth < 2) return leafText(kids[0], depth + 1)
    return ''
  }

  /** Scripts, styles and stray punctuation are not names (a URL is not code). */
  function looksLikeCode(value) {
    return /[<>{};=\\]|^\s*\/\/|\bfunction\s|\bvar\s|\bconst\s|\blet\s|\breturn\s/.test(value)
  }

  /** Short label of one node, for sibling/child context (labels act as names, containers do not). */
  function shortName(node) {
    if (!node || node.nodeType !== 1 || isOurs(node)) return ''
    if (NON_TEXT_TAGS.test(node.tagName)) return ''
    var aria = cleanText(node.getAttribute('aria-label'))
    if (aria !== '') return clip(aria, 24)
    var alt = cleanText(node.getAttribute('alt'))
    if (alt !== '') return clip(alt, 20)
    if (/^(svg|path|g|circle|use|canvas|img|input|textarea|select)$/i.test(node.tagName)) return ''
    var text = leafText(node, 0)
    if (text === '' || text.length < 2 || looksLikeCode(text)) return ''
    return text
  }

  /**
   * The labels around it: "撤销 / 重做 / 剪切", which tells a model what menu this is.
   * Tooltip sentences ("…请按空格键…拖动时…") are instructions, not names: they are
   * dropped so the line stays context instead of noise.
   */
  var ACTION_HINT = /^(请|按|拖动|使用|点击|双击|长按|可拖|拖拽)/
  function nearbyOf(node) {
    var parent = node.parentElement
    if (!parent) return ''
    var out = []
    var total = 0
    var children = parent.children || []
    for (var index = 0; index < children.length && out.length < 3; index += 1) {
      if (children[index] === node) continue
      var name = shortName(children[index])
      if (name === '' || name.length > 20 || ACTION_HINT.test(name)) continue
      if (out.indexOf(name) !== -1) continue
      if (total + name.length > 48) break
      out.push(name)
      total += name.length + 3
    }
    return out.join(' / ')
  }

  /** Walk into wrapper children until a visible label appears (a nav's groups are wrappers). */
  function collectContent(node, depth, out) {
    var kids = node.children || []
    for (var index = 0; index < kids.length && out.length < 5; index += 1) {
      var kid = kids[index]
      if (isOurs(kid)) continue
      // Visible text only: an icon button's tooltip names an action, not a section.
      var name = leafText(kid, 0)
      if (name !== '') {
        if (out.indexOf(name) === -1) out.push(name)
        continue
      }
      if (depth < 2) collectContent(kid, depth + 1, out)
    }
  }

  /** For a container, what it holds: "新会话 / 开发dsh元素选取插件 / …". */
  function contentOf(node) {
    var role = roleOf(node)
    var containerish = /^(navigation|menu|menubar|list|tablist|table|grid|dialog|region|form|toolbar|group)$/.test(role) ||
      ((node.children || []).length >= 3 && ownText(node) === '')
    if (!containerish) return ''
    var out = []
    collectContent(node, 0, out)
    return out.join(' / ')
  }

  /** How to find it again in a semantic query: role=button[name="…"]. */
  function locatorOf(node, role, name) {
    if (name === '') return role
    return 'role=' + role + '[name="' + name.replace(/"/g, '\\"') + '"]'
  }

  /**
   * The media the element points at: an image, video, audio, poster or iframe URL.
   * A link's href is already in the state line, so only media earns this field.
   */
  var MEDIA_TAGS = /^(IMG|VIDEO|AUDIO|SOURCE|TRACK|IFRAME|EMBED|OBJECT)$/
  function resourceOf(node) {
    // A click on a thumbnail usually lands on the wrapper link, so look inside too.
    var start = MEDIA_TAGS.test(node.tagName)
      ? node
      : (node.querySelector ? node.querySelector('img, video, audio, iframe, source') : null) || node
    var cur = start
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 3; depth += 1) {
      if (MEDIA_TAGS.test(cur.tagName)) {
        var raw = cur.getAttribute('src') || cur.getAttribute('data-src') || cur.getAttribute('poster')
        if (typeof raw === 'string' && raw !== '' && raw.indexOf('data:') !== 0) {
          try {
            return clip(new URL(raw, (cur.ownerDocument && cur.ownerDocument.baseURI) || location.href).href, 140)
          } catch (error) {
            return clip(raw, 140)
          }
        }
      }
      cur = cur.parentElement
    }
    return ''
  }

  /** "A A A A A" reads as "A ×5": anti-adblock notices love to repeat themselves. */
  function collapseRepeats(text) {
    var value = String(text || '').trim()
    if (value.length < 8) return value
    var half = Math.floor(value.length / 2)
    for (var unit = 4; unit <= half; unit += 1) {
      var piece = value.slice(0, unit).trim()
      if (piece === '') continue
      var repeated = 0
      var at = 0
      while (at + piece.length <= value.length) {
        if (value.slice(at, at + piece.length) !== piece) break
        repeated += 1
        at += piece.length
        // Skip the separator between copies (space or punctuation).
        while (at < value.length && /[\s,，.。;；·、]/.test(value.charAt(at))) at += 1
      }
      if (repeated >= 2 && at >= value.length - 1) return piece + ' ×' + repeated
    }
    return value
  }

  /** Visible text of the element: what a person means by "look at this and tell me". */
  function excerptOf(node) {
    try {
      // A container is read through its first real text block, not through the
      // concatenation of every descendant (which is how a whole transcript ended up
      // inside one 摘录).
      var blocks = []
      try {
        blocks = node.querySelectorAll
          ? node.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td')
          : []
      } catch (error) {
        blocks = []
      }
      for (var index = 0; index < blocks.length && index < 8; index += 1) {
        if (blocks[index].contains(node)) continue
        var text = visibleText(blocks[index], 200)
        if (text.length >= 24) return clip(collapseRepeats(text), 240)
      }
      return clip(collapseRepeats(visibleText(node, 240)), 240)
    } catch (error) {
      return ''
    }
  }

  /** Where a cell sits in its table: which column, and the row's values. */
  function tableContextOf(node) {
    var cell = node
    if (cell.tagName !== 'TD' && cell.tagName !== 'TH') {
      cell = node.closest ? node.closest('td, th') : null
      if (!cell) return ''
    }
    var row = cell.parentElement
    if (!row || row.tagName !== 'TR') return ''
    var column = -1
    for (var index = 0; index < row.children.length; index += 1) {
      if (row.children[index] === cell) {
        column = index
        break
      }
    }
    var table = row.closest ? row.closest('table') : null
    var header = ''
    if (table && column >= 0) {
      var headRow = table.querySelector('thead tr') || table.querySelector('tr')
      if (headRow && headRow !== row && headRow.children[column]) header = visibleText(headRow.children[column], 24)
    }
    var values = []
    for (var at = 0; at < row.children.length && values.length < 6; at += 1) {
      var value = visibleText(row.children[at], 24)
      if (value !== '') values.push(value)
    }
    var parts = []
    if (header !== '') parts.push('列: ' + header)
    if (values.length > 0) parts.push('行: ' + values.join(' / '))
    return clip(parts.join(' · '), 140)
  }

  /** The attributes that actually identify or configure an element, in one compact line. */
  var ATTR_KEYS = ['id', 'name', 'type', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'placeholder', 'for', 'maxlength', 'target', 'src', 'alt', 'title']
  function attrsOf(node) {
    var parts = []
    for (var index = 0; index < ATTR_KEYS.length; index += 1) {
      var key = ATTR_KEYS[index]
      var value = node.getAttribute(key)
      if (value === null || value === '' || value.length > 60) continue
      // A class list or a data URL says nothing a model can act on.
      if (key === 'src' && value.indexOf('data:') === 0) continue
      parts.push(key + '=' + clip(value, 40))
    }
    // href is already part of the state line; listing it twice only costs tokens.
    return clip(parts.join(' · '), 140)
  }

  /** Position inside a repeated list: "3/12" tells a model it is one row of many. */
  function indexOf(node) {
    var parent = node.parentElement
    if (!parent) return ''
    var same = []
    for (var index = 0; index < parent.children.length; index += 1) {
      if (parent.children[index].tagName === node.tagName) same.push(parent.children[index])
    }
    if (same.length < 2) return ''
    return (same.indexOf(node) + 1) + '/' + same.length
  }

  /** Best-effort framework component name (React fiber / Vue instance), for "edit this component". */
  function componentOf(node) {
    try {
      var keys = Object.keys(node)
      for (var index = 0; index < keys.length; index += 1) {
        var key = keys[index]
        if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue
        var fiber = node[key]
        for (var depth = 0; fiber && depth < 4; depth += 1) {
          var type = fiber.type
          var name = ''
          if (typeof type === 'function') name = type.displayName || type.name || ''
          else if (type !== null && typeof type === 'object') name = type.displayName || (type.render && (type.render.displayName || type.render.name)) || ''
          if (typeof name === 'string' && name.length >= 3 && /^[A-Z]/.test(name)) return clip(name, 40)
          fiber = fiber.return
        }
        return ''
      }
      var vue = node.__vueParentComponent
      if (vue && vue.type) {
        var vueName = vue.type.__name || vue.type.name || ''
        if (typeof vueName === 'string' && vueName.length >= 3 && /^[A-Z]/.test(vueName)) return clip(vueName, 40)
      }
    } catch (error) {
      return ''
    }
    return ''
  }

  /**
   * The enclosing card/list-item title. This is CONTEXT, never the element's name:
   * AccName says an image without alt has no accessible name, and silently borrowing
   * another element's title is exactly the "cross-contamination" this field replaces.
   */
  function ownerTitleOf(node) {
    var current = node.parentElement
    for (var depth = 0; current && depth < 6; depth += 1) {
      var heading = current.querySelector && current.querySelector('h1, h2, h3, h4, h5, h6')
      if (heading && !heading.contains(node)) {
        var text = visibleText(heading, 56)
        if (text.length >= 2) return text
      }
      var link = current.querySelector && current.querySelector('a[href]')
      if (link && !link.contains(node)) {
        var linkText = visibleText(link, 56)
        if (linkText.length >= 2 && !looksLikeCode(linkText)) return linkText
      }
      current = current.parentElement
    }
    return ''
  }

  /** aria-labelledby → the text of the elements that carry the name. */
  function labelledByText(node) {
    var ids = cleanText(node.getAttribute && node.getAttribute('aria-labelledby'))
    if (ids === '') return ''
    var parts = []
    var list = ids.split(/\s+/)
    for (var index = 0; index < list.length && index < 4; index += 1) {
      var ref = null
      try {
        ref = node.ownerDocument ? node.ownerDocument.getElementById(list[index]) : null
      } catch (error) {
        ref = null
      }
      if (!ref) continue
      var text = visibleText(ref, 40)
      if (text === '') text = cleanText(ref.textContent)
      if (text !== '') parts.push(text)
    }
    return parts.length > 0 ? clip(parts.join(' '), MAX.label) : ''
  }

  /** Native names: alt, label[for], the svg's own <title>, and the media inside a wrapper. */
  function nativeName(node) {
    var alt = cleanText(node.getAttribute && node.getAttribute('alt'))
    if (alt !== '') return clip(alt, MAX.label)
    // `title` is the native fallback name for buttons and links that carry no text.
    var title = cleanText(node.getAttribute && node.getAttribute('title'))
    if (title !== '') return clip(title, MAX.label)
    if (node.id && node.ownerDocument) {
      var label = null
      try {
        label = node.ownerDocument.querySelector('label[for="' + String(node.id).replace(/"/g, '\\"') + '"]')
      } catch (error) {
        label = null
      }
      if (label) {
        var labelText = visibleText(label, MAX.label)
        if (labelText !== '') return clip(labelText, MAX.label)
      }
    }
    var placeholder = cleanText(node.getAttribute && node.getAttribute('placeholder'))
    if (placeholder !== '') return clip(placeholder, MAX.label)
    // Icon systems put the name in the svg's own <title>, which the text scanner skips.
    try {
      var isSvg = String(node.tagName).toLowerCase() === 'svg'
      var svgTitle = isSvg ? node.querySelector('title, desc') : (node.querySelector ? node.querySelector('svg > title, svg > desc') : null)
      if (svgTitle) {
        var svgName = cleanText(svgTitle.textContent)
        if (svgName !== '') return clip(svgName, MAX.label)
      }
    } catch (error) {
      /* no svg name */
    }
    try {
      var media = node.querySelector ? node.querySelector('img[alt], video[title]') : null
      if (media) {
        var mediaName = cleanText(media.getAttribute('alt') || media.getAttribute('title'))
        if (mediaName !== '') return clip(mediaName, MAX.label)
      }
    } catch (error) {
      /* no inner name */
    }
    return ''
  }

  /** The name of the interactive control an icon belongs to. */
  function controlName(node) {
    var control = node.parentElement
    for (var depth = 0; control && depth < 3; depth += 1) {
      var isControl = /^(BUTTON|A|LABEL|SUMMARY)$/.test(control.tagName) ||
        (control.getAttribute && control.getAttribute('role') === 'button')
      if (isControl) {
        var name = cleanText(control.getAttribute('aria-label') || control.getAttribute('title') || '')
        if (name !== '') return clip(name, MAX.label)
      }
      control = control.parentElement
    }
    return ''
  }

  /**
   * Resolve the name of one element — ONE ordered chain. It used to be spread over
   * standardName / humanLabel / primaryTextOf / ownerTitleOf, where one rule silently
   * overrode another, which is exactly why the same name bug kept coming back.
   *
   *  1 aria-labelledby   2 aria-label (or the more descriptive visible title)
   *  3 native (alt / label[for] / svg title / inner media)   4 container/child label
   *  5 control ancestor   6 CSS descriptor (last resort)
   *
   * A source that merely *wraps* the visible child label ("工作区「x」的操作") is a
   * description, so the child label wins. The enclosing card title is NEVER used here:
   * it travels in the separate `owner` field.
   */
  function resolveName(node, ownText) {
    var kids = node.children || []
    var firstChildText = ''
    var textChildren = 0
    for (var at = 0; at < kids.length && at < 6; at += 1) {
      var part = visibleText(kids[at], MAX.label)
      if (part.length < 2) continue
      if (firstChildText === '') firstChildText = part
      textChildren += 1
      if (textChildren >= 2) break
    }
    var singleChild = textChildren <= 1
    // A source is a "wrapper phrase" when it merely contains the visible child label.
    var wrapsChild = function (value) {
      return firstChildText !== '' && value !== '' && value.indexOf(firstChildText) !== -1
    }

    var labelled = labelledByText(node)
    if (labelled !== '' && !wrapsChild(labelled)) return clip(labelled, MAX.label)

    var aria = cleanText(node.getAttribute && node.getAttribute('aria-label'))
    if (aria !== '' && wrapsChild(aria)) return clip(firstChildText, MAX.label)
    var visible = ownText !== '' ? ownText : visibleText(node, MAX.label)
    var visibleOk = singleChild && visible.length > 2 && visible.length <= 40 &&
      visible.indexOf('://') === -1 && visible.indexOf(' › ') === -1 && !looksLikeCode(visible)
    if (aria !== '') {
      // A longer, more descriptive visible title beats a terse aria name on a link.
      if (visibleOk && visible.length > aria.length + 2) return clip(visible, MAX.label)
      return clip(aria, MAX.label)
    }
    if (visibleOk) return clip(visible, MAX.label)

    var native = nativeName(node)
    if (native !== '') return native

    var primary = primaryTextOf(node, firstChildText)
    if (primary !== '') return clip(primary, MAX.label)

    var control = controlName(node)
    if (control !== '') return control

    var described = describeTarget(node)
    var tag = String(node.tagName).toLowerCase()
    if (described === tag && node.querySelector && node.querySelector('svg, img, canvas, i')) return tag + ' 图标'
    return described
  }

  /** Tags that are clickable/semantic on their own, so a click on them is a click on it. */
  var MEANINGFUL = /^(BUTTON|A|INPUT|TEXTAREA|SELECT|OPTION|LABEL|SUMMARY|DETAILS|IMG|TR|TD|TH|LI|H1|H2|H3|H4|H5|H6|CODE|PRE)$/

  function isMeaningful(node) {
    if (!node || node.nodeType !== 1) return false
    if (MEANINGFUL.test(node.tagName)) return true
    if (node.hasAttribute('role')) return true
    if (node.hasAttribute('aria-label') || node.hasAttribute('data-testid') || node.hasAttribute('name')) return true
    if (node.isContentEditable) return true
    return false
  }

  /** A click on a span inside a button means the button. */
  /** Vector internals are never a target: a click on an icon means the control around it. */
  var VECTOR_TAGS = /^(SVG|PATH|USE|CIRCLE|RECT|G|DEFS|LINE|POLYGON|POLYLINE|ELLIPSE|TSPAN|TEXT|MASK|CLIPPATH)$/
  function isVector(node) {
    return Boolean(node && typeof node.tagName === 'string' && VECTOR_TAGS.test(node.tagName))
  }

  /** A box bigger than the window cannot be a click target: it is a scroll container. */
  function isGiant(node) {
    try {
      var rect = node.getBoundingClientRect()
      var view = node.ownerDocument.defaultView || window
      var viewWidth = Number(view.innerWidth) || 800
      var viewHeight = Number(view.innerHeight) || 600
      return rect.height > viewHeight * 1.5 || rect.width > viewWidth * 1.5
    } catch (error) {
      return false
    }
  }

  function meaningfulTarget(node) {
    var cur = node
    for (var depth = 0; depth < 6 && cur && cur.parentElement; depth += 1) {
      if (!isVector(cur) && isMeaningful(cur) && !isGiant(cur)) return cur
      cur = cur.parentElement
    }
    if (isVector(cur)) return node
    return isMeaningful(cur) && !isGiant(cur) ? cur : node
  }

  /** Nearest ancestor that actually carries a link. */
  function linkOf(node) {
    var cur = node
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 4; depth += 1) {
      var raw = cur.getAttribute('href') || cur.getAttribute('data-url')
      if (typeof raw === 'string' && raw !== '' && raw !== '#' && raw.indexOf('javascript:') !== 0) {
        try {
          var url = new URL(raw, (cur.ownerDocument && cur.ownerDocument.baseURI) || location.href).href
          var label = clip(ownText(cur) || cur.getAttribute('title') || cur.getAttribute('aria-label') || url, MAX.label)
          return { url: clip(url, MAX.page), label: label }
        } catch (error) {
          /* not a URL */
        }
      }
      cur = cur.parentElement
    }
    return null
  }

  /**
   * The visible area in *device* pixels, plus the scale that maps CSS px onto it.
   *
   * `getBoundingClientRect` is already scroll-independent (it is viewport-relative),
   * but it is measured in CSS px: browser zoom changes `devicePixelRatio`, page
   * pinch-zoom changes `visualViewport.scale` and pans the visual viewport. Mixing
   * those up is why a coordinate taken at 100% is wrong at 150%, and why a pinched
   * page reports boxes outside the visible area. Multiplying by dpr and subtracting
   * the visual-viewport offset yields a number that matches the screenshot, at any
   * zoom, without any scroll term.
   */
  function viewportMetrics(scope) {
    var view = scope || window
    var visual = null
    try {
      visual = view.visualViewport || null
    } catch (error) {
      visual = null
    }
    var dpr = Number(view.devicePixelRatio) || 1
    var scale = dpr * (visual !== null && Number(visual.scale) > 0 ? Number(visual.scale) : 1)
    return {
      scale: scale,
      offsetX: visual !== null ? Number(visual.offsetLeft) || 0 : 0,
      offsetY: visual !== null ? Number(visual.offsetTop) || 0 : 0,
      width: Math.round((visual !== null ? Number(visual.width) || 0 : Number(view.innerWidth) || 0) * scale),
      height: Math.round((visual !== null ? Number(visual.height) || 0 : Number(view.innerHeight) || 0) * scale),
    }
  }

  /** Element box in device pixels of the visible area (same units as a screenshot). */
  function boxOf(rect, metrics) {
    if (rect === null || metrics === null) return null
    return [
      Math.round((rect.left - metrics.offsetX) * metrics.scale),
      Math.round((rect.top - metrics.offsetY) * metrics.scale),
      Math.round(rect.width * metrics.scale),
      Math.round(rect.height * metrics.scale),
    ]
  }

  function describe(node, options, link, view) {
    var target = meaningfulTarget(node)
    var scope = view || (node.ownerDocument && node.ownerDocument.defaultView) || window
    var text = ownText(target)
    var rect = null
    try {
      rect = target.getBoundingClientRect()
    } catch (error) {
      rect = null
    }
    var context = contextOf(scope)
    var role = roleOf(target)
    var label = resolveName(target, text)
    var base = {
      v: 1,
      kind: 'element',
      label: label,
      // Context, clearly labelled as someone else's name: the card this element lives
      // in. Never merged into `label`, so the two can no longer contaminate each other.
      owner: label === describeTarget(target) ? clip(ownerTitleOf(target), 56) : '',
      // `selector` means no human name was found: the block must then carry content
      // instead of a name, otherwise the reference identifies nothing.
      labelKind: label === describeTarget(target) ? 'selector' : 'named',
      role: role,
      desc: clip(describeTarget(target), MAX.desc),
      state: clip(stateOf(target), 60),
      region: clip(regionOf(target), 90),
      // The locator uses the *resolved* name, not the raw own text: a tree row has no
      // direct text, and `role=treeitem` alone would tell a model nothing.
      locator: clip(locatorOf(target, role, (text !== '' ? text : '') || label || (target.getAttribute('aria-label') || '')), 90),
      nearby: clip(nearbyOf(target), 80),
      content: clip(contentOf(target), 90),
      excerpt: excerptOf(target),
      table: tableContextOf(target),
      title: clip((scope.document && scope.document.title) || '', 80),
      attrs: attrsOf(target),
      index: indexOf(target),
      component: componentOf(target),
      resource: resourceOf(target),
      selector: clip(selectorWithShadow(target), MAX.selector),
      selectorAlt: '',
      page: options && options.omitPage === true ? '' : clip(context.page, MAX.page),
      text: text,
      frame: clip(context.frame, MAX.frame),
      frameUrl: clip(context.frameUrl, MAX.page),
      source: (options && options.channel) || 'page',
      at: Date.now(),
    }
    var alternative = selectorsFor(target).alt
    if (alternative && alternative !== base.selector) base.selectorAlt = clip(alternative, MAX.selectorAlt)
    var metrics = viewportMetrics(scope)
    var box = boxOf(rect, metrics)
    if (box !== null) {
      base.box = box
      base.viewport = [metrics.width, metrics.height]
      base.scale = Math.round(metrics.scale * 100) / 100
    }
    var root = rootOf(target)
    if (root && root.nodeType === 11) base.shadow = true
    if (link) {
      return {
        v: 1,
        kind: 'link',
        label: link.label,
        url: link.url,
        page: base.page,
        region: clip(regionOf(target), 90),
        frame: base.frame,
        frameUrl: base.frameUrl,
        source: base.source,
        at: base.at,
      }
    }
    return base
  }

  /* --------------------------------------------------------------- overlay */

  /**
   * A frame loop with a cancel handle: the highlight is a per-frame projection, not a
   * snapshot, so it runs while armed and stops the moment the session ends.
   */
  function requestFrameLoop(callback) {
    var stopped = false
    var handle = 0
    var raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    function schedule() {
      if (stopped) return
      handle = raf ? window.requestAnimationFrame(step) : setTimeout(step, 16)
    }
    function step() {
      if (stopped) return
      try {
        callback()
      } catch (error) {
        /* one bad frame must not stop the loop */
      }
      schedule()
    }
    schedule()
    return {
      cancel: function () {
        stopped = true
        try {
          if (raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle)
          else clearTimeout(handle)
        } catch (error) {
          /* detached window */
        }
      },
    }
  }

  /** The document root: absolute coordinates must not inherit a body margin. */
  function overlayParent(doc) {
    return doc.documentElement || doc.body
  }

  function ensureOverlay(doc) {
    if (state.box && state.box.isConnected && state.box.ownerDocument === doc) return
    removeOverlay()
    var parent = overlayParent(doc)
    if (!parent) return
    var box = doc.createElement('div')
    box.setAttribute('data-dsh-element-ref', 'box')
    box.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:' + Z_BOX + ';pointer-events:none;display:none;' +
      'border:2px solid #4c8dff;background:rgba(76,141,255,0.16);border-radius:2px;box-sizing:border-box'
    parent.appendChild(box)
    state.box = box
  }

  function removeOverlay() {
    var box = state.box
    if (box && box.parentNode) box.parentNode.removeChild(box)
    state.box = null
    state.boxBox = ''
  }

  function paint(node, doc) {
    if (!node || !doc) {
      if (state.box && state.box.style.display !== 'none') state.box.style.display = 'none'
      state.boxBox = ''
      return
    }
    ensureOverlay(doc)
    if (!state.box) return
    var rect = null
    try {
      rect = node.getBoundingClientRect()
    } catch (error) {
      rect = null
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      if (state.box.style.display !== 'none') state.box.style.display = 'none'
      return
    }
    // READ PHASE — every layout read happens before any write. Writing styles and then
    // calling getBoundingClientRect in the same frame forces a synchronous layout of the
    // whole document ("layout thrashing"), which is why the same code felt smooth on a
    // light page and sluggish inside a large app like DSH.
    var parent = state.box.parentElement
    var base = { left: 0, top: 0 }
    try {
      if (parent) {
        var parentRect = parent.getBoundingClientRect()
        base = { left: parentRect.left, top: parentRect.top }
      }
    } catch (error) {
      base = { left: 0, top: 0 }
    }

    // WRITE PHASE — placement is measured, not assumed: the delta between the element's
    // box and the overlay parent's box is the same number in every coordinate system,
    // so scroll, zoom, page transforms and body margins cannot shift it. Unchanged
    // geometry is not rewritten: a frame with no movement costs no style work at all.
    var left = Math.round(rect.left - base.left)
    var top = Math.round(rect.top - base.top)
    var width = Math.round(rect.width)
    var height = Math.round(rect.height)
    var next = left + ',' + top + ',' + width + ',' + height
    if (state.boxBox === next && state.box.style.display === 'block') return
    state.boxBox = next
    if (state.box.style.display !== 'block') state.box.style.display = 'block'
    state.box.style.transform = 'translate(' + left + 'px,' + top + 'px)'
    state.box.style.width = width + 'px'
    state.box.style.height = height + 'px'
  }

  /* ------------------------------------------------------------- listening */

  function eventTarget(event) {
    var path = []
    try {
      path = typeof event.composedPath === 'function' ? event.composedPath() : []
    } catch (error) {
      path = []
    }
    var node = path.length > 0 ? path[0] : event.target
    while (node && node.nodeType !== 1) node = node.parentNode
    return node || null
  }

  function ignored(node, options) {
    if (!node) return true
    // A frame element is never the thing the user means: its content either has
    // its own agent (same-origin frame, bound below) or cannot be read at all.
    // Painting the whole frame as one box is noise, so it neither highlights nor picks.
    if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') return true
    var skip = (options && options.skip) || ['[data-dsh-element-ref]']
    for (var index = 0; index < skip.length; index += 1) {
      try {
        if (node.closest && node.closest(skip[index])) return true
      } catch (error) {
        /* bad selector in options */
      }
    }
    return node.tagName === 'HTML'
  }

  function onMove(event, doc) {
    if (!state.active) return
    state.seen.move += 1
    state.lastMoveAt = Date.now()
    try {
      state.pointer = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 }
    } catch (error) {
      state.pointer = null
    }
    var node = eventTarget(event)
    if (ignored(node, state.options)) {
      state.hover = null
      paint(null)
      return
    }
    state.hover = { node: node, doc: doc }
    paint(node, doc)
  }

  function finish(payload) {
    var options = state.options || {}
    state.picked = payload
    disarm()
    try {
      if (typeof options.binding === 'string' && typeof window[options.binding] === 'function') {
        window[options.binding](JSON.stringify(payload))
      }
    } catch (error) {
      /* no CDP binding on this transport */
    }
    try {
      if (typeof window.__dshRef.onpick === 'function') window.__dshRef.onpick(payload)
    } catch (error) {
      /* caller threw: the pick is still in read() */
    }
  }

  function stopEvent(event) {
    event.preventDefault()
    event.stopPropagation()
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
  }

  function onPointerDown(event, doc) {
    if (!state.active) return
    state.seen.down += 1
    var node = eventTarget(event)
    if (ignored(node, state.options)) return
    stopEvent(event)
    state.downTarget = { node: node, doc: doc, alt: event.altKey === true }
  }

  function onPointerUp(event, doc) {
    if (!state.active) return
    state.seen.up += 1
    var node = eventTarget(event)
    if (ignored(node, state.options)) return
    stopEvent(event)
    var down = state.downTarget
    state.downTarget = null
    var target = node
    var targetDoc = doc
    if (down && down.node && node && (node === down.node || down.node.contains(node))) {
      target = down.node
      targetDoc = down.doc
    }
    // A large area is a legitimate pick when the user wants exactly that area (the blank
    // space of a section): it is described honestly instead of being refused.
    var payload = null
    try {
      payload = describe(target, state.options, down ? down.alt : event.altKey === true, targetDoc ? targetDoc.defaultView : undefined)
    } catch (error) {
      // Never swallow this: a thrown describe looked exactly like "the click did
      // nothing", the most expensive failure mode to debug from the outside.
      state.lastError = String((error && error.stack) || error || 'describe failed').slice(0, 500)
      state.notice = { kind: 'error', text: String((error && error.message) || error || 'describe failed').slice(0, 120), at: Date.now() }
      try {
        if (typeof window.__dshRef.onnotice === 'function') window.__dshRef.onnotice(state.notice)
      } catch (callbackError) {
        /* the notice is still in read() */
      }
      payload = null
    }
    // Settle on the next task, not inside this pointer event: the browser
    // dispatches `click` right after `pointerup`, and disarming here would
    // remove the capture listener that has to swallow that click — the page
    // would then act on it (a clicked nav row would navigate away).
    setTimeout(function () {
      if (payload === null) disarm()
      else finish(payload)
    }, 0)
  }

  function onClick(event, doc) {
    if (!state.active) return
    var node = eventTarget(event)
    if (ignored(node, state.options)) return
    stopEvent(event)
  }

  function onKey(event) {
    if (!state.active) return
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    finish({ cancelled: true })
  }

  function onScroll() {
    if (!state.active) return
    if (!state.hover) return
    // The highlight is a projection of the pointer, never a leftover: a node that
    // left the document ends it instead of freezing a box in place.
    if (!state.hover.node || state.hover.node.isConnected !== true) {
      clearHighlight()
      return
    }
    paint(state.hover.node, state.hover.doc)
  }

  /** End the highlight without ending the pick session (pointer left, window blurred). */
  function clearHighlight() {
    state.hover = null
    paint(null)
  }

  /**
   * Whether the pointer is still on `node`, accounting for Shadow DOM:
   * `elementFromPoint` returns the shadow *host*, never the inner node, so a plain
   * containment test clears the highlight of every web-component element on the
   * next frame (bilibili's comment area is exactly that).
   */
  function pointerOn(node, under) {
    if (!node || !under) return false
    if (under === node || node.contains(under)) return true
    var current = node
    for (var depth = 0; depth < 8; depth += 1) {
      var root = null
      try {
        root = current.getRootNode ? current.getRootNode() : null
      } catch (error) {
        return false
      }
      if (!root || root.nodeType !== 11 || !root.host) return false
      var host = root.host
      if (host === under || host.contains(under)) return true
      current = host
    }
    return false
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') clearHighlight()
  }

  function bindWindow(view, doc) {
    var handlers = [
      [view, 'pointermove', function (event) { onMove(event, doc) }, true],
      [view, 'pointerdown', function (event) { onPointerDown(event, doc) }, true],
      [view, 'pointerup', function (event) { onPointerUp(event, doc) }, true],
      [view, 'click', function (event) { onClick(event, doc) }, true],
      [view, 'keydown', onKey, true],
      [view, 'scroll', onScroll, true],
      // Three ways the pointer stops describing this document: it leaves the
      // window, it leaves every element (relatedTarget is null), or the window
      // loses focus to another app — the case when a click goes to a different
      // browser window while the picker is armed.
      [view, 'pointerleave', function () { clearHighlight() }, true],
      // Leaving this document for another one (a same-origin frame hands over a
      // relatedTarget that lives in the parent document) is a leave too — that
      // cross-document case is what left a frame's box behind.
      [view, 'pointerout', function (event) {
        var to = event.relatedTarget
        if (!to || (to.ownerDocument && to.ownerDocument !== doc)) clearHighlight()
      }, true],
      [view, 'blur', function () { clearHighlight() }, true],
      [view, 'contextmenu', function (event) { if (state.active) event.preventDefault() }, true],
    ]
    for (var index = 0; index < handlers.length; index += 1) {
      var entry = handlers[index]
      try {
        entry[0].addEventListener(entry[1], entry[2], entry[3])
        state.listeners.push(entry)
      } catch (error) {
        /* cross-origin or detached frame */
      }
    }
  }

  function bindFrames() {
    if (!state.active) return
    var stack = [window]
    var guard = 0
    while (stack.length > 0 && guard < 32) {
      guard += 1
      var view = stack.shift()
      if (!view) continue
      if (view.__dshRefBound === VERSION) continue
      view.__dshRefBound = VERSION
      var doc = null
      try {
        doc = view.document
      } catch (error) {
        continue
      }
      if (!doc) continue
      bindWindow(view, doc)
      var frames = []
      try {
        frames = doc.querySelectorAll('iframe, frame')
      } catch (error) {
        frames = []
      }
      for (var index = 0; index < frames.length; index += 1) {
        try {
          if (frames[index].contentWindow && frames[index].contentDocument) stack.push(frames[index].contentWindow)
        } catch (error) {
          /* cross-origin frame: the click lands on the frame element itself */
        }
      }
    }
  }

  function unbind() {
    for (var index = 0; index < state.listeners.length; index += 1) {
      var entry = state.listeners[index]
      try {
        entry[0].removeEventListener(entry[1], entry[2], entry[3])
      } catch (error) {
        /* detached */
      }
    }
    state.listeners = []
    var stack = [window]
    var guard = 0
    while (stack.length > 0 && guard < 32) {
      guard += 1
      var view = stack.shift()
      if (!view) continue
      try {
        view.__dshRefBound = 0
        var frames = view.document.querySelectorAll('iframe, frame')
        for (var at = 0; at < frames.length; at += 1) {
          try {
            if (frames[at].contentWindow && frames[at].contentDocument) stack.push(frames[at].contentWindow)
          } catch (error) {
            /* cross-origin */
          }
        }
      } catch (error) {
        /* detached */
      }
    }
  }

  /* ------------------------------------------------------------ public API */

  function arm(options) {
    if (state.active) return 'armed'
    state.active = true
    state.options = options || {}
    state.picked = null
    state.notice = null
    state.lastError = ''
    state.downTarget = null
    state.hover = null
    state.lastMoveAt = Date.now()
    ensureOverlay(document)
    bindFrames()
    state.frameTimer = setInterval(bindFrames, 800)
    // One model for the highlight, no timers and no focus heuristics:
    //   the box is the projection of "the element under the pointer", recomputed
    //   every frame, and it ends only on an observable fact — the pointer is no
    //   longer over it, the element left the document, or the session ended.
    // Re-measuring each frame also glues the box through scroll, reflow and
    // transforms, which is why there is no coordinate correction anywhere.
    state.tickTimer = requestFrameLoop(function () {
      if (!state.active) return
      var hover = state.hover
      if (!hover || !hover.node) return
      var node = hover.node
      var point = state.pointer
      if (node.isConnected !== true) {
        clearHighlight()
        return
      }
      try {
        if (node.getClientRects().length === 0) {
          clearHighlight()
          return
        }
      } catch (error) {
        clearHighlight()
        return
      }
      if (point !== null && hover.doc) {
        var under = null
        try {
          under = hover.doc.elementFromPoint(point.x, point.y)
        } catch (error) {
          under = null
        }
        if (!pointerOn(node, under)) {
          clearHighlight()
          return
        }
      }
      paint(node, hover.doc)
    })
    document.addEventListener('visibilitychange', onVisibility, true)
    try {
      document.documentElement.style.cursor = 'crosshair'
    } catch (error) {
      /* ignore */
    }
    return 'armed'
  }

  function disarm() {
    var was = state.active
    state.active = false
    state.hover = null
    state.downTarget = null
    if (state.frameTimer) clearInterval(state.frameTimer)
    state.frameTimer = 0
    if (state.tickTimer) {
      if (typeof state.tickTimer.cancel === 'function') state.tickTimer.cancel()
      else clearInterval(state.tickTimer)
    }
    state.tickTimer = 0
    try {
      document.removeEventListener('visibilitychange', onVisibility, true)
    } catch (error) {
      /* detached */
    }
    if (was) unbind()
    removeOverlay()
    try {
      document.documentElement.style.cursor = ''
    } catch (error) {
      /* ignore */
    }
    return 'idle'
  }

  function read() {
    return {
      active: state.active,
      picked: state.picked,
      notice: state.notice,
      lastError: state.lastError || '',
      seen: { move: state.seen.move, down: state.seen.down, up: state.seen.up },
    }
  }

  /** Walk a `>>>` selector chain (shadow roots) inside one document. */
  function resolveIn(doc, selector) {
    var parts = String(selector || '').split('>>>').map(function (part) { return part.trim() }).filter(Boolean)
    var root = doc
    var node = null
    for (var index = 0; index < parts.length; index += 1) {
      if (!root) return null
      try {
        node = root.querySelector(parts[index])
      } catch (error) {
        return null
      }
      if (!node) return null
      if (index < parts.length - 1) {
        root = node.shadowRoot
        if (!root) return null
      }
    }
    return node
  }

  /** Clicking a chip points back at what it names: scroll to it and flash. */
  function flash(payload) {
    if (!payload || typeof payload !== 'object') return false
    var doc = document
    var frame = String(payload.frame || '')
    if (frame !== '') {
      var steps = frame.split('>>>').map(function (part) { return part.trim() }).filter(Boolean)
      for (var index = 0; index < steps.length; index += 1) {
        var frameNode = resolveIn(doc, steps[index])
        if (!frameNode) return false
        try {
          doc = frameNode.contentDocument
        } catch (error) {
          doc = null
        }
        if (!doc) return false
      }
    }
    var target = resolveIn(doc, payload.selector)
    if (!target) return false
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    } catch (error) {
      try {
        target.scrollIntoView()
      } catch (inner) {
        /* detached */
      }
    }
    var rect = target.getBoundingClientRect()
    var marker = doc.createElement('div')
    marker.setAttribute('data-dsh-element-ref', 'flash')
    marker.style.cssText = 'position:fixed;pointer-events:none;z-index:' + Z_BOX + ';border-radius:2px;' +
      'border:2px solid #4c8dff;background:rgba(76,141,255,0.18);transition:opacity .35s ease;' +
      'left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'
    var parent = overlayParent(doc)
    if (!parent) return false
    parent.appendChild(marker)
    setTimeout(function () { marker.style.opacity = '0' }, 900)
    setTimeout(function () { if (marker.parentNode) marker.parentNode.removeChild(marker) }, 1400)
    return true
  }

  window.__dshRef = {
    version: VERSION,
    build: BUILD,
    arm: arm,
    disarm: disarm,
    read: read,
    clearHighlight: clearHighlight,
    flash: flash,
    describe: function (node, link) { return describe(node, { channel: 'page' }, link === true) },
    onpick: null,
  }
})()









