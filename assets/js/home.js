/* ============================================
   home.js —— 首页的「显示」逻辑（Day 8）
   职责：读接口给的板块清单，把三个板块入口渲染成卡片
   三种显示状态在这里收口：加载中 / 空 / 读取失败（＋重试）

   术语备注：
     fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
     JSON  —— 一种纯文本数据格式，人和机器都能读，用来存板块清单
   ============================================ */

/* ============================================
   Day 17：板块清单改从【后端接口】取，不再读仓库里的 data/boards.json
   Day 27：地址从【完整域名】改成【同源相对路径】。

   ⚠️ 为什么改走相对路径（原先写的是云函数完整域名）：
      发布站点 https://echoread.app.workbuddy.host 不在 CloudBase 网关的跨域白名单里，
      浏览器直接调云函数会被 CORS 拦掉 —— 首页一直显示「网络连不上」
      （CORS_FIX.md：Day 23 发现、Day 24 定位，因免费体验版加不了安全域名而封存）。
      现在页面只调自己域名下的 /api/boards（同源，浏览器压根不认为这是跨域请求），
      由 dev-server.js 上的 /api 代理转发给云函数 —— 服务器之间没有 CORS 这回事。
      ⇒ 云函数地址因此从【前端源码】挪进了【后端】，前端不再暴露它。
   ⚠️ 别改回完整域名：那样跨域会原样回来。

   ⚠️ 接口返回的数据形状和原来的 data/boards.json【完全一致】（都是 { boards: [...] }），
      所以下面渲染卡片、处理三种状态的那几百行，一行都不用改 ——
      这正是 api-contract.md 当初把响应形状刻意对齐 mock 赚回来的。
   ============================================ */
var BOARDS_URL = '/api/boards';   /* 板块清单：首页上要列哪几个入口 */

/* 状态码 → 给人看的样子。
   为什么放在代码里、不放进 JSON：
     JSON 管「有哪些板块、叫什么、说明什么」（内容），
     「可用 / 开发中」怎么显示属于界面规则（代码）。
   两种东西分开放，以后换文案不用改数据，加板块也不用改代码。 */
var STATUS_STYLE = {
  available: { label: '可用',   badge: 'badge-ok',   hint: '' },
  wip:       { label: '开发中', badge: 'badge-todo', hint: '开发中 · 暂不可进入' }
};

/* ⚠️ 下面 loadJSON / failureHTML / escapeHTML 三段，Day 23 之前是【有意复制】的
   （当时只有两个页面，TECH_DESIGN.md §2.1 认下这笔账）。
   Day 23 结账：它们已收编进 assets/js/common.js，本文件改为直接引用那一份，
   不再自带副本 —— 全站错误提示从此只有一个源头。

   为什么必须由 common.js 提供（而不是各页各写一份）：
     错误提示的风格要"统一"，靠三份复制品是统一不了的 —— 改一处，另两处不同步。
   ⇒ index.html 的 <script> 里，common.js 必须排在 home.js 之前。 */

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
    return '<li class="board item">' +
             '<a class="board-link" href="' + escapeHTML(board.href) + '">' +
               head + desc +
             '</a>' +
           '</li>';
  }
  return '<li class="board item">' + head + desc + hint + '</li>';
}

function setStatus(box, html) {
  if (box) box.innerHTML = html;
}

/* 【Day 27】撤掉加载遮罩。
   放在"数据有结果了"那一刻调用 —— 不管后面是铺成卡片、还是空、还是报错，
   遮罩的使命都已经结束：它只负责盖住"页面上什么都没有"的那几百毫秒。
   先加 .is-hide 触发淡出（.32s，见 loading.css），再等过渡走完加 .is-gone 移出布局。
   为什么用定时器而不是 transitionend：元素被隐藏、或系统开了"减少动态效果"时，
   transitionend 可能压根不派发，定时器更稳。350ms 略大于 CSS 里的 320ms。 */
function hideLoadingMask() {
  var mask = document.getElementById('ld-mask');
  if (!mask || mask.classList.contains('is-gone')) return;   /* 已撤过就跳掉，防重复 */
  mask.classList.add('is-hide');
  setTimeout(function () { mask.classList.add('is-gone'); }, 350);
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
    hideLoadingMask();                     /* 数据到手，遮罩下岗 */
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
    wireCards();                          /* Day 11：卡片刚铺好，立刻接上浮圆与扩散 */
  }).catch(function (err) {
    hideLoadingMask();                     /* 报错也要撤 —— 下面会给出错提示和重试按钮 */
    /* 读不到数据也要给人话 ＋ 重试入口，不能白屏。
       Day 23：改调 common.js 的统一版 —— 必须传 what / action，
       否则按钮 data-action 会退成默认值、点重试找不到这个页面的处理函数。 */
    setStatus(status, failureHTML(err, '板块列表', 'retry-boards'));
    console.error(err);
  });
}

/* ============================================
   Day 11：卡片光标处的「透视窗」＋ 点击溶解
   视觉全在 CSS（.board::after 那层"皮"上的 mask 挖洞），这里只干三件事：
     ① 把交互点（鼠标的、手指的，同一套算法）写进 CSS 变量 —— 圆才知道从哪儿冒出来
     ② 来回切圆的半径：藏起来(0) → 悬停/点按(110) → 盖满整卡
     ③ 按时机加/摘那一个开关 class：is-dissolving（溶解中）
        圆从哪儿冒出来 = 人刚在哪儿动的手，鼠标和手机一致。
   ============================================ */

var LIGHT_RADIUS = 110;     /* 悬停时那个圆的半径（px）—— 够大看得见，够小不糊住整张卡 */

/* 点击之后的节奏。CSS 里的 --duration-dissolve 必须和 DISSOLVE_MS 对上：
   CSS 管"每次变化用多久"，这里管"什么时候跳走"。 */
var DISSOLVE_MS = 200;      /* 圆从光标处扩到盖满整卡、文字同时淡出 —— 两者同一时刻结束 */
var NAV_WAIT = 260;         /* 可进入的卡片：从点击到真的跳走（溶解 200 走完再留一点余量） */
var REVERT_WAIT = 380;      /* 「开发中」卡片：溶解完停一下，再整体还原回去 */

/* 圆要多大才能盖住整张卡 —— 取对角线长度，保证四个角都吃到 */
function coverRadius(card) {
  var r = card.getBoundingClientRect();
  return Math.ceil(Math.sqrt(r.width * r.width + r.height * r.height));
}

/* 系统开了「减少动态效果」吗 —— 开了就不演，直接办事。
   为什么要在这里判、而不是只靠 CSS 把时长压成 0：
   压成 0 之后文字会"啪"地消失、卡片空在那里等 NAV_WAIT 才跳走，反而更难受。 */
function prefersReducedMotion() {
  return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* 交互点在卡片内的坐标 → 写进 CSS 变量，圆就从那儿冒出来。
   ⚠️ 鼠标和触屏【走的是同一套】：都拿事件的 clientX / clientY 减去卡片左上角。
      触屏的 pointerenter 在个别浏览器上给的是上一次的旧坐标，
      所以下面 pointerdown 会再写一次 —— 手指点哪儿，圆就长在哪儿。 */
function moveLight(card, e) {
  var r = card.getBoundingClientRect();
  card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  card.style.setProperty('--my', (e.clientY - r.top) + 'px');
}

/* 窄屏（手机）吗 —— Day 14 起，手机改走"整张皮 opacity 淡出"这条路
   （见 style.css 里 @media (max-width: 599px) 的那一节）。
   ⚠️ 为什么要在这里判：手机上一律【不写 --r】。
      写了会怎样：窄屏那边没有 --r 过渡，洞会【瞬时】开满整卡，
      皮当场全透 —— 后面那条淡出就白做了，又变回"啪一下空白"。
      所以圆的整套逻辑（悬停 / 按下 / 溶解撑开）在手机上一个都不参与。 */
function isNarrow() {
  return !!(window.matchMedia &&
            window.matchMedia('(max-width: 599px)').matches);
}

function setRadius(card, px) {
  if (isNarrow()) return;
  card.style.setProperty('--r', px + 'px');
}

/* 溶解：圆从光标处扩大、直到盖满整卡（卡片的白底被身后的背景替代），
   文字同时淡出 —— 两边都交给 CSS 的 --duration-dissolve，同一时刻结束。 */
function dissolve(card) {
  card.classList.add('is-dissolving');
  setRadius(card, coverRadius(card));
}

/* 还原：「开发中」卡片那次溶解演完之后的收场 ——
   把圆收回去、文字淡回来。跟进来时是同一套，只是方向相反。 */
function restore(card) {
  card.classList.remove('is-dissolving');
  /* 鼠标还停在卡上就是退回悬停那个小圆；不然干脆全收掉。
     触屏上一般 matches(':hover') 是 false，圆就整个消失了。 */
  setRadius(card, card.matches(':hover') ? LIGHT_RADIUS : 0);
}

/* 给卡片接上"透视窗 / 溶解"。渲染完才能调用 —— 卡片那会儿才存在。
   为什么不用事件代理：pointerenter / pointerleave 这两个事件【不冒泡】，
   代理挂不上；首屏就三张卡，直接绑更省心。 */
function wireCards() {
  var cards = document.querySelectorAll('.board');

  for (var i = 0; i < cards.length; i++) {
    (function (card) {
      var link = card.querySelector('.board-link');

      card.addEventListener('pointerenter', function (e) {
        if (card.classList.contains('is-dissolving')) return;   /* 正在溶解，别打断 */
        /* 动效敏感的用户：圆根本不出现。
           ⚠️ 为什么必须在这里拦：CSS 那边只把过渡时长压成了 0（@media reduced-motion），
              半径要是照写，圆还是会"瞬时冒出来"—— 不补间 ≠ 不出现。 */
        if (prefersReducedMotion()) return;
        /* 先定坐标、再给半径，顺序不能反 —— 反了会看见圆从角落里蹦出来再滑过去 */
        moveLight(card, e);
        setRadius(card, LIGHT_RADIUS);
      });

      card.addEventListener('pointermove', function (e) {
        moveLight(card, e);
      });

      /* 手指 / 笔尖落下的那一刻，把圆挪到【真正点到的地方】再让它长出来。
         鼠标上这一下是多余的（pointerenter 已经定好位），但值一样，重复写没代价；
         触屏上它是主力 —— 手指点哪儿，圆就长在哪儿，跟电脑完全一致。 */
      card.addEventListener('pointerdown', function (e) {
        if (card.classList.contains('is-dissolving')) return;   /* 正在溶解，别打断 */
        if (prefersReducedMotion()) return;                     /* 同上：圆不出现 */
        moveLight(card, e);
        setRadius(card, LIGHT_RADIUS);
      });

      card.addEventListener('pointerleave', function () {
        if (card.classList.contains('is-dissolving')) return;  /* 溶解中，留着别收 */
        setRadius(card, 0);
      });

      if (link) {
        /* 可进入的卡片：点下去先把溶解演完，再真的跳走。
           不拦的话浏览器当场就换页了，那个溶解动画等于没做。
           ⚠️ 跳走这一步之后，接手的是【跨页过渡】（style.css 里 @keyframes vtLeave/vtEnter）：
              首页整体上移 + 消散，跟读页从下方上移 + 显现。 */
        link.addEventListener('click', function (e) {
          /* 中键 / Ctrl+点 / Shift+点 = 用户想开新标签，那是浏览器的活儿，一律放行 */
          if (e.defaultPrevented || e.button !== 0 ||
              e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

          e.preventDefault();

          /* 动效敏感的用户：不演，也不白等那 260ms，直接跳 */
          if (prefersReducedMotion()) {
            window.location.href = link.getAttribute('href');
            return;
          }

          dissolve(card);
          setTimeout(function () {
            window.location.href = link.getAttribute('href');
          }, NAV_WAIT);

          /* 【网 3】兜底：这次跳转要是没走成 —— 页面被浏览器冻进缓存、
             又原样吐回来，而 pageshow / visibilitychange 一个信号都没到 ——
             到点就把卡片收回原样，免得你看到一张没有皮、没有字的空卡。
             正常跳转时这一页早就被销毁了，这个定时器什么都不会跑。
             ⚠️ 已知取舍：网络极慢、两秒后还停在这一页时，卡片会自己弹回来一下。
                弹回来难看，但比"永远空着"强。 */
          setTimeout(function () {
            if (document.visibilityState === 'visible') resetCards();
          }, NAV_WAIT + 1500);
        });
      } else {
        /* 「开发中」的卡片：没有可去的地方，溶解一下就【弹回来】——
           当作"收到了，但进不去"，而不是点完毫无反应。 */
        card.addEventListener('click', function () {
          if (card.classList.contains('is-dissolving')) return;

          if (prefersReducedMotion()) return;   /* 不演 */

          dissolve(card);
          setTimeout(function () {
            restore(card);
          }, REVERT_WAIT);
        });
      }
    })(cards[i]);
  }
}

/* 点「重试」→ 重来一遍。事件代理挂在 document 上，不依赖按钮何时被渲染出来 */
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.closest) return;
  if (el.closest('[data-action="retry-boards"]')) render();
});

/* ---- 从 bfcache 回来时的收尾（Day 11）----
   浏览器前进/后退时，可能把这一页【原样冻住】再原样吐回来（bfcache 这个概念）。
   "原样"里就包括点卡片那一刻 JS 写下的东西：
   --r 已经被撑到 429px（盖满整卡）、卡片上还挂着 is-dissolving、文字 opacity 被压到 0 ——
   而那次跳转其实没真的完成（页面是被冻住，不是被销毁）。
   于是回到这一页，屏幕上就是【一张没有皮、没有字的空卡】。

   修法：借"页面重新出现在屏幕上"的信号把几样东西擦干净，回到初始样。
   **三层网**，每一层盖一种失败方式（下面的 resetCards / pageshow / visibilitychange）：

     网 1  pageshow      —— 浏览器从 bfcache 吐回来时会派发
     网 2  visibilitychange（变回可见）—— 个别内置浏览器恢复时【不派发 pageshow】
     网 3  跳转后的兜底定时器（写在点卡片那一段）—— 万一前两个信号一个都没来

   ⚠️⚠️ Day 14 更正（真人测试实测）：原版【只在 e.persisted 为真时才动手】，
      而那台手机上实测到 bug —— 点进板块 → 返回键退出 → 被点的卡【仍然是空的】。
      说明它恢复页面时 pageshow 的 persisted 不是 true，清理整段被那行判断挡掉了。
      ⇒ 现在改成【每次 pageshow 都清】。首次加载多清一遍三张卡，代价可以忽略。
      （教训：别用"顺便省一点"的优化去挡一条【正确性】分支 —— 省下的是三次 DOM 遍历，
        赔上的是别人手机上一条擦不掉的空卡。）

   ⚠️ 为什么用 removeProperty 而不是写 0：
      写 0 会留下一个"内联的 0px"，那和"从没被碰过"是两种状态（以后想判断
      --r 有没有被写过就不准了）。直接删掉，才真的回到"这张卡还没被悬停过"的样子。
   ⚠️ 挂在顶层而不是 DOMContentLoaded 里：它只用到 window，不用等 DOM，
      而且脚本只执行一次，不会重复注册。 */
/* 把三张卡擦回初始样 —— 三处收尾共用这一份 */
function resetCards() {
  var cards = document.querySelectorAll('.board');
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.remove('is-dissolving');
    cards[i].style.removeProperty('--r');
    cards[i].style.removeProperty('--mx');
    cards[i].style.removeProperty('--my');
  }
}

/* 【网 1】pageshow —— 页面从"冻结状态"被吐回来时，浏览器会派发它。
   ⚠️ Day 14：这里【故意不再判断 e.persisted】。
      原来写的是「只在 persisted 为真时才动手」，理由是"首次加载没有残留，清了白清"。
      但真人测试在手机上实测到了反例：点进板块 → 手机返回键退出 →
      被点击的那张卡【仍然是空的】。说明那台浏览器把页面恢复回来时，
      pageshow 里的 persisted 并不是 true —— 于是清理被这行判断挡掉了，残留原样留在屏幕上。
      ⇒ 判断删掉：**每次 pageshow 都清一遍**。三张卡的 DOM 遍历，代价可以忽略，
        换来的是"不管浏览器怎么恢复，看到的都是干净的一页"。 */
window.addEventListener('pageshow', resetCards);

/* 【网 2】visibilitychange —— 页面重新变可见时再清一遍。
   为什么还要这一条：网 1 靠的是 pageshow，而个别手机浏览器（内置 WebView 那类）
   从自己的页面缓存里恢复时，可能压根不派发 pageshow。
   但"变回可见"这个信号几乎所有浏览器都会给 —— 再兜一层。 */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') resetCards();
});

document.addEventListener('DOMContentLoaded', render);
