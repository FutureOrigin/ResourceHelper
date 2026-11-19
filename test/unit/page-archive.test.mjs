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
  codePointsOf,
  collectFontFamilies,
  collectFrameFontFamilies,
  collectHtmlFontFamilies,
  createToken,
  cssImportRef,
  cssUrlRef,
  describeSkipReason,
  ensureUtf8Charset,
  escapeCssString,
  escapeHtmlAttr,
  escapeStyleText,
  framePlaceholderFor,
  isFetchableUrl,
  normalizeArchiveOptions,
  normalizeFontFamily,
  normalizeResourceUrl,
  normalizeSelectorVocabulary,
  parsePlaceholder,
  placeholderFor,
  pruneFontFaceSources,
  pruneUnusedCss,
  pruneUnusedFontFaces,
  pruneUnusedUnicodeRanges,
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
  // 没有 <head> 时就近插在 <html> 后面，正文不受影响
  assert.ok(doc.includes('<html><meta charset="utf-8"><body>hi</body></html>'));
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
    removeHidden: true,
    removeUnusedCss: true,
    limits: defaults.limits
  });
  assert.ok(defaults.limits.maxTotalBytes > defaults.limits.maxResourceBytes);

  const custom = normalizeArchiveOptions({
    inlineImages: false,
    removeScripts: 'yes',
    onlySelection: true,
    removeHidden: false,
    removeUnusedCss: false,
    limits: { maxTotalBytes: 12345 }
  });
  assert.equal(custom.inlineImages, false);
  assert.equal(custom.removeScripts, true, '类型不对回退默认值');
  assert.equal(custom.onlySelection, true);
  assert.equal(custom.removeHidden, false);
  assert.equal(custom.removeUnusedCss, false);
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

/* ------------------------------------------------------------------ *
 * CSS 精简
 * ------------------------------------------------------------------ */

const VOCAB = normalizeSelectorVocabulary({
  tags: ['html', 'body', 'div', 'a', 'span'],
  classes: ['used', 'b', 'sm:flex', 'x:y'],
  ids: ['main'],
  attrs: ['data-x', 'class', 'href']
});

test('选择器词表：缺字段/空词表返回 null（宁可不精简，也不能删光样式）', () => {
  assert.equal(normalizeSelectorVocabulary(null), null);
  assert.equal(normalizeSelectorVocabulary({}), null);
  assert.equal(normalizeSelectorVocabulary({ tags: [] }), null);
  const vocab = normalizeSelectorVocabulary({ tags: ['div'], classes: ['a', 3, ''] });
  assert.ok(vocab.tags.has('div'));
  assert.equal(vocab.classes.size, 1, '非字符串项被丢掉');
});

test('CSS 精简：删掉文档里根本不存在的类 / id / 标签 / 属性规则', () => {
  assert.equal(pruneUnusedCss('.used{color:red}.unused{color:blue}', VOCAB).css, '.used{color:red}');
  assert.equal(pruneUnusedCss('#main{x:1}#gone{x:2}', VOCAB).css, '#main{x:1}');
  assert.equal(pruneUnusedCss('div{x:1}table{x:2}', VOCAB).css, 'div{x:1}');
  assert.equal(pruneUnusedCss('[data-x]{x:1}[data-y]{x:2}', VOCAB).css, '[data-x]{x:1}');
  assert.equal(pruneUnusedCss('.b.also-gone{x:1}', VOCAB).css, '', '复合选择器缺一个类就匹配不到');
  assert.equal(pruneUnusedCss('.b.used{x:1}', VOCAB).css, '.b.used{x:1}');
  assert.equal(pruneUnusedCss('.b .used{x:1}', VOCAB).css, '.b .used{x:1}', '后代组合要求每一段都能对上');
  assert.equal(pruneUnusedCss('.b .gone{x:1}', VOCAB).css, '');
});

test('CSS 精简：选择器列表里只要有一条可能匹配就保留整条规则', () => {
  assert.equal(pruneUnusedCss('.gone, .b{x:1}', VOCAB).css, '.gone, .b{x:1}');
  assert.equal(pruneUnusedCss('.gone, .also-gone{x:1}', VOCAB).css, '');
});

test('CSS 精简：判断不了的写法一律保留（伪类参数 / 命名空间 / 嵌套）', () => {
  assert.equal(pruneUnusedCss(':is(.gone,.b){x:1}', VOCAB).css, ':is(.gone,.b){x:1}');
  assert.equal(pruneUnusedCss('.gone:not(.b){x:1}', VOCAB).css, '.gone:not(.b){x:1}');
  assert.equal(pruneUnusedCss('.gone:nth-child(2n){x:1}', VOCAB).css, '.gone:nth-child(2n){x:1}');
  assert.equal(pruneUnusedCss('svg|rect{x:1}', VOCAB).css, 'svg|rect{x:1}');
  assert.equal(pruneUnusedCss('& .gone{x:1}', VOCAB).css, '& .gone{x:1}');
  assert.equal(pruneUnusedCss(':root{--x:1}', VOCAB).css, ':root{--x:1}');
  assert.equal(pruneUnusedCss('*{box-sizing:border-box}', VOCAB).css, '*{box-sizing:border-box}');
});

test('CSS 精简：@media 递归精简，@font-face/@keyframes/@page 原样保留', () => {
  assert.equal(pruneUnusedCss('@media screen{.unused{x:1}}', VOCAB).css, '@media screen{}');
  assert.equal(pruneUnusedCss('@media screen{.used{x:1}}', VOCAB).css, '@media screen{.used{x:1}}');
  assert.equal(pruneUnusedCss('@supports (display:grid){.unused{x:1}}', VOCAB).css, '@supports (display:grid){}');

  const fontFace = '@font-face{font-family:Foo;src:url(foo.woff2)}';
  assert.equal(pruneUnusedCss(fontFace, VOCAB).css, fontFace);
  const keyframes = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
  assert.equal(pruneUnusedCss(keyframes, VOCAB).css, keyframes);
  assert.equal(pruneUnusedCss('@page{margin:1cm}', VOCAB).css, '@page{margin:1cm}');
  assert.equal(pruneUnusedCss('@import url(a.css);', VOCAB).css, '@import url(a.css);');
  assert.equal(pruneUnusedCss('@layer a, b;', VOCAB).css, '@layer a, b;');
  assert.equal(pruneUnusedCss('@layer base{.unused{x:1}}', VOCAB).css, '@layer base{}');
});

test('CSS 精简：去掉注释，字符串里的括号/注释符不影响解析', () => {
  assert.equal(pruneUnusedCss('/* 头部 */\n.used{x:1}\n/* 尾部 */', VOCAB).css, '\n.used{x:1}\n');
  assert.equal(pruneUnusedCss('.used{content:"}"}.unused{x:1}', VOCAB).css, '.used{content:"}"}');
  assert.equal(pruneUnusedCss('.used{content:"/*"}', VOCAB).css, '.used{content:"/*"}');
  const result = pruneUnusedCss('/* 大段注释 */ .used{x:1}', VOCAB);
  assert.equal(result.removedRules, 0);
  assert.ok(result.removedBytes > 0, '注释也算省下的字节');
});

test('CSS 精简：转义标识符能对上真实类名（Tailwind 的 sm\\:flex）', () => {
  assert.equal(pruneUnusedCss('.sm\\:flex{display:flex}', VOCAB).css, '.sm\\:flex{display:flex}');
  assert.equal(pruneUnusedCss('.sm\\:hidden{display:none}', VOCAB).css, '');
  assert.equal(pruneUnusedCss('.x\\3a y{x:1}', VOCAB).css, '.x\\3a y{x:1}', '十六进制转义解出 x:y');
  assert.equal(pruneUnusedCss('.x\\3a z{x:1}', VOCAB).css, '');
});

test('CSS 精简：超深嵌套不会把栈打爆（超过上限就原样保留）', () => {
  let css = '.unused{x:1}';
  for (let i = 0; i < 60; i++) css = '@media screen{' + css + '}';
  const result = pruneUnusedCss(css, VOCAB);
  assert.equal(result.css, css, '超过嵌套上限的部分必须原样保留');
  assert.equal(result.removedRules, 0);
});

test('CSS 精简：结构损坏时原样保留剩下的内容，绝不丢', () => {
  const broken = '.used{x:1}.broken{color:red';
  assert.equal(pruneUnusedCss(broken, VOCAB).css, broken);
  assert.equal(pruneUnusedCss('', VOCAB).css, '');
  assert.equal(pruneUnusedCss('.unused{x:1}', null).css, '.unused{x:1}', '没有词表就不精简');
});

/* ------------------------------------------------------------------ *
 * 字体精简
 * ------------------------------------------------------------------ */

test('字体族名归一化：去引号、折叠空白、大小写不敏感', () => {
  assert.equal(normalizeFontFamily(' "Open   Sans" '), 'open sans');
  assert.equal(normalizeFontFamily("'Inter'"), 'inter');
  assert.equal(normalizeFontFamily('Arial'), 'arial');
  assert.equal(normalizeFontFamily(''), '');
});

test('字体精简：@font-face 只留第一个 url()，备用格式不再抓', () => {
  const one = '@font-face{font-family:Foo;src:url(a.woff2) format("woff2"), url(a.woff) format("woff")}';
  const result = pruneFontFaceSources(one);
  assert.equal(result.css, '@font-face{font-family:Foo;src: url(a.woff2) format("woff2")}');
  assert.equal(result.removed, 1);
  assert.ok(result.removedBytes > 0, '省下的字节要能统计');

  // local() 不占字节，留着（本机已有就先用）
  const withLocal = '@font-face{font-family:Foo;src:local("Foo"), url(a.woff2) format("woff2"), url(a.woff)}';
  assert.equal(
    pruneFontFaceSources(withLocal).css,
    '@font-face{font-family:Foo;src: local("Foo"), url(a.woff2) format("woff2")}'
  );

  // 只有一个地址：不动
  const single = '@font-face{font-family:Foo;src:url(a.woff2) format("woff2")}';
  assert.equal(pruneFontFaceSources(single).css, single);
  assert.equal(pruneFontFaceSources(single).removed, 0);

  // 只有 local()：不动
  const localOnly = '@font-face{font-family:Foo;src:local("Foo")}';
  assert.equal(pruneFontFaceSources(localOnly).css, localOnly);

  // data: URI 里的分号不能把 src 提前截断
  const inline = '@font-face{font-family:Foo;src:url(data:font/woff2;base64,AAAA) format("woff2"), url(b.woff)}';
  assert.equal(
    pruneFontFaceSources(inline).css,
    '@font-face{font-family:Foo;src: url(data:font/woff2;base64,AAAA) format("woff2")}'
  );

  // 多个 @font-face 各自处理
  const two = '@font-face{font-family:A;src:url(a1),url(a2)}@font-face{font-family:B;src:url(b1),url(b2)}';
  const prunedTwo = pruneFontFaceSources(two);
  assert.equal(prunedTwo.removed, 2);
  assert.equal(prunedTwo.css, '@font-face{font-family:A;src: url(a1)}@font-face{font-family:B;src: url(b1)}');
});

test('字体收集：font-family 列表、font 简写、引号字符串都算点名', () => {
  const listed = collectFontFamilies('body{font-family:"Open Sans", Arial, sans-serif}');
  assert.deepEqual([...listed.families].sort(), ['arial', 'open sans']);
  assert.equal(listed.unknown, false);

  const shorthand = collectFontFamilies('strong{font:italic bold 14px/1.5 "Foo Bar", serif}');
  assert.deepEqual([...shorthand.families], ['foo bar']);

  const custom = collectFontFamilies(':root{--font-sans:"Custom Sans"}');
  assert.deepEqual([...custom.families], ['custom sans'], '自定义属性里的引号串也要认');

  const generic = collectFontFamilies('p{font-family:system-ui, -apple-system, monospace}');
  assert.deepEqual([...generic.families], ['-apple-system'], '通用族名不是具体字体');
});

test('字体收集：@font-face 自己声明的那一行不算点名', () => {
  const result = collectFontFamilies('@font-face{font-family:"Orphan";src:url(x.woff2)}');
  assert.deepEqual([...result.families], []);
});

test('字体收集：var() 或解析不了的 font 简写标记为不确定', () => {
  assert.equal(collectFontFamilies('body{font-family:var(--font)}').unknown, true);
  assert.equal(collectFontFamilies('body{font:menu}').unknown, true);
  assert.equal(collectFontFamilies('body{font-family:"Foo"}').unknown, false);
});

test('字体收集：!important 与注释不算族名的一部分', () => {
  const important = collectFontFamilies('body{font-family:"Foo" !important}');
  assert.deepEqual([...important.families], ['foo'], '!important 不能被当成族名后缀');

  const shorthand = collectFontFamilies('body{font:bold 12px/1.5 "Bar" !important}');
  assert.deepEqual([...shorthand.families], ['bar']);

  const commented = collectFontFamilies('body{font-family:/* 旧值 */ "Baz"}');
  assert.deepEqual([...commented.families], ['baz']);
});

test('字体精简：@font-face 里被注释掉的旧族名不能顶掉真的那个', () => {
  const css = '@font-face{/* font-family:"Old"; */ font-family:"Used"; src:url(x.woff2)}';
  assert.equal(pruneUnusedFontFaces(css, new Set(['used'])).removed, 0, '真族名被点名，必须保留');
  assert.equal(pruneUnusedFontFaces(css, new Set(['old'])).removed, 1, '按注释里的旧名字判断就会删错');
});

test('字体精简：没人点名的 @font-face 整块删掉，点名了就保留', () => {
  const css = '@font-face{font-family:"Used";src:url(a.woff2)}@font-face{font-family:"Orphan";src:url(b.woff2)}';
  const used = new Set(['used']);
  const result = pruneUnusedFontFaces(css, used);
  assert.equal(result.css, '@font-face{font-family:"Used";src:url(a.woff2)}');
  assert.equal(result.removed, 1);

  // 没有 font-family 的块、空集合：都不动
  const nameless = '@font-face{src:url(x.woff2)}';
  assert.equal(pruneUnusedFontFaces(nameless, used).removed, 0);
  assert.equal(pruneUnusedFontFaces(css, new Set()).removed, 0);
  assert.equal(pruneUnusedFontFaces(css, null).removed, 0);
});

test('字体收集：HTML 表现属性与 <font face> 也算点名（含实体解码）', () => {
  const html = '<svg><text font-family="Icon Font, serif">x</text></svg>'
    + '<font face="Legacy Font">y</font>'
    + '<text font-family="&quot;Quoted Font&quot;">z</text>';
  const families = collectHtmlFontFamilies(html);
  assert.deepEqual([...families].sort(), ['icon font', 'legacy font', 'quoted font']);
});

test('字体精简：@media 里的 @font-face 与 unicode-range 也按同一规则处理', () => {
  const css = '@media screen{@font-face{font-family:"A";src:url(a.woff2) format("woff2"), url(a.woff) format("woff");'
    + 'unicode-range:U+0000-00FF}}';
  const pruned = pruneFontFaceSources(css);
  assert.equal(pruned.removed, 1);
  assert.ok(pruned.css.includes('unicode-range:U+0000-00FF'), '其它描述符不能动');

  const unused = pruneUnusedFontFaces(pruned.css, new Set(['b']));
  assert.equal(unused.removed, 1);
  assert.equal(unused.css, '@media screen{}');

  // 族名对得上就整块留下
  assert.equal(pruneUnusedFontFaces(pruned.css, new Set(['a'])).removed, 0);
});

test('一帧的字体使用：合并所有样式文本与 HTML，遇到 @import 就放弃判断', () => {
  const merged = collectFrameFontFamilies(
    ['body{font-family:"Foo"}', '.icon{font-family:"Icon"}'],
    '<svg><text font-family="Bar">x</text></svg>'
  );
  assert.deepEqual([...merged.families].sort(), ['bar', 'foo', 'icon']);
  assert.equal(merged.unknown, false);

  const imported = collectFrameFontFamilies(['@import url(theme.css);body{font-family:"Foo"}'], '');
  assert.equal(imported.unknown, true, '导入的样式表可能点名别的字体，宁可不动');
});

test('一帧的字体使用：没有 url() 的内联 style 也要算点名', () => {
  const merged = collectFrameFontFamilies([], '<div style="font-family:&quot;Inline Font&quot;, serif">x</div>');
  assert.deepEqual([...merged.families], ['inline font']);

  const withVar = collectFrameFontFamilies([], '<div style="font-family:var(--f)">x</div>');
  assert.equal(withVar.unknown, true);
});

test('一帧的字体使用：没有被登记成 CSS 资源的 <style> 块也要算点名', () => {
  // 采集端只登记含 url()/@import 的样式块，纯文字的 <style> 会原样留在 HTML 里
  const merged = collectFrameFontFamilies([], '<style>body{font-family:"Inline Block Font"}</style>');
  assert.deepEqual([...merged.families], ['inline block font']);

  const withVar = collectFrameFontFamilies([], '<style>body{font-family:var(--f)}</style>');
  assert.equal(withVar.unknown, true, '样式块里的 var() 同样要触发保守放弃');
});

/* ------------------------------------------------------------------ *
 * 字符集与 unicode-range 子集精简
 * ------------------------------------------------------------------ */

test('字符集：去重、升序、支持星平面字符', () => {
  assert.deepEqual(codePointsOf(['bb', 'a', '中', '😀']), [0x61, 0x62, 0x4e2d, 0x1f600]);
  assert.equal(codePointsOf([]), null, '没有输入就没有依据');
  assert.equal(codePointsOf(null), null);
});

test('字体子集精简：unicode-range 与文档字符没有交集就删掉', () => {
  const css = '@font-face{font-family:"F";src:url(cyr.woff2);unicode-range:U+0400-04FF}'
    + '@font-face{font-family:"F";src:url(cjk.woff2);unicode-range:U+4E00-9FFF}';
  const pruned = pruneUnusedUnicodeRanges(css, codePointsOf(['中文']));
  assert.equal(pruned.removed, 1);
  assert.ok(pruned.css.includes('cjk.woff2'), '用得到的子集必须留下');
  assert.ok(!pruned.css.includes('cyr.woff2'), '用不到的子集应整块删掉');
  assert.ok(pruned.removedBytes > 0);
});

test('字体子集精简：没有 unicode-range、解析不了、全量范围都不动', () => {
  const noRange = '@font-face{font-family:"F";src:url(a)}';
  const broken = '@font-face{font-family:"F";src:url(b);unicode-range:U+zz}';
  const full = '@font-face{font-family:"F";src:url(c);unicode-range:U+0-10FFFF}';
  const points = codePointsOf(['x']);
  assert.equal(pruneUnusedUnicodeRanges(noRange, points).removed, 0);
  assert.equal(pruneUnusedUnicodeRanges(broken, points).removed, 0);
  assert.equal(pruneUnusedUnicodeRanges(full, points).removed, 0);
  assert.equal(pruneUnusedUnicodeRanges(noRange, null).removed, 0, '没有字符集就不删');
  assert.equal(pruneUnusedUnicodeRanges(noRange, []).removed, 0);
});

test('字体子集精简：U+4?? 通配与多段 range 都按字符集判断', () => {
  const wildcard = '@font-face{font-family:"F";src:url(a);unicode-range:U+4??}';
  assert.equal(pruneUnusedUnicodeRanges(wildcard, codePointsOf(['中'])).removed, 1, 'U+4?? 是 0400-04FF，不含中文');
  assert.equal(pruneUnusedUnicodeRanges(wildcard, codePointsOf(['Ё'])).removed, 0, 'U+0401 落在 0400-04FF');

  const multi = '@font-face{font-family:"F";src:url(b);unicode-range:U+0100-024F, U+0370-03FF}';
  assert.equal(pruneUnusedUnicodeRanges(multi, codePointsOf(['Ł'])).removed, 0, 'U+0141 命中第一段');
  assert.equal(pruneUnusedUnicodeRanges(multi, codePointsOf(['中'])).removed, 1, '两段都没有中文');
});

/* ------------------------------------------------------------------ *
 * 编码声明
 * ------------------------------------------------------------------ */

test('字符集：原页面没有 <meta charset> 时补在 <head> 里（否则本地打开是乱码）', () => {
  assert.equal(
    ensureUtf8Charset('<html><head><title>t</title></head><body>x</body></html>'),
    '<html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>'
  );
  // 原页面声明别的编码：文件字节是 UTF-8，必须改写
  assert.equal(
    ensureUtf8Charset('<html><head><meta charset="gbk"></head></html>'),
    '<html><head><meta charset="utf-8"></head></html>'
  );
  assert.equal(
    ensureUtf8Charset('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head></html>'),
    '<html><head><meta charset="utf-8"></head></html>'
  );
  // 没有 head：插到 <html> 后面；连 <html> 都没有：放最前面
  assert.equal(ensureUtf8Charset('<html lang="zh">x</html>'), '<html lang="zh"><meta charset="utf-8">x</html>');
  assert.equal(ensureUtf8Charset('<p>x</p>'), '<meta charset="utf-8"><p>x</p>');
  assert.equal(ensureUtf8Charset(''), '<meta charset="utf-8">');
  // 已经是 utf-8：幂等
  const once = ensureUtf8Charset('<html><head></head></html>');
  assert.equal(ensureUtf8Charset(once), once);
});

test('最终文件：字符集声明落在前 1024 字节内，且文档开头仍是 doctype', () => {
  const doc = buildArchiveDocument({
    html: '<html lang="zh-CN"><head><title>标题</title></head><body>中文</body></html>',
    sourceUrl: 'https://e.com/x',
    createdAt: '2026-11-19T00:00:00.000Z'
  });
  assert.ok(doc.startsWith('<!DOCTYPE html>'), doc.slice(0, 40));
  const at = doc.toLowerCase().indexOf('<meta charset="utf-8">');
  assert.ok(at > 0 && at < 1024, '偏移必须在前 1024 字节内，实际 ' + at);
});

test('token：随机源固定时长度稳定且只含安全字符', () => {
  assert.equal(createToken(() => 0), '0000000000');
  assert.equal(createToken(() => 0.5).length, 10);
  assert.match(createToken(), /^[a-z0-9]{10}$/);
});
