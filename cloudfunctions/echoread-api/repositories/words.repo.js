/* ============================================
   repositories/words.repo.js —— words 表的数据访问

   Day 19：新建。原来「查 / 写 words 表」的代码分别硬写在 index.js 的
   getWords 和 postWords 里，现在都搬到这里 —— 一表一份文件。

   分工：
     · 这个文件只回答「words 表怎么读、怎么写」。
     · 字段名翻译（title↔word、desc↔meaning、tag↔unit_tag）和必填校验
       仍然是接口层 index.js 的事，一点没挪。
   ============================================ */

var rdb = require('../lib/rdb');

/* 词表 —— 读 words 表；传了 unit 就只取该单元的词。
   ⚠️ 「按哪个列筛」也是数据访问的知识：库里的列叫 unit_tag，
      所以过滤条件在这里拼，接口层只管把 query.unit 递进来。 */
async function listWords(unit) {
  var filters = unit ? [['unit_tag', unit]] : [];
  return rdb.rdbSelect(
    'words',
    'id,word,meaning,unit_tag',
    'sort_order.asc,id.asc',
    filters
  );
}

/* 新增一条词条。
   ⚠️ row 的键必须是【数据库列名】（id / word / meaning / unit_tag）——
      接口层把网页的叫法翻译完再递进来，这里不碰翻译。
   出错就抛（重复提交会带 conflict = true，由接口层的 postWords 翻成 409）。 */
async function createWord(row) {
  return rdb.rdbInsert('words', row);
}

module.exports = {
  listWords: listWords,
  createWord: createWord
};
