# free talk 话题库 · 来源与许可

## 一、英文问句来自哪里

- 仓库：<https://github.com/1599570912/IELTS-Speaking-AI>
- 文件：`ielts-question-bank.js`（14280 字节，已留档为 `ielts-question-bank.orig.js`）
- 许可：**MIT License**（仓库根目录 LICENSE 实存）

MIT 允许复制、修改、再分发（含商用），唯一硬性义务是**保留版权声明**——本文件即为履行。
原始题库版权归原作者（GitHub 用户 `1599570912`）所有。

## 二、我们改了什么

1. `extract.mjs`：eval 原始 class 取出 `questionBank`，按「分类 → 题」摊平。
2. 原始题库实测 **62 条**（README 自称「210+」，虚标，实测为准）：Part 1 34 / Part 2 4 / Part 3 24。
3. 剔除 2 条考官身份核验题（`What's your full name?`、`Can I see your ID?`）——那是考试开场白，不是练习话题。剩 **60 条**。
4. 追问重组：原仓库是平铺列表，我们按「主问 + 同分类其它题目作追问」重排；Part 2 的 `follow_up` 为原仓库自带。
5. 缩写展开 3 条（`it's` → `it is`、`What's` → `What is`），便于朗读与发音。

## 三、哪些不是搬的

| 字段 | 来源 |
|---|---|
| `q` 英文问句、`follow` 追问、`bullets` 要点 | MIT 题库（见上） |
| `zh` 中文翻译 | 本项目自撰 |
| `words` 参考词汇 | 本项目按话题挑选 |
| `tips` 表达支架 | 本项目自撰 |
| `sample` 参考回答 | 本项目自撰（60 条，平均 51 词） |

参考词汇只提供有道**标准美音**：全球发音需离线预取 voiceId，本页未预取，故不放点不响的按钮。

## 四、复现与校验

```bash
# 1 从留档的题库里抽出结构化题目
node tools/freetalk/extract.mjs          # 输出 qbank-extracted.json

# 2 校验数据完整性（字段齐全 / id 唯一 / 分类闭合）
node tools/check-freetalk.mjs

# 3 溯源验证：问句能否在原文找到、范文是否为原创
node tools/verify-freetalk-source.mjs
```

第 3 步的判定（最近一次实测）：

| 项 | 结果 |
|---|---|
| 主问句来自题库 | 60/60（逐字 57 + 缩写展开 3） |
| 追问来自题库 | 180/180（逐字 174 + 缩写展开 6） |
| 参考回答命中原文 | **0/60** → 证明范文为自撰，非抄袭 |

## 五、被弃用的数据源（留档说明为什么不碰）

`ChiShengChen/IELTS_speaking` 数据更全（含 Band 7 范文 + 主题词表），但
**仓库无 LICENSE 文件**（raw 抓取 404）。没有许可证 = 默认保留所有权利，
不能搬运，故弃用。宁可少拿数据，不碰版权不明的仓库。

## 六、能不能确定这些是「雅思真题」？——**不能**

核实过程与结论：

| 核实动作 | 结果 |
|---|---|
| 查原仓库《题库集成说明.md》有无来源声明 | **通篇没有一句说明题目从哪来**；只在结尾营销句里出现「使用真题进行考试模拟」，另一处写的是「按照 IELTS 官方**结构**练习」（指 Part 1/2/3 形式，不是官方题目） |
| 原仓库自称题量 vs 实测 | 自称「210+ 真题」→ 实测 **62 条**，虚标 3.4 倍，作者可信度打折 |
| 抽查 `Do you use the internet very much?` | 在中文备考站（老烤鸭）Part One Internet 话题里**逐字出现**；但同话题在新东方站是 `Do you often use the Internet?`、在 PrepAsk 是 `How often do you go online?`——**各家措辞不一** |
| 抽查 `Describe a person you admire` | 多个独立备考站都有这个主题，但 SpeakShark 明确标注「Practice cue cards (**phrased by us**)」——即站点自己编写的练习卡 |
| 是否有官方来源可比对 | **没有**。雅思官方（ielts.org）不公开完整题库，网传题库均为考生回忆 + 机构整理/改写，无法官方溯源 |

**能确定的**：题型结构是雅思官方的 Part 1/2/3；话题属于雅思高频常考范围
（Internet、person you admire、memorable journey、skill、place 等均为经典主题）；
部分问句在公开备考资料中能找到近同措辞。

**不能确定的**：没有任何一条能证明「某一场真实考试考过它」。第三方题库无法自证真题，
本仓库也不例外。

**因此本项目的表述统一为「雅思题型练习话题」，不写「真题」。**
对练习本身没有影响——题型、话题、难度分级都是对的，只是不挂「真题」这个无法兑现的名头。
