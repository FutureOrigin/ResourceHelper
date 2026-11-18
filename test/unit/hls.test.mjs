import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDrm,
  isMasterPlaylist,
  isMediaPlaylist,
  parseAttributes,
  parseByteRange,
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseResolution,
  pickAudioRendition,
  pickBestVariant,
  splitAttributes
} from '../../src/core/hls.js';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-hi",NAME="中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/zh.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-hi",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文",LANGUAGE="zh",URI="subs/zh.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640032,mp4a.40.2",AUDIO="aud-hi",SUBTITLES="subs",FRAME-RATE=30',
  'video/1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud-hi"',
  'video/720/index.m3u8',
  ''
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:42',
  '#EXT-X-MAP:URI="init.mp4",BYTERANGE="795@0"',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
  '#EXTINF:6.006,',
  '#EXT-X-BYTERANGE:1000@795',
  'seg1.m4s',
  '#EXTINF:6.006,',
  '#EXT-X-BYTERANGE:1200',
  'seg2.m4s',
  '#EXT-X-DISCONTINUITY',
  '#EXT-X-KEY:METHOD=NONE',
  '#EXTINF:4.0,',
  'seg3.ts',
  '#EXT-X-ENDLIST',
  ''
].join('\n');

test('属性串切分能处理引号里的逗号', () => {
  const parts = splitAttributes('BANDWIDTH=1,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1920x1080');
  assert.equal(parts.length, 3);
  assert.equal(parts[1], 'CODECS="avc1.4d401f,mp4a.40.2"');
});

test('parseAttributes 处理数字、布尔与引号', () => {
  const attrs = parseAttributes('DEFAULT=YES,BANDWIDTH=5000000,NAME="中文",RESOLUTION=1920x1080');
  assert.equal(attrs.DEFAULT, true);
  assert.equal(attrs.BANDWIDTH, 5000000);
  assert.equal(attrs.NAME, '中文');
  assert.equal(attrs.RESOLUTION, '1920x1080');
});

test('resolution 与 byterange 解析', () => {
  assert.deepEqual(parseResolution('1920x1080'), { width: 1920, height: 1080 });
  assert.equal(parseResolution('bad'), null);
  assert.deepEqual(parseByteRange('1000@795'), { length: 1000, offset: 795 });
  assert.deepEqual(parseByteRange('1200'), { length: 1200, offset: null });
  assert.equal(parseByteRange('x'), null);
});

test('master playlist：变体、音轨组、字幕都解析出来', () => {
  assert.equal(isMasterPlaylist(MASTER), true);
  const master = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(master.variants.length, 2);
  assert.equal(master.variants[0].uri, 'https://cdn.example.com/hls/video/1080/index.m3u8');
  assert.equal(master.variants[0].bandwidth, 5000000);
  assert.deepEqual(master.variants[0].resolution, { width: 1920, height: 1080 });
  assert.equal(master.variants[0].audioGroup, 'aud-hi');
  assert.equal(master.audioRenditions.length, 2);
  assert.equal(master.audioRenditions[0].isDefault, true);
  assert.equal(master.audioRenditions[0].language, 'zh');
  assert.equal(master.audioRenditions[1].isDefault, false);
  assert.equal(master.subtitles.length, 1);
});

test('pickBestVariant 按分辨率优先、其次码率', () => {
  const { variants } = parseMasterPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
  assert.equal(pickBestVariant(variants).resolution.height, 1080);
  assert.equal(pickBestVariant(variants, { height: 720 }).resolution.height, 720);
  assert.equal(pickBestVariant([]), null);
});

test('media playlist：分片、init、密钥、BYTERANGE 连续偏移', () => {
  assert.equal(isMediaPlaylist(MEDIA), true);
  const media = parseMediaPlaylist(MEDIA, 'https://cdn.example.com/hls/video/1080/index.m3u8');
  assert.equal(media.targetDuration, 6);
  assert.equal(media.mediaSequence, 42);
  assert.equal(media.endList, true);
  assert.ok(media.initSegment);
  assert.equal(media.initSegment.uri, 'https://cdn.example.com/hls/video/1080/init.mp4');
  assert.deepEqual(media.initSegment.byteRange, { length: 795, offset: 0 });

  assert.equal(media.segments.length, 3);
  assert.equal(media.segments[0].uri, 'https://cdn.example.com/hls/video/1080/seg1.m4s');
  assert.deepEqual(media.segments[0].byteRange, { length: 1000, offset: 795 });
  assert.equal(media.segments[0].key.method, 'AES-128');
  assert.equal(media.segments[0].key.uri, 'https://cdn.example.com/hls/video/1080/key.bin',
    '密钥地址按播放列表所在目录解析');

  // 只写长度时，偏移应接在上一个分片之后
  assert.deepEqual(media.segments[1].byteRange, { length: 1200, offset: 1795 });

  // #EXT-X-KEY:METHOD=NONE 之后的明文分片
  assert.equal(media.segments[2].key, null);
  assert.equal(media.segments[2].discontinuity, true);
  assert.equal(media.segments[2].uri, 'https://cdn.example.com/hls/video/1080/seg3.ts');

  // 序号从 MEDIA-SEQUENCE 起递增
  assert.deepEqual(media.segments.map((s) => s.sequence), [42, 43, 44]);
});

test('相对路径按播放列表地址解析', () => {
  const media = parseMediaPlaylist('#EXTM3U\n#EXTINF:1,\na.ts\n', 'https://x.com/a/b/list.m3u8');
  assert.equal(media.segments[0].uri, 'https://x.com/a/b/a.ts');
});

test('pickAudioRendition：按 AUDIO 组匹配，优先 DEFAULT', () => {
  const master = parseMasterPlaylist(MASTER, 'https://cdn.example.com/x/master.m3u8');
  const picked = pickAudioRendition(master, master.variants[0]);
  assert.ok(picked, '应当挑到音轨');
  assert.equal(picked.uri, 'https://cdn.example.com/x/audio/zh.m3u8', 'DEFAULT=YES 的中文音轨优先');
  assert.equal(picked.language, 'zh');

  const en = pickAudioRendition(master, master.variants[0], { language: 'en' });
  assert.equal(en.uri, 'https://cdn.example.com/x/audio/en.m3u8');
});

test('pickAudioRendition：没有 AUDIO 组或没有 URI 时返回 null', () => {
  const master = parseMasterPlaylist(MASTER, 'https://cdn.example.com/x/master.m3u8');
  assert.equal(pickAudioRendition(master, { audioGroup: '' }), null);
  assert.equal(pickAudioRendition(master, { audioGroup: 'missing' }), null);
  assert.equal(pickAudioRendition(null, master.variants[0]), null);
});

test('detectDrm 识别 SAMPLE-AES 与 Widevine 标记', () => {
  assert.equal(detectDrm('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"'), 'SAMPLE-AES');
  assert.equal(detectDrm('#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'), 'WIDEVINE');
  assert.equal(detectDrm('#EXT-X-KEY:METHOD=AES-128,URI="k"'), null);
});

test('空输入与畸形输入不抛错', () => {
  assert.deepEqual(parseMasterPlaylist('', ''), { variants: [], audioRenditions: [], subtitles: [] });
  const media = parseMediaPlaylist('#EXTM3U\n#,,\n', 'https://x.com/a.m3u8');
  assert.deepEqual(media.segments, []);
});
