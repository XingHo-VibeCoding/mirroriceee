/* ============================================
   list-page.js —— 列表类视图的通用渲染（Day 13）
   ------------------------------------------------------------
   谁在用：vocab.html（词汇速记）、writing.html（作文模板）。
   两个页面要干的事一样：读一份 JSON，把条目铺成一列。
   所以渲染逻辑只写这一份，由页面上的 data-* 告诉它「读哪个文件、取哪个数组、
   这块叫什么名字」—— 以后再添第三个列表页，不必再抄一遍。

   页面上的配置（都写在 <ul id="list"> 上）：
     data-list-url   要读的 JSON 路径
     data-list-key   取 JSON 里的哪个数组（words / templates …）
     data-list-name  这块的中文名，用于状态提示（「正在加载词表…」）

   ---- 四种状态都在 renderList 里收口（这是 Day 13 的重点）----
     ① 加载中    —— 数据还没回来，写明「正在加载…」，不留白屏
     ② 加载成功  —— 数据回来了、有条目，铺列表
     ③ 没有结果  —— 数据回来了、一条都没有，说清是「这份清单本来就空」
     ④ 请求失败  —— 断网 / 404 / JSON 非法，给人话 ＋ 重试入口
   ============================================ */

/* 把一条数据拼成一行。
   title / desc / tag 三个字段都是可选的：缺哪个就不铺哪个。
   不写死「必须三个都有」—— 数据少给一个字段就整行报错，那是自找的。 */
function buildItemHTML(item) {
  var title = item.title ? '<span class="li-title">' + escapeHTML(item.title) + '</span>' : '';
  var desc  = item.desc  ? '<span class="li-desc">'  + escapeHTML(item.desc)  + '</span>' : '';
  var tag   = item.tag   ? '<span class="li-tag">'   + escapeHTML(item.tag)   + '</span>' : '';
  return '<li class="list-item item">' + title + desc + tag + '</li>';
}

function setListStatus(html) {
  var box = document.getElementById('list-status');
  if (box) box.innerHTML = html;
}

function renderList() {
  var list = document.getElementById('list');
  if (!list) return;

  var url  = list.getAttribute('data-list-url');
  var key  = list.getAttribute('data-list-key');
  var name = list.getAttribute('data-list-name') || '内容';

  /* ① 加载中：这段时间页面上什么都没有，不写一句就跟白屏没区别。
     重试时也先回到这一句，用户才知道点下去有反应了 */
  setListStatus('<p class="empty">正在加载' + escapeHTML(name) + '…</p>');
  list.innerHTML = '';

  loadJSON(url).then(function (data) {
    /* 取不到那个数组（文件里没这个字段、或类型写错了）时，一律当成空清单 ——
       宁可显示「还没有内容」，也不要拿一个 undefined 去遍历、当场报错 */
    var items = (data && Array.isArray(data[key])) ? data[key] : [];

    /* ③ 没有结果：页面能打开、控制台干净、什么都不报 ——
       长得跟成功一模一样，所以最容易被漏掉。必须给一句人话，
       而不是留一片空白让人以为页面挂了 */
    if (!items.length) {
      setListStatus('<p class="empty">' + escapeHTML(name) + '还没有内容。</p>');
      return;
    }

    /* ② 加载成功 */
    setListStatus('');
    list.innerHTML = items.map(buildItemHTML).join('');
  }).catch(function (err) {
    /* ④ 请求失败：读不到也要给人话 ＋ 重试入口，不能白屏 */
    setListStatus(failureHTML(err, name, 'retry-list'));
    console.error(err);
  });
}

/* 点「重试」→ 重来一遍。事件代理挂在 document 上，不依赖按钮何时被渲染出来 */
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.closest) return;
  if (el.closest('[data-action="retry-list"]')) renderList();
});

document.addEventListener('DOMContentLoaded', renderList);
