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

/** 把一句查询切成立体词：「阿格莱雅 关系」「白厄、童年」「三月七」都当多词处理。 */
function splitTerms(query) {
  const raw = String(query || '')
    .toLowerCase()
    .split(/[\s,，、;；/|·・。.!！?？:："'“”‘’（）()【】\[\]]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 || /[\u4e00-\u9fa5a-z0-9]/i.test(term));
  const unique = [];
  for (const term of raw) if (!unique.includes(term)) unique.push(term);
  return unique;
}

/** 查询里带了「关系 / 故事 / 解析 / 档案」这种词时，优先那一类。 */
const CATEGORY_HINTS = [
  { key: 'relation', words: ['关系', '彼此', '羁绊', '朋友', '同伴', '相处'] },
  { key: 'story', words: ['故事', '经历', '过去', '童年', '童年时', '身世', '背景'] },
  { key: 'analysis', words: ['解析', '分析', '设定', '意象', '解读', '评价', '性格'] },
  { key: 'archive', words: ['档案', '资料', '信息', '属性', '命途', '城邦', '阵营'] },
];

function categoryHint(query) {
  const text = String(query || '');
  for (const rule of CATEGORY_HINTS) {
    if (rule.words.some((word) => text.includes(word))) return rule.key;
  }
  return '';
}

/** 没点名要哪一类时，档案（它是总览）优先，其次故事。 */
const DEFAULT_BONUS = { archive: 6, story: 3, relation: 1, analysis: 0 };

/**
 * 命中得分：先按「触发词命中几个查询词」排，再看是否正好是那个词、
 * 以及查询里有没有点名要哪一类；一个都没命中触发词时，退回正文里找
 * ——地名、专有名词（如「哀丽秘榭」）不一定被写进 keys。
 */
export function matchEntries(entries, query, limit = 6) {
  const list = Array.isArray(entries) ? entries : [];
  const terms = splitTerms(query);
  if (terms.length === 0) return [];
  const hint = categoryHint(query);

  const scored = [];
  for (const item of list) {
    const matched = [];
    let termHits = 0;
    let weight = 0;
    for (const term of terms) {
      let hitKey = '';
      for (const key of item.keys) {
        const folded = key.toLowerCase();
        if (folded === '' || !(folded.includes(term) || term.includes(folded))) continue;
        hitKey = key;
        if (folded === term) weight += 8;
        break;
      }
      if (hitKey === '') continue;
      termHits += 1;
      matched.push(hitKey);
    }
    if (termHits === 0) continue;
    const nameHit = terms.some((term) => item.name.toLowerCase().includes(term) || String(item.character).toLowerCase().includes(term));
    scored.push({
      item,
      score: termHits * 20 + weight + (nameHit ? 3 : 0) + (DEFAULT_BONUS[item.category] || 0) + (hint !== '' && item.category === hint ? 14 : 0),
      hits: matched,
    });
  }

  // 触发词一个都没中：退回正文子串检索（只在前一种完全没结果时发生）。
  if (scored.length === 0) {
    for (const item of list) {
      const content = item.content.toLowerCase();
      const found = [];
      let weight = 0;
      for (const term of terms) {
        let count = 0;
        let from = content.indexOf(term);
        while (from !== -1 && count < 3) {
          count += 1;
          from = content.indexOf(term, from + term.length);
        }
        if (count === 0) continue;
        found.push(term);
        weight += count;
      }
      if (found.length === 0) continue;
      scored.push({
        item,
        score: found.length * 10 + Math.min(weight, 6) + (DEFAULT_BONUS[item.category] || 0) + (hint !== '' && item.category === hint ? 14 : 0),
        hits: found,
      });
    }
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
