/* ============================================================================
   echoread · 建表脚本（schema.sql）
   ----------------------------------------------------------------------------
   归属：Day 16（第 3 周）② 建表
   依据：api-contract.md 第二节「数据模型（PostgreSQL）」
   数据库：腾讯云 CloudBase · PostgreSQL（PG 模式）
   在哪儿执行：控制台 → 数据库 → SQL 编辑器（整份粘进去，一次执行）

   这份脚本只干一件事：把 6 张表建出来
   （主键 / 外键 / 唯一约束 / 检查约束 / 索引）。
   灌数据是 seed.sql 的活儿 —— 分开两份，是为了「结构」和「内容」各自能重跑。

   ⚠️ 可重复执行（今天清单的硬要求）
      开头先把 6 张旧表全删掉再重建，所以反复跑不会报 "already exists"。
      代价：**表里的旧数据会一起没**。今天表里只有种子数据，随便跑；
      将来上了真数据再跑这份脚本，等于清库，要先想清楚。
   ============================================================================ */


/* ---------------------------------------------------------------------------
   0. 先删旧表
      顺序：先子表、后父表（其实 CASCADE 会自动处理依赖，这里只是让阅读顺序
      跟上依赖方向）。CASCADE = 连同依赖它的对象（这里是外键）一起删。
   --------------------------------------------------------------------------- */
DROP TABLE IF EXISTS segments  CASCADE;
DROP TABLE IF EXISTS materials CASCADE;
DROP TABLE IF EXISTS levels    CASCADE;
DROP TABLE IF EXISTS words     CASCADE;
DROP TABLE IF EXISTS templates CASCADE;
DROP TABLE IF EXISTS boards    CASCADE;


/* ---------------------------------------------------------------------------
   1. levels —— 等级目录（L1 / L2 / L3）
      来源：data/materials.json 的 levels 数组
      code 直接当主键：L1 本身就是唯一标识，再另编一个数字 id 是多余的。
   --------------------------------------------------------------------------- */
CREATE TABLE levels (
  code       TEXT    PRIMARY KEY,           -- 等级代码：L1 / L2 / L3
  title      TEXT,                          -- 展示名（现在还没有，先留位置）
  sort_order INTEGER NOT NULL DEFAULT 0     -- 目录里的先后顺序，小的排前面
);


/* ---------------------------------------------------------------------------
   2. materials —— 素材（课文）清单
      来源：data/materials.json 的 materials 数组
      id 用可读短名（如 oh-im-really-sorry），不用自增数字：
      它会直接出现在接口地址里（/api/materials/{id}/segments），可读的名字更好认。
   --------------------------------------------------------------------------- */
CREATE TABLE materials (
  id         TEXT    PRIMARY KEY,           -- 素材 id，如 oh-im-really-sorry
  level_code TEXT    NOT NULL,              -- 这条素材属于哪一级
  title      TEXT    NOT NULL,              -- 标题，如 Oh, I'm really sorry
  audio_path TEXT    NOT NULL,              -- 音频文件路径，如 assets/audio/xxx.mp3
  sort_order INTEGER NOT NULL DEFAULT 0,    -- 同级内的排序

  -- 外键：level_code 必须在 levels.code 里存在
  -- ON DELETE RESTRICT：这个等级下面还挂着素材时，不许直接删等级
  --                    （挡住「顺手删个等级、结果课文全没了」）
  -- ON UPDATE CASCADE：等级代码改名时跟着改（如 L1 → L1A）
  CONSTRAINT fk_materials_level
    FOREIGN KEY (level_code) REFERENCES levels (code)
    ON DELETE RESTRICT ON UPDATE CASCADE
);


/* ---------------------------------------------------------------------------
   3. segments —— 句子 ↔ 音频时间戳
      来源：data/segments.json
      这是「跟读（复读机）」的核心数据：没它，「点某一句只播这一句」就不成立。

      为什么单独一张表：一条素材下面挂多句（一对多），所以拆出来。
   --------------------------------------------------------------------------- */
CREATE TABLE segments (
  id          BIGSERIAL    PRIMARY KEY,     -- 自增主键；BIGSERIAL = 64 位整数 + 自动递增的序列
  material_id TEXT         NOT NULL,        -- 属于哪条素材（外键）
  idx         INTEGER      NOT NULL,        -- 第几句，**从 0 起**（与 data/segments.json 一致）
  start_sec   NUMERIC(8,3) NOT NULL,        -- 起点（秒）；8 位有效数字、留 3 位小数
  end_sec     NUMERIC(8,3) NOT NULL,        -- 终点（秒）
  text        TEXT         NOT NULL,        -- 这一句的原文

  -- 外键：素材一删，它下面的句子跟着删（ON DELETE CASCADE）
  CONSTRAINT fk_segments_material
    FOREIGN KEY (material_id) REFERENCES materials (id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- 唯一约束：同一条素材里句号不许重复（否则「第 3 句」会有两个答案）
  --   顺带把「按素材取全部句子」的索引也解决了 —— 唯一约束自带一个
  --   (material_id, idx) 索引，够用；契约里另外列的那个同名索引是重复的，没建。
  CONSTRAINT uq_segments_material_idx UNIQUE (material_id, idx),

  -- 检查约束：终点必须晚于起点（挡掉 18 → 6 这种倒着写的数据）
  CONSTRAINT ck_segments_time_order CHECK (end_sec > start_sec)
);


/* ---------------------------------------------------------------------------
   4. words —— 词表
      来源：data/words.json

      ⚠️ 列名和接口返回的字段名**故意不一样**（api-contract 第三节 6 号接口那个坑）：
          数据库列：  word   / meaning / unit_tag
          接口 JSON： title  / desc    / tag
      转换在 Day 17 的接口层做，前端渲染代码一行不改。
   --------------------------------------------------------------------------- */
CREATE TABLE words (
  id         TEXT    PRIMARY KEY,           -- 词条 id，如 w-abandon
  word       TEXT    NOT NULL,              -- 单词本身，如 abandon
  meaning    TEXT    NOT NULL,              -- 中文释义，如 v. 放弃；抛弃
  unit_tag   TEXT,                          -- 课程单元，如 Unit 1（可空）
  sort_order INTEGER NOT NULL DEFAULT 0     -- 排序
);


/* ---------------------------------------------------------------------------
   5. templates —— 作文模板
      来源：data/templates.json（**本期是空清单**：templates: []）

      空表是正常状态，不是出错：接口返回空数组，页面显示「作文模板还没有内容。」

      ⚠️ 列名由契约的 desc 改成了 description ——
          DESC 是 PostgreSQL 的**保留关键字**（排序用的 ORDER BY ... DESC），
          拿它当列名，建表语句会直接语法报错、跑不起来，所以必须改名。
          接口返回给前端的字段名**仍然是 desc**（映射在接口层做），前端不受影响。
   --------------------------------------------------------------------------- */
CREATE TABLE templates (
  id          TEXT    PRIMARY KEY,          -- 模板 id，如 t-argument-01
  title       TEXT    NOT NULL,             -- 模板名
  description TEXT,                         -- 列表里的一句话说明（原契约叫 desc，见上）
  body        TEXT,                         -- 正文全文（「单篇查看」用；该页面本期未做）
  unit_tag    TEXT,                         -- 课程单元
  sort_order  INTEGER NOT NULL DEFAULT 0    -- 排序
);


/* ---------------------------------------------------------------------------
   6. boards —— 首页板块入口
      来源：data/boards.json（固定 3 条：reader / vocab / writing）
      Day 15 拍板入表：以后加第四个板块，只插数据、不改代码、不用重新发布。
      代价：多一张表。
   --------------------------------------------------------------------------- */
CREATE TABLE boards (
  id          TEXT    PRIMARY KEY,          -- reader / vocab / writing
  title       TEXT    NOT NULL,             -- 卡片标题
  description TEXT,                         -- 卡片说明（原契约叫 desc，同上）
  status      TEXT    NOT NULL,             -- available（可用）/ wip（开发中）
  href        TEXT,                         -- 点击跳转的页面，如 reader.html
  sort_order  INTEGER NOT NULL DEFAULT 0,   -- 卡片顺序

  -- 检查约束：status 只允许这两个值
  --   （拼错了当场被拦下，而不是等前端渲染出一张空白卡片才发现）
  CONSTRAINT ck_boards_status CHECK (status IN ('available', 'wip'))
);


/* ---------------------------------------------------------------------------
   7. 字段注释（Day 16 余力加练）
      干什么：把「这一列是干嘛的」写进**数据库自己**，而不是只写在脚本的 -- 注释里。

      为什么不直接用 -- 注释 —— 两者不是一回事：
        · `--` 注释只活在这个 .sql 文件里。谁拿着库、没拿这个文件，就看不到。
        · `COMMENT ON` 是**数据库里的元数据**：控制台「数据表 → 字段」能看到，
          也能用 `SELECT ... FROM information_schema.columns` 查出来。
          Day 17 写接口时不用来回翻脚本猜字段含义。

      可重复执行：COMMENT ON 是「覆盖写」，反复跑不报错。
   --------------------------------------------------------------------------- */

-- levels（等级目录）
COMMENT ON TABLE  levels            IS '等级目录（L1 / L2 / L3）；来源 data/materials.json 的 levels 数组';
COMMENT ON COLUMN levels.code       IS '等级代码，主键；取值 L1 / L2 / L3';
COMMENT ON COLUMN levels.title      IS '展示名（当前没有，留位置）';
COMMENT ON COLUMN levels.sort_order IS '目录顺序；数字小的排前面';

-- materials（素材清单）
COMMENT ON TABLE  materials             IS '素材（课文）清单；来源 data/materials.json 的 materials 数组';
COMMENT ON COLUMN materials.id          IS '素材 id，主键；可读短名（如 oh-im-really-sorry），会出现在接口地址里';
COMMENT ON COLUMN materials.level_code  IS '所属等级；外键 → levels.code';
COMMENT ON COLUMN materials.title       IS '课文标题';
COMMENT ON COLUMN materials.audio_path  IS '音频文件相对路径（如 assets/audio/xxx.mp3），相对站点根目录';
COMMENT ON COLUMN materials.sort_order  IS '同级内的排序';

-- segments（句子 ↔ 音频时间戳）
COMMENT ON TABLE  segments             IS '句子与音频时间戳；跟读「点哪句播哪句」的核心数据；来源 data/segments.json';
COMMENT ON COLUMN segments.id          IS '自增主键（BIGSERIAL，由数据库发号）';
COMMENT ON COLUMN segments.material_id IS '所属素材；外键 → materials.id，素材删除时级联删除';
COMMENT ON COLUMN segments.idx         IS '第几句，从 0 起（与 data/segments.json 的 idx 一致）';
COMMENT ON COLUMN segments.start_sec   IS '这一句的起点，单位秒，精确到 0.001 秒';
COMMENT ON COLUMN segments.end_sec     IS '这一句的终点，单位秒';
COMMENT ON COLUMN segments.text        IS '这一句的原文';

-- words（词表）
COMMENT ON TABLE  words            IS '词表；来源 data/words.json';
COMMENT ON COLUMN words.id         IS '词条 id，主键（如 w-abandon）';
COMMENT ON COLUMN words.word       IS '单词本身';
COMMENT ON COLUMN words.meaning    IS '中文释义';
COMMENT ON COLUMN words.unit_tag   IS '课程单元（如 Unit 1），用于筛选；可空';
COMMENT ON COLUMN words.sort_order IS '排序';

-- templates（作文模板）
COMMENT ON TABLE  templates             IS '作文模板；来源 data/templates.json（本期为空清单）';
COMMENT ON COLUMN templates.id          IS '模板 id，主键（如 t-argument-01）';
COMMENT ON COLUMN templates.title       IS '模板名';
COMMENT ON COLUMN templates.description IS '列表里的一句话说明（原契约叫 desc；DESC 是 PG 保留字，故改名）';
COMMENT ON COLUMN templates.body        IS '正文全文；「单篇查看」页用（该页面本期未做）';
COMMENT ON COLUMN templates.unit_tag    IS '课程单元；可空';
COMMENT ON COLUMN templates.sort_order  IS '排序';

-- boards（首页板块入口）
COMMENT ON TABLE  boards             IS '首页板块入口；来源 data/boards.json（固定 3 条）';
COMMENT ON COLUMN boards.id          IS '板块 id：reader / vocab / writing';
COMMENT ON COLUMN boards.title       IS '卡片标题';
COMMENT ON COLUMN boards.description IS '卡片说明（原契约叫 desc，同上）';
COMMENT ON COLUMN boards.status      IS '状态：available（可用）/ wip（开发中）；受 CHECK 约束限制';
COMMENT ON COLUMN boards.href        IS '点击跳转的页面（如 reader.html）';
COMMENT ON COLUMN boards.sort_order  IS '卡片顺序';


/* ---------------------------------------------------------------------------
   8. 自查（可选）
      想当场确认 6 张表都建出来了，就把下面两行前面的 -- 去掉再执行一遍。
      期望：返回 6 行表名。
   --------------------------------------------------------------------------- */
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'public' ORDER BY table_name;
