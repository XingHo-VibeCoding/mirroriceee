# RUN.md · 运行与自验说明

> **项目英文名：EchoRead**（2026-10-09 定，见 `package.json` 的 `name`）。
> 下面命令与路径里出现的 `vibe-coding-30days` 是**仓库目录名**，与项目名无关，不用改。

本项目是纯前端静态站点：**没有构建步骤，没有需要安装的依赖**。
但**必须用一个支持 Range（分段请求）的本地服务器打开**，不能双击 HTML 文件——原因见第四节。

## 一、环境要求

- Node.js 18 或以上（只用到标准库 `http` / `fs` / `path` / `os`，无第三方依赖）
- 现代浏览器（Chrome / Edge / Safari）
- 全程本地运行，不需要联网

## 二、启动

在项目根目录执行：

```
node dev-server.js
```

默认端口 8000。端口被占用时换一个：

```
node dev-server.js 8001
```

启动成功后终端会打印四行：本地访问地址、网站根目录、一行状态说明、以及手机访问用的局域网地址。

## 三、打开

- **电脑**：浏览器访问 `http://localhost:8000/`
  - 首页三张卡片：文本跟读 / 词汇速记 / 作文模板，**Day 13 起三个都能进**
  - 三个内页都能直达，也都能用页面顶部那条导航互相切换、或点「← 返回首页」回首页：
    - `http://localhost:8000/reader.html`（文本跟读）
    - `http://localhost:8000/vocab.html`（词汇速记）
    - `http://localhost:8000/writing.html`（作文模板）
  - **作文模板页现在是空的**（内容还没准备），打开会看到「作文模板还没有内容。」—— 这是数据为空时的正常提示，**不是坏了**
  - 跟读页里要**一层层点进去**，共三层：等级目录（L1 / L2 / L3）→ 文件列表 → 音频与逐句文本
    - 只点了等级、没点具体文件时，下面**什么都不出现**，这是设计如此，**不是坏了**
- **手机（真机验收用 —— 本期暂缓）**：本期以 PC 端验收为准（见 `PRD.md` §2.3）。若日后要手机验证：手机与电脑连同一个 Wi-Fi，访问启动时打印的那条局域网地址
- **停止**：在跑服务器的那个终端窗口按 `Ctrl + C`

## 四、为什么不能用别的方式打开（两种都踩过）

### 双击 `index.html` 不行

双击打开时地址栏是 `file:///...`。浏览器出于安全限制会拦截本地文件发起的 `fetch` 请求，导致 `data/materials.json` 读不到，页面停在「正在加载素材…」。
另外，课程完成标准也要求地址栏是 `localhost` 开头。

### `python -m http.server` 也不行

它**不支持 Range（分段请求）**。
「点第 8 句、从第 18 秒开始播」这个动作，底层是浏览器向服务器索取「从第 18 秒对应的字节开始的那一段」：支持 Range 的服务器回 `206 Partial Content` + `Content-Range`，浏览器才允许跳播；Python 那个极简服务器只会回 `200` + 整个文件，浏览器拿不到分段数据，于是**直接禁止 seek**——`audio.currentTime = 18` 落空，点哪一句都从头播整段。

所以项目自带 `dev-server.js`，它做三件事：支持 Range、关闭浏览器缓存、启动时打印局域网地址。

### 项目文档（`.md`）不对外提供

`dev-server.js` 里有一条规则：**任何 `.md` 请求一律回 404**（见该文件里的 `BLOCKED_EXT`）。

为什么需要它 —— 发布是「只增不删」的：文件一旦随发布上传，就留在服务端沙箱里**删不掉了**
（实测：本地删掉后重新发布，线上仍返回 200）。所以**已经上去过的**文档，只能改由**服务器层拒绝**。
这是唯一能可靠下架"已上传文件"的办法。

影响范围：下节目录里那几份 `.md`（含 `USER_TEST.md` / `MOBILE_FIX.md`）**在线上访问不到**，
本地打开不受任何影响。

## 五、自验（三条命令，看输出就知道对不对）

```bash
# 1) 页面能打开 —— 期望 200
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/reader.html
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/vocab.html
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/writing.html

# 2) 音频能分段 —— 期望 206（这条是关键，坏了跳播就一定是坏的）
curl -s -o /dev/null -D - -H "Range: bytes=1000-1999" http://localhost:8000/assets/audio/oh-im-really-sorry.mp3
```

第 2 条要能看到 `HTTP/1.1 206 Partial Content` 与 `Content-Range: bytes 1000-1999/1602297`（`1602297` 是当前这个音频文件的总字节数）。
如果看到的是 `200`，说明你用的服务器不是 `dev-server.js`，跳播功能一定不工作。

## 六、目录结构

```
vibe-coding-30days/
├─ index.html          首页（三个板块入口）
├─ reader.html         文本跟读页（F2 复读机）
├─ vocab.html          词汇速记页（F4，列表）
├─ writing.html        作文模板页（F5，列表）
├─ dev-server.js       本地服务器（支持 Range）
├─ AGENTS.md           项目规则（AI 协作的行为边界，先读这份）
├─ PRD.md              产品需求（做什么、不做什么）
├─ TECH_DESIGN.md      技术方案（怎么实现）
├─ research.md         需求研究（为什么这么定）
├─ user-story.md       用户故事（复读机 / 分段点播）
├─ USER_TEST.md        （Day 14）真人测试记录：怎么测的、测出什么、卡在哪
├─ MOBILE_FIX.md       （Day 14）手机端两处问题的诊断与修复（点卡片卡顿 / 返回后空白）
├─ RUN.md              本文件（怎么跑起来、怎么自验）
├─ data/
│   ├─ boards.json     首页三个板块的卡片数据（标题 / 说明 / 状态 / 链接）
│   ├─ materials.json  素材清单（含等级 L1 / L2 / L3 与其下的文件）
│   ├─ segments.json   每一句的起止秒数与文本
│   ├─ words.json      词表（词汇速记页读它）
│   └─ templates.json  作文模板清单（现在是空数组，页面会显示空状态）
└─ assets/
    ├─ css/style.css   样式；配色变量集中在文件顶部 :root
    ├─ img/
    │   ├─ logo.png        站点图标（由 <img> 引用）
    │   └─ wordmark.png    站名字形图（由 style.css 以 mask 引用，不是 <img>）
    ├─ js/home.js      首页：读 boards.json 渲染板块卡片；含加载 / 空 / 读取失败三态
    ├─ js/app.js       跟读页：渲染等级目录与文件列表、读素材与逐句文本、加载失败提示
    ├─ js/player.js    播放控制（点句播放 / 进度条跳播 / 单句重复）
    ├─ js/common.js    （Day 13）取数与状态工具：loadJSON / escapeHTML / failureHTML
    ├─ js/list-page.js （Day 13）列表页通用渲染：四种状态在这里收口
    └─ audio/          音频素材
```

> 说明：本机项 `.env` 与 `.workbuddy/` 已被 `.gitignore` 挡在仓库之外，不列入上面的目录树。
>
> 账（Day 13 记）：`home.js` 与 `app.js` 里各留着一份 `loadJSON / escapeHTML / failureHTML` 的旧实现，
> 本轮没有收编进 `common.js` —— 那两个页面已过 PRD 第六节的验收，有意不动，以后顺手再收。
>
> ⚠️ **（Day 23 补注，2026-10-12）上面这笔账已结清。原文保留不删，只加这条标注。**
>
> Day 23 的 `9dcff11`（「统一三类错误提示并补长度校验」）把重复实现收编掉了，实测核对如下：
>
> | 核对项 | 结果 |
> |---|---|
> | `home.js` 自定义 `loadJSON` / `failureHTML` / `escapeHTML` | 已删除（0 处定义） |
> | `app.js` 同上 | 已删除（0 处定义） |
> | `index.html` 引入 `assets/js/common.js` | 已引入 |
> | `reader.html` 引入 `assets/js/common.js` | 已引入 |
> | `common.js` 仍提供这三个函数 | 是（单一来源） |
>
> 所以「各留着一份旧实现」**不再成立**。变更是**收敛不是退步**：原先同一段取数/转义/错误提示逻辑
> 在三处各存一份（改一处会漏另外两处），现在全站只认 `common.js` 一份。
> 三个页面的调用点也一并改成传参形式，例如 `failureHTML(err, '板块列表', 'retry-boards')`。


## 七、后端接口与线上部署（Day 23 补）

### 7.1 两条独立的部署通道 —— 本项目最容易踩的坑

| 东西 | 怎么上线 | 发它的时候，另一个会不会跟着更新 |
|---|---|---|
| 前端静态站 | 用发布流程按目录落位上传文件 | ❌ 不会 |
| 后端云函数 `echoread-api` | **手动**打 zip → 控制台「上传代码包」→ 点「部署」 | ❌ 不会 |

⚠️ **代码提交了 ≠ 线上生效。** 实测（Day 23）：长度校验的代码 `commit 9dcff11` 早就提交了，
但云函数没重新部署，线上照样放行超长字段。同一次请求、两种表现：

```
POST /api/words  {"id":"<72 个字符>"}
  旧版（未重部署）  →  201  {"ok":true}              ← 悄悄收下了
  新版（已重部署）  →  400  字段过长：词条 id（id）太长（最多 64 个字符，当前 72 个）
```

**结论：改完 `cloudfunctions/` 下任何东西，必须单独重新部署一次云函数。只发前端 = 后端一个字都没变。**

### 7.2 怎么打包云函数

zip 解压后必须**直接是函数根目录**（不能再套一层文件夹），共 5 个文件：

```
index.js
package.json
lib/rdb.js
repositories/boards.repo.js
repositories/words.repo.js
```

⚠️ 本机**没有 `zip` 命令**；PowerShell `Compress-Archive` 曾静默失败、`Add-Type` 被安全策略拦
→ 改用 **Python `zipfile`** 或 **Node 自写打包**。

打完**别只信自己的打包脚本**，要独立验两道：
① Windows 自带 `tar.exe -tvf <zip>` 列清单；② 解到临时目录跟源码 `diff -r`（应当**零差异**）。

### 7.3 跨域（CORS）：哪些来源在白名单里（Day 23 实测）

机制 ＝ CloudBase「环境配置 → 安全来源（Web 安全域名白名单）」＋ HTTP 网关跨域校验：
**白名单内 → 网关自动补 `Access-Control-Allow-Origin`（只回显自身，不给 `*`）；白名单外 → 一张跨域头都没有。**

| 请求头 `Origin` | 跨域头 |
|---|---|
| `https://echoread.app.workbuddy.host`（发布站点在用） | ❌ **没有** |
| `https://echoread-d0g1b2ez6a369d11e-1502538433.tcloudbaseapp.com` | ✅ 有 |
| `http://localhost:8000` / `http://localhost:8080` | ✅ 有 |
| `https://evil.example.com` | ❌ 没有（正确：不给 `*`） |

⇒ **修法**：控制台「环境配置 → 安全来源」把 `https://echoread.app.workbuddy.host` 加进去 —— **不用改任何代码**。
加之前，浏览器里从发布站点调接口会被拦（页面显示「网络连不上」）；
但**服务端直连不受影响**（curl / Node 都正常），所以「接口坏了」和「跨域被拦」要先分清楚。

排查口诀（cmd 里跑，`findstr` 是 cmd 的搜索工具，不是 `grep`）：

```
curl -s -D - -o /dev/null -H "Origin: <页面域名>" <接口地址> | findstr /i "access-control"
```

有头 ＝ 服务器放行；无头 ＝ 没放行。

> ⚠️ **（Day 24 补注，2026-10-12）上面这段的"修法"已实测复现，但【尚未执行】。原文保留不删，只加本条标注。**
>
> Day 24 把这条从"听说过"升级成"有完整证据"（含**预检 OPTIONS** 那一条，Day 23 没测）：
>
> | 请求 | 发布站点域名 | localhost:8000（对照） |
> |---|---|---|
> | `GET /api/health` 带 `Origin` | 200 但**无任何 `access-control-*` 头**、无 `vary` | ✅ 有 `allow-origin` + `vary: Origin` |
> | `OPTIONS /api/words` 预检（`ACRM: POST`） | **405**（`content-length: 100`）—— 网关把预检**透传给了云函数** | ✅ **204** + `allow-methods: POST` —— 网关自己答的 |
>
> ⇒ **网关对白名单外的来源连预检都不应答**，任它掉进云函数撞 405。
> ⇒ 这也解释了为什么界面报的是「网络连不上」而不是 405：浏览器在**预检阶段**就判不通过，
>    `fetch` 直接 reject，JS 根本拿不到那个 405。**`check.js` 的提示是如实反映，不是文案写错。**
>
> ⚠️ 附带纠正一条容易误解的事：**curl 全绿 ≠ 线上可用**。curl 不发预检、不校验 CORS 头，
> 所以从 Day 17 到今天所有 curl 命令一路绿灯，唯独浏览器不通 ——
> 「接口坏了」和「跨域被拦」靠 curl 永远分不出来。
>
> ⚠️⚠️ **补一条会让上面那句"修法"白填一轮的坑：填进去的域名【不要带 `http://` 或 `https://` 前缀】。**
>
> 本节（Day 23 原文）写的是「把 `https://echoread.app.workbuddy.host` 加进去」——
> 那个带协议的形态是**给 curl 的 `Origin` 头用的**，**不是控制台该填的**。原文保留不删，这里只作纠正：
>
> | 场合 | 正确形态 | 理由 |
> |---|---|---|
> | 控制台「安全域名」填写 | `echoread.app.workbuddy.host`（**裸域名**） | 官方示例全是裸域名；CLI 文档明写"不含 `http://` 或 `https://` 前缀"。存的是裸域名，网关按 host 比对，**回显时才补回完整 Origin** |
> | curl / 脚本的 `Origin` 请求头 | `https://echoread.app.workbuddy.host`（**带协议**） | `Origin` 的规范形态就是 `scheme://host` |
>
> 实证：默认列表里存的是裸 `localhost`，而实测它对 `http://localhost:8000` 放行、回显的就是带协议带端口的完整 Origin。
>
> **另一条旁证 —— 白名单里其实只有 4 个官方默认项**（`localhost` / HTTP 网关域名 / 静态托管域名 / 文件存储域名），
> 本次实测放行的正是前三个中的两个。`echoread.app.workbuddy.host` 是发布平台给的自定义域名，
> **三个默认项里没有它 ⇒ 从来没人加过** —— 根因到此闭环。
> 官方文档：安全来源 <https://docs.cloudbase.net/envconfig/security/intro> ｜ HTTP 访问服务·跨域设置 <https://cloud.tencent.com/document/product/876/130728>
>
> **状态：复现已完成，修复待手动执行。** 完整证据与前后对照见根目录 `CORS_FIX.md`。

### 7.4 线上回归脚本

```
cd /d <仓库路径>
node skills\frontend-guidelines\scripts\verify-day23-live.cjs
```

10 项断言（反例必须被拦 / 边界 64 过、65 拦 / 正例不被误伤 / 库容复核），**自己清理测试数据**，退出码 0 或 1。
该脚本做过反向验证（拿一个故意模仿旧版行为的假服务器当对照组，必须大面积 FAIL），不是永远亮绿灯的橡皮章。

> ⚠️ **（Day 25 补注，2026-10-12）上面那条路径已失效 —— 脚本被收编了。原文保留不删，只加本条标注。**
>
> `verify-day23-live.cjs` 已并入发布前检查 Skill，旧文件删除，检查逻辑只有一份实现。
> 换路径即可，用法不变：
>
> | 场合 | 现在的命令 |
> |---|---|
> | 对应本节的长度校验 / 边界 / 库容复核 | `node skills\verify-project\scripts\check-online.mjs`（默认只读） |
> | 真要写入库再清理（原脚本就是这么干的） | `node skills\verify-project\scripts\check-online.mjs --write` |
> | 顺带把密钥 / 发布包那几组也一起查 | `node skills\verify-project\scripts\check-offline.mjs` |
>
> 承接的检查项：D3 / D4 / D6 + E1 / E2。去向总表见
> `skills/verify-project/SKILL.md` 末节与 `skills/frontend-guidelines/scripts/README.md`。

### 7.5 跨域（CORS）回归脚本（Day 24 新增）

```
cd /d <仓库路径>
node skills\frontend-guidelines\scripts\verify-day24-cors.cjs
```

8 项断言，**只读**（不写库、不造数据、无需清理）：

| 组 | 断言 | 作用 |
|---|---|---|
| 1（3 条） | 发布站点域名带 `Origin` 打 `GET` / `OPTIONS` 预检 / `GET /api/words` | 本次的靶子；**修好之前必然是 FAIL** |
| 2（2 条） | `localhost:8000` 与内置域名必须继续放行 | 防"修一个坏一个" |
| 3（1 条） | `https://evil.example.com` 必须仍拿不到跨域头 | 防"白名单被改松"（比原 Bug 更严重） |
| 4（2 条） | 不带 `Origin` 打接口，确认**接口本体**是活的 | 把"跨域被拦"和"接口坏了"分开 |

退出码 0 / 1。可覆盖地址：`ECHOREAD_API`、`ECHOREAD_SITE`。

⚠️ 这个脚本的反向验证是**最硬的一种**：改前跑就是 5 PASS / 3 FAIL（红的全在第 1 组），
加完白名单再跑应变成 8 PASS / 0 FAIL —— **这个"红→绿"的差值，就是修复生效的铁证**。

> ⚠️ **（Day 25 补注，2026-10-12）上面那条路径已失效 —— 脚本被收编了。原文保留不删，只加本条标注。**
>
> `verify-day24-cors.cjs` 已并入发布前检查 Skill，旧文件删除。换路径即可，8 项断言一条没少
> （C1 ~ C5，含「白名单外必须仍被拒」那条防改松的）：
>
> ```
> node skills\verify-project\scripts\check-online.mjs
> ```
>
> 界面地址仍可用 `ECHOREAD_API` / `ECHOREAD_SITE` 覆盖。自带的提示语也一起搬过去了 ——
> 若 FAIL 全落在「发布站点」相关项、而对照组全过，脚本末尾会直接打印该往控制台填什么域名。

