/**
 * DASH（.mpd）解析（P3e）
 *
 * 现状：识别得到 .mpd 但直接拒绝（AUDIT D5）。国际站与部分国内站都用 DASH，
 * 这是"泛用性"最直接的缺口之一。
 *
 * 这里自带一个极小的 XML 扫描器（浏览器里有 DOMParser，Node 里没有；
 * 为了让解析逻辑可单测，统一用同一份实现，不依赖宿主能力）。
 * 只覆盖 MPD 需要的子集：元素、属性、文本、自闭合、注释、CDATA。
 */

/** 解析成 {name, attrs, children, text} 树；无效输入返回 null */
export function parseXml(input) {
  const text = String(input || '');
  let index = 0;
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];

  const isNameChar = (ch) => /[-A-Za-z0-9_:.]/.test(ch);

  while (index < text.length) {
    const lt = text.indexOf('<', index);
    if (lt < 0) {
      const tail = text.slice(index);
      if (tail.trim()) stack[stack.length - 1].text += tail;
      break;
    }
    if (lt > index) {
      const chunk = text.slice(index, lt);
      if (chunk.trim()) stack[stack.length - 1].text += chunk;
    }

    // 注释
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    // CDATA
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += text.slice(lt + 9, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    // 声明/处理指令
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const end = text.indexOf('>', lt);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    // 结束标签
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      index = end < 0 ? text.length : end + 1;
      continue;
    }

    // 开始标签
    let cursor = lt + 1;
    let name = '';
    while (cursor < text.length && isNameChar(text[cursor])) {
      name += text[cursor];
      cursor += 1;
    }
    if (!name) {
      index = lt + 1;
      continue;
    }

    const attrs = {};
    let selfClosing = false;
    while (cursor < text.length) {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '/') {
        selfClosing = true;
        cursor += 1;
        continue;
      }
      if (text[cursor] === '>') {
        cursor += 1;
        break;
      }
      let attrName = '';
      while (cursor < text.length && isNameChar(text[cursor])) {
        attrName += text[cursor];
        cursor += 1;
      }
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '=') {
        cursor += 1;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
        const quote = text[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const end = text.indexOf(quote, cursor);
          attrs[attrName] = text.slice(cursor, end < 0 ? text.length : end);
          cursor = end < 0 ? text.length : end + 1;
        }
      } else if (attrName) {
        attrs[attrName] = '';
      }
    }

    const node = { name: name, attrs: attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    index = cursor;
  }

  return root.children.length > 0 ? root.children[0] : null;
}

function childrenNamed(node, name) {
  return (node && node.children ? node.children : []).filter((child) => child.name === name);
}

function firstNamed(node, name) {
  return childrenNamed(node, name)[0] || null;
}

/** 递归找第一个匹配名称的后代（MPD 里 SegmentTemplate 可能挂在 AdaptationSet 上） */
function findDescendant(node, names) {
  if (!node) return null;
  for (const name of names) {
    const direct = firstNamed(node, name);
    if (direct) return direct;
  }
  for (const child of node.children || []) {
    const found = findDescendant(child, names);
    if (found) return found;
  }
  return null;
}

/** ISO 8601 时长（PT1H2M3.5S）-> 秒 */
export function parseIsoDuration(value) {
  const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/);
  if (!match) return 0;
  const days = Number.parseFloat(match[1] || '0');
  const hours = Number.parseFloat(match[2] || '0');
  const minutes = Number.parseFloat(match[3] || '0');
  const seconds = Number.parseFloat(match[4] || '0');
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function absoluteUrl(uri, baseUrl) {
  // 空字符串表示"继承上级 BaseURL"，不能返回空
  if (!uri) return baseUrl || '';
  try {
    return new URL(uri, baseUrl).href;
  } catch (e) {
    return uri;
  }
}

/** 替换 $Number$ / $Time$ / $RepresentationID$ / $Bandwidth$（含 %0Nd 格式，$$ 转义） */
export function fillTemplate(template, values) {
  if (!template) return '';
  // $$ 是"字面量美元符"的转义，且没有结尾的 $；先占位避免被后面的规则吃掉
  const DOLLAR = '\u0000DOLLAR\u0000';
  const escaped = String(template).split('$$').join(DOLLAR);
  const filled = escaped.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (whole, key, pad) => {
    if (key === 'Number') {
      const raw = String(values.number == null ? '' : values.number);
      return pad ? raw.padStart(Number(pad), '0') : raw;
    }
    if (key === 'Time') return String(values.time == null ? '' : values.time);
    if (key === 'RepresentationID') return String(values.representationId == null ? '' : values.representationId);
    if (key === 'Bandwidth') return String(values.bandwidth == null ? '' : values.bandwidth);
    return whole;
  });
  return filled.split(DOLLAR).join('$');
}

/**
 * 把 SegmentTemplate + SegmentTimeline / 固定 duration 展开成分片列表。
 * 只支持 static（有明确时长）的 MPD；直播型（dynamic）返回空并给出 reason。
 */
export function expandTemplate(template, options) {
  const opts = options || {};
  const segments = [];
  const timescale = Number.parseFloat((template && template.attrs.timescale) || '1') || 1;
  const startNumber = Number.parseInt((template && template.attrs.startNumber) || '1', 10) || 1;
  const media = template && template.attrs.media;
  const timeline = template ? firstNamed(template, 'SegmentTimeline') : null;

  if (timeline) {
    let number = startNumber;
    let time = 0;
    for (const entry of childrenNamed(timeline, 'S')) {
      const t = entry.attrs.t != null ? Number.parseInt(entry.attrs.t, 10) : time;
      const d = Number.parseInt(entry.attrs.d, 10) || 0;
      const repeat = Number.parseInt(entry.attrs.r || '0', 10) || 0;
      let current = t;
      for (let i = 0; i <= repeat; i += 1) {
        segments.push({
          url: absoluteUrl(fillTemplate(media, { number: number, time: current, representationId: opts.representationId, bandwidth: opts.bandwidth }), opts.baseUrl),
          number: number,
          time: current,
          duration: d / timescale
        });
        number += 1;
        current += d;
      }
      time = current;
    }
    return { segments: segments, timescale: timescale, startNumber: startNumber };
  }

  const duration = Number.parseInt((template && template.attrs.duration) || '0', 10);
  const total = opts.durationSeconds ? Math.ceil(opts.durationSeconds * timescale / duration) : 0;
  if (!duration || !total) return { segments: [], timescale: timescale, startNumber: startNumber, reason: 'NO_TIMELINE' };

  for (let i = 0; i < total; i += 1) {
    const number = startNumber + i;
    segments.push({
      url: absoluteUrl(fillTemplate(media, { number: number, time: i * duration, representationId: opts.representationId, bandwidth: opts.bandwidth }), opts.baseUrl),
      number: number,
      time: i * duration,
      duration: duration / timescale
    });
  }
  return { segments: segments, timescale: timescale, startNumber: startNumber, count: total };
}

/** 解析一个 Representation 的取流方式 */
function describeRepresentation(representation, inherited, context) {
  const attrs = representation.attrs || {};
  const baseUrlNode = firstNamed(representation, 'BaseURL') || inherited.baseUrlNode;
  const baseUrl = absoluteUrl((baseUrlNode && baseUrlNode.text.trim()) || '', context.baseUrl);

  const templateNode = firstNamed(representation, 'SegmentTemplate') || inherited.templateNode;
  const listNode = firstNamed(representation, 'SegmentList') || inherited.listNode;
  const segmentBaseNode = firstNamed(representation, 'SegmentBase') || inherited.segmentBaseNode;

  const description = {
    id: attrs.id || '',
    bandwidth: Number.parseInt(attrs.bandwidth || '0', 10) || 0,
    width: Number.parseInt(attrs.width || '0', 10) || 0,
    height: Number.parseInt(attrs.height || '0', 10) || 0,
    codecs: attrs.codecs || inherited.codecs || '',
    mimeType: attrs.mimeType || inherited.mimeType || '',
    baseUrl: baseUrl,
    initUrl: '',
    segments: [],
    reason: ''
  };

  if (templateNode) {
    const initTemplate = templateNode.attrs.initialization;
    if (initTemplate) {
      description.initUrl = absoluteUrl(fillTemplate(initTemplate, {
        representationId: description.id,
        bandwidth: description.bandwidth
      }), baseUrl || context.baseUrl);
    }
    const expanded = expandTemplate(templateNode, {
      baseUrl: baseUrl || context.baseUrl,
      representationId: description.id,
      bandwidth: description.bandwidth,
      durationSeconds: context.durationSeconds
    });
    description.segments = expanded.segments;
    if (description.segments.length === 0) description.reason = expanded.reason || 'NO_SEGMENTS';
    return description;
  }

  if (listNode) {
    const initNode = firstNamed(listNode, 'Initialization');
    if (initNode && initNode.attrs.source) {
      description.initUrl = absoluteUrl(initNode.attrs.source, baseUrl || context.baseUrl);
    }
    description.segments = childrenNamed(listNode, 'SegmentURL')
      .map((node) => node.attrs.media)
      .filter(Boolean)
      .map((media) => ({ url: absoluteUrl(media, baseUrl || context.baseUrl) }));
    if (description.segments.length === 0) description.reason = 'NO_SEGMENTS';
    return description;
  }

  if (segmentBaseNode && (baseUrl || context.baseUrl)) {
    // SegmentBase：整个 Représentation 就是一个带 sidx 的 MP4，直接下这个文件即可
    const init = firstNamed(segmentBaseNode, 'Initialization');
    description.segmentBase = true;
    description.fileUrl = baseUrl || context.baseUrl;
    description.indexRange = segmentBaseNode.attrs.indexRange || '';
    description.initializationRange = (init && init.attrs.range) || '';
    return description;
  }

  description.reason = 'NO_SEGMENT_INFO';
  return description;
}

/**
 * 解析 MPD。
 * @returns {{durationSeconds:number, isLive:boolean, video:Array, audio:Array, text:Array}}
 */
export function parseMpd(xmlText, baseUrl) {
  const root = parseXml(xmlText);
  if (!root || root.name !== 'MPD') {
    return { durationSeconds: 0, isLive: false, video: [], audio: [], text: [] };
  }

  const isLive = String(root.attrs.type || '').toLowerCase() === 'dynamic';
  const durationSeconds = parseIsoDuration(root.attrs.mediaPresentationDuration);
  const result = { durationSeconds: durationSeconds, isLive: isLive, video: [], audio: [], text: [] };

  const mpdBaseNode = firstNamed(root, 'BaseURL');
  const mpdBase = absoluteUrl((mpdBaseNode && mpdBaseNode.text.trim()) || '', baseUrl);

  for (const period of childrenNamed(root, 'Period')) {
    const periodBaseNode = firstNamed(period, 'BaseURL');
    const periodBase = absoluteUrl((periodBaseNode && periodBaseNode.text.trim()) || '', mpdBase || baseUrl);
    const periodDuration = parseIsoDuration(period.attrs.duration) || durationSeconds;

    for (const adaptation of childrenNamed(period, 'AdaptationSet')) {
      const contentType = String(adaptation.attrs.contentType || '').toLowerCase();
      const mimeType = String(adaptation.attrs.mimeType || '').toLowerCase();
      const inherited = {
        templateNode: firstNamed(adaptation, 'SegmentTemplate'),
        listNode: firstNamed(adaptation, 'SegmentList'),
        segmentBaseNode: firstNamed(adaptation, 'SegmentBase'),
        baseUrlNode: firstNamed(adaptation, 'BaseURL'),
        codecs: adaptation.attrs.codecs || '',
        mimeType: mimeType
      };

      const kind = contentType
        || (mimeType.startsWith('video') ? 'video' : mimeType.startsWith('audio') ? 'audio' : mimeType.includes('ttml') || mimeType.includes('vtt') ? 'text' : '');

      for (const representation of childrenNamed(adaptation, 'Representation')) {
        const described = describeRepresentation(representation, inherited, {
          baseUrl: periodBase || baseUrl,
          durationSeconds: periodDuration
        });
        described.lang = adaptation.attrs.lang || '';
        described.role = (findDescendant(adaptation, ['Role']) || { attrs: {} }).attrs.value || '';

        // 有分片可枚举，或者是 SegmentBase（整文件直接下载）都算可下载
        const downloadable = described.segments.length > 0 || described.segmentBase === true;
        if (!downloadable) continue;
        if (kind === 'video') result.video.push(described);
        else if (kind === 'audio') result.audio.push(described);
        else if (kind === 'text') result.text.push(described);
      }
    }
  }

  return result;
}

/** 选分辨率最高的视频轨 / 码率最高的音轨 */
export function pickBestRepresentations(parsed, options) {
  const opts = options || {};
  const videos = (parsed.video || []).slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const audios = (parsed.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth);
  const video = opts.height ? (videos.find((v) => v.height === opts.height) || videos[0]) : videos[0];
  const audio = audios[0];
  return { video: video || null, audio: audio || null, videos: videos, audios: audios };
}
