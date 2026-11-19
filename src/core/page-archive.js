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
    limits: limits
  };
}
