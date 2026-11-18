/**
 * Pure-logic checks that run in plain Node, before the plugin is installed.
 *
 * The browser half is a classic script (it calls `window.__ModuleLoader__`), so
 * it is loaded here the same way the page loads it: a stub module loader and a
 * stub `require('react')`. Everything asserted below is DOM-free.
 *
 *   node scripts/test.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const here = new URL('../', import.meta.url)
const read = (name) => readFileSync(new URL(name, here), 'utf8')

/* ---------------------------------------------------------- parse checks */

for (const name of ['agent.source.js', 'client.js']) {
  const source = read(name)
  try {
    // Compiles the source without running it.
    new Function(source)
  } catch (error) {
    console.error(`${name} does not parse:`, error.message)
    process.exit(1)
  }
}

const host = await import(new URL('index.js', here).href)
const cdp = await import(new URL('cdp.js', here).href)
const browsers = await import(new URL('browsers.js', here).href)
assert.equal(typeof host.apply, 'function', 'index.js must export apply()')
assert.equal(typeof host.inject, 'object', 'index.js must export inject')
assert.equal(typeof cdp.CdpBrowser, 'function', 'cdp.js must export CdpBrowser')
assert.equal(typeof cdp.flashExpression, 'function', 'cdp.js must export flashExpression')
assert.equal(typeof browsers.resolveExecutable, 'function', 'browsers.js must export resolveExecutable')

/* --------------------------------------------------------- client factory */

const storage = new Map()
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
}
const clientSource = read('client.js')
new Function(clientSource)()
assert.ok(definition !== null, 'client.js must register a module')
assert.equal(definition.id, 'dsh-element-ref', 'module id must equal the package name')
const ReactStub = { createElement: () => null, useEffect: () => {} }
const client = definition.factory((name) => {
  assert.equal(name, 'react', 'the client only requires react')
  return ReactStub
})
assert.ok(client.__test !== undefined, 'client must expose its pure helpers for tests')
const { formatReference, chipLabel, clipboardOf, clip, parseUserBlock, sentTextPattern } = client.__test

/* ------------------------------------------------------------- formatting */

const element = {
  v: 1,
  kind: 'element',
  label: '提交订单',
  desc: 'button.btn-primary',
  role: 'button',
  state: '',
  region: '购物车 › 结算',
  locator: 'role=button[name="提交订单"]',
  nearby: '取消 / 继续购物',
  content: '',
  selector: 'form#cart > button.btn-primary',
  selectorAlt: '',
  page: 'https://shop.example/cart',
  text: '提交订单',
  frame: '',
  source: 'edge',
  box: [10, 20, 120, 32],
  viewport: [1256, 808],
}

const elementText = formatReference(element)
assert.equal(
  elementText,
  '提交订单 (button)\n页面: https://shop.example/cart\n位置: 购物车 › 结算 · 画面 10,20 · 120x32 · 视口 1256x808\n选择器: form#cart > button.btn-primary\n附近: 取消 / 继续购物\n',
  'a web element leads with its page, its region, its selector, its neighbours and its box',
)
assert.ok(elementText.endsWith('\n'), 'the block ends with a newline so later typing stays out of it')
assert.ok(elementText.length < 260, 'a typical block stays under 260 characters')

const local = formatReference({ ...element, page: 'http://127.0.0.1:10108/', source: 'dsh' })
assert.ok(!local.includes('页面:'), 'a DSH-internal pick does not print the app origin')
assert.ok(local.includes('可定位: role=button[name="提交订单"]'), 'a DSH pick trades the CSS path for a role/name locator')
assert.ok(!local.includes('选择器:'), 'no CSS path for DSH UI: the model cannot run one there')

const dshStates = formatReference({
  v: 1, kind: 'element', label: '打开右侧边栏', role: 'button', state: 'aria-expanded=false',
  region: '会话视图 › 顶部工具区', locator: 'role=button[name="打开右侧边栏"]', nearby: '收起左侧栏 / 全部面板',
  content: '', selector: 'button:nth-of-type(2)', page: '', text: '', source: 'dsh',
})
assert.ok(dshStates.startsWith('打开右侧边栏 (button, aria-expanded=false)'), 'state rides in the header (quote mode has no marker)')
assert.ok(dshStates.includes('附近: 收起左侧栏 / 全部面板'), 'neighbours place the control inside its row')

const container = formatReference({
  v: 1, kind: 'element', label: '会话层级', role: 'navigation', state: '', region: '会话视图',
  locator: 'role=navigation[name="会话层级"]', nearby: '', content: '新会话 / 开发dsh元素选取插件 / 生涯规划',
  selector: 'nav', page: '', text: '', source: 'dsh',
})
assert.ok(container.includes('内容: 新会话 / 开发dsh元素选取插件 / 生涯规划'), 'a container says what it holds')

// "Read this to me": a card/article carries its text, a child-label list does not replace it.
const cardFixture = {
  v: 1, kind: 'element', label: 'DeepSeek 发布新模型', role: 'article', state: '', region: '资讯 › 列表',
  locator: 'role=article[name="DeepSeek 发布新模型"]', nearby: '上一篇 / 下一篇', content: '',
  excerpt: 'DeepSeek 今天发布了新模型，参数量与上一代持平，推理速度提升约 30%，并同步开源了权重。团队表示后续将把上下文窗口扩展到 1M。',
  selector: 'article.card:nth-of-type(2)', selectorAlt: 'main > article:nth-of-type(2)', page: 'https://news.example/', title: '科技资讯', text: '', source: 'edge', resource: 'https://news.example/cover.png',
}
const card = formatReference(cardFixture)
assert.ok(card.includes('标签页: 科技资讯'), 'a web reference names the tab it came from')
assert.ok(card.includes('摘录: DeepSeek 今天发布了新模型'), 'a container carries readable text, not just its label')
assert.ok(card.includes('资源: https://news.example/cover.png'), 'media resources are named so a picture can be identified')
assert.ok(!card.includes('备选:'), 'the fallback selector is a full-level luxury, not a default line')
client.__test.setTextConfig('full', 4000)
assert.ok(formatReference(cardFixture).includes('备选: main > article:nth-of-type(2)'), 'full still prints the fallback selector')
client.__test.setTextConfig('standard', 520)

// A table cell explains its own position: which column, which row.
const cell = formatReference({
  v: 1, kind: 'element', label: '30', role: 'cell', state: '', region: '实测结果',
  locator: 'role=cell[name="30"]', table: '列: 数量 · 行: 张三 / 30 / 北京', nearby: '', content: '',
  excerpt: '30', selector: 'td:nth-of-type(2)', page: '', text: '', source: 'dsh',
})
assert.ok(cell.includes('表格: 列: 数量 · 行: 张三 / 30 / 北京'), 'a table cell carries its column and row')
assert.ok(!cell.includes('摘录:'), 'a short excerpt adds nothing and is dropped')

/* ------------------------------------------- detail levels and the budget */

const rich = {
  v: 1, kind: 'element', label: '提交订单', role: 'button', state: 'aria-expanded=false',
  region: '购物车 › 结算', locator: 'role=button[name="提交订单"]', table: '列: 金额 · 行: 198 / 已含税',
  nearby: '取消 / 继续购物', content: '', excerpt: '提交订单前请确认收货地址、优惠券与发票信息，确认无误后点击提交。',
  attrs: 'id=pay · type=submit · data-testid=checkout', component: 'CheckoutButton', index: '2/3',
  selector: 'form#cart > button.btn-primary', selectorAlt: 'main > form > button:nth-of-type(2)',
  page: 'https://shop.example/cart', title: '购物车', text: '', frame: '', source: 'edge', box: [10, 20, 120, 32], viewport: [1280, 800], scale: 2,
}

client.__test.setTextConfig('compact', 0)
const compact = formatReference(rich)
assert.ok(compact.includes('页面:') && compact.includes('位置:') && compact.includes('选择器:'), 'compact keeps the identity and the locator')
assert.ok(!compact.includes('标签页:') && !compact.includes('附近:') && !compact.includes('表格:'), 'compact drops what the model can live without')
assert.ok(!compact.includes('属性:') && !compact.includes('组件:'), 'compact never carries developer-only fields')

client.__test.setTextConfig('full', 4000)
const full = formatReference(rich)
assert.ok(full.includes('标签页: 购物车'), 'full names the tab')
assert.ok(full.includes('表格: 列: 金额'), 'full carries the table position')
assert.ok(full.includes('序号: 2/3'), 'full carries the item index')
assert.ok(full.includes('属性: id=pay'), 'full carries identifying attributes')
assert.ok(full.includes('组件: CheckoutButton'), 'full carries the framework component')
assert.ok(full.includes('位置: 购物车 › 结算 · 画面 10,20 · 120x32 · 视口 1280x800'), 'position carries region, box and viewport')
assert.ok(!full.includes('坐标:'), 'there is no separate coordinate line any more')
assert.ok(compact.includes('位置: 购物车 › 结算 · 画面 10,20 · 120x32 · 视口 1280x800'), 'compact keeps position, box and viewport')

client.__test.setTextConfig('standard', 120)
const tight = formatReference(rich)
assert.ok(tight.length <= 120 + 60, 'a small budget still returns a bounded block: ' + tight.length)
assert.ok(tight.startsWith('提交订单 (button, aria-expanded=false)'), 'the header always survives the budget')
assert.ok(!tight.includes('属性:'), 'the budget drops the least useful lines first')

client.__test.setTextConfig('standard', 520)

const withFrame = formatReference({ ...element, frame: 'iframe#pay', frameUrl: 'https://pay.example/form' })
assert.ok(withFrame.includes('框架: iframe#pay → https://pay.example/form'), 'a frame names both the path and the URL')

const withText = formatReference({ ...element, label: '结算', text: '去结算' })
assert.ok(!withText.includes('文本:'), 'there is no separate text line any more: the excerpt owns "read this"')

const link = formatReference({
  v: 1, kind: 'link', label: '价格说明', url: 'https://shop.example/help/price', page: 'https://shop.example/cart', region: '帮助中心', source: 'edge',
})
assert.equal(link, '价格说明\n链接: https://shop.example/help/price\n页面: https://shop.example/cart\n位置: 帮助中心\n')

const long = formatReference({
  v: 1,
  kind: 'element',
  label: 'x'.repeat(400),
  selector: 's'.repeat(400),
  page: 'p'.repeat(400),
  text: 't'.repeat(400),
})
assert.ok(long.length <= 600, 'every field is capped, so one reference cannot flood the prompt')
assert.ok(!long.includes('x'.repeat(57)), 'labels are capped at 56 characters')

// The plain-text/clipboard fallbacks must still carry a marker, or the block loses
// its identity on the very versions that need those fallbacks.
assert.ok(formatReference(element, true).startsWith('[引用元素] 提交订单'), 'the text fallback forces the element marker')
assert.ok(formatReference({ kind: 'link', label: '价格说明', url: 'https://a' }, true).startsWith('[引用链接] 价格说明'), 'the text fallback forces the link marker')
assert.equal(formatReference(null), '', 'no payload formats to nothing')
assert.equal(chipLabel({ label: 'x'.repeat(100) }).length, 56, 'chip labels share the label cap')
assert.equal(clipboardOf({ kind: 'link', label: '文档', url: 'https://a' }), '[引用链接] 文档', 'clipboard text is one short line')
assert.equal(clipboardOf({ kind: 'element', label: '保存' }), '[引用元素] 保存', 'clipboard text names the kind')

/* ------------------------------- sent-message rendering (write ↔ read pair) */

const parsed = parseUserBlock(elementText.trimEnd())
assert.equal(parsed.kind, 'element', 'a block parses back to an element')
assert.equal(parsed.label, '提交订单', 'the desc in parentheses is stripped from the display label')
assert.equal(parsed.selector, 'form#cart > button.btn-primary', 'the selector survives the round trip')
assert.equal(parsed.page, 'https://shop.example/cart', 'the page survives the round trip')

const parsedLink = parseUserBlock(link.trimEnd())
assert.equal(parsedLink.kind, 'link', 'a link block parses as a link')
assert.equal(parsedLink.url, 'https://shop.example/help/price', 'the link target survives')

// A label that genuinely ends in parentheses must not lose it.
const parens = parseUserBlock(formatReference({ ...element, label: '按钮 (新)', desc: '', text: '' }).trimEnd())
assert.equal(parens.label, '按钮 (新)', 'a CJK parenthesised label is kept')

// The rule must find every block in a message that stacks several of them.
const pattern = sentTextPattern()
const stacked = elementText + withFrame + link
const found = [...stacked.matchAll(pattern)].map((match) => parseUserBlock(match[0]))
assert.equal(found.length, 3, 'three stacked blocks are matched separately')
assert.deepEqual(found.map((entry) => entry.kind), ['element', 'element', 'link'], 'each block keeps its kind')
assert.ok(!pattern.exec('普通文字，没有引用'), 'plain text has no reference')

/* ------------------------------------------------------------ target pick */

const targets = [
  { id: 'a', url: 'https://other.example/' },
  { id: 'b', url: 'https://shop.example/cart' },
  { id: 'c', url: 'https://shop.example/help' },
]
assert.equal(cdp.pickTargetFor(targets, 'https://shop.example/cart').id, 'b', 'exact URL wins')
assert.equal(cdp.pickTargetFor(targets, 'https://shop.example/missing').id, 'b', 'same origin is the fallback')
assert.equal(cdp.pickTargetFor(targets, '').id, 'a', 'without a page the first target is used')
assert.equal(cdp.pickTargetFor([], 'https://x'), null, 'no targets answers null')

const flash = cdp.flashExpression({ selector: 'a > b', frame: 'iframe#x' })
assert.ok(flash.includes('"a > b"'), 'the flash expression carries the selector literally')
assert.ok(flash.startsWith('(function (selector, frame)'), 'the flash expression is self-contained')

/* ------------------------------------------------- extension stays in sync */

// The extension injects the very same picker kernel: if the two copies drift, the
// browser shows one behaviour and the app another. This SELF-HEALS rather than only
// complaining, because a stale copy has silently shipped before.
const agentSource = readFileSync(new URL('../agent.source.js', import.meta.url), 'utf8')
if (readFileSync(new URL('../extension/agent.js', import.meta.url), 'utf8') !== agentSource) {
  writeFileSync(new URL('../extension/agent.js', import.meta.url), agentSource)
  console.log('synced extension/agent.js from agent.source.js')
}
assert.equal(
  readFileSync(new URL('../extension/agent.js', import.meta.url), 'utf8'),
  agentSource,
  'extension/agent.js must equal agent.source.js',
)

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
assert.equal(manifest.manifest_version, 3, 'the extension is Manifest V3')
assert.ok(manifest.permissions.includes('scripting'), 'injecting the picker needs the scripting permission')
assert.ok(manifest.background.service_worker === 'background.js', 'the bridge runs in the service worker')

console.log('ok — all pure-logic checks passed')















/* ------------------------------- 提示语只走 UI，绝不进输入框（token 效率） */

const clientText = read('client.js')
assert.ok(!/insertText\(\s*t\(/u.test(clientText), 'toast text is never inserted into the composer')
assert.ok(!/insertQuote\(\s*t\(/u.test(clientText), 'toast text is never inserted as a quote')
const referenceBlock = clientText.slice(clientText.indexOf('const reference = {'))
const referenceLiteral = referenceBlock.slice(0, referenceBlock.indexOf('}') + 1)
assert.ok(/chipLabel\(payload\)/u.test(referenceLiteral), 'the chip reference is labelled from the payload')
assert.ok(!/\bt\(/u.test(referenceLiteral), 'the chip reference never carries a toast string')
// 只有引用块会进输入框：降级通道只影响"怎么插"，不改变"插什么"。
assert.ok(
  /insertText\(formatReference\(payload, true\), span\)/u.test(clientText),
  'the plain-text fallback inserts the reference block, not a notice',
)
for (const key of ['inserted', 'insertedText', 'insertedClipboard', 'insertFailed', 'nothingHere', 'pickFailed']) {
  assert.ok(
    new RegExp(`^\\s{8,}${key}:`, 'mu').test(clientSource),
    'notice key present in the locale tables: ' + key,
  )
}


