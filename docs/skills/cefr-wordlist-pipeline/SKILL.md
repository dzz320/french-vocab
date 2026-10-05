---
name: cefr-wordlist-pipeline
description: 从 FLELex（CEFR 定级）+ Lexique383（词形/IPA音标/词性/阴阳性）合成**分级法语词表**，产出的 CSV 可直接导入背单词类应用（表头 mot/中文释义/音标/词性/例句/例句翻译）。当用户要「A1/A2/B1/B2 词表」「按等级的词库」「几千词的词汇表」「带音标和例句的词表」时使用。内含两个数据源的获取捷径（pylexique 走 PyPI 秒下，官方站点要 35 分钟）与六个实测坑（文件是 latin-1、音素不是标准 IPA、频率栏是词根级、词根大小写、阴阳性空值、省音前缀被拆分），以及批量生成释义/例句并逐行机械校验的产线。
agent_created: true
---

# CEFR 分级词表产线（FLELex + Lexique383）

## 何时使用

- 用户要一份「A1 / A2 / B1 / B2 法语词表」，或者问「B1 不是应该 3000 词吗」；
- 要按等级建词库（B1 库 / B2 库），需要**几千条**带音标、词性、释义、例句的条目；
- 已经有一份手工小词表，用户嫌少，要扩到标准量级。

不适用：只要几十到两三百条、且要求逐条人工打磨质量时，手工写反而更齐整（见文末「什么时候别用这条产线」）。

## 两个数据源

| 源 | 作用 | 授权 |
|---|---|---|
| **FLELex**（CENTAL / UCLouvain） | 给每个词条一个推断的 CEFR 等级，**只负责定级** | 学术资源，使用需引用论文 |
| **Lexique383**（lexique.org） | 词形归一(lemme)、**IPA 音标**、词性(cgram)、阴阳性(genre)、词频 | **CC BY-SA 4.0**（署名 + 衍生同协议） |

### 获取：别直接从官方站点下 Lexique383

`http://www.lexique.org/databases/Lexique383/Lexique383.tsv` 有 25.8 MB，实测从该站点下载约 **35 分钟**（上一次 4 分钟只下到 1.4 MB）。

**捷径**：PyPI 上的 `pylexique` 包直接内置了完整数据文件，走 CDN 几秒下完：

```bash
python -m pip install pylexique
# 数据在 site-packages/pylexique/Lexique383/Lexique383.txt（25 MB，与官方 .tsv 同格式）
```

FLELex 只有 718 KB，直接下即可：

```
https://cental.uclouvain.be/cefrlex/static/resources/fr/FleLex_TT_Beacco.tsv
```

列：`word / tag / freq_A1..freq_C2 / freq_total / level`。
实测 level 分布：A1 1247、A2 679、B1 1753、B2 5088、C1 3155、C2 2314。

## 六个实测坑（每一个都会静默产出错数据）

### ① Lexique383 是 **latin-1**，不是 UTF-8

```python
raw.decode('utf-8')   # UnicodeDecodeError: invalid start byte 0xa7
raw.decode('latin-1') # OK
```

**症状**：没报错但**所有带重音的词全部查不到**。曾经 1753 条里有 435 条「缺音标」，全是 `abbé` `accès` `aîné` 这类。

Node 侧：`fs.readFileSync(p, 'latin1')`（字节直接映射到 U+0000–U+00FF，正是 latin-1 语义）。

### ② `phon` 列不是标准 IPA，是 Lexique 自己的 ASCII 音素表

直接用会把音标全部写错。**枚举 `phon` 列出现的全部字符**，再用发音确定的词反推（`tu`→ty、`huit`→8it、`bon`→b§、`temps`→t@、`vin`→p5、`agneau`→aNo 等），得到完整映射：

| Lexique | IPA | | Lexique | IPA |
|---|---|---|---|---|
| `R` | ʁ | | `@` | ɑ̃ |
| `S` | ʃ | | `§` | ɔ̃ |
| `Z` | ʒ | | `5` | ɛ̃ |
| `N` | ɲ | | `1` | œ̃ |
| `G` | ŋ | | `2` | ø |
| `E` | ɛ | | `9` | œ |
| `O` | ɔ | | `8` | ɥ |
| `y` | y | | `°` | ə |
| `u` | u | | `j` | j |

其余 `a e i o p b t d k g f v s z m n l w` 与 IPA 同形。`A`（ɑ）在该列**从未出现**（法语 a/ɑ 已合并）。
`x`/`0`/`r`/`-` 只在十几个外来词或脏数据里出现，可忽略。

`23_syll` 列是同一套音素的音节切分，用 `-` 分隔（`b§-ZuR`）；把 `-` 换成 `.` 就得到带音节点的音标 `bɔ̃.ʒuʁ`，比只有整词音标更好用。

### ③ `freqlemfilms2` / `freqlemlivres` 是**词根级**频率，不能用来在同形词里挑

**这是最阴的一个坑。** `aller` 的 42 个变位**全都写着 9992,77**（词根频率），按「频率最高」排序等于随机抽——`aller` 会被抽成 `aille` 的发音 `/aj/`。

必须改用**词形级**的 `9_freqfilms2` + `10_freqlivres`，并且优先用 `14_islem`（这个形本身是不是原形）做第一判据，词性匹配做第二判据：

```
排序优先级：islem=1 > 词性与目标同族 > 词形频率高
```

### ④ `lemme` 列有大小写不一致

`vrai` 本身在 Lexique 里**没有条目**，但 `vrais`/`vraie` 的 lemme 写的是大写的 **`VRAI`**。
按小写建 `byLemme` 索引就会查不到，`vrai` 白丢。→ 索引键统一 `toLowerCase()`。

### ⑤ `genre` 列有**空值**，默认成阳性会把阴性名词标错

实测 962 个名词里 47 个 genre 为空（`gorge` `poche` `souris` `foudre` `barbe` `ordonnance` `auto` `politique` `manière`…）。
其中一部分确实是两性通用（`ministre` `pilote` `spécialiste` `ancêtre` `guide` `interprète`），保留阳性是惯例；
但另一部分明确是阴性，需要一张**人工覆盖表**。

交叉验证的好办法：**看生成的例句里的限定词**。`La foudre est tombée…`、`une ordonnance`、`la poche` 是独立于你的判断的第二个信号。

### ⑥ 省音前缀被 Lexique 拆开了

Lexique 里**没有** `d'ailleurs`，只有 `ailleurs`（`qu'`、`l'`、`n'`、`s'`、`j'`、`m'`、`t'`、`c'` 同理）。
查不到时按「省音辅音 + 余下部分的音标」拼回：`d` + `aj9R` → `da.jœʁ`。

同类例外还有：`tandis` 只收录了整体 `tandis que`；`médiathèque` / `retraiter` / `rentraire` / `est-à-dire` / `mi-temps` 确实**不在库中**（需人工补音标并标注）。

## 产线步骤

1. **建底表**（`assets/build_cefr_wordlist.cjs`，按需改 LEVEL 与列映射）：
   FLELex 取目标等级 → 丢碎片（非字母开头，如 `-ci`）→ 全大写归一为小写 → 查 Lexique383（原形→词根索引→去省音前缀）
   → 按 `islem`/词性/词形频率选最佳条目 → 该归一才归一到原形 → 音标转 IPA → 词性/阴阳性映射 → 输出 TSV。

2. **词形归一的取舍**（很重要，别无条件按 `lemme` 改）：
   Lexique 习惯把**阴性名词也挂到阳性词根**下——`princesse→prince`、`héroïne→héros`、`demoiselle→damoiseau`、`servante→servant`、`épouse→époux`。
   照它改会把独立的词弄丢。规则：
   - `VER` 的变位 → 不定式（`allons→aller`）✅
   - 形容词/限定词/代词的性数变化（`grecque→grec`、`tous→tout`、`sèche→sec`）✅
   - 名词复数 → 单数（`mesdames→madame`、`castagnettes→castagnette`）✅
   - **名词单数一律不动**（保住 `princesse` `héroïne` `épouse`）✅

3. **词性映射**到目标应用的取值域。常用 12 值：`n.m. n.f. v. adj. adv. prép. conj. pron. det. num. interj. loc.`
   Lexique cgram：`NOM VER ADJ ADV PRO PRE CON ART INT ONO`；带 `:NUM` 的 `ADJ:num` → `num.`；`AUX` → `v.`。

4. **批量生成中文释义 + 例句 + 例句翻译**：切块（每块 100 条），每块交给一个子代理，
   给它 `word<TAB>pos<TAB>ipa`，要求它产出六列 CSV。要点：
   - **音标/词性原样照抄**，明确禁止它自己重写音标（否则会开始臆造）；
   - 表头用目标应用的表头词（如 `mot,中文释义,音标,词性,例句,例句翻译`），这样导入时零点击对位；
   - 明确要求**不写 UTF-8 BOM**（写文件工具常常自动加，表头会变成 `\ufeffmot`）；
   - 别名/多词条目要提醒它 `mot` 可能含重音、连字符、撇号。

5. **机械校验后合并**：逐行对回底表，断言 ①表头 ②行数 ③顺序 ④`mot`/`音标`/`词性` 三列**逐字符相同** ⑤释义/例句/翻译非空。
   只有硬性错误为 0 才输出成品。最后加 UTF-8 BOM（Excel 打开中文不乱码）。

6. **抽看质量**：随机抽 10–15 条完整记录人工读一遍。重点看**性数配合**和**介词搭配**，
   这两类错误机械校验抓不到（例：`Les pluies abondantes de ce printemps…` 里的 `abondantes` 配合对不对）。

## 交付前必须知道的语义

**FLELex 是按「词 + 词性」分别定级的**，所以同一个词形在不同等级承载不同义项：

```
pouvoir → VER@A1, NOM@B1     # A1 学「能够」，B1 学「权力」
être    → VER@A1, NOM@B1     # B1 是名词 l'être
impossible → ADJ@A1, NOM@B1  # B1 是名词 l'impossible
immobilier → ADJ@B1, NOM@B2
```

所以一份「完整 B1」里出现 `pouvoir n.m.`（而不是动词）是**正确的**，它收的是这一级的新知识。
但用户看到会疑惑 —— **主动在交付说明里解释这一点**，否则会被当成错误。

同理，完整 B1 与手工 A1/A2 会有几十个**词形重叠**（同一词形、不同义项），这不是重复内容，
导入时只会提示不会拦。要在说明里写清重叠数量，别让用户以为是数据出错。

## 词量口径（用户一定会问）

常见说法「B1 有 2000–3000 词」指的是**累计量**（A1+A2+B1），不是单级新增。
口径也要对齐 —— 这些数字和产线输出都是 **lemmes（词族）** 口径：`parler / parle / parlais / parlé` 算 1 个。

FLELex 的累进覆盖：A1 1247 → A1+A2 ≈ 1900 → 到 B1 ≈ 3700 → 到 B2 ≈ 8800。

## 验证方式（务必做）

1. **音标抽样反查**：挑鼻化元音、圆唇元音、半元音、重音各几个（`vin` `deux` `huit` `fleur` `agneau` `travail` `maison`），
   人工读一遍确认映射没错 —— 映射表错一个字符就是几千条全错。
2. **近变形冗余检查**：找出「去尾 1–2 个字符后仍在表里且音标相同」的对，人工判断是真同音词（`bond`/`bon`、`dont`/`don`、`file`/`fil`）
   还是漏归一的变形。
3. **同词根多条目检查**：按 lemme 分组，若同组出现多条目，确认是 `baisse`(n.)/`baisser`(v.) 这种合法成对，
   而不是 `tout`/`tous` 这种该合并的。
4. **端到端导入**：用目标应用真实的解析器和数据层把成品真的导入一遍（哪怕有上万条），
   断言条数、首末条顺序、长字段（含逗号/撇号/合字）原样落库、重复导入幂等。

## 什么时候别用这条产线

- 只要 100–300 条时：手工逐条打磨（自己写 IPA + 配对例句）质量更齐整，批量生成反而会出现
  「词对但句子生硬」。
- 需要**多词固定搭配/语篇连接词**（`je pense que`、`en effet`、`se rendre compte`）时：
  这类不在 FLELex 词根表里，必须单独手工补一份，再与主表做零重词校验。

## 资产

- `assets/build_cefr_wordlist.cjs`：底表构建脚本（含音素映射表、归一规则、省音回退、性别覆盖表），
  改 `LEVEL` 与输出列即可复用。直接 `node build_cefr_wordlist.cjs`（需先备好两个数据文件）。
