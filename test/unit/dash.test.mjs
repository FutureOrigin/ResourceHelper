import test from 'node:test';
import assert from 'node:assert/strict';

import { fillTemplate, parseIsoDuration, parseMpd, parseXml, pickBestRepresentations } from '../../src/core/dash.js';

const MPD_TIMELINE = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- 由测试构造的 DASH manifest -->\n<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\" type=\"static\" mediaPresentationDuration=\"PT1M30.5S\" minBufferTime=\"PT2S\">\n  <BaseURL>https://cdn.example.com/vod/</BaseURL>\n  <Period id=\"1\">\n    <AdaptationSet contentType=\"video\" mimeType=\"video/mp4\" codecs=\"avc1.64001f\">\n      <BaseURL>video/</BaseURL>\n      <Representation id=\"v-720\" bandwidth=\"2000000\" width=\"1280\" height=\"720\">\n        <SegmentTemplate timescale=\"1000\" initialization=\"init-$RepresentationID$.mp4\" media=\"seg-$RepresentationID$-$Number$.m4s\">\n          <SegmentTimeline>\n            <S t=\"0\" d=\"4000\" r=\"2\" />\n            <S d=\"2000\" />\n          </SegmentTimeline>\n        </SegmentTemplate>\n      </Representation>\n      <Representation id=\"v-1080\" bandwidth=\"5000000\" width=\"1920\" height=\"1080\">\n        <SegmentTemplate timescale=\"1000\" initialization=\"init-$RepresentationID$.mp4\" media=\"seg-$RepresentationID$-$Number%05d$.m4s\">\n          <SegmentTimeline>\n            <S t=\"0\" d=\"6000\" r=\"1\" />\n          </SegmentTimeline>\n        </SegmentTemplate>\n      </Representation>\n    </AdaptationSet>\n    <AdaptationSet contentType=\"audio\" mimeType=\"audio/mp4\" lang=\"zh\" codecs=\"mp4a.40.2\">\n      <BaseURL>audio/</BaseURL>\n      <Representation id=\"a-128\" bandwidth=\"128000\">\n        <SegmentTemplate timescale=\"48000\" initialization=\"a-init.mp4\" media=\"a-$Number$.m4s\">\n          <SegmentTimeline>\n            <S t=\"0\" d=\"192000\" r=\"1\" />\n          </SegmentTimeline>\n        </SegmentTemplate>\n      </Representation>\n    </AdaptationSet>\n  </Period>\n</MPD>";

const MPD_DURATION = "<MPD type=\"static\" mediaPresentationDuration=\"PT10S\">\n  <Period>\n    <AdaptationSet contentType=\"video\" mimeType=\"video/mp4\">\n      <Representation id=\"1\" bandwidth=\"1000\" height=\"480\">\n        <SegmentTemplate timescale=\"1000\" duration=\"2000\" startNumber=\"1\" initialization=\"init.mp4\" media=\"chunk-$Number$.m4s\" />\n      </Representation>\n    </AdaptationSet>\n  </Period>\n</MPD>";

test('parseXml 处理属性、自闭合、注释与 CDATA', () => {
  const root = parseXml('<a x="1" y=\'2\'><b/><!-- c --><d><![CDATA[<raw>]]></d></a>');
  assert.equal(root.name, 'a');
  assert.equal(root.attrs.x, '1');
  assert.equal(root.attrs.y, '2');
  assert.equal(root.children[0].name, 'b');
  assert.equal(root.children[1].name, 'd');
  assert.equal(root.children[1].text, '<raw>');
});

test('parseIsoDuration 支持天/时/分/秒', () => {
  assert.equal(parseIsoDuration('PT1M30.5S'), 90.5);
  assert.equal(parseIsoDuration('PT2H'), 7200);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration(''), 0);
});

test('fillTemplate 支持 $Number$ 的补零格式与 $$ 转义', () => {
  assert.equal(fillTemplate('seg-$Number%05d$.m4s', { number: 7 }), 'seg-00007.m4s');
  assert.equal(fillTemplate('$RepresentationID$-$Bandwidth$', { representationId: 'v1', bandwidth: 9000 }), 'v1-9000');
  assert.equal(fillTemplate('cost-$$5', {}), 'cost-$5');
});

test('SegmentTimeline 展开：repeat 与 t/d 连续推进', () => {
  const parsed = parseMpd(MPD_TIMELINE, 'https://example.com/play.mpd');
  const v720 = parsed.video.find((item) => item.id === 'v-720');
  assert.equal(v720.segments.length, 4, 'r=2 表示额外重复 2 次，加末尾一段共 4 段');
  assert.equal(v720.segments[0].url, 'https://cdn.example.com/vod/video/seg-v-720-1.m4s');
  assert.equal(v720.segments[0].duration, 4);
  assert.equal(v720.segments[3].duration, 2);
  assert.equal(v720.initUrl, 'https://cdn.example.com/vod/video/init-v-720.mp4');
  assert.equal(v720.height, 720);

  const v1080 = parsed.video.find((item) => item.id === 'v-1080');
  assert.equal(v1080.segments[0].url, 'https://cdn.example.com/vod/video/seg-v-1080-00001.m4s');
});

test('音频轨：语言与 timescale 正确', () => {
  const parsed = parseMpd(MPD_TIMELINE, 'https://example.com/play.mpd');
  assert.equal(parsed.audio.length, 1);
  const audio = parsed.audio[0];
  assert.equal(audio.lang, 'zh');
  assert.equal(audio.segments.length, 2);
  assert.equal(audio.segments[0].duration, 4, '192000/48000 = 4 秒');
  assert.equal(audio.initUrl, 'https://cdn.example.com/vod/audio/a-init.mp4');
});

test('固定 duration 的模板按总时长推算分片数', () => {
  const parsed = parseMpd(MPD_DURATION, 'https://example.com/m.mpd');
  assert.equal(parsed.video.length, 1);
  assert.equal(parsed.video[0].segments.length, 5, '10s / 2s = 5 段');
  assert.equal(parsed.video[0].segments[4].url, 'https://example.com/chunk-5.m4s');
});

test('pickBestRepresentations 选最高分辨率与最高码率', () => {
  const parsed = parseMpd(MPD_TIMELINE, 'https://example.com/play.mpd');
  const best = pickBestRepresentations(parsed);
  assert.equal(best.video.id, 'v-1080');
  assert.equal(best.audio.id, 'a-128');
  assert.equal(pickBestRepresentations(parsed, { height: 720 }).video.id, 'v-720');
  assert.equal(best.videos.length, 2);
});

test('动态（直播）MPD 标记为 live', () => {
  const live = parseMpd('<MPD type="dynamic"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="1"><SegmentTemplate media="s-$Number$.m4s"><SegmentTimeline><S d="2000" r="3"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>', 'https://x.com/live.mpd');
  assert.equal(live.isLive, true);
  assert.equal(live.video.length, 1);
});

test('SegmentBase 走整文件下载，而不是被丢弃', () => {
  const parsed = parseMpd('<MPD><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="1" height="1080"><BaseURL>a.mp4</BaseURL><SegmentBase indexRange="0-100"><Initialization range="0-999"/></SegmentBase></Representation></AdaptationSet></Period></MPD>', 'https://x.com/dir/a.mpd');
  assert.equal(parsed.video.length, 1);
  const rep = parsed.video[0];
  assert.equal(rep.segmentBase, true);
  assert.equal(rep.fileUrl, 'https://x.com/dir/a.mp4', '相对 BaseURL 必须按 MPD 地址补全');
  assert.equal(rep.indexRange, '0-100');
  assert.equal(rep.initializationRange, '0-999');
  assert.equal(rep.segments.length, 0, 'SegmentBase 没有可枚举分片');
});

test('既没有分片也没有 SegmentBase 的 Representation 被丢弃', () => {
  const parsed = parseMpd('<MPD><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="1" height="720"></Representation></AdaptationSet></Period></MPD>', 'https://x.com/a.mpd');
  assert.equal(parsed.video.length, 0);
});

test('畸形输入不抛错', () => {
  assert.equal(parseXml('not xml at all'), null);
  const parsed = parseMpd('<<<>>>', 'https://x.com/a.mpd');
  assert.deepEqual(parsed.video, []);
  assert.equal(parsed.isLive, false);
});
