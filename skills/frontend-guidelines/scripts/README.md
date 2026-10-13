# 迁移说明（Day 25 · 2026-10-12）

这里原本躺着 7 个脚本。**其中 4 个已经搬家到 `skills/verify-project/`**，
逻辑不再有第二份实现 —— 本目录里的旧文件已删除，只留这张说明。

## 搬走的（收编进「发布前检查」）

| 原文件（已删除） | 原 blob 哈希 | 新家 | 承接的检查项 |
|---|---|---|---|
| `scan-secrets.cjs` | `d59a18a` | `skills/verify-project/scripts/check-offline.mjs` | A1 密钥特征扫描（保留「搜索结果：0 条 —— 干净」的输出口径） |
| `verify-day23-security.mjs` | `ee709a9` | 同上 | A1 / A2 / A3 / A4 / A6 |
| `verify-day23-live.cjs` | `e2bceaf` | `skills/verify-project/scripts/check-online.mjs` | D3 / D4 / D6 + E1 / E2（`--write`） |
| `verify-day24-cors.cjs` | `aec68e6` | 同上 | C1 ~ C5 |

**旧命令怎么换**（是"换个路径"，不是"换个用法"）：

```bash
# 旧（已失效）
node skills\frontend-guidelines\scripts\verify-day24-cors.cjs
node skills\frontend-guidelines\scripts\verify-day23-live.cjs
node skills\frontend-guidelines\scripts\verify-day23-security.mjs

# 新（发布前检查统一入口）
node skills\verify-project\scripts\check-offline.mjs          # A / B / E3
node skills\verify-project\scripts\check-online.mjs           # C / D / F（只读）
node skills\verify-project\scripts\check-online.mjs --write   # 追加 E1 / E2（跑完自己清理）
```

> ⚠️ 搬家**没有削弱检查**，反而更全了：新增了 B 组（发布包不夹带）、
> F 组（线上可达）、D4/D6（边界内放行 + 线上=本地代码）等原先没有的项。
> 双向验证（故意弄坏要能红）的做法与三个注入配方写在 `skills/verify-project/SKILL.md`。

## 没动的（留在原地，仍然有效）

| 文件 | 为什么留着 |
|---|---|
| `check-filter-interaction.mjs` | `frontend-guidelines` skill 自己的工具（静态检查三态 + 可访问性） |
| `verify-three-states.cjs` | 同上（真机三态验证） |
| `verify-request-log.cjs` | 开发期**请求日志探针**，不属于"发布前检查"的范畴 |

## 为什么搬

这四个脚本本来就不属于「前端准则自查」—— 它们只是当时**只有这一个 skill 目录**，就顺手塞这儿了。
按检查对象归位之后：

- 「发布前该查什么」只有一个入口（`skills/verify-project/`），不会漏跑；
- 同一段检查逻辑不再有两份实现（本项目 Day 13 → 23 刚为"重复实现"收过账）；
- 想加新检查项时，只改一处。

## 怎么找回旧文件（万一要）

旧文件都在 Git 历史里（收编时的 HEAD 是 `fb1ba3d`），随时可以取回来：

```bash
cd /d <仓库路径>
git checkout fb1ba3d -- skills/frontend-guidelines/scripts/scan-secrets.cjs
git checkout fb1ba3d -- skills/frontend-guidelines/scripts/verify-day23-security.mjs
git checkout fb1ba3d -- skills/frontend-guidelines/scripts/verify-day23-live.cjs
git checkout fb1ba3d -- skills/frontend-guidelines/scripts/verify-day24-cors.cjs
```

## ⚠️ 已知遗留（未处理，等确认）

根目录三份文档里仍写着**旧路径**，按本项目「保留原文、只加 ⚠️ 标注」的规矩
应当在原文下方加一条标注指到这里，但**本次未动**（改文档需单独确认）：

| 文档 | 位置 |
|---|---|
| `RUN.md` | 第七节 7.4「线上回归脚本」、7.5「跨域回归脚本」 |
| `SECURITY_CHECKLIST.md` | 第六节「一键复核」 |
| `CORS_FIX.md` | 第五节「回归验证」 |
