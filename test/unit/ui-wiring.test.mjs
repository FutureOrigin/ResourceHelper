/**
 * 侧边栏接线守卫（静态检查）
 *
 * 这类问题不会让测试变红，但会让功能"看不见"：加了 Tab 却没注册、加了页面却没接消息。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel) => readFileSync(path.join(ROOT, 'src', rel), 'utf8');

test('每个导航按钮都有对应的面板', () => {
  const html = read('sidepanel/index.html');
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, '至少 5 个 Tab');
  for (const tab of tabs) {
    assert.ok(html.includes('id="pane-' + tab + '"'), '缺少 pane-' + tab);
  }
});

test('下载历史页已接线（模块、实例化、消息、刷新）', () => {
  const main = read('sidepanel/main.js');
  assert.ok(main.includes("from './modules/history_tab.js'"), '未导入 HistoryTab');
  assert.ok(main.includes('new HistoryTab()'), '未实例化 HistoryTab');
  assert.ok(main.includes('historyTab.init('), '未初始化 HistoryTab');
  assert.ok(main.includes("tabName === 'history'"), '切到历史页时未刷新');
  assert.ok(main.includes('RH_HISTORY_CHANGED'), '未监听历史变更');
});

test('三条引擎下载路径都会写入历史（经由统一落盘末端）', () => {
  for (const rel of ['sidepanel/modules/stream_downloader.js', 'sidepanel/modules/dash_downloader.js', 'sidepanel/modules/media_muxer.js']) {
    const source = read(rel);
    assert.ok(
      source.includes('finalizeBlobDownload(') || source.includes('reportDownloadStarted('),
      rel + ' 未回报下载历史'
    );
  }
  const finalize = read('sidepanel/modules/download_finalize.js');
  assert.ok(finalize.includes('reportDownloadStarted('), '统一末端必须写入历史');
});

test('HLS 独立音轨组会被合流而不是丢弃', () => {
  const source = read('sidepanel/modules/stream_downloader.js');
  assert.ok(source.includes('pickAudioRendition('), '未识别独立音轨组');
  assert.ok(source.includes('collectTrack('), '缺少整轨收集（合流需要全量字节）');
  assert.ok(source.includes('remuxFragmented('), '未对独立音轨做无损合流');
  assert.ok(source.includes('canMuxAudio'), '缺少"能否合流"的判定');
});

test('合流前必须检查体积预算', () => {
  const muxer = read('sidepanel/modules/media_muxer.js');
  assert.ok(muxer.includes("from '../../core/limits.js'"), '未引入预算模块');
  assert.ok(muxer.includes('checkMuxBudget('), '合流前未做预算判定');
  assert.ok(muxer.includes('describeBudgetFailure('), '超预算时缺少人话说明');
  assert.ok(
    muxer.includes('packVideoOnly(') || muxer.includes('saveVideoOnly('),
    '超预算应降级为"仅视频轨"'
  );
});

test('引擎下载走串行队列', () => {
  const videoTab = read('sidepanel/modules/video_tab.js');
  assert.ok(videoTab.includes("from '../../core/task-queue.js'"), '未引入 TaskQueue');
  assert.ok(videoTab.includes('enqueueDownload('), '缺少入队入口');
  const dispatch = videoTab.split('enqueueDownload(').length - 1;
  assert.ok(dispatch >= 4, '三条引擎路径都应当经过队列，实际调用点 ' + dispatch);
  assert.ok(videoTab.includes('renderQueueBar('), '队列状态未显示给用户');
  assert.ok(videoTab.includes('cancelPending('), '排队任务无法取消');
});

test('历史页重下按模式分发，而不是一律直链', () => {
  const historyTab = read('sidepanel/modules/history_tab.js');
  assert.ok(historyTab.includes('async retry('), '缺少 retry');
  assert.ok(historyTab.includes('streamDownloader.downloadM3u8'), 'HLS 重下未走下载器');
  assert.ok(historyTab.includes('dashDownloader.download'), 'DASH 重下未走下载器');
  assert.ok(historyTab.includes('mediaMuxer.mergeAndDownload'), '合流重下未走合流器');
});

test('直播录制的接线齐全', () => {
  const videoTab = read('sidepanel/modules/video_tab.js');
  assert.ok(videoTab.includes("from './live_recorder.js'"), '未导入 LiveRecorder');
  assert.ok(videoTab.includes('toggleLiveRecording('), '缺少录制入口');
  assert.ok(videoTab.includes('live-record-btn'), 'HLS 卡片缺少录制按钮');

  const recorder = read('sidepanel/modules/live_recorder.js');
  assert.ok(recorder.includes("from '../../core/live-record.js'"), '未复用账本逻辑');
  assert.ok(recorder.includes("from '../../core/sink.js'"), '未用滚动落盘');
  assert.ok(
    recorder.includes('finalizeBlobDownload(') || recorder.includes('reportDownloadStarted('),
    '录制结果未写入历史'
  );
});

test('offscreen 构建链路接线齐全', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('offscreen'), '缺少 offscreen 权限');

  const root = path.resolve(import.meta.dirname, '../..');
  for (const rel of ['src/offscreen/offscreen.html', 'src/offscreen/offscreen.js', 'src/bg/offscreen.js']) {
    assert.ok(existsSync(path.join(root, rel)), '缺少文件 ' + rel);
  }

  const background = read('service/background.js');
  assert.ok(background.includes('OFFSCREEN_MESSAGE.BUILD'), '后台未处理构建请求');
  assert.ok(background.includes('OFFSCREEN_MESSAGE.READY'), '后台未处理构建完成');
  assert.ok(background.includes('releaseOffscreenBlob'), 'blob URL 未在下载结束后释放');

  const videoTab = read('sidepanel/modules/video_tab.js');
  assert.ok(videoTab.includes('tryOffscreen('), '侧边栏未尝试委托 offscreen');
  assert.ok(videoTab.includes('handleBuildResult('), '侧边栏未处理构建失败');
  assert.ok(videoTab.includes('await local()'), '缺少回退到本地构建的路径');
});

test('后台提供历史读写接口', () => {
  const background = read('service/background.js');
  for (const type of ['RH_GET_HISTORY', 'RH_CLEAR_HISTORY', 'RH_DOWNLOAD_STARTED']) {
    assert.ok(background.includes("'" + type + "'"), '缺少消息处理：' + type);
  }
  assert.ok(background.includes('downloads.onChanged'), '缺少下载状态监听');
});
