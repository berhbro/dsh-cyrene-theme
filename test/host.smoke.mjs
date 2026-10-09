/**
 * 宿主半自检：不起服务器、不碰真实 ~/.dsh，全在临时目录里跑。
 *
 *   node test/host.smoke.mjs
 *
 * 覆盖：section 名/order 回退、默认底稿、GET/POST 信封、落盘、重挂 section、
 *      enabled/空白 persona 的处理、404、超大请求体、跨"重启"读取磁盘设定。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cyrene-host-'))
process.env.DSH_HOME = home
const MOD = new URL('../lib/index.js', import.meta.url).href
const STATE_FILE = join(home, 'cyrene-theme.json')

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

/** 复刻运行版的 ctx 形状（section() 会对非 finite order 抛错，跟真版一致）。 */
function makeCtx(orders = {}) {
  const sections = []
  const routes = []
  const warnings = []
  const ctx = {
    logger: { info() {}, warn: (...a) => warnings.push(a) },
    effect(fn) {
      fn()
    },
    systemPrompt: {
      getSectionOrder: (name) => orders[name],
      section(spec) {
        if (!Number.isFinite(spec.order)) {
          throw new TypeError(`prompt section "${spec.name}" order must be a finite number`)
        }
        sections.push(spec)
        return () => {
          spec.disposed = true
        }
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
      },
    },
  }
  return { ctx, sections, routes, warnings }
}

function makeReq(method, url, body) {
  const buf = body === undefined ? null : Buffer.from(body, 'utf8')
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (buf !== null) yield buf
    },
  }
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    setHeader(k, v) {
      res.headers = { ...(res.headers ?? {}), [k.toLowerCase()]: v }
    },
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = { ...(res.headers ?? {}), ...(headers ?? {}) }
    },
    end(chunk) {
      // 图片是二进制：body 只给文本断言用，bytes 保留原始字节。
      res.bytes = chunk ? Buffer.from(chunk) : Buffer.alloc(0)
      res.body = res.bytes.toString('utf8')
    },
  }
  return res
}

const readStateFile = async () => JSON.parse(await readFile(STATE_FILE, 'utf8'))
const lastSection = (box) => box.sections[box.sections.length - 1]
const liveSections = (box) => box.sections.filter((s) => s.disposed !== true)

console.log(`临时 DSH_HOME = ${home}\n`)

// ── 1. 挂载 + section 契约（运行版 order 键：DEPLOYMENT_PERSONA_PREFIX = 0）
const { apply } = await import(MOD)
const A = makeCtx({ DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500 })
apply(A.ctx)
await tick()

const s0 = lastSection(A)
ok('section 名是 cyrene:persona', s0?.name === 'cyrene:persona', s0?.name)
ok('order = 部署人格前缀 0 + 100', s0?.order === 100, s0?.order)
ok('默认底稿含「昔涟」与【口吻】', s0?.text.includes('昔涟') && s0?.text.includes('【口吻】'))
ok('同一时刻只有一个活着的 section', liveSections(A).length === 1, A.sections.length)
ok('活着的就是最后挂的那个', liveSections(A)[0] === lastSection(A))
const route = A.routes[0]
ok('路由 kind=prefix path=/cyrene', route?.kind === 'prefix' && route?.path === '/cyrene', route)

/** 复刻真实客户端半的写入姿势：先 GET 拿 rev，再带着它 POST。 */
async function post(patch) {
  const g = makeRes()
  await route.handler(makeReq('GET', '/cyrene/state'), g)
  const rev = JSON.parse(g.body).value.rev
  const r = makeRes()
  await route.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev, ...patch })), r)
  return r
}

/** 读一次状态快照，返回 {statusCode, body, headers}。 */
async function get(path = '/cyrene/state') {
  const r = makeRes()
  await route.handler(makeReq('GET', path), r)
  return r
}

// ── 2. GET /cyrene/state
const r1 = makeRes()
await route.handler(makeReq('GET', '/cyrene/state'), r1)
ok('GET 200', r1.statusCode === 200, r1.statusCode)
const j1 = JSON.parse(r1.body)
ok('信封 {ok:true,value}', j1.ok === true && typeof j1.value === 'object')
ok('statePath 落在临时 home', j1.value.statePath === STATE_FILE, j1.value.statePath)
ok('初值 enabled=true theme=true', j1.value.enabled === true && j1.value.theme === true)
ok('defaultPersona === persona（未改过）', j1.value.defaultPersona === j1.value.persona)
ok(
  '响应头 charset=utf-8 + no-store',
  /charset=utf-8/i.test(String(r1.headers?.['Content-Type'] ?? r1.headers?.['content-type'] ?? '')) &&
    String(r1.headers?.['Cache-Control'] ?? r1.headers?.['cache-control']) === 'no-store',
  r1.headers,
)
ok('只读时不写盘（文件尚未创建）', (await readFile(STATE_FILE, 'utf8').then(() => true, () => false)) === false)
const beforeNoop = A.sections.length
const r1b = makeRes()
await route.handler(makeReq('POST', '/cyrene/state'), r1b)
ok(
  '不带 rev 的 POST（旧版客户端半）被拒 400 client-outdated',
  r1b.statusCode === 400 && JSON.parse(r1b.body).error.code === 'client-outdated' && A.sections.length === beforeNoop,
  [r1b.statusCode, r1b.body],
)
ok('GET 快照带 rev=0 与 lastWrite=null', j1.value.rev === 0 && j1.value.lastWrite === null, [j1.value.rev, j1.value.lastWrite])
const r1bGet = makeRes()
await route.handler(makeReq('GET', '/cyrene/state'), r1bGet)
const lastRejected = JSON.parse(r1bGet.body).value.lastWrite
ok(
  '被拒的尝试记进 lastWrite（rev 为 null）',
  lastRejected?.result === 'client-outdated' && lastRejected?.rev === null && lastRejected?.keys.length === 0,
  lastRejected,
)
const r1c = await post({})
ok(
  '带 rev 的空补丁 = 200 no-op 且不重挂',
  r1c.statusCode === 200 && A.sections.length === beforeNoop && JSON.parse(r1c.body).value.rev === 0,
  [r1c.statusCode, A.sections.length, r1c.body],
)
ok('no-op 写进 lastWrite 但不算改动', JSON.parse(r1c.body).value.lastWrite?.result === 'noop')

// ── 3. POST 改人格 → 立即重挂 section + 落盘 + rev 自增
const beforePost = A.sections.length
const r2 = await post({ persona: '测试人格 v2 · TEST' })
ok('POST 200', r2.statusCode === 200, r2.statusCode)
ok('POST 回传新值', JSON.parse(r2.body).value.persona === '测试人格 v2 · TEST')
ok('写入后 rev 自增到 1', JSON.parse(r2.body).value.rev === 1, JSON.parse(r2.body).value.rev)
ok('lastWrite 记下这次成功写入的字段', JSON.parse(r2.body).value.lastWrite?.result === 'ok' && JSON.parse(r2.body).value.lastWrite?.keys.join(',') === 'persona')
ok('重挂：多一个 section 且旧的被 disposal', A.sections.length === beforePost + 1 && A.sections[beforePost - 1].disposed === true)
ok(
  '新 section 正文 = 新设定 + 表情包约定',
  lastSection(A).text.startsWith('测试人格 v2 · TEST') && lastSection(A).text.includes('【表情包】'),
  lastSection(A).text.slice(0, 40),
)
const persisted2 = await readStateFile()
ok('新设定已落盘（含 rev）', persisted2.persona === '测试人格 v2 · TEST' && persisted2.rev === 1, persisted2)

// ── 3b. 乐观并发：过期 rev 一律拒绝，状态与 section 都不许动
const beforeStale = A.sections.length
const textBeforeStale = lastSection(A).text
const rStale = makeRes()
await route.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev: 0, persona: '不该生效' })), rStale)
ok('过期 rev → 409 stale', rStale.statusCode === 409 && JSON.parse(rStale.body).error.code === 'stale', rStale.statusCode)
ok('过期写入不改状态、不重挂 section', A.sections.length === beforeStale && lastSection(A).text === textBeforeStale)
const rStaleGet = makeRes()
await route.handler(makeReq('GET', '/cyrene/state'), rStaleGet)
const afterStale = JSON.parse(rStaleGet.body).value
ok('过期写入后 rev 不变、磁盘也没被改', afterStale.rev === 1 && (await readStateFile()).persona === '测试人格 v2 · TEST', afterStale.rev)
ok(
  'lastWrite 记录了被拒的这次尝试',
  afterStale.lastWrite?.result === 'stale' && afterStale.lastWrite?.rev === 0 && afterStale.lastWrite?.keys.join(',') === 'persona',
  afterStale.lastWrite,
)
const rBadRev = makeRes()
await route.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev: '1', theme: false })), rBadRev)
ok('非整数 rev 同样按旧版客户端处理', rBadRev.statusCode === 400 && JSON.parse(rBadRev.body).error.code === 'client-outdated', rBadRev.statusCode)

// ── 4. GET 反映磁盘
const r3 = makeRes()
await route.handler(makeReq('GET', '/cyrene/state'), r3)
ok('GET 读到新人格', JSON.parse(r3.body).value.persona === '测试人格 v2 · TEST')

// ── 5. enabled=false / 空白 persona → 交出空字符串（渲染阶段被丢掉）
const r4 = await post({ enabled: false })
ok('关闭人格后正文为空', lastSection(A).text === '')
const r5 = await post({ enabled: true, persona: '   \n  ' })
ok('空白 persona 正文为空', lastSection(A).text === '')

// ── 6. theme 开关独立于 enabled
const r6 = await post({ persona: 'ok', theme: false })
const j6 = JSON.parse(r6.body).value
ok('theme=false 生效', j6.theme === false && j6.enabled === true && j6.persona === 'ok')
ok('theme=false 已落盘', (await readStateFile()).theme === false)

// ── 7. 未知路由 / 超大请求体
const r7 = makeRes()
await route.handler(makeReq('GET', '/cyrene/nope'), r7)
ok('未知路由 404 not-found', r7.statusCode === 404 && JSON.parse(r7.body).error.code === 'not-found', r7.statusCode)
const r8 = makeRes()
await route.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev: 99, persona: 'x'.repeat(300 * 1024) })), r8)
ok('超过 256KB 的请求体被拒（400）', r8.statusCode === 400 && JSON.parse(r8.body).ok === false, r8.statusCode)
ok('被拒后 section 未被动过', lastSection(A).text.startsWith('ok'))

// ── 7b. 活页面取证路由：只存内存的旁路，绝不碰状态与磁盘
const revBeforeReport = JSON.parse((await get()).body).value.rev
const report = { kind: 'cyrene-dom-report', theme: true, viewport: [1200, 800], blurCount: 1, entries: [{ el: 'div[data-shell-overlay]', blur: 'blur(16px)' }] }
const rp1 = makeRes()
await route.handler(makeReq('POST', '/cyrene/report', JSON.stringify(report)), rp1)
ok('POST /cyrene/report 200 并回执时间', rp1.statusCode === 200 && typeof JSON.parse(rp1.body).value?.at === 'string', rp1.body)
const rp2 = makeRes()
await route.handler(makeReq('GET', '/cyrene/report'), rp2)
const stored = JSON.parse(rp2.body).value
ok(
  'GET /cyrene/report 读回最后一份报告',
  stored?.payload?.kind === 'cyrene-dom-report' && stored?.payload?.entries?.[0]?.el === 'div[data-shell-overlay]',
  stored,
)
const afterReport = JSON.parse((await get()).body).value
ok('取证不碰 rev / 状态', afterReport.rev === revBeforeReport && afterReport.persona === 'ok', afterReport.rev)
ok('取证不落盘', (await readStateFile()).persona === 'ok')
const rp3 = makeRes()
await route.handler(makeReq('POST', '/cyrene/report', JSON.stringify({ kind: 'cyrene-dom-report', pad: 'x'.repeat(200 * 1024) })), rp3)
ok('超过 128KB 的报告被拒（400 too-large）', rp3.statusCode === 400 && JSON.parse(rp3.body).error.code === 'too-large', rp3.statusCode)
const rp4 = makeRes()
await route.handler(makeReq('GET', '/cyrene/report'), rp4)
ok('被拒的报告没有覆盖上一份', JSON.parse(rp4.body).value?.payload?.kind === 'cyrene-dom-report' && !('pad' in JSON.parse(rp4.body).value.payload))

// ── 7c. 表情包：清单、图片字节、开关（素材与清单都在包里，测试直接用真货）
const rs1 = makeRes()
await route.handler(makeReq('GET', '/cyrene/stickers'), rs1)
const stickerList = JSON.parse(rs1.body).value
ok('GET /cyrene/stickers 回清单', rs1.statusCode === 200 && stickerList.items.length > 0, rs1.statusCode)
ok(
  '清单项带 id / label / when / url',
  stickerList.items.every((it) => typeof it.id === 'string' && it.id !== '' && it.label !== '' && typeof it.url === 'string' && it.url.startsWith('/cyrene/sticker/')),
  stickerList.items[0],
)
ok('清单里的文件都存在（missing 为空）', stickerList.missing.length === 0, stickerList.missing)
const firstSticker = stickerList.items[0]
const rs2 = makeRes()
await route.handler(makeReq('GET', `/cyrene/sticker/${encodeURIComponent(firstSticker.id)}`), rs2)
ok(
  'GET /cyrene/sticker/<id> 回图片字节',
  rs2.statusCode === 200 && rs2.bytes.length === firstSticker.bytes && rs2.headers['Content-Type'] === firstSticker.type,
  [rs2.statusCode, rs2.bytes.length, rs2.headers?.['Content-Type']],
)
ok(
  '图片响应带缓存与 nosniff 头',
  rs2.headers['Cache-Control'] === 'private, max-age=300' && rs2.headers['X-Content-Type-Options'] === 'nosniff',
  rs2.headers,
)
const rs3 = makeRes()
await route.handler(makeReq('GET', '/cyrene/sticker/not-a-real-id'), rs3)
ok('不认识的表情包 id → 404', rs3.statusCode === 404 && JSON.parse(rs3.body).error.code === 'not-found', rs3.statusCode)
const rs4 = await post({ stickers: false })
ok(
  '关掉表情包开关后正文里没有约定',
  rs4.statusCode === 200 && lastSection(A).text.startsWith('ok') && !lastSection(A).text.includes('【表情包】'),
  lastSection(A).text.slice(0, 20),
)
ok('表情包开关已落盘', (await readStateFile()).stickers === false)
const rs5 = await post({ stickers: true })
ok('打开后约定又回来了', rs5.statusCode === 200 && lastSection(A).text.includes('【表情包】'))

// ── 7d. 欢迎页形象：state.hero + /cyrene/hero 字节路由
const rh1 = await get()
const heroState = JSON.parse(rh1.body).value.hero
ok(
  'GET /cyrene/state 带 hero（默认形象 + 欢迎语 + 就绪状态 + 字节地址）',
  heroState !== null && typeof heroState === 'object' &&
    heroState.image === 'meme/俏皮眨眼.png' &&
    heroState.title === '让昔涟来帮帮你吧🎵' &&
    heroState.ready === true && heroState.url === '/cyrene/hero',
  heroState,
)
const rh2 = makeRes()
await route.handler(makeReq('GET', '/cyrene/hero'), rh2)
ok(
  'GET /cyrene/hero 回图片字节（透明背景的 PNG）',
  rh2.statusCode === 200 && rh2.bytes.length > 1000 && rh2.headers['Content-Type'] === 'image/png',
  [rh2.statusCode, rh2.bytes.length, rh2.headers?.['Content-Type']],
)
ok(
  '形象响应也带缓存 / nosniff / ETag',
  rh2.headers['Cache-Control'] === 'private, max-age=300' &&
    rh2.headers['X-Content-Type-Options'] === 'nosniff' &&
    typeof rh2.headers.ETag === 'string',
  rh2.headers,
)
const rh3 = makeReq('GET', '/cyrene/hero')
rh3.headers['if-none-match'] = rh2.headers.ETag
const rh3res = makeRes()
await route.handler(rh3, rh3res)
ok('带对 ETag 时回 304（省掉一次读盘）', rh3res.statusCode === 304 && rh3res.bytes.length === 0, rh3res.statusCode)

const rh4 = await post({ hero: { title: '昔涟在呢' } })
ok('改欢迎语立即生效', rh4.statusCode === 200 && JSON.parse(rh4.body).value.hero.title === '昔涟在呢', JSON.parse(rh4.body).value.hero)
ok('欢迎语已落盘', (await readStateFile()).hero.title === '昔涟在呢')
const rh5 = await post({ hero: { image: '../outside.png' } })
const badHero = JSON.parse(rh5.body).value.hero
ok('形象路径不许跑出包外（未就绪，不是 500）', badHero.ready === false && badHero.url === null, badHero)
const rh6 = makeRes()
await route.handler(makeReq('GET', '/cyrene/hero'), rh6)
ok('未就绪时 /cyrene/hero 回 404', rh6.statusCode === 404 && JSON.parse(rh6.body).error.code === 'not-found', rh6.statusCode)
const rh7 = await post({ hero: { image: 'meme/没有这张.png' } })
ok('文件不存在同样是未就绪', JSON.parse(rh7.body).value.hero.ready === false, JSON.parse(rh7.body).value.hero)
const rh8 = await post({ hero: { image: 'meme/俏皮眨眼.png', title: '让昔涟来帮帮你吧🎵' } })
const backHero = JSON.parse(rh8.body).value.hero
ok('改回默认形象后重新就绪', backHero.ready === true && backHero.url === '/cyrene/hero', backHero)

// ── 7e. 表情包管理：自添加 / 删除 / 大小（写入口也走 rev 闸门）
const revNow = async () => JSON.parse((await get()).body).value.rev
async function writeTo(path, payload) {
  const r = makeRes()
  await route.handler(makeReq('POST', path, JSON.stringify({ rev: await revNow(), ...payload })), r)
  return r
}
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAABAAElEQVR4nGP4//8/AwAI/AL+8V2SAAAAAElFTkSuQmCC'
const m0 = JSON.parse((await get()).body).value
ok(
  'state 带 stickerSize=96 与空的 customStickers',
  m0.stickerSize === 96 && Array.isArray(m0.customStickers) && m0.customStickers.length === 0,
  [m0.stickerSize, m0.customStickers],
)

const up = await writeTo('/cyrene/stickers', { name: '我的图.png', label: '自定的', when: '测试用', data: 'data:image/png;base64,' + PNG_B64 })
const upValue = JSON.parse(up.body).value
const upId = upValue.state.customStickers[0]?.id
ok(
  '上传成功：回 state + 清单两个快照',
  up.statusCode === 200 && upValue.state.customStickers.length === 1 && upValue.stickers.items.some((it) => it.id === upId && it.custom === true),
  upValue.state.customStickers,
)
ok('自定义项带上 label / when', upValue.state.customStickers[0].label === '自定的' && upValue.state.customStickers[0].when === '测试用', upValue.state.customStickers[0])
const upFile = makeRes()
await route.handler(makeReq('GET', `/cyrene/sticker/${upId}`), upFile)
ok(
  '自添加的图能从宿主半读到字节（内容对得上）',
  upFile.statusCode === 200 && upFile.bytes.length === Buffer.from(PNG_B64, 'base64').length && upFile.headers['Content-Type'] === 'image/png',
  [upFile.statusCode, upFile.bytes.length],
)
ok('自定义条目落盘', (await readStateFile()).customStickers.length === 1)
ok('人格附录立刻跟上（新贴纸马上能贴）', lastSection(A).text.includes('自定的') && lastSection(A).text.includes('测试用'))

const staleUp = makeRes()
await route.handler(makeReq('POST', '/cyrene/stickers', JSON.stringify({ rev: 1, name: 'x.png', data: 'data:image/png;base64,' + PNG_B64 })), staleUp)
ok('上传也受 rev 闸门管（过期 → 409 stale）', staleUp.statusCode === 409 && JSON.parse(staleUp.body).error.code === 'stale', staleUp.statusCode)

const badImg = await writeTo('/cyrene/stickers', { name: 'x.png', data: 'not-a-data-url' })
ok('不是 data URL → 400 bad-image', badImg.statusCode === 400 && JSON.parse(badImg.body).error.code === 'bad-image', badImg.statusCode)
const badType = await writeTo('/cyrene/stickers', { name: 'x.txt', data: 'data:text/plain;base64,AAAA' })
ok('类型不认识 → 400 bad-type', badType.statusCode === 400 && JSON.parse(badType.body).error.code === 'bad-type', badType.statusCode)
const tooBig = await writeTo('/cyrene/stickers', { name: 'big.png', data: 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 64).toString('base64') })
ok('解码后超过 8MB → 400 too-large', tooBig.statusCode === 400 && JSON.parse(tooBig.body).error.code === 'too-large', tooBig.statusCode)
ok('被拒的上传没在磁盘上留下东西', (await readStateFile()).customStickers.length === 1)

const szHigh = await post({ stickerSize: 9999 })
ok('stickerSize 上限夹到 320', JSON.parse(szHigh.body).value.stickerSize === 320, JSON.parse(szHigh.body).value.stickerSize)
const szLow = await post({ stickerSize: 10 })
ok('stickerSize 下限夹到 48', JSON.parse(szLow.body).value.stickerSize === 48, JSON.parse(szLow.body).value.stickerSize)
const szOk = await post({ stickerSize: 128.4 })
ok(
  'stickerSize 取整并落盘',
  JSON.parse(szOk.body).value.stickerSize === 128 && (await readStateFile()).stickerSize === 128,
  JSON.parse(szOk.body).value.stickerSize,
)

const del = makeRes()
await route.handler(makeReq('POST', '/cyrene/stickers/remove', JSON.stringify({ rev: await revNow(), id: upId })), del)
const delValue = JSON.parse(del.body).value
ok(
  '删除成功：条目与清单同时更新',
  del.statusCode === 200 && delValue.state.customStickers.length === 0 && !delValue.stickers.items.some((it) => it.id === upId),
  delValue.state.customStickers,
)
const gone = makeRes()
await route.handler(makeReq('GET', `/cyrene/sticker/${upId}`), gone)
ok('文件也从磁盘删掉了', gone.statusCode === 404, gone.statusCode)
ok('删除已落盘，人格附录里也不再提它', (await readStateFile()).customStickers.length === 0 && !lastSection(A).text.includes('自定的'))
const delMissing = makeRes()
await route.handler(makeReq('POST', '/cyrene/stickers/remove', JSON.stringify({ rev: await revNow(), id: '../../etc/passwd' })), delMissing)
ok(
  '删不存在的 id（含路径穿越写法）→ 404 not-found',
  delMissing.statusCode === 404 && JSON.parse(delMissing.body).error.code === 'not-found',
  delMissing.statusCode,
)

// ── 7e. 背景图：Background/ 的清单 + 字节路由 + 设定（开关 / 选图 / 轮换 / 浓度）
const bg1 = await get()
const bgState = JSON.parse(bg1.body).value.background
ok(
  'GET /cyrene/state 带 background（默认开着、起点按目录顺序第一张、不轮换、90s、浓度 0.6）',
  bgState !== null && typeof bgState === 'object' &&
    bgState.enabled === true && bgState.current === '' && bgState.rotate === false &&
    bgState.interval === 90 && bgState.dim === 0.6,
  bgState,
)
const rb1 = makeRes()
await route.handler(makeReq('GET', '/cyrene/backgrounds'), rb1)
const bgList = JSON.parse(rb1.body).value
ok(
  'GET /cyrene/backgrounds 回清单',
  rb1.statusCode === 200 && bgList.items.length > 0 && bgList.folder === 'Background' && bgList.error === null,
  [rb1.statusCode, bgList.items?.length, bgList.error],
)
ok(
  '清单项带 id / type / bytes / url，url 与文件名一一对应',
  bgList.items.every((it) => typeof it.id === 'string' && it.id !== '' && typeof it.type === 'string' && it.bytes > 0 &&
    it.url === '/cyrene/background/' + encodeURIComponent(it.id)),
  bgList.items[0],
)
const bgFirst = bgList.items[0]
const rb2 = makeRes()
await route.handler(makeReq('GET', `/cyrene/background/${encodeURIComponent(bgFirst.id)}`), rb2)
ok(
  'GET /cyrene/background/<name> 回图片字节（响应头与表情包同一套）',
  rb2.statusCode === 200 && rb2.bytes.length === bgFirst.bytes && rb2.headers['Content-Type'] === bgFirst.type &&
    rb2.headers['Cache-Control'] === 'private, max-age=300' && rb2.headers['X-Content-Type-Options'] === 'nosniff',
  [rb2.statusCode, rb2.bytes.length, rb2.headers?.['Content-Type']],
)
const rb3 = makeRes()
await route.handler(makeReq('GET', '/cyrene/background/not-a-real-picture.jpeg'), rb3)
ok('不在清单里的名字 → 404 not-found', rb3.statusCode === 404 && JSON.parse(rb3.body).error.code === 'not-found', rb3.statusCode)
const rb4 = makeRes()
await route.handler(makeReq('GET', '/cyrene/background/..%2F..%2Fpackage.json'), rb4)
ok('路径穿越写法也走「不在清单里」这条路（读不到包外文件）', rb4.statusCode === 404, rb4.statusCode)

const rb5 = await post({ background: { dim: 5, interval: 3, enabled: 'no', current: '../outside.jpeg' } })
const clampedBg = JSON.parse(rb5.body).value.background
ok(
  '脏值一律不写进去：dim / interval 收到区间内，非布尔的开关与带路径的文件名保持原样',
  clampedBg.dim === 0.85 && clampedBg.interval === 15 && clampedBg.enabled === true && clampedBg.current === '',
  clampedBg,
)
const rb6 = await post({ background: { enabled: false, rotate: true, interval: 120, dim: 0.4, current: bgFirst.name } })
const goodBg = JSON.parse(rb6.body).value.background
ok(
  '正常的背景设定照常生效',
  goodBg.enabled === false && goodBg.rotate === true && goodBg.interval === 120 && goodBg.dim === 0.4 && goodBg.current === bgFirst.name,
  goodBg,
)
const bgDisk = (await readStateFile()).background
ok('背景设定已落盘', bgDisk.current === bgFirst.name && bgDisk.dim === 0.4 && bgDisk.rotate === true, bgDisk)
const rb7 = await post({ background: { enabled: true, rotate: false, interval: 90, dim: 0.6, current: '' } })
ok('改回默认也是普通写入（后面的段落只看 theme / rev）', JSON.parse(rb7.body).value.background.enabled === true, rb7.statusCode)

// ── 8. order 回退：旧版键 / 完全没有这个键
const B = makeCtx({ DEPLOYMENT_PERSONA: 0 })
apply(B.ctx)
await tick()
ok('旧版 DEPLOYMENT_PERSONA 也得到 100', lastSection(B).order === 100, lastSection(B).order)
const C = makeCtx({})
apply(C.ctx)
await tick()
ok('完全不认识这些键时落到 100', lastSection(C).order === 100, lastSection(C).order)

// ── 9. "重启"：新模块实例只从磁盘读设定（缓存破坏 → 新实例）
const revBeforeRestart = (await readStateFile()).rev
const mod2 = await import(`${MOD}?restart=1`)
const D = makeCtx({ DEPLOYMENT_PERSONA_PREFIX: 0 })
mod2.apply(D.ctx)
ok('挂载瞬间用默认底稿', lastSection(D).text.includes('昔涟'))
await tick()
ok('读盘后用文件里的设定覆盖', lastSection(D).text.startsWith('ok'), lastSection(D).text.slice(0, 40))
ok('第二次挂载同样只有一个活着的 section', liveSections(D).length === 1, D.sections.length)

const routeD = D.routes[0]
const rD = makeRes()
await routeD.handler(makeReq('GET', '/cyrene/state'), rD)
const jD = JSON.parse(rD.body).value
ok('重启后 rev 跟着磁盘走', jD.rev === revBeforeRestart && jD.rev > 0, [jD.rev, revBeforeRestart])
const rDStale = makeRes()
await routeD.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev: 0, theme: true })), rDStale)
ok('重启后旧 rev 依然被拒（不会把主题翻回来）', rDStale.statusCode === 409 && jD.theme === false, [rDStale.statusCode, jD.theme])
const rDOk = makeRes()
await routeD.handler(makeReq('POST', '/cyrene/state', JSON.stringify({ rev: jD.rev, theme: true })), rDOk)
ok('带对 rev 的写入照常成功并再自增', rDOk.statusCode === 200 && JSON.parse(rDOk.body).value.rev === jD.rev + 1, rDOk.statusCode)

await rm(home, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)
