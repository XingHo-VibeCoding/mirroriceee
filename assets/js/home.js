/* ============================================
   home.js —— 首页的「显示」逻辑（Day 8）
   职责：读 data/boards.json，把三个板块入口渲染成卡片
   三种显示状态在这里收口：加载中 / 空 / 读取失败（＋重试）

   术语备注：
     fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
     JSON  —— 一种纯文本数据格式，人和机器都能读，用来存板块清单
   ============================================ */

var BOARDS_URL = 'data/boards.json';   /* 板块清单：首页上要列哪几个入口 */

/* 状态码 → 给人看的样子。
   为什么放在代码里、不放进 JSON：
     JSON 管「有哪些板块、叫什么、说明什么」（内容），
     「可用 / 开发中」怎么显示属于界面规则（代码）。
   两种东西分开放，以后换文案不用改数据，加板块也不用改代码。 */
var STATUS_STYLE = {
  available: { label: '可用',   badge: 'badge-ok',   hint: '' },
  wip:       { label: '开发中', badge: 'badge-todo', hint: '开发中 · 暂不可进入' }
};

/* ⚠️ 下面 loadJSON / failureHTML / escapeHTML 三段，与 assets/js/app.js 里是同一套逻辑，
   这里是【有意复制】的，不是漏了抽取：
   TECH_DESIGN.md §2.1 已经认下这笔账 —— 本项目不引框架、不引构建工具，
   两个页面各带一份小工具函数，代价远小于引入一整套工具链。
   等页面多到第三、第四页，再抽成共用文件不迟。 */

/* 取一个 JSON 文件；读不到就抛错，交给 render 的 catch 统一处理。
   失败原因分三类打标签（kind），因为给用户看的话不一样：
     network —— 断网 / DNS 挂了 / 被拦了
     http    —— 服务器答了，但不是 200（比如 404 文件不在、500 服务器炸了）
     parse   —— 文件拿到了，但里面不是合法 JSON（手写 JSON 少个逗号就会这样） */
function loadJSON(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.kind = 'http';
      e.url = url;
      throw e;
    }
    return res.json().catch(function () {
      var e2 = new Error('内容不是合法 JSON');
      e2.kind = 'parse';
      e2.url = url;
      throw e2;
    });
  }, function () {
    /* fetch 自己 reject 了：根本没连上服务器 */
    var e3 = new Error('网络连不上');
    e3.kind = 'network';
    e3.url = url;
    throw e3;
  });
}

/* 把失败翻译成人话 —— 绝不能让用户看到 "Failed to fetch" 这种英文报错 */
function failureHTML(err) {
  var text;
  if (err.kind === 'network') {
    text = '网络连不上，加载不了板块列表。请检查网络后点下面的「重试」。';
  } else if (err.kind === 'http') {
    text = '服务器没能提供板块列表（' + err.message + '）。请稍后点「重试」。';
  } else if (err.kind === 'parse') {
    text = '板块列表读不出来（' + err.message + '）。这是数据文件本身的问题，请联系维护者。';
  } else {
    text = '板块列表加载失败：' + err.message;
  }
  return '<p class="empty">' + escapeHTML(text) + '</p>' +
         '<button type="button" class="btn" data-action="retry-boards">重试</button>';
}

/* 文本里的 & < > 要转义，否则数据文件里一个尖括号就能把页面结构冲乱 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* 把一条板块数据拼成一张卡。三条规矩：
     ① 只有 status 是 available 【且】给了 href 的才做成链接 ——
        PRD 6.3 H2 要求「点开发中的入口不能出现空白页」，那干脆不给它链接，从源头堵死
     ② 认不出的 status 一律按「开发中」处理 —— 宁可标得保守，也不要假装它能用
     ③ 所有文字过一遍 escapeHTML */
function buildBoardHTML(board) {
  var style = STATUS_STYLE[board.status] || STATUS_STYLE.wip;

  var head = '<div class="board-head">' +
               '<h2>' + escapeHTML(board.title) + '</h2>' +
               '<span class="badge ' + style.badge + '">' + escapeHTML(style.label) + '</span>' +
             '</div>';
  var desc = board.desc ? '<p class="board-desc">' + escapeHTML(board.desc) + '</p>' : '';
  var hint = style.hint ? '<p class="board-hint">' + escapeHTML(style.hint) + '</p>' : '';

  if (board.status === 'available' && board.href) {
    /* 整张卡片就是一个链接，点哪儿都能进（点击区域靠 .board-link 撑满） */
    return '<li class="board">' +
             '<a class="board-link" href="' + escapeHTML(board.href) + '">' +
               head + desc +
             '</a>' +
           '</li>';
  }
  return '<li class="board">' + head + desc + hint + '</li>';
}

function setStatus(box, html) {
  if (box) box.innerHTML = html;
}

/* 主流程：读清单 → 铺卡片。三种显示状态都在这里收口 */
function render() {
  var list = document.getElementById('boards');
  var status = document.getElementById('boards-status');
  if (!list) return;

  /* 加载中必须说话：这段时间页面上什么都没有，不写一句就跟白屏没区别 */
  setStatus(status, '<p class="empty">正在加载板块…</p>');
  list.innerHTML = '';

  loadJSON(BOARDS_URL).then(function (data) {
    var boards = data.boards || [];

    /* 空状态：页面能打开、控制台干净、什么都不报 ——
       长得跟成功一模一样，所以最容易被漏掉。这里必须给一句人话，
       而不是留一片空白让人以为页面挂了 */
    if (!boards.length) {
      setStatus(status, '<p class="empty">暂无板块</p>');
      return;
    }

    setStatus(status, '');
    list.innerHTML = boards.map(buildBoardHTML).join('');
  }).catch(function (err) {
    /* 读不到数据也要给人话 ＋ 重试入口，不能白屏 */
    setStatus(status, failureHTML(err));
    console.error(err);
  });
}

/* 点「重试」→ 重来一遍。事件代理挂在 document 上，不依赖按钮何时被渲染出来 */
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.closest) return;
  if (el.closest('[data-action="retry-boards"]')) render();
});

document.addEventListener('DOMContentLoaded', render);
