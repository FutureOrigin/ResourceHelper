/**
 * 静态 SVG 图标（不含任何插值，可安全用于 innerHTML）
 */
const ICONS = {
  download: '<svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  copy: '<svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
};

/** 返回包含该图标的 DocumentFragment（template 解析可正确处理 SVG 命名空间） */
export function icon(name) {
  const markup = ICONS[name];
  const holder = document.createElement('template');
  if (markup) holder.innerHTML = markup;
  return holder.content.cloneNode(true);
}
