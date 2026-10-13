/* ============================================================================
   echoread · 学习时长表（schema-usage.sql）—— Day 28 增量脚本
   ----------------------------------------------------------------------------
   归属：Day 28 学习时长排行榜 ① 建表
   数据库：腾讯云 CloudBase · PostgreSQL（PG 模式）
   在哪儿执行：控制台 → 数据库 → SQL 编辑器（整份粘进去，一次执行）

   ⚠️⚠️ 跟 schema-auth.sql 同一个规矩：只 CREATE IF NOT EXISTS，永不 DROP。
      schema.sql 那份开头会 DROP 掉 6 张旧表再重建（"重跑=清库"），
      库里现在是真数据，谁手滑谁赔。这份脚本跑多少遍都安全。

   ⚠️ 为什么是"每人一行累计"，不是"每心跳一行流水"：
      云函数执行超时锁死 3 秒，而排行榜要在一次请求里出结果。
      流水表（每次心跳插一行）到几十人规模就会长成几万行，
      每次榜单都要把全表拉回来求和 → 撞 3 秒天花板，直接崩。
      一人一行则：读到就是结果，排行榜 = 按 total_seconds 倒序取前 N，一次查询搞定。
      代价：累计值是"读-改-写"出来的，理论上并发丢更新（同一账号同时开两个设备）。
      学校场景下这个窗口极小、丢的也就是一个心跳周期，可接受。
      （真要做到严格不丢，得上 PG 函数在库内做 UPDATE ... SET x = x + n，
        那需要把函数暴露给网关的 RPC 通道 —— 等真出现多设备并发再谈。）
   ============================================================================ */

/* ---------------------------------------------------------------------------
   1. usage_totals —— 每个账号一行的复读时长累计
   --------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS usage_totals (
  user_id        bigint      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  /* 累计复读秒数。integer 上限约 21 亿秒 ≈ 68 年，一个人一辈子也刷不满 */
  total_seconds  integer     NOT NULL DEFAULT 0,
  /* 上一次心跳的时刻。服务端靠它算"距上次上报过了多久"，
     用来给本次可接受的秒数封顶（防手改请求刷时长） */
  last_beat_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

/* 排行榜是「按 total_seconds 倒序取前 N」，给它建索引。
   ⚠️ DESC 要写出来 —— 默认索引按升序排，倒序查询用不上它。 */
CREATE INDEX IF NOT EXISTS idx_usage_totals_total
  ON usage_totals (total_seconds DESC);

/* 迁移说明（如果这张表以后要加列，照这个格式追加，不要改上面）：
   ALTER TABLE usage_totals ADD COLUMN IF NOT EXISTS xxx ...; */
