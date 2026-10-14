/* ============================================================
   page-loader.js —— 站内切页时的加载动画（Day 29）

   一句话：点站内链接 → 等 130 毫秒（快导航就别闪了）→ 盖一层转圈的遮罩。
   为什么"盖上去"就够了、不用在新页面里也放一遍：
     浏览器是【等新页面能画了才替换老页面】的 —— 老页面（连同这层遮罩）
     一直留在屏幕上，直到新文档开始绘制。所以这一层天然覆盖了整段等待。

   ⚠️ 为什么挂在 document 上用事件代理，而不是给每个链接绑事件：
     左栏导航、页面里的药丸链接、将来新加的链接 —— 全站链接都要接管，
     一个个绑就是"漏一个就有一个页面切起来像卡住"。
   ============================================================ */

var PageLoader = (function () {
  'use strict';

  /* 延迟出现：本地/内网切页常常几十毫秒就完事，立刻显示只会闪一下。
     130ms 是个经验值 —— 比一帧长得多（不会误判成"每次都闪"），
     又比人的"卡住了"感受阈值（约 300ms）短得多。
     ⚠️ 想亲眼看这个动画：地址后面加 `?maskdemo=1`（延迟归零，每次跳转都显示），
        或者在 DevTools 里把网络限速到 Slow 3G 再点导航 ——
        本地站切页太快，不这么做基本看不到它（这是设计如此，不是没生效）。 */
  var SHOW_DELAY_MS = /[?&]maskdemo=1/.test(location.search) ? 0 : 130;

  /* 兜底自动收罩：万一遮罩升起来了、页面却没真的换（被浏览器拒了、点了下载、
     或者别的脚本半路改了主意），不能让它在屏幕上永远转下去。
     8 秒 = 沿用本站旧的首页遮罩那套兜底时长。 */
  var HIDE_FALLBACK_MS = 8000;

  var mask = null;
  var showTimer = null;
  var hideTimer = null;

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
  }

  function hide() {
    clearTimeout(hideTimer);
    if (mask) mask.classList.remove('is-on');
  }

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
         链接被取消 → 没有新文档 → 遮罩 130ms 后照样升起来，**而且永远没人收它**（卡住）。 */
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
        （调试时踩过：点了链接却什么都没出现，查半天是这个原因）。 */
  window.addEventListener('pageshow', hide);

  /* 万一被 show() 手动叫起来（比如登录成功后自己跳转），本页 load 完就收 */
  window.addEventListener('load', hide);

  /* 对外：给"脚本自己跳转"的地方用（如登录成功 → location.href = 'index.html'） */
  return {
    show: show,
    hide: hide,
    /* ⚠️ 只给验证脚本用：单独问一句"这个链接该不该接管"，不用真的点它。
       真点会真的跳走/刷新，日志当场就没了（写验证脚本时踩过）。
       生产代码请无视它 —— 真实点击里它由上面的事件代理调用。 */
    _shouldTakeOver: shouldTakeOver,
    /* ⚠️ 只给验证脚本用：报告内部状态。
       为什么需要它：无头浏览器开着虚拟时钟时，"130ms 后显示"这种竞态根本测不准
       （虚拟时间会先把导航走完，再看计时器）—— 只能退一步问"该出场的那次，排上队了吗"。
       生产代码请无视。 */
    _state: function () {
      return {
        hasMask: !!mask,
        on: !!(mask && mask.className.indexOf('is-on') >= 0),
        scheduled: !!showTimer,      /* 已排上队（等出场） */
        delay: SHOW_DELAY_MS
      };
    }
  };
})();
