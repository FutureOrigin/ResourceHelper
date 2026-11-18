/**
 * 极简 DOM 构造器
 *
 * 存在的唯一理由：资源标题、图片地址、音频名全部来自网页，属于不可信输入。
 * 直接把它们拼进 innerHTML 会产生 HTML 注入（AUDIT F1，全仓 26 处）。
 * 这里用 createElement + textContent 表达同样的结构，插值天然被转义。
 */

function appendChildren(node, children) {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(node, child);
    return;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return;
  }
  node.appendChild(document.createTextNode(String(children)));
}

/**
 * @param {string} tag
 * @param {Object|null} props  class / text / dataset / style / on* / disabled / 其它作为属性
 * @param {Array|Node|string} children
 */
export function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'disabled' || key === 'checked' || key === 'selected') node[key] = Boolean(value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

/** 清空子节点（唯一的合法 innerHTML 赋值形式） */
export function clear(node) {
  if (node) node.innerHTML = '';
}

export function setText(node, value) {
  if (node) node.textContent = value == null ? '' : String(value);
}
