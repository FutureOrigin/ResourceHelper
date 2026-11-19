/**
 * 设置（P6 地基）
 *
 * 目标：把"深度模式 / 提示开关 / 图片扫描阈值"这类可选行为变成一份有默认值、
 * 有校验、可迁移的数据，而不是散落在各处的常量。
 *
 * 纯函数：读取 storage 的动作在调用方（后台/设置页），这里只管数据形状。
 */

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  // 深度模式：注入页面钩子并上报名额内的 MSE 信息。默认关（ROADMAP 决策 3）
  deepCapture: true,
  // 面板里是否展示 MSE / blob 提示条
  showHookHint: true,
  // 图片扫描时小于该边长的图直接丢弃（0 表示不过滤）
  imageMinSize: 100,
  // 单页最多显示的媒体条数（图多的时候保护侧边栏）
  maxMediaPerTab: 200,
  // 下载文件名模板：{title} {quality} {ext}
  filenameTemplate: '{title} [{quality}].{ext}',
  // ---- 整页快照（P8）----
  // 去掉脚本（含内联 on* 事件属性）：离线打开时不该再执行页面代码
  archiveRemoveScripts: true,
  // 图片/字体/背景图内联成 data URI；关掉就是"能联网才完整"的 HTML
  archiveInlineImages: true,
  // 把 iframe 的内容也塞进 srcdoc
  archiveEmbedFrames: true,
  // 体积优化：删掉不渲染（display:none）的元素
  archiveRemoveHidden: true,
  // 体积优化：删掉当前文档里根本匹配不到的 CSS 规则
  archiveRemoveUnusedCss: true,
  // 防盗链场景：抓取失败后是否允许"临时带上页面 Referer 再试一次"
  archiveRefererRetry: true,
  // 单个资源上限（MiB）
  archiveMaxResourceMB: 4,
  // 整份快照的内联字节上限（MiB）
  archiveMaxTotalMB: 40
};

/** 布尔开关：只接受真正的 boolean，其它一律回退默认值 */
const BOOLEAN_KEYS = [
  'deepCapture',
  'showHookHint',
  'archiveRemoveScripts',
  'archiveInlineImages',
  'archiveEmbedFrames',
  'archiveRemoveHidden',
  'archiveRemoveUnusedCss',
  'archiveRefererRetry'
];

const LIMITS = {
  imageMinSize: { min: 0, max: 2000 },
  maxMediaPerTab: { min: 10, max: 2000 },
  archiveMaxResourceMB: { min: 1, max: 64 },
  archiveMaxTotalMB: { min: 5, max: 512 }
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把任意输入（storage / 设置页表单）规整成合法设置。
 * 未知字段丢弃、越界值夹紧、类型不对回退默认值 —— 设置永远不该把扩展弄坏。
 */
export function normalizeSettings(input) {
  const raw = isPlainObject(input) ? input : {};
  const out = Object.assign({}, DEFAULT_SETTINGS);

  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }

  for (const [key, range] of Object.entries(LIMITS)) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) {
      out[key] = Math.min(range.max, Math.max(range.min, Math.round(value)));
    }
  }

  if (typeof raw.filenameTemplate === 'string' && raw.filenameTemplate.trim()) {
    const template = raw.filenameTemplate.trim().slice(0, 120);
    // 至少要能插进标题或扩展名，否则文件名会退化成空字符串
    out.filenameTemplate = /\{(title|quality|ext|site|date)\}/.test(template) ? template : DEFAULT_SETTINGS.filenameTemplate;
  }

  out.version = SETTINGS_VERSION;
  return out;
}

/** 只把与默认值不同的项存起来，减少 sync 存储的写入 */
export function diffSettings(settings) {
  const normalized = normalizeSettings(settings);
  const diff = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'version') continue;
    if (value !== DEFAULT_SETTINGS[key]) diff[key] = value;
  }
  return diff;
}

/** 按模板渲染文件名（不含非法字符清洗，交给 decision.buildFilename） */
export function renderFilenameTemplate(template, values) {
  const source = typeof template === 'string' && template ? template : DEFAULT_SETTINGS.filenameTemplate;
  const map = Object.assign({ title: 'resource', quality: '', ext: 'bin', site: '', date: '' }, values || {});
  const rendered = source.replace(/\{(title|quality|ext|site|date)\}/g, (whole, key) => {
    const value = map[key] == null ? '' : String(map[key]);
    return value;
  });
  return rendered
    .replace(/\[\s*\]/g, '')       // "{quality}" 为空时留下的空方括号
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.\-_])/g, '$1')  // 清理"标题 .mp4"这种标点前的空格
    .replace(/\s{2,}/g, ' ')
    .trim();
}
