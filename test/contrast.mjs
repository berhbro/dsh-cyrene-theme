/**
 * 主题可读性自检：从 lib/client.js 里抠出本包写下的 `--dsw-alias-*` token，
 * 做 alpha 合成后算 WCAG 对比度，确认粉白主题下的文字仍然读得清。
 *
 *   node test/contrast.mjs
 *
 * 面板是半透明的，所以真正的底色 = 半透明面板层 composited 到渐变背景上；
 * 浅色背景按"最不利的那一角"取（粉最浓的地方），深色同理。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const source = await readFile(CLIENT, 'utf8')

// ── 从 CSS 里取 token ────────────────────────────────────────────────────
function tokensOf(selector) {
  const start = source.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  const body = source.slice(open + 1, close)
  const map = new Map()
  for (const line of body.split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (m) map.set(m[1], m[2].trim())
  }
  return map
}

const LIGHT = tokensOf('body[data-dsh-cyrene][data-cyrene-skin="on"]{')
const DARK = tokensOf('body[data-dsh-cyrene][data-cyrene-skin="on"][data-ds-dark-theme]{')

// ── 颜色工具 ─────────────────────────────────────────────────────────────
function parse(value) {
  let m = /^#([0-9a-f]{6})$/i.exec(value)
  if (m) {
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  m = /^#([0-9a-f]{3})$/i.exec(value)
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16))
    return [r, g, b, 1]
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  throw new Error(`cannot parse color: ${value}`)
}

/** src 按 alpha 叠在 dst 上。 */
function over(src, dst) {
  const [r1, g1, b1, a1] = parse(src)
  const [r2, g2, b2, a2] = parse(dst)
  const mix = (a, b) => a1 * a + (1 - a1) * b
  return `rgb(${Math.round(mix(r1, r2))}, ${Math.round(mix(g1, g2))}, ${Math.round(mix(b1, b2))})`
}

function luminance(color) {
  const [r, g, b] = parse(color).slice(0, 3)
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function ratio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

// 背景取下限（最不利）：浅色取粉最浓的角落，深色取最亮的角落。
const BACKDROPS = {
  light: ['#ffdcee', '#fdf3fb'],
  dark: ['#2b1c30', '#20141f'],
}

// 文字实际上坐在这些半透明层上（取最不利的那个）。
const SURFACES = {
  light: ['--dsw-alias-bg-layer-3', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1', '--dsw-specific-input-major'],
  dark: ['--dsw-alias-bg-layer-3', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1', '--dsw-specific-input-major'],
}

const LABELS = {
  '--dsw-alias-label-primary': 7,
  '--dsw-alias-label-primary-bluish': 7,
  '--dsw-alias-label-secondary': 4.5,
  '--dsw-alias-label-primary-dimmed': 4.5,
  '--dsw-alias-label-caption': 4.5,
  '--dsw-alias-label-tertiary': 4.5,
  '--dsw-alias-label-deep-diving': 4.5,
}

const rows = []
const failures = []

for (const [mode, map] of [
  ['light', LIGHT],
  ['dark', DARK],
]) {
  const surfaceValues = SURFACES[mode].map((k) => map.get(k)).filter(Boolean)
  for (const [token, floor] of Object.entries(LABELS)) {
    const fg = map.get(token)
    if (!fg) {
      failures.push(`${mode}: ${token} missing`)
      continue
    }
    let worst = Infinity
    let worstCase = ''
    for (const backdrop of BACKDROPS[mode]) {
      for (const surface of surfaceValues) {
        const bg = over(surface, backdrop)
        const value = ratio(fg, bg)
        if (value < worst) {
          worst = value
          worstCase = `on ${surface} / ${backdrop}`
        }
      }
    }
    const pass = worst >= floor
    if (!pass) failures.push(`${mode}: ${token} = ${worst.toFixed(2)}:1 (需要 ≥ ${floor}) ${worstCase}`)
    rows.push({ mode, token, value: `${worst.toFixed(2)}:1`, floor, pass })
  }
}

// 品牌填充上的文字（按钮），大字号/粗体按 3:1 计。
for (const [mode, map] of [
  ['light', LIGHT],
  ['dark', DARK],
]) {
  for (const [fill, text] of [
    ['--dsw-alias-brand-primary', '--dsw-alias-brand-text'],
    ['--dsw-alias-button-info-fill', '--dsw-alias-label-primary-foreground'],
  ]) {
    const f = map.get(fill)
    const t = map.get(text)
    if (!f || !t) continue
    const value = ratio(t, f)
    const pass = value >= 3
    if (!pass) failures.push(`${mode}: ${t} on ${fill} = ${value.toFixed(2)}:1 (需要 ≥ 3)`)
    rows.push({ mode, token: `${t} on ${fill}`, value: `${value.toFixed(2)}:1`, floor: 3, pass })
  }
}

// 语义状态色：多数当圆点/描边用（图形 ≥3:1），其中 error 也常当文字用。
const STATES = [
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-business-primary',
]

for (const [mode, map] of [
  ['light', LIGHT],
  ['dark', DARK],
]) {
  const surfaceValues = SURFACES[mode].map((k) => map.get(k)).filter(Boolean)
  for (const token of STATES) {
    const fg = map.get(token)
    if (!fg) continue
    let worst = Infinity
    for (const backdrop of BACKDROPS[mode]) {
      for (const surface of surfaceValues) {
        worst = Math.min(worst, ratio(fg, over(surface, backdrop)))
      }
    }
    const floor = token.endsWith('warn-label') || token.endsWith('error-primary') ? 4.5 : 3
    const pass = worst >= floor
    if (!pass) failures.push(`${mode}: ${token} = ${worst.toFixed(2)}:1 (需要 ≥ ${floor})`)
    rows.push({ mode, token, value: `${worst.toFixed(2)}:1`, floor, pass })
  }
}

// 本包自绘的主按钮：渐变填充 + 深色字（白字在浅粉上只有 2.1:1，不能用）。
{
  const gradient = /\.cyre-primary\{[^}]*background:linear-gradient\([^)]*?((?:#[0-9a-f]{3,6})(?:\s*,\s*#[0-9a-f]{3,6})+)\)/i.exec(source)
  const ink = /\.cyre-primary\{[^}]*color:(#[0-9a-f]{3,6})/i.exec(source)
  if (!gradient || !ink) {
    failures.push('light: .cyre-primary 渐变色或文字色没解析出来')
  } else {
    for (const stop of gradient[1].split(',').map((s) => s.trim())) {
      const value = ratio(ink[1], stop)
      const pass = value >= 4.5
      if (!pass) failures.push(`light: .cyre-primary 文字 ${ink[1]} 在 ${stop} 上 = ${value.toFixed(2)}:1 (需要 ≥ 4.5)`)
      rows.push({ mode: 'light', token: `.cyre-primary 文字 / ${stop}`, value: `${value.toFixed(2)}:1`, floor: 4.5, pass })
    }
  }
}

// 工具提示：背景是实心深色，文字用 label-primary-inverted。
{
  const bg = LIGHT.get('--dsw-alias-tooltip-bg')
  const fg = LIGHT.get('--dsw-alias-label-primary-inverted')
  if (bg && fg) {
    const value = ratio(fg, bg)
    const pass = value >= 4.5
    if (!pass) failures.push(`light: tooltip 文字 = ${value.toFixed(2)}:1 (需要 ≥ 4.5)`)
    rows.push({ mode: 'light', token: 'tooltip 文字', value: `${value.toFixed(2)}:1`, floor: 4.5, pass })
  }
}

const width = Math.max(...rows.map((r) => r.token.length))
for (const r of rows) {
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.mode.padEnd(5)} ${r.token.padEnd(width)} ${r.value.padStart(8)}  (≥${r.floor})`)
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${rows.length - failures.length}/${rows.length}`)
for (const f of failures) console.log(`  · ${f}`)
assert.equal(failures.length, 0)
