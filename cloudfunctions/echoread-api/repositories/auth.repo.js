/* ============================================
   repositories/auth.repo.js —— users / sessions 两张表的数据访问（Day 28）

   一表一份文件是 Day 19 定下的规矩（words / boards 各一份），
   认证加了两张表，但它们干的是同一件事（登录），所以合住一个文件 ——
   拆成 auth.repo + session.repo 各只有三四个函数，反而把"登录"这件事拆散了。
   ⚠️ 分工不变：这里只回答「这两张表怎么读、怎么写、怎么删」；
      密码校验、验证码比对、参数校验都还是接口层的事，一点不挪。

   ⚠️ 表名只允许【代码里写死的常量】—— 'users' / 'sessions' 在下面写死，
      绝不接受任何用户输入（lib/rdb.js 那条铁律在这里继续生效）。
   ============================================ */

var rdb = require('../lib/rdb');

/* ---------------------------------------------------------------------------
   users 表
   --------------------------------------------------------------------------- */

/* 按用户名查账号（登录 / 注册查重都用它）。
   只取这三列 —— ⚠️ 故意不 select=*：
     这是「登录」路径，用不着 created_at；少取一列，少一分"密码哈希被
     不小心带进别处"的风险面。 */
async function findUserByUsername(username) {
  return rdb.rdbSelect(
    'users',
    'id,username,password_hash',
    'id.asc',
    [['username', username]]
  );
}

/* 按 id 查账号（/api/auth/me 用 —— 拿到 token 先查会话，再查人）。
   ⚠️ 同样不取 password_hash：/me 用不着它，凭什么带上它。 */
async function findUserById(id) {
  return rdb.rdbSelect(
    'users',
    'id,username',
    'id.asc',
    [['id', String(id)]]
  );
}

/* 建一个账号。
   ⚠️ row 的键必须是【数据库列名】（username / password_hash）——
      翻译和校验是接口层的事，这里不碰。
   出错就抛；用户名撞了 UNIQUE 约束会带 conflict = true
   （lib/rdb.js 里认 409 / SQLSTATE 23505），接口层据此翻 409。
   这就是「查重 + 唯一约束」的双保险：先查是为了给人话（409 比数据库报错好看），
   约束是防竞态（两个人同一瞬间注册同一个名字，先查后插谁都没查到，照样都插——
   真正拦住第二个的是数据库的唯一约束）。 */
async function createUser(row) {
  return rdb.rdbInsert('users', row);
}

/* ---------------------------------------------------------------------------
   sessions 表
   --------------------------------------------------------------------------- */

/* 写一条登录态。
   row = { token, user_id, expires_at }，expires_at 是 ISO 字符串
   （timestamptz 列，网关直接收 ISO 8601）。 */
async function createSession(row) {
  return rdb.rdbInsert('sessions', row);
}

/* 按 token 查登录态。空数组 = 没这个 token（没登录过 / 已被退出 / 已清理）。 */
async function findSession(token) {
  return rdb.rdbSelect(
    'sessions',
    'token,user_id,expires_at',
    'token.asc',
    [['token', token]]
  );
}

/* 删一条登录态 —— 「退出登录」的全部实现，就这么一行。
   ⚠️ 用的是真删（rdbDelete），不是 words 表那套软删：
      会话记录没有"误删要找回"的需求 —— 它本来就是随时该消失的东西，
      留着一行死会话反而多占一个能被猜的位置。 */
async function deleteSession(token) {
  return rdb.rdbDelete('sessions', [['token', token]]);
}

module.exports = {
  findUserByUsername: findUserByUsername,
  findUserById: findUserById,
  createUser: createUser,
  createSession: createSession,
  findSession: findSession,
  deleteSession: deleteSession
};
