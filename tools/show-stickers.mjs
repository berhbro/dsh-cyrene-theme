// 把清单渲染成「【表情包】」段的样子，方便人眼复核（不参与运行，纯展示）。
// 用法：node tools/show-stickers.mjs
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(PLUGIN_DIR, 'stickers.json'), 'utf8'))
const items = (manifest.items ?? []).map((item) => ({
  ...item,
  abs: resolve(PLUGIN_DIR, item.file).replace(/\\/g, '/'),
}))

const lines = [
  '【表情包】',
  `你手边有 ${items.length} 张自己的表情包。要贴的时候，从下面挑一张，把整行（含 Markdown）单独放在回复的最后一行——路径连尖括号一起复制，不要改写、不要自己拼。`,
  ...items.map((item) => `- ${item.label}｜${item.when} → ![昔涟·${item.label}](<${item.abs}>)`),
  `规矩：一轮最多 ${manifest.maxPerTurn ?? 1} 张；只在情绪真的到了的时候贴；代码、命令、报错、技术结论旁边不要贴；拿不准就不贴。`,
]
console.log(lines.join('\n'))
console.log(`\n[共 ${items.length} 张，清单 ${resolve(PLUGIN_DIR, 'stickers.json')}]`)
