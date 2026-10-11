/* ============================================
   repositories/boards.repo.js —— boards 表的数据访问

   Day 19：新建。原来这段「查 boards 表」的代码硬写在 index.js 的 getBoards 里，
   现在搬到这里 —— 一表一份文件。

   分工（记住这条界线）：
     · 这个文件只回答「boards 表里有什么」：查哪张表、要哪几列、怎么排序。
     · 「这个接口该返回什么形状（desc 还是 description）」是接口层 index.js 的事。
   ============================================ */

var rdb = require('../lib/rdb');

/* 首页三板块清单 —— 读 boards 表全部行，按 sort_order、再按 id 排序。
   ⚠️ 要哪几列写死在这儿（**数据库列名**）。以后加一列，改这一处就够。 */
async function listBoards() {
  return rdb.rdbSelect(
    'boards',
    'id,title,description,status,href',
    'sort_order.asc,id.asc'
  );
}

module.exports = { listBoards: listBoards };
