/**
 * 正文去字体加密（私用区码位 → 真字）
 *
 * 站点把常用字换成 U+E000–U+F8FF 的私用区码位，再用随机命名的子集字体把
 * 这些码位画成真字：页面上正常，复制/提取出来却是一串"看不见的字"。
 * 这里用内置的字形指纹表把码位换回真字；解码出的映射还会推回页面，
 * 让页面里的 Ctrl+C 也直接拿到正常文本。
 */

import {
  applyMapping,
  buildPrivateUseMapping,
  collectPrivateUse,
  parseGlyphTable
} from '../../core/font-deobfuscate.js';

const TABLE_PATH = 'data/glyph-table.bin';

let tablePromise = null;
const fontCache = new Map();

/** 指纹表体积不小（约 170 KiB），只在真的要解码时才取 */
export function loadGlyphTable() {
  if (!tablePromise) {
    tablePromise = (async () => {
      const res = await fetch(chrome.runtime.getURL(TABLE_PATH));
      if (!res.ok) throw new Error('table-missing');
      return parseGlyphTable(new Uint8Array(await res.arrayBuffer()));
    })();
    tablePromise.catch(() => { tablePromise = null; });
  }
  return tablePromise;
}

async function fetchFontBytes(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('font-http-' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** 同一份字体只解析一次（字体按内容命名，会跨章节复用） */
async function mappingForUrl(url, table) {
  const cached = fontCache.get(url);
  if (cached) return cached;
  const promise = (async () => buildPrivateUseMapping(await fetchFontBytes(url), table))();
  fontCache.set(url, promise);
  promise.catch(() => fontCache.delete(url));
  return promise;
}

export function clearFontCache() {
  fontCache.clear();
}

/**
 * 在页面里现场找"正文用的那份自绘字体"。
 *
 * 走 chrome.scripting 而不是内容脚本，是为了在老标签页/老内容脚本上也能用：
 * 提取拿不到 font 线索时（例如扩展刚升级、页面里还是旧脚本），这里兜底。
 */
export async function discoverFontInTab(tabId) {
  if (!tabId || !chrome.scripting) return null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: pageDiscoverFont });
    return (results && results[0] && results[0].result) || null;
  } catch (err) {
    console.warn('[FontDecode] discoverFontInTab failed:', err);
    return null;
  }
}

/** 注入函数：必须自包含（不能引用外部变量） */
function pageDiscoverFont() {
  const isPua = (cp) => (cp >= 0xE000 && cp <= 0xF8FF)
    || (cp >= 0xF0000 && cp <= 0xFFFFD)
    || (cp >= 0x100000 && cp <= 0x10FFFD);

  const faces = new Map();
  const rank = (u) => (/\.otf(\?|#|$)/i.test(u) ? 0 : /\.ttf(\?|#|$)/i.test(u) ? 1 : /\.woff(\?|#|$)/i.test(u) ? 2 : 3);
  const collect = (family, srcText) => {
    if (!family || !srcText) return;
    const key = String(family).replace(/^["']|["']$/g, '').trim();
    if (!key) return;
    const urls = [];
    const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
    let match;
    while ((match = re.exec(srcText))) {
      const raw = match[1].trim();
      if (!raw || /^data:/i.test(raw) || /\.woff2(\?|#|$)/i.test(raw)) continue;
      try {
        urls.push(new URL(raw, document.baseURI).href);
      } catch (err) {}
    }
    if (!urls.length) return;
    const list = faces.get(key) || [];
    for (const url of urls) if (!list.includes(url)) list.push(url);
    faces.set(key, list);
  };

  for (const sheet of Array.from(document.styleSheets || [])) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (err) {
      rules = null;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (!rule || !rule.style || typeof rule.style.getPropertyValue !== 'function') continue;
      collect(rule.style.getPropertyValue('font-family'), rule.style.getPropertyValue('src'));
    }
  }
  if (!faces.size) return null;

  const root = document.body || document.documentElement;
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node = walker.nextNode();
  let visited = 0;
  while (node && visited < 5000) {
    visited++;
    if (node.nodeValue && Array.from(node.nodeValue).some((ch) => isPua(ch.codePointAt(0)))) {
      const el = node.parentElement;
      if (el) {
        const families = (window.getComputedStyle(el).fontFamily || '')
          .split(',')
          .map((item) => item.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        for (const family of families) {
          const urls = faces.get(family);
          if (urls && urls.length) return { family, urls: urls.slice().sort((a, b) => rank(a) - rank(b)) };
        }
      }
    }
    node = walker.nextNode();
  }
  if (faces.size === 1) {
    const [family] = faces.keys();
    return { family, urls: (faces.get(family) || []).slice().sort((a, b) => rank(a) - rank(b)) };
  }
  return null;
}

/**
 * 把提取到的正文解码成真字。
 * @param {{content: string, font: {family: string, urls: string[]}|null}} input
 * @returns {Promise<{changed: boolean, text: string, pua: {total: number, distinct: number},
 *   matched: number, glyphs: number, family: string, mapping: Map<number, string>|null, reason: string}>}
 */
export async function decodeExtractedText({ content, font }) {
  const pua = collectPrivateUse(content);
  const base = {
    changed: false,
    text: content,
    pua: { total: pua.total, distinct: pua.distinct.length },
    matched: 0,
    glyphs: 0,
    family: font ? font.family : '',
    mapping: null,
    reason: 'no-private-use'
  };
  if (!pua.total) return base;
  base.reason = 'no-font';
  if (!font || !Array.isArray(font.urls) || !font.urls.length) return base;

  let table;
  try {
    table = await loadGlyphTable();
  } catch (err) {
    base.reason = 'table-missing';
    return base;
  }

  let best = null;
  let lastError = '';
  for (const url of font.urls) {
    try {
      const result = await mappingForUrl(url, table);
      if (!best || result.matched > best.matched) best = { ...result, url };
      // 命中率够高就不用再试别的字重
      if (best.matched > 0 && best.matched >= result.glyphs * 0.98) break;
    } catch (err) {
      lastError = (err && err.message) || String(err);
    }
  }

  if (!best) {
    base.reason = lastError || 'font-unreadable';
    return base;
  }
  base.glyphs = best.glyphs;
  base.matched = best.matched;
  if (!best.matched) {
    base.reason = 'no-match';
    return base;
  }

  const text = applyMapping(content, best.map);
  let replaced = 0;
  for (const ch of content) {
    if (best.map.has(ch.codePointAt(0))) replaced++;
  }
  return {
    ...base,
    changed: text !== content,
    text,
    matched: replaced,
    mapping: best.map,
    reason: 'ok'
  };
}

/** 把映射推回页面，让 Ctrl+C / 右键复制也拿到真字 */
export async function pushCopyMap(tabId, mapping) {
  if (!tabId || !mapping || !mapping.size) return false;
  const mappings = [...mapping.entries()];
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'SNIFFER_SET_COPY_MAP', mappings });
    return !!(res && res.success);
  } catch (err) {
    return false;
  }
}

export function describeDecodeFailure(reason) {
  switch (reason) {
    case 'no-font': return '没找到正文字体（可能是图片或跨域样式表）';
    case 'table-missing': return '内置字形指纹表缺失';
    case 'no-match': return '字体能读到，但字形对不上（站点换了字体）';
    case 'woff2-unsupported': return '站点只提供 woff2，浏览器无法解压';
    case 'not-a-cff-font': return '字体不是 CFF 轮廓，暂不支持';
    case 'font-http-0': return '字体下载被拦截';
    case 'font-unreadable': return '字体解析失败';
    default: return reason ? '字体解析失败（' + reason + '）' : '未知原因';
  }
}
