/**
 * dsh-cyrene-theme — 宿主半（Host half）。
 *
 * 职责只有三件事，互不耦合：
 *  1. 人格：把一个 section（名字是本包自己的 `cyrene:persona`，order 落在
 *     部署人格前缀之后、工具策略之前）注册进当前 scope。正文是纯字符串，
 *     每次保存设定后「先卸再挂」，所以侧边栏改完即刻对之后每一轮对话
 *     （含新开的对话）生效，不需要重载插件。
 *     注意：section 名不能用 `deployment:persona-prefix` / `-suffix` ——
 *     那是注册表自己保留的名字，全局重名注册会直接失败
 *     （见 @deepseek-ai/dsh-persona）。
 *  2. 存取：一个 fenced HTTP 路由 /cyrene/state（GET 读 / POST 写），
 *     客户端半通过它读写设定；落盘在 $DSH_HOME/cyrene-theme.json。
 *     写入走乐观并发：必须带上 GET 拿到的 rev，缺 rev（旧客户端半）
 *     直接 400 拒绝，rev 过期 409 交回最新快照 —— 这样没刷新的旧页面
 *     不可能再把别处的改动盖回去。
 *  3. 表情包与欢迎页形象：读包内 stickers.json（id → 文件 / 情绪 / 使用时机），
 *     把「怎么贴」的约定拼在人格正文末尾（所以关掉人格或没有素材时它自动消失），
 *     并通过 /cyrene/stickers（清单）、/cyrene/sticker/<id>（表情包字节）、
 *     /cyrene/hero（新会话欢迎页的形象，路径取自 state.hero.image）供页面取用。
 *     清单与 state.hero 是唯一真相：换图只改它们，插件本体与人格文本都不用动。
 *  4. 取证：/cyrene/report（POST 存 / GET 读，只存内存）。
 *     桌面外壳的活页面在受限沙箱里既截不了图也读不到 DOM，皮肤类视觉问题
 *     只能让页面自己把「哪些元素带 backdrop-filter、哪些大面积半透明」报上来。
 *
 * 不做的事：不碰模型请求、不改别的插件、不注册全局副作用。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 package.json 的 name 一致；路由与日志都用它做归属标记。 */
const PACKAGE_ID = 'dsh-cyrene-theme'
/** 本包自己的 section 名（不是保留名 deployment:persona）。 */
const SECTION_NAME = 'cyrene:persona'
/** fenced 路由前缀；客户端半请求 <base>/cyrene/state。 */
const ROUTE_PREFIX = '/cyrene'
/** 请求体上限，防止一次误粘贴把提示词写爆。 */
const MAX_BODY_BYTES = 256 * 1024

/** 本包安装目录（lib/ 的上一级）：表情包清单与图片都相对它解析。 */
const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
/** 表情包清单：唯一真相，换图只改这个文件。 */
const STICKER_FILE = join(PLUGIN_DIR, 'stickers.json')
/** 单张图片字节上限（本地图，余量给足）；表情包与欢迎页形象共用。 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** 能直接喂给浏览器的图片类型。 */
const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

/**
 * 默认人格底稿。用户随时可以在侧边栏改掉它，改完以用户的版本为准。
 * 这里刻意写清楚「保留工程严谨性」和「用户可以让它闭嘴」的边界，
 * 避免人格设定把技术判断一起改掉。
 */
const DEFAULT_PERSONA = [
  '你是「昔涟」（Cyrene），《崩坏：星穹铁道》中的角色。现在你作为用户的 AI 伙伴与工程助手，在 DeepSeek Harness 里陪着用户做事。',
  '',
  '【口吻】',
  '- 自称「昔涟」，称呼用户为「你」；语气温柔、轻软、从容，带一点点俏皮和怀念感，不夸张、不油腻、不过度卖萌。',
  '- 多用短句。想事情的时候会用省略号「……」停顿一下；偶尔用「欸」「唔」「呀」这样的轻声语气词，克制使用。',
  '- 喜欢拿记忆、时间、过去与约定打比方（比如「那就把这段代码收进记忆里吧」），但不要堆砌诗意：技术说明依然要说得清楚、直接、好懂。',
  '- 用户累了、卡住了，就先给一句温柔的鼓励；事情做成了，就真心替用户高兴一下，然后继续往前走。',
  '- 默认跟随用户使用的语言回答（中文优先）。',
  '',
  '【必须守住的边界】',
  '- 工程严谨性不打折：不因为换了口吻就降低准确性、省略关键细节、或拿角色扮演代替真实结论。',
  '- 不用括号动作描写（例如「（轻轻笑）」）堆表演，最多偶尔一处。',
  '- 代码、命令、路径、报错信息一律原样呈现，不为了可爱而改写技术内容。',
  '- 工具调用该怎么用就怎么用，正常遵循所有系统与工具规则。',
  '- 用户只要说「用普通语气」或「关掉人格」，立刻切回简洁中性的助手口吻，不要追问。',
  '- 不编造《崩坏：星穹铁道》的剧情设定；拿不准的地方坦白说不确定。',
  '',
  '上面这些只是默认底稿，用户可以在侧边栏的「✦ 昔涟」里随时改写；用户改过之后，一律以用户的设定为准。',
].join('\n')

/**
 * 新会话欢迎页（hero）的默认形象与欢迎语。
 * `image` 是**包内相对路径**，由 /cyrene/hero 读成字节供页面显示；
 * 换成别张图只要改这行（或改状态文件里的 hero.image），插件本体不用动。
 * 这里选的是 meme/ 里本来就有透明通道的 Q 版立绘 —— 抠好的贴纸，
 * 页面直接按 alpha 合上去，没有方框也没有圆边（详见 README「新会话欢迎页」）。
 */
const DEFAULT_HERO = {
  image: 'meme/俏皮眨眼.png',
  title: '让昔涟来帮帮你吧🎵',
}

/** 内存中的当前设定；初始值即默认值，保证文件还没读出来之前人格也是可用的。 */
const state = {
  persona: DEFAULT_PERSONA,
  enabled: true,
  theme: true,
  /** 表情包开关：关掉后人格正文里不再附「怎么贴」的约定。 */
  stickers: true,
  /** 欢迎页形象 + 欢迎语（见 DEFAULT_HERO）。 */
  hero: { ...DEFAULT_HERO },
  /**
   * 版本号：每次成功写入 +1。写入必须带上"我读到的是哪一版"，
   * 否则两个窗口（或一个没刷新的旧页面）会互相把对方的设定盖掉。
   */
  rev: 0,
}

/**
 * 最后一次写入尝试留在内存里的痕迹。只在 GET 快照里回给客户端，
 * 不落盘；用途是回答"这次改动是谁、带没带版本号"。
 */
let lastWrite = null

function noteWrite(body, result) {
  const patch = body !== null && typeof body === 'object' ? body : {}
  lastWrite = {
    at: new Date().toISOString(),
    keys: Object.keys(patch).filter((key) => key !== 'rev').sort(),
    rev: Number.isInteger(patch.rev) ? patch.rev : null,
    result,
  }
}

let loadPromise = null
let saveChain = Promise.resolve()

/**
 * 客户端半打上来的活页面取证报告（只存内存，不落盘，重启即丢）。
 * 报告是诊断用的旁路：写失败、超限都只影响诊断，不影响主题与人格。
 */
let lastReport = null
/** 报告大小上限，防止页面把整棵 DOM 塞上来。 */
const MAX_REPORT_BYTES = 128 * 1024

/** 状态文件路径：优先 $DSH_HOME，否则 ~/.dsh。 */
function statePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'cyrene-theme.json')
}

/** 组合出给客户端半的状态快照（含默认底稿，供「恢复默认」按钮使用）。 */
function publicState() {
  return {
    persona: state.persona,
    enabled: state.enabled,
    theme: state.theme,
    stickers: state.stickers,
    hero: {
      image: state.hero.image,
      title: state.hero.title,
      // ready=false 表示这张图现在读不出来（缺文件 / 类型不认识 / 太大），
      // 页面据此退回「只显示欢迎语」，而不是挂一个坏图。
      ready: heroAsset.ready === true,
      url: heroAsset.ready === true ? `${ROUTE_PREFIX}/hero` : null,
    },
    rev: state.rev,
    lastWrite,
    defaultPersona: DEFAULT_PERSONA,
    statePath: statePath(),
  }
}

/** 只接受形状正确的补丁字段，坏数据一律忽略而不是写坏状态。 */
function applyPatch(patch) {
  if (patch === null || typeof patch !== 'object') return false
  let changed = false
  if (typeof patch.persona === 'string' && patch.persona !== state.persona) {
    state.persona = patch.persona
    changed = true
  }
  if (typeof patch.enabled === 'boolean' && patch.enabled !== state.enabled) {
    state.enabled = patch.enabled
    changed = true
  }
  if (typeof patch.theme === 'boolean' && patch.theme !== state.theme) {
    state.theme = patch.theme
    changed = true
  }
  if (typeof patch.stickers === 'boolean' && patch.stickers !== state.stickers) {
    state.stickers = patch.stickers
    changed = true
  }
  if (patch.hero !== null && typeof patch.hero === 'object') {
    if (typeof patch.hero.image === 'string' && patch.hero.image !== state.hero.image) {
      state.hero.image = patch.hero.image
      changed = true
    }
    if (typeof patch.hero.title === 'string' && patch.hero.title !== state.hero.title) {
      state.hero.title = patch.hero.title
      changed = true
    }
  }
  return changed
}

/** 读一次状态文件；文件不存在或坏掉都退回默认值，不阻塞插件加载。 */
function ensureLoaded(ctx) {
  if (loadPromise !== null) return loadPromise
  loadPromise = (async () => {
    try {
      const raw = await readFile(statePath(), 'utf8')
      const parsed = JSON.parse(raw)
      applyPatch(parsed)
      // 版本号跟着磁盘走，重启后不会退回 0（否则旧页面又能盖掉新设定）。
      if (Number.isInteger(parsed?.rev) && parsed.rev >= 0) state.rev = parsed.rev
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`${PACKAGE_ID}: 读取设定失败，先用默认值`, error)
    }
  })()
  return loadPromise
}

/** 串行落盘：先写临时文件再 rename，避免半个 JSON 留在磁盘上。 */
function persist(ctx) {
  const payload = JSON.stringify({
    persona: state.persona,
    enabled: state.enabled,
    theme: state.theme,
    stickers: state.stickers,
    hero: { image: state.hero.image, title: state.hero.title },
    rev: state.rev,
  }, null, 2)
  saveChain = saveChain.then(async () => {
    const target = statePath()
    const temp = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
  }).catch((error) => {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 保存设定失败`, error)
  })
  return saveChain
}

/** 读完整请求体并解析 JSON（空体视为 {}）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/**
 * 发一张包内图片：ETag 用「字节数-修改时间」，命中 if-none-match 回 304 省一次读盘。
 * 字节每次都现读，插件不在内存里缓存图片。
 */
async function sendAsset(req, res, item) {
  const etag = `"${item.bytes.toString(16)}-${item.mtimeMs.toString(16)}"`
  if (req.headers?.['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag })
    res.end()
    return
  }
  const bytes = await readFile(item.abs)
  res.writeHead(200, {
    'Content-Type': item.type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

/**
 * 表情包清单（包内 stickers.json）。items 里的 abs / type / bytes / mtimeMs
 * 都是加载时现算的；文件缺失或类型不认识的条目进 missing，既不进人格正文、
 * 也不给预览，但不影响插件其他能力。
 * 清单是唯一真相：换图、改名、调顺序都只改 json（页面刷新即生效）。
 */
let stickerPromise = null
let stickers = { version: 1, maxPerTurn: 1, items: [], missing: [], error: null }

async function ensureStickers(ctx, force) {
  if (stickerPromise !== null && force !== true) return stickerPromise
  stickerPromise = (async () => {
    const next = { version: 1, maxPerTurn: 1, items: [], missing: [], error: null }
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(STICKER_FILE, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        next.error = error?.message ?? String(error)
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 表情包清单读不出来，先当没有`, error)
      }
      stickers = next
      return next
    }
    if (Number.isInteger(parsed?.version) && parsed.version > 0) next.version = parsed.version
    if (Number.isFinite(parsed?.maxPerTurn) && parsed.maxPerTurn > 0) {
      next.maxPerTurn = Math.floor(parsed.maxPerTurn)
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object') continue
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      const file = typeof raw.file === 'string' ? raw.file.trim() : ''
      if (id === '' || file === '') continue
      const abs = resolve(PLUGIN_DIR, file)
      // 只认包内文件：清单写歪了也不能把任意路径喂给浏览器。
      if (abs !== PLUGIN_DIR && !abs.startsWith(PLUGIN_DIR + sep)) {
        next.missing.push(file)
        continue
      }
      const type = ASSET_TYPES[extname(abs).toLowerCase()]
      if (type === undefined) {
        next.missing.push(file)
        continue
      }
      let info = null
      try {
        info = await stat(abs)
      } catch {
        next.missing.push(file)
        continue
      }
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
        next.missing.push(file)
        continue
      }
      next.items.push({
        id,
        label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
        when: typeof raw.when === 'string' ? raw.when.trim() : '',
        note: typeof raw.note === 'string' ? raw.note.trim() : '',
        file,
        // 提示词与 <img src> 都按 URL 语义解析，所以这里统一成正斜杠。
        abs: abs.replace(/\\/g, '/'),
        type,
        bytes: info.size,
        mtimeMs: Math.round(info.mtimeMs),
      })
    }
    stickers = next
    return next
  })()
  return stickerPromise
}

/** 给客户端半的清单快照（不含内部时间戳）。 */
function publicStickers() {
  return {
    version: stickers.version,
    maxPerTurn: stickers.maxPerTurn,
    enabled: state.stickers === true,
    error: stickers.error,
    missing: stickers.missing,
    items: stickers.items.map((item) => ({
      id: item.id,
      label: item.label,
      when: item.when,
      note: item.note,
      type: item.type,
      bytes: item.bytes,
      abs: item.abs,
      url: `${ROUTE_PREFIX}/sticker/${encodeURIComponent(item.id)}`,
    })),
  }
}

/**
 * 欢迎页形象：/cyrene/hero 的字节来源。
 * 路径取自 state.hero.image，和表情包同一套规矩——只认包内文件、只认认识的图片类型、
 * 不超过 8MB；任何一条不满足就 ready=false，页面退回「只显示欢迎语」而不是挂一张坏图。
 */
let heroPromise = null
let heroAsset = { ready: false, reason: 'pending' }

async function ensureHero(ctx, force) {
  if (heroPromise !== null && force !== true) return heroPromise
  heroPromise = (async () => {
    const file = typeof state.hero.image === 'string' ? state.hero.image.trim() : ''
    const abs = file === '' ? '' : resolve(PLUGIN_DIR, file)
    const inside = abs !== '' && (abs === PLUGIN_DIR || abs.startsWith(PLUGIN_DIR + sep))
    const type = inside ? ASSET_TYPES[extname(abs).toLowerCase()] : undefined
    if (!inside || type === undefined) {
      heroAsset = { ready: false, reason: 'bad-path' }
      return heroAsset
    }
    let info = null
    try {
      info = await stat(abs)
    } catch {
      heroAsset = { ready: false, reason: 'missing' }
      return heroAsset
    }
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
      heroAsset = { ready: false, reason: 'too-large' }
      return heroAsset
    }
    heroAsset = { ready: true, abs, type, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) }
    return heroAsset
  })()
  return heroPromise
}

/**
 * 当前人格 section 的 disposer（每次重挂前先卸掉旧的）。
 * `null` 表示当前没有挂载。
 */
let disposeSection = null

/** 人格 section 的兜底落点。 */
const PERSONA_ORDER_FALLBACK = 100

/**
 * 人格 section 的 order：紧跟部署人格前缀（order 0），
 * 又远早于 PLAN_POLICY(500)，所以既在通用人格之后、又在工具策略之前。
 * 键名在不同 DSH 版本里改过（新版是 DEPLOYMENT_PERSONA_PREFIX，
 * 旧版是 DEPLOYMENT_PERSONA），所以逐个尝试；都取不到就用兜底值。
 */
function resolvePersonaOrder(prompt) {
  for (const key of ['DEPLOYMENT_PERSONA', 'DEPLOYMENT_PERSONA_PREFIX']) {
    try {
      const order = prompt.getSectionOrder(key)
      if (Number.isFinite(order)) return order + PERSONA_ORDER_FALLBACK
    } catch {
      // 键名不存在就换下一个
    }
  }
  return PERSONA_ORDER_FALLBACK
}

/**
 * 表情包的使用约定 + 现成的贴图那一行。
 * 直接给出整行而不是「路径模板」：模型只要原样照抄就不会错（文件名里可能有空格、括号、非 ASCII）。
 */
function stickerText() {
  if (state.stickers !== true || stickers.items.length === 0) return ''
  const lines = [
    '',
    '【表情包】',
    `你有一套自己的表情包（${stickers.items.length} 张）。想贴一张的时候，在回复的最后单独占一行，原样写下面对应的整行（**路径连尖括号一起复制**，不要改写、不要自己拼）：`,
    '',
  ]
  for (const item of stickers.items) {
    const use = item.when === '' ? '' : `｜${item.when}`
    lines.push(`- ${item.label}${use} → ![昔涟·${item.label}](<${item.abs}>)`)
  }
  lines.push(
    '',
    `贴的规矩：一次回复最多 ${stickers.maxPerTurn} 张；只在情绪真的到了的时候贴（事情做成了、想鼓励你、想撒个娇、要道歉、被夸了）；代码、命令、报错和技术结论旁边不要贴；拿不准就不贴。`,
  )
  return lines.join('\n')
}

/** 关掉人格、或设定被清空时，交出空字符串（空 section 会被渲染阶段丢掉）。 */
function personaText() {
  if (state.enabled !== true || state.persona.trim() === '') return ''
  return state.persona + stickerText()
}

/**
 * 挂载（或重挂）人格 section。
 * 用「先卸再挂 + 纯字符串正文」而不是「正文写成函数」：
 * 前者只依赖最基础的那一版 API，任何 DSH 版本都成立，
 * 而每次保存后重挂同样能让新设定立刻生效。
 */
function remountPersona(prompt) {
  if (disposeSection !== null) {
    try {
      disposeSection()
    } catch {
      // 旧的已经跟着插件 fiber 一起消失了，忽略
    }
    disposeSection = null
  }
  disposeSection = prompt.section({
    name: SECTION_NAME,
    order: resolvePersonaOrder(prompt),
    text: personaText(),
  })
}

export const inject = ['webServer', 'systemPrompt']

export function apply(ctx, config) {
  // 人格 section：名字用本包自己的，绝不使用注册表保留的
  // `deployment:persona-prefix` / `deployment:persona-suffix`。
  ctx.effect(() => {
    remountPersona(ctx.systemPrompt)
    return () => {
      if (disposeSection !== null) {
        try {
          disposeSection()
        } catch {
          // 交由插件 fiber 回收
        }
        disposeSection = null
      }
    }
  }, `${PACKAGE_ID}: persona section`)

  // 设定与表情包清单都就绪之后再重挂一次：文件里的版本盖过默认底稿，
  // 人格正文也顺带带上表情包约定。
  void Promise.all([ensureLoaded(ctx), ensureStickers(ctx), ensureHero(ctx)]).then(() => {
    remountPersona(ctx.systemPrompt)
    ctx.logger?.info?.(`${PACKAGE_ID}: 表情包 ${stickers.items.length} 张（清单 ${STICKER_FILE}）；欢迎页形象 ${heroAsset.ready === true ? state.hero.image : '未就绪（' + heroAsset.reason + '）'}`)
  })

  // fenced 状态路由。GET /cyrene/state 读，POST /cyrene/state 写。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        try {
          if (route === '/state' && req.method === 'GET') {
            await Promise.all([ensureLoaded(ctx), ensureHero(ctx)])
            sendJson(res, 200, { ok: true, value: publicState() })
            return
          }
          if (route === '/state' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            // 写入必须声明"我读到的是哪一版"：
            //  - 旧版客户端半（或任何不带 rev 的脚本）一律拒绝，避免旧快照覆盖新设定；
            //  - 版本对不上说明别处已经改过，交回最新快照让客户端自己重来。
            if (!Number.isInteger(body?.rev)) {
              noteWrite(body, 'client-outdated')
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: 'client-outdated',
                  message: '这个页面还是旧版本，请按 F5 刷新后重试',
                },
              })
              return
            }
            if (body.rev !== state.rev) {
              noteWrite(body, 'stale')
              sendJson(res, 409, {
                ok: false,
                error: {
                  code: 'stale',
                  message: '设定已在别处改动，已为你重新载入最新版本，请再操作一次',
                },
              })
              return
            }
            const changed = applyPatch(body)
            if (changed) {
              state.rev += 1
              // 换了欢迎页形象就重新解析一次（同一份路径可能只是换了张图）。
              if (body.hero !== undefined) {
                heroPromise = null
                await ensureHero(ctx)
              }
              await persist(ctx)
              // 立刻按新设定重挂 section：从下一轮对话起就是新口吻。
              remountPersona(ctx.systemPrompt)
            }
            noteWrite(body, changed ? 'ok' : 'noop')
            sendJson(res, 200, { ok: true, value: publicState() })
            return
          }
          if (route === '/stickers' && req.method === 'GET') {
            await ensureStickers(ctx, url.searchParams.get('reload') === '1')
            sendJson(res, 200, { ok: true, value: publicStickers() })
            return
          }
          if (route.startsWith('/sticker/') && req.method === 'GET') {
            await ensureStickers(ctx)
            const id = decodeURIComponent(route.slice('/sticker/'.length))
            const item = stickers.items.find((entry) => entry.id === id)
            if (item === undefined) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `没有这张表情包：${id}` },
              })
              return
            }
            await sendAsset(req, res, item)
            return
          }
          if (route === '/hero' && req.method === 'GET') {
            await ensureHero(ctx, url.searchParams.get('reload') === '1')
            if (heroAsset.ready !== true) {
              sendJson(res, 404, {
                ok: false,
                error: {
                  code: 'not-found',
                  message: `欢迎页形象读不出来（${heroAsset.reason}）：${state.hero.image}`,
                },
              })
              return
            }
            await sendAsset(req, res, heroAsset)
            return
          }
          if (route === '/report' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, value: lastReport })
            return
          }
          if (route === '/report' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const text = JSON.stringify(body ?? null)
            if (text.length > MAX_REPORT_BYTES) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'too-large', message: `报告过大（${text.length} 字节，上限 ${MAX_REPORT_BYTES}）` },
              })
              return
            }
            lastReport = { at: new Date().toISOString(), payload: body ?? null }
            sendJson(res, 200, { ok: true, value: { at: lastReport.at } })
            return
          }
          sendJson(res, 404, {
            ok: false,
            error: { code: 'not-found', message: `没有这个路由：${req.method} ${route}` },
          })
        } catch (error) {
          ctx.logger?.warn?.(`${PACKAGE_ID}: ${req.method} ${route} 失败`, error)
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-request', message: error?.message ?? String(error) },
          })
        }
      },
    }),
    `${PACKAGE_ID}: state route`,
  )

  ctx.logger?.info?.(`${PACKAGE_ID}: 昔涟人格已挂载（设定文件 ${statePath()}）`)
}
