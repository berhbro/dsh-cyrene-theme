#!/usr/bin/env node
/**
 * 把官方 wiki 抓下来、转成世界书 JSON。
 *
 *   node tools/build-worldbook.mjs                     # 抓线上、写到 ~/.dsh/cyrene-worldbook.json
 *   node tools/build-worldbook.mjs --source ./wiki.json # 用本地已经存好的原始 JSON
 *   node tools/build-worldbook.mjs --out ./wb.json     # 换个落盘位置
 *
 * 只依赖 Node 自带能力（fetch / fs），不发 npm 依赖。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildEntries, packWorldbook, summarizeEntries } from '../lib/worldbook.js';

const WIKI_URL = 'https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index';

function argOf(name, fallback) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const source = argOf('source', '');
const lang = argOf('lang', 'zh-cn');
const out = resolve(argOf('out', join(homedir(), '.dsh', 'cyrene-worldbook.json')));

async function loadRaw() {
  if (source === '') {
    const url = `${WIKI_URL}?lang=${encodeURIComponent(lang)}`;
    process.stdout.write(`抓取 ${url}\n`);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const text = await response.text();
    process.stdout.write(`收到 ${Buffer.byteLength(text)} 字节\n`);
    return { raw: JSON.parse(text), label: url };
  }
  const path = resolve(source);
  const text = await readFile(path, 'utf8');
  process.stdout.write(`读取 ${path}（${Buffer.byteLength(text)} 字节）\n`);
  return { raw: JSON.parse(text), label: path };
}

const { raw, label } = await loadRaw();
if (raw?.retcode !== 0 || raw?.data === null || raw?.data === undefined) {
  throw new Error(`接口没给数据：retcode=${raw?.retcode} message=${raw?.message}`);
}

const entries = buildEntries(raw.data);
if (entries.length === 0) throw new Error('一条条目都没切出来，先看看 data.content_list 的结构');
const document = packWorldbook(entries, {
  source: label,
  sourceVersion: String(raw.data.current_version || ''),
});

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(document, null, 2) + '\n', 'utf8');

const stats = summarizeEntries(document.entries);
const bytes = Buffer.byteLength(JSON.stringify(document));
process.stdout.write(
  [
    `写出 ${out}`,
    `版本 ${document.sourceVersion || '（未知）'}`,
    `条目 ${stats.count} 条 / ${Math.round(bytes / 1024)} KB`,
    `分类 档案 ${stats.categories.archive}、故事 ${stats.categories.story}、关系 ${stats.categories.relation}、解析 ${stats.categories.analysis}`,
    `角色 ${stats.characters.map((row) => `${row.name}(${row.total})`).join('、')}`,
    '',
  ].join('\n'),
);
