/* ============================================
   repositories/words.repo.js —— words 表的数据访问

   Day 19：新建。原来「查 / 写 words 表」的代码分别硬写在 index.js 的
   getWords 和 postWords 里，现在都搬到这里 —— 一表一份文件。

   Day 22：补齐「改 / 删」—— words 表的四种操作凑齐（查 list / 插 create /
   改 update / 删 remove），这也正是今天要掌握的「增删改查闭环」。

   分工：
     · 这个文件只回答「words 表怎么读、怎么写、怎么改、怎么删」。
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

/* 删一条词条。
   ⚠️ 这是【真删】（DELETE），不是软删 —— 删完库里就没这行了，找不回来。
      软删（加 is_deleted 标记、查询时跳过）是今天的余力加练，本期先不做。
   返回：被删掉那一行的数组；**空数组 = 这个 id 不存在**（接口层据此回 404）。 */
async function deleteWord(id) {
  return rdb.rdbDelete('words', [['id', id]]);
}

module.exports = {
  listWords: listWords,
  createWord: createWord,
  updateWord: updateWord,
  deleteWord: deleteWord
};
