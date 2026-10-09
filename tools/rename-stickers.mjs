// 一次性迁移：把 meme/ 里的原始文件名（时间戳/哈希）改成清单里的「表情名字」。
// 清单是唯一真相——文件跟着 label 走，清单里的 file 字段同步更新。
//
//   node tools/rename-stickers.mjs --dry     # 只看要做什么
//   node tools/rename-stickers.mjs           # 真改
//
// 有一步失败就把已改的滚回去，不会留下"文件改了、清单没改"的半截状态。
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = resolve(PLUGIN_DIR, 'stickers.json')
const dry = process.argv.includes('--dry')

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const dir = manifest.dir ?? 'meme'
const plan = []

for (const item of manifest.items) {
  const oldAbs = resolve(PLUGIN_DIR, item.file)
  const newRel = `${dir}/${item.label}${extname(oldAbs).toLowerCase()}`
  const newAbs = resolve(PLUGIN_DIR, newRel)
  plan.push({ item, oldAbs, newRel, newAbs, same: oldAbs === newAbs })
}

for (const step of plan) {
  if (step.same) continue
  if (!existsSync(step.oldAbs)) throw new Error(`源文件不在：${step.oldAbs}`)
  if (existsSync(step.newAbs)) throw new Error(`目标已存在，先处理它：${step.newAbs}`)
}

const done = []
try {
  for (const step of plan) {
    if (step.same) continue
    if (!dry) renameSync(step.oldAbs, step.newAbs)
    done.push(step)
    step.item.file = step.newRel
    console.log(`${dry ? '[dry] ' : ''}${step.oldAbs.slice(PLUGIN_DIR.length + 1)}  →  ${step.newRel}`)
  }
  if (!dry) writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
} catch (error) {
  for (const step of done.reverse()) {
    step.item.file = step.oldAbs.slice(PLUGIN_DIR.length + 1).replace(/\\/g, '/')
    if (!dry && existsSync(step.newAbs)) renameSync(step.newAbs, step.oldAbs)
  }
  throw error
}

console.log(`\n${dry ? '（dry run，什么都没动）' : `已改名 ${done.length} 个，清单已同步：${MANIFEST}`}`)
