#!/usr/bin/env node
/**
 * 站点语料回归（ROADMAP §10）
 *
 * 为什么需要它：没有语料，"泛用性和准确性"只是感觉。这里把
 * 页面数据 -> 适配器 -> 观测 -> 资源图 -> UI 投影 的整条链路跑一遍，
 * 与 golden 里声明的"应该长什么样"逐项比对。
 *
 * 加一个站点 = 加一组 fixture + case；改坏了就会红。
 *
 * 用法：node test/corpus/run.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { extractWithAdapter, selectAdapters } from '../../src/core/site-engine.js';
import { variantsToObservations } from '../../src/core/page-observation.js';
import { mediaToObservation } from '../../src/core/observation.js';
import { ResourceGraph, toMedia } from '../../src/core/graph.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CASES = path.join(ROOT, 'test/corpus/cases');
const FIXTURES = path.join(ROOT, 'test/corpus/fixtures');
const SITES = path.join(ROOT, 'src/sites');

const adapters = readdirSync(SITES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(path.join(SITES, name), 'utf8')));

/** 跑一个 case，返回 { actual, checks } */
export function runCase(testCase) {
  // 和运行时一致：按 URL 选出所有匹配的适配器（站点适配器优先，generic-dom 兜底）并合并
  const matched = selectAdapters(adapters, testCase.url);
  if (matched.length === 0) {
    return { actual: null, checks: [{ name: '适配器匹配', ok: false, detail: testCase.url }] };
  }

  const fixture = testCase.fixture
    ? JSON.parse(readFileSync(path.join(FIXTURES, testCase.fixture), 'utf8'))
    : {};
  const context = {
    data: fixture,
    media: testCase.domMedia || [],
    doc: { title: testCase.title, url: testCase.url },
    url: testCase.url
  };

  const observations = [];
  for (const adapter of matched) {
    const extracted = extractWithAdapter(adapter, context);
    if (!extracted.matched || extracted.variants.length === 0) continue;
    observations.push(...variantsToObservations({
      adapterId: adapter.id,
      mediaId: extracted.id,
      title: extracted.title,
      variants: extracted.variants
    }));
  }

  const graph = new ResourceGraph({ now: () => 1000 });
  for (const observation of observations) {
    graph.upsert(mediaToObservation(observation, 1, 0));
  }
  const media = graph.list({ generation: 0 }).map(toMedia).filter(Boolean);
  const node = media[0] || null;

  const playable = media.some((item) => item.completeness === 'complete'
    || item.completeness === 'video-only'
    || (item.qualities || []).some((quality) => quality.playable));

  const actual = node
    ? {
      nodes: media.length,
      playable: playable,
      variants: node.qualities.length + (node.audio_qualities ? node.audio_qualities.length : 0),
      title: node.title,
      qualityLabels: (node.qualities || []).map((item) => item.label),
      audioLabels: (node.audio_qualities || []).map((item) => item.label),
      completeness: node.completeness
    }
    : { nodes: 0 };

  return { actual, checks: compare(testCase.expect, actual) };
}

export function compare(expect, actual) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('节点数', actual.nodes === expect.nodes, expect.nodes + ' / 实际 ' + actual.nodes);
  if (expect.variants != null) push('变体数', actual.variants === expect.variants, expect.variants + ' / 实际 ' + actual.variants);
  if (expect.title != null) push('标题', actual.title === expect.title, JSON.stringify(actual.title));
  if (expect.qualityLabels) {
    push('画质标签顺序', JSON.stringify(actual.qualityLabels) === JSON.stringify(expect.qualityLabels),
      '期望 ' + JSON.stringify(expect.qualityLabels) + ' 实际 ' + JSON.stringify(actual.qualityLabels));
  }
  if (expect.audioLabels) {
    push('音轨标签', JSON.stringify(actual.audioLabels) === JSON.stringify(expect.audioLabels),
      '期望 ' + JSON.stringify(expect.audioLabels) + ' 实际 ' + JSON.stringify(actual.audioLabels));
  }
  if (expect.completeness != null) {
    push('完整性', actual.completeness === expect.completeness, expect.completeness + ' / 实际 ' + actual.completeness);
  }
  return checks;
}

function main() {
  const asJson = process.argv.includes('--json');
  const files = readdirSync(CASES).filter((name) => name.endsWith('.json')).sort();
  const report = [];
  let failed = 0;
  let total = 0;

  for (const file of files) {
    const testCase = JSON.parse(readFileSync(path.join(CASES, file), 'utf8'));
    const result = runCase(testCase);
    const bad = result.checks.filter((check) => !check.ok);
    total += result.checks.length;
    failed += bad.length;
    report.push({
      case: file,
      name: testCase.name,
      ok: bad.length === 0,
      playable: Boolean(result.actual && result.actual.playable),
      expectsPlayable: testCase.expect ? testCase.expect.playable : undefined,
      checks: result.checks,
      actual: result.actual
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ report, total, failed }, null, 2));
  } else {
    for (const entry of report) {
      console.log((entry.ok ? '[通过] ' : '[失败] ') + entry.name + '  (' + entry.case + ')');
      for (const check of entry.checks) {
        if (!check.ok) console.log('    ✗ ' + check.name + ': ' + check.detail);
      }
    }
    // KPI：泛用性 = 能发现至少一条可播放资源的用例占比；准确性 = 全部断言通过的用例占比
    // 负例（声明 playable: false）只用于检验"不瞎报"，不计入泛用性分母
    const coveragePool = report.filter((entry) => entry.expectsPlayable !== false);
    const playableCases = coveragePool.filter((entry) => entry.playable).length;
    const accurateCases = report.filter((entry) => entry.ok).length;
    const coverage = coveragePool.length > 0 ? playableCases / coveragePool.length : 1;
    const accuracy = report.length > 0 ? accurateCases / report.length : 1;

    console.log('');
    console.log('语料用例 ' + report.length + ' 个，断言 ' + total + ' 条，失败 ' + failed + ' 条');
    console.log('泛用性 P = ' + playableCases + '/' + coveragePool.length + ' = ' + (coverage * 100).toFixed(0) + '%（目标 ≥ 90%）');
    console.log('准确性 A = ' + accurateCases + '/' + report.length + ' = ' + (accuracy * 100).toFixed(0) + '%（目标 ≥ 95%）');

    if (coverage < 0.9 || accuracy < 0.95) {
      console.log('✗ KPI 未达标');
      process.exit(1);
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
