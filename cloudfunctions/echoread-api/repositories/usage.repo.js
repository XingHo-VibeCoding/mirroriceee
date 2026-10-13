/* ============================================
   repositories/usage.repo.js —— usage_totals 表的数据访问（Day 28）

   一表一份文件是 Day 19 定下的规矩（words / auth 各一份）。
   这张表只干一件事：记住"每个人复读了多少秒"。

   ⚠️ 分工不变：这里只回答「这张表怎么读、怎么写」；
      "秒数合不合法 / 谁在请求 / 封顶怎么算" 都是接口层的事，一点不挪。
   ⚠️ 表名只允许【代码里写死的常量】（lib/rdb.js 那条铁律继续生效）。
   ============================================ */

var rdb = require('../lib/rdb');

/* ---------------------------------------------------------------------------
   usage_totals 表
   --------------------------------------------------------------------------- */

/* 读一个人的累计记录（心跳时用它算"加完是多少"、并拿 last_beat_at 做封顶）。
   空数组 = 这人还没上报过（第一次心跳走插入分支）。 */
async function findTotalByUserId(userId) {
  return rdb.rdbSelect(
    'usage_totals',
    'user_id,total_seconds,last_beat_at',
    'user_id.asc',
    [['user_id', String(userId)]]
  );
}

/* 建第一行（这人第一次上报）。row = { user_id, total_seconds, last_beat_at, updated_at } */
async function createTotal(row) {
  return rdb.rdbInsert('usage_totals', row);
}

/* 更新累计值。
   ⚠️ 这是「读-改-写」的写那一步：接口层先读出来、加上本次秒数、再整行写回。
      并发丢更新的窗口极小（同一账号同时两个设备），已在校验层用 last_beat_at 封顶，
      真出现多设备再把方案换成库内自增（见 db/schema-usage.sql 末尾说明）。 */
async function updateTotal(userId, patch) {
  return rdb.rdbUpdate('usage_totals', patch, [['user_id', String(userId)]]);
}

/* 排行榜：按累计秒数倒序取前 N 名。
   ⚠️ 第二排序键必须带上 user_id —— total_seconds 打平时，没有第二键的排序
      在不同请求间可能给出不同顺序，榜单会"自己抖动"（同一分数忽前忽后）。 */
async function listTopTotals(limit) {
  return rdb.rdbSelect(
    'usage_totals',
    'user_id,total_seconds',
    'total_seconds.desc,user_id.asc',
    [],
    limit
  );
}

/* 排行榜要显示名字：把 users 表整份取回来（只两列），在接口层拼起来。
   ⚠️ 为什么不按 id 一条条查：网关的过滤只支持等值，查 20 个人就是 20 次请求，
      3 秒超时下这是自寻死路；一次取回、内存里查表才稳。
      学校场景（几十到几百人）这份数据很小；真到几万人再改成"随榜取名字"。 */
async function listAllUsersBrief() {
  return rdb.rdbSelect('users', 'id,username', 'id.asc', []);
}

module.exports = {
  findTotalByUserId: findTotalByUserId,
  createTotal: createTotal,
  updateTotal: updateTotal,
  listTopTotals: listTopTotals,
  listAllUsersBrief: listAllUsersBrief
};
