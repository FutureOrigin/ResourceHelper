/**
 * 身份唯一性探针
 * 运行：node test/probes/identity-collision.probe.mjs
 *
 * 历史（AUDIT §6.2）：旧实现用 32 位累加哈希当 Map 键，9.1 万个 URL 就碰撞，
 * 后到的资源静默覆盖先到的。P1.1 改为"规范化 URL 即身份"，短 ID 只用于显示。
 *
 * 本探针验证：
 *   1. 40 万个不同 URL 下，resourceKey 零碰撞（身份正确性）
 *   2. 同一资源不同分块区间折叠为同一个 key（去重正确性）
 */
import { resourceKey, shortId } from '../../src/core/identity.js';

const N = 400000;
const keys = new Set();
const ids = new Set();
let duplicateKeys = 0;
let duplicateIds = 0;
const started = Date.now();

for (let i = 0; i < N; i += 1) {
  const url = 'https://cdn' + (i % 7) + '.example.com/media/'
    + i.toString(36) + '.mp4?token=' + ((i * 2654435761) % 1000003);
  const key = resourceKey(url);
  const id = shortId(key);
  if (keys.has(key)) duplicateKeys += 1;
  if (ids.has(id)) duplicateIds += 1;
  keys.add(key);
  ids.add(id);
}

const elapsed = Date.now() - started;
console.log('distinct URLs:', N, '| unique keys:', keys.size, '| unique short ids:', ids.size);
console.log('duplicate keys:', duplicateKeys, '| duplicate short ids:', duplicateIds, '| elapsed:', elapsed + 'ms');

const chunkA = 'https://rr1.googlevideo.com/videoplayback?itag=137&id=abc&range=0-1048575';
const chunkB = 'https://rr1.googlevideo.com/videoplayback?itag=137&id=abc&range=1048576-2097151';
const chunkCollapsed = resourceKey(chunkA) === resourceKey(chunkB);
console.log('same track different range collapses:', chunkCollapsed);

const ok = duplicateKeys === 0 && duplicateIds === 0 && chunkCollapsed;
console.log('RESULT: ' + (ok ? 'OK — 身份唯一，分块正确折叠。' : 'BROKEN — 身份存在碰撞或分块未折叠。'));
process.exit(ok ? 0 : 1);
