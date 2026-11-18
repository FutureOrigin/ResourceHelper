import test from 'node:test';
import assert from 'node:assert/strict';

import { ResourceGraph, isVariantPlayable, toMedia, variantRank } from '../../src/core/graph.js';

function obs(overrides) {
  return Object.assign({
    key: 'https://cdn.example.com/v/1080.m4s',
    title: '测试视频',
    site: 'example.com',
    kind: 'media',
    scope: { tabId: 1, frameId: 0, documentId: 'D1', generation: 1 },
    provenance: 'webRequest',
    duration: 120,
    variant: {
      id: 'v1080',
      label: '1080P',
      url: 'https://cdn.example.com/v/1080.m4s',
      videoUrl: 'https://cdn.example.com/v/1080.m4s',
      audioUrl: '',
      extension: 'm4s',
      isAudio: false,
      videoOnly: true,
      height: 1080
    }
  }, overrides || {});
}

function clockGraph() {
  let now = 1000;
  const graph = new ResourceGraph({ now: () => now, ttlMs: 1000 });
  return { graph, tick: (delta) => { now += delta; } };
}

test('首次 upsert 创建节点并标记 created/changed', () => {
  const { graph } = clockGraph();
  const result = graph.upsert(obs());
  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  assert.equal(graph.size(), 1);
  assert.equal(result.node.variants.length, 1);
});

test('相同 key 的重复观测不新增节点、不重复变体', () => {
  const { graph } = clockGraph();
  graph.upsert(obs());
  const second = graph.upsert(obs());
  assert.equal(second.created, false);
  assert.equal(graph.size(), 1);
  assert.equal(second.node.variants.length, 1);
  assert.equal(second.changed, false, '完全相同的观测不应触发广播');
});

test('同一 groupKey 的不同变体合并成一张卡（I2）', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ key: 'g:yt', groupKey: 'youtube:abc', variant: { id: 'v1', label: '1080P', url: 'u1', videoOnly: true, extension: 'm4s', height: 1080 } }));
  graph.upsert(obs({ key: 'g:yt2', groupKey: 'youtube:abc', variant: { id: 'v2', label: '720P', url: 'u2', videoOnly: true, extension: 'm4s', height: 720 } }));
  assert.equal(graph.size(), 1);
  const node = graph.get('youtube:abc');
  assert.equal(node.variants.length, 2);
  // 高分变体排在前面，作为封面
  assert.equal(node.variants[0].label, '1080P');
});

test('同一 URL 只能属于一个节点：第二个节点不会凭空建立', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'k1', groupKey: 'page',
    variant: { id: 'v1', url: 'https://x/same.m4s', videoUrl: 'https://x/same.m4s', extension: 'm4s' }
  }));
  const second = graph.upsert(obs({
    key: 'k1', groupKey: 'dom',
    variant: { id: 'v2', url: 'https://x/same.m4s', videoUrl: 'https://x/same.m4s', extension: 'm4s' }
  }));

  assert.equal(graph.size(), 1, '同一个流不应产生第二张卡');
  assert.equal(second.node, null);
  assert.equal(graph.get('page').variants.length, 1);
});

test('第二个节点有自己的独有资源时保留，但不再登记重复 URL', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'k1', groupKey: 'page',
    variant: { id: 'v1', url: 'https://x/shared.m4s', videoUrl: 'https://x/shared.m4s', extension: 'm4s' }
  }));
  graph.upsert(obs({
    key: 'k2', groupKey: 'dom',
    variant: { id: 'v2', url: 'https://x/own.mp4', videoUrl: 'https://x/own.mp4', extension: 'mp4' }
  }));
  graph.upsert(obs({
    key: 'k1', groupKey: 'dom',
    variant: { id: 'v3', url: 'https://x/shared.m4s', videoUrl: 'https://x/shared.m4s', extension: 'm4s' }
  }));

  assert.equal(graph.size(), 2);
  assert.equal(graph.get('dom').variants.length, 1, '重复地址不应被登记到第二个节点');
  assert.equal(graph.get('dom').variants[0].url, 'https://x/own.mp4');
});

test('节点被移除后地址释放，可以被别的节点接管', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'k1', groupKey: 'page',
    variant: { id: 'v1', url: 'https://x/free.m4s', videoUrl: 'https://x/free.m4s', extension: 'm4s' }
  }));
  graph.remove('page');
  const result = graph.upsert(obs({
    key: 'k1', groupKey: 'dom',
    variant: { id: 'v2', url: 'https://x/free.m4s', videoUrl: 'https://x/free.m4s', extension: 'm4s' }
  }));
  assert.ok(result.node);
  assert.equal(graph.get('dom').variants.length, 1);
});

test('节点数超过上限时按最久未见淘汰，且优先淘汰不可播放的', () => {
  const graph = new ResourceGraph({ now: () => 1000, maxNodes: 3, ttlMs: 10 * 60 * 1000 });
  graph.upsert(obs({ key: 'k1', groupKey: 'g1', variant: { id: 'v1', url: 'https://x/1.mp4', videoUrl: 'https://x/1.mp4', extension: 'mp4' } }));
  graph.upsert(obs({ key: 'k2', groupKey: 'g2', variant: { id: 'v2', url: 'https://x/2.m4s', videoUrl: 'https://x/2.m4s', extension: 'm4s', videoOnly: true } }));
  graph.upsert(obs({ key: 'k3', groupKey: 'g3', variant: { id: 'v3', url: 'https://x/3.mp4', videoUrl: 'https://x/3.mp4', extension: 'mp4' } }));
  assert.equal(graph.size(), 3);

  graph.upsert(obs({ key: 'k4', groupKey: 'g4', variant: { id: 'v4', url: 'https://x/4.mp4', videoUrl: 'https://x/4.mp4', extension: 'mp4' } }));
  assert.equal(graph.size(), 3, '超过上限后应立刻淘汰');
  assert.equal(graph.get('g2'), null, '不可播放的优先被淘汰');
  assert.ok(graph.get('g4'), '新来的要留着');
  assert.equal(graph.evicted, 1);
});

test('同一 URL 的不同来源变体合并为一条（迁移期双跑去重）', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'g1', groupKey: 'grp',
    variant: { id: 'bili_80', url: 'https://x/v80.m4s', videoUrl: 'https://x/v80.m4s', extension: 'mp4', videoOnly: true, height: 1080 }
  }));
  graph.upsert(obs({
    key: 'g1', groupKey: 'grp',
    variant: { id: 'rabcdef1234567890', url: 'https://x/v80.m4s', videoUrl: 'https://x/v80.m4s', extension: 'm4s', height: 1080, bitrate: 2400000 }
  }));
  const node = graph.get('grp');
  assert.equal(node.variants.length, 1, '同一 URL 只保留一条变体');
  assert.equal(node.variants[0].id, 'bili_80', '保留先到的 id');
  assert.equal(node.variants[0].bitrate, 2400000, '后到的字段仍然合并进来');
});

test('变体字段做增量合并：空值不覆盖已有值', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ variant: { id: 'v1', url: 'u1', audioUrl: 'a1', extension: 'mp4', isAudio: false } }));
  graph.upsert(obs({ variant: { id: 'v1', url: 'u1', audioUrl: '', extension: 'mp4', isAudio: false } }));
  const node = graph.get(obs().key);
  assert.equal(node.variants[0].audioUrl, 'a1');
});

test('配对：音轨到达后视频变体自动挂上音轨，completeness 升级为 complete', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'grp', groupKey: 'grp',
    variant: { id: 'v1080', url: 'https://x/v1080.mp4', videoUrl: 'https://x/v1080.mp4', extension: 'mp4', videoOnly: true, height: 1080 }
  }));
  let node = graph.get('grp');
  assert.equal(node.completeness, 'video-only');

  graph.upsert(obs({
    key: 'grp', groupKey: 'grp',
    variant: { id: 'a128', url: 'https://x/a128.m4a', extension: 'm4a', isAudio: true, bitrate: 128000 }
  }));
  node = graph.get('grp');
  assert.equal(node.completeness, 'complete');
  assert.equal(node.variants.find((v) => v.id === 'v1080').pairedAudioId, 'a128');

  const media = toMedia(node);
  const quality = media.qualities[0];
  assert.equal(quality.audioUrl, 'https://x/a128.m4a');
  assert.equal(media.audio_qualities.length, 1);
});

test('completeness：仅有视频轨 -> video-only', () => {
  const { graph } = clockGraph();
  const { node } = graph.upsert(obs());
  assert.equal(node.completeness, 'video-only');
});

test('completeness：音画配对后升级为 complete', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ variant: { id: 'v1', url: 'u1', videoUrl: 'u1', extension: 'm4s', videoOnly: true } }));
  const { node } = graph.upsert(obs({
    variant: { id: 'v1', url: 'u1', videoUrl: 'u1', audioUrl: 'a1', extension: 'm4s', videoOnly: false }
  }));
  assert.equal(node.completeness, 'complete');
});

test('completeness：DRM 优先于一切', () => {
  const { graph } = clockGraph();
  const { node } = graph.upsert(obs({ variant: { id: 'v1', url: 'u1', extension: 'mp4', drm: true } }));
  assert.equal(node.completeness, 'drm');
});

test('muxed 容器（mp4）默认视为可播放，m4s 分片不算', () => {
  assert.equal(isVariantPlayable({ url: 'u', extension: 'mp4' }), true);
  assert.equal(isVariantPlayable({ url: 'u', extension: 'm4s' }), false);
  assert.equal(isVariantPlayable({ url: 'u', extension: 'mp4', videoOnly: true }), false);
  assert.equal(isVariantPlayable({ url: 'u', isAudio: true, extension: 'm4a' }), true);
  assert.equal(isVariantPlayable({ url: 'u', extension: 'mp4', drm: true }), false);
});

test('variantRank 让可播放、高分辨率、高码率排前面', () => {
  const hd = variantRank({ url: 'u', height: 1080, extension: 'mp4' });
  const sd = variantRank({ url: 'u', height: 480, extension: 'mp4' });
  const broken = variantRank({ url: 'u', height: 2160, extension: 'm4s', videoOnly: true });
  assert.ok(hd > sd);
  assert.ok(hd > broken, '不可播放的高分辨率不应排在可播放的低分辨率前面');
});

test('provenance 去重并按可信度排序', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ provenance: 'webRequest' }));
  const { node } = graph.upsert(obs({ provenance: 'page-json' }));
  assert.deepEqual(node.provenance.slice(0, 2), ['page-json', 'webRequest']);
});

test('更可信来源的标题即使更短也优先', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ title: '一个非常非常长的标签页标题 - 站点名 - 广告', provenance: 'webRequest' }));
  const { node } = graph.upsert(obs({ title: '真实标题', provenance: 'page-json' }));
  assert.equal(node.title, '真实标题');
});

test('探测回填：只补字段，不新增节点也不改变身份', () => {
  const { graph } = clockGraph();
  const first = graph.upsert(obs({
    variant: { id: 'v1', url: 'https://cdn.example.com/v/1080.m4s', extension: 'm4s', videoOnly: true }
  }));
  assert.equal(first.node.variants[0].sizeBytes, undefined);

  const enriched = graph.upsert({
    key: obs().key,
    groupKey: obs().key,
    scope: obs().scope,
    variant: {
      id: 'v1',
      extension: 'mp4',
      sizeBytes: 183456789,
      mime: 'video/mp4',
      container: 'mp4',
      filename: '真实标题.mp4'
    }
  });
  assert.equal(graph.size(), 1, '探测不应产生新节点');
  const variant = enriched.node.variants[0];
  assert.equal(variant.sizeBytes, 183456789);
  assert.equal(variant.extension, 'mp4');
  assert.equal(variant.mime, 'video/mp4');
  assert.equal(variant.filename, '真实标题.mp4');
  assert.equal(variant.url, 'https://cdn.example.com/v/1080.m4s', '原有字段不能被清空');

  const media = toMedia(enriched.node);
  assert.equal(media.size, 183456789);
  assert.equal(media.filename, '真实标题.mp4');
});

test('expire 按 lastSeenAt 清理超期节点', () => {
  const { graph, tick } = clockGraph();
  graph.upsert(obs());
  tick(500);
  graph.upsert(obs({ key: 'https://cdn.example.com/v/720.m4s', variant: { id: 'v720', url: 'https://cdn.example.com/v/720.m4s', videoUrl: 'https://cdn.example.com/v/720.m4s', extension: 'm4s', videoOnly: true, height: 720 } }));
  tick(600);
  const removed = graph.expire();
  assert.deepEqual(removed, [obs().key]);
  assert.equal(graph.size(), 1);
});

test('clearStale 只保留当前导航代次', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ scope: { tabId: 1, frameId: 0, documentId: 'D1', generation: 1 } }));
  graph.upsert(obs({ key: 'k2', variant: { id: 'v720', url: 'https://cdn.example.com/v/720.m4s', videoUrl: 'https://cdn.example.com/v/720.m4s', extension: 'm4s', videoOnly: true, height: 720 }, scope: { tabId: 1, frameId: 0, documentId: 'D2', generation: 2 } }));
  const removed = graph.clearStale(2);
  assert.equal(removed.length, 1);
  assert.equal(graph.size(), 1);
});

test('list 支持按代次与框架过滤', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({ scope: { tabId: 1, frameId: 0, documentId: 'D1', generation: 3 } }));
  graph.upsert(obs({ key: 'k2', variant: { id: 'v720', url: 'https://cdn.example.com/v/720.m4s', videoUrl: 'https://cdn.example.com/v/720.m4s', extension: 'm4s', videoOnly: true, height: 720 }, scope: { tabId: 1, frameId: 7, documentId: 'D2', generation: 3 } }));
  assert.equal(graph.list({ generation: 3 }).length, 1, '默认只返回主框架');
  assert.equal(graph.list({ generation: 3, includeFrames: true }).length, 2);
  assert.equal(graph.list({ generation: 3, includeFrames: true, frameId: 7 }).length, 1);
  assert.equal(graph.list({ generation: 4 }).length, 0);
});

test('snapshot/load 往返保真', () => {
  const { graph } = clockGraph();
  graph.upsert(obs());
  graph.upsert(obs({ key: 'k2', groupKey: 'group-2', title: '另一个视频', variant: { id: 'v720', url: 'https://cdn.example.com/v/720.m4s', videoUrl: 'https://cdn.example.com/v/720.m4s', extension: 'm4s', videoOnly: true, height: 720 } }));
  const restored = ResourceGraph.load(graph.snapshot(), { now: () => 2000 });
  assert.equal(restored.size(), 2);
  assert.equal(restored.get(obs().key).title, '测试视频');
});

test('toMedia 把 node 投影成 UI 契约', () => {
  const { graph } = clockGraph();
  graph.upsert(obs({
    key: 'youtube:abc:137', groupKey: 'youtube:abc', title: '某视频（完整标题）',
    variant: { id: 'q137', label: '1080P', url: 'v137', videoUrl: 'v137', extension: 'm4s', videoOnly: true, height: 1080 }
  }));
  graph.upsert(obs({
    key: 'youtube:abc:140', groupKey: 'youtube:abc',
    variant: { id: 'q140', label: '128K AAC', url: 'a140', audioUrl: 'a140', extension: 'm4a', isAudio: true }
  }));
  const media = toMedia(graph.get('youtube:abc'));
  assert.equal(media.title, '某视频（完整标题）');
  assert.equal(media.key, 'youtube:abc');
  assert.equal(media.qualities.length, 1, '视频变体进 qualities');
  assert.equal(media.audio_qualities.length, 1, '音轨单独投影，等 P2/P3 才配对');
  assert.equal(media.audio_qualities[0].audioUrl, 'a140');
  assert.equal(media.completeness, 'complete');
});
