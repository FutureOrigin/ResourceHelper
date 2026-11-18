/**
 * 声明式站点适配器引擎（P4）
 *
 * 问题（AUDIT G5）：站点逻辑硬编码在 content/extractor.js 里，5 套 if 分支，
 * 加一个站点 = 改核心文件 + 发版；站点改版也只能跟着发版。
 *
 * 这里把"页面数据 -> 媒体变体"变成数据映射：适配器是 JSON，
 * 引擎只实现一个够用的 JSONPath 子集 + 少量语法糖。
 *
 * 语法：
 *   $.a.b              取属性
 *   $.a[0]             取数组下标
 *   $.a[*]             展开数组（返回数组）
 *   $.a || $.b || 'x'  依次尝试，取第一个非空
 *   $.x == 1           比较，返回布尔（支持字符串/数字/true/false）
 *   $.x contains 'v'   子串判断，返回布尔
 *   $doc.title         页面标题（上下文注入）
 *   '$literal'         字面量
 */

/** 把表达式按顶层 || 切开（忽略字符串与括号内的） */
export function splitAlternatives(expression) {
  const parts = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']') {
      depth -= 1;
      current += char;
      continue;
    }
    if (depth === 0 && char === '|' && expression[i + 1] === '|') {
      parts.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/** 把单个路径解析成 token 序列：[{type:'key',value}|{type:'index',value}|{type:'wild'}] */
export function parsePath(path) {
  const text = String(path || '').trim();
  if (!text) return [];
  let rest = text;
  if (rest.startsWith('$doc')) return [{ type: 'doc' }].concat(parsePath('$' + rest.slice(4)));
  if (rest.startsWith('$state')) return [{ type: 'state' }].concat(parsePath('$' + rest.slice(6)));
  if (rest.startsWith('$media')) return [{ type: 'media' }].concat(parsePath('$' + rest.slice(6)));
  if (rest.startsWith('$')) rest = rest.slice(1);

  const tokens = [];
  let index = 0;
  while (index < rest.length) {
    const char = rest[index];
    if (char === '.') {
      index += 1;
      let key = '';
      while (index < rest.length && rest[index] !== '.' && rest[index] !== '[') {
        key += rest[index];
        index += 1;
      }
      if (key) tokens.push({ type: 'key', value: key });
      continue;
    }
    if (char === '[') {
      const end = rest.indexOf(']', index);
      if (end < 0) break;
      const inner = rest.slice(index + 1, end).trim();
      if (inner === '*') tokens.push({ type: 'wild' });
      else tokens.push({ type: 'index', value: Number.parseInt(inner, 10) });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return tokens;
}

function readAt(node, token) {
  if (node == null) return undefined;
  if (token.type === 'wild') return Array.isArray(node) ? node : undefined;
  if (token.type === 'index') return Array.isArray(node) ? node[token.value] : undefined;
  return typeof node === 'object' ? node[token.value] : undefined;
}

/** 沿 token 展开所有值（wild 会产生多个） */
export function walk(value, tokens) {
  let current = [value];
  for (const token of tokens) {
    const next = [];
    for (const item of current) {
      if (token.type === 'wild') {
        if (Array.isArray(item)) next.push(...item);
        else if (item != null && typeof item === 'object') next.push(...Object.values(item));
      } else if (token.type === 'index') {
        if (Array.isArray(item)) {
          const picked = item[token.value];
          if (picked !== undefined) next.push(picked);
        }
      } else if (token.type === 'key') {
        if (item != null && typeof item === 'object' && item[token.value] !== undefined) {
          next.push(item[token.value]);
        }
      }
    }
    current = next;
  }
  return current;
}

function parseLiteral(text) {
  const trimmed = String(text).trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isEmpty(value) {
  if (value == null) return true;
  if (value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * 求值一个表达式。
 * context: { data, state, doc: { title, url } }
 */
export function evaluateExpression(expression, context) {
  const ctx = context || {};
  const branches = splitAlternatives(String(expression));

  for (const branch of branches) {
    // contains：$.mimeType contains 'video'
    const contains = branch.match(/^(.*?)\s+contains\s+(.+)$/);
    if (contains) {
      const left = evaluateExpression(contains[1], ctx);
      const needle = parseLiteral(contains[2]);
      const haystack = Array.isArray(left) ? left[0] : left;
      return String(haystack == null ? '' : haystack).includes(String(needle));
    }

    // 先处理比较：左侧路径 == 右侧字面量
    const compare = branch.match(/^(.*?)\s*==\s*(.+)$/);
    if (compare) {
      const left = evaluateExpression(compare[1], ctx);
      const rightText = compare[2].trim();
      // 右侧只有以 $ 开头才是路径，否则一律当字面量（数字/布尔/带引号字符串）
      const right = rightText.startsWith('$') ? evaluateExpression(rightText, ctx) : parseLiteral(rightText);
      const leftValue = Array.isArray(left) ? left[0] : left;
      if (String(leftValue) === String(right)) return true;
      return false;
    }

    if (!isPathLike(branch)) {
      const literal = parseLiteral(branch);
      if (!isEmpty(literal)) return literal;
      continue;
    }

    const tokens = parsePath(branch);
    let root = ctx.data;
    if (tokens.length > 0 && tokens[0].type === 'doc') {
      root = ctx.doc;
      tokens.shift();
    } else if (tokens.length > 0 && tokens[0].type === 'state') {
      root = ctx.state;
      tokens.shift();
    } else if (tokens.length > 0 && tokens[0].type === 'media') {
      root = ctx.media || [];
      tokens.shift();
    }
    const values = walk(root, tokens);
    if (values.length === 1 && tokens.some((token) => token.type !== 'wild')) {
      if (!isEmpty(values[0])) return values[0];
      continue;
    }
    if (values.length > 0) return values;
  }

  return null;
}

/**
 * 只有"路径 / 数字 / 布尔 / null"需要求值；
 * 带引号的字符串是字面量，必须走 parseLiteral，不能被当成路径解析。
 */
function isPathLike(text) {
  const trimmed = String(text).trim();
  return trimmed.startsWith('$')
    || trimmed === 'true' || trimmed === 'false' || trimmed === 'null'
    || /^-?\d+(\.\d+)?$/.test(trimmed);
}

/** 把站点后缀（" - QQ音乐"之类）从标题里剥掉；regular 用 FIFO 的方式套用 */
export function cleanTitle(title, patterns) {
  let value = String(title == null ? '' : title);
  for (const pattern of patterns || []) {
    try {
      value = value.replace(new RegExp(pattern, 'i'), '');
    } catch (e) {}
  }
  return value.trim();
}

/** 适配器是否匹配当前 URL */
export function matchesAdapter(adapter, url) {
  const patterns = (adapter && adapter.match) || [];
  return patterns.some((pattern) => {
    const regex = new RegExp('^' + String(pattern).replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(String(url || ''));
  });
}

function mapVariant(spec, item, context) {
  const read = (expr) => (expr == null ? undefined : evaluateExpression(expr, Object.assign({}, context, { data: item })));
  const url = read(spec.url);
  if (!url) return null;
  const variant = {
    kind: spec.kind,
    id: String(read(spec.id) != null ? read(spec.id) : (spec.kind + '-' + Math.random().toString(36).slice(2, 8))),
    url: String(url),
    width: numberOrNull(read(spec.width)),
    height: numberOrNull(read(spec.height)),
    bitrate: numberOrNull(read(spec.bitrate)),
    codec: read(spec.codec) ? String(read(spec.codec)) : '',
    language: spec.lang ? String(read(spec.lang) || '') : '',
    // container 也要按表达式求值，否则适配器里写 "$.ext" 会原样变成扩展名
    container: read(spec.container) ? String(read(spec.container)).toLowerCase() : '',
    videoOnly: spec.videoOnly === true,
    drm: Boolean(read('$.drm'))
  };
  if (spec.quality && !variant.quality) {
    const quality = read(spec.quality);
    if (quality != null) variant.quality = numberOrNull(quality);
  }
  return variant;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== '' && value != null ? number : null;
}

/**
 * 用适配器从页面数据里抽出媒体描述。
 * @returns {{matched:boolean, id:string, title:string, variants:Array, drm:boolean}}
 */
export function extractWithAdapter(adapter, context) {
  const ctx = context || {};
  // id 只有适配器显式声明 media.id 时才存在；否则留空，由调用方决定分组粒度
  const result = { matched: false, id: '', title: '', variants: [], drm: false };
  if (!adapter) return result;

  if (ctx.url && (adapter.match || []).length > 0 && !matchesAdapter(adapter, ctx.url)) return result;

  result.matched = true;
  const titleExpression = Array.isArray(adapter.title) ? adapter.title.join(' || ') : adapter.title;
  const rawTitle = titleExpression ? evaluateExpression(titleExpression, ctx) : null;
  result.title = cleanTitle(rawTitle == null ? '' : rawTitle, adapter.titleCleanup);

  const media = adapter.media || {};
  if (media.id) {
    const id = evaluateExpression(media.id, ctx);
    if (id != null && id !== '') result.id = String(id);
  }
  if (media.drm) result.drm = Boolean(evaluateExpression(media.drm, ctx));

  for (const kind of ['video', 'audio']) {
    const spec = media[kind];
    if (!spec) continue;
    const items = evaluateExpression(spec.each, ctx);
    let list = Array.isArray(items) ? items : (items ? [items] : []);
    if (spec.filter) {
      // 同一个数组里既有视频又有音频时（YouTube 的 adaptiveFormats），靠 filter 分流
      list = list.filter((item) => Boolean(evaluateExpression(spec.filter, Object.assign({}, ctx, { data: item }))));
    }
    for (const item of list) {
      const variant = mapVariant(Object.assign({ kind: kind }, spec), item, ctx);
      if (!variant) continue;
      if (spec.labels && variant.quality != null && spec.labels[String(variant.quality)]) {
        variant.label = spec.labels[String(variant.quality)];
      }
      variant.drm = variant.drm || result.drm;
      result.variants.push(variant);
    }
  }

  return result;
}

/**
 * 从一组适配器里挑出匹配当前 URL 的那个。
 * priority 大的优先（站点适配器 10 > generic-dom 0），同优先级取列表靠前的。
 */
export function selectAdapter(adapters, url) {
  const matched = selectAdapters(adapters, url);
  return matched.length > 0 ? matched[0] : null;
}

/**
 * 所有匹配的适配器（按 priority 降序）。
 * 后台会逐个执行并合并结果：站点适配器补页面数据，generic-dom 补 DOM 里的真实流，
 * 两条来源产出的 URL 相同时由资源图合并，不会重复出卡。
 */
export function selectAdapters(adapters, url) {
  const matched = (adapters || []).filter((adapter) => matchesAdapter(adapter, url));
  matched.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  return matched;
}
