/* ============================================================
   page-loader.js —— 站内切页时的加载动画（Day 29）

   一句话：点站内链接 → 等 450 毫秒（快导航就别闪了）→ 盖一层四片穗子旋转的遮罩；
   一旦盖上就必须播完整圈（2 秒）—— 旧页面活不过导航提交，靠新页面接手接力。
   ⚠️ 为什么需要"接力"：遮罩是盖在旧文档上的，浏览器一跳起来就连带没了。
      不接力的话，本地快跳时可见窗口只有几十毫秒（渐入要 180ms、转一圈要 2s），
      永远只能播到一截 —— 斌哥反馈的"要么不出现、出现也只是短暂几帧"正是这个。

   ⚠️ 为什么挂在 document 上用事件代理，而不是给每个链接绑事件：
     左栏导航、页面里的药丸链接、将来新加的链接 —— 全站链接都要接管，
     一个个绑就是"漏一个就有一个页面切起来像卡住"。
   ============================================================ */

var PageLoader = (function () {
  'use strict';

  /* 延迟出现：本地/内网切页常常几十毫秒就完事，立刻显示只会闪一下。
     ⚠️ Day 29 当晚改过一次（130ms → 450ms），原因与取舍留痕：
        斌哥反馈"要么不出现、出现也只是短暂几帧" —— 根因是遮罩盖在旧页面上、
        活不过导航提交（见文件头），本地快跳可见窗口只有几十毫秒，
        而遮罩渐入要 180ms、穗子转一圈要 2s，永远只能播到一截。
        【他拍板的方案 B】只慢加载时出现 + 出现必播完整：
          · 阈值抬到 450ms（比"感觉卡住"的约 300ms 感受阈值略高）——
            快跳彻底不闪，只有真的慢才盖上去；
          · 盖上了就必须播完一圈：靠新页面"接力"（见下方 tryTakeOver + MIN_VISIBLE_MS）。
        【被否掉的方案 A】每次跳转都出现+必播完 = 每次固定多等 1-2 秒，
            与他"不许为了凸显动画加大延迟、别每次跳转都显示"的定位冲突。
     原 130ms 的取值理由（留尸）：比一帧长得多、又比"卡住了"感受阈值短得多。
     ⚠️ 想亲眼看这个动画：地址后面加 `?maskdemo=1`（延迟归零、保底照常，每次跳转都播完整一圈），
        或者在 DevTools 里把网络限速到 Slow 3G 再点导航。 */
  var SHOW_DELAY_MS = /[?&]maskdemo=1/.test(location.search) ? 0 : 450;

  /* 保底播放时长：遮罩一旦盖上，至少要播这么久才允许收 —— 取"穗子转一圈"的 2 秒，
     与 CSS 里 pl-rotor-spin / pl-petal-veil 的周期严格对齐（改动画时长记得同步改这里）。
     系统开了「减少动态效果」时动画是停住的，没必要让人干等 2 秒静态图 → 缩到 0.6 秒。 */
  var MIN_VISIBLE_MS = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 600 : 2000;

  /* 跨页接力的暗号：旧页面盖上遮罩时写下时间戳，新页面据此判断"该不该接着播、还剩多久"。
     ⚠️ 为什么必须接力：遮罩挂在旧文档上，浏览器一起跳就连带没了 ——
        不接力的话"必播完整"无从谈起（旧页面活不过导航提交）。 */
  var PENDING_KEY = 'pl_pending';

  /* 兜底自动收罩：万一遮罩升起来了、页面却没真的换（被浏览器拒了、点了下载、
     或者别的脚本半路改了主意），不能让它在屏幕上永远转下去。
     8 秒 = 沿用本站旧的首页遮罩那套兜底时长。 */
  var HIDE_FALLBACK_MS = 8000;

  var mask = null;
  var showTimer = null;
  var hideTimer = null;
  var takeoverHideTimer = null;   /* 接力保底的收罩计时器：非空 = 本页正在接力播放中 */

  function build() {
    if (mask) return mask;
    mask = document.createElement('div');
    mask.className = 'pl-mask';
    mask.setAttribute('role', 'status');       /* 读屏软件会播报里面的字 */
    mask.setAttribute('aria-live', 'polite');
    /* 四片穗子：tl / bl / br 三片平铺，tr 那片包在 .pl-rotor 里当"刀片"转
       （顺序照旧首页遮罩那份，转子放最后 = 压在其余三片之上） */
    mask.innerHTML =
      '<div class="pl-logo" aria-hidden="true">' +
        '<div class="pl-petal pl-petal--tl"></div>' +
        '<div class="pl-petal pl-petal--bl"></div>' +
        '<div class="pl-petal pl-petal--br"></div>' +
        '<div class="pl-rotor"><div class="pl-petal pl-petal--tr"></div></div>' +
      '</div>' +
      '<span class="pl-label">加载中…</span>';
    document.body.appendChild(mask);
    return mask;
  }

  function show() {
    build().classList.add('is-on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_FALLBACK_MS);
    /* 写下"我盖上了"的时间戳，新页面要接力接着播。
       sessionStorage 被禁用（隐私模式等）时静默失败 → 退回无保底的老行为。 */
    try { sessionStorage.setItem(PENDING_KEY, String(Date.now())); } catch (e) {}
  }

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(takeoverHideTimer);
    takeoverHideTimer = null;
    if (mask) mask.classList.remove('is-on');
    /* 遮罩收下了，暗号作废 —— 含"没走成"的兜底路径，别让下一次新页面误接手。 */
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
  }

  /* 新页面接手：本站每个页面都加载本脚本，新文档一跑起来就问"上一个页面是不是
     给我留了没播完的遮罩" —— 有就接着播到 MIN_VISIBLE_MS，没有就正常放行。
     ⚠️ 用"脚本执行时刻"近似"新页面绘制时刻"：两者相差极小（都在绘制前），
        且偏差方向安全（elapsed 算小了 → 多播一点，绝不会少播）。
     ⚠️ 这里直接调用 show()：它内部会重新写一份暗号，链路自洽
        （当前遮罩成为"活着的遮罩"，hide 时一并清掉）。 */
  function tryTakeOver() {
    var raw = null;
    try { raw = sessionStorage.getItem(PENDING_KEY); } catch (e) { return; }
    if (!raw) return;
    var showAt = Number(raw);
    try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {}
    if (!showAt || !isFinite(showAt)) return;

    var remaining = MIN_VISIBLE_MS - (Date.now() - showAt);
    if (remaining <= 0) return;          /* 旧遮罩已播够一整圈，新页面干净显示，不用盖 */

    show();                              /* 新遮罩接手，续播剩余时长 */
    clearTimeout(takeoverHideTimer);
    takeoverHideTimer = setTimeout(hide, remaining);
  }
  tryTakeOver();

  /* 这个链接该不该被接管？
     不该管的一律放行（new tab / 外链 / 锚点 / 下载 / 加了修饰键 / 点的是当前页）——
     宁可漏接管，也别把用户的正常操作劫走。 */
  function shouldTakeOver(a, event) {
    if (!a || !a.getAttribute) return false;
    if (event.defaultPrevented) return false;                  /* 别人已经处理过了 */
    if (event.button !== undefined && event.button !== 0) return false;   /* 只认左键 */
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;  /* 新窗口/新标签 */
    if (a.hasAttribute('download')) return false;
    if (a.target && a.target !== '' && a.target !== '_self') return false;

    var href = a.getAttribute('href') || '';
    if (!href) return false;
    if (href.charAt(0) === '#') return false;                   /* 页内锚点 */
    if (/^(mailto:|tel:|javascript:|blob:)/i.test(href)) return false;

    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;            /* 外链：出了本站就别盖 */

    /* 点的是当前页（含 query 相同）→ 浏览器多半不跳，遮罩会一直赖着 */
    if (url.pathname === location.pathname && url.search === location.search) return false;

    return true;
  }

  /* 把一段代码推到「微任务」里执行。
     ⚠️ 这里必须用微任务、不能用 setTimeout(0)：微任务在【本次点击派发结束之后、
        浏览器开始处理导航之前】跑 —— 既能读到所有处理器最终的 defaultPrevented，
        又不会把遮罩的出场时机推迟一个宏任务。
        （先写成 setTimeout(0) 时实测踩过：多拖一个宏任务，遮罩就被推到导航之后，
          正常跳转反而永远看不到动画。） */
  var defer = (typeof queueMicrotask === 'function')
    ? queueMicrotask
    : function (fn) { Promise.resolve().then(fn); };

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!shouldTakeOver(a, e)) return;         /* 先便宜地筛一遍（外链/锚点等当场放行） */

    /* ⚠️ 最终判定要等【这一轮所有 click 处理器都表完态】再下结论。
       本站有些脚本会在自己的处理器里 preventDefault（把链接当按钮用、或自己接管跳转），
       而本文件的监听注册得比它们早（page-loader.js 排在 common.js 之后、业务脚本之前）——
       点下去那一瞬间，别人还没表态。
       当场排队的后果，本地与线上都复现过：
         链接被取消 → 没有新文档 → 遮罩 450ms 后照样升起来，**而且永远没人收它**（卡住）。
         （阈值从 130ms 抬到 450ms 后这个坑照样成立，只是等得更久；修法不变。） */
    defer(function () {
      if (!shouldTakeOver(a, e)) return;       /* 这次会连同 defaultPrevented 一起重新判 */
      clearTimeout(showTimer);
      showTimer = setTimeout(show, SHOW_DELAY_MS);
    });
  });

  /* 点完链接又没真的走（被脚本拦下、下载、浏览器拒绝）→ 别让遮罩永远转下去。
     监听 pagehide/pageunload 没用（那时候页面要没了，清不清都一样），
     关键是"没走成"这一路：给一个比延迟长一点的兜底，把计时器撤掉。 */
  window.addEventListener('pagehide', function () { clearTimeout(showTimer); });

  /* 从「后退到缓存页」(bfcache) 回来时，页面上可能还留着上一次的遮罩状态 → 收掉。
     ⚠️ 这里【只收罩、不清计时器】：pageshow 紧跟着 load 触发，而一次刚发生的点击
        正等着出场 —— 顺手 clearTimeout 会把那次合法的显示也一起掐掉
        （调试时踩过：点了链接却什么都没出现，查半天是这个原因）。
     ⚠️ 接力播放中（takeoverHideTimer 非空）不能收：否则"必播完整"就破了 ——
        load 早于保底到点时，收罩的活儿交给保底计时器（tryTakeOver 里那个）。 */
  window.addEventListener('pageshow', function () {
    if (takeoverHideTimer) return;
    hide();
  });

  /* 本页 load 完就收 —— 接力播放中例外（理由同上：保底优先）。
     这条路主要兜"被 show() 手动叫起来"的情况（比如登录成功后自己跳转）。 */
  window.addEventListener('load', function () {
    if (takeoverHideTimer) return;
    hide();
  });

  /* 对外：给"脚本自己跳转"的地方用（如登录成功 → location.href = 'index.html'） */
  return {
    show: show,
    hide: hide,
    /* ⚠️ 只给验证脚本用：单独问一句"这个链接该不该接管"，不用真的点它。
       真点会真的跳走/刷新，日志当场就没了（写验证脚本时踩过）。
       生产代码请无视它 —— 真实点击里它由上面的事件代理调用。 */
    _shouldTakeOver: shouldTakeOver,
    /* ⚠️ 只给验证脚本用：报告内部状态。
       为什么需要它：无头浏览器开着虚拟时钟时，"450ms 后显示"这种竞态根本测不准
       （虚拟时间会先把导航走完，再看计时器）—— 只能退一步问"该出场的那次，排上队了吗"。
       接力逻辑则可以直接问 takeover / on：新页面脚本一同步跑完 tryTakeOver，这两个值就是确定的。
       生产代码请无视。 */
    _state: function () {
      return {
        hasMask: !!mask,
        on: !!(mask && mask.className.indexOf('is-on') >= 0),
        scheduled: !!showTimer,      /* 已排上队（等出场） */
        takeover: !!takeoverHideTimer, /* 本页正在接力播放中 */
        delay: SHOW_DELAY_MS,
        minVisible: MIN_VISIBLE_MS
      };
    }
  };
})();
