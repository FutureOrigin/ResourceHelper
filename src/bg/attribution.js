/**
 * 归属与代次（I4：每条资源知道自己在哪）
 *
 * 旧实现只按 tabId 归属（AUDIT B4），后果有两个：
 *   1) iframe 里的广告/挂件视频和主页面视频混在同一个列表里；
 *   2) SPA 换了一集之后，上一集的流仍然挂在列表上。
 *
 * 这里把"归属"抽成可单测的两个东西：
 *   attributeMedia(media, details)  把 webRequest 的 documentId/frameId 挂到观测上
 *   NavigationTracker               每个标签页的导航代次
 */

/** 把 webRequest details 的归属字段挂到 media 上（不改变已有值以外的东西） */
export function attributeMedia(media, details) {
  if (!media || !details) return media;
  if (details.documentId) media.document_id = details.documentId;
  if (Number.isInteger(details.frameId)) media.frame_id = details.frameId;
  if (Number.isInteger(details.tabId)) media.tab_id = details.tabId;
  return media;
}

export class NavigationTracker {
  constructor() {
    this.state = new Map(); // tabId -> { generation, documentId }
  }

  generationOf(tabId) {
    const state = this.state.get(tabId);
    return state ? state.generation : 0;
  }

  documentOf(tabId) {
    const state = this.state.get(tabId);
    return state ? state.documentId : '';
  }

  /** 换一次代次（真实导航与前端路由都会调用），返回新代次 */
  bump(tabId, documentId) {
    const previous = this.state.get(tabId) || { generation: 0, documentId: '' };
    const next = { generation: previous.generation + 1, documentId: documentId || '' };
    this.state.set(tabId, next);
    return next.generation;
  }

  reset(tabId) {
    this.state.delete(tabId);
  }

  /** 只保留当前代次的节点；没有 scope 的节点视为当前代次（兼容老快照） */
  filterByGeneration(nodes, tabId) {
    const generation = this.generationOf(tabId);
    return (nodes || []).filter((node) => !node.scope || node.scope.generation === generation);
  }
}
