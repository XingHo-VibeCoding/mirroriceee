---
name: verify-project
description: "Pre-release check for this project (EchoRead): secrets & .env hygiene, release-package leaks, CORS whitelist, frozen API contract, soft-delete safety, and live reachability. Use when the user asks to 发布前检查 / 上线前自查 / 跑一遍发布检查 / 验收自查 / 检查跨域 / 密钥扫描 / 接口契约检查 / pre-release check / release gate."
description_zh: "发布前检查 —— 把「上线前必须过的 26 项」写成能自动跑的检查：密钥与 .env、发布包不夹带机密、跨域白名单、接口契约（冻结）、软删数据安全、线上可达。逐项 PASS/FAIL/跳过 + 证据，退出码 0 才算过。"
description_en: "Pre-release gate: secrets, release leaks, CORS, API contract, data safety, reachability"
display_name: "发布前检查"
display_name_en: "Pre-release Check"
version: 1.0.0
visibility: "public"
agent_created: true
---

# 发布前检查

## 用途

把「这东西能不能发布」从**人的记忆**变成**能跑的命令**。

这份清单不是凭空写的 —— 每一条都对应本项目**真实踩过的一次坑**：

| 检查项 | 它防的是哪次事故 |
|---|---|
| A 组 | Day 23 安全审计：密钥红线、`.env` 与忽略规则 |
| B 组 | Day 23 → Day 24：发布是「整目录上传、只增不删」，本地删了线上还在 ⇒ 只能靠服务器层拒绝 |
| C 组 | Day 23 发现 / Day 24 复现：网关跨域白名单漏了发布域名，界面报「网络连不上」，而 **curl 全绿** |
| D 组 | Day 23：`commit 9dcff11` 早提交了，但云函数没重新部署 ⇒ **源码 ≠ 线上生效** |
| E 组 | Day 22：`w-abandon` 被删了三天才发现 —— 删要能退，重复写不能悄悄变两条 |
| F 组 | Day 9 / Day 13：Range 支持没了跳播必坏；`.md` 文档会上公网 |

**这段是硬契约**：检查跑出红条还当没看见，等于这次自查没做。

## 何时使用

用户提到以下任一意图时使用本 skill：

- 「发布前检查」「上线前自查」「跑一遍发布检查」「验收自查」
- 「检查跨域」「CORS 通不通」「白名单」
- 「密钥扫描」「有没有把 key 传上去」
- 「接口契约有没有被改」「错误码还对不对」

**不适用**：前端筛选交互的三态与可访问性（那是 `frontend-guidelines` skill）；性能 / 包体积 / CSS 视觉审查。

## 检查项（26 条）

### A 组 · 密钥与机密（离线）

| 编号 | 检查什么 | 怎么算过 |
|---|---|---|
| A1 | 工作区无硬编码密钥 | 按**真密钥形态**扫描（AKID / 私钥头 / 带密码连接串 / 硬编码赋值 / 长 Bearer），**0 条命中**。不含裸变量名（搜 `api_key` 会误伤 `process.env.CLOUDBASE_API_KEY` 这种正常代码） |
| A2 | `.env` 被 `.gitignore` 挡住 | **按 Git 的真实语义**逐行判定：`.env` 确实被忽略，**且** `.env.example` 没被一起挡住。⚠️ 判据不是"有 `.env` 或 `.env.*` 行就算过" —— `.env.*` 挡不住 `.env` 本身（Day 25 注入测试逮到过这个漏报） |
| A3 | `.env` 从未进过 git 历史 | 快照里**没有**独立一行 `.env`。快照缺失 ⇒ 报「没查」，**不默认通过** |
| A4 | `.env.example` 存在且只有占位值 | 存在，有 `your_…` 占位写法，且无真实值（AKID / 长 hex / 带密码连接串） |
| A5 | 密钥不下发浏览器 | 前端 js / html 里 **0 次**出现 `CLOUDBASE_API_KEY`（判据比「搜不到值」更可验证） |
| A6 | 错误提示不外吐 `err.message` | `common.js` 的 `failureHTML` 函数体里没有 `+ err.message` 拼接 |

### B 组 · 发布包不夹带机密（离线）

| 编号 | 检查什么 | 怎么算过 |
|---|---|---|
| B1 | `dev-server.js` 路径前缀黑名单齐全 | 覆盖 `.env` / `.workbuddy/` / `.git/` / `cloudfunctions/` / `db/` 五个 |
| B2 | `dev-server.js` 后缀黑名单齐全 | 含 `.md`，且含 `.env*` |
| B3 | 交叉比对：仓库里的敏感物逐条能被挡住 | 把**真实躺着**的敏感文件（`.env` / `.workbuddy/memory/…` / `cloudfunctions/…` / `db/schema.sql` / 各 `.md`）拿同一套规则过一遍，**一个都不许漏** |

### C 组 · 跨域（联网）

| 编号 | 检查什么 | 怎么算过 |
|---|---|---|
| C1 | 发布站点来源能拿到跨域头 | 带发布域名 `Origin` 打 `GET /api/health` → `access-control-allow-origin` **回显自身**（回 `*` 也不算过） |
| C2 | 写入预检能过 | `OPTIONS /api/words` 带 `Access-Control-Request-Method: POST` → **204** 且 `allow-methods` 含 POST |
| C3 | 对照组没被误伤 | `localhost:8000` 与内置 `tcloudbaseapp.com` 仍**有**跨域头（防「修一个坏一个」） |
| C4 | 白名单没被改松 | `https://evil.example.com` **必须仍无**跨域头（比原 Bug 更严重的错，是"闸门被拆"） |
| C5 | 接口本体是活的 | 不带 `Origin` → 200。把「跨域被拦」和「接口坏了」分开 |

### D 组 · 接口契约（联网，冻结：路径 / 字段名 / 错误码都不许动）

| 编号 | 检查什么 | 怎么算过 |
|---|---|---|
| D1 | 健康检查结构 | `GET /api/health` → `{ok:true, service:"echoread"}` |
| D2 | 读接口结构 | `GET /api/words` → `{words:[…]}` |
| D3 | 五个错误短码齐全 | `missing_field` / `invalid_field` / `word_not_found` / `not_found` / `method_not_allowed` —— **契约文档里写着** + **线上实测都对** + 都有中文 message |
| D4 | 边界内不误伤 | `tag` 32 / `title` 64 / `desc` 500 走**不存在的 id** → 应回 404 `word_not_found`（说明长度校验放行、走到了查无此 id） |
| D5 | 路径式写法不认 | `PATCH /api/words/{id}` → 404 `not_found`（Day 23 踩过：id 必须走**查询参数**） |
| D6 | **线上 = 本地这份代码** | `tag` 33 / `title` 65 / `desc` 501 → 必须 400 `invalid_field`。**回 404 就说明线上还是没长度校验的旧版本** |

**为什么 D4 和 D6 是一对**：光有「越界被拦」可能只是拦得太狠；光有「边界内放行」可能根本没校验。两个一起看，才知道校验**恰好卡在上限**上。这两条都走不存在的 id，**完全不碰库**。

### E 组 · 数据安全

| 编号 | 检查什么 | 怎么算过 | 需要 |
|---|---|---|---|
| E1 | 软删可逆 | DELETE → 200、列表里看不见；同 id 再写 → 2xx 复活、且只有 1 条 | `--write` |
| E2 | 同 id 不双写 | 重复 POST 同 id → **409**，列表里该 id 仍只有 1 条 | `--write` |
| E3 | 查询过滤已删 | `words.repo.js` 的 `listWords` 函数体里带 `is_deleted` 过滤 | 离线 |

### F 组 · 线上可达（联网）

| 编号 | 检查什么 | 怎么算过 |
|---|---|---|
| F1 | 四个页面能打开 | 发布站点上 `/` `/reader.html` `/vocab.html` `/writing.html` 全 200 |
| F2 | 音频支持分段请求 | `Range: bytes=1000-1999` → **206** + `Content-Range`（**跳播的前提**，回 200 就一定坏） |
| F3 | 内部东西没上公网 | 发布站点上 `/RUN.md`、`/.env`、`/cloudfunctions/echoread-api/index.js` **都拿不到 200** |

## 如何调用（两个工具，缺一不可）

### 工具一 · 离线检查（只看磁盘，零网络零子进程）

```bash
cd /d <仓库路径>
node skills\verify-project\scripts\check-offline.mjs
```

不带参数时查当前工作目录，也可以 `node <脚本> <项目根目录>` 指定。

**跑之前先生成 git 历史快照**（A3 要读它）：

```bash
cd /d <仓库路径>
git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt
```

> ⚠️ 为什么 A3 不自己跑 `git`：**本机沙箱里 Node 起任何子进程都 EBUSY**（连 `git rev-parse HEAD` 都起不来）。
> 一个"看环境脸色"的检查器比没有更糟，所以改成**外部先出快照、脚本只读文件**。
> 快照文件已在 `.gitignore` 里被忽略，不进仓库。

### 工具二 · 联网检查（打真实接口 / 真实站点）

```bash
cd /d <仓库路径>
node skills\verify-project\scripts\check-online.mjs

:: 要验写入路径（软删可逆 / 同 id 不双写），加 --write —— 脚本自己清理
node skills\verify-project\scripts\check-online.mjs --write
```

- 默认 **只读**：所有请求都是「必然被拒」或「查无此 id」的那种，**不写库、不造数据**。
- 可覆盖地址：`ECHOREAD_API`（接口基地址）、`ECHOREAD_SITE`（发布站点来源）。
- 退出码：**0 = 执行到的项全过；1 = 有 FAIL**。⚠️ 以退出码为准，别靠肉眼扫输出。

### 两个工具的分工

离线答「**仓库里**有没有带不该带的」，联网答「**线上**现在是不是真的对」。
**只跑一个不算做完自查。**

## 双向验证（这不是橡皮章）

工具在真实代码上跑绿，**不足以**证明它有用 —— 可能它太宽松、什么都放行。
必须再证明「**故意弄坏，它真会红**」。三个注入配方（改完记得立刻还原）：

| # | 怎么弄坏 | 应该红哪条 | 还原 |
|---|---|---|---|
| 1 | 把 `.gitignore` 里的 `.env` 行注释掉 | **A2** | `git checkout -- .gitignore` |
| 2 | 在 `common.js` 的 `failureHTML` 里加一句 `+ err.message` | **A6** | `git checkout -- assets/js/common.js` |
| 3 | 删掉 `dev-server.js` 里 `BLOCKED_PATH_PREFIX` 的 `'cloudfunctions/'` | **B1** + **B3** | `git checkout -- dev-server.js` |

⚠️ 注入一律**改动真实文件、验完立刻 `git checkout` 还原**，做完用 `git status` 复核工作区干净。
**不要**做成脚本内置的 `--bad` 假副本模式 —— 那验的是"脚本对自己的想象"，不是"对真实缺陷的反应"。

联网侧自带一条**天然的红**：在跨域白名单补上发布域名之前，**C1 / C2 必然是 FAIL**。
「补上白名单后由红转绿」这个差值，就是修复生效的铁证。

## 人还要做的那一步（脚本替不了）

两个脚本都跑完之后，剩下这一步必须人来做：

1. 打开**发布站点**的检查台，按 F12；
2. 看 Console 里是「具体的 HTTP 状态码」（白名单内）还是 `blocked by CORS policy`（白名单外）——
   这是一条**免费的现场判据**，一眼能分出"本地还是线上"；
3. 截图，**图里要含地址栏与报错原文**。

为什么脚本绿了还要人看：脚本验的是「头对不对」，
看不出「用户看到的那句话读起来顺不顺」「页面是不是白屏」。这一步缺了，自查只算做了一半。

## 输出格式

```
==============================================================
 发布前检查 · 离线部分（磁盘）
 项目根：<仓库根>
 时间：<本地时间>
==============================================================
【A 组 · 密钥与机密】
  ✅ A1  工作区无硬编码密钥
       ↳ 搜索结果：0 条 —— 干净
  ⏭  A3  .env 从未进入 git 历史
       ↳ 没查的原因：未找到 .git-history-snapshot.txt …
...
--------------------------------------------------------------
 汇总：PASS 20 / FAIL 3 / 跳过 1（共 23 项实际执行）
--------------------------------------------------------------
 退出码：1（0 = 全部执行到的项都过；1 = 有 FAIL）
```

> ⚠️ **「跳过」不等于「通过」。** 条件不满足（比如快照没生成）时必须诚实地说"这项没查"，
> 汇总里会单列，并明确提示「跳过 ≠ 通过，需要人工确认」。

## 已知边界（诚实说明）

- 离线检查是**源码启发式**（正则 / 字符串），不是编译器：它认的是「这段规则**存在**」。
  `dev-server.js` 里的黑名单变量**改了名就会抠不出来** → B1/B2 会明确报"抠不出，请人工确认"，
  **不会**假装通过。这是刻意的设计，不是 bug。
- 密钥扫描**排除 `skills/` 整个目录**：检查器自己文件里写着密钥正则（如 AKID 的形态），
  不排除就会"自己抓自己"。代价是 skill 目录里的脚本不在扫描范围内。
- `assets/audio/` 也被排除（对二进制没意义，且体积大）。
- 联网检查依赖 Node 18+ 的全局 `fetch`，无需任何第三方依赖。
- 检查项与具体实现**松耦合**：函数重命名、目录搬家都可能让某条突然变红。
  先看是不是改了名字，再决定改代码还是改规则。
- E1 的「数据还在库里」这一半**验不了** —— 没有"列出已软删行"的接口（Day 22 记过）。
  能验的是：删完看不见 + 能复活（复活本身证明数据还在）。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot find module` | 在别的目录直接敲了脚本名 | 用完整路径，或先 `cd /d <仓库路径>` |
| A3 一直显示「跳过」 | 快照文件没生成 | 先跑一遍文件头那条 `git log … > .git-history-snapshot.txt` |
| B1/B2 报「抠不出」 | 黑名单变量被改名 | 改回原名，或同步更新检查脚本里的变量名 |
| C1/C2 一直红 | 跨域白名单没有发布域名 | **免费体验版加不了**，见根目录 `CORS_FIX.md` 四·补；这不是脚本的问题 |
| 中文输出乱码 | Windows 终端代码页 | 先 `chcp 65001` |

## 资源

- `scripts/check-offline.mjs` —— 离线检查器（零依赖、零子进程，纯 Node 内置模块）。
- `scripts/check-online.mjs` —— 联网检查器（Node 全局 `fetch`，只读为默认）。
- `scripts/lib/report.mjs` —— 两个脚本共用的输出 / 汇总框架（只留一份实现）。
- `records/` —— 每次调用的输出存档与双向验证记录。

## 收编说明（Day 25）

本 skill 是「发布前检查」的**统一入口**。原先散在 `skills/frontend-guidelines/scripts/`
下的几个发布前脚本已于 Day 25 收编到这里，**逻辑不再有第二份实现**：

| 原文件 | 去向 |
|---|---|
| `scan-secrets.cjs` | → A1（并保留「搜索结果：0 条 —— 干净」这句输出，截图口径不变） |
| `verify-day23-security.mjs` | → A1 / A2 / A3 / A4 / A6 |
| `verify-day23-live.cjs` | → D3 / D4 / D6 + E1 / E2（`--write`） |
| `verify-day24-cors.cjs` | → C1 ~ C5 |

**留在原地没动的**（它们不属于"发布前检查"）：
`check-filter-interaction.mjs`、`verify-three-states.cjs`（`frontend-guidelines` skill 自己的工具）、
`verify-request-log.cjs`（开发期的请求日志探针）。

⚠️ 根目录 `RUN.md` 第七节、`SECURITY_CHECKLIST.md` 第六节、`CORS_FIX.md` 第五节里
仍写着旧路径 —— 那些是**历史记录**，按本项目规矩「保留原文、只加标注」，改动需单独确认。
