/**
 * 合流偏移探针
 * 运行：node test/probes/remux-offsets.probe.mjs
 *
 * 历史（AUDIT §6.1）：旧实现在 moov 变长后不重写 stco，探针实测视频轨偏移早 112 字节、
 * 音频轨早 1144 字节。P3 引入 src/core/remux.js 后，偏移必须指向对应轨道的数据。
 */
import { buildBox, children, concatBytes, parseTopLevel, readChunkOffsets } from '../../src/core/mp4.js';
import { remuxProgressive } from '../../src/core/remux.js';

const u32 = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const box = (type, parts) => buildBox(type, concatBytes(parts || []));

function mvhd(timescale, duration) {
  const payload = new Uint8Array(96);
  payload.set(u32(timescale), 12);
  payload.set(u32(duration), 16);
  return buildBox('mvhd', payload);
}
function tkhd(trackId) {
  const payload = new Uint8Array(76);
  payload.set(u32(trackId), 12);
  return buildBox('tkhd', payload);
}
function stco(offsets) {
  const payload = new Uint8Array(8 + offsets.length * 4);
  payload.set(u32(offsets.length), 4);
  offsets.forEach((value, index) => payload.set(u32(value), 8 + index * 4));
  return buildBox('stco', payload);
}
const FTYP = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])]);

function makeFile(trackId, dataLength, fill, timescale) {
  const mdat = buildBox('mdat', new Uint8Array(dataLength).fill(fill));
  const probeMoov = box('moov', [mvhd(timescale || 1000, 4000), box('trak', [tkhd(trackId), box('mdia', [box('minf', [box('stbl', [stco([0])])])])])]);
  const dataOffset = FTYP.length + probeMoov.length + 8;
  const moov = box('moov', [mvhd(timescale || 1000, 4000), box('trak', [tkhd(trackId), box('mdia', [box('minf', [box('stbl', [stco([dataOffset])])])])])]);
  return concatBytes([FTYP, moov, mdat]);
}

const video = makeFile(1, 100, 0xaa);
const audio = makeFile(1, 60, 0xbb, 48000);

const { data, stats } = remuxProgressive(video, audio);
const top = parseTopLevel(data);
const traks = children(data, top.moov, 'trak');
const vOffsets = readChunkOffsets(data, traks[0]);
const aOffsets = readChunkOffsets(data, traks[1]);

const videoOk = data[vOffsets.values[0]] === 0xaa && data[vOffsets.values[0] + 99] === 0xaa;
const audioOk = data[aOffsets.values[0]] === 0xbb && data[aOffsets.values[0] + 59] === 0xbb;

console.log('输入: video', video.length, 'bytes | audio', audio.length, 'bytes');
console.log('输出:', data.length, 'bytes | trak 数:', traks.length);
console.log('video stco[0] =', vOffsets.values[0], '-> 字节', data[vOffsets.values[0]].toString(16), videoOk ? '(正确)' : '(错误)');
console.log('audio stco[0] =', aOffsets.values[0], '-> 字节', data[aOffsets.values[0]].toString(16), audioOk ? '(正确)' : '(错误)');
console.log('videoDelta =', stats.videoDelta, '| audioDelta =', stats.audioDelta, '| audioTrackId =', stats.audioTrackId);

const ok = videoOk && audioOk && traks.length === 2;
console.log('RESULT: ' + (ok ? 'OK — 两条轨的采样偏移都指向自己的数据。' : 'BROKEN — 采样偏移仍然错位。'));
process.exit(ok ? 0 : 1);
