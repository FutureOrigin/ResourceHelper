/**
 * 子框架（iframe/frame）的嵌套装配（P8）
 *
 * 单文件网页的"整页"含义里包含 iframe。跨域 iframe 的内容脚本读不到父页面文档树的
 * 那一部分（同源 iframe 其实也不需要走消息：父页面直接读 contentDocument 即可），
 * 所以做法是：每个 frame 各自序列化自己 → 侧边栏按 frame 树把它们**从深到浅**塞回父文档。
 *
 * 塞回去用的载体是 `srcdoc`：`<iframe srcdoc="<html>…">` 是唯一一种
 * "不开网络也能显示子文档"的写法。挑战在于转义顺序 ——
 * 子文档必须先处理完它自己的 iframe（最深优先），再整体作为**属性值**转义一次；
 * 顺序错了就会出现 `&amp;lt;` 这种被转义两遍的正文。
 *
 * 纯函数：只做树与字符串，不碰 chrome API。
 */

import { escapeHtmlAttr, framePlaceholderFor } from './page-archive.js';

/** URL 规范化：只用于"父文档里的 src"与"浏览器报告的 frame url"之间比对 */
export function normalizeFrameUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (e) {
    return text;
  }
  // 只有 http(s) 才有"主机 + 路径"这件事；about:blank / data: 之类原样返回
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return text;
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.protocol + '//' + parsed.host.toLowerCase() + path + parsed.search;
}

/**
 * 建立 frame 树。
 * @param {Array<{frameId:number, parentFrameId:number, url:string}>} frames
 * @returns {{byId: Map<number, Object>, roots: number[], deepestFirst: number[]}}
 */
export function buildFrameTree(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const byId = new Map();

  for (const frame of list) {
    const frameId = Number(frame && frame.frameId);
    if (!Number.isFinite(frameId)) continue;
    byId.set(frameId, {
      frameId: frameId,
      parentFrameId: Number.isFinite(Number(frame.parentFrameId)) ? Number(frame.parentFrameId) : -1,
      url: typeof frame.url === 'string' ? frame.url : '',
      depth: 0,
      children: []
    });
  }

  const roots = [];
  for (const node of byId.values()) {
    const parent = byId.get(node.parentFrameId);
    if (parent && parent !== node) parent.children.push(node.frameId);
    else roots.push(node.frameId);
  }

  // 深度用迭代算：坏数据里可能有环，环上的节点按 0 处理而不是死循环
  for (const rootId of roots) {
    const queue = [{ id: rootId, depth: 0 }];
    while (queue.length > 0) {
      const item = queue.shift();
      const node = byId.get(item.id);
      if (!node) continue;
      if (node.depth !== 0 && node.depth <= item.depth) continue;
      node.depth = item.depth;
      for (const childId of node.children) queue.push({ id: childId, depth: item.depth + 1 });
    }
  }

  const deepestFirst = Array.from(byId.values())
    .sort((a, b) => (b.depth - a.depth) || (a.frameId - b.frameId))
    .map((node) => node.frameId);

  return { byId: byId, roots: roots, deepestFirst: deepestFirst };
}

/**
 * 把父文档登记的子框架描述与浏览器报告的 frame 列表对上号。
 *
 * 只按 URL 配对：父文档里的 `src` 是它自己解析出来的绝对地址，
 * 浏览器报告的是导航后的地址（可能被重定向改过），所以先精确比对，
 * 再退一步只比 pathname。仍然对不上就返回 null —— 宁可保留在线地址，
 * 也不要把 A 框架的内容塞进 B 框架里。
 *
 * @param {number} parentFrameId
 * @param {Array<{index:number, src:string, name?:string}>} descriptors
 * @param {Array<{frameId:number, parentFrameId:number, url:string}>} frames
 * @param {Set<number>} claimed 已经被别的描述符占用的 frameId
 * @returns {Map<number, Object>} descriptor.index -> frame
 */
export function matchFrameDescriptors(parentFrameId, descriptors, frames, claimed) {
  const list = Array.isArray(descriptors) ? descriptors : [];
  const all = Array.isArray(frames) ? frames : [];
  const used = claimed instanceof Set ? claimed : new Set();
  const picked = new Map();

  const candidates = all.filter((frame) => {
    const frameId = Number(frame && frame.frameId);
    if (!Number.isFinite(frameId) || used.has(frameId)) return false;
    return Number(frame.parentFrameId) === Number(parentFrameId);
  });

  for (const descriptor of list) {
    const wanted = normalizeFrameUrl(descriptor && descriptor.src);
    if (!wanted) continue;

    let match = candidates.find((frame) => !used.has(Number(frame.frameId))
      && normalizeFrameUrl(frame.url) === wanted);

    if (!match) {
      const wantedPath = pathOf(wanted);
      match = wantedPath
        ? candidates.find((frame) => !used.has(Number(frame.frameId))
          && pathOf(normalizeFrameUrl(frame.url)) === wantedPath)
        : null;
    }

    if (!match) continue;
    const frameId = Number(match.frameId);
    used.add(frameId);
    picked.set(Number(descriptor.index), match);
  }

  return picked;
}

function pathOf(url) {
  try {
    return new URL(url).pathname || '';
  } catch (e) {
    return '';
  }
}

/**
 * 把子文档塞进父文档的 iframe。
 * 替换的是 `src="rhframe://<token>/<n>"` 这**一段属性**，同时去掉登记用的 data 属性。
 *
 * @param {string} html 父文档
 * @param {string} token
 * @param {number} index 描述符序号
 * @param {string} childHtml 已经处理完自身 iframe 的子文档
 */
export function embedChildFrame(html, token, index, childHtml) {
  const source = typeof html === 'string' ? html : '';
  const placeholder = framePlaceholderFor(token, index);
  const srcAttr = 'src="' + placeholder + '"';
  if (!source.includes(srcAttr)) return source;

  const srcdoc = 'srcdoc="' + escapeHtmlAttr(childHtml) + '"';
  let out = source.split(srcAttr).join(srcdoc);
  out = stripFrameMarker(out, index);
  return out;
}

/** 没能采集到的框架：把占位符还原成在线地址（离线打开时这块会是空白，但不会指向 rhframe:） */
export function revertFramePlaceholder(html, token, index, absoluteUrl) {
  const source = typeof html === 'string' ? html : '';
  const placeholder = framePlaceholderFor(token, index);
  const srcAttr = 'src="' + placeholder + '"';
  if (!source.includes(srcAttr)) return stripFrameMarker(source, index);
  const fallback = 'src="' + escapeHtmlAttr(absoluteUrl || '') + '"';
  return stripFrameMarker(source.split(srcAttr).join(fallback), index);
}

function stripFrameMarker(html, index) {
  return String(html).replace(new RegExp('\\s+data-rh-frame="' + Number(index) + '"', 'g'), '');
}

/**
 * 装配顺序：从最深的 frame 开始，先把子文档塞进它的父文档，
 * 再让父文档整体作为属性值被更上一层转义。
 *
 * @param {Array<{frameId:number, parentFrameId:number, html:string, frames?:Array}>} collected
 * @returns {{order:number[], byId:Map<number,Object>}}
 */
export function planFrameAssembly(collected) {
  const list = Array.isArray(collected) ? collected : [];
  const tree = buildFrameTree(list.map((item) => ({
    frameId: item.frameId,
    parentFrameId: item.parentFrameId,
    url: item.url || ''
  })));
  const byId = new Map();
  for (const item of list) {
    const frameId = Number(item && item.frameId);
    if (Number.isFinite(frameId)) byId.set(frameId, item);
  }
  // 只有真正采集到 HTML 的 frame 才参与装配
  const order = tree.deepestFirst.filter((frameId) => {
    const item = byId.get(frameId);
    return item && typeof item.html === 'string';
  });
  return { order: order, byId: byId };
}
