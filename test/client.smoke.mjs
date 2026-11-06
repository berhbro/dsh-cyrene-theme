/**
 * 客户端半自检：不装浏览器，用最小 DOM / react / fetch 桩把 bundle 跑一遍。
 *
 *   node test/client.smoke.mjs
 *
 * 覆盖：bundle 包装与导出、样式表注入与回收、body 作用域与还原、
 *      GET 之后按 theme 打 data-cyrene-skin、两个槽位注册（id / order）、
 *      设置页编辑器真的跑起来之后的写入姿势（只发改动字段 + rev）与 409 冲突自动重载。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const PACKAGE_ID = 'dsh-cyrene-theme'

let passed = 0
const failures = []
function ok(label, cond, extra) {
  if (cond) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
  }
}
const tick = () => new Promise((r) => setTimeout(r, 30))

/**
 * 极简 DOM 元素桩：够 createEditor / openPanel 那一小撮用法（属性、子节点、
 * innerHTML 里扫出来的 data-role、事件监听、querySelector/closest）。
 */
function parseHtml(html) {
  const out = []
  const tagRe = /<(\w+)([^>]*)>/g
  let tagMatch
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrs = {}
    const attrRe = /([\w-]+)="([^"]*)"/g
    let attrMatch
    while ((attrMatch = attrRe.exec(tagMatch[2])) !== null) attrs[attrMatch[1]] = attrMatch[2]
    out.push({ tag: tagMatch[1], attrs })
  }
  return out
}

class El {
  constructor(tag) {
    this.tagName = tag
    this.attrs = {}
    this.children = []
    this.listeners = {}
    this.value = ''
    this.checked = false
    this._text = ''
    this.parent = null
    this._html = ''
    // 贴图大小是写到 body.style 上的自定义属性；桩里记下来供断言。
    this.style = {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value) },
      removeProperty(name) { delete this._props[name] },
      getPropertyValue(name) { return this._props[name] ?? '' },
    }
  }
  set textContent(v) {
    this._text = String(v)
    // 真 DOM 里 textContent="" 会清空子节点；这里对齐，
    // 否则重复渲染（每次 paint）会在桩里越堆越多。
    if (this._text === '') this.children = []
  }
  get textContent() { return this._text }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  append(...children) { for (const child of children) this.appendChild(child) }
  remove() {
    this.removed = true
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this)
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn) }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event })
  }
  closest(selector) {
    const wantRole = selector.includes('button')
    for (let node = this; node !== null; node = node.parent) {
      if (wantRole && node.tagName === 'button' && node.attrs['data-role'] !== undefined) return node
    }
    return null
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }
  querySelector(selector) {
    const roleMatch = /\[data-role="([^"]+)"\]/.exec(selector)
    return this.descendants().find((node) => (
      roleMatch !== null ? node.attrs['data-role'] === roleMatch[1] : node.tagName === selector
    )) ?? null
  }
  querySelectorAll() { return [] }
  focus() {}
  set innerHTML(html) {
    this._html = html
    this.children = []
    for (const { tag, attrs } of parseHtml(html)) {
      const child = new El(tag)
      Object.assign(child.attrs, attrs)
      this.appendChild(child)
    }
  }
  get innerHTML() { return this._html }
}

function makeDoc() {
  const head = new El('head')
  const body = new El('body')
  body.dataset = {}
  return {
    baseURI: 'http://127.0.0.1:19387/',
    visibilityState: 'visible',
    head,
    body,
    createElement(tag) { return new El(tag) },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * 载入 bundle 并返回 apply / inject / 被捕获的 spec。
 * `response` 可以是固定的 {ok,value} 信封，也可以是 (call, index) => {status, payload}
 * 的应答函数（返回 Promise 就能模拟慢响应）。
 */
async function bootstrap(response, options = {}) {
  const calls = []
  const refs = []
  let spec = null
  globalThis.window = {
    __ModuleLoader__: {
      load(s) {
        spec = s
      },
    },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
  }
  globalThis.document = makeDoc()
  // 上传走 FileReader.readAsDataURL；桩只要把预定好的 data URL 递回去。
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = options.dataUrl ?? 'data:image/png;base64,AAAA'
      if (typeof this.onload === 'function') this.onload()
    }
  }
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body }
    calls.push(call)
    const decided = typeof response === 'function'
      ? await response(call, calls.length)
      : { status: 200, payload: response }
    const status = decided?.status ?? 200
    const payload = decided?.payload ?? decided
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      // 「看原文」走的是 text()：正文是整段 json 文本。
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }

  const source = await readFile(CLIENT, 'utf8')

  // 取证扫描用的是 setInterval；测试里把它换成手动可触发的桩，方便验证重试语义。
  const intervals = []
  if (options.captureIntervals === true) {
    globalThis.setInterval = (fn) => {
      intervals.push(fn)
      return { unref() {} }
    }
    globalThis.clearInterval = () => {}
  }
  ;(0, eval)(source)

  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (v) => {
      // 真实组件传 null，然后往 ref.current 里挂编辑器；这里给它一个真元素。
      const ref = { current: v == null && options.autoHost === true ? new El('div') : v }
      refs.push(ref)
      return ref
    },
    useEffect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') (options.cleanups ??= []).push(dispose)
    },
    useState: (initial) => {
      // 桩只要能把首帧渲染出来；setter 记下值，测的是「首帧长什么样」。
      let value = initial
      return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
    },
    useSyncExternalStore() {},
  }
  const exports_ = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return { spec, exports: exports_, calls, react, refs, intervals, doc: globalThis.document }
}

function makeCtx(options = {}) {
  const registered = []
  const injected = []
  const disposed = []
  const effects = []
  const themeCalls = []
  // 宿主主题服务（dsh-client-ui-theme 提供）：背景管理器靠 ctx.get('theme') 拿到它，
  // 「浅色 / 深色」两档直接调它的 setTheme；真实的宿主切完会把深色标记落到 body 上，
  // 这里照做（否则管理器读不到"现在是什么外观"）。
  const theme = {
    preference: options.themePreference ?? 'light',
    getTheme() {
      // 真服务回的是不可变快照：preference 是偏好（可能是 system），active 是解析结果。
      return {
        preference: this.preference,
        active: { colorScheme: this.preference === 'dark' ? 'dark' : 'light' },
      }
    },
    setTheme(id) {
      themeCalls.push(id)
      this.preference = id
      if (globalThis.document?.body) {
        if (id === 'dark') globalThis.document.body.setAttribute('data-ds-dark-theme', '')
        else globalThis.document.body.removeAttribute('data-ds-dark-theme')
      }
    },
  }
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
    },
    get(name) {
      return name === 'theme' ? theme : undefined
    },
    slots: {
      inject(name, cb) {
        injected.push(name)
        cb()
        // 真契约里 inject 回的是"这次注入"的 disposer：欢迎页开关就靠它撤注册，
        // 让宿主自己的鱼 + 「探索未至之境」回来。
        return () => {
          disposed.push(name)
        }
      },
      register(registration, component) {
        // 模拟「宿主已经在同一优先级占了 single 槽」——真实契约会直接 throw。
        if (options.failSlot === registration.name) {
          throw new Error(`single slot "${registration.name}" already has a registration at priority 0`)
        }
        registered.push({ registration, component })
      },
    },
  }
  return { ctx, registered, injected, disposed, effects, theme, themeCalls }
}

const RESPONSE = {
  ok: true,
  value: {
    persona: '昔涟的设定',
    enabled: true,
    theme: true,
    defaultPersona: '默认昔涟',
    statePath: 'C:\\Users\\you\\.dsh\\dsh-theme-cyrene\\cyrene-theme.json',
  },
}

console.log(`bundle = ${CLIENT.pathname}\n`)

/** 背景清单信封：两张图，路径都必须是宿主半的字节路由。 */
const BACKGROUNDS = {
  ok: true,
  value: {
    error: null,
    folder: 'Background',
    items: [
      { id: 'a.jpeg', name: 'a.jpeg', type: 'image/jpeg', bytes: 10, url: '/cyrene/background/a.jpeg' },
      // 第二张标成"用户自传"，好顺手验证删除按钮只出现在自传的那几张上；
      // url 故意带查询串：缩略图必须照用宿主给的地址，而不是自己拼一遍。
      { id: 'b.jpeg', name: 'b.jpeg', type: 'image/jpeg', bytes: 10, custom: true, url: '/cyrene/background/b.jpeg?v=2' },
    ],
  },
}
const isBackgrounds = (call) => call.url.includes('/cyrene/backgrounds')

// ── 1. 包装 + 导出
const boot = await bootstrap(RESPONSE)
ok('loader 用包名注册', boot.spec?.id === PACKAGE_ID, boot.spec?.id)
ok('导出 apply / inject', typeof boot.exports.apply === 'function' && Array.isArray(boot.exports.inject), Object.keys(boot.exports))
ok('inject = ["slots"]', boot.exports.inject.length === 1 && boot.exports.inject[0] === 'slots', boot.exports.inject)

// ── 2. apply：样式表、body 作用域、两个槽位、主题属性
const box = makeCtx()
boot.exports.apply(box.ctx)
await tick()

ok(
  '注册了 8 个 effect（样式 / 欢迎页 CSS / 作用域 / 释放 loader 误标的样式 / 焦点同步 / 背景层 / 活页面取证 / 欢迎页槽位）',
  box.effects.length === 8 && box.effects[0].label.endsWith('stylesheet') && box.effects[1].label.endsWith('hero stylesheet') && box.effects[4].label.endsWith('resync on focus') && box.effects[5].label.endsWith('background layer') && box.effects[6].label.endsWith('dom report') && box.effects[7].label.endsWith('hero slot'),
  box.effects.map((e) => e.label),
)
const style = globalThis.document.head.children[0]
ok('样式表进了 head', style?.tagName === 'style')
ok('样式表带 data-plugin-css（防 loader 误删）', style?.attrs['data-plugin-css'] === PACKAGE_ID, style?.attrs)
const heroStyle = globalThis.document.head.children[1]
ok(
  '欢迎语的自定义 CSS 是另一张 style（同一标记 + -hero 后缀，空内容时等于没有）',
  heroStyle?.tagName === 'style' && heroStyle?.attrs['data-plugin-css'] === PACKAGE_ID + '-hero' && heroStyle?.textContent === '',
  [heroStyle?.attrs, heroStyle?.textContent],
)
ok('CSS 含作用域属性与毛玻璃', /\[data-dsh-cyrene\]/.test(style?.textContent ?? '') && /backdrop-filter/.test(style?.textContent ?? ''))

// 回归保护：AppFrame 的 overlayLayer（[data-shell-overlay]，position:absolute;inset:0;z-index:20，
// 永远存在）一旦被加上 backdrop-filter，整个窗口都会发糊 —— 曾经真的犯过这个错。
const cssText = (style?.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
const blurTargets = [...cssText.matchAll(/([^{}]+)\{([^{}]*backdrop-filter[^{}]*)\}/g)]
  .map((m) => m[1].trim())
  .join(' | ')
ok(
  '毛玻璃不落在整帧 overlay 层本身上',
  !/\[data-shell-overlay\](?!\s*>\s*\*)/.test(blurTargets) && !/\[data-slot="shell\.overlay"\]/.test(blurTargets),
  blurTargets.slice(0, 160),
)
ok('毛玻璃落到浮层的直接子元素上', /\[data-shell-overlay\]\s*>\s*\*/.test(blurTargets), blurTargets.slice(0, 160))
// 回归保护 2：右侧栏容器 [data-sidebar-right-panel]（.OUqwTW_panel）是
// position:absolute;top:0;bottom:0;right:0 且自身无背景，收起时只把窗格设成
// visibility:hidden（仍占布局）——给它加 backdrop-filter 会让右半边一直发雾，
// 打开设置页出现、关掉也不散。只允许打在真正的窗格上。
ok(
  '毛玻璃不落在右侧栏容器 [data-sidebar-right-panel] 上',
  !/\[data-sidebar-right-panel\]/.test(blurTargets),
  blurTargets.slice(0, 200),
)
ok(
  '毛玻璃落在真正的窗格 [data-dockkit-pane] / [data-dockkit-float] 上',
  /\[data-dockkit-pane\]/.test(blurTargets) && /\[data-dockkit-float\]/.test(blurTargets),
  blurTargets.slice(0, 200),
)
ok(
  'html 画布有不透明兜底（桌面窗口是原生 acrylic）',
  /html:has\(body\[data-dsh-cyrene\]\[data-cyrene-skin="on"\]\)/.test(cssText) && /background-color:#fff8fc/.test(cssText),
)
// 回归保护 3：输入框卡片的毛玻璃必须画在静态伪元素上，不能画在卡片自己身上。
// 卡片的发送键外面套着一个没开 portal 的 Tooltip，气泡是 position:fixed 且靠在
// ResizeObserver 里反复「适应」视口换边；卡片一旦自己带 backdrop-filter，就成了
// fixed 后代的包含块，气泡的视口定位被破坏 —— 鼠标停在发送键上（delayMs 500）时
// 界面就会抖/闪。这条断言把那个坑钉住。
const blurSelectors = [...cssText.matchAll(/([^{}]+)\{([^{}]*backdrop-filter[^{}]*)\}/g)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim()))
const cardBlur = blurSelectors.filter((s) => s.includes('[data-composer-card]'))
ok(
  '卡片的毛玻璃只画在 ::before 上（卡片自己不能成为 fixed 后代的包含块）',
  cardBlur.length > 0 && cardBlur.every((s) => /\[data-composer-card\]::before/.test(s)),
  cardBlur,
)
const groupBlur = blurSelectors.filter((s) => /data-slot="sidebar|data-dockkit-pane|data-dockkit-float|role="dialog"|data-radix-popper|data-shell-overlay/.test(s))
ok(
  '毛玻璃组齐全，且已经不再挂诊断闸门（面板里的诊断开关取消了）',
  groupBlur.length >= 7 && groupBlur.every((s) => !s.includes('data-cyre-blur')),
  groupBlur,
)
ok(
  '贴图大小：CSS 变量 + 按 alt 认自己的贴图（不带主题开关，关了主题也该生效）',
  /body\[data-dsh-cyrene\]\{[^}]*--cyre-sticker-size:96px/.test(cssText) &&
    /body\[data-dsh-cyrene\] img\[alt\^="昔涟·"\]\{[^}]*max-width:var\(--cyre-sticker-size\)[^}]*max-height:var\(--cyre-sticker-size\)/.test(cssText),
)
// 管理器是单独一页：外层覆盖层封顶 + overflow:hidden，里面那层才滚动；
// 卡片锁 min-width:0 / max-width:100% / overflow:hidden，长名字也撑不出格子。
ok(
  '表情包管理器不会让素材超出页面范围（外层封顶、内层滚动、卡片锁宽）',
  /\.cyre-overlay\{[^}]*max-height:[^}]*overflow:hidden/.test(cssText) &&
    /\.cyre-overlay--wide\{[^}]*width:min\(/.test(cssText) &&
    /\.cyre-manager-scroll\{[^}]*flex:1 1 auto[^}]*min-height:0[^}]*overflow-y:auto[^}]*overflow-x:hidden/.test(cssText) &&
    /\.cyre-sticker\{[^}]*min-width:0[^}]*max-width:100%[^}]*overflow:hidden/.test(cssText) &&
    /\.cyre-sticker img\{[^}]*max-width:100%/.test(cssText),
)
// 回归：滚动容器是 flex 列，子项默认会被压缩而不是让容器滚——世界书 279 条时
// 列表被压扁、卡片直接画到下面的说明文字上。钉住 flex:0 0 auto 才真的滚。
ok(
  '管理器里的子项不参与压缩（否则条目一多，卡片会叠到说明文字上）',
  /\.cyre-manager-scroll > \*\{flex:0 0 auto\}/.test(cssText),
  (cssText.match(/\.cyre-manager-scroll > \*\{[^}]*\}/) ?? ['(没找到)'])[0],
)
// 回归：侧边栏那颗「✦ 昔涟」弹出的面板内容比 max-height 高时，编辑器自己得能滚——
// 否则最后几行（世界书入口）被 overflow:hidden 裁掉，看起来就像根本没做这个控制器。
ok(
  '侧边栏面板里的编辑器自己能滚（内容一多，最后一行不会被裁掉）',
  /\.cyre-editor\{[^}]*flex:1 1 auto[^}]*overflow-y:auto/.test(cssText),
  (cssText.match(/\.cyre-editor\{[^}]*\}/) ?? ['(没找到)'])[0],
)
ok('body 打了 data-dsh-cyrene', globalThis.document.body.attrs['data-dsh-cyrene'] === '', globalThis.document.body.attrs)

ok(
  '三个槽位都 inject 了',
  box.injected.join(',') === 'sidebar.footer.action,settings.section,conversation.hero.brand.mark',
  box.injected,
)
const ids = box.registered.map((r) => r.registration.id)
ok('前两个槽位的 id', ids.slice(0, 2).join(',') === 'cyrene-persona,cyrene-theme', ids)
ok('槽位 order 20 / 30', box.registered[0].registration.order === 20 && box.registered[1].registration.order === 30)
ok(
  '槽位 name 依次是 sidebar.footer.action / settings.section / conversation.hero.brand.mark',
  box.registered.map((r) => r.registration.name).join(',') === 'sidebar.footer.action,settings.section,conversation.hero.brand.mark',
  box.registered.map((r) => r.registration),
)
ok(
  '欢迎页槽位不带 id / order（契约里是单占位，官方示例只传 name）',
  box.registered[2].registration.id === undefined && box.registered[2].registration.order === undefined,
  box.registered[2].registration,
)
ok(
  '欢迎页槽位用 priority -1 去盖住宿主在 p0 的那条鱼（issue #1）',
  box.registered[2].registration.priority === -1,
  box.registered[2].registration,
)
ok('组件是可调用的 React 组件', box.registered.every((r) => typeof r.component === 'function'))

// 宿主（DSH Desktop 的 dsh-desktop-client-ui）已经在 p0 占了欢迎页标记：注册会抛，
// 但错误必须关在自己的回调里——抛到外面会被算成「声明这个槽位的宿主入口」激活失败，
// 整个 GUI 起不来（issue #1 的实际现象）。
const conflictBox = makeCtx({ failSlot: 'conversation.hero.brand.mark' })
let conflictError = null
try {
  boot.exports.apply(conflictBox.ctx)
} catch (error) {
  conflictError = error
}
ok('宿主占用欢迎页槽位时 apply 不抛（失败不外溢）', conflictError === null, conflictError && conflictError.message)
ok(
  '冲突时其它两个槽位照常注册',
  conflictBox.registered.map((r) => r.registration.name).join(',') === 'sidebar.footer.action,settings.section',
  conflictBox.registered.map((r) => r.registration.name),
)

const get = boot.calls.find((c) => c.method === 'GET' && c.url.endsWith('/cyrene/state'))
ok('GET 打到 /cyrene/state', get?.url === 'http://127.0.0.1:19387/cyrene/state', get)
ok('theme=true → data-cyrene-skin="on"', globalThis.document.body.attrs['data-cyrene-skin'] === 'on', globalThis.document.body.attrs)
// 取证是旁路：开机就先报一份，并且不碰 rev / 状态
const reportCall = boot.calls.find((c) => c.url.endsWith('/cyrene/report'))
const reportBody = reportCall ? JSON.parse(reportCall.body) : null
ok(
  '开机就上报一份活页面取证到 /cyrene/report',
  reportCall?.method === 'POST' && reportBody?.kind === 'cyrene-dom-report',
  reportCall,
)
ok('取证不带 rev（与状态写入口完全分开）', reportBody !== null && !('rev' in reportBody), reportBody && Object.keys(reportBody))

// ── 3. 卸载：还原 body，移除样式
for (const effect of box.effects.reverse()) if (typeof effect.dispose === 'function') effect.dispose()
ok('卸载后移除 body 作用域', globalThis.document.body.attrs['data-dsh-cyrene'] === undefined && globalThis.document.body.attrs['data-cyrene-skin'] === undefined, globalThis.document.body.attrs)
ok('卸载后移除样式表', style?.removed === true)

// ── 4. theme=false 的宿主状态 → skin="off"
const boot2 = await bootstrap({ ok: true, value: { ...RESPONSE.value, theme: false } })
const box2 = makeCtx()
boot2.exports.apply(box2.ctx)
await tick()
ok('theme=false → data-cyrene-skin="off"', globalThis.document.body.attrs['data-cyrene-skin'] === 'off', globalThis.document.body.attrs)

// ── 5. 宿主信封失败时不能把插件拖垮
const boot3 = await bootstrap(RESPONSE)
globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'x', message: 'boom' } }) })
const box3 = makeCtx()
boot3.exports.apply(box3.ctx)
await tick()
ok('读不到宿主也照样装上（skin 退回本地默认 on）', globalThis.document.body.attrs['data-cyrene-skin'] === 'on', globalThis.document.body.attrs)
ok('槽位仍然注册了', box3.registered.length === 3)

// ── 6. 编辑器真的跑起来：只发改动字段 + rev 契约 + 409 冲突后自动重新载入
const REV7 = { ok: true, value: { ...RESPONSE.value, rev: 7, theme: true, version: '0.1.1' } }
const STALE = {
  ok: false,
  error: { code: 'stale', message: '设定已在别处改动，已为你重新载入最新版本，请再操作一次' },
}
const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bootE = await bootstrap(REV7, { autoHost: true })
const boxE = makeCtx()
bootE.exports.apply(boxE.ctx)
await tick()
boxE.registered.find((r) => r.registration.id === 'cyrene-theme').component()
const editor = bootE.refs[0].current.children[0]
ok('设置页组件跑起来后挂出了编辑器', editor?.className === 'cyre-editor', editor?.className)

const themeBox = editor.querySelector('[data-role="theme"]')
const personaArea = editor.querySelector('[data-role="persona"]')
const saveBtn = editor.querySelector('[data-role="save"]')
const statusEl = editor.querySelector('[data-role="status"]')
ok('编辑器有开关 / 文本域 / 保存按钮 / 状态位', Boolean(themeBox && personaArea && saveBtn && statusEl))
ok('文本域先填上宿主的人格', personaArea.value === '昔涟的设定', personaArea.value)

const beforeToggle = bootE.calls.length
themeBox.checked = false
themeBox.dispatch('change')
await tick()
const togglePost = bootE.calls.slice(beforeToggle).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const togglePatch = togglePost ? JSON.parse(togglePost.body) : null
ok('开关改动立刻 POST', togglePost !== undefined, bootE.calls.slice(beforeToggle))
ok('POST 带上了宿主给的 rev=7', togglePatch?.rev === 7, togglePatch)
ok(
  '开关只发自己那个字段（不再回写缓存快照）',
  togglePatch?.theme === false && !('persona' in togglePatch) && !('enabled' in togglePatch),
  togglePatch,
)

personaArea.value = '新的人格底稿'
personaArea.dispatch('input')
const beforeSave = bootE.calls.length
editor.dispatch('click', { target: saveBtn })
await tick()
const savePost = bootE.calls.slice(beforeSave).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const savePatch = savePost ? JSON.parse(savePost.body) : null
ok(
  '保存按钮只提交改过的 persona（并带 rev）',
  savePatch?.persona === '新的人格底稿' && savePatch?.rev === 7 && !('theme' in savePatch) && !('enabled' in savePatch),
  savePatch,
)
ok('保存成功后状态位给出反馈', /已保存/.test(statusEl.textContent), statusEl.textContent)

let stateGetCount = 0
const bootS = await bootstrap(async (call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  // 背景清单要立刻应答：它不能参与下面这个「第 2 个 GET 起变慢」的计数，
  // 否则被拖慢的会变成 state GET，断言时状态位还没写上就被 absorb 清掉。
  if (isBackgrounds(call)) return { status: 200, payload: BACKGROUNDS }
  if (call.method === 'POST') return { status: 409, payload: STALE }
  stateGetCount += 1
  if (stateGetCount > 1) await slow(45)
  return { status: 200, payload: REV7 }
}, { autoHost: true })
const boxS = makeCtx()
bootS.exports.apply(boxS.ctx)
await tick()
const pageS = boxS.registered.find((r) => r.registration.id === 'cyrene-theme').component()
const headS = (pageS.children ?? []).find((c) => c && c.props && c.props.className === 'cyre-page-head')
const verS = headS === undefined
  ? undefined
  : headS.children.find((c) => c && c.props && c.props['data-role'] === 'version')
ok(
  '设置页标题旁显示插件版本号（值来自宿主半读的 package.json）',
  verS !== undefined && verS.children.join('') === 'v0.1.1',
  verS === undefined ? null : verS.children,
)
const editorS = bootS.refs[0].current.children[0]
const themeS = editorS.querySelector('[data-role="theme"]')
const statusS = editorS.querySelector('[data-role="status"]')
const getsBefore = bootS.calls.filter((c) => c.method === 'GET').length
themeS.checked = false
themeS.dispatch('change')
await tick()
ok('版本过期（409）时状态位显示宿主说明', /已在别处改动/.test(statusS.textContent), statusS.textContent)
ok(
  '冲突后自动重新载入（多发一次 GET）',
  bootS.calls.filter((c) => c.method === 'GET').length === getsBefore + 1,
  bootS.calls.map((c) => c.method),
)
await slow(60)
ok('重新载入完成后按宿主的值把开关回正', themeS.checked === true, themeS.checked)

// ── 6b. 表情包：清单预览 + 开关（图片必须走宿主半，不能是 file://）
const STICKERS = {
  ok: true,
  value: {
    version: 1,
    maxPerTurn: 1,
    enabled: true,
    missing: [],
    items: [
      { id: 'happy', label: '超开心', when: '事情成了', type: 'image/png', bytes: 10, url: '/cyrene/sticker/happy' },
      { id: 'wink', label: '俏皮眨眼', when: '开个小玩笑', type: 'image/png', bytes: 10, url: '/cyrene/sticker/wink' },
    ],
  },
}
const bootK = await bootstrap((call) => {
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS }
  if (call.url.includes('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  return { status: 200, payload: REV7 }
}, { autoHost: true })
const boxK = makeCtx()
bootK.exports.apply(boxK.ctx)
await tick()
boxK.registered.find((r) => r.registration.id === 'cyrene-theme').component()
await tick()
const editorK = bootK.refs[0].current.children[0]
ok(
  '编辑器拉了表情包清单',
  bootK.calls.some((c) => c.method === 'GET' && c.url.includes('/cyrene/stickers')),
  bootK.calls.map((c) => c.url),
)
const entryK = editorK.querySelector('[data-role="open-stickers"]')
const summaryK = editorK.querySelector('[data-role="sticker-summary"]')
ok(
  '编辑器里只剩一个入口：一句概况 + 「打开管理器」按钮，没有内嵌网格/滑杆',
  entryK !== null && summaryK !== null &&
    editorK.querySelector('[data-role="sticker-grid"]') === null &&
    editorK.querySelector('[data-role="sticker-size"]') === null &&
    editorK.querySelector('[data-role="blur"]') === null,
  [entryK !== null, summaryK?.textContent],
)
ok('入口那句概况跟上清单', /2 张/.test(summaryK.textContent), summaryK.textContent)

editorK.dispatch('click', { target: entryK })
const overlayK = globalThis.document.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok('点入口打开管理器页（挂在 body 上的覆盖层）', overlayK !== undefined && overlayK !== null, globalThis.document.body.descendants().map((el) => el.className))
const managerK = overlayK.querySelector('[data-role="sticker-grid"]')
const cardsK = managerK.descendants().filter((el) => el.className === 'cyre-sticker')
ok('管理器网格按清单渲染卡片（不重复堆）', cardsK.length === 2, cardsK.length)
const imgK = cardsK[0].descendants().find((el) => el.tagName === 'img')
ok(
  '图片指向宿主半的字节路由，不是 file:// 本地路径',
  typeof imgK?.src === 'string' && imgK.src.includes('/cyrene/sticker/happy') && !imgK.src.startsWith('file:'),
  imgK?.src,
)
// 关掉管理器：覆盖层必须真的从 body 上摘掉（不然会越开越多）。
const closeK = overlayK.querySelector('[data-role="close"]') ?? overlayK.descendants().find((el) => el.tagName === 'button' && el.attrs['aria-label'] === '关闭')
closeK.dispatch('click')
ok(
  '关掉后覆盖层从 body 上移除',
  !globalThis.document.body.descendants().some((el) => el.className === 'cyre-overlay cyre-overlay--wide'),
  globalThis.document.body.descendants().map((el) => el.className),
)
const stickersBoxK = editorK.querySelector('[data-role="stickers"]')
ok('表情包开关默认按宿主值打开', stickersBoxK.checked === true, stickersBoxK.checked)
const beforeK = bootK.calls.length
stickersBoxK.checked = false
stickersBoxK.dispatch('change')
await tick()
const kPost = bootK.calls.slice(beforeK).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const kPatch = kPost ? JSON.parse(kPost.body) : null
ok(
  '关掉表情包只提交 stickers 字段',
  kPatch?.stickers === false && kPatch?.rev === 7 && !('theme' in kPatch) && !('persona' in kPatch),
  kPatch,
)

const bootK2 = await bootstrap({ ok: true, value: { ...REV7.value, stickers: false } }, { autoHost: true })
const boxK2 = makeCtx()
bootK2.exports.apply(boxK2.ctx)
await tick()
boxK2.registered.find((r) => r.registration.id === 'cyrene-theme').component()
const editorK2 = bootK2.refs[0].current.children[0]
ok(
  '宿主说关着时开关回显为关',
  editorK2.querySelector('[data-role="stickers"]').checked === false,
  editorK2.querySelector('[data-role="stickers"]').checked,
)

// ── 6c. 表情包管理器：一个入口 → 单独一页（大小滑杆 + 自添加 + 删除）
const STICKERS_CUSTOM = {
  ok: true,
  value: {
    ...STICKERS.value,
    items: [
      ...STICKERS.value.items,
      { id: 'u1', label: '自定的', when: '测试用', custom: true, type: 'image/png', bytes: 10, url: '/cyrene/sticker/u1' },
    ],
  },
}
const bootM = await bootstrap((call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  if (isBackgrounds(call)) return { status: 200, payload: BACKGROUNDS }
  if (call.method === 'POST' && call.url.endsWith('/cyrene/stickers/remove')) {
    return { status: 200, payload: { ok: true, value: { state: { ...REV7.value, rev: 10 }, stickers: STICKERS.value } } }
  }
  if (call.method === 'POST' && call.url.endsWith('/cyrene/stickers')) {
    return { status: 200, payload: { ok: true, value: { state: { ...REV7.value, rev: 9 }, stickers: STICKERS_CUSTOM.value } } }
  }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS_CUSTOM }
  if (call.method === 'POST') return { status: 200, payload: { ok: true, value: { ...REV7.value, rev: 8 } } }
  return { status: 200, payload: REV7 }
}, { autoHost: true })
const boxM = makeCtx()
bootM.exports.apply(boxM.ctx)
await tick()
boxM.registered.find((r) => r.registration.id === 'cyrene-theme').component()
await tick()
const editorM = bootM.refs[0].current.children[0]

ok(
  '诊断开关已经从编辑器里取消（也不在管理器里）',
  editorM.querySelector('[data-role="blur"]') === null &&
    !editorM.descendants().some((el) => el.attrs['data-role'] === 'blur'),
  editorM.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)

const entryM = editorM.querySelector('[data-role="open-stickers"]')
editorM.dispatch('click', { target: entryM })
const overlayM = globalThis.document.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok('入口按钮打开管理器页', overlayM !== undefined && overlayM !== null, globalThis.document.body.descendants().map((el) => el.className))
const managerRoot = overlayM.descendants().find((el) => el.className === 'cyre-manager')

const sizeRange = overlayM.querySelector('[data-role="sticker-size"]')
const sizeLabel = overlayM.querySelector('[data-role="sticker-size-label"]')
ok(
  '大小滑杆按宿主值回显',
  sizeRange?.value === '96' && sizeLabel?.textContent === '96px',
  [sizeRange?.value, sizeLabel?.textContent],
)
sizeRange.value = '160'
sizeRange.dispatch('input')
ok(
  '拖滑杆时先就地改 CSS 变量（还没落盘）',
  globalThis.document.body.style.getPropertyValue('--cyre-sticker-size') === '160px',
  globalThis.document.body.style.getPropertyValue('--cyre-sticker-size'),
)
const beforeSize = bootM.calls.length
sizeRange.dispatch('change')
await tick()
const sizePost = bootM.calls.slice(beforeSize).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const sizePatch = sizePost ? JSON.parse(sizePost.body) : null
ok(
  '松手才提交 stickerSize，且只发这一个字段',
  sizePatch?.stickerSize === 160 && sizePatch?.rev === 7 && Object.keys(sizePatch).length === 2,
  sizePatch,
)

const newFile = overlayM.querySelector('[data-role="new-file"]')
const addButton = overlayM.querySelector('[data-role="add"]')
const newLabel = overlayM.querySelector('[data-role="new-label"]')
const newWhen = overlayM.querySelector('[data-role="new-when"]')
ok('没选文件时「添加」是禁用的', addButton?.disabled === true, addButton?.disabled)
newFile.files = [{ name: 'my.png', type: 'image/png' }]
newFile.dispatch('change')
ok('选了文件就能点「添加」', addButton?.disabled === false, addButton?.disabled)
newLabel.value = '自定的'
newWhen.value = '测试用'
const beforeAdd = bootM.calls.length
addButton.dispatch('click')
await tick()
await tick()
await tick()
const addPost = bootM.calls.slice(beforeAdd).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/stickers'))
const addBody = addPost ? JSON.parse(addPost.body) : null
ok(
  '上传走宿主半的 /cyrene/stickers，带 rev / 名字 / 时机 / data URL',
  addBody?.rev === 8 && /^data:image\/png;base64,/.test(addBody?.data ?? '') &&
    addBody?.label === '自定的' && addBody?.when === '测试用' && addBody?.name === 'my.png',
  addBody && { ...addBody, data: String(addBody.data).slice(0, 24) + '…' },
)

const gridM = overlayM.querySelector('[data-role="sticker-grid"]')
const customCard = gridM.descendants().find((el) => el.className === 'cyre-sticker' && el.descendants().some((d) => d.attrs['data-role'] === 'del-sticker'))
const delBtn = customCard ? customCard.descendants().find((d) => d.attrs['data-role'] === 'del-sticker') : null
ok(
  '上传成功后网格里多出那张卡，且只有自添加的带删除按钮',
  gridM.descendants().filter((el) => el.className === 'cyre-sticker').length === 3 &&
    delBtn !== null && delBtn !== undefined && delBtn.attrs['data-id'] === 'u1',
  gridM.descendants().map((el) => [el.className, el.attrs['data-role']]),
)
const beforeDel = bootM.calls.length
managerRoot.dispatch('click', { target: delBtn })
await tick()
const delPost = bootM.calls.slice(beforeDel).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/stickers/remove'))
const delBody = delPost ? JSON.parse(delPost.body) : null
ok('删除走 /cyrene/stickers/remove 并带上 id 与 rev', delBody?.id === 'u1' && delBody?.rev === 9, delBody)
// 管理器里的改动要回流到编辑器那一行概况（两处共用同一份 state + watchers）。
ok(
  '管理器里删完，编辑器入口的概况也跟着变',
  /2 张/.test(editorM.querySelector('[data-role="sticker-summary"]').textContent),
  editorM.querySelector('[data-role="sticker-summary"]').textContent,
)

// ── 6d. 背景：清单来自 Background/，控制板管开关 / 选图 / 轮换 / 浓度
// 这一块最容易出事的不是"图能不能显示"，而是"会不会碍着用"：
// 图层必须是最底下一层且不吃鼠标，对话列要有一层自己的纸面，
// 而且这层纸面不能是毛玻璃（输入框卡片在滚动容器里，会重新触发浮层闪烁）。
const BG_STATE = { enabled: true, current: '', rotate: false, interval: 90, dim: 0.6 }
// 假宿主也得分状态：每次写只合并补丁，别把没动的字段（尤其 current）冲回默认值。
let bgLive = { ...BG_STATE }
let bgRev = 7
const bgNextRev = () => { bgRev += 1; return bgRev }
const REVB = { ok: true, value: { ...REV7.value, background: BG_STATE } }
const bootB = await bootstrap((call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  if (isBackgrounds(call)) {
    if (call.method === 'GET') return { status: 200, payload: BACKGROUNDS }
    // 上传 / 删除：回一份新状态 + 新清单（形状和宿主半一致）。
    const patch = JSON.parse(call.body)
    bgLive = { ...bgLive, ...(patch.background ?? null) }
    return {
      status: 200,
      payload: { ok: true, value: { state: { ...REVB.value, rev: bgNextRev(), background: bgLive }, backgrounds: BACKGROUNDS.value } },
    }
  }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS }
  if (call.method === 'POST') {
    const patch = JSON.parse(call.body)
    // 宿主半的 POST /cyrene/state 直接回一份新状态（不是嵌在 value.state 里）。
    bgLive = { ...bgLive, ...(patch.background ?? null) }
    return {
      status: 200,
      payload: { ok: true, value: { ...REVB.value, rev: bgNextRev(), background: bgLive } },
    }
  }
  return { status: 200, payload: REVB }
}, { autoHost: true, captureIntervals: true })
const boxB = makeCtx()
bootB.exports.apply(boxB.ctx)
await tick()

const docB = bootB.doc
const layerB = docB.body.descendants().find((el) => el.className === 'cyre-bg')
const imgsB = layerB === undefined ? [] : layerB.children.filter((el) => el.className === 'cyre-bg-img')
const activeImage = () => {
  const img = imgsB.find((el) => el.attrs['data-active'] === '1')
  return img === undefined ? '' : String(img.style.backgroundImage)
}
ok(
  '背景层先铺好两层图 + 一层色纱（换图靠淡入淡出，不重建 DOM），并标了 aria-hidden',
  imgsB.length === 2 && layerB.children.some((el) => el.className === 'cyre-bg-veil') && layerB.attrs['aria-hidden'] === 'true',
  layerB?.children.map((el) => el.className),
)
ok(
  '图层是最底下一层、不吃鼠标（position:fixed / z-index:-1 / pointer-events:none 都写在 CSS 里）',
  /\.cyre-bg\{[^}]*position:fixed/.test(cssText) &&
    /\.cyre-bg\{[^}]*z-index:-1/.test(cssText) &&
    /\.cyre-bg\{[^}]*pointer-events:none/.test(cssText),
)
ok(
  '背景层显式退出宿主的 no-drag 减法（铺满视口的 body 子元素会把 [data-window-drag] 整片减掉 → 窗口拖不动、双击也不能缩放）',
  /body\[data-dsh-cyrene\] > \.cyre-bg\{[^}]*-webkit-app-region:initial !important/.test(cssText) &&
    /body\[data-dsh-cyrene\] > \.cyre-bg\{[^}]*[;{\s]app-region:initial !important/.test(cssText),
)
ok(
  '整列对话区不再刷白：滚动容器身上没有底色 / 圆角那套"纸面"（照片才透得上来）',
  !/\[data-cyre-bg="on"\] \[data-conversation-scroll\]\{[^}]*background:/.test(cssText) &&
    !/\[data-cyre-bg="on"\] \[data-conversation-scroll\]\{[^}]*border-radius/.test(cssText),
)
ok(
  '只对"对话本身"做处理：有图时气泡底色调厚 + 正文一圈淡光晕',
  /\[data-cyre-bg="on"\]\{[^}]*--dsw-specific-bubble:/.test(cssText) &&
    /\[data-cyre-bg="on"\] \[data-conversation-scroll\] :is\(p,li,/.test(cssText) &&
    /text-shadow:/.test(cssText),
)
ok(
  '这层处理没有用毛玻璃（滚动容器一旦成为 fixed 子元素的包含块，发送键的浮层会重新闪）',
  !/\[data-conversation-scroll\][^{]*\{[^}]*backdrop-filter/.test(cssText),
)
ok(
  '拉清单时带 reload=1（往 Background/ 丢新图后刷新就能看到）',
  bootB.calls.some((c) => c.method === 'GET' && isBackgrounds(c) && c.url.includes('reload=1')),
  bootB.calls.map((c) => c.url),
)
ok(
  'body 上写着浓度变量与总开关（页面级，不受编辑器是否打开影响）',
  docB.body.style.getPropertyValue('--cyre-bg-dim') === '0.6' && docB.body.attrs['data-cyre-bg'] === 'on',
  [docB.body.style.getPropertyValue('--cyre-bg-dim'), docB.body.attrs['data-cyre-bg']],
)

boxB.registered.find((r) => r.registration.id === 'cyrene-theme').component()
await tick()
const editorB = bootB.refs[0].current.children[0]
ok(
  '编辑器里只留一行背景入口（概况 + 「打开管理器」），缩略图与滑杆都搬进管理器了',
  editorB.querySelector('[data-role="open-backgrounds"]') !== null &&
    editorB.querySelector('[data-role="bg-strip"]') === null &&
    editorB.querySelector('[data-role="bg-rotate"]') === null &&
    editorB.querySelector('[data-role="bg-interval"]') === null &&
    editorB.querySelector('[data-role="bg-dim"]') === null &&
    editorB.querySelector('[data-role="bg-next"]') === null,
  editorB.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)
ok('概况行跟着清单', /2 张/.test(editorB.querySelector('[data-role="bg-note"]').textContent), editorB.querySelector('[data-role="bg-note"]').textContent)
ok(
  '当前那张真的铺在图层上',
  activeImage().includes('/cyrene/background/a.jpeg'),
  activeImage(),
)

// 打开背景管理器（整页覆盖层，挂在 body 上；和表情包管理器同一套骨架）
editorB.dispatch('click', { target: editorB.querySelector('[data-role="open-backgrounds"]') })
await tick()
const pageB = bootB.doc.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok('点入口打开背景管理器页（挂在 body 上的覆盖层）', pageB !== undefined && pageB !== null, bootB.doc.body.descendants().map((el) => el.className))
const managerB = pageB.descendants().find((el) => el.className === 'cyre-manager')
const stripB = managerB.querySelector('[data-role="bg-strip"]')
const thumbsB = stripB.descendants().filter((el) => el.className === 'cyre-bg-thumb')
ok('管理器按清单渲染缩略图（每张一个按钮）', thumbsB.length === 2, thumbsB.length)
const thumbImgB = thumbsB[0]?.descendants().find((el) => el.tagName === 'img')
ok(
  '缩略图走宿主半的字节路由，不是 file:// 本地路径',
  thumbImgB !== undefined && String(thumbImgB.src).includes('/cyrene/background/a.jpeg') && !String(thumbImgB.src).startsWith('file:'),
  thumbImgB?.src,
)
ok(
  '缩略图里的文件名只占一行、放不下就省略号（完整名留在 title 上）',
  /\.cyre-bg-thumb span\{[^}]*white-space:nowrap/.test(cssText) &&
    /\.cyre-bg-thumb span\{[^}]*text-overflow:ellipsis/.test(cssText) &&
    /\.cyre-bg-thumb span\{[^}]*overflow:hidden/.test(cssText) &&
    thumbsB[0].title === 'a.jpeg' && thumbsB[1].title === 'b.jpeg' &&
    thumbsB.every((el) => el.querySelector !== undefined && el.descendants().some((n) => n.tagName === 'span' && n.textContent === el.title)),
  [thumbsB.map((el) => el.title), /\.cyre-bg-thumb span\{[^}]*\}/.exec(cssText)?.[0]],
)
ok(
  'current 为空＝用清单第一张，那张是亮着的',
  thumbsB[0].attrs['data-on'] === '1' && thumbsB[1].attrs['data-on'] === undefined,
  thumbsB.map((el) => el.attrs['data-on']),
)
const darkBtnB = managerB.descendants().filter((el) => el.attrs['data-role'] === 'bg-dark')
const delBtnB = managerB.descendants().filter((el) => el.attrs['data-role'] === 'bg-del')
ok(
  '「深色」绑图按钮已经取消；「删除」只出现在用户自传的那几张上',
  darkBtnB.length === 0 && delBtnB.length === 1 && delBtnB[0].attrs['data-id'] === 'b.jpeg',
  [darkBtnB.length, delBtnB.map((el) => el.attrs['data-id'])],
)

ok(
  '编辑器里已经没有二选一按钮（都搬进管理器了）',
  editorB.querySelector('[data-role="bg-mode-image"]') === null &&
    editorB.querySelector('[data-role="bg-mode-plain"]') === null,
  editorB.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)
const bgModeImage = managerB.querySelector('[data-role="bg-mode-image"]')
const bgModePlain = managerB.querySelector('[data-role="bg-mode-plain"]')
ok(
  '管理器里风格是二选一：进来时「背景图」亮着、「简约（无图）」没亮，root 上写着当前档',
  bgModeImage.attrs['data-on'] === '1' && bgModePlain.attrs['data-on'] === undefined &&
    managerB.attrs['data-bg-mode'] === 'image',
  [bgModeImage.attrs['data-on'], bgModePlain.attrs['data-on'], managerB.attrs['data-bg-mode']],
)
const bgPostOf = (from) => bootB.calls.slice(from).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const bgPatchOf = (from) => {
  const call = bgPostOf(from)
  return call === undefined ? null : JSON.parse(call.body)
}

const beforeBg = bootB.calls.length
managerB.dispatch('click', { target: bgModePlain })
await tick()
const offPatch = bgPatchOf(beforeBg)
ok(
  '选「简约」只发 background.enabled 一个键（带 rev，不回写别的字段）',
  offPatch?.rev === 7 && offPatch?.background?.enabled === false &&
    Object.keys(offPatch.background).length === 1 && !('persona' in offPatch) && !('theme' in offPatch),
  offPatch,
)
ok('简约档下整层直接 display:none，页面回到没加背景图之前那种样子', docB.body.attrs['data-cyre-bg'] === 'off', docB.body.attrs['data-cyre-bg'])
ok(
  '高亮与档位跟着切，跟图片有关的控件淡下去',
  bgModePlain.attrs['data-on'] === '1' && bgModeImage.attrs['data-on'] === undefined &&
    managerB.attrs['data-bg-mode'] === 'plain' && /\[data-bg-mode="plain"\] \.cyre-bg-only/.test(cssText),
  managerB.attrs['data-bg-mode'],
)

const beforeSameMode = bootB.calls.length
managerB.dispatch('click', { target: bgModePlain })
await tick()
ok('同一档再点一次不重复写宿主（只是重画一遍）', bgPostOf(beforeSameMode) === undefined, bootB.calls.slice(beforeSameMode).map((c) => c.url))

managerB.dispatch('click', { target: bgModeImage })
await tick()
ok(
  '切回「背景图」又铺回原样（不用刷新页面）',
  docB.body.attrs['data-cyre-bg'] === 'on' && managerB.attrs['data-bg-mode'] === 'image' &&
    activeImage().includes('/cyrene/background/a.jpeg'),
  [docB.body.attrs['data-cyre-bg'], activeImage()],
)

const beforePick = bootB.calls.length
managerB.dispatch('click', { target: thumbsB[1] })
await tick()
const pickPatch = bgPatchOf(beforePick)
ok(
  '点缩略图把 current 交给宿主（锚点由用户定，轮换不会推着它走）',
  pickPatch?.background?.current === 'b.jpeg' && Object.keys(pickPatch.background).length === 1,
  pickPatch,
)
ok(
  '选中的那张亮起来，图层也换成它',
  thumbsB[1].attrs['data-on'] === '1' && thumbsB[0].attrs['data-on'] === undefined &&
    activeImage().includes('/cyrene/background/b.jpeg'),
  [thumbsB.map((el) => el.attrs['data-on']), activeImage()],
)

const beforeNext = bootB.calls.length
managerB.dispatch('click', { target: managerB.querySelector('[data-role="bg-next"]') })
await tick()
ok(
  '「下一张」只在页面里换图，不写宿主（下一张不等于改起点）',
  bgPostOf(beforeNext) === undefined && activeImage().includes('/cyrene/background/a.jpeg'),
  activeImage(),
)

// 轮换 / 淡化：滑杆和开关都在管理器里
const bgRotateBox = managerB.querySelector('[data-role="bg-rotate"]')
bgRotateBox.checked = true
bgRotateBox.dispatch('change')
await tick()
ok(
  '打开自动轮换后多出一个定时任务（间隔取宿主给的 90s）',
  bootB.intervals.length === 2,
  bootB.intervals.length,
)
bootB.intervals[1]()
await tick()
ok(
  '轮换到下一张：图层与缩略图高亮一起走，宿主那边一个字节都没动',
  activeImage().includes('/cyrene/background/b.jpeg') && thumbsB[1].attrs['data-on'] === '1' &&
    !bootB.calls.slice(beforeNext).some((c) => c.method === 'POST' && String(c.body).includes('"current"')),
  activeImage(),
)
const beforeDim = bootB.calls.length
const bgDimRange = managerB.querySelector('[data-role="bg-dim"]')
ok(
  '淡化滑杆开放到 0–100%（步长 5%）',
  bgDimRange.attrs.min === '0' && bgDimRange.attrs.max === '1' && bgDimRange.attrs.step === '0.05',
  bgDimRange.attrs,
)
bgDimRange.value = '0.35'
bgDimRange.dispatch('input')
ok(
  '拖浓度滑杆时就地预览（只改 CSS 变量，还没落盘）',
  docB.body.style.getPropertyValue('--cyre-bg-dim') === '0.35' && bgPostOf(beforeDim) === undefined &&
    managerB.querySelector('[data-role="bg-dim-label"]').textContent === '35%',
  docB.body.style.getPropertyValue('--cyre-bg-dim'),
)
bgDimRange.dispatch('change')
await tick()
const dimPatch = bgPatchOf(beforeDim)
ok(
  '松手才把浓度交给宿主',
  dimPatch?.background?.dim === 0.35 && Object.keys(dimPatch.background).length === 1,
  dimPatch,
)

// 外观：管理器里一个「浅色 / 深色」总开关（原来每张卡片上的「深色」绑图按钮已经取消）
const appearanceLightB = managerB.querySelector('[data-role="bg-appearance-light"]')
const appearanceDarkB = managerB.querySelector('[data-role="bg-appearance-dark"]')
const appearanceSystemB = managerB.querySelector('[data-role="bg-appearance-system"]')
ok(
  '外观是浅色 / 深色 / 跟随系统三档，进来时「浅色」亮着（body 上没有深色标记）',
  appearanceLightB !== null && appearanceDarkB !== null && appearanceSystemB !== null &&
    appearanceLightB.attrs['data-on'] === '1' &&
    appearanceDarkB.attrs['data-on'] === undefined &&
    appearanceSystemB.attrs['data-on'] === undefined &&
    bootB.doc.body.hasAttribute('data-ds-dark-theme') === false,
  [appearanceLightB?.attrs['data-on'], appearanceDarkB?.attrs['data-on'], appearanceSystemB?.attrs['data-on']],
)
const beforeAppearance = bootB.calls.length
managerB.dispatch('click', { target: appearanceDarkB })
await tick()
ok(
  '点「深色」调宿主主题服务的 setTheme("dark")，插件自己的状态一个字节都不写',
  boxB.themeCalls.length === 1 && boxB.themeCalls[0] === 'dark' && bgPostOf(beforeAppearance) === undefined,
  boxB.themeCalls,
)
ok(
  '切完高亮跟着换，管理器底下写着现在是哪种外观',
  appearanceDarkB.attrs['data-on'] === '1' && appearanceLightB.attrs['data-on'] === undefined &&
    /深色/.test(managerB.querySelector('[data-role="appearance-note"]').textContent) &&
    /外观/.test(managerB.querySelector('[data-role="dark-note"]').textContent),
  [managerB.querySelector('[data-role="appearance-note"]').textContent, managerB.querySelector('[data-role="dark-note"]').textContent],
)
managerB.dispatch('click', { target: appearanceLightB })
await tick()
ok(
  '点「浅色」切回去（setTheme("light")），同样不写插件状态',
  boxB.themeCalls.length === 2 && boxB.themeCalls[1] === 'light' &&
    appearanceLightB.attrs['data-on'] === '1' && bgPostOf(beforeAppearance) === undefined,
  boxB.themeCalls,
)
// 第三档：跟随系统。宿主自己盯着系统的深色开关，插件只负责把偏好交出去。
managerB.dispatch('click', { target: appearanceSystemB })
await tick()
ok(
  '点「跟随系统」→ setTheme("system")，高亮落在第三档，底下写着现在解析成什么',
  boxB.themeCalls.length === 3 && boxB.themeCalls[2] === 'system' &&
    appearanceSystemB.attrs['data-on'] === '1' &&
    appearanceLightB.attrs['data-on'] === undefined &&
    appearanceDarkB.attrs['data-on'] === undefined &&
    /跟随系统/.test(managerB.querySelector('[data-role="appearance-note"]').textContent) &&
    bgPostOf(beforeAppearance) === undefined,
  [boxB.themeCalls, managerB.querySelector('[data-role="appearance-note"]').textContent],
)
ok(
  '跟随系统这一档也照旧不写插件的状态文件',
  boxB.themeCalls.length === 3 && bgPostOf(beforeAppearance) === undefined,
  boxB.themeCalls,
)
managerB.dispatch('click', { target: appearanceLightB })
await tick()
// 深浅色和背景图**不绑定**：切外观不换图，选图也不动外观。
const beforeSwitchImage = activeImage()
bootB.doc.body.setAttribute('data-ds-dark-theme', '')
const rotB = managerB.querySelector('[data-role="bg-rotate"]')
rotB.checked = true
rotB.dispatch('change')
await tick()
ok(
  '切到深色不换背景：重铺时用的还是用户选的那张起点',
  activeImage().includes('/cyrene/background/b.jpeg') && beforeSwitchImage === activeImage(),
  activeImage(),
)
bootB.doc.body.removeAttribute('data-ds-dark-theme')
rotB.checked = false
rotB.dispatch('change')
await tick()

// 上传：走 /cyrene/backgrounds（12MB 上限那条路），带 rev / 文件名 / 标签 / data URL
const fileB = managerB.querySelector('[data-role="bg-file"]')
const labelB = managerB.querySelector('[data-role="bg-label"]')
const uploadB = managerB.querySelector('[data-role="bg-upload"]')
fileB.files = [{ name: 'mine.png', type: 'image/png' }]
labelB.value = '夜色'
const beforeUp = bootB.calls.length
uploadB.dispatch('click')
await slow(30)
const upCall = bootB.calls.slice(beforeUp).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/backgrounds'))
const upBody = upCall ? JSON.parse(upCall.body) : null
ok(
  '上传走 /cyrene/backgrounds，带 rev / 文件名 / 标签 / data URL',
  Number.isInteger(upBody?.rev) && upBody.rev >= 7 && upBody?.name === 'mine.png' && upBody?.label === '夜色' &&
    String(upBody?.data).startsWith('data:image/png;base64,'),
  upBody === null ? null : { ...upBody, data: String(upBody.data).slice(0, 28) + '…' },
)

const beforeDelB = bootB.calls.length
managerB.dispatch('click', { target: delBtnB[0] })
await slow(20)
const delCallB = bootB.calls.slice(beforeDelB).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/backgrounds/remove'))
const delBodyB = delCallB ? JSON.parse(delCallB.body) : null
ok(
  '删除走 /cyrene/backgrounds/remove，带 id 与 rev',
  delBodyB?.id === 'b.jpeg' && Number.isInteger(delBodyB?.rev) && delBodyB.rev >= 8,
  delBodyB,
)

// 小屏：欢迎页那一行要能收住（否则 360px 宽的手机上文字会顶出屏幕）
ok(
  '窄屏媒体查询收住了欢迎页：缩字号 / 允许换行 / 形象收小',
  /@media \(max-width: 620px\)\{[\s\S]*?\.cyre-hero-title\{[^}]*font-size:clamp/.test(cssText) &&
    /@media \(max-width: 620px\)\{[\s\S]*?\.cyre-hero\{[^}]*flex-wrap:wrap/.test(cssText) &&
    /@media \(max-width: 620px\)\{[\s\S]*?\.cyre-overlay\{[^}]*max-width:calc\(100vw/.test(cssText),
)
ok(
  '背景地址优先用宿主给的 url（手机外壳的 baseURI 和桌面不一样）',
  thumbsB[1].descendants().some((el) => el.tagName === 'img' && String(el.src).includes('?v=2')),
  thumbsB.map((el) => el.descendants().find((n) => n.tagName === 'img')?.src),
)

{
// ── 6e. 长期记忆：入口一行 → 单独一页；增 / 删 / 开关都走记忆自己的 rev
let memLive = { error: null, enabled: true, rev: 0, count: 0, limit: 300, path: 'C:/x/cyrene-memory.json', items: [] }
let memRevN = 0
const memNextRev = () => { memRevN += 1; return memRevN }
const bootMem = await bootstrap((call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  if (call.url.endsWith('/cyrene/memory/reveal')) {
    return { status: 200, payload: { ok: true, value: { opened: true, path: memLive.path } } }
  }
  if (call.url.includes('/cyrene/memory')) {
    if (call.method === 'GET') return { status: 200, payload: { ok: true, value: memLive } }
    const body = JSON.parse(call.body)
    if (body.action === 'add') {
      const item = { id: 'mem-a1b2c', text: String(body.text).trim(), tags: ['偏好'], created: '2026-10-29T12:00:00.000Z' }
      memLive = { ...memLive, rev: memNextRev(), items: [item, ...memLive.items], count: memLive.items.length + 1 }
    } else if (body.action === 'remove') {
      const items = memLive.items.filter((it) => it.id !== body.id)
      memLive = { ...memLive, rev: memNextRev(), items, count: items.length }
    } else if (body.action === 'toggle') {
      memLive = { ...memLive, rev: memNextRev(), enabled: body.enabled === true }
    } else if (body.action === 'clear') {
      memLive = { ...memLive, rev: memNextRev(), items: [], count: 0 }
    }
    return { status: 200, payload: { ok: true, value: memLive } }
  }
  if (isBackgrounds(call)) return { status: 200, payload: BACKGROUNDS }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS }
  if (call.method === 'POST') return { status: 200, payload: REV7 }
  return { status: 200, payload: REV7 }
}, { autoHost: true })
const boxMem = makeCtx()
bootMem.exports.apply(boxMem.ctx)
await tick()
boxMem.registered.find((r) => r.registration.id === 'cyrene-theme').component()
const editorMem = bootMem.refs[0].current.children[0]
ok(
  '设置页里有「长期记忆」入口，只有一句概况 + 按钮，没有把列表塞进去',
  editorMem.querySelector('[data-role="open-memory"]') !== null &&
    editorMem.querySelector('[data-role="memory-note"]') !== null &&
    editorMem.querySelector('[data-role="mem-list"]') === null,
  editorMem.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)
ok(
  '还没记过的时候概况写清楚（而不是空白）',
  /还没记过/.test(editorMem.querySelector('[data-role="memory-note"]').textContent),
  editorMem.querySelector('[data-role="memory-note"]').textContent,
)
editorMem.dispatch('click', { target: editorMem.querySelector('[data-role="open-memory"]') })
await tick()
const pageMem = bootMem.doc.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok('点入口打开记忆管理器页（挂在 body 上的覆盖层）', pageMem !== undefined && pageMem !== null, bootMem.doc.body.descendants().map((el) => el.className))
const managerMem = pageMem.descendants().find((el) => el.className === 'cyre-manager')
const listMem = managerMem.querySelector('[data-role="mem-list"]')
ok('空状态有说明，不是一个空白框', /还没有记忆/.test(listMem.children[0].textContent), listMem.children[0].textContent)
// 记忆文件那一行：路径 + 「打开文件位置」
const pathMem = managerMem.querySelector('[data-role="mem-path"]')
const revealMem = managerMem.querySelector('[data-role="mem-reveal"]')
ok(
  '记忆文件那一行把路径写在最前面，旁边是「打开文件位置」',
  pathMem !== null && pathMem.textContent === memLive.path && revealMem !== null,
  [pathMem === null ? null : pathMem.textContent, revealMem === null ? null : Object.keys(revealMem.attrs)],
)
const beforeReveal = bootMem.calls.length
revealMem.dispatch('click')
await tick()
const revealCall = bootMem.calls.slice(beforeReveal).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/memory/reveal'))
ok(
  '点「打开文件位置」只发一条 reveal（不回整份快照，清单不会被冲掉）',
  revealCall !== undefined && revealCall.body === '{}',
  revealCall === undefined ? null : revealCall.body,
)
ok(
  '打开之后状态行说明结果，清单原样还在',
  /文件管理器/.test(managerMem.querySelector('[data-role="mstatus"]').textContent) && /还没有记忆/.test(listMem.children[0].textContent),
  managerMem.querySelector('[data-role="mstatus"]').textContent,
)

// 加一条
const memText = managerMem.querySelector('[data-role="mem-text"]')
const memTags = managerMem.querySelector('[data-role="mem-tags"]')
memText.value = '用户偏好深色主题'
memTags.value = '偏好'
const beforeAdd = bootMem.calls.length
managerMem.querySelector('[data-role="mem-add"]').dispatch('click')
await tick()
const addCall = bootMem.calls.slice(beforeAdd).find((c) => c.method === 'POST' && c.url.includes('/cyrene/memory'))
const addBody = addCall === undefined ? {} : JSON.parse(addCall.body)
ok(
  '「记住」发一条 memory POST：带记忆自己的 rev + action=add',
  addBody.action === 'add' && addBody.text === '用户偏好深色主题' && addBody.tags === '偏好' && addBody.rev === 0,
  addBody,
)
const cardsMem = managerMem.querySelector('[data-role="mem-list"]').descendants().filter((el) => el.className === 'cyre-mem-item')
ok('加完列表里出现一张卡片（正文 + 日期/标签 + 删除）', cardsMem.length === 1 && /用户偏好深色主题/.test(cardsMem[0].children[0].textContent) && /2026-10-29/.test(cardsMem[0].children[1].textContent) && cardsMem[0].children.length === 3, cardsMem[0]?.children.map((c) => c.textContent))
ok('加完概况行跟上（设置页那一行也刷新）', /1 条/.test(editorMem.querySelector('[data-role="memory-note"]').textContent), editorMem.querySelector('[data-role="memory-note"]').textContent)

// 搜一下
const memSearch = managerMem.querySelector('[data-role="mem-search"]')
memSearch.value = '深色'
memSearch.dispatch('input')
ok('搜索只过滤列表，不发请求', managerMem.querySelector('[data-role="mem-list"]').descendants().filter((el) => el.className === 'cyre-mem-item').length === 1)
memSearch.value = '不存在的词'
memSearch.dispatch('input')
ok('搜不到时给一句提示', /没有匹配的记忆/.test(listMem.children[0].textContent))
memSearch.value = ''
memSearch.dispatch('input')

// 删掉
const beforeDel = bootMem.calls.length
managerMem.querySelector('[data-role="mem-del"]').dispatch('click')
await tick()
const delCall = bootMem.calls.slice(beforeDel).find((c) => c.method === 'POST' && c.url.includes('/cyrene/memory'))
const delBody = delCall === undefined ? {} : JSON.parse(delCall.body)
ok('删除发的是 action=remove + id', delBody.action === 'remove' && delBody.id === 'mem-a1b2c', delBody)
ok('删完列表回到空状态', /还没有记忆/.test(listMem.children[0].textContent))

// 开关
const memEnabled = managerMem.querySelector('[data-role="mem-enabled"]')
const beforeToggle = bootMem.calls.length
memEnabled.checked = false
memEnabled.dispatch('change')
await tick()
const toggleCall = bootMem.calls.slice(beforeToggle).find((c) => c.method === 'POST' && c.url.includes('/cyrene/memory'))
const toggleBody = toggleCall === undefined ? {} : JSON.parse(toggleCall.body)
ok('关掉记忆发的是 action=toggle + enabled=false（不删数据）', toggleBody.action === 'toggle' && toggleBody.enabled === false, toggleBody)
ok('关掉后设置页概况写「已关闭」', /已关闭/.test(editorMem.querySelector('[data-role="memory-note"]').textContent), editorMem.querySelector('[data-role="memory-note"]').textContent)

// Esc 关闭
pageMem.descendants().find((el) => el.className === 'cyre-close').dispatch('click')
ok('点 ✕ 关掉记忆管理器页（覆盖层从 body 上摘掉）', bootMem.doc.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide') === undefined)

}

// ── 6f. 世界书：入口一行 → 单独一页；索引只给元信息，正文由模型用工具取
{
let wbLive = {
  error: null,
  count: 2,
  version: '3.7',
  fetchedAt: '2026-10-31T00:00:00.000Z',
  source: 'https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index?lang=zh-cn',
  path: 'C:/x/cyrene-worldbook.json',
  characters: [{ name: '昔涟', total: 1 }, { name: '白厄', total: 1 }],
  categories: [{ key: 'archive', label: '档案', total: 1 }, { key: 'relation', label: '关系', total: 1 }],
  entries: [
    { id: 'wiki-test-1', name: '昔涟 · 档案', character: '昔涟', category: 'archive', keys: ['昔涟', '哀丽秘榭'], size: 120 },
    { id: 'wiki-test-2', name: '昔涟 × 白厄', character: '白厄', category: 'relation', keys: ['白厄'], size: 140 },
  ],
}
let wbRevealMode = 'ok'
const bootWb = await bootstrap((call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  if (call.url.endsWith('/cyrene/worldbook/reveal')) {
    if (wbRevealMode === 'route-miss') {
      // 宿主半还是旧版时的真实回包：兜底 404 也用 `not-found` 这个码。
      return {
        status: 404,
        payload: { ok: false, error: { code: 'not-found', message: '没有这个路由：POST /worldbook/reveal' } },
      }
    }
    if (wbRevealMode === 'empty') {
      return { status: 409, payload: { ok: false, error: { code: 'no-worldbook', message: '还没有世界书文件，先抓取一次' } } }
    }
    return { status: 200, payload: { ok: true, value: { opened: true, path: 'C:/x/cyrene-worldbook.json' } } }
  }
  if (call.url.includes('/cyrene/worldbook')) {
    if (call.method === 'GET') return { status: 200, payload: { ok: true, value: wbLive } }
    const body = JSON.parse(call.body)
    if (body.action === 'fetch') {
      wbLive = {
        ...wbLive,
        count: 3,
        version: '3.8',
        fetchedAt: '2026-11-01T00:00:00.000Z',
        entries: [...wbLive.entries, { id: 'wiki-test-3', name: '白厄 · 档案', character: '白厄', category: 'archive', keys: ['白厄'], size: 260 }],
        characters: [{ name: '昔涟', total: 1 }, { name: '白厄', total: 2 }],
      }
    } else if (body.action === 'clear') {
      wbLive = { ...wbLive, count: 0, version: '', fetchedAt: '', characters: [], categories: [], entries: [] }
    }
    return { status: 200, payload: { ok: true, value: wbLive } }
  }
  if (isBackgrounds(call)) return { status: 200, payload: BACKGROUNDS }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS }
  return { status: 200, payload: REV7 }
}, { autoHost: true })
const boxWb = makeCtx()
bootWb.exports.apply(boxWb.ctx)
await tick()
boxWb.registered.find((r) => r.registration.id === 'cyrene-theme').component()
const editorWb = bootWb.refs[0].current.children[0]
await tick()
ok(
  '设置页里有「世界书」入口，只有一句概况 + 按钮',
  editorWb.querySelector('[data-role="open-worldbook"]') !== null &&
    editorWb.querySelector('[data-role="worldbook-note"]') !== null &&
    editorWb.querySelector('[data-role="wb-list"]') === null,
  editorWb.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)
ok(
  '概况写清楚库里有多少条 + 哪个版本',
  /2 条/.test(editorWb.querySelector('[data-role="worldbook-note"]').textContent) &&
    /3\.7/.test(editorWb.querySelector('[data-role="worldbook-note"]').textContent),
  editorWb.querySelector('[data-role="worldbook-note"]').textContent,
)
editorWb.dispatch('click', { target: editorWb.querySelector('[data-role="open-worldbook"]') })
await tick()
const pageWb = bootWb.doc.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok('点入口打开世界书管理器页（挂在 body 上的覆盖层）', pageWb !== undefined && pageWb !== null, bootWb.doc.body.descendants().map((el) => el.className))
const managerWb = pageWb.descendants().find((el) => el.className === 'cyre-manager')
const metaWb = managerWb.querySelector('[data-role="wmeta"]')
ok(
  '元信息那行写了版本、条数、角色数、抓取日期',
  /3\.7/.test(metaWb.textContent) && /2 条/.test(metaWb.textContent) && /2 位角色/.test(metaWb.textContent) && /2026-10-31/.test(metaWb.textContent),
  metaWb.textContent,
)
ok(
  '抓到的条目不铺在管理器里（列表、搜索框、原文预览都不在了）——只留元信息与按钮',
  managerWb.querySelector('[data-role="wb-list"]') === null &&
    managerWb.querySelector('[data-role="wb-search"]') === null &&
    managerWb.querySelector('[data-role="wb-rawbox"]') === null &&
    managerWb.querySelector('[data-role="wb-raw"]') === null &&
    managerWb.descendants().filter((el) => el.className === 'cyre-mem-item').length === 0,
  managerWb.descendants().map((el) => el.attrs['data-role']).filter(Boolean),
)
ok(
  '元信息里也给出文件路径（想看原文的人自己按路径去找）',
  /cyrene-worldbook\.json/.test(metaWb.textContent),
  metaWb.textContent,
)

// 抓取更新
const beforeFetch = bootWb.calls.length
managerWb.querySelector('[data-role="wb-fetch"]').dispatch('click')
await tick()
const fetchCall = bootWb.calls.slice(beforeFetch).find((c) => c.method === 'POST' && c.url.includes('/cyrene/worldbook'))
ok(
  '「抓取更新」发的是 action=fetch（写盘在宿主那一侧，客户端只发一个动作）',
  fetchCall !== undefined && JSON.parse(fetchCall.body).action === 'fetch',
  fetchCall === undefined ? null : fetchCall.body,
)
ok(
  '抓完之后元信息与概况都跟上（3.8 / 3 条）',
  /3\.8/.test(metaWb.textContent) && /3 条/.test(metaWb.textContent) &&
    /3 条/.test(editorWb.querySelector('[data-role="worldbook-note"]').textContent),
  [metaWb.textContent, editorWb.querySelector('[data-role="worldbook-note"]').textContent],
)
ok('状态行说明这次抓取的结果', /抓/.test(managerWb.querySelector('[data-role="wstatus"]').textContent), managerWb.querySelector('[data-role="wstatus"]').textContent)

// 「打开文件位置」：交给宿主把系统文件管理器叫出来（浏览器做不到这件事）。
const wbStatus = managerWb.querySelector('[data-role="wstatus"]')
const beforeReveal = bootWb.calls.length
managerWb.querySelector('[data-role="wb-reveal"]').dispatch('click')
await tick()
const revealCall = bootWb.calls.slice(beforeReveal).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/worldbook/reveal'))
ok(
  '「打开文件位置」发一条 POST 给宿主（不是 target=_blank，也不是自己拼地址）',
  revealCall !== undefined, revealCall === undefined ? null : revealCall.url,
)
ok('打开成功就说一声', /已在文件管理器里打开/.test(wbStatus.textContent), wbStatus.textContent)

// 宿主半还是旧版（缺这条路由）：别说成「还没抓取」——那会让人白折腾一遍。
wbRevealMode = 'route-miss'
managerWb.querySelector('[data-role="wb-reveal"]').dispatch('click')
await tick()
ok(
  '缺路由时说清是宿主半旧版（不是「还没有文件」）',
  /重载插件行/.test(wbStatus.textContent) && !/先抓取一次/.test(wbStatus.textContent),
  wbStatus.textContent,
)
// 真的还没抓过：才提示去抓取。
wbRevealMode = 'empty'
managerWb.querySelector('[data-role="wb-reveal"]').dispatch('click')
await tick()
ok('真没文件时才提示「先抓取一次」', /先抓取一次/.test(wbStatus.textContent), wbStatus.textContent)
wbRevealMode = 'ok'

// 清空（confirm 在桩里恒为 true）
const beforeClear = bootWb.calls.length
managerWb.querySelector('[data-role="wb-clear"]').dispatch('click')
await tick()
const clearCall = bootWb.calls.slice(beforeClear).find((c) => c.method === 'POST' && c.url.includes('/cyrene/worldbook'))
ok(
  '「清空」发的是 action=clear',
  clearCall !== undefined && JSON.parse(clearCall.body).action === 'clear',
  clearCall === undefined ? null : clearCall.body,
)
ok('清空后元信息回到空状态说明', /还没有资料库/.test(metaWb.textContent), metaWb.textContent)

pageWb.descendants().find((el) => el.className === 'cyre-close').dispatch('click')
ok('点 ✕ 关掉世界书管理器页（覆盖层从 body 上摘掉）', bootWb.doc.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide') === undefined)

// 侧边栏那颗「✦ 昔涟」弹出的面板用的是同一份编辑器——世界书入口也得在里面。
const navEntry = boxWb.registered.find((r) => r.registration.id === 'cyrene-persona')
const navElement = navEntry.component({ wide: true })
navElement.props.onClick()
await tick()
const sidePanel = bootWb.doc.body.descendants().find(
  (el) => el.className === 'cyre-overlay' &&
    el.descendants().some((node) => node.attrs['data-role'] === 'open-worldbook'),
)
ok('侧边栏面板里也有「✦ 世界书」入口（和设置页是同一份编辑器）', sidePanel !== undefined)
ok(
  '面板里的世界书概况不是空壳（条数 / 还没建库）',
  sidePanel !== undefined && /条|还没/.test(sidePanel.querySelector('[data-role="worldbook-note"]').textContent),
  sidePanel?.querySelector('[data-role="worldbook-note"]')?.textContent,
)
sidePanel.descendants().find((el) => el.className === 'cyre-close').dispatch('click')
ok('关掉面板（覆盖层摘掉，不影响后面的断言）', bootWb.doc.body.descendants().find((el) => el.className === 'cyre-overlay') === undefined)
}

// ── 7. 取证扫描的挑选逻辑：谁带 backdrop-filter、谁是大面积半透明
// 背景：桌面外壳的页面在受限沙箱里截不了图，皮肤视觉问题只能靠页面自报，
// 所以这条链路（扫描 → 上报）必须真的能跑，且不能把旁路接进状态写入。
const bootR = await bootstrap(RESPONSE)
const docR = bootR.doc
globalThis.window.innerWidth = 1000
globalThis.window.innerHeight = 800
globalThis.window.getComputedStyle = (el) => el.__style ?? {
  backdropFilter: 'none', backgroundColor: 'rgb(255,255,255)',
  position: 'static', visibility: 'visible', zIndex: 'auto', opacity: '1',
}
El.prototype.getBoundingClientRect = function () {
  return this.__rect ?? { left: 0, top: 0, width: 1000, height: 800 }
}
const plain = new El('div')
plain.__style = { backdropFilter: 'none', backgroundColor: 'rgb(255,255,255)', position: 'static', visibility: 'visible', zIndex: 'auto', opacity: '1' }
const blurry = new El('div')
blurry.setAttribute('data-shell-overlay', '')
blurry.__style = { backdropFilter: 'blur(16px) saturate(160%)', backgroundColor: 'rgba(0,0,0,0)', position: 'absolute', visibility: 'visible', zIndex: '20', opacity: '1' }
blurry.__rect = { left: 0, top: 0, width: 1000, height: 800 }
const milky = new El('div')
milky.setAttribute('data-sidebar-right-panel', 'push')
milky.__style = { backdropFilter: 'none', backgroundColor: 'rgba(255,255,255,0.42)', position: 'absolute', visibility: 'visible', zIndex: 'auto', opacity: '1' }
milky.__rect = { left: 600, top: 0, width: 400, height: 800 }
const small = new El('div')
small.__style = { backdropFilter: 'none', backgroundColor: 'rgba(255,255,255,0.2)', position: 'static', visibility: 'visible', zIndex: 'auto', opacity: '1' }
small.__rect = { left: 0, top: 0, width: 20, height: 20 }
docR.body.append(blurry, milky, plain, small)

const boxR = makeCtx()
bootR.exports.apply(boxR.ctx)
await tick()
await tick()
const reportCallR = bootR.calls.find((c) => c.url.endsWith('/cyrene/report'))
const reportR = reportCallR ? JSON.parse(reportCallR.body) : null
const labels = (reportR?.entries ?? []).map((entry) => entry.el)
ok('取证报出了带 backdrop-filter 的元素', reportR?.blurCount === 1 && labels.some((l) => l.includes('data-shell-overlay')), reportR?.entries)
ok('取证报出了大面积半透明的元素', labels.some((l) => l.includes('data-sidebar-right-panel')), labels)
ok('取证不报干净元素与小面积半透明', !labels.some((l) => l.includes('class=')) && (reportR?.entries ?? []).length === 2, labels)
ok('取证带上视口尺寸供换算占比', reportR?.viewport?.[0] === 1000 && reportR?.viewport?.[1] === 800, reportR?.viewport)
ok('取证按面积从大到小排', (reportR?.entries?.[0]?.share ?? 0) >= (reportR?.entries?.[1]?.share ?? 0), reportR?.entries?.map((e) => e.share))

// ---- 8. 取证通道的自我修复：宿主半还是旧构建（404）时下一拍要重试 ----
const stateOnly = { status: 200, payload: { ok: true, value: { persona: '底稿', enabled: true, theme: true, rev: 1 } } }
const reportCalls = (boot) => boot.calls.filter((c) => c.url.endsWith('/cyrene/report')).length

const boot404 = await bootstrap((call) => (
  call.url.endsWith('/cyrene/report')
    ? { status: 404, payload: { ok: false, error: { code: 'not-found', message: 'no route' } } }
    : stateOnly
), { captureIntervals: true })
boot404.exports.apply(makeCtx().ctx)
await tick()
await tick()
ok('宿主半没有 /cyrene/report 时开机照样上报一次', reportCalls(boot404) === 1, boot404.calls.map((c) => c.url))
ok('扫描器登记了一个定时任务', boot404.intervals.length === 1, boot404.intervals.length)
boot404.intervals[0]()
await tick()
await tick()
ok('上报被 404 拒收后下一拍重试（插件行重载后无需再刷新页面）', reportCalls(boot404) === 2, reportCalls(boot404))
boot404.intervals[0]()
await tick()
await tick()
ok('一直失败就一直重试，不会把通道卡死在第一次', reportCalls(boot404) === 3, reportCalls(boot404))

const bootOk = await bootstrap((call) => (
  call.url.endsWith('/cyrene/report')
    ? { status: 200, payload: { ok: true, value: { at: 'now' } } }
    : stateOnly
), { captureIntervals: true })
bootOk.exports.apply(makeCtx().ctx)
await tick()
await tick()
ok('上报成功后开机那份仍然只发一次', reportCalls(bootOk) === 1, reportCalls(bootOk))
bootOk.intervals[0]()
await tick()
await tick()
ok('内容没变就不重复上报（省掉没意义的流量）', reportCalls(bootOk) === 1, reportCalls(bootOk))

// ── 9. 对话界面微调：新会话欢迎页形象 + 输入框占位提示
const braceDelta = (cssText.match(/\{/g) ?? []).length - (cssText.match(/\}/g) ?? []).length
ok('样式表大括号收支平衡', braceDelta === 0, braceDelta)
ok('样式表里没有插值残留（模板串已经求值过）', !cssText.includes('${'))
ok(
  '欢迎页有我们的形象（圆形头像）与艺术字欢迎语',
  /\.cyre-hero-mark\{/.test(cssText) && /\.cyre-hero-title-text\{/.test(cssText),
)
ok(
  '有我们的形象时藏掉内置那句「探索未至之境」（两种构建的落点都覆盖）',
  /\[class\*="_headline"\]:has\(\.cyre-hero\) \[class\*="_headlineText"\],/.test(cssText) &&
    /\[class\*="_headline"\]:has\(\.cyre-hero\) \[class\*="_titleGroup"\] > span:not\(\[class\]\)\{display:none\}/.test(cssText),
  'CSS 里给内置文案的隐藏规则',
)
ok('把欢迎那行收成单列（否则形象会被塞进 34px 那格）', /\[class\*="_headline"\]:has\(\.cyre-hero\)\{grid-template-columns:auto\}/.test(cssText))
ok(
  '官方「预览版」徽标一起收掉，这一行只留头像 + 艺术字',
  /\[class\*="_headline"\]:has\(\.cyre-hero\) \[class\*="_previewBadge"\]\{display:none\}/.test(cssText),
)
ok(
  '艺术字 = 方正舒体打头 + 渐变裁字 + 描边阴影',
  /font-family:"FZShuTi","方正舒体"/.test(cssText) &&
    /-webkit-background-clip:text/.test(cssText) &&
    /-webkit-text-stroke/.test(cssText),
)
ok(
  '艺术字的字栈收在无衬线，不会掉回宋体那一类衬线字',
  /"Microsoft YaHei UI","微软雅黑",system-ui,sans-serif;/.test(cssText) &&
    !/STXingkai|华文行楷|"STKaiti"|"楷体"|,serif;/.test(cssText),
)
ok(
  '头像是一整张贴纸：不画边框/底盘/圆角/遮罩，直接用素材自己的 alpha',
  /\.cyre-hero-mark\{[^}]*height:72px/.test(cssText) &&
    /\.cyre-hero-mark\{[^}]*object-fit:contain/.test(cssText) &&
    !/\.cyre-hero-mark\{[^}]*border:/.test(cssText) &&
    !/\.cyre-hero-mark\{[^}]*border-radius:/.test(cssText) &&
    !/\.cyre-hero-mark\{[^}]*box-shadow:/.test(cssText) &&
    !/\.cyre-hero-mark\{[^}]*background:/.test(cssText) &&
    !/\.cyre-hero-mark\{[^}]*mask-image/.test(cssText),
)
ok(
  '艺术字是粉 → 白渐变，并靠一圈粉边把白尾托住',
  /background:linear-gradient\(168deg,#ff7cbb 0%,#ffa9d0 34%,#ffd8ea 68%,#fff7fc 100%\)/.test(cssText) &&
    /-webkit-text-stroke:1\.1px #e8699f/.test(cssText),
)
ok(
  '渐变裁字不被支持时有纯色兜底',
  /@supports not \(background-clip:text\)/.test(cssText),
)
ok(
  '音符自己轻轻晃，且给 prefers-reduced-motion 让路',
  /@keyframes cyre-note-float/.test(cssText) && /prefers-reduced-motion: reduce/.test(cssText) && /\.cyre-hero-note\{animation:none\}/.test(cssText),
)
ok(
  '占位提示：原字染透明 + 自己的 ::after 写昔涟的招呼语，并且钉回容器左上角（否则会被透明原字顶到右边）',
  /\[data-composer-placeholder\]\{color:transparent\}/.test(cssText) &&
    cssText.includes('content:"有问题？有任务？来找昔涟♪"') &&
    /\+ \[data-composer-placeholder\]::after\{[\s\S]*?position:absolute;[\s\S]*?left:0;[\s\S]*?text-align:left;/.test(cssText),
  'CSS 里的占位提示规则',
)
ok(
  '占位提示明写无衬线字栈，中文不会掉成宋体',
  /\+ \[data-composer-placeholder\]::after\{[\s\S]*?"微软雅黑","PingFang SC"[\s\S]*?sans-serif;/.test(cssText),
)
ok(
  '占位提示只在「默认/欢迎页默认」生效，靠兄弟节点的 data-placeholder 前缀做闸门',
  /\[data-composer-input\]\[data-placeholder\^="发消息或创建任务"\] \+ \[data-composer-placeholder\]/.test(cssText) &&
    /\[data-composer-input\]\[data-placeholder\^="描述你想要构建的内容"\] \+ \[data-composer-placeholder\]/.test(cssText) &&
    cssText.includes('+ [data-composer-placeholder]{color:transparent}') &&
    !cssText.includes('[data-dsh-cyrene] [data-composer-placeholder]{color:transparent}'),
  '闸门规则：有闸门的写法在、无闸门的写法不在',
)
ok(
  '状态类提示（会话不可用/父会话离线/排队插话/计划/选择工作区）没有被写进规则里',
  !/会话不可用|父会话已离线|插话发送|选择一个工作区开始/.test(cssText),
)
ok(
  '欢迎页那一行是纯装饰：点不响（pointer-events:none，行与容器两层都写了）、文字选不中（user-select:none）、图拖不动（-webkit-user-drag:none）',
  /\[class\*="_headline"\]:has\(\.cyre-hero\)\{[^}]*pointer-events:none[^}]*user-select:none/.test(cssText) &&
    /\.cyre-hero\{[^}]*pointer-events:none/.test(cssText) &&
    /\.cyre-hero\{[^}]*user-select:none/.test(cssText) &&
    /\.cyre-hero\{[^}]*cursor:default/.test(cssText) &&
    /\.cyre-hero-mark\{[^}]*user-drag:none/.test(cssText),
)

const heroBoot = await bootstrap(RESPONSE)
const heroBox = makeCtx()
heroBoot.exports.apply(heroBox.ctx)
await tick()
const heroReg = heroBox.registered.find((r) => r.registration.name === 'conversation.hero.brand.mark')
const heroEl = heroReg.component()
const heroImg = heroEl.children.find((child) => child && child.type === 'img')
ok(
  '欢迎页组件渲染出形象，src 指向宿主半的 /cyrene/hero（不是 file://）',
  heroEl.props.className === 'cyre-hero' && heroImg !== undefined && /\/cyrene\/hero$/.test(heroImg.props.src) && !/^file:/.test(heroImg.props.src),
  heroImg?.props,
)
const heroTitle = heroEl.children.find((child) => child && child.props?.className === 'cyre-hero-title')
ok(
  '形象带 draggable=false（配合 CSS 的 user-drag，浏览器里拖不出影子）',
  heroImg?.props?.draggable === false,
  heroImg?.props,
)
ok(
  '宿主没给欢迎语时用兜底那句，并把末尾音符拆成单独一个 span',
  heroTitle.children[0].props.className === 'cyre-hero-title-text' &&
    heroTitle.children[0].children[0] === '让昔涟来帮帮你吧' &&
    heroTitle.children[1].props.className === 'cyre-hero-note' &&
    heroTitle.children[1].children[0] === '🎵',
  heroTitle.children.map((c) => (c ? c.children?.[0] : null)),
)

const heroOff = await bootstrap({
  ok: true,
  value: { ...RESPONSE.value, hero: { image: 'meme/没有这张.jpg', title: '昔涟在呢', ready: false, url: null } },
})
const heroOffBox = makeCtx()
heroOff.exports.apply(heroOffBox.ctx)
await tick()
const heroOffEl = heroOffBox.registered.find((r) => r.registration.name === 'conversation.hero.brand.mark').component()
const heroOffTitle = heroOffEl.children.find((child) => child && child.props?.className === 'cyre-hero-title')
ok(
  '宿主说形象读不出来时只渲染欢迎语，不挂一张坏图',
  heroOffEl.children.every((child) => child === null || child.type !== 'img') &&
    heroOffTitle.children[0].children[0] === '昔涟在呢' &&
    !heroOffTitle.children.some((child) => child && child.props?.className === 'cyre-hero-note'),
  heroOffEl.children.map((c) => c && c.type),
)

// ── 6f. 欢迎页管理：形象 / 欢迎语 / 文本自定义 CSS
// 形象候选直接从表情包 + 背景图两份清单来（宿主半给每张图带 path），所以假宿主
// 也照真形状给 path；写操作走 /cyrene/state（改设定）与 POST /cyrene/hero（上传）。
const HERO_STATE = {
  image: 'meme/俏皮眨眼.png',
  title: '让昔涟来帮帮你吧🎵',
  css: '',
  ready: true,
  url: '/cyrene/hero',
  stamp: 'z9-1k',
}
const DEFAULT_HERO_STATE = { image: 'meme/俏皮眨眼.png', title: '让昔涟来帮帮你吧🎵', css: '' }
const HERO_STICKERS = {
  ok: true,
  value: {
    version: 1,
    maxPerTurn: 1,
    enabled: true,
    missing: [],
    items: [
      { id: 'happy', label: '超开心', when: '', type: 'image/png', bytes: 10, url: '/cyrene/sticker/happy', path: 'meme/超开心.png' },
      { id: 'wink', label: '俏皮眨眼', when: '', type: 'image/png', bytes: 10, url: '/cyrene/sticker/wink', path: 'meme/俏皮眨眼.png' },
    ],
  },
}
const HERO_BACKGROUNDS = {
  ok: true,
  value: {
    error: null,
    folder: 'Background',
    items: [{ id: 'a.jpeg', name: 'a.jpeg', type: 'image/jpeg', bytes: 10, url: '/cyrene/background/a.jpeg', path: 'Background/a.jpeg' }],
  },
}
let heroLive = { ...HERO_STATE }
let heroRev = 11
const heroStateValue = () => ({ ...REV7.value, rev: heroRev, hero: { ...heroLive }, defaultHero: DEFAULT_HERO_STATE })
const bootH = await bootstrap((call) => {
  if (call.url.endsWith('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: HERO_STICKERS }
  if (call.url.includes('/cyrene/backgrounds')) return { status: 200, payload: HERO_BACKGROUNDS }
  if (call.url.endsWith('/cyrene/hero') && call.method === 'POST') {
    // 上传形象：宿主半落盘后把 state.hero.image 换成自定义记号，版本戳也跟着变。
    heroRev += 1
    heroLive = { ...heroLive, image: 'hero-custom/hero.png', stamp: 'zz-2k' }
    return { status: 200, payload: { ok: true, value: { state: heroStateValue() } } }
  }
  if (call.method === 'POST') {
    const patch = JSON.parse(call.body)
    heroRev += 1
    heroLive = { ...heroLive, ...(patch.hero ?? null) }
    return { status: 200, payload: { ok: true, value: heroStateValue() } }
  }
  return { status: 200, payload: { ok: true, value: heroStateValue() } }
}, { autoHost: true })
const boxH = makeCtx()
bootH.exports.apply(boxH.ctx)
await tick()
boxH.registered.find((r) => r.registration.id === 'cyrene-theme').component()
await tick()
const editorH = bootH.refs[0].current.children[0]
const docH = bootH.doc
const heroStyleTag = docH.head.children[1]

const nodesH = editorH.descendants()
const indexOfRole = (role) => nodesH.findIndex((el) => el.attrs['data-role'] === role)
ok(
  '设置页在「背景图管理」下面多了一行「欢迎页」入口（概况 + 打开设置）',
  indexOfRole('open-hero') !== -1 &&
    indexOfRole('open-hero') > indexOfRole('open-backgrounds') &&
    editorH.querySelector('[data-role="hero-preview"]') === null &&
    editorH.querySelector('[data-role="hero-grid"]') === null,
  [indexOfRole('open-backgrounds'), indexOfRole('open-hero'), nodesH.map((el) => el.attrs['data-role']).filter(Boolean)],
)
const heroNoteH = editorH.querySelector('[data-role="hero-note"]')
ok(
  '入口概况写的是「欢迎语 + 形象文件名」（有自定义样式时再加一句）',
  /让昔涟来帮帮你吧🎵/.test(heroNoteH.textContent) && /俏皮眨眼\.png/.test(heroNoteH.textContent) && !/自定义样式/.test(heroNoteH.textContent),
  heroNoteH.textContent,
)

// 打开管理器：整页覆盖层挂 body，和表情包 / 背景图同一套壳。
editorH.dispatch('click', { target: editorH.querySelector('[data-role="open-hero"]') })
await tick()
const pageH = docH.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
ok(
  '点入口打开欢迎页管理器（挂在 body 上的覆盖层）',
  pageH !== undefined && pageH !== null && pageH.attrs['aria-label'] === '昔涟 · 欢迎页',
  docH.body.descendants().map((el) => el.className),
)
const managerH = pageH.descendants().find((el) => el.className === 'cyre-manager')
const cardsH = managerH.descendants().filter((el) => el.attrs['data-role'] === 'hero-pick')
ok(
  '形象候选 = 表情包贴纸 + 背景图照片（各自带 path 与「贴纸 / 照片」标签）',
  cardsH.length === 3 &&
    cardsH[0].attrs['data-path'] === 'meme/超开心.png' &&
    cardsH[2].attrs['data-path'] === 'Background/a.jpeg' &&
    cardsH[2].descendants().some((el) => el.tagName === 'em' && el.textContent === '照片') &&
    cardsH[0].descendants().some((el) => el.tagName === 'em' && el.textContent === '贴纸'),
  cardsH.map((el) => [el.attrs['data-path'], el.title]),
)
ok(
  '当前形象那张是亮着的（其余不亮）',
  cardsH[1].attrs['data-on'] === '1' && cardsH[0].attrs['data-on'] === undefined && cardsH[2].attrs['data-on'] === undefined,
  cardsH.map((el) => [el.attrs['data-path'], el.attrs['data-on']]),
)
const managerHImg = managerH.querySelector('[data-role="preview-mark"]')
ok(
  '预览里的形象地址带着版本戳（换图后 <img> 不会端缓存里的旧图）',
  String(managerHImg.src).endsWith('/cyrene/hero?v=z9-1k'),
  managerHImg?.src,
)

const heroPostOf = (from) => bootH.calls.slice(from).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/state'))
const heroPatchOf = (from) => {
  const call = heroPostOf(from)
  return call === undefined ? null : JSON.parse(call.body)
}

const beforePickH = bootH.calls.length
managerH.dispatch('click', { target: cardsH[0] })
await tick()
const pickPatchH = heroPatchOf(beforePickH)
ok(
  '点一张卡片只发 hero.image 一个键（带 rev，不回写文案 / 其它设定）',
  pickPatchH?.rev === 11 && pickPatchH?.hero?.image === 'meme/超开心.png' &&
    Object.keys(pickPatchH.hero).length === 1 && !('persona' in pickPatchH) && !('theme' in pickPatchH) && !('background' in pickPatchH),
  pickPatchH,
)
ok(
  '换完形象，高亮跟着走（预览图仍走 /cyrene/hero 的字节路由）',
  cardsH[0].attrs['data-on'] === '1' && cardsH[1].attrs['data-on'] === undefined &&
    /\/cyrene\/hero/.test(String(managerHImg.src)),
  [cardsH.map((el) => el.attrs['data-on']), managerHImg?.src],
)

// 文本 CSS：边写边预览，写进那张独立 <style>；只写声明时自动套到标题文字上。
const cssInputH = managerH.querySelector('[data-role="hero-css"]')
ok(
  'CSS 文本框预填的就是"现在生效的那套"（不是空白），用户改哪行改哪行',
  cssInputH.value.startsWith('background:linear-gradient(168deg') &&
    cssInputH.value.includes('-webkit-text-stroke:1.1px #e8699f') &&
    cssInputH.value.split('\n').length >= 5,
  cssInputH.value.slice(0, 70),
)
cssInputH.value = 'font-size:40px; letter-spacing:2px;'
cssInputH.dispatch('input')
ok(
  '只写声明时，自动包成 .cyre-hero-title-text{…} 落到欢迎页那张 style 上（立刻看得见效果）',
  heroStyleTag.textContent === '.cyre-hero-title-text{font-size:40px; letter-spacing:2px;}',
  heroStyleTag.textContent,
)
cssInputH.value = '.cyre-hero-title-text{color:#123456}'
cssInputH.dispatch('input')
ok(
  '写了 { } 的当成整条规则原样追加（高级用法，作用域自负）',
  heroStyleTag.textContent === '.cyre-hero-title-text{color:#123456}',
  heroStyleTag.textContent,
)

// 没保存就关掉：预览时临时写进去的 CSS 要还原成状态里那份（这里本来是空的）。
const closeH = pageH.descendants().find((el) => el.tagName === 'button' && el.attrs['aria-label'] === '关闭')
closeH.dispatch('click')
ok(
  '点 ✕ 关掉管理器页，未保存的 CSS 预览被还原（覆盖层也从 body 上摘掉）',
  docH.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide') === undefined &&
    heroStyleTag.textContent === '',
  heroStyleTag.textContent,
)

// 再来一次：改文案 + 存 CSS
editorH.dispatch('click', { target: editorH.querySelector('[data-role="open-hero"]') })
await tick()
const pageH2 = docH.body.descendants().find((el) => el.className === 'cyre-overlay cyre-overlay--wide')
const managerH2 = pageH2.descendants().find((el) => el.className === 'cyre-manager')
const cardsH2 = managerH2.descendants().filter((el) => el.attrs['data-role'] === 'hero-pick')
const titleInputH = managerH2.querySelector('[data-role="hero-title"]')
const cssInputH2 = managerH2.querySelector('[data-role="hero-css"]')
titleInputH.value = '  来一起写点东西吧♪  '
cssInputH2.value = '  font-size:44px;  '
const beforeSaveH = bootH.calls.length
managerH2.dispatch('click', { target: managerH2.querySelector('[data-role="hero-save"]') })
await tick()
const savePatchH = heroPatchOf(beforeSaveH)
ok(
  '点保存把文案**原样**发出去（不 trim），CSS 去掉两端空白，仍然只带 hero 这一组',
  savePatchH?.hero?.title === '  来一起写点东西吧♪  ' && savePatchH?.hero?.css === 'font-size:44px;' &&
    Object.keys(savePatchH.hero).length === 2 && !('persona' in savePatchH),
  savePatchH,
)
ok(
  '存完那张 style 就是新 CSS，预览里的文案带着首尾空格（音符仍单独一个 span）',
  heroStyleTag.textContent === '.cyre-hero-title-text{font-size:44px;}' &&
    managerH2.querySelector('[data-role="preview-text"]').textContent === '  来一起写点东西吧  ' &&
    managerH2.querySelector('[data-role="preview-note"]').textContent === '♪',
  [heroStyleTag.textContent, managerH2.querySelector('[data-role="preview-text"]').textContent],
)

// 上传自己的图：走 POST /cyrene/hero，回来之后形象路径与版本戳都换新。
const fileH = managerH2.querySelector('[data-role="hero-file"]')
fileH.files = [{ name: 'mine.png' }]
const beforeUploadH = bootH.calls.length
managerH2.querySelector('[data-role="hero-upload"]').dispatch('click', {
  target: managerH2.querySelector('[data-role="hero-upload"]'),
})
await tick()
await tick()
const uploadCall = bootH.calls.slice(beforeUploadH).find((c) => c.method === 'POST' && c.url.endsWith('/cyrene/hero'))
ok(
  '上传形象走 POST /cyrene/hero（带 rev + data URL），不是从页面直接写文件',
  uploadCall !== undefined && JSON.parse(uploadCall.body).rev === heroRev - 1 &&
    JSON.parse(uploadCall.body).data === 'data:image/png;base64,AAAA',
  uploadCall?.body,
)
const managerHImg2 = managerH2.querySelector('[data-role="preview-mark"]')
ok(
  '上传完形象路径换成自定义记号、预览地址带上新版本戳',
  /\/cyrene\/hero\?v=zz-2k$/.test(String(managerHImg2.src)) && cardsH2.every((el) => el.attrs['data-on'] === undefined),
  managerHImg2?.src,
)

// 恢复默认：一次性把形象 / 文案 / CSS / 开关都拉回出厂值。
const beforeResetH = bootH.calls.length
managerH2.dispatch('click', { target: managerH2.querySelector('[data-role="hero-reset"]') })
await tick()
const resetPatchH = heroPatchOf(beforeResetH)
ok(
  '「恢复默认」把形象 / 文案 / CSS / 接管开关一起写回默认值',
  resetPatchH?.hero?.image === 'meme/俏皮眨眼.png' &&
    resetPatchH?.hero?.title === '让昔涟来帮帮你吧🎵' &&
    resetPatchH?.hero?.css === '' &&
    resetPatchH?.hero?.enabled === true &&
    Object.keys(resetPatchH.hero).length === 4,
  resetPatchH?.hero,
)
ok(
  '默认值来自宿主半的 defaultHero（不是客户端自己写死一份）',
  (await readFile(CLIENT, 'utf8')).includes('state.defaultHero'),
)

// 接管开关：关掉 → 撤掉槽位注册（宿主的鱼 + 默认文案才回来），打开 → 再注一次。
const toggleH = managerH2.querySelector('[data-role="hero-on"]')
ok('管理器里有「接管欢迎页」开关，默认开着', toggleH !== null && toggleH.checked === true, toggleH?.checked)
const heroInjections = () => boxH.injected.filter((name) => name === 'conversation.hero.brand.mark').length
ok(
  '开机就注入了欢迎页槽位（默认接管）',
  heroInjections() === 1 && boxH.disposed.length === 0,
  [boxH.injected, boxH.disposed],
)
const beforeOff = bootH.calls.length
toggleH.checked = false
toggleH.dispatch('change')
await tick()
const offPatchH = heroPatchOf(beforeOff)
ok(
  '关掉开关只发 hero.enabled 一个键',
  offPatchH?.hero?.enabled === false && Object.keys(offPatchH.hero).length === 1,
  offPatchH,
)
ok(
  '关掉后槽位注册被撤掉（single 槽只要还有注册，宿主就不会渲染自己的兜底）',
  boxH.disposed.filter((name) => name === 'conversation.hero.brand.mark').length === 1,
  boxH.disposed,
)
ok(
  '入口概况改成「已关闭（用 DSH 默认欢迎页）」',
  /已关闭/.test(editorH.querySelector('[data-role="hero-note"]').textContent),
  editorH.querySelector('[data-role="hero-note"]').textContent,
)
ok(
  '关掉时管理器标上 data-hero-on="off"（预览与候选淡下去，但仍可配置）',
  managerH2.attrs['data-hero-on'] === 'off' && /\[data-hero-on="off"\]/.test(cssText),
  managerH2.attrs['data-hero-on'],
)

const beforeOn = bootH.calls.length
toggleH.checked = true
toggleH.dispatch('change')
await tick()
ok(
  '重新打开就再注一次（不用重载插件行）',
  heroPatchOf(beforeOn)?.hero?.enabled === true && heroInjections() === 2 && managerH2.attrs['data-hero-on'] === 'on',
  [heroPatchOf(beforeOn), heroInjections()],
)

// 文本 CSS 的默认值：原样存回去时按空串存，别把默认样式"冻"进状态里。
const beforeDefaultCss = bootH.calls.length
managerH2.querySelector('[data-role="hero-css-default"]').dispatch('click', {
  target: managerH2.querySelector('[data-role="hero-css-default"]'),
})
managerH2.dispatch('click', { target: managerH2.querySelector('[data-role="hero-save"]') })
await tick()
ok(
  '「填回默认样式」后再保存：CSS 按空串存（继续跟插件默认走，而不是冻住一份快照）',
  heroPatchOf(beforeDefaultCss)?.hero?.css === '',
  heroPatchOf(beforeDefaultCss),
)

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)
