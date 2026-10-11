/* ============================================
   repositories/words.repo.js —— words 表的数据访问

   Day 19：新建。原来「查 / 写 words 表」的代码分别硬写在 index.js 的
   getWords 和 postWords 里，现在都搬到这里 —— 一表一份文件。

   Day 22：补齐「改 / 删」—— words 表的四种操作凑齐（查 list / 插 create /
   改 update / 删 remove），这也正是今天要掌握的「增删改查闭环」。

   Day 22 余力加练：**软删除**（soft delete）
     · 删，不再是 DELETE 掉整行，而只是把 is_deleted 改成 true —— 数据还在库里，能找回。
     · 查询（listWords）默认只取 is_deleted = false 的行 —— 已删的对上层"看不见"。
     · 由此多出两个动作：findWordById（连已删的也查得到，用来判断"这个 id 是被删了、还是从没存在过"）
       和 restoreWord（把 is_deleted 改回 false = 复活）。
     ⚠️ 为什么软删更安全：真删（rdbDelete）是**不可逆**的；软删最坏情况只是"改错一个布尔值"，
        再 UPDATE 一次就回来了。这就是"删除为什么比新增更容易出事"的解法之一。

   分工：
     · 这个文件只回答「words 表怎么读、怎么写、怎么改、怎么删」。
     · 字段名翻译（title↔word、desc↔meaning、tag↔unit_tag）和必填校验
       仍然是接口层 index.js 的事，一点没挪。
   ============================================ */

var rdb = require('../lib/rdb');

/* 词表 —— 读 words 表；传了 unit 就只取该单元的词。
   ⚠️ 「按哪个列筛」也是数据访问的知识：库里的列叫 unit_tag，
      所以过滤条件在这里拼，接口层只管把 query.unit 递进来。
   ⚠️ 余力加练：**始终带 is_deleted=false 过滤** —— 已软删的词条从这里就"看不见"了。
      这一步放在最底层（而不是接口层），意味着所有走 listWords 的调用方
      自动获得"过滤已删"的行为，一处改动、全场生效。 */
async function listWords(unit) {
  var filters = [['is_deleted', 'false']];
  if (unit) filters.push(['unit_tag', unit]);
  return rdb.rdbSelect(
    'words',
    'id,word,meaning,unit_tag',
    'sort_order.asc,id.asc',
    filters
  );
}

/* 按 id 查一条 —— **连已软删的也查**（不加 is_deleted 过滤）。
   用途：POST 时要判断「这个 id 是活的（→ 409）、还是被软删的（→ 复活）」，
        光靠 listWords 查不出来（它把已删的过滤掉了）。
   返回：数组；空数组 = 这个 id 从没存在过。 */
async function findWordById(id) {
  return rdb.rdbSelect(
    'words',
    'id,word,meaning,unit_tag,is_deleted',
    'id.asc',
    [['id', id]]
  );
}

/* 新增一条词条。
   ⚠️ row 的键必须是【数据库列名】（id / word / meaning / unit_tag）——
      接口层把网页的叫法翻译完再递进来，这里不碰翻译。
   出错就抛（重复提交会带 conflict = true，由接口层的 postWords 翻成 409）。 */
async function createWord(row) {
  return rdb.rdbInsert('words', row);
}

/* 改一条词条。
   id     —— 改哪一行（等值过滤，落到 words.id 列上）
   fields —— 要改的列，键必须是【数据库列名】（word / meaning / unit_tag）；
             接口层翻译完再递进来。
   ⚠️ filters 里的列名 'id' 也属于「数据访问的知识」——它得跟表里的主键名一致，
      所以在这里拼，接口层只管把要改的 id 和字段递进来。
   返回：改后那一行的数组；**空数组 = 这个 id 不存在**（接口层据此回 404）。 */
async function updateWord(id, fields) {
  return rdb.rdbUpdate('words', fields, [['id', id]]);
}

/* 「删」一条词条 —— ⚠️ Day 22 余力加练后，这是**软删**，不是真删。
   做法：把 is_deleted 改成 true（复用 rdbUpdate，不是 rdbDelete）。
   ⚠️ 「软删是改、不是删」—— 所以这里调的是 update，不是 delete。
      好处：上层接口的写法几乎不用变（还是"改哪一行、得到改后的行 / 空数组"），
           但数据库里那一行**原封不动还在**，只是被标记成"已删除"。
   返回：改后那一行的数组（is_deleted 已为 true）；**空数组 = 这个 id 不存在**。
   ⚠️ 一个边界：对一个**已经软删**的 id 再调一次 → 它仍在（is_deleted 还是 true），
      回显不为空 ⇒ 接口层会报"成功"。这是可接受的：重复删同一个东西，
      结果都是"它不在了"，幂等。 */
async function softDeleteWord(id) {
  return rdb.rdbUpdate('words', { is_deleted: true }, [['id', id]]);
}

/* 复活一条被软删的词条 —— 把 is_deleted 改回 false。
   用途：POST 时遇到「曾经被软删、现在又想重新添加」的 id，直接复活它，
        而不是被主键唯一约束拦成 409（"我明明删了它，为什么说已存在？"的困惑就出在这）。
   ⚠️ 复活时**顺手把字段覆盖成新提交的值**（fields 由接口层翻译好传进来）——
      因为用户 POST 的是"一条全新的词"，只把标记改回来、留着旧值，等于骗人。
   返回：复活后那一行的数组；空数组 = 这个 id 不存在（理论上不会走到）。 */
async function restoreWord(id, fields) {
  var patch = { is_deleted: false };
  Object.keys(fields || {}).forEach(function (k) { patch[k] = fields[k]; });
  return rdb.rdbUpdate('words', patch, [['id', id]]);
}

/* ⚠️ 保留真删能力（rdbDelete 仍在 lib/rdb.js 里），但当前语义已改为软删，不用它。
   以后若要"彻底清掉已软删的行"（比如后台清理任务），可以在这里加一个 purgeWord()。 */

module.exports = {
  listWords: listWords,
  findWordById: findWordById,
  createWord: createWord,
  updateWord: updateWord,
  softDeleteWord: softDeleteWord,
  restoreWord: restoreWord
};
