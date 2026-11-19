/**
 * 整页快照：纯逻辑单测
 *
 * 这些函数决定"文件打开后是不是坏的"：
 * 占位符替换漏一个 → 页面里留下一串 rhres://；
 * srcset/CSS 地址解析错 → 断图；
 * 转义少一层 → 文档被提前截断。
 * 所以这里逐条锁住行为，而不是只测"跑通"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_SCHEME,
  FRAME_SCHEME,
  applyCssReferences,
  archiveFilename,
  buildArchiveDocument,
  classifyResource,
  createToken,
  cssImportRef,
  cssUrlRef,
  describeSkipReason,
  escapeCssString,
  escapeHtmlAttr,
  escapeStyleText,
  framePlaceholderFor,
  isFetchableUrl,
  normalizeArchiveOptions,
  normalizeResourceUrl,
  parsePlaceholder,
  placeholderFor,
  replacePlaceholders,
  resourceExtension,
  scanCssReferences
} from '../../src/core/page-archive.js';

test('占位符：生成 / 解析 / 拒绝别的 token', () => {
  assert.equal(ARCHIVE_SCHEME, 'rhres');
  assert.equal(FRAME_SCHEME, 'rhframe');
  assert.equal(placeholderFor('abc', 3), 'rhres://abc/3');
  assert.equal(framePlaceholderFor('abc', 0), 'rhframe://abc/0');

  assert.equal(parsePlaceholder('rhres://abc/3', 'abc'), 3);
  assert.equal(parsePlaceholder('rhres://abc/3', 'zzz'), null, 'token 不同必须不认');
  assert.equal(parsePlaceholder('rhres://abc/x', 'abc'), null);
  assert.equal(parsePlaceholder('', 'abc'), null);
});

test('占位符：一次替换，替换进去的内容不会被二次展开', () => {
  const html = '<img src="rhres://t/0"><img src="rhres://t/1">';
  const out = replacePlaceholders(html, 't', (index) => (index === 0 ? 'rhres://t/1' : 'B'));
  assert.equal(out, '<img src="rhres://t/1"><img src="B">', '替换值里的占位符必须保持原样');
});

test('占位符：解析器返回 null 时保持原样，抛错也不炸整份文档', () => {
  const html = 'a rhres://t/0 b rhres://t/1 c';
  assert.equal(replacePlaceholders(html, 't', () => null), html);
  assert.equal(replacePlaceholders(html, 't', (index) => {
    if (index === 1) throw new Error('boom');
    return 'X';
  }), 'a X b rhres://t/1 c');
});

test('地址规整：相对地址按 base 解析，片段被丢掉', () => {
  const page = 'https://e.com/dir/page.html';
  assert.equal(normalizeResourceUrl('a.png', page).url, 'https://e.com/dir/a.png');
  assert.equal(normalizeResourceUrl('/a.png', page).url, 'https://e.com/a.png');
  assert.equal(normalizeResourceUrl('//cdn.e.com/a.png', page).url, 'https://cdn.e.com/a.png');
  assert.equal(normalizeResourceUrl('https://x/y.png#frag', page).url, 'https://x/y.png');
});

test('地址规整：不可抓的一律给出原因，而不是静默变成空串', () => {
  const page = 'https://e.com/';
  assert.equal(normalizeResourceUrl('', page).reason, 'EMPTY');
  assert.equal(normalizeResourceUrl('#top', page).reason, 'FRAGMENT');
  assert.equal(normalizeResourceUrl('data:image/png;base64,AA', page).reason, 'SCHEME');
  assert.equal(normalizeResourceUrl('blob:https://e.com/1', page).reason, 'SCHEME');
  assert.equal(normalizeResourceUrl('javascript:alert(1)', page).reason, 'SCHEME');
  assert.equal(normalizeResourceUrl('mailto:a@b.c', page).reason, 'SCHEME');
  assert.equal(normalizeResourceUrl('ftp://e.com/a', page).reason, 'SCHEME');
});

test('可抓判定与同源无关，只认 http(s)', () => {
  assert.equal(isFetchableUrl('https://e.com/a'), true);
  assert.equal(isFetchableUrl('http://e.com/a'), true);
  assert.equal(isFetchableUrl('data:text/plain,x'), false);
  assert.equal(isFetchableUrl(''), false);
});

test('CSS：读取 url() 的三种写法与转义', () => {
  const css = [
    '.a{background:url(plain.png)}',
    '.b{background:url("quoted.png")}',
    ".c{background:url( 'spaced.png' )}",
    '.d{background:url(es\\ cape.png)}',
    '.e{background:url()}'
  ].join('\n');
  const values = scanCssReferences(css).map((ref) => ref.value);
  assert.deepEqual(values, ['plain.png', 'quoted.png', 'spaced.png', 'es cape.png']);
  assert.equal(scanCssReferences(css).length, 4, '空 url() 不应产生引用');
});

test('CSS：@import 的整段区间与媒体条件，且不会与内部的 url() 重复', () => {
  const css = '@import url("theme.css") screen and (min-width: 600px);\n.a{background:url(a.png)}';
  const refs = scanCssReferences(css);
  assert.equal(refs.length, 2);

  const importRef = refs[0];
  assert.equal(importRef.kind, 'import');
  assert.equal(importRef.value, 'theme.css');
  assert.equal(importRef.media, 'screen and (min-width: 600px)');
  assert.equal(css.slice(importRef.start, importRef.end), '@import url("theme.css") screen and (min-width: 600px);');

  assert.equal(refs[1].kind, 'url');
  assert.equal(refs[1].value, 'a.png');
});

test('CSS：@import 字符串写法与无媒体条件', () => {
  const refs = scanCssReferences('@import "a.css";');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'import');
  assert.equal(refs[0].value, 'a.css');
  assert.equal(refs[0].media, '');
});

test('CSS：重写只动被解析的片段，其余原样保留', () => {
  const css = '.a{background:url(a.png)}\n.b{color:red}\n.c{background:url(#grad)}';
  const refs = scanCssReferences(css);
  const out = applyCssReferences(css, refs, (ref) => (ref.value === 'a.png' ? 'url("data:image/png;base64,AA")' : null));
  assert.equal(out.css, '.a{background:url("data:image/png;base64,AA")}\n.b{color:red}\n.c{background:url(#grad)}');
  assert.equal(out.replaced, 1);
});

test('CSS：生成的 url()/@import 语法正确', () => {
  assert.equal(cssUrlRef('data:image/png;base64,AA'), 'url("data:image/png;base64,AA")');
  assert.equal(cssUrlRef('https://e.com/a b.png'), 'url("https://e.com/a b.png")');
  assert.equal(cssImportRef('https://e.com/a.css', ''), '@import url("https://e.com/a.css");');
  assert.equal(cssImportRef('https://e.com/a.css', 'print'), '@import url("https://e.com/a.css") print;');
});

test('CSS 字符串转义：引号、换行、反斜杠', () => {
  assert.equal(escapeCssString('a"b'), 'a\\"b');
  assert.equal(escapeCssString('a\nb'), 'ab');
  assert.equal(escapeCssString('a\\b'), 'a\\\\b');
});

test('转义：属性值与 <style> 文本各用各的规则', () => {
  assert.equal(escapeHtmlAttr('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
  assert.equal(escapeHtmlAttr("单引号不动"), "单引号不动");
  assert.equal(escapeStyleText('.a{content:"</style>"}'), '.a{content:"<\\/style>"}');
  assert.equal(escapeStyleText('</STYLE >'), '<\\/STYLE >');
});

test('文档装配：doctype + 来源注释 + 正文', () => {
  const doc = buildArchiveDocument({
    html: '<html><body>hi</body></html>',
    sourceUrl: 'https://e.com/a?b=1',
    createdAt: '2026-11-18T00:00:00.000Z',
    generator: 'ResourceHelper'
  });
  assert.ok(doc.startsWith('<!DOCTYPE html>\n'));
  assert.ok(doc.includes('saved by ResourceHelper'));
  assert.ok(doc.includes('source https://e.com/a?b=1'));
  assert.ok(doc.includes('<html><body>hi</body></html>'));
  assert.ok(doc.endsWith('</html>\n'));
});

test('文档装配：注释里的 -- 不能破坏 HTML 注释', () => {
  const doc = buildArchiveDocument({ html: '<html></html>', sourceUrl: 'https://e.com/--x', createdAt: '2026--11' });
  const firstLine = doc.split('\n')[1];
  assert.ok(!firstLine.slice(4, -3).includes('--'), '注释体内不应出现 --');
});

test('文件名：模板 / 缺省 / 强制 .html / 非法字符', () => {
  assert.equal(archiveFilename({ title: '示例 页面', template: '{title} [{quality}].{ext}' }), '示例 页面.html');
  assert.equal(archiveFilename({ title: '示例 页面' }), '示例 页面.html');
  assert.equal(archiveFilename({}), '网页快照.html');
  assert.equal(archiveFilename({ title: 'a/b:c*?' }), 'a_b_c__.html');
  assert.equal(archiveFilename({ title: '标题', template: '{title}-{site}' , site: 'e.com'}), '标题-e.com.html');
  assert.ok(!archiveFilename({ title: '标题', template: '{title}.{ext}' }).endsWith('.html.html'));
});

test('统计归类与跳过原因文案', () => {
  assert.equal(classifyResource('https://e.com/a.woff2'), 'font');
  assert.equal(classifyResource('https://e.com/a.PNG'), 'image');
  assert.equal(classifyResource('https://e.com/a.css'), 'style');
  assert.equal(classifyResource('https://e.com/a'), 'other');
  assert.equal(resourceExtension('https://e.com/a/b.webp?x=1'), 'webp');
  assert.equal(resourceExtension('not a url'), '');

  for (const code of ['SCHEME', 'TOO_LARGE', 'BUDGET', 'FETCH_FAILED']) {
    assert.notEqual(describeSkipReason(code), '已跳过', code + ' 应有专门说明');
  }
  assert.equal(describeSkipReason('WHATEVER'), '已跳过');
});

test('选项规整：默认值、布尔值、预算单位换算前置校验', () => {
  const defaults = normalizeArchiveOptions(null);
  assert.deepEqual(defaults, {
    inlineImages: true,
    removeScripts: true,
    embedFrames: true,
    onlySelection: false,
    limits: defaults.limits
  });
  assert.ok(defaults.limits.maxTotalBytes > defaults.limits.maxResourceBytes);

  const custom = normalizeArchiveOptions({
    inlineImages: false,
    removeScripts: 'yes',
    onlySelection: true,
    limits: { maxTotalBytes: 12345 }
  });
  assert.equal(custom.inlineImages, false);
  assert.equal(custom.removeScripts, true, '类型不对回退默认值');
  assert.equal(custom.onlySelection, true);
  assert.equal(custom.limits.maxTotalBytes, 12345);
});

test('预算里不再有 DOM 节点上限：大页面不该被直接拒绝', () => {
  const defaults = normalizeArchiveOptions(null);
  assert.equal('maxNodes' in defaults.limits, false, '节点数不是资源预算，不该出现在这里');

  // 旧调用方即使还在传，也只会被当作未知字段丢掉，不会重新变成一道上限
  const custom = normalizeArchiveOptions({ limits: { maxNodes: 10 } });
  assert.equal('maxNodes' in custom.limits, false);
  assert.ok(custom.limits.maxFrames > 0, '其它预算项不受影响');
});

test('token：随机源固定时长度稳定且只含安全字符', () => {
  assert.equal(createToken(() => 0), '0000000000');
  assert.equal(createToken(() => 0.5).length, 10);
  assert.match(createToken(), /^[a-z0-9]{10}$/);
});
