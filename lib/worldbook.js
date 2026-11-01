/**
 * 世界书的「原料加工厂」：把官方 wiki 的原始 JSON 切成可检索的条目。
 *
 * 这个模块只做纯数据转换，不碰文件系统、不碰 Cordis 上下文——
 * 所以既能被宿主半 `lib/index.js` 当成工具调用，也能被命令行脚本单独跑。
 */

export const SCHEMA_VERSION = 1;
export const ENTRY_MAX = 1500;
export const ENTRY_MIN = 30;
export const NAME_MAX = 80;
export const CONTENT_MAX = 6000;
export const KEY_MAX = 12;
export const KEY_LEN = 24;

/** 官方正文里混着 `\\n` 这种双重转义，先还原成真换行。 */
function unescapeText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
}

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** 富文本 → 纯文本：保留段落结构，别把整段粘成一行。 */
export function stripHtml(input) {
  let text = unescapeText(input);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n');
  text = text.replace(/<li[^>]*>/gi, '- ');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&[a-z#0-9]+;/gi, (token) => ENTITIES[token.toLowerCase()] ?? token);
  text = text.replace(/\r/g, '');
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 章节结构是 `{components:[{data:"<json 字符串>"}]}`，要再解析一层。 */
function sheet(section) {
  const raw = section && Array.isArray(section.components) ? section.components[0] : null;
  const data = raw && raw.data;
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 按段落边界切块，单块不超过 max；实在没有段落边界就硬切。 */
export function chunkText(text, max = ENTRY_MAX) {
  const source = String(text || '').trim();
  if (source === '') return [];
  if (source.length <= max) return [source];
  const blocks = source.split(/\n{2,}/);
  const out = [];
  let buffer = '';
  const flush = () => {
    const piece = buffer.trim();
    if (piece !== '') out.push(piece);
    buffer = '';
  };
  for (const block of blocks) {
    if (block.length > max) {
      flush();
      for (let index = 0; index < block.length; index += max) out.push(block.slice(index, index + max));
      continue;
    }
    if (buffer === '') buffer = block;
    else if (buffer.length + block.length + 2 <= max) buffer += '\n\n' + block;
    else {
      flush();
      buffer = block;
    }
  }
  flush();
  return out;
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function cleanKeys(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(item || '').replace(/\s+/g, ' ').trim().slice(0, KEY_LEN);
    if (key === '') continue;
    const folded = key.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(key);
    if (out.length >= KEY_MAX) break;
  }
  return out;
}

function entry({ id, character, category, name, keys, content }) {
  const body = String(content || '').trim().slice(0, CONTENT_MAX);
  if (body.length < ENTRY_MIN) return null;
  return {
    id: String(id).slice(0, 64),
    character: cleanName(character),
    category,
    name: cleanName(name),
    keys: cleanKeys([character, ...keys]),
    content: body,
  };
}

/** 角色档案：三行键值对。第一行的左值是世界名，单独提出来当「来自」。 */
function archiveEntry(character, info) {
  const rows = Array.isArray(info?.list) ? info.list : [];
  const lines = [];
  let origin = '';
  for (const row of rows) {
    const meta = row?.textMapMeta || {};
    const left = stripHtml(meta.leftValue?.data);
    const label = stripHtml(meta.rightKey?.data);
    const value = stripHtml(meta.rightValue?.data);
    if (left !== '' && origin === '') origin = left;
    if (label === '' && value === '') continue;
    lines.push(label === '' ? value : `${label}：${value}`);
  }
  if (origin !== '') lines.unshift(`来自：${origin}`);
  if (lines.length === 0) return [];
  return [entry({
    id: `wiki-${character.cid}-archive`,
    character: character.name,
    category: 'archive',
    name: `${character.name} · 档案`,
    keys: [character.name],
    content: lines.join('\n'),
  })].filter(Boolean);
}

/** 角色故事：开场白 + 逐级解锁的段落，超长才切。 */
function storyEntries(character, story) {
  const parts = [];
  const lead = stripHtml(story?.detail);
  if (lead !== '') parts.push(lead);
  for (const chapter of Array.isArray(story?.list) ? story.list : []) {
    const body = stripHtml(chapter?.desc);
    if (body !== '') parts.push(body);
  }
  const whole = parts.join('\n\n');
  if (whole.length < ENTRY_MIN) return [];
  const chunks = chunkText(whole);
  return chunks.map((content, index) => entry({
    id: `wiki-${character.cid}-story-${index + 1}`,
    character: character.name,
    category: 'story',
    name: chunks.length === 1 ? `${character.name} · 角色故事` : `${character.name} · 角色故事（${index + 1}/${chunks.length}）`,
    keys: [character.name],
    content,
  })).filter(Boolean);
}

/** 角色关系：一行一个人，两边名字都进触发词；同一个人出现多次时合并。 */
function relationEntries(character, relation) {
  const grouped = new Map();
  const lists = Array.isArray(relation?.list) ? relation.list : [];
  for (const list of lists) {
    for (const row of Array.isArray(list?.table) ? list.table : []) {
      const other = cleanName(row?.role?.title);
      const desc = stripHtml(row?.desc);
      if (other === '' || desc === '') continue;
      const kind = stripHtml(row?.relation);
      const line = kind === '' || desc.includes(kind) ? desc : `${kind}：${desc}`;
      const bucket = grouped.get(other) || [];
      if (!bucket.some((item) => item === line)) bucket.push(line);
      grouped.set(other, bucket);
    }
  }
  const out = [];
  let index = 0;
  for (const [other, lines] of grouped) {
    index += 1;
    const built = entry({
      id: `wiki-${character.cid}-relation-${index}`,
      character: character.name,
      category: 'relation',
      name: `${character.name} × ${other}`,
      keys: [other],
      content: `${character.name} × ${other}\n${lines.join('\n')}`,
    });
    if (built) out.push(built);
  }
  return out;
}

/**
 * 官方解析数据里同一小节会出现「越来越长」的累积版本。
 * 短的那份一定被长的那份包含，所以直接丢掉被包含的，只留最完整的一份。
 */
function dedupeCumulative(texts) {
  const sorted = [...texts].sort((a, b) => b.length - a.length);
  const kept = [];
  for (const text of sorted) {
    if (kept.some((longer) => longer.includes(text))) continue;
    kept.push(text);
  }
  return kept;
}

/** 角色解析：长文按「一、二、三…」这类小标题切段，没有再按长度切。 */
function analysisEntries(character, analysis) {
  const texts = [];
  const lists = Array.isArray(analysis?.list) ? analysis.list : [];
  for (const list of lists) {
    for (const row of Array.isArray(list?.table) ? list.table : []) {
      const body = stripHtml(row?.desc);
      if (body !== '') texts.push(body);
    }
  }
  const whole = dedupeCumulative(texts).join('\n\n');
  if (whole.length < ENTRY_MIN) return [];
  const sections = [];
  let buffer = '';
  for (const paragraph of whole.split(/\n{2,}/)) {
    const isHeading = paragraph.length <= 40 && /^[一二三四五六七八九十]+[、.]/.test(paragraph);
    if (isHeading && buffer.trim() !== '') {
      sections.push(buffer);
      buffer = paragraph;
    } else if (buffer === '') buffer = paragraph;
    else buffer += '\n\n' + paragraph;
  }
  if (buffer.trim() !== '') sections.push(buffer);
  const out = [];
  for (const section of sections) {
    for (const content of chunkText(section)) {
      out.push(entry({
        id: `wiki-${character.cid}-analysis-${out.length + 1}`,
        character: character.name,
        category: 'analysis',
        name: `${character.name} · 解析（${out.length + 1}）`,
        keys: [character.name],
        content,
      }));
    }
  }
  return out.filter(Boolean);
}

/** 估算一条角色记录的「资料量」，用来在同名重复条目里挑最完整的那份。 */
function weighCharacter(raw) {
  let total = 0;
  const story = sheet(raw?.character_story);
  total += stripHtml(story?.detail).length;
  for (const chapter of Array.isArray(story?.list) ? story.list : []) total += stripHtml(chapter?.desc).length;
  const analysis = sheet(raw?.character_analysis);
  for (const list of Array.isArray(analysis?.list) ? analysis.list : []) {
    for (const row of Array.isArray(list?.table) ? list.table : []) total += stripHtml(row?.desc).length;
  }
  const relation = sheet(raw?.character_relation);
  for (const list of Array.isArray(relation?.list) ? relation.list : []) {
    total += Array.isArray(list?.table) ? list.table.length * 20 : 0;
  }
  const info = sheet(raw?.character_info);
  total += Array.isArray(info?.list) ? info.list.length * 10 : 0;
  return total;
}

/** wiki 原始 `data.content_list` → 世界书条目。 */
export function buildEntries(data) {
  const list = Array.isArray(data?.content_list) ? data.content_list : [];
  // 同一个角色在 content_list 里可能出现两次（其中一份只有几行占位文本），
  // 按资料量留最完整的那份，否则关系条目会成对重复。
  const best = new Map();
  for (const raw of list) {
    const info = raw?.base_info || {};
    const name = cleanName(info.name);
    if (name === '') continue;
    const weight = weighCharacter(raw);
    const kept = best.get(name);
    if (!kept || weight > kept.weight) best.set(name, { raw, weight });
  }
  const out = [];
  for (const [name, { raw }] of best) {
    const info = raw?.base_info || {};
    const character = { name, cid: String(raw.content_id || info.avatarId || '') };
    if (character.cid === '') continue;
    out.push(...archiveEntry(character, sheet(raw.character_info)));
    out.push(...storyEntries(character, sheet(raw.character_story)));
    out.push(...relationEntries(character, sheet(raw.character_relation)));
    out.push(...analysisEntries(character, sheet(raw.character_analysis)));
  }
  return out;
}

const CATEGORIES = new Set(['archive', 'story', 'relation', 'analysis']);

/** 从磁盘读回来的东西不可信：逐字段兜底，坏条目直接丢掉。 */
export function sanitizeEntries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(id) || seen.has(id)) continue;
    const content = String(item.content || '').trim().slice(0, CONTENT_MAX);
    if (content.length < ENTRY_MIN) continue;
    const category = String(item.category || '');
    seen.add(id);
    out.push({
      id,
      character: cleanName(item.character),
      category: CATEGORIES.has(category) ? category : 'analysis',
      name: cleanName(item.name) || id,
      keys: cleanKeys(item.keys),
      content,
    });
    if (out.length >= 4000) break;
  }
  return out;
}

/** 包成可以直接落盘的一份文档。 */
export function packWorldbook(entries, meta = {}) {
  return {
    schema: SCHEMA_VERSION,
    source: String(meta.source || 'https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index?lang=zh-cn'),
    sourceVersion: String(meta.sourceVersion || ''),
    fetchedAt: String(meta.fetchedAt || new Date().toISOString()),
    entries: sanitizeEntries(entries),
  };
}

/** 命中得分：短词权重更高，命中条数越多越高。 */
export function matchEntries(entries, query, limit = 6) {
  const text = String(query || '').toLowerCase();
  const list = Array.isArray(entries) ? entries : [];
  if (text.trim() === '') return [];
  const scored = [];
  for (const item of list) {
    let score = 0;
    let hits = 0;
    const nameHits = [];
    for (const key of item.keys) {
      const folded = key.toLowerCase();
      if (folded === '' || !text.includes(folded)) continue;
      hits += 1;
      score += folded.length >= 2 ? folded.length : 1;
      nameHits.push(key);
    }
    if (hits === 0) continue;
    if (item.category === 'archive') score += 3;
    if (item.category === 'story') score += 1;
    scored.push({ item, score, hits: nameHits });
  }
  scored.sort((a, b) => b.score - a.score || a.item.content.length - b.item.content.length);
  return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 6))).map((row) => ({
    ...row.item,
    matched: row.hits,
    score: row.score,
  }));
}

/** 分类的展示名：面板与卡片上写中文，state 里仍用英文键。 */
export const CATEGORY_LABELS = { archive: '档案', story: '故事', relation: '关系', analysis: '解析' };

/** 面板要的一份轻量索引：不背正文。 */
export function summarizeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const characters = new Map();
  const categories = { archive: 0, story: 0, relation: 0, analysis: 0 };
  for (const item of list) {
    categories[item.category] = (categories[item.category] || 0) + 1;
    const name = item.character || '（未标注）';
    const row = characters.get(name) || { name, total: 0, archive: 0, story: 0, relation: 0, analysis: 0 };
    row.total += 1;
    row[item.category] = (row[item.category] || 0) + 1;
    characters.set(name, row);
  }
  return {
    count: list.length,
    characters: [...characters.values()].sort((a, b) => b.total - a.total),
    categories: Object.entries(categories)
      .filter(([, total]) => total > 0)
      .map(([key, total]) => ({ key, label: CATEGORY_LABELS[key] ?? key, total })),
  };
}
