/* ============================================================================
   echoread · 认证两张表（schema-auth.sql）—— Day 28 增量脚本
   ----------------------------------------------------------------------------
   归属：Day 28 登录后端 ① 建表
   数据库：腾讯云 CloudBase · PostgreSQL（PG 模式）
   在哪儿执行：控制台 → 数据库 → SQL 编辑器（整份粘进去，一次执行）

   ⚠️⚠️ 为什么【单独一份】，不并进 schema.sql：
      schema.sql 开头会 DROP 掉全部 6 张旧表再重建 —— 那是"重跑 = 清库"的脚本，
      当年表里只有种子数据才敢这么写。现在库里是 Living 数据（words 有人真在用），
      谁手滑重跑一次 schema.sql，词条全没。
      认证表是【后来加的】，就用【增量】的方式建：只 CREATE IF NOT EXISTS，
      永不 DROP —— 跑多少遍都安全，已有数据分毫不动。

   ⚠️ 两张表各管一件事：
      users    —— 谁（账号本体，密码只存哈希，永不存明文）
      sessions —— 登录态（一个 token 一行；「退出登录」= 删掉这一行）
      为什么登录态单独一张表而不是塞在 users 上（比如记个 last_token）：
        ① 一个用户可能同时登录手机 + 电脑，各拿各的 token，互不顶掉；
        ② 「退出登录 / 踢下线 / 过期清理」都是【删一行】的事，不碰账号本体。
   ============================================================================ */


/* ---------------------------------------------------------------------------
   1. users —— 账号本体
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS users (
  id            bigserial    PRIMARY KEY,
  username      varchar(20)  NOT NULL UNIQUE,          /* 3~20 位：字母 / 数字 / 下划线（接口层校验，库层唯一约束兜底） */
  password_hash text         NOT NULL,                 /* scrypt 哈希，格式 s1$<盐>$<哈希>（都是十六进制）。⚠️ 永远不存明文 */
  created_at    timestamptz  NOT NULL DEFAULT now()
);

/* ---------------------------------------------------------------------------
   2. sessions —— 登录态
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS sessions (
  token      varchar(64)  PRIMARY KEY,                  /* 32 字节随机数 → 64 位十六进制，长度正好 */
  user_id    bigint       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz  NOT NULL DEFAULT now(),
  expires_at timestamptz  NOT NULL                      /* 过了这一刻，这个 token 作废（接口层比对 now()） */
);

/* 常用的辅助查询：按用户清 token（将来做"踢下线 / 改密码后全端下线"会用到） */
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);


/* ---------------------------------------------------------------------------
   3. 自检 —— 执行完肉眼核对，两行都应该是 CREATE TABLE / CREATE INDEX
   --------------------------------------------------------------------------- */
SELECT 'users 建好了'  AS check WHERE to_regclass('public.users')    IS NOT NULL
UNION ALL
SELECT 'sessions 建好了'     WHERE to_regclass('public.sessions') IS NOT NULL;
