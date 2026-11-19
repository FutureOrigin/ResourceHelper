/**
 * 整页快照的纯逻辑（P8）
 *
 * 目标：把当前网页存成一个**脱网也能打开**的 HTML 文件 —— 图片、样式表、字体、
 * 背景图全部内联成 data URI，脚本与跳转类 meta 去掉。
 *
 * 这个模块不碰 DOM、不碰网络、不碰 chrome API，只负责"文本怎么改"：
 *   - 占位符协议：内容脚本把每个要内联的地址换成 `rhres://<token>/<n>`，
 *     侧边栏抓完字节后一次性替换。用唯一 token 而不是"标记注释"，
 *     是因为页面上可能本来就存在类似的字符串（碰撞），而 token 是随机生成的。
 *   - CSS 扫描/重写：`url(...)`、`@import`；相对地址按样式表自身地址解析。
 *   - 转义：`srcdoc` / `style` 属性 / `<style>` 文本三种上下文规则不同，
 *     写错任一处的后果都是"文件打开是乱码或被截断"。
 *
 * 为什么不直接用 SingleFile：它是 AGPL-3.0，本仓库是 Apache-2.0，
 * 直接复制代码会造成许可证冲突（见 docs/ARCHIVE.md §许可证）。
 * 这里只借鉴"单文件归档"这个问题本身的解法，实现与代码均为独立编写。
 */

import { buildFilename } from './decision.js';

/** 资源占位符协议（HTML 属性 / CSS 文本里） */
export const ARCHIVE_SCHEME = 'rhres';
/** 子框架占位符协议（iframe 的 src 上） */
export const FRAME_SCHEME = 'rhframe';

/** 内联预算：超过就退回"保留在线地址"，而不是把浏览器撑爆 */
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  // 单个资源（一张图 / 一个字体）上限
  maxResourceBytes: 4 * 1024 * 1024,
  // 整份快照里所有内联字节的上限（base64 后还会涨约 1/3，但落盘的是字符串，这里按原始字节算）
  maxTotalBytes: 40 * 1024 * 1024,
  // 最多内联多少个资源（保护主线程与内存）
  maxResources: 400,
  // 一份快照里最多处理多少个样式表（含 @import 展开）
  maxCssResources: 60,
  // @import 嵌套深度
  maxCssDepth: 3,
  // 最多嵌入多少个子框架
  maxFrames: 20
});

/** 这些协议不可能被扩展 fetch，也不该出现在归档里 */
const UNSAFE_SCHEMES = new Set([
  'data', 'blob', 'javascript', 'mailto', 'tel', 'about', 'chrome', 'chrome-extension',
  'edge', 'moz-extension', 'file', 'filesystem', 'ws', 'wss', 'ftp'
]);

const ATTR_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * 生成一次性 token。
 * @param {Function} [random] 0..1 的随机源（单测注入固定值）
 */
export function createToken(random) {
  const rnd = typeof random === 'function' ? random : Math.random;
  let token = '';
  while (token.length < 10) {
    token += Math.floor(rnd() * 36 ** 2).toString(36).padStart(2, '0');
  }
  return token.slice(0, 10);
}

/** 资源占位符文本 */
export function placeholderFor(token, index) {
  return ARCHIVE_SCHEME + '://' + String(token) + '/' + String(index);
}

/** 子框架占位符文本 */
export function framePlaceholderFor(token, index) {
  return FRAME_SCHEME + '://' + String(token) + '/' + String(index);
}

/** 从一段占位符文本里取回索引；不是本 token 的占位符返回 null */
export function parsePlaceholder(value, token, scheme) {
  const prefix = (scheme || ARCHIVE_SCHEME) + '://' + String(token) + '/';
  const text = typeof value === 'string' ? value : '';
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

/** 匹配本 token 全部占位符的正则（用于一次性替换整份 HTML） */
export function placeholderPattern(token, scheme) {
  const prefix = escapeRegExp((scheme || ARCHIVE_SCHEME) + '://' + String(token) + '/');
  return new RegExp(prefix + '(\\d+)', 'g');
}

/**
 * 一次性替换整份文本里的占位符。
 * 使用函数作为替换值：返回串里的 `$&`、`$1` 不会被再次解释（data URI 里不会出现，但别赌）。
 * 替换结果不会被再次扫描，所以替换进去的内容里即使含占位符也不会被二次展开。
 *
 * @param {string} text
 * @param {string} token
 * @param {(index:number)=>string|null|undefined} resolve 返回 null/undefined 表示"保持原样"
 * @param {string} [scheme]
 */
export function replacePlaceholders(text, token, resolve, scheme) {
  const source = typeof text === 'string' ? text : '';
  const pattern = placeholderPattern(token, scheme);
  return source.replace(pattern, (whole, digits) => {
    let replacement;
    try {
      replacement = resolve(Number(digits));
    } catch (e) {
      return whole;
    }
    return typeof replacement === 'string' ? replacement : whole;
  });
}

/**
 * 把网页里的原始地址解析成绝对地址。
 *
 * 只放行 http/https：`data:` 已经内联、`blob:` 出了页面就失效、
 * `javascript:` 显然不能进归档，这些一律返回失败并带上原因（UI 会如实展示）。
 *
 * @param {string} raw
 * @param {string} base 页面地址（或样式表地址）
 * @returns {{ok:boolean, url:string, reason:string}}
 */
export function normalizeResourceUrl(raw, base) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, url: '', reason: 'EMPTY' };
  // `url(#gradient)` / `href="#top"` 是文档内引用，抓它会变成"抓页面自己"
  if (value.startsWith('#')) return { ok: false, url: '', reason: 'FRAGMENT' };
  let parsed;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch (e) {
    return { ok: false, url: '', reason: 'INVALID' };
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (UNSAFE_SCHEMES.has(scheme)) return { ok: false, url: parsed.href, reason: 'SCHEME' };
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, url: parsed.href, reason: 'SCHEME' };
  // 片段不参与资源身份：同一张图带不带 # 都是同一份字节
  parsed.hash = '';
  return { ok: true, url: parsed.href, reason: '' };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------ */

/**
 * 读一个 `url(...)` token。
 * 支持 `url(x)`、`url( 'x' )`、`url("x")` 与反斜杠转义；不合法返回 null。
 */
function readCssUrlToken(text, start) {
  const len = text.length;
  let i = start + 4; // 跳过 "url("
  while (i < len && /\s/.test(text[i])) i++;

  let value = '';
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    i++;
    while (i < len && text[i] !== quote) {
      if (text[i] === '\\' && i + 1 < len) { value += text[i + 1]; i += 2; continue; }
      value += text[i];
      i++;
    }
    if (text[i] !== quote) return null;
    i++;
    while (i < len && /\s/.test(text[i])) i++;
  } else {
    let raw = '';
    while (i < len && text[i] !== ')') {
      if (text[i] === '\\' && i + 1 < len) { raw += text[i + 1]; i += 2; continue; }
      raw += text[i];
      i++;
    }
    value = raw.trim();
  }

  if (text[i] !== ')') return null;
  return { value: value, end: i + 1 };
}

/** 找出所有 `@import ...;` 语句的区间（按分号/花括号收尾，跳过字符串与括号） */
function findImportStatements(text) {
  const statements = [];
  const re = /@import\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    let i = start + match[0].length;
    let depth = 0;
    let quote = '';
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) quote = '';
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
      if (ch === ';' && depth === 0) { i++; break; }
      if (ch === '{' && depth === 0) break;
      i++;
    }
    statements.push({ start: start, end: i });
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return statements;
}

/** 从 `@import` 语句里取出地址与媒体条件 */
function readImportTarget(text, statement) {
  const inner = text.slice(statement.start, statement.end);
  const urlAt = inner.toLowerCase().indexOf('url(');
  let value = '';
  let consumed = 0;
  if (urlAt >= 0) {
    const token = readCssUrlToken(inner, urlAt);
    if (!token) return null;
    value = token.value;
    consumed = token.end;
  } else {
    const quoted = /(["'])([\s\S]*?)\1/.exec(inner);
    if (!quoted) return null;
    value = quoted[2];
    consumed = quoted.index + quoted[0].length;
  }
  const media = inner.slice(consumed).replace(/;\s*$/, '').trim();
  return { value: value, media: media };
}

/**
 * 扫描一段 CSS 里所有需要处理的引用。
 *
 * 返回按位置排序的引用列表：
 *   { kind:'url', value, start, end }                       —— 整个 url(...) token 的区间
 *   { kind:'import', value, start, end, media }             —— 整个 @import 语句的区间
 *
 * `start/end` 是**整段替换**用的区间：重写时直接把这段换成新文本，
 * 不用去猜括号里原来有没有引号、有没有空格。
 */
export function scanCssReferences(css) {
  const text = typeof css === 'string' ? css : '';
  if (!text) return [];

  const references = [];
  const importSpans = [];

  for (const statement of findImportStatements(text)) {
    const target = readImportTarget(text, statement);
    if (!target) continue;
    references.push({
      kind: 'import',
      value: target.value,
      start: statement.start,
      end: statement.end,
      media: target.media
    });
    importSpans.push(statement);
  }

  const lower = text.toLowerCase();
  let i = 0;
  while (true) {
    const at = lower.indexOf('url(', i);
    if (at < 0) break;
    i = at + 4;
    // 落在 @import 语句里的已经被上面收走了（否则会重复替换）
    if (importSpans.some((span) => at >= span.start && at < span.end)) continue;
    // `myurl(` 这种标识符尾巴不是 CSS 函数
    if (at > 0 && /[A-Za-z0-9_-]/.test(text[at - 1])) continue;
    const token = readCssUrlToken(text, at);
    if (!token || !token.value) continue;
    references.push({ kind: 'url', value: token.value, start: at, end: token.end });
    i = token.end;
  }

  return references.sort((a, b) => a.start - b.start);
}

/**
 * 按引用重写 CSS。
 * @param {string} css
 * @param {Array} references scanCssReferences 的结果
 * @param {(ref:Object)=>string|null} resolve 返回 null 表示"这段不动"
 * @returns {{css:string, replaced:number}}
 */
export function applyCssReferences(css, references, resolve) {
  const text = typeof css === 'string' ? css : '';
  const refs = Array.isArray(references) ? references : [];
  let out = '';
  let cursor = 0;
  let replaced = 0;

  for (const ref of refs) {
    if (ref.start < cursor) continue; // 重叠（异常 CSS）时以先出现的为准
    const replacement = resolve(ref);
    if (typeof replacement !== 'string') continue;
    out += text.slice(cursor, ref.start) + replacement;
    cursor = ref.end;
    replaced++;
  }
  out += text.slice(cursor);
  return { css: out, replaced: replaced };
}

/* ------------------------------------------------------------------ *
 * CSS 精简（体积）
 * ------------------------------------------------------------------ */

/**
 * 选择器词表：文档里真实出现过的标签名 / 类名 / id / 属性名。
 *
 * 内容脚本采集时顺手收集（它看得见活 DOM），侧边栏用它判断"这条规则还有没有
 * 可能匹配"。词表只用于**否定判断**：选择器要求的类名不在词表里，它就绝不可能
 * 匹配，整条规则可以删掉；只要有一项判断不了，就保留 —— 宁可多留，不能删错。
 */
export function normalizeSelectorVocabulary(input) {
  const raw = input && typeof input === 'object' ? input : null;
  if (!raw) return null;
  const toSet = (list) => {
    const set = new Set();
    if (!Array.isArray(list)) return set;
    for (const item of list) {
      if (typeof item === 'string' && item) set.add(item);
    }
    return set;
  };
  const vocabulary = {
    tags: toSet(raw.tags),
    classes: toSet(raw.classes),
    ids: toSet(raw.ids),
    attrs: toSet(raw.attrs)
  };
  // 空词表说明调用方没给有效数据：宁可不动 CSS，也不要把整份样式删光
  if (!vocabulary.tags.size && !vocabulary.classes.size && !vocabulary.ids.size && !vocabulary.attrs.size) {
    return null;
  }
  return vocabulary;
}

/** 这些 at-rule 的块里还是普通规则，可以继续递归精简 */
const PRUNABLE_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'document']);

/**
 * 删掉"不可能匹配当前文档"的 CSS 规则，并顺带去掉注释。
 *
 * 只做必要条件判断：选择器里的每个复合选择器都要求它引用的标签/类/id/属性
 * 在文档里出现过。任何一项判断不了（带参数的伪类、命名空间、嵌套 `&`、
 * 转义失败……）都退回"保留"，所以最坏结果是文件大一点，而不是样式错乱。
 *
 * @param {string} css
 * @param {Object|null} vocabulary normalizeSelectorVocabulary 的结果
 * @returns {{css:string, removedRules:number, removedBytes:number}}
 */
export function pruneUnusedCss(css, vocabulary) {
  const text = typeof css === 'string' ? css : '';
  if (!text || !vocabulary) return { css: text, removedRules: 0, removedBytes: 0 };
  const stats = { removedRules: 0 };
  const output = pruneCssRange(text, 0, text.length, vocabulary, stats);
  return { css: output, removedRules: stats.removedRules, removedBytes: Math.max(0, text.length - output.length) };
}

function pruneCssRange(text, from, to, vocabulary, stats) {
  let out = '';
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 || end + 2 > to ? to : end + 2;
      continue; // 注释直接丢掉：也是体积的一部分
    }
    if (isCssSpace(ch)) { out += ch; i++; continue; }

    const statement = readCssStatement(text, i, to);
    if (!statement) {
      // 结构看不懂（括号不配对等）：原样保留剩下的部分，绝不丢内容
      out += text.slice(i, to);
      break;
    }

    if (statement.kind === 'statement') {
      out += text.slice(statement.start, statement.end);
      i = statement.end;
      continue;
    }

    const prelude = text.slice(statement.preludeStart, statement.preludeEnd).trim();
    if (prelude.startsWith('@')) {
      const name = atRuleName(prelude);
      if (PRUNABLE_AT_RULES.has(name)) {
        const inner = pruneCssRange(text, statement.blockStart + 1, statement.blockEnd, vocabulary, stats);
        out += text.slice(statement.start, statement.blockStart + 1) + inner + '}';
      } else {
        out += text.slice(statement.start, statement.blockEnd + 1);
      }
    } else if (selectorListMayMatch(prelude, vocabulary)) {
      out += text.slice(statement.start, statement.blockEnd + 1);
    } else {
      stats.removedRules++;
    }
    i = statement.blockEnd + 1;
  }
  return out;
}

function isCssSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function atRuleName(prelude) {
  const match = /^@([\w-]+)/.exec(prelude);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 从 start 起读一条语句：到顶层 `;` 是语句（@import/@charset…），
 * 到顶层 `{` 是块（规则或 @media 之类）。字符串、注释、括号里的字符不算边界。
 */
function readCssStatement(text, start, to) {
  let i = start;
  let quote = '';
  let paren = 0;
  let bracket = 0;
  while (i < to) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? to : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '(') { paren++; i++; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); i++; continue; }
    if (ch === '[') { bracket++; i++; continue; }
    if (ch === ']') { bracket = Math.max(0, bracket - 1); i++; continue; }
    if (paren === 0 && bracket === 0) {
      if (ch === ';') return { kind: 'statement', start: start, end: i + 1 };
      if (ch === '{') {
        const close = findClosingBrace(text, i, to);
        if (close < 0) return null;
        return { kind: 'block', start: start, preludeStart: start, preludeEnd: i, blockStart: i, blockEnd: close };
      }
    }
    i++;
  }
  return null;
}

function findClosingBrace(text, open, to) {
  let depth = 0;
  let i = open;
  let quote = '';
  while (i < to) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? to : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/** 选择器列表里只要有一条"可能匹配"，整条规则就保留 */
function selectorListMayMatch(prelude, vocabulary) {
  const selectors = splitCssList(prelude, ',');
  if (selectors.length === 0) return true;
  for (const selector of selectors) {
    if (selectorVerdict(selector, vocabulary) !== 'absent') return true;
  }
  return false;
}

/** 按顶层分隔符切分（跳过字符串、括号、方括号里的分隔符） */
function splitCssList(text, separator) {
  const parts = [];
  let start = 0;
  let i = 0;
  let quote = '';
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '(' || ch === '[') { depth++; i++; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * 一条选择器的判定：
 *   'absent' —— 必然匹配不到（某条要求文档里根本不存在）
 *   'maybe'  —— 判断不了或可能匹配，保留
 */
function selectorVerdict(selector, vocabulary) {
  const text = selector.trim();
  if (!text) return 'maybe';
  // 带参数的伪类（:is/:not/:nth-child/:has…）里可能还藏着选择器，不猜
  if (/:[\w-]+\(/.test(text)) return 'maybe';

  const compounds = splitCompounds(text);
  if (!compounds) return 'maybe';
  let absent = false;
  for (const compound of compounds) {
    const verdict = compoundVerdict(compound, vocabulary);
    // 只要有一段看不懂，整条选择器就不下结论（结构可能被解析歪了）
    if (verdict === 'unknown') return 'maybe';
    if (verdict === 'absent') absent = true;
  }
  return absent ? 'absent' : 'maybe';
}

/** 按组合符（空格 / > / + / ~ / ||）切成复合选择器；切不动返回 null */
function splitCompounds(selector) {
  const parts = [];
  let current = '';
  let i = 0;
  let depth = 0;
  let quote = '';
  while (i < selector.length) {
    const ch = selector[i];
    if (quote) {
      if (ch === '\\') { current += ch + (selector[i + 1] || ''); i += 2; continue; }
      current += ch;
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; i++; continue; }
    if (ch === '\\') {
      // 十六进制转义（\3a ）后面那个空格属于转义，不是组合符
      const escaped = readCssEscape(selector, i);
      if (!escaped) return null;
      current += selector.slice(i, escaped.end);
      i = escaped.end;
      continue;
    }
    if (ch === '(' || ch === '[') { depth++; current += ch; i++; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); current += ch; i++; continue; }
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || (ch === '|' && selector[i + 1] === '|'))) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += ch === '|' ? 2 : 1;
      continue;
    }
    if (depth === 0 && isCssSpace(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : null;
}

/** 单个复合选择器：'present' 要求都在 / 'absent' 缺东西 / 'unknown' 看不懂 */
function compoundVerdict(compound, vocabulary) {
  // 命名空间（svg|rect）、列组合、属性里的 | 操作符：不猜，保留
  if (compound.includes('|')) return 'unknown';
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '*') { i++; continue; }
    if (ch === '.') {
      const ident = readCssIdent(compound, i + 1);
      if (!ident.value) return 'unknown';
      if (!vocabulary.classes.has(ident.value)) return 'absent';
      i = ident.end;
      continue;
    }
    if (ch === '#') {
      const ident = readCssIdent(compound, i + 1);
      if (!ident.value) return 'unknown';
      if (!vocabulary.ids.has(ident.value)) return 'absent';
      i = ident.end;
      continue;
    }
    if (ch === '[') {
      const close = findClosingBracket(compound, i);
      if (close < 0) return 'unknown';
      const name = readAttributeName(compound.slice(i + 1, close));
      if (!name) return 'unknown';
      if (!vocabulary.attrs.has(name.toLowerCase())) return 'absent';
      i = close + 1;
      continue;
    }
    if (ch === ':') {
      // 不带参数的伪类/伪元素不改变"能不能匹配"，跳过即可
      let j = i + 1;
      if (compound[j] === ':') j++;
      const ident = readCssIdent(compound, j);
      if (!ident.value) return 'unknown';
      i = ident.end;
      continue;
    }
    if (/[A-Za-z_\u00A0-\uFFFF-]/.test(ch)) {
      const ident = readCssIdent(compound, i);
      if (!ident.value) return 'unknown';
      if (!vocabulary.tags.has(ident.value.toLowerCase())) return 'absent';
      i = ident.end;
      continue;
    }
    // 命名空间、嵌套 &、以及没见过的写法：不判断
    return 'unknown';
  }
  return 'present';
}

function findClosingBracket(text, open) {
  let i = open + 1;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === ']') return i;
    i++;
  }
  return -1;
}

/** `[data-x="a b" i]` → `data-x`；带命名空间/转义等看不懂的写法返回空串 */
function readAttributeName(inner) {
  const text = String(inner || '').trim();
  const cut = text.search(/[=~|^$*]/);
  const name = (cut < 0 ? text : text.slice(0, cut)).trim();
  if (!name || /[\s\\"']/.test(name)) return '';
  return name;
}

/** 读一个 CSS 标识符（处理 `\:` 这类转义；失败返回空串） */
function readCssIdent(text, start) {
  let i = start;
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const escaped = readCssEscape(text, i);
      if (!escaped) return { value: '', end: i };
      value += escaped.value;
      i = escaped.end;
      continue;
    }
    if (/[A-Za-z0-9_\u00A0-\uFFFF-]/.test(ch)) { value += ch; i++; continue; }
    break;
  }
  return { value: value, end: i };
}

function readCssEscape(text, start) {
  let i = start + 1;
  if (i >= text.length) return null;
  let hex = '';
  while (i < text.length && hex.length < 6 && /[0-9a-fA-F]/.test(text[i])) { hex += text[i]; i++; }
  if (hex) {
    if (text[i] === ' ') i++;
    const code = parseInt(hex, 16);
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return null;
    try {
      return { value: String.fromCodePoint(code), end: i };
    } catch (e) {
      return null;
    }
  }
  const ch = text[i];
  if (ch === '\n' || ch === '\r' || ch === '\f') return null;
  return { value: ch, end: i + 1 };
}

/* ------------------------------------------------------------------ *
 * 字体精简（体积）
 * ------------------------------------------------------------------ */

/** 通用族名：不是具体字体，@font-face 不会用它们当名字 */
const GENERIC_FONT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default'
]);

/** 字体族名归一化：去引号、折叠空白、小写（CSS 字体族名大小写不敏感） */
export function normalizeFontFamily(value) {
  let text = String(value == null ? '' : value).trim();
  while (text.length >= 2) {
    const first = text[0];
    if ((first !== '"' && first !== "'") || text[text.length - 1] !== first) break;
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 找出所有 `@font-face` 块（偏移 + 块体）。
 *
 * 只认 CSS 结构里的，不碰注释与字符串里的同名文本；块体用配对花括号确定，
 * 所以 `src: url(data:...;base64,...)` 里的分号不会提前截断。
 */
function findFontFaceBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipCssString(css, i);
      i = end < 0 ? css.length : end;
      continue;
    }
    if (ch === '@' && /^@font-face[\s{]/i.test(css.slice(i, i + 12))) {
      let open = i;
      while (open < css.length && css[open] !== '{') open++;
      if (open >= css.length) break;
      const close = findClosingBrace(css, open, css.length);
      if (close < 0) break;
      blocks.push({ start: i, bodyStart: open + 1, bodyEnd: close, end: close + 1 });
      i = close + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function skipCssString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return -1;
}

/**
 * 读一条声明（`name: value`）的值区间。
 *
 * 不能简单用 `[^;}]+`：`src` 里的 `url(data:...;base64,...)` 含有分号，
 * 必须按括号层级判断真正的结束位置。
 */
function readDeclarationValue(body, name) {
  const match = new RegExp('\\b' + name + '\\s*:', 'i').exec(body);
  if (!match) return null;
  let i = match.index + match[0].length;
  const start = i;
  let paren = 0;
  let quote = '';
  while (i < body.length) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '(') { paren++; i++; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); i++; continue; }
    if (paren === 0 && (ch === ';' || ch === '}')) break;
    i++;
  }
  return { start: start, end: i, value: body.slice(start, i) };
}

/** 从 @font-face 块体里取它声明的族名；取不到返回空串 */
function fontFaceFamily(body) {
  const declaration = readDeclarationValue(body, 'font-family');
  if (!declaration) return '';
  return normalizeFontFamily(declaration.value);
}

/**
 * 删掉 `@font-face` 里用不到的备用字体格式。
 *
 * 浏览器只会用 `src` 列表里第一个它支持的格式；`url(x.woff2) ..., url(x.woff) ...`
 * 会把同一份字体抓两遍、内联两遍 —— 这是老站点上很容易被忽视的一大块。
 * 保留所有 `local()`（不产生字节，是"本机已有就先用"）和第一个 `url()`。
 *
 * @returns {{css:string, removed:number, removedBytes:number}}
 */
export function pruneFontFaceSources(css) {
  const text = typeof css === 'string' ? css : '';
  if (!text) return { css: text, removed: 0, removedBytes: 0 };
  const blocks = findFontFaceBlocks(text);
  if (blocks.length === 0) return { css: text, removed: 0, removedBytes: 0 };

  let out = '';
  let cursor = 0;
  let removed = 0;
  for (const block of blocks) {
    const body = text.slice(block.bodyStart, block.bodyEnd);
    const rewritten = rewriteSrcValue(body);
    if (!rewritten) continue;
    out += text.slice(cursor, block.bodyStart) + rewritten.body;
    cursor = block.bodyEnd;
    removed += rewritten.removed;
  }
  if (removed === 0) return { css: text, removed: 0, removedBytes: 0 };
  out += text.slice(cursor);
  return { css: out, removed: removed, removedBytes: Math.max(0, text.length - out.length) };
}

function rewriteSrcValue(body) {
  const declaration = readDeclarationValue(body, 'src');
  if (!declaration) return null;
  const items = splitCssList(declaration.value, ',');
  if (items.length < 2) return null;

  let seenUrl = false;
  const kept = [];
  let removed = 0;
  for (const item of items) {
    if (!/\burl\s*\(/i.test(item)) {
      kept.push(item); // local(...)：不占字节，留着
      continue;
    }
    if (!seenUrl) {
      seenUrl = true;
      kept.push(item);
      continue;
    }
    removed++;
  }
  if (removed === 0) return null;

  return {
    body: body.slice(0, declaration.start) + ' ' + kept.join(', ') + body.slice(declaration.end),
    removed: removed
  };
}

/**
 * 删掉"文档里没人点名"的 `@font-face` 整块。
 *
 * 判据是**族名**：只要有规则（含内联 style、SVG 表现属性、`<font face>`）提到过
 * 这个族名，就保留 —— 哪怕实际只用到其中一两个字重，也不猜。判不出来（缺
 * `font-family`、族名解析不出来）一律保留。
 *
 * @param {string} css
 * @param {Set<string>|null} families 归一化后的族名集合；空集合视为"没有依据"
 */
export function pruneUnusedFontFaces(css, families) {
  const text = typeof css === 'string' ? css : '';
  if (!text) return { css: text, removed: 0, removedBytes: 0 };
  if (!(families instanceof Set) || families.size === 0) {
    return { css: text, removed: 0, removedBytes: 0 };
  }
  const blocks = findFontFaceBlocks(text);
  if (blocks.length === 0) return { css: text, removed: 0, removedBytes: 0 };

  let out = '';
  let cursor = 0;
  let removed = 0;
  for (const block of blocks) {
    const family = fontFaceFamily(text.slice(block.bodyStart, block.bodyEnd));
    if (!family || families.has(family)) continue;
    out += text.slice(cursor, block.start);
    cursor = block.end;
    removed++;
  }
  if (removed === 0) return { css: text, removed: 0, removedBytes: 0 };
  out += text.slice(cursor);
  return { css: out, removed: removed, removedBytes: Math.max(0, text.length - out.length) };
}

/**
 * 收集一段 CSS 里"被点名"的字体族。
 *
 * 覆盖 `font-family`、`font` 简写、以及自定义属性里的引号字符串（`--font: "Foo"`）。
 * `@font-face` 自己声明的那一行不算点名，否则每个字体都会"自我证明"存在。
 *
 * `unknown` 为真表示这段 CSS 里有 `var()` 或解析不了的 `font` 简写 —— 调用方
 * 应该放弃整帧的字体精简，因为族名可能是运行时才拼出来的。
 *
 * @returns {{families:Set<string>, unknown:boolean}}
 */
export function collectFontFamilies(css) {
  const text = typeof css === 'string' ? css : '';
  const families = new Set();
  if (!text) return { families, unknown: false };
  let unknown = false;

  let rest = '';
  let cursor = 0;
  for (const block of findFontFaceBlocks(text)) {
    rest += text.slice(cursor, block.start);
    cursor = block.end;
  }
  rest += text.slice(cursor);

  let match;
  const declaration = /\bfont-family\s*:\s*([^;}]+)/gi;
  while ((match = declaration.exec(rest))) {
    const value = match[1];
    if (/var\s*\(/i.test(value)) { unknown = true; continue; }
    for (const part of splitCssList(value, ',')) addFontFamily(families, part);
  }

  const shorthand = /\bfont\s*:\s*([^;}]+)/gi;
  while ((match = shorthand.exec(rest))) {
    const value = match[1];
    if (/var\s*\(/i.test(value)) { unknown = true; continue; }
    const list = parseFontShorthandFamilies(value);
    if (!list) { unknown = true; continue; }
    for (const part of list) addFontFamily(families, part);
  }

  // 自定义属性等地方的引号字符串：宁可多认，不能漏认
  const quoted = /(["'])([^"'\n]{1,120})\1/g;
  while ((match = quoted.exec(rest))) addFontFamily(families, match[2]);

  return { families, unknown };
}

function addFontFamily(set, raw) {
  const name = normalizeFontFamily(raw);
  if (!name) return;
  if (GENERIC_FONT_FAMILIES.has(name)) return;
  if (name.includes('(') || name.includes(')')) return;
  set.add(name);
}

/**
 * 解析 `font` 简写里的族名列表。
 *
 * 简写语法是 `[style || variant || weight || stretch]? size[/line-height]? family`，
 * 所以"族名"就是尺寸之后的部分。找不到尺寸关键字就返回 null（调用方据此放弃判断）。
 */
function parseFontShorthandFamilies(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const size = /(?:^|\s)(?:[+-]?\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|q|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*[^\s,]+)?\s+/i;
  const match = size.exec(text);
  if (!match) return null;
  const list = text.slice(match.index + match[0].length).trim();
  if (!list) return null;
  const parts = splitCssList(list, ',');
  return parts.length > 0 ? parts : null;
}

const HTML_ENTITIES = { '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' };

function decodeHtmlAttribute(value) {
  return String(value || '').replace(/&quot;|&#39;|&apos;|&amp;/g, (entity) => HTML_ENTITIES[entity]);
}

/**
 * 从 HTML 里收集"被点名"的字体族：SVG 的 `font-family` 表现属性与 `<font face>`。
 *
 * 内联 `style="font-family:…"` 不用在这里管 —— 它本身就是一个 CSS 文本资源。
 */
export function collectHtmlFontFamilies(html) {
  const text = typeof html === 'string' ? html : '';
  const families = new Set();
  if (!text) return families;

  let match;
  const attr = /\bfont-family\s*=\s*(["'])([^"']*)\1/gi;
  while ((match = attr.exec(text))) {
    const value = decodeHtmlAttribute(match[2]);
    for (const part of value.split(',')) addFontFamily(families, part);
  }
  const face = /<font\b[^>]*\bface\s*=\s*(["'])([^"']*)\1/gi;
  while ((match = face.exec(text))) {
    const value = decodeHtmlAttribute(match[2]);
    for (const part of value.split(',')) addFontFamily(families, part);
  }
  return families;
}

/**
 * HTML 里所有内联 `style` 属性的值（已解码实体，可以直接当 CSS 声明列表解析）。
 *
 * 没有 `url()` 的 style 属性不会被采集端单独登记成 CSS 资源，字体族就得从这里补；
 * 带 `url()` 的那些会被换成占位符，但它们的原文已经在样式文本里，两条路合起来是完整的。
 */
function extractInlineStyles(html) {
  const styles = [];
  const pattern = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while ((match = pattern.exec(html))) {
    styles.push(decodeHtmlAttribute(match[1] != null ? match[1] : match[2]));
  }
  return styles;
}

/**
 * 一帧的字体使用情况：把这一帧所有样式文本与 HTML 合起来看。
 *
 * 有 `@import` 就放弃判断：导入的样式表不在手上，它可能点名了别的字体，
 * 这时候删字体是拿不准的（宁可留）。
 */
export function collectFrameFontFamilies(texts, html) {
  const families = collectHtmlFontFamilies(html);
  let unknown = false;

  for (const styleText of extractInlineStyles(html)) {
    const result = collectFontFamilies(styleText);
    if (result.unknown) unknown = true;
    for (const family of result.families) families.add(family);
  }

  for (const text of Array.isArray(texts) ? texts : []) {
    if (/@import\b/i.test(text)) unknown = true;
    const result = collectFontFamilies(text);
    if (result.unknown) unknown = true;
    for (const family of result.families) families.add(family);
  }
  return { families, unknown };
}

/** CSS 字符串转义（只处理会破坏语法的字符） */
export function escapeCssString(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, '');
}

/** `url("...")` 形式 */
export function cssUrlRef(url) {
  return 'url("' + escapeCssString(url) + '")';
}

/** `@import url("...") <media>;` 形式（内联失败时用它保留在线引用） */
export function cssImportRef(url, media) {
  const suffix = media ? ' ' + media : '';
  return '@import url("' + escapeCssString(url) + '")' + suffix + ';';
}

/* ------------------------------------------------------------------ *
 * 转义与装配
 * ------------------------------------------------------------------ */

/** 双引号属性值转义（序列化器总是用双引号，所以单引号可以不动） */
export function escapeHtmlAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ATTR_ESCAPES[ch]);
}

/**
 * `<style>` 元素文本转义：HTML 解析器遇到 `</style` 就收尾，
 * 所以 CSS 里出现的这一串必须变成 CSS 合法的 `<\/style`（反斜杠转义在 CSS 里等价于原字符）。
 */
export function escapeStyleText(css) {
  return String(css == null ? '' : css).replace(/<\/style/gi, (match) => '<\\/' + match.slice(2));
}

/**
 * 组装最终文件。
 *
 * 前面加一行来源注释：用户半年后打开这个文件时，还能知道它来自哪个地址。
 * 不加 `<base>`：所有地址都已经内联成 data URI 或绝对地址，`<base>` 反而会改变
 * 页面内锚点的解析。
 */
export function buildArchiveDocument(input) {
  const opts = input || {};
  const html = typeof opts.html === 'string' ? opts.html : '';
  const sourceUrl = typeof opts.sourceUrl === 'string' ? opts.sourceUrl : '';
  const createdAt = typeof opts.createdAt === 'string' && opts.createdAt ? opts.createdAt : new Date().toISOString();
  const generator = typeof opts.generator === 'string' && opts.generator ? opts.generator : 'ResourceHelper';

  const comment = '<!-- saved by ' + generator + ' at ' + createdAt.replace(/--/g, '- -')
    + (sourceUrl ? ' · source ' + sourceUrl.replace(/--/g, '- -') : '')
    + ' · resources inlined as data URIs -->';

  return '<!DOCTYPE html>\n' + comment + '\n' + html + '\n';
}

/**
 * 归档文件名：复用下载路径的模板（{title} {quality} {ext} {site} {date}），
 * 扩展名固定 html —— 用户改了模板也不该把单文件网页存成 .mp4。
 */
export function archiveFilename(input) {
  const opts = input || {};
  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : '网页快照';
  const filename = buildFilename(
    { title: title, site: typeof opts.site === 'string' ? opts.site : '' },
    '',
    'html',
    { template: opts.template, date: opts.date }
  );
  if (/\.html?$/i.test(filename)) return filename;
  return filename + '.html';
}

/** 只保留 http/https 的判定（内容脚本/管线共用） */
export function isFetchableUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/** 取地址的扩展名（小写、无点），用于统计与提示 */
export function resourceExtension(url) {
  let pathname = '';
  try {
    pathname = new URL(String(url)).pathname;
  } catch (e) {
    return '';
  }
  const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
  return match ? match[1].toLowerCase() : '';
}

const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp']);

/** 把地址归类成 UI 上的统计口径 */
export function classifyResource(url) {
  const ext = resourceExtension(url);
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'css') return 'style';
  return 'other';
}

/** 跳过原因 -> 人话（UI 直接显示，不吞掉） */
export function describeSkipReason(reason) {
  switch (String(reason || '')) {
    case 'SCHEME': return '不是 http(s) 地址，无法内联';
    case 'INVALID': return '地址无法解析';
    case 'EMPTY': return '地址为空';
    case 'TOO_LARGE': return '单个文件超过体积上限';
    case 'BUDGET': return '整份快照超出体积预算';
    case 'COUNT': return '资源数量超过上限';
    case 'FETCH_FAILED': return '抓取失败（可能需要登录或被防盗链拦截）';
    case 'NO_CONTENT': return '抓回来的内容是空的';
    case 'NOT_TEXT': return '样式表内容不是文本';
    case 'NO_RECEIVER': return '页面没有响应（可能是浏览器内部页）';
    default: return '已跳过';
  }
}

/**
 * 校验并规整 UI/设置传进来的归档选项。
 * 未知字段丢弃、类型不对回退默认值 —— 与设置层的做法保持一致。
 */
export function normalizeArchiveOptions(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

  const limits = Object.assign({}, DEFAULT_ARCHIVE_LIMITS);
  const source = raw.limits && typeof raw.limits === 'object' ? raw.limits : raw;
  for (const key of Object.keys(DEFAULT_ARCHIVE_LIMITS)) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) limits[key] = Math.round(value);
  }

  return {
    inlineImages: bool(raw.inlineImages, true),
    removeScripts: bool(raw.removeScripts, true),
    embedFrames: bool(raw.embedFrames, true),
    onlySelection: bool(raw.onlySelection, false),
    // 体积优化：删掉不渲染的元素与不可能匹配的样式规则（SingleFile 的默认行为）
    removeHidden: bool(raw.removeHidden, true),
    removeUnusedCss: bool(raw.removeUnusedCss, true),
    limits: limits
  };
}
