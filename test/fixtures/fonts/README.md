# 字体样本（测试用）

`private-use-subset.otf`：把思源黑体（SourceHanSansSC-Normal 2.002）裁出
「雨夜雷声风灯影火」8 个字、去掉 hinting 与子程序（与线上「字体反爬」站点的做法一致），
再把码位改成私用区 U+E000–U+E007 得到的小字体。它用来验证
「字形轮廓 → 指纹 → 真字」这条链路。

重新生成（需要 fontTools，仅一次性工具，不在构建链路里）：

~~~bash
python - <<'PY'
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

CHARS = "雨夜雷声风灯影火"
font = TTFont("SourceHanSansSC-Normal.otf")
options = Options()
options.desubroutinize = True
options.hinting = False
subsetter = Subsetter(options=options)
subsetter.populate(unicodes=[ord(c) for c in CHARS])
subsetter.subset(font)
names = [font.getBestCmap()[ord(c)] for c in CHARS]
remapped = {0xE000 + i: name for i, name in enumerate(names)}
for table in font["cmap"].tables:
    if table.format in (4, 12):
        table.cmap = dict(remapped)
font.save("private-use-subset.otf")
PY
~~~

参考字体是 SIL OFL 1.1 授权的思源黑体（Adobe），本样本只用于本地测试。
