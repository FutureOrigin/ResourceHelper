/**
 * 设置的持久化（chrome.storage.sync 假实现）
 *
 * 目标不是测 storage 本身，而是锁住两条不变量：
 *   1. 读出的一定是合法设置（别人手改 storage 也不会把扩展弄坏）
 *   2. 写回的只包含与默认值不同的项
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function makeChrome(initial) {
  const store = { settings: initial };
  const listeners = [];
  return {
    store,
    listeners,
    chrome: {
      storage: {
        sync: {
          async get(key) { return { [key]: store[key] }; },
          async set(payload) { Object.assign(store, payload); }
        },
        onChanged: { addListener(fn) { listeners.push(fn); } }
      }
    }
  };
}

async function freshModule() {
  const module = await import('../../src/bg/settings.js');
  module.resetSettingsCache();
  return module;
}

test('默认读取：空 storage 返回默认值', async () => {
  const fake = makeChrome(undefined);
  globalThis.chrome = fake.chrome;
  const { loadSettings } = await freshModule();
  const settings = await loadSettings();
  assert.equal(settings.imageMinSize, 100);
  assert.equal(settings.deepCapture, true);
  delete globalThis.chrome;
});

test('坏数据被规整成合法设置', async () => {
  const fake = makeChrome({ deepCapture: 'yes', imageMinSize: 99999 });
  globalThis.chrome = fake.chrome;
  const { loadSettings } = await freshModule();
  const settings = await loadSettings();
  assert.equal(settings.deepCapture, true, '非布尔回退默认值');
  assert.equal(settings.imageMinSize, 2000, '越界夹紧');
  delete globalThis.chrome;
});

test('保存只写差异项', async () => {
  const fake = makeChrome(undefined);
  globalThis.chrome = fake.chrome;
  const { saveSettings } = await freshModule();
  await saveSettings({ imageMinSize: 240 });
  assert.deepEqual(fake.store.settings, { imageMinSize: 240 });
  delete globalThis.chrome;
});

test('设置变化会通知订阅者', async () => {
  const fake = makeChrome({ imageMinSize: 120 });
  globalThis.chrome = fake.chrome;
  const { watchSettings } = await freshModule();
  let seen = null;
  watchSettings((settings) => { seen = settings; });
  fake.listeners.forEach((fn) => fn({ settings: { newValue: { imageMinSize: 300 } } }, 'sync'));
  assert.equal(seen.imageMinSize, 300);
  delete globalThis.chrome;
});

test('storage 抛错时回退默认值而不是崩溃', async () => {
  globalThis.chrome = { storage: { sync: { async get() { throw new Error('denied'); } }, onChanged: { addListener() {} } } };
  const { loadSettings } = await freshModule();
  const settings = await loadSettings();
  assert.equal(settings.imageMinSize, 100);
  delete globalThis.chrome;
});
