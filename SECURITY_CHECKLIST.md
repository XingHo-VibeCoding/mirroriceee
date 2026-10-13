# 安全自查清单 —— echoread（Day 23）

> **怎么使用这份清单**：每一行都写了「**怎么算通过**」——也就是一条**可亲手复核**的证据，
> 不接受「已修复」这种空话。带 ✅ 的是本次审计已实测通过，附了命令与结果。
> 复核命令请在项目根目录执行（`C:/Users/20769/Desktop/vibe-coding-30days`）。

---

## 一、密钥与凭据（上线红线）

| # | 检查项 | 怎么算通过（证据） | 状态 |
|---|---|---|---|
| 1.1 | 工作区无硬编码密钥 | 跑密钥特征扫描，输出**0 条**命中 | ✅ 0 条 |
| 1.2 | `.env` 被 `.gitignore` 覆盖 | `git check-ignore -v .env` 输出含 `.gitignore:10:.env` | ✅ 命中第 10 行 |
| 1.3 | `.env` 从未进入 Git 历史 | `git log --all --diff-filter=A --name-only` 里**没有** `.env` | ✅ 无 |
| 1.4 | 提供 `.env.example` 模板 | 文件存在，且里面**只有占位值**（`your_...`），无真实串 | ✅ 存在 |
| 1.5 | `.env.example` 能进仓库 | `git status` 里出现 `?? .env.example`（未被忽略） | ✅ 可见 |
| 1.6 | 业务密钥只从环境变量读 | 代码里 `CLOUDBASE_API_KEY` 全部写作 `process.env.CLOUDBASE_API_KEY`，无字面值 | ✅ 全文如此 |
| 1.7 | 密钥不下发到浏览器 | 前端 `.js` / `.html` 里搜不到 `CLOUDBASE_API_KEY` 的值 | ✅ 仅有公开 URL |

**扫描命令（1.1 的证据，应为 0 条）**：

```bash
grep -rniE "(AKID[A-Za-z0-9]{13,}|Bearer[[:space:]]+[A-Za-z0-9_.-]{30,}|(postgres|mysql|mongodb|redis)://[^/[:space:]]+:[^@[:space:]]+@|secret[_ -]?key[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_-]{16,})" \
  --include="*.js" --include="*.json" --include="*.html" --include="*.css" --include="*.sql" . \
  | grep -v "^./.workbuddy/" | grep -v "^./skills/"
# 期望输出：空（0 条）
```

---

## 二、错误处理（不许把裸报错甩给用户）

### 三类错误的统一口径

| 类别 | 什么时候用 | 给用户看的话 | 证据 |
|---|---|---|---|
| ① **用户输入错** | 必填缺失 / 类型错 / **超长** | 「缺少必填字段：…」「字段过长：…」——**告诉他改什么** | ✅ 后端 400 + 中文 message |
| ② **网络 / 接口错** | 断网、跨域、网关超时、非 200 | 「网络连不上，请检查网络后点下面的「重试」。」——**提示稍后再试** | ✅ `common.js` `network`/`http` 类 |
| ③ **服务端错** | 网关 5xx、JSON 解析失败、未知异常 | 「服务端出错了，请稍后再试。」——**记日志 + 通用提示** | ✅ 后端 500 + `console.error` |

| # | 检查项 | 怎么算通过（证据） | 状态 |
|---|---|---|---|
| 2.1 | 错误提示只有**一个源头** | `common.js` 里的 `failureHTML` 是唯一实现；`home.js`/`app.js` 各只有一处引用、无副本 | ✅ 已收编 |
| 2.2 | 不把 `err.message` 直接吐给用户 | `failureHTML` 函数体内搜不到 `+ err.message` 拼接 | ✅ 无 |
| 2.3 | 服务端错记日志 | 云函数 `catch` 里 `console.error('[echoread-api] 接口出错:', ...)`，对外只说中文 | ✅ 有 |
| 2.4 | 失败必带重试入口 | 每个 `failureHTML` 产出的 HTML 里都有一个 `data-action` 的重试按钮 | ✅ 有 |
| 2.5 | 加载中不留白屏 | 三个页面（首页/跟读/检查台）都有「正在加载…」状态 | ✅ 有 |
| 2.6 | 空数据不说成"错误" | 空数组 → 说"还没有内容"，不是报错 | ✅ 有 |

**验证命令（2.2 的证据，应为空）**：

```bash
sed -n '/function failureHTML/,/^}/p' assets/js/common.js | grep -n '+ *err\.message'
# 期望输出：空
```

---

## 三、非法输入（空值 / 超长 / 类型错 / 注入）

| # | 检查项 | 怎么算通过（证据） | 状态 |
|---|---|---|---|
| 3.1 | 必填字段校验 | POST 缺 `id`/`title`/`desc` → 400 `missing_field`，一次报全 | ✅ 有 |
| 3.2 | 类型校验 | 传数字/对象给文本字段 → 400 `invalid_field` | ✅ 有 |
| 3.3 | **长度上限**（本次新增） | 超长输入 → 400 `invalid_field`，message 写明「哪个字段、超了多少」 | ✅ 新增 |
| 3.4 | 长度上限口径 | `MAX_LEN = {id:64, title:64, desc:500, tag:32}`，前后端一致 | ✅ 有 |
| 3.5 | SQL 注入 | 用户值一律 `encodeURIComponent` 后作查询参数；表名只允许代码内常量 | ✅ 架构保证 |
| 3.6 | 空请求体 | `{}` → 400；数组/字符串/数字 → 400 | ✅ 有 |
| 3.7 | PATCH 至少改一项 | 空 body → 400 `missing_field` | ✅ 有 |

**验证命令（3.3 的证据，需部署后跑）**：

```bash
# 超长 title（100 个 a）→ 期望 400 + 「字段过长：单词（title）太长…」
curl -s -X POST "https://<你的云函数域名>/api/words" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"w-toolong-test\",\"title\":\"$(printf 'a%.0s' {1..100})\",\"desc\":\"x\"}"
```

---

## 四、数据操作安全（增删改查）

| # | 检查项 | 怎么算通过（证据） | 状态 |
|---|---|---|---|
| 4.1 | 改/删必须先确认目标存在 | PATCH/DELETE 用 `return=representation`，空数组 → 404 | ✅ 有 |
| 4.2 | 删除是"可逆"的 | DELETE 实为软删（`is_deleted=true`），数据仍在库 | ✅ 有 |
| 4.3 | 查询过滤已删 | `listWords` 始终带 `is_deleted=false` | ✅ 有 |
| 4.4 | 删了再加能"复活" | POST 撞主键时先查是否软删，是则复活 | ✅ 有 |
| 4.5 | 无"不带条件的改/删" | `rdbUpdate`/`rdbDelete` 的 `filters` 必填，空则拒 | ✅ 有 |

---

## 五、遗留与边界（如实记录，不掩盖）

| # | 事项 | 现状 | 何时处理 |
|---|---|---|---|
| 5.1 | 检查台写入口令硬编码 | `check.js` 里 `WRITE_GATE_PASS='echoread-write'`，**不是安全机制**（文件自带注释已声明），只挡误触 | 若要真拦，需在后端加令牌校验 |
| 5.2 | 彻底清掉软删数据 | 无 `purgeWord()`，软删行永久留库 | 需要时再加 |
| 5.3 | 请求日志 | 后端已有 `console.log` 记增删改；"时间/路径/结果"的完整请求日志属余力加练 | Day 23 余力或之后 |

---

## 六、一键复核

本次审计的自动检查脚本（**双向验证**：真实代码应全过、故意写坏的副本应被杀）：

```bash
# 生成 git 历史快照（本机沙箱里 Node 起子进程会 EBUSY，所以由外部先跑）
git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt

# 真实代码：期望 5 项全 PASS
node skills/frontend-guidelines/scripts/verify-day23-security.mjs

# 故意写坏的副本：期望 5 项全 FAIL（证明 checker 不是橡皮章）
node skills/frontend-guidelines/scripts/verify-day23-security.mjs --bad
```

**最后一次实测结果**：真实代码 `5 项通过，0 项失败`；写坏副本 `0 项通过，5 项失败`。

> ⚠️ **（Day 25 补注，2026-10-12）上面那个脚本已收编，路径失效。原文保留不删，只加本条标注。**
>
> `verify-day23-security.mjs` 已并入发布前检查 Skill，旧文件删除，逻辑不再有第二份实现。
> 它原来那 5 项，在新入口里对应 **A1 / A2 / A3 / A4 / A6**（外加一条新建的 A5「密钥不下发浏览器」）：
>
> ```
> # 生成 git 历史快照（一样：沙箱里 Node 起子进程会 EBUSY，所以由外部先跑）
> git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt
>
> # 真实代码：期望 A 组全 PASS
> node skills\verify-project\scripts\check-offline.mjs
> ```
>
> ⚠️ **`--bad` 那个用法被有意取消了。** 旧脚本的 `--bad` 是"脚本自己造一个假副本再自己抓"，
> 验的其实是对自己的想象。改成**对真实文件注入缺陷、验完立刻 `git checkout` 还原** ——
> 三个注入配方（改哪一行、该红哪条、怎么还原）写在 `skills/verify-project/SKILL.md`
> 「双向验证」一节，照着做即可复现本节的"写坏副本必须 FAIL"。
