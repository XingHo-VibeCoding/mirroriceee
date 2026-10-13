# API 契约 —— echoread 英语学习工具

> **项目**：echoread（面向机构学生的英语学习网页工具）
> **文档阶段**：Day 15 · 第 3 周｜前后端接口契约（~~v1：占位登记~~ → **现已到 v1.7，且 16 个接口全部实现**）
> **日期**：2026-10-09（首版）｜**最近更新：2026-10-13 Day 28（v1.7：认证 + 学习时长）**
> **依据**：`PRD.md`（Day 4）+ `TECH_DESIGN.md`（Day 5）+ 第 2 周前端四个页面与 `data/*.json`
> **本文档给谁看**：自己（Day 16 建表、Day 17–19 写接口的**唯一依据**）、老师与同学（验收对照物）、AI（写代码时的输入）

> ⚠️ **Day 28 提示**：首版登记时 8 个接口只有 1 个实现（health）；现在 **3.1 总览里 16 条全部 ✅**。
> 三处最需要留意的更新：**1.5 认证**（从"无认证"改为 token 会话 + 线上 cookie 通道）、
> **2.1 表清单**（6 张 → 9 张）、**3.2 第 10~16 条**（认证 5 个 + 学习时长 2 个）。

---

## 〇、一句话说明

**这份文档把「前端要向后端要什么」逐条写死**：每个接口的路径、方法、参数、返回长什么样、出错长什么样。

- **Day 15（今天）：只登记，一个都不实现。** 唯一已实现的是 `GET /api/health`。
- **Day 16**：照着第二节建 PostgreSQL 表。
- **Day 17–19**：照着第三节写接口。
- **Day 20**：处理跨域（CORS）。

**为什么先写契约再写代码**：接口一旦写出来，前端就依赖它了。改接口 = 前端跟着改。先把形状谈好，后面几天省的是返工。

---

## 一、通用约定

### 1.1 基地址（Base URL）

| 环境 | 地址 |
|---|---|
| 本期实际（CloudBase 云函数） | `https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com` |

下属所有路径都拼在它后面，例如 `…/api/health`。

> **术语备注**：Base URL —— 所有接口地址共同的「前缀」，像小区门牌号前半段，后面才是各家的房号（路径）。

### 1.2 响应格式

**成功**：**直接返回业务对象**，不套 `{ code, data }` 这种信封。理由：本项目只有一个数据源，套信封只是多剥一层。

**失败**：统一长这样 ——

```json
{
  "ok": false,
  "error": "method_not_allowed",
  "message": "该接口只支持 GET"
}
```

| 字段 | 含义 |
|---|---|
| `error` | **给机器看**的短码（判断用），全小写 + 下划线 |
| `message` | **给人看**的一句中文（直接能显示到页面上） |

> ⚠️ **这不是新规定**：已上线的 `GET /api/health` 用的就是这个格式（用 POST 打它会返回
> `{"ok":false,"error":"method_not_allowed","message":"该接口只支持 GET"}`）。
> **后续所有接口一律对齐它**，不另起一套。

### 1.3 状态码约定

| 码 | 什么时候用 |
|---|---|
| `200` | 请求成功（GET 命中） |
| `201` | 创建成功（POST 写入了一条新记录） |
| `400` | 参数不合法（例如 `level=LX`；缺必填字段） |
| `404` | 资源不存在（例如 id 查不到） |
| `405` | 方法不允许（例如用 PUT 打只读接口） |
| `409` | 冲突（重复提交同一个 id —— 唯一约束撞车） |
| `500` | 服务端出错（数据库连不上等） |

### 1.4 命名与类型约定（**这条最要紧，写错了前端全废**）

| 项 | 约定 | 理由 |
|---|---|---|
| **JSON 字段名** | 一律 **camelCase**（`materialId`） | 与第 2 周的 `data/*.json` **完全一致** —— 前端只换 URL，渲染代码一行不改 |
| **数据库列名** | 一律 **snake_case**（`material_id`） | PostgreSQL 的通行惯例 |
| 两者怎么接 | **在接口层做映射**（Day 17 写代码时转） | 数据库的说法和网页的说法本来就不同，让接口当翻译，两边各自舒服 |
| 时间戳（音频起止） | **秒，浮点数**（`18.0`） | 与 `player.js` 里 `audio.currentTime` 的单位一致，不用换算 |
| 布尔值 | 真 `true` / `false`，不用 `"1"` `"0"` | 免得前端还要再判一次 |

> **术语备注**：camelCase —— 小驼峰命名，如 `materialId`（第一个词小写，后面每个词首字母大写）；
> snake_case —— 蛇形命名，如 `material_id`（全小写、下划线分隔）。两种都是「多个单词拼成一个名字」的写法，只是风格不同。

### 1.5 认证

> **Day 28 更新（原第 15 天的「本期无认证」已被推翻，原文保留见下方墓碑）**

采用 **token 会话**：登录成功拿一个 64 位十六进制的 token，之后每次请求都要带上它。

| 项 | 约定 |
|---|---|
| 请求头 | `Authorization: Bearer <token>` |
| token 长相 | 32 字节随机数的十六进制，**定长 64 位** |
| 有效期 | 30 天（`sessions.expires_at`；过期即失效，服务端会顺手删掉那行） |
| 落库 | `sessions` 表，一行 = 一个登录态；「退出登录」= 删掉那一行 |
| 失败形状 | 一律 `401 { "ok": false, "error": "not_logged_in", ... }` |

**⚠️⚠️ 线上有一条必须知道的额外约定：token 同时放在 cookie 里。**

为什么（实测结论，不是设计洁癖）：线上站点前面多了一层**平台反向代理**，
它会把 `Authorization` 头**替换成它自己的 JWT**（实测：我们发的 64 位 token，
到达站点服务器的是 `Bearer eyJhb…`、长度 395）。症状是"登录成功、之后每次都是未登录"。

所以线上链路是：

```
浏览器  ──(Authorization: 自己的 token + cookie: echoread_token)──▶  平台反向代理
                                                                      │  Authorization 被换成平台 JWT
                                                                      ▼
                                           站点服务器 dev-server.js 的 /api 代理
                                              · cookie 里的 token 优先，覆盖 Authorization
                                              · 平台的 JWT 一律丢弃（不外传给云函数）
                                                                      ▼
                                                        云函数 echoread-api（认 64 位 token）
```

⇒ 对**接口契约**而言：云函数这一侧从未变过（只认 `Authorization: Bearer <64位>`）；
    变化全部发生在"站点自己的代理"里。前端只需保证 **token 同时写进 localStorage 和 cookie**
    （实现见 `app-shell.js` 的 `setToken`，登录页通过 `window.EchoToken.set` 复用同一份实现）。

<details>
<summary>墓碑：Day 15 的原文（已失效，保留以便对照）</summary>

> **本期无认证。** 所有接口匿名可调（依据 `PRD.md` 3.4：网页改为公开访问，不按人识别）。

⚠️ 该结论已被 Day 28 推翻：`PRD.md` 3.4 的前提是"不按人识别"，
而 Day 28 的登录 + 学习时长排行榜**必须按人识别**。改动是**增量**的 ——
老接口（`/api/health`、`/api/boards`、`/api/words`）依然匿名可调，契约一行没动。
</details>

---

## 二、数据模型（PostgreSQL）

> 本节是 Day 16 建表的直接依据。表结构来自第 2 周的 5 份 mock JSON —— **不是凭空设计**，是把已有的数据文件「竖起来」。
>
> **Day 16 已落盘**：建表脚本 `db/schema.sql`、种子数据 `db/seed.sql`（都在仓库根的 `db/` 下，两份都可重复执行）。

### 2.1 表清单

| 表名 | 装什么 | 来自第 2 周的哪份 mock |
|---|---|---|
| `levels` | 等级目录（L1 / L2 / L3） | `data/materials.json` 的 `levels` 数组 |
| `materials` | 素材（课文）清单 | `data/materials.json` 的 `materials` 数组 |
| `segments` | 句子 ↔ 音频时间戳 | `data/segments.json` |
| `words` | 词表 | `data/words.json` |
| `templates` | 作文模板 | `data/templates.json` |
| `boards` | 首页板块入口 | `data/boards.json` |
| `users` | 账号本体（用户名 + 密码哈希） | —— **Day 28 新增**，不是 mock「竖起来」的 |
| `sessions` | 登录态（一行一个 token） | —— **Day 28 新增** |
| `usage_totals` | 每人一行的复读时长累计 | —— **Day 28 新增**（排行榜的依据） |

> **Day 28 的三张新表与前六张不是一回事**：前六张来自第 2 周的 mock JSON，是"把数据文件竖起来"；
> 后三张是**新功能**（登录 / 学习时长）带来的。
> 建表脚本也刻意分开：`db/schema.sql`（六张旧表，**开头会 DROP**，重跑=清库）与
> `db/schema-auth.sql` + `db/schema-usage.sql`（三张新表，**只 CREATE IF NOT EXISTS，永不 DROP**）。
> ⇒ 库里已有真数据之后，能跑的只有后两份。

### 2.2 逐表定义

**`levels` —— 等级目录**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `code` | `TEXT` | **主键** | `L1` / `L2` / `L3` |
| `title` | `TEXT` | 可空 | 展示名（现在没有，留个位置） |
| `sort_order` | `INT` | 非空，默认 0 | 目录里的先后顺序 |

**`materials` —— 素材清单**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | **主键** | 如 `oh-im-really-sorry`（用可读的短名，不用数字自增） |
| `level_code` | `TEXT` | 非空，**外键 → `levels.code`**（`ON DELETE RESTRICT`） | 这条素材属于哪一级 |
| `title` | `TEXT` | 非空 | 如 `Oh, I'm really sorry` |
| `audio_path` | `TEXT` | 非空 | 音频文件路径，如 `assets/audio/oh-im-really-sorry.mp3` |
| `sort_order` | `INT` | 非空，默认 0 | 同级内的排序 |

**`segments` —— 句子与音频时间戳的对齐数据**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `BIGSERIAL` | **主键** | 自增 |
| `material_id` | `TEXT` | 非空，**外键 → `materials.id`，级联删除** | 属于哪条素材 |
| `idx` | `INT` | 非空 | 第几句（**从 0 起**，与 `data/segments.json` 的 `idx` 一致） |
| `start_sec` | `NUMERIC(8,3)` | 非空 | 起点（秒） |
| `end_sec` | `NUMERIC(8,3)` | 非空 | 终点（秒） |
| `text` | `TEXT` | 非空 | 这一句的原文 |
| — | — | **唯一约束 `(material_id, idx)`** | 同一条素材里句号不许重复 |
| — | — | 索引 `(material_id, idx)` **由上一行唯一约束自带，无需重复建** | 按素材取全部句子是最常做的查询 |

**`words` —— 词表**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | **主键** | 如 `w-abandon` |
| `word` | `TEXT` | 非空 | 如 `abandon` |
| `meaning` | `TEXT` | 非空 | 如 `v. 放弃；抛弃` |
| `unit_tag` | `TEXT` | 可空 | 如 `Unit 1`（课程单元，用于筛选） |
| `sort_order` | `INT` | 非空，默认 0 | 排序 |
| `is_deleted` | `BOOL` | 非空，默认 `false` | **软删除标记**（Day 22 余力加练）：`false`=正常，`true`=已"删除"但数据仍在库、可恢复。**所有读接口默认只返回 `false` 的行** |

**`templates` —— 作文模板**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | **主键** | 如 `t-argument-01` |
| `title` | `TEXT` | 非空 | 模板名 |
| `description` | `TEXT` | 可空 | 列表里的一句话说明（**原叫 `desc`**：DESC 是 PostgreSQL 保留关键字，当列名会语法报错） |
| `body` | `TEXT` | 可空 | 正文全文（「单篇查看」用；该页面本期**未做**） |
| `unit_tag` | `TEXT` | 可空 | 课程单元 |
| `sort_order` | `INT` | 非空，默认 0 | 排序 |

**`boards` —— 首页板块入口**

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `TEXT` | **主键** | `reader` / `vocab` / `writing` |
| `title` | `TEXT` | 非空 | 卡片标题 |
| `description` | `TEXT` | 可空 | 卡片说明（**原叫 `desc`**，同上） |
| `status` | `TEXT` | 非空 | `available`（可用）/ `wip`（开发中） |
| `href` | `TEXT` | 可空 | 点击跳转的页面 |
| `sort_order` | `INT` | 非空，默认 0 | 卡片顺序 |

> **决定（2026-10-09 拍板）**：`boards` **入表**。它只有固定 3 条、本是页面导航配置，
> 但入表后与其余 5 张表保持一致的「数据驱动」——以后加第四个板块**不用改代码、不用重新发布**。
> 代价：多一张表。

### 2.3 表间关系

```
levels  1 ──── n  materials  1 ──── n  segments
（一个等级下多条素材）（一条素材下多句）

words / templates / boards   —— 各自独立，不与其他表关联
```

**为什么这样切**：`levels → materials → segments` 是真正的「一对多」关系（一级多条、一条多句），
所以拆三张表；词表、模板、板块之间没有从属关系，各占一张就够。

---

## 三、接口清单

### 3.1 总览

| # | 方法 | 路径 | 用途 | 哪个页面用 | 本期状态 |
|---|---|---|---|---|---|
| 1 | `GET` | `/api/health` | 健康检查 | —（运维/排查） | ✅ **已实现** |
| 2 | `GET` | `/api/boards` | 首页板块列表 | `index.html` | ✅ **已实现** |
| 3 | `GET` | `/api/levels` | 等级目录 | `reader.html` | 📝 待实现 |
| 4 | `GET` | `/api/materials` | 素材列表（可按等级筛） | `reader.html` | 📝 待实现 |
| 5 | `GET` | `/api/materials/{id}/segments` | 某条素材的分句与时间戳 | `reader.html` | 📝 待实现 |
| 6 | `GET` | `/api/words` | 词表列表（可按单元筛） | `vocab.html` | ✅ **已实现** |
| 6 | `POST` | `/api/words` | 新增一条词条（写接口） | `vocab.html`（本期未接线） | ✅ **已实现**（Day 18） |
| 6 | `PATCH` | `/api/words?id=` | 修改一条词条（写接口） | `check.html` 检查台 | ✅ **已实现**（Day 22） |
| 6 | `DELETE` | `/api/words?id=` | 删除一条词条（写接口，**软删**） | `check.html` 检查台 | ✅ **已实现**（Day 22） |
| 7 | `GET` | `/api/templates` | 作文模板列表 | `writing.html` | 📝 待实现 |
| 8 | `GET` | `/api/templates/{id}` | 单篇模板详情 | `writing.html`（未做） | 📝 待实现 |
| 9 | `GET/POST` | `/api/mastered-words` | 标记「已掌握」 | `vocab.html`（未做） | ⛔ **本期不做**（见第五节） |
| 10 | `GET` | `/api/auth/captcha` | 取一张图形验证码（注册用） | `login.html` | ✅ **已实现**（Day 28） |
| 11 | `POST` | `/api/auth/register` | 注册（需验证码） | `login.html` | ✅ **已实现**（Day 28） |
| 12 | `POST` | `/api/auth/login` | 登录，换 token | `login.html` | ✅ **已实现**（Day 28） |
| 13 | `GET` | `/api/auth/me` | token 换"我是谁" | 右栏账号卡（全站） | ✅ **已实现**（Day 28） |
| 14 | `POST` | `/api/auth/logout` | 退出登录（作废 token） | 右栏账号卡 | ✅ **已实现**（Day 28） |
| 15 | `POST` | `/api/usage/beat` | 上报一段复读时长 | 跟读页（后台心跳） | ✅ **已实现**（Day 28 晚） |
| 16 | `GET` | `/api/usage/leaderboard` | 学习时长榜（前 N + 我的名次） | 右栏账号卡 | ✅ **已实现**（Day 28 晚） |

> **10~16 是 Day 28 一天内加完的**（上午认证、晚上学习时长），全部走认证规则（见 1.5）。
> ⚠️ **老的 1~9 一个都没动**：新增接口只往路由表里加行，不改已有路径/字段/错误码 —— 契约冻结照旧。

> **共同的读接口在哪儿**：第 2、3、4、6、7 条都是「**读一份清单**」——这正是任务清单里点名的
> 「别忘了列表读取接口」。少了它，页面就只能靠 mock 数据活着。

---

### 3.2 逐个接口

#### 1. `GET /api/health` ✅ 已实现

**用途**：确认服务活着。排查问题的第一站。

**请求参数**：无

**响应 200**

```json
{ "ok": true, "service": "echoread" }
```

**错误**

| 码 | 场景 | 响应 |
|---|---|---|
| `405` | 用了 GET / HEAD 以外的方法 | `{ "ok": false, "error": "method_not_allowed", "message": "该接口只支持 GET" }` |

**实测状态**（2026-10-09）：`200` ✓ ；`POST` → `405` ✓

---

#### 2. `GET /api/boards` ✅ 已实现

**用途**：首页三张板块卡片。

**请求参数**：无

**响应 200**

```json
{
  "boards": [
    { "id": "reader",  "title": "文本跟读", "desc": "按句切分，点某一句即播放该句片段", "status": "available", "href": "reader.html"  },
    { "id": "vocab",   "title": "词汇速记", "desc": "课程范围内的固定词表",             "status": "available", "href": "vocab.html"   },
    { "id": "writing", "title": "作文模板", "desc": "课程范围内的模板列表",             "status": "available", "href": "writing.html" }
  ]
}
```

**错误**：无特殊错误（读一张固定表）。

> **形状说明**：与 `data/boards.json` **完全一致**，前端 `home.js` 只需把 `BOARDS_URL` 从
> `data/boards.json` 换成**接口完整地址**（`https://<云函数域名>/api/boards`：页面与接口不在同一
> 域名，写相对路径必 404），渲染逻辑一行不改。

**实测状态**（2026-10-10）：`200` ✓ 返回 3 条，字段为 `desc`（映射生效）✓

---

#### 3. `GET /api/levels` 📝 待实现

**用途**：跟读页顶部的等级目录（L1 / L2 / L3）。

**请求参数**：无

**响应 200**

```json
{ "levels": ["L1", "L2", "L3"] }
```

**错误**：无

> **形状说明**：`levels` 是**字符串数组**（不是对象数组），与 `data/materials.json` 里那个字段一致。

---

#### 4. `GET /api/materials` 📝 待实现

**用途**：跟读页选定等级后的素材（课文）列表。

**请求参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `level` | query | 否 | 按等级筛，取值 `L1` / `L2` / `L3`。**不传 = 返回全部** |
| `audio` | query | 否 | 无（音频路径由后端写入响应，不接受客户端传路径）|

**响应 200**

```json
{
  "materials": [
    {
      "id": "oh-im-really-sorry",
      "level": "L1",
      "title": "Oh, I'm really sorry",
      "audio": "assets/audio/oh-im-really-sorry.mp3"
    }
  ]
}
```

**错误**

| 码 | 场景 | 响应 |
|---|---|---|
| `400` | `level` 不是 L1/L2/L3 | `{ "ok": false, "error": "invalid_level", "message": "等级只能是 L1、L2 或 L3" }` |

> **两个刻意的决定**：
> 1. 字段名用 `level`（不是 `level_code`）—— 与 `data/materials.json` 对齐，前端不改。
> 2. `audio` 返回**相对路径**（`assets/audio/…`），前端在同一个站点下直接能用；
>    将来音频若挪去云存储，这里改成完整 URL 即可，**接口形状不变**。

---

#### 5. `GET /api/materials/{id}/segments` 📝 待实现

**用途**：跟读页的核心数据 —— 某条素材「每句从第几秒到第几秒」。没有它，「点某一句播这一句」就不成立。

**请求参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `id` | 路径 | 是 | 素材 id，如 `oh-im-really-sorry` |

**响应 200**

```json
{
  "materialId": "oh-im-really-sorry",
  "segments": [
    { "idx": 0, "start": 0.0,  "end": 6.0,  "text": "Oh, I'm really sorry, are you okay?" },
    { "idx": 1, "start": 6.0,  "end": 10.0, "text": "I'm fine, but I'm not very good at this." }
  ]
}
```

**错误**

| 码 | 场景 | 响应 |
|---|---|---|
| `404` | 素材 id 不存在 | `{ "ok": false, "error": "material_not_found", "message": "没有找到这条素材" }` |

> **形状说明**：就是 `data/segments.json` 里的**单条元素**（原来是一个数组装所有素材，
> 现在按素材分开取）。`start` / `end` 是秒（浮点），直接喂给 `audio.currentTime`。

---

#### 6. `GET` / `POST` / `PATCH` / `DELETE` `/api/words`

> **`GET`** ✅ 已实现（Day 17）　｜　**`POST`** ✅ 已实现（Day 18）　｜　**`PATCH`** ✅ 已实现（Day 22）　｜　**`DELETE`** ✅ 已实现（Day 22）
> ⇒ 这一个路径（`/api/words`）现在支撑「增（POST）删（DELETE）改（PATCH）查（GET）」四类操作。

**用途**：词汇速记页的词表。

**请求参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `unit` | query | 否 | 按课程单元筛，如 `Unit 1`。**不传 = 全部** |

**响应 200**

```json
{
  "words": [
    { "id": "w-abandon",     "title": "abandon",     "desc": "v. 放弃；抛弃",       "tag": "Unit 1" },
    { "id": "w-efficient",   "title": "efficient",   "desc": "adj. 高效的；效率高的", "tag": "Unit 1" }
  ]
}
```

**错误**：无特殊错误。

> ⚠️ **这里有个容易踩的坑，单独说清**：
> 数据库里的列叫 `word` / `meaning` / `unit_tag`，但**接口返回的字段是 `title` / `desc` / `tag`**。
> 为什么故意不一致 —— 因为 `list-page.js` 渲染列表时读的就是 `title` / `desc` / `tag`
> （它被词汇页和模板页共用，认的是通用字段名）。
> **转换在接口层做**，前端一行不改。要是这里「按数据库的叫法」返回，前端所有列表页当场全空。

**实测状态**（2026-10-10）：`200` ✓ 返回 3 条；`?unit=Unit 2` → 1 条（筛选生效）✓

**`POST /api/words`** —— 新增一条词条 ✅ 已实现（Day 18）

**用途**：往词表里插一条新词。本期**只做接口**，词汇页的「新增」入口未做。

**请求体**（JSON 对象）

| 字段 | 必填 | 对应数据库列 | 说明 |
|---|---|---|---|
| `id` | **是** | `id` | 词条 id，可读短名，如 `w-diligent`。**重复提交同一个 id 会被拒** |
| `title` | **是** | `word` | 单词本身 |
| `desc` | **是** | `meaning` | 中文释义 |
| `tag` | 否 | `unit_tag` | 课程单元，如 `Unit 3`；不传 = 空 |

> **为什么请求体沿用 `title` / `desc` / `tag`**：与 `GET` 响应**完全同形** —— 前端从列表里拿到一个对象，
> 改几个值就能直接提交回去；也让 `list-page.js` 认的字段名在**读写两侧一致**。

**响应 201**

```json
{
  "ok": true,
  "data": { "id": "w-diligent", "title": "diligent", "desc": "adj. 勤奋的", "tag": "Unit 3" }
}
```

> **写接口成功为什么带 `ok`**：读接口的成功形状是"直接给业务对象"，因为返回的就是一组业务数据。
> 写操作没有这种"业务对象"可给（返回的是"写成功"这个结果），而失败形状本来就带 `ok:false` ——
> 写接口成功用 `{ok:true, data}` 与失败**对称**，前端靠一个 `ok` 字段就能判断成败，不必解析 HTTP 状态码。

**错误**

| 码 | error | message（中文，可直接显示到页面上） |
|---|---|---|
| `400` | `invalid_body` | 请求体必须是 JSON 对象 |
| `400` | `missing_field` | 缺少必填字段：单词（title）（缺哪个就写哪个） |
| `400` | `invalid_field` | 字段「单词（title）」必须是非空字符串 |
| `409` | `duplicate_id` | 这个词条 id 已存在，请不要重复提交 |
| `500` | `db_error` | 服务端写入出错，请稍后再试 |

> **防重复怎么做**：不是「先查一次、没有就插」—— 那样两个请求同时查、同时插，照样重复（并发漏洞）。
> 做法是**直接插，让数据库主键拦住**：PostgreSQL 抛唯一约束冲突（SQLSTATE `23505`），
> 云函数把它翻成 `409 duplicate_id`。一次请求解决，天然没有竞态。

> **⚠️ 余力加练（软删除）给这条加了一个岔路**：主键撞车时**先别急着 409** ——
> 先查这个 id **是不是被软删过的**（`is_deleted = true`）：
>
> | 情形 | 处理 | 响应 |
> |---|---|---|
> | id 存在、且 `is_deleted = false`（活的） | 真的重复 | `409 duplicate_id` |
> | id 存在、且 `is_deleted = true`（被软删过） | **复活**：置 `is_deleted = false` + 用新提交的值覆盖字段 | `201 {ok:true, data:{...新值}}` |
> | id 查不到（理论不该发生，因为刚撞了主键） | 兜底当重复 | `409 duplicate_id` |
>
> **为什么必须处理**：软删只是"标记为删"，那一行**还占着主键**。若不特判，
> 用户 POST 同一个 id 会撞 409，困惑于「我明明把它删了啊？」—— 复活让"删了再加回来"真的 work。
> ⚠️ 复活时**字段被新值覆盖**（不是保留旧值）：用户 POST 的是"一条全新的词"，
> 只把标记改回来、留着旧字段，等于骗人。
>
> ⇒ 也就是说：**`POST` 一个 id，最终结果可能是「新建」也可能是「复活」**，两者都返回 `201`。

**实测状态**（Day 18 部署后补，Day 21 复核）：`POST /api/words` → `201` ✓，响应
`{"ok":true,"data":{"id":"w-test-bin","title":"test","desc":"测试","tag":null}}`；
同 id 重复提交 → `409 duplicate_id` ✓（数据库主键拦截生效，无竞态）。

---

**`PATCH /api/words?id=w-xxx`** —— 修改一条词条 ✅ 已实现（Day 22）

**用途**：改一条已存在词条的字段。本期**只做接口**，词汇页的「编辑」入口未做（页面未接线）。

**URL 参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `id` | query | **是** | 改哪一条，如 `w-diligent`。**不存在则回 `404`** |

> ⚠️ **为什么 id 走 query 参数、不走 `/api/words/{id}` 这种路径参数**：
> 路径参数需要动网关的「路径透传」配置（能不能碰就不碰）；
> 而 query 参数与 `GET ?unit=` 是同一套路，网关**一行都不用改**。
> 另外它让请求地址自身可复制 —— 一条 `curl` 就能完整复现这次修改。

**请求体**（JSON 对象）

| 字段 | 必填 | 对应数据库列 | 说明 |
|---|---|---|---|
| `title` | 否 | `word` | 新单词。不传 = 不改这个字段 |
| `desc` | 否 | `meaning` | 新释义。不传 = 不改这个字段 |
| `tag` | 否 | `unit_tag` | 新单元。不传 = 不改；**传空字符串 = 清空该字段（存 `NULL`）** |

> ⚠️ **两个硬规矩**：
> ① **`id` 不在可改字段里** —— 主键是这一行的身份，改主键 = 换了一条记录，那是「先删后插」，不是「修改」。
> ② **至少要给一个可改字段** —— 空 body（`{}`）回 `400 missing_field`，不当作「什么都不改也算成功」。

**响应 200**

```json
{
  "ok": true,
  "data": { "id": "w-diligent", "title": "diligent", "desc": "adj. 勤奋的；用功的", "tag": "Unit 3" }
}
```

> 返回的是**改后**的整行（网关 `Prefer: return=representation` 回显），前端不用再 `GET` 一次。

**错误**

| 码 | error | message（中文，可直接显示到页面上） |
|---|---|---|
| `400` | `missing_id` | 缺少 id 参数：请在地址里带上 ?id=词条id |
| `400` | `invalid_body` | 请求体必须是 JSON 对象 |
| `400` | `missing_field` | 请求体里至少要有一个要改的字段：单词（title）、释义（desc）或单元（tag） |
| `400` | `invalid_field` | 字段「单词（title）」必须是非空字符串 |
| `404` | `word_not_found` | 没有找到 id 为「w-xxx」的词条，无法修改 |
| `409` | `duplicate_id` | 修改后的值与已有记录冲突，请换一个值 |
| `500` | `db_error` | 服务端出错，请稍后再试 |

> **`404` 怎么判定**（不用「先查后改」那种有竞态的写法）：
> PATCH 带 `Prefer: return=representation` 时，网关把「被改的行」回显回来；
> **回显是空数组 = 没有任何一行匹配 = 这个 id 不存在**。一次请求同时完成「做事」和「判存在」，天然无竞态。

---

**`DELETE /api/words?id=w-xxx`** —— 删除一条词条 ✅ 已实现（Day 22）

**用途**：删掉一条已存在的词条。⚠️ **这是软删（soft delete）** —— 接口把 `is_deleted` 置为 `true`，
那一行**仍留在数据库里**，只是从所有读接口的结果中消失（`GET` 不再返回它）。**删错了可以找回**
（把 `is_deleted` 改回 `false` 即"复活"，见下方 POST 子段）。

**URL 参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `id` | query | **是** | 删哪一条，如 `w-diligent`。**不存在则回 `404`** |

**请求体**：无。

**响应 200**

```json
{
  "ok": true,
  "data": { "id": "w-diligent", "title": "diligent", "desc": "adj. 勤奋的；用功的", "tag": "Unit 3" }
}
```

> **为什么删除成功还要把「被删掉的那行」返回**：这是删除操作**唯一**还能拿到「删了什么」的机会 ——
> 删完再 `GET` 就没有它了。前端据此显示「已删除 w-diligent = diligent」，留个据可查。

**错误**

| 码 | error | message（中文，可直接显示到页面上） |
|---|---|---|
| `400` | `missing_id` | 缺少 id 参数：请在地址里带上 ?id=词条id |
| `404` | `word_not_found` | 没有找到 id 为「w-xxx」的词条，无需删除 |
| `500` | `db_error` | 服务端出错，请稍后再试 |

> ⚠️⚠️ **为什么删除必须显式判 `404`（这是本期最要紧的一个坑）**：
> 不带 `Prefer: return=representation` 时，删一个**不存在**的 id，网关同样回成功 ——
> 用户会以为「删掉了」，其实什么都没发生（因为本来就没有）。这正是**理解偏差**的温床。
> 显式判空 → 如实回「没有这条」，才是诚实的接口。

> ⚠️ **不带过滤条件的 DELETE 会清空整张表**：`rdbDelete` / `rdbUpdate` 的 `filters` 都是必给参数，
> 代码层已把这条写进注释，契约层在这里再钉一遍。（当前 DELETE 已改为软删、走 `rdbUpdate`，
> 但"必须带过滤"这条规矩不变。）

> **删除的防护三层**（今天要掌握的「删除为什么比新增更容易出事」）：
> 新增错了 → 多一条，删一次就完了；
> 删除错了 → **少一条，且不容易发现**。
> 所以三层都得有：**接口层**（id 不存在明确回 404，绝不糊弄）＋ **前端**（`check.html` 加 `confirm()` 二次确认）
> ＋ **数据库层**（**软删**：只改 `is_deleted` 标记，数据还在，改回来就复活）。
> ⇒ 第 3 层是 Day 22 余力加练的最大价值：把"删除"从**不可逆**变成**可逆**。

**实测状态**（2026-10-11）：见文末「变更记录 v1.5」；现场验证方法见下节「四类操作闭环自检」。

**软删后的"读"行为**：`GET /api/words` 及其 `?unit=` 筛选**都不返回** `is_deleted=true` 的行
（过滤在 `repositories/words.repo.js` 的 `listWords` 里统一加，接口层不用管）。
⇒ 从页面视角看，"删除"的效果和真删**完全一样**；区别只在数据库里那一行还在不在。

---

**`DELETE` 的姊妹能力：「复活」（Day 22 余力加练）**

软删的一个自然结果是「删了还能加回来」。本接口**没有**单独的"恢复"端点，
而是把复活**融进了 `POST`**（见上方 POST 子段）：POST 一个**曾被软删**的 id 时，
接口会**复活它**（`is_deleted → false` + 用新提交的值覆盖字段），而不是回 `409`。
⇒ 这样"删了再加回来"这个最自然的操作能真的 work，不用额外造一个端点。

---

#### 6-附. 四类操作闭环自检（Day 22）

要亲手确认「增删改查」四类操作都通、且删除真的生效，按下面这条**单变量**流程走一遍即可
（`BASE` 换成你的基地址；用 `w-day22-probe` 这种**专门造的测试 id**，别拿种子数据开刀）：

| 步 | 操作 | 命令（curl） | 期望 |
|---|---|---|---|
| 1 增 | POST 造一条测试词条 | `curl -sS -X POST "$BASE/api/words" -H 'Content-Type: application/json' -d '{"id":"w-day22-probe","title":"probe","desc":"Day22 测试词","tag":"Unit 9"}'` | `201` + `data.id = w-day22-probe` |
| 2 查 | GET 应能见到它 | `curl -sS "$BASE/api/words" \| grep day22-probe` | 命中该行 |
| 3 改 | PATCH 改它的释义 | `curl -sS -X PATCH "$BASE/api/words?id=w-day22-probe" -H 'Content-Type: application/json' -d '{"desc":"改后的释义"}'` | `200` + `data.desc = 改后的释义` |
| 4 查 | GET 应见到**改后的值** | `curl -sS "$BASE/api/words" \| grep day22-probe` | `desc` 已是新值 |
| 5 删 | DELETE 删掉它 | `curl -sS -X DELETE "$BASE/api/words?id=w-day22-probe"` | `200` + `data.id = w-day22-probe` |
| 6 查 | GET **不再返回**它 | `curl -sS "$BASE/api/words" \| grep day22-probe` | **无输出**（这才是删除生效的铁证） |
| 7 反 | 删一个不存在的 id | `curl -sS -X DELETE "$BASE/api/words?id=w-nope-xxx"` | `404` + 中文 `message` |

> **第 6 步是重点**：删除"成功"不看返回码，要看**那条从 GET 里真的消失了**。
> **第 7 步是反向验证**（防"橡皮章"）：接口必须能对**不存在的 id** 明确报错，
> 而不是一律回"成功" —— 只会回成功的接口，等于没有校验。

---

#### 7. `GET /api/templates` 📝 待实现

**用途**：作文模板列表页。

**请求参数**：无

**响应 200**

```json
{
  "templates": [
    { "id": "t-argument-01", "title": "议论文三段式", "desc": "开头表态 · 中间两个理由 · 结尾总结", "tag": "Unit 1" }
  ]
}
```

> **当前是空清单**（`data/templates.json` 里 `templates: []`）—— 返回空数组是**正常结果**，
> 页面会显示「作文模板还没有内容。」（第 2 周已经做好的四种状态之一）。
> 空数组**不是** 404：清单存在、只是暂时没有条目。

**错误**：无

---

#### 8. `GET /api/templates/{id}` 📝 待实现

**用途**：单篇模板查看。**对应的页面本期未做**，此处先登记。

**请求参数**

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `id` | 路径 | 是 | 模板 id |

**响应 200**

```json
{
  "id": "t-argument-01",
  "title": "议论文三段式",
  "body": "第一段：……\n第二段：……",
  "tag": "Unit 1"
}
```

**错误**

| 码 | 场景 | 响应 |
|---|---|---|
| `404` | 模板 id 不存在 | `{ "ok": false, "error": "template_not_found", "message": "没有找到这个模板" }` |

---

#### 9. `GET / POST /api/mastered-words` ⛔ 本期不做（仅登记）

**用途**：F4「词汇速记」的**标记已掌握**功能。

**为什么登记却不做**（依据 `PRD.md` 4.5 与 `TECH_DESIGN.md` 2.3）：

- `PRD.md` 原文只要求「浏览 + 标记已掌握」，**没规定要跨设备**；
- 纯前端用 `localStorage` 就能满足「标记在本机有效」，**不需要后端**；
- **只有**当要求「换手机还能看见」时才需要真接口 —— 而本期不按人识别（`PRD.md` 3.4 已拍板）。

**将来要做的形状（先写在这里，免得重新想）**

```
POST /api/mastered-words
  请求：{ "studentKey": "<匿名标识>", "wordId": "w-abandon" }
  响应 200：{ "ok": true }

GET /api/mastered-words?studentKey=<匿名标识>
  响应 200：{ "wordIds": ["w-abandon", "w-efficient"] }
```

⚠️ 注意 `studentKey` 是**匿名标识**（比如浏览器本地生成的一串随机码），**不是账号** ——
~~本期没有用户体系~~。这条路真要开，得先决定「谁是谁」，那是另一个话题。

> ⚠️ **Day 28 追加**：上面那句"本期没有用户体系"**已经过时**（见 1.5 认证）——
> 现在有 `users` / `sessions` 两张表与 5 个认证接口，**"谁是谁"这件事已经解决了**。
> 所以这个占位接口将来真要做，可以直接用**登录态**代替 `studentKey`（就不必自造匿名标识了）。
> 登记的形状保留原文不删，作为"当时的想法"留痕。

---

#### 10. `GET /api/auth/captcha` ✅ 已实现（Day 28）

**用途**：注册前拿一张图形验证码。`login.html` 注册页用。

**请求参数**：无（**匿名可调**，不需要 token）

**响应 200**

```json
{ "ok": true, "data": { "captchaId": "<签名过的 id>.", "svg": "<svg …>", "expiresInMs": 300000 } }
```

**说明**

- 前端把 `svg` 直接塞进容器显示；用户抄下的码 + `captchaId` 一起交给注册接口。
- ⚠️ **答案只存在于 SVG 图里**：`captchaId` 里只有答案的 HMAC，拿到它也算不出答案。
- 验证码有时效（`expiresInMs`），过期即失效。

**实测状态**：线上 `200` ✓（Day 28 联调）

---

#### 11. `POST /api/auth/register` ✅ 已实现（Day 28）

**用途**：注册新账号。

**请求**（**匿名可调**）

```json
{ "username": "test28_2552", "password": "Passw0rd28!", "captchaId": "<上一步拿到的>", "captchaCode": "ERSQ" }
```

**字段约束**：`username` 3~20 位，只能是字母 / 数字 / 下划线；`password` 8~64 位。

**响应 201**

```json
{ "ok": true, "data": { "id": 1, "username": "test28_2552" } }
```

**错误**

| 码 | 场景 | error |
|---|---|---|
| `400` | 字段不合法（用户名格式 / 密码长度） | `invalid_field` |
| `400` | 验证码不对或过期 | `invalid_captcha` |
| `409` | 用户名已被占用 | `username_taken` |

**实测状态**：线上 `201` ✓；重复用户名 → `409 username_taken` ✓；错验证码 → `400 invalid_captcha` ✓（Day 28）

---

#### 12. `POST /api/auth/login` ✅ 已实现（Day 28）

**用途**：登录，换一个 token。

**请求**（**匿名可调**）

```json
{ "username": "test28_2552", "password": "Passw0rd28!" }
```

**响应 200**

```json
{
  "ok": true,
  "data": {
    "token": "<64 位十六进制>",
    "expiresAt": "2026-11-12T14:43:50.782Z",
    "user": { "id": 1, "username": "test28_2552" }
  }
}
```

**错误**

| 码 | 场景 | error |
|---|---|---|
| `400` | 用户名或密码没填 | `invalid_field` |
| `401` | 用户名或密码不对 | `bad_credentials` |

> ⚠️ **两种失败给同一句话**（`bad_credentials`）是刻意的：区分"用户不存在"与"密码错"
> 等于把"哪些用户名已注册"告诉外人（用户名探测）。

**实测状态**：线上 `200` + token（长度 64）✓；错密码 → `401 bad_credentials` ✓（Day 28）

---

#### 13. `GET /api/auth/me` ✅ 已实现（Day 28）

**用途**：token 换"我是谁"。全站右栏账号卡打开时就调它。

**请求头**：`Authorization: Bearer <token>`

**响应 200**

```json
{ "ok": true, "data": { "user": { "id": 1, "username": "test28_2552" } } }
```

**错误**

| 码 | 场景 | error |
|---|---|---|
| `401` | 没带 token | `not_logged_in` |
| `401` | token 查不到（已退出 / 被清理） | `not_logged_in` |
| `401` | token 已过期 | `token_expired` |

**实测状态**：直连云函数 `200` ✓；线上走站点代理 `200`（cookie 通道，见 1.5）✓（Day 28）

---

#### 14. `POST /api/auth/logout` ✅ 已实现（Day 28）

**用途**：退出登录（作废 token）。请求体为空。

**请求头**：`Authorization: Bearer <token>`

**响应 200**：`{ "ok": true }`

**错误**：`401 not_logged_in`（没带 token）

> ⚠️ **幂等**：token 已经不在了（重复退出）也回 `200` —— 两次退出的结果都是"不在了"，
> 与 `DELETE /api/words` 对已删 id 再删一次的容忍是同一个道理。

**实测状态**：线上 `200` ✓（Day 28）

---

#### 15. `POST /api/usage/beat` ✅ 已实现（Day 28 晚）

**用途**：上报"刚才这一段时间我在复读"，累加到本人名下。

**请求头**：`Authorization: Bearer <token>`

**请求**

```json
{ "seconds": 60 }
```

`seconds` 必须是**正整数**（前端每 60 秒报一次，交整秒，零头留本地）。

**响应 200**

```json
{ "ok": true, "data": { "added": 60, "totalSeconds": 120 } }
```

`added` 是**实际记了多少**，可能与请求值不同（见下方封顶）。

**错误**

| 码 | 场景 | error |
|---|---|---|
| `400` | `seconds` 不是正整数（字符串 / 0 / 负数 / 小数都拒） | `invalid_field` |
| `401` | 未登录 | `not_logged_in` |

**⚠️ 封顶规则（防刷，服务端说了算）**

```
本次最多认：min(180, 距上次上报的秒数 + 90)
```

- 绝对值 180 秒 = 3 个心跳周期（留给"标签页被浏览器节流、心跳迟了两拍"的余量）；
- 只卡绝对值没用 —— 脚本一秒调一次、每次报 180 照样能刷出天文数字，
  所以再加"不能比我实际等的时间多太多"（90 秒补偿网络往返与节流）。
- 封顶后剩 0 秒 → **不写库**，原样返回现状（让重复请求无害）。

**实测状态**（Day 28 晚，公网）：首次报 60 → `added=60, totalSeconds=60` ✓；
紧接着再报 60 → `added=60, totalSeconds=120` ✓；
**报 999999 → `added=91`（被压回）** ✓；
`seconds` 传 `"60"` / `0` / `-5` → 全部 `400 invalid_field` ✓；未登录 → `401` ✓

---

#### 16. `GET /api/usage/leaderboard?limit=5` ✅ 已实现（Day 28 晚）

**用途**：学习时长榜 —— 前 N 名 + 我的名次。右栏「学习时长榜」卡片用。

**请求头**：`Authorization: Bearer <token>`（要看"我的名次"，必须登录）

**参数**：`limit`（可选，默认 `5`，上限 `50`；非法值或超限一律收敛，不报错）

**响应 200**

```json
{
  "ok": true,
  "data": {
    "me":  { "totalSeconds": 291, "rank": 1 },
    "top": [
      { "rank": 1, "username": "test28_2552", "totalSeconds": 291 },
      { "rank": 2, "username": "111", "totalSeconds": 3 }
    ]
  }
}
```

**错误**：`401 not_logged_in`

**⚠️ 三条设计约定**

1. **只回"前 N 名 + 我自己"，不回全榜** —— 前端要的是一眼看懂，少传一份就少泄露一份。
2. **`me.rank` 为 `null` = 榜外**：服务端只往下扫 200 名来找"我"（免费版云函数 3 秒超时锁死，
   为一个名次拉全表不划算）。用户量上来后改成"统计比我高的人数"的计数查询。
3. **前端固定渲染 5 个栏位**（哪怕只有 1 个人）：空位显示「虚位以待 / —」——
   位次本身是信息。名次分档用**颜色 + 字重两路**表达（只靠颜色，色觉差异或黑白屏就读不出来）。

**实测状态**（Day 28 晚，公网）：`200`，`me={totalSeconds:291, rank:1}`，`top[0]={test28_2552, 291}` ✓；
未登录 → `401` ✓；`limit=999999` / `limit=abc` → 均 `200`（内部收敛）✓

---

## 四、前端对接方式（页面 ↔ 接口）

第 2 周的页面读的是**仓库里的静态 JSON**。接上后端之后，改动方式是**只换地址**：

| 页面 | 现在读的文件 | 接后端后改成 |
|---|---|---|
| `index.html` | `data/boards.json` | `GET /api/boards` |
| `reader.html` | `data/materials.json` | `GET /api/levels` + `GET /api/materials?level=L1` |
| `reader.html` | `data/segments.json` | `GET /api/materials/{id}/segments` |
| `vocab.html` | `data/words.json` | `GET /api/words` |
| `writing.html` | `data/templates.json` | `GET /api/templates` |

**改动量**：因为响应形状刻意对齐了现有 mock，前端只需改「请求哪个地址」这一处，
`home.js` / `app.js` / `list-page.js` 的**渲染逻辑不用动**。

> **术语备注**：本节说的「只换地址」，指的是**业务逻辑**不动。实际接线时还要处理
> 「加载中 / 没有结果 / 请求失败」这四种状态 —— 那部分第 2 周已经做完了（见 `PRD.md` 6.7 的 L2）。

---

## 五、本期的边界（做什么 / 不做什么）

**本期做**（Day 16–20）

- ✅ Day 16：按第二节建表 + 灌入现有 mock 数据
- ✅ Day 17–19：按第三节写第 2–8 号接口
- ✅ Day 20：配跨域（CORS），打通前端 → 后端

**本期不做**（以及为什么）

| 不做 | 原因 |
|---|---|
| 真实业务接口（今天） | 今天只登记占位，写代码是 Day 17 起 |
| 数据库建表（今天） | Day 16 做 |
| 跨域配置（今天） | Day 20 做（就在「HTTP 网关」那个页面里） |
| 用户认证 / 按人识别 | `PRD.md` 3.4：公开访问，不需要知道「谁是谁」 |
| 「标记已掌握」（9 号接口） | 本期用 `localStorage` 就够，不足以撑起一张表 |
| 学生上传录音、AI 批改 | `PRD.md` 第五节：本期不做 |

---

## 六、变更记录

| 版本 | 日期 | 阶段 | 改了什么 |
|---|---|---|---|
| v1.0 | 2026-10-09 | Day 15 | 首版落盘：通用约定 + **6 张表**（含 `boards`，同日拍板入表）+ 8 个待实现接口 + 1 个占位接口。今天**只登记、不实现**（已实现的仅 `GET /api/health`） |
| v1.1 | 2026-10-10 | Day 16 | 建表与种子落盘（`db/schema.sql` / `db/seed.sql`，均可重复执行）；契约同步三处：`templates.desc` / `boards.desc` → **`description`**（DESC 是 PG 保留关键字）、`materials.level_code` 外键补 `ON DELETE RESTRICT`、`segments` 同名索引并入唯一约束。线上实测 6 张表建成，行数 3 / 5 / 16 / 3 / 0 / 3 |
| v1.2 | 2026-10-10 | Day 17 | 前两个读接口落地上线：`GET /api/boards` 与 `GET /api/words`（含 `?unit=` 筛选）。⚠️ **实现方式与最初设想不同**：原计划用 `pg` 驱动「TCP 直连」数据库，实测本套餐（免费体验版 / 共享集群）既没有内网地址、公网直连又要求「独享集群」的安全组，且 `anon`/`authenticated`/`service_role` 三个角色全是 `NOLOGIN`、根本无法直接登录 —— 遂改为**调 CloudBase PG REST 网关**（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表>`，头带 `Authorization: Bearer <API Key>`，Key 由云函数环境变量 `CLOUDBASE_API_KEY` 注入，零依赖）。**代价**（如实记）：原方案设想的「SQL 参数化」在这条路上对应为「用户输入一律 `encodeURIComponent` 后作为查询参数」，防注入的目标不变、形式变了。线上实测：`GET /api/boards` → 200 + 3 条；`GET /api/words?unit=Unit 2` → 200 + 1 条；`POST /api/boards` → 405；未知路径 → 404 |
| v1.3 | 2026-10-10 | Day 18 | 新增写接口 `POST /api/words`（登记，代码同日实现）：请求体 `id` / `title` / `desc` / `tag`，前三项必填；成功 `201 {ok:true,data}`（**拍板**：写接口成功一律带 `ok`，与失败形状对称）；重复 id → `409 duplicate_id`（**靠主键唯一约束，非「先查后插」**）；缺必填 → `400 missing_field`（中文写明缺哪一项）。1.3 状态码表补 `201` 与 `409`，并把 405 的过期例子（「用 POST 打只读接口」）改为 PUT |
| v1.4 | 2026-10-11 | Day 22 | 补齐写接口的最后两类，`/api/words` 四类操作闭环：新增 **`PATCH /api/words?id=`**（改一条；可改 `title`/`desc`/`tag`；`id` 不入可改字段；至少给一个字段否则 `400`）与 **`DELETE /api/words?id=`**（**真删**一条）。两者均用网关 `Prefer: return=representation` 回显：**空数组 = id 不存在 → `404 word_not_found`**（不写「先查后改/删」那种竞态写法）。`id` 一律走 query 参数（`?id=`），**不动网关配置**。⚠️ 删除的防护三层：接口层判 404 + 前端 `confirm()` 二次确认 + 本节写明「真删、不可恢复」。同时回填上一版遗留的 `POST` 「实测状态」占位（Day 18 已实测留证，Day 21 复核）。新增「6-附. 四类操作闭环自检」小节（7 步单变量流程，含反向验证）。层内改动：`lib/rdb.js` + `rdbUpdate`/`rdbDelete`、`repositories/words.repo.js` + `updateWord`/`deleteWord`、`index.js` + `patchWords`/`deleteWords` 与路由表扩到四方法、`check.html` + `check.js` 新增第 ④ 区（修改 / 删除 + 二次确认） |
| v1.5 | 2026-10-11 | Day 22（余力加练） | **软删除**落地：`words` 表新增列 **`is_deleted BOOL NOT NULL DEFAULT false`**（2.2 表定义已补）；**`DELETE /api/words?id=` 的语义由「真删」改为「软删」**——只置 `is_deleted=true`，数据留在库、可恢复，但所有读接口默认不返回它（过滤加在 `words.repo.js` 的 `listWords`）。**`POST` 增加「复活」分支**：撞主键时先查是否 `is_deleted=true`，是则复活（清标记 + 覆盖字段）回 `201`，不是才回 `409`。⇒ 删除从**不可逆**变为**可逆**。⚠️ **数据库升级方式**：线上表已有数据，**不能重跑 `schema.sql`（开头 DROP）/ `seed.sql`（开头 TRUNCATE），都会清库**；`db/schema.sql` 末尾新增「9. 增量升级脚本」，只跑一句 `ALTER TABLE words ADD COLUMN IF NOT EXISTS is_deleted ...`（带 `DEFAULT false`，已有行自动补 `false`，一条数据不动）。层内改动：`words.repo.js` + `findWordById`/`softDeleteWord`/`restoreWord`（`listWords` 加过滤）、`index.js` 的 `deleteWords` 改走软删 + `postWords` 加复活分支 |
| v1.6 | 2026-10-13 | Day 28（上午） | **认证体系落地，1.5 节的「本期无认证」作废**（原文以墓碑形式留在 1.5 里）：新增 **5 个认证端点**（captcha / register / login / me / logout，3.1 总览第 10~14 条 + 3.2 逐条登记）；新增两张表 **`users` / `sessions`**（2.1 已补，建表脚本 `db/schema-auth.sql`：**只 CREATE IF NOT EXISTS、永不 DROP**）；密码存 scrypt 哈希（`s1$<盐>$<哈希>`），token 为 64 位十六进制、有效期 30 天。⚠️ **老接口一行没动**：`/api/health` `/api/boards` `/api/words` 全部照旧匿名可调 —— 契约冻结继续生效 |
| v1.7 | 2026-10-13 | Day 28（晚） | **学习时长与排行榜落地**：新增 **2 个端点**（`POST /api/usage/beat`、`GET /api/usage/leaderboard`，3.1 第 15~16 条 + 3.2 逐条登记）；新增一张表 **`usage_totals`**（每人一行累计秒数 + `last_beat_at`，建表脚本 `db/schema-usage.sql`，同样只 CREATE 不 DROP）。口径：**只算音频真正在放的时间**，由前端 60 秒心跳上报，服务端封顶 `min(180, 距上次上报秒数+90)` 防刷。⚠️ **同日线上排障得到一个必须记进契约的事实**（已写进 1.5）：线上站点前的**平台反向代理会把 `Authorization` 头替换成它自己的 JWT**，导致"登录成功但之后每次都是未登录"；修法是 token 同时写进 **cookie**，由站点自己的 `dev-server.js` 代理把 cookie 里的 token **覆盖回** `Authorization`（平台 JWT 一律丢弃、不外传给云函数）。**云函数侧契约零变更**。 |
