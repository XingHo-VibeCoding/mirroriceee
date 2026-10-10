/* ============================================================================
   echoread · 种子数据脚本（seed.sql）
   ----------------------------------------------------------------------------
   归属：Day 16（第 3 周）③ 种子脚本
   依赖：**先跑 schema.sql**（表得先存在，否则这里 INSERT 会报 relation does not exist）
   执行处：控制台 → 数据库 → SQL 编辑器（整份粘进去，一次执行）

   这份脚本干两件事，顺序不能反：
     1) 先清空旧数据（TRUNCATE）  —— 保证可重复执行
     2) 再灌入示例数据（INSERT）  —— 保证每次跑完结果一模一样

   ⚠️ 可重复执行（今天清单的硬要求）
      先 TRUNCATE 再 INSERT，所以反复跑不会报「主键重复」，也不会越插越多。
      代价：**表里原有数据会全没**。今天表里只有种子数据，随便跑。
   ============================================================================ */


/* ---------------------------------------------------------------------------
   1. 清空旧数据
      TRUNCATE = 一次性清空整张表（比 DELETE 快，因为它不走逐行删除）。
      RESTART IDENTITY = 把自增序列也归零 ——
        这样 segments.id 每次跑都从 1 开始，结果完全可复现。
      CASCADE = 6 张表之间有外键，一起清，省得挑顺序。
   --------------------------------------------------------------------------- */
TRUNCATE TABLE segments, materials, levels, words, templates, boards
  RESTART IDENTITY CASCADE;


/* ---------------------------------------------------------------------------
   2. levels —— 等级目录（**3 条**）
      来源：data/materials.json 的 levels 数组
      title 插 NULL：契约里写着「现在没有，留个位置」，就不编一个假名字进去。
   --------------------------------------------------------------------------- */
INSERT INTO levels (code, title, sort_order) VALUES
  ('L1', NULL, 1),
  ('L2', NULL, 2),
  ('L3', NULL, 3);


/* ---------------------------------------------------------------------------
   3. materials —— 素材清单（**5 条**）
      第 1 条来自 data/materials.json（原有）；
      后 4 条是 Day 16 新增的真实音频（斌哥提供，已放进 assets/audio/）。

      ⚠️ 两处必须说明的写法：

      ① 文件名的处理
         原始文件名带空格、大写、括号、还有 `(1)` 这种下载副本后缀，
         而文件名去掉 .mp3 就是 id，id 要拼进接口地址
         `/api/materials/{id}/segments` —— 这些字符在 URL 里全是雷。
         所以统一改成「全小写 + 连字符」的短名（slug），音频文件已同步改名。

      ② `I''m` 里为什么是两个单引号
         SQL 用单引号包字符串，字符串**里面**要再出现一个单引号，
         必须写成两个（`''`），否则 SQL 以为字符串提前结束了 —— 当场语法报错。
         Oh, I'm really sorry 里有 I'm，所以写 `I''m`。
   --------------------------------------------------------------------------- */
INSERT INTO materials (id, level_code, title, audio_path, sort_order) VALUES
  ('oh-im-really-sorry',                  'L1', 'Oh, I''m really sorry',
     'assets/audio/oh-im-really-sorry.mp3',                  1),
  ('are-these-pictures-of-you',           'L1', 'Are these pictures of you...',
     'assets/audio/are-these-pictures-of-you.mp3',           2),
  ('that-was-fun',                        'L1', 'That was fun',
     'assets/audio/that-was-fun.mp3',                        3),
  ('where-are-you-from-originally',       'L1', 'Where are you from originally',
     'assets/audio/where-are-you-from-originally.mp3',       4),
  ('you-know-what-i-remember-most-about', 'L1', 'You know what I remember most about...',
     'assets/audio/you-know-what-i-remember-most-about.mp3', 5); 


/* ---------------------------------------------------------------------------
   4. segments —— 句子 ↔ 音频时间戳（**16 条**）
      来源：data/segments.json，全部属于 oh-im-really-sorry。
      id 不写：它是 BIGSERIAL，数据库自己发号（清表时已归零，所以是 1 ~ 16）。

      ⚠️ 新增的那 4 条素材**暂时没有分句数据** ——
         把音频转成「哪一句从第几秒到第几秒」是另一道工序，今天清单里没有，不做。
         所以这里只有 16 行，跟读页点进那 4 条会是空的，**这是有意的，不是坏了**。
   --------------------------------------------------------------------------- */
INSERT INTO segments (material_id, idx, start_sec, end_sec, text) VALUES
  ('oh-im-really-sorry',  0,  0.000,  6.000, 'Oh, I''m really sorry, are you okay?'),
  ('oh-im-really-sorry',  1,  6.000, 10.000, 'I''m fine, but I''m not very good at this.'),
  ('oh-im-really-sorry',  2, 10.000, 11.000, 'Neither am I.'),
  ('oh-im-really-sorry',  3, 11.000, 13.000, 'Say, are you from South America?'),
  ('oh-im-really-sorry',  4, 13.000, 14.000, 'Yes, I am originally.'),
  ('oh-im-really-sorry',  5, 14.000, 16.000, 'I was born in Argentina.'),
  ('oh-im-really-sorry',  6, 16.000, 18.000, 'Did you grow up there?'),
  ('oh-im-really-sorry',  7, 18.000, 23.000, 'Yes, I did, but my family moved here eight years ago when I was in high school.'),
  ('oh-im-really-sorry',  8, 23.000, 25.000, 'And where did you learn to rollerblade?'),
  ('oh-im-really-sorry',  9, 25.000, 26.000, 'Here in the park.'),
  ('oh-im-really-sorry', 10, 26.000, 28.000, 'This is only my second time.'),
  ('oh-im-really-sorry', 11, 29.000, 31.000, 'Well, that''s my first time.'),
  ('oh-im-really-sorry', 12, 31.000, 33.000, 'Can you give me some lessons?'),
  ('oh-im-really-sorry', 13, 33.000, 35.000, 'Sure, just follow me.'),
  ('oh-im-really-sorry', 14, 35.000, 37.000, 'By the way, my name is Ted.'),
  ('oh-im-really-sorry', 15, 37.000, 39.000, 'And I''m Anna, nice to meet you.');


/* ---------------------------------------------------------------------------
   5. words —— 词表（**3 条**）
      来源：data/words.json
      ⚠️ 列名和接口字段名故意不同（api-contract 第三节 6 号接口的坑）：
         数据库列 word / meaning / unit_tag  →  接口 JSON 的 title / desc / tag
         转换在 Day 17 的接口层做，前端一行不改。
   --------------------------------------------------------------------------- */
INSERT INTO words (id, word, meaning, unit_tag, sort_order) VALUES
  ('w-abandon',     'abandon',     'v. 放弃；抛弃',        'Unit 1', 1),
  ('w-efficient',   'efficient',   'adj. 高效的；效率高的', 'Unit 1', 2),
  ('w-responsible', 'responsible', 'adj. 有责任的；负责的', 'Unit 2', 3);


/* ---------------------------------------------------------------------------
   6. templates —— 作文模板（**0 条，故意不插**）
      来源：data/templates.json，本来就是空数组 `templates: []`。

      为什么不补几条凑数 —— 补了就和现状打架：
        · 契约写明「当前是空清单」，接口要返回空数组，页面要显示
          「作文模板还没有内容。」
        · 硬塞几条样例进去，这个空状态就再也演示不出来了，而且那几条是假的。
      空清单不是 404，是正常结果。所以这一段**没有 INSERT，只有这张注释**。
   --------------------------------------------------------------------------- */


/* ---------------------------------------------------------------------------
   7. boards —— 首页板块入口（**3 条**）
      来源：data/boards.json
      status 只允许 available / wip（schema.sql 里有检查约束拦着，写别的会报错）。
   --------------------------------------------------------------------------- */
INSERT INTO boards (id, title, description, status, href, sort_order) VALUES
  ('reader',  '文本跟读', '按句切分，点某一句即播放该句片段', 'available', 'reader.html',  1),
  ('vocab',   '词汇速记', '课程范围内的固定词表',             'available', 'vocab.html',   2),
  ('writing', '作文模板', '课程范围内的模板列表',             'available', 'writing.html', 3);


/* ---------------------------------------------------------------------------
   8. 自查（可选）
      想当场确认每张表灌了几行，就把下面几行前面的 -- 去掉再执行一遍。
      期望结果：levels 3 / materials 5 / segments 16 / words 3 / templates 0 / boards 3
   --------------------------------------------------------------------------- */
-- SELECT 'levels'    AS 表, count(*) AS 行数 FROM levels
-- UNION ALL SELECT 'materials',  count(*) FROM materials
-- UNION ALL SELECT 'segments',   count(*) FROM segments
-- UNION ALL SELECT 'words',      count(*) FROM words
-- UNION ALL SELECT 'templates',  count(*) FROM templates
-- UNION ALL SELECT 'boards',     count(*) FROM boards;
