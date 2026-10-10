# API 契约 —— echoread 英语学习工具

> **项目**：echoread（面向机构学生的英语学习网页工具）
> **文档阶段**：Day 15 · 第 3 周｜前后端接口契约（**v1：占位登记**）
> **日期**：2026-10-09
> **依据**：`PRD.md`（Day 4）+ `TECH_DESIGN.md`（Day 5）+ 第 2 周前端四个页面与 `data/*.json`
> **本文档给谁看**：自己（Day 16 建表、Day 17–19 写接口的**唯一依据**）、老师与同学（验收对照物）、AI（写代码时的输入）

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
| `400` | 参数不合法（例如 `level=LX`） |
| `404` | 资源不存在（例如 id 查不到） |
| `405` | 方法不允许（例如用 POST 打只读接口） |
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

**本期无认证。** 所有接口匿名可调（依据 `PRD.md` 3.4：网页改为公开访问，不按人识别）。

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
| 7 | `GET` | `/api/templates` | 作文模板列表 | `writing.html` | 📝 待实现 |
| 8 | `GET` | `/api/templates/{id}` | 单篇模板详情 | `writing.html`（未做） | 📝 待实现 |
| 9 | `GET/POST` | `/api/mastered-words` | 标记「已掌握」 | `vocab.html`（未做） | ⛔ **本期不做**（见第五节） |

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
> `data/boards.json` 换成 `/api/boards`，渲染逻辑一行不改。

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

#### 6. `GET /api/words` ✅ 已实现

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
本期没有用户体系。这条路真要开，得先决定「谁是谁」，那是另一个话题。

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
| v1.2 | 2026-10-10 | Day 17 | 前两个读接口落地上线：`GET /api/boards` 与 `GET /api/words`（含 `?unit=` 筛选）。⚠️ **实现方式与最初设想不同**：原计划用 `pg` 驱动「TCP 直连」数据库，实测本套餐（免费体验版 / 共享集群）既没有内网地址、公网直连又要求「独享集群」的安全组，且 `anon`/`authenticated`/`service_role` 三个角色全是 `NOLOGIN`、根本无法直接登录 —— 遂改为**调 CloudBase PG REST 网关**（`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表>`，头带 `Authorization: Bearer <API Key>`，Key 由云函数环境变量 `CLOUDBASE_API_KEY` 注入，零依赖）。**代价**（如实记）：1.4 节说的「SQL 参数化」在这条路上对应为「用户输入一律 `encodeURIComponent` 后作为查询参数」，防注入的目标不变、形式变了。线上实测：`GET /api/boards` → 200 + 3 条；`GET /api/words?unit=Unit 2` → 200 + 1 条；`POST /api/boards` → 405；未知路径 → 404 |
