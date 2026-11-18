/**
 * fMP4 分片合流探针
 * 运行：node test/probes/remux-fragments.probe.mjs
 *
 * 验证：两条分片 MP4（moov+mvex+moof×N）合流后
 *   · 只有一个 moov，内含 2 条 trak 与 2 条 trex
 *   · 片段按 视频/音频 交错，mfhd 序号连续递增
 *   · 音频 tfhd 的 track_id 与视频冲突时被重编
 *   · 每个片段的 trun data_offset 仍指向自己的数据
 */
import {
  buildBox,
  children,
  concatBytes,
  findChild,
  groupFragments,
  listTrex,
  parseTopLevel,
  readMfhdSequence,
  readTrunDataOffset,
  readUint32
} from '../../src/core/mp4.js';
import { remuxFragmented } from '../../src/core/remux.js';

const u32 = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const box = (type, parts) => buildBox(type, concatBytes(parts || []));
const fullBox = (type, flags, payload) => {
  const body = new Uint8Array(4 + payload.length);
  body[1] = (flags >>> 16) & 0xff;
  body[2] = (flags >>> 8) & 0xff;
  body[3] = flags & 0xff;
  body.set(payload, 4);
  return buildBox(type, body);
};

function tkhd(trackId) {
  const payload = new Uint8Array(76);
  payload.set(u32(trackId), 12);
  return buildBox('tkhd', payload);
}
function mvhd(timescale) {
  const payload = new Uint8Array(96);
  payload.set(u32(timescale), 12);
  return buildBox('mvhd', payload);
}
function trex(trackId) {
  const payload = new Uint8Array(24);
  payload.set(u32(trackId), 4);
  return buildBox('trex', payload);
}

function makeFragmented(trackId, fragmentCount, fill) {
  const ftyp = box('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x35, 0, 0, 2, 0])]);
  const moov = box('moov', [mvhd(1000), box('trak', [tkhd(trackId), box('mdia', [])]), box('mvex', [trex(trackId)])]);

  const parts = [ftyp, moov];
  for (let i = 0; i < fragmentCount; i += 1) {
    const mdat = buildBox('mdat', new Uint8Array(32).fill(fill));
    const probeMoof = box('moof', [
      fullBox('mfhd', 0, u32(i + 1)),
      box('traf', [fullBox('tfhd', 0x020000, u32(trackId)), fullBox('trun', 0x000001, new Uint8Array(8))])
    ]);
    const dataOffset = probeMoof.length + 8;
    const trunPayload = new Uint8Array(8);
    trunPayload.set(u32(1), 0);
    trunPayload.set(u32(dataOffset), 4);
    const moof = box('moof', [
      fullBox('mfhd', 0, u32(i + 1)),
      box('traf', [fullBox('tfhd', 0x020000, u32(trackId)), fullBox('trun', 0x000001, trunPayload)])
    ]);
    parts.push(moof, mdat);
  }
  return concatBytes(parts);
}

const video = makeFragmented(1, 2, 0xaa);
const audio = makeFragmented(1, 2, 0xbb);

const { data, stats } = remuxFragmented(video, audio);
const top = parseTopLevel(data);
const traks = top.moov ? children(data, top.moov, 'trak') : [];
const mvex = top.moov ? children(data, top.moov, 'mvex')[0] : null;
const trexes = mvex ? listTrex(data, mvex) : [];
const groups = groupFragments(data).fragments;

const sequences = groups.map((group) => {
  const moofBox = { type: 'moof', start: group.moof.start, end: group.moof.end, headerSize: 8, size: group.moof.size };
  const inner = children(data, moofBox);
  return readMfhdSequence(data, inner.find((b) => b.type === 'mfhd'));
});

const firstTrafs = (index) => {
  const moofBox = { type: 'moof', start: groups[index].moof.start, end: groups[index].moof.end, headerSize: 8, size: groups[index].moof.size };
  return children(data, moofBox).find((b) => b.type === 'traf');
};
const dataByteAt = (index, expected) => {
  const traf = firstTrafs(index);
  const trun = findChild(data, traf, 'trun');
  const offset = readTrunDataOffset(data, trun);
  return data[groups[index].moof.start + offset] === expected;
};
const audioTfhdTrackId = () => {
  const tfhdBox = findChild(data, firstTrafs(1), 'tfhd');
  return readUint32(data, tfhdBox.start + 12);
};

const checks = {
  '两个 moov 合并为一个': top.boxes.filter((b) => b.type === 'moov').length === 1,
  '两条 trak': traks.length === 2,
  '两条 trex': trexes.length === 2,
  '四个片段组': groups.length === 4,
  '序号连续递增': sequences.join(',') === '1,2,3,4',
  '视频数据可定位': dataByteAt(0, 0xaa),
  '音频数据可定位': dataByteAt(1, 0xbb),
  '音频 track_id 重编': audioTfhdTrackId() === stats.audioTrackId && stats.audioTrackId !== 1
};

console.log('输入: video', video.length, 'bytes | audio', audio.length, 'bytes');
console.log('输出:', data.length, 'bytes | trak', traks.length, '| trex', trexes.length, '| 片段组', groups.length);
console.log('mfhd 序号:', sequences.join(','));
console.log('音频 tfhd track_id:', audioTfhdTrackId(), '(视频为 1)');
for (const [name, ok] of Object.entries(checks)) console.log((ok ? '  [ok] ' : '  [!!] ') + name);

const allOk = Object.values(checks).every(Boolean);
console.log('RESULT: ' + (allOk ? 'OK — 分片合流结构自洽。' : 'BROKEN — 分片合流结构有问题。'));
process.exit(allOk ? 0 : 1);
