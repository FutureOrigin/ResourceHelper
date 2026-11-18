import test from 'node:test';
import assert from 'node:assert/strict';

import { isSniffedMedia, sniffBytes, sniffExtension } from '../../src/core/sniff.js';

function bytes(...values) {
  return new Uint8Array(values);
}

function ascii(text, prefix) {
  const head = prefix ? new Uint8Array(prefix) : new Uint8Array(0);
  const tail = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

function box(headType, payload) {
  // 4 字节 size + 4 字节 type + payload
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = payload.length + 8;
  for (let i = 0; i < 4; i += 1) out[4 + i] = headType.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

test('ISO BMFF：ftyp 品牌决定容器与类型', () => {
  const mp4 = bytes(...box('ftyp', ascii('isom')), 0, 0, 0, 0);
  assert.deepEqual(sniffBytes(mp4), { kind: 'video', container: 'mp4', detail: 'isom' });

  const m4a = bytes(...box('ftyp', ascii('M4A ')), 0, 0, 0, 0);
  assert.equal(sniffBytes(m4a).kind, 'audio');
  assert.equal(sniffBytes(m4a).container, 'm4a');

  const avif = bytes(...box('ftyp', ascii('avif')), 0, 0, 0, 0);
  assert.equal(sniffBytes(avif).kind, 'image');

  const mov = bytes(...box('ftyp', ascii('qt  ')), 0, 0, 0, 0);
  assert.equal(sniffBytes(mov).container, 'mov');
});

test('fMP4 分片：styp / moof 都能识别', () => {
  const styp = bytes(...box('styp', new Uint8Array(8)));
  assert.equal(sniffBytes(styp).container, 'fmp4-segment');
  const moof = bytes(...box('moof', new Uint8Array(8)));
  assert.equal(sniffBytes(moof).kind, 'video');
});

test('MPEG-TS 靠 0x47 同步字节与 188 间隔判定', () => {
  const ts = new Uint8Array(189);
  ts[0] = 0x47;
  ts[188] = 0x47;
  assert.equal(sniffBytes(ts).container, 'ts');
});

test('EBML：webm 与 mkv 靠 DocType 区分', () => {
  const webm = ascii('webm', [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(sniffBytes(webm).container, 'webm');
  const mkv = ascii('matroska', [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(sniffBytes(mkv).container, 'mkv');
});

test('播放列表：m3u8 与 mpd', () => {
  const hls = ascii('#EXTM3U\n#EXT-X-VERSION:3\n');
  assert.equal(sniffBytes(hls).kind, 'playlist');
  assert.equal(sniffBytes(hls).container, 'm3u8');
  const dash = ascii('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">');
  assert.equal(sniffBytes(dash).container, 'mpd');
});

test('音频：ogg/flac/mp3/wav', () => {
  assert.equal(sniffBytes(ascii('OggS....OpusHead')).container, 'ogg');
  assert.equal(sniffBytes(ascii('OggS....OpusHead')).detail, 'opus');
  assert.equal(sniffBytes(ascii('fLaC')).container, 'flac');
  assert.equal(sniffBytes(ascii('ID3\u0004')).container, 'mp3');
  assert.equal(sniffBytes(bytes(0xff, 0xfb, 0x90, 0x00)).container, 'mp3');
  assert.equal(sniffBytes(ascii('RIFF....WAVE')).container, 'wav');
});

test('图片：jpg/png/gif/webp/svg', () => {
  assert.equal(sniffBytes(bytes(0xff, 0xd8, 0xff, 0xe0)).container, 'jpg');
  assert.equal(sniffBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).container, 'png');
  assert.equal(sniffBytes(ascii('GIF89a')).container, 'gif');
  assert.equal(sniffBytes(ascii('RIFF....WEBP')).container, 'webp');
  assert.equal(sniffBytes(ascii('<svg xmlns="http://www.w3.org/2000/svg">')).container, 'svg');
});

test('文档与归档', () => {
  assert.equal(sniffBytes(ascii('%PDF-1.7')).container, 'pdf');
  assert.equal(sniffBytes(bytes(0x50, 0x4b, 0x03, 0x04)).container, 'zip');
  assert.equal(sniffBytes(bytes(0x4d, 0x5a, 0x90, 0x00)).container, 'exe');
});

test('未知内容返回 null，不瞎猜', () => {
  assert.equal(sniffBytes(ascii('hello world')), null);
  assert.equal(sniffBytes(new Uint8Array(0)), null);
  assert.equal(sniffBytes(null), null);
});

test('isSniffedMedia 只认音视频', () => {
  assert.equal(isSniffedMedia({ kind: 'video' }), true);
  assert.equal(isSniffedMedia({ kind: 'audio' }), true);
  assert.equal(isSniffedMedia({ kind: 'image' }), false);
  assert.equal(isSniffedMedia(null), false);
});

test('sniffExtension 处理 fMP4 分片', () => {
  assert.equal(sniffExtension({ container: 'fmp4-segment' }), 'mp4');
  assert.equal(sniffExtension({ container: 'm3u8' }), 'm3u8');
  assert.equal(sniffExtension(null), '');
});
