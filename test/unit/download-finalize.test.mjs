import test from 'node:test';
import assert from 'node:assert/strict';

import { finalizeBlobDownload } from '../../src/sidepanel/modules/download_finalize.js';

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' });

function harness(options) {
  const opts = options || {};
  const calls = { download: [], revoked: [], created: 0, scheduled: 0, reported: [] };
  return {
    calls,
    input: {
      blob: blob(),
      filename: '某视频.mp4',
      meta: { title: '某视频', url: 'https://x/v.mp4', mode: 'direct', site: 'x' },
      downloads: {
        async download(payload) {
          calls.download.push(payload);
          if (opts.failDownload) throw new Error('下载启动失败');
          return 42;
        }
      },
      createObjectUrl: () => { calls.created += 1; return 'blob:test'; },
      revokeObjectUrl: (url) => { calls.revoked.push(url); },
      scheduleRevoke: (fn) => { calls.scheduled += 1; if (opts.runRevoke) fn(); }
    }
  };
}

test('正常落地：下载一次、释放一次、返回浏览器下载 id', async () => {
  const h = harness({ runRevoke: true });
  const id = await finalizeBlobDownload(h.input);

  assert.equal(id, 42);
  assert.equal(h.calls.created, 1);
  assert.equal(h.calls.download.length, 1);
  assert.equal(h.calls.download[0].url, 'blob:test');
  assert.equal(h.calls.download[0].filename, '某视频.mp4');
  assert.equal(h.calls.download[0].saveAs, false);
  assert.deepEqual(h.calls.revoked, ['blob:test']);
});

test('释放是延后的：下载刚启动时不能 revoke', async () => {
  const h = harness({ runRevoke: false });
  await finalizeBlobDownload(h.input);
  assert.equal(h.calls.scheduled, 1);
  assert.deepEqual(h.calls.revoked, [], '未到期前不应 revoke');
});

test('下载失败时立刻释放并抛出', async () => {
  const h = harness({ failDownload: true });
  await assert.rejects(finalizeBlobDownload(h.input), /下载启动失败/);
  assert.deepEqual(h.calls.revoked, ['blob:test']);
});

test('缺少数据或文件名时明确报错，且不创建 URL', async () => {
  const h = harness();
  await assert.rejects(finalizeBlobDownload({ downloads: h.input.downloads, filename: 'x.mp4' }), /没有可保存的数据/);
  await assert.rejects(finalizeBlobDownload({ downloads: h.input.downloads, blob: blob() }), /缺少文件名/);
  assert.equal(h.calls.created, 0);
});

test('下载接口缺失时报错而不是静默', async () => {
  await assert.rejects(
    finalizeBlobDownload({ blob: blob(), filename: 'x.mp4', downloads: {} }),
    /下载接口不可用/
  );
});
