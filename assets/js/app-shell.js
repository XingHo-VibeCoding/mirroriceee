/* ============================================
   app-shell.js —— 应用外壳的交互（Day 28）
   ------------------------------------------------------------
   管三件事，都不碰页面内部的业务逻辑：
     ① 两边侧栏的开合（只在窄屏成立；宽屏两栏常驻，这里什么都不做）
     ② 右侧「个人账号」面板：登录态是真接口（/api/auth/me），不再是写死的数据
     ③ 顶栏头像上的字：跟着登录态变 —— 登录显示用户名首字，未登录显示小人图标
        （⚠️ 斌哥 2026-10-13 指示：头像不要写死 —— 所以 HTML 里那个位置是空的，
           由这里的 paintAvatar() 填，页面加载前那 0.1 秒它是空的不是「斌」）

   ⚠️ 引用顺序：本文件依赖 common.js 里的 loadJSON / failureHTML / escapeHTML，
      页面上必须 common.js 在前、本文件在后。
   ⚠️ 术语备注：
      localStorage —— 浏览器自带的"本地小仓库"，关掉网页数据还在。
                      存 token 用它。⚠️ 它没有过期机制，所以过期判定靠后端
                      （/me 回 401 时这里把 token 扔掉），不在前端记时间。
      fetch —— 浏览器自带的"发请求"函数（common.js 的 loadJSON 底下也是它）
   ============================================ */

(function () {
  'use strict';

  var DESKTOP_QUERY = '(min-width: 1080px)';

  /* 登录态只存一样：token 本体。用户名不存 —— 以 /api/auth/me 查回来的为准，
     免得"账号换了、界面上还是旧的"这种两套账。 */
  var TOKEN_KEY = 'echoread_token';

  /* ⚠️ Day 28 晚：token 除了 localStorage，还要写一份进 cookie —— 这不是冗余，是命门。
     原因（实证）：线上的平台反向代理会把 Authorization 头吃掉，症状是
     「登录成功、token 也拿到了，但之后每次 /api/auth/me 都回 401 = 未登录」。
     实测对照：同一条 token 直连云函数 200、走线上域名 401、加随机查询串破缓存后仍 401。
     cookie 是独立于 header 的通道，浏览器会自动带上；由我们自己的 dev-server 代理
     再从 cookie 补回 Authorization 头转发给云函数（见 dev-server.js 的 proxyToApi）。
     ⚠️ 键名与有效期必须和 dev-server.js 里的 TOKEN_COOKIE 一致 —— 改一处就要改两处。 */
  var TOKEN_COOKIE = 'echoread_token';
  var TOKEN_MAX_AGE = 30 * 24 * 60 * 60;      /* 30 天，与登录态有效期对齐 */

  function writeTokenCookie(t) {
    document.cookie = TOKEN_COOKIE + '=' + (t ? encodeURIComponent(t) : '') +
      '; path=/; max-age=' + (t ? TOKEN_MAX_AGE : 0) + '; SameSite=Lax';
  }

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) {
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      writeTokenCookie(t);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      writeTokenCookie('');
    }
  }

  /* ============================================
     「上次确认过的我是谁」本地缓存（Day 32 补）
     ------------------------------------------------------------
     为什么要有：右栏账号卡原本必须等 /api/auth/me 回来才画 ——
       左栏列表在 DOMContentLoaded 就入场了，右栏却要等一次网络往返
       （线上实测 0.2~2 秒），于是右边永远"晚半拍才出现"。
     做法：把上一次校验通过的 user 连 token 一起存下来。
       · 页面一加载就能立刻画出右栏 → 与左栏同一时刻入场；
       · 真正的校验挪到后台照做，用户名变了再重画（见 renderAccount）。
     ⚠️ 读的时候必须比对 token —— 换号登录后若只认 user 不认 token，
        就会拿旧用户名冒充新账号，那是比"晚半拍"严重得多的事故。
     ⚠️ 这不是登录态的一部分：登录是否有效永远由后端说了算，
        这份缓存只管"先画什么"，401 一到整份作废。
     ============================================ */
  var USER_CACHE_KEY = 'echoread_user_cache';

  function readUserCache(token) {
    if (!token) return null;
    try {
      var raw = localStorage.getItem(USER_CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.token !== token || !o.user || !o.user.username) return null;
      return o.user;
    } catch (e) {
      return null;          /* 存的内容坏了就当没有，别让整块面板跟着挂 */
    }
  }

  function writeUserCache(token, user) {
    try {
      if (token && user && user.username) {
        localStorage.setItem(USER_CACHE_KEY, JSON.stringify({ token: token, user: user }));
      } else {
        localStorage.removeItem(USER_CACHE_KEY);
      }
    } catch (e) {
      /* 隐私模式 / 存满写不进去：不影响功能，顶多退回到"等接口" */
    }
  }

  /* ============================================
     一、侧栏开合
     ============================================ */

  var mql = window.matchMedia ? window.matchMedia(DESKTOP_QUERY) : null;

  function isDesktop() {
    return !!(mql && mql.matches);
  }

  function btnLeft()  { return document.getElementById('btn-left'); }
  function btnRight() { return document.getElementById('btn-right'); }

  /* 把两个按钮的 aria-expanded 与当前状态对齐。
     ⚠️ 读屏软件靠这个属性知道"抽屉是开是关"，视觉上开没开它看不见。 */
  function syncExpanded() {
    var l = btnLeft();
    var r = btnRight();
    if (l) l.setAttribute('aria-expanded', String(document.body.classList.contains('left-open')));
    if (r) r.setAttribute('aria-expanded', String(document.body.classList.contains('right-open')));
  }

  function closeDrawers() {
    document.body.classList.remove('left-open', 'right-open');
    document.documentElement.classList.remove('drawer-open');
    if (isDesktop()) {
      /* 宽屏两栏是常驻的，语义上一直是"展开" */
      var r = btnRight();
      if (r) r.setAttribute('aria-expanded', 'true');
    } else {
      syncExpanded();
    }
  }

  /* 开一边就关另一边 —— 窄屏放不下两个抽屉，这是要求里写死的一条。
     ⚠️ 所以这里的 toggle 不是单纯的开关，是"三态"：
        没开 → 开这个；开的是它 → 关掉；开的是对面 → 换成这个。 */
  function toggleDrawer(side) {
    if (isDesktop()) return;                 /* 宽屏不需要开合，点了当没点 */

    var mine  = side === 'left' ? 'left-open'  : 'right-open';
    var other = side === 'left' ? 'right-open' : 'left-open';

    var willOpen = !document.body.classList.contains(mine);

    document.body.classList.remove(other);
    document.body.classList.toggle(mine, willOpen);
    /* 抽屉开着的时候锁掉底下的页面滚动，免得手指一滑把背景滚跑了 */
    document.documentElement.classList.toggle('drawer-open', willOpen);
    syncExpanded();
  }

  /* 宽窄切换时把抽屉状态清干净：
     手机开着抽屉 → 转成桌面宽度，抽屉的 transform 被 CSS 撤掉，
     但 body 上那个 left-open 还挂着，转回手机时会莫名其妙自己开着。 */
  function applyMode() {
    if (isDesktop()) {
      closeDrawers();
    } else {
      syncExpanded();
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    if (el.closest('#btn-left'))  { toggleDrawer('left');  return; }
    if (el.closest('#btn-right')) { toggleDrawer('right'); return; }

    /* 点遮罩 = 关抽屉。遮罩本身不是按钮，但它就是一个"点空白处收起"的区域 */
    if (el.closest('.scrim')) { closeDrawers(); return; }

    /* 抽屉里点了一条板块链接就出发跳页了，但万一被拦下（比如中键、改目标），
       抽屉还开着会挡住新页面 —— 顺手收掉 */
    if (el.closest('.side--left .sidenav__item')) { closeDrawers(); }
  });

  /* Esc 关抽屉 —— 键盘用户的常规预期 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawers();
  });

  if (mql) {
    if (mql.addEventListener) mql.addEventListener('change', applyMode);
    else if (mql.addListener) mql.addListener(applyMode);   /* 老 Safari */
  }

  /* ============================================
     二、顶栏头像（登录态的"门面"）
     ============================================ */

  /* 未登录时头像里的小人图标 —— 一个通用符号，不代表任何人 */
  var AVATAR_GUEST =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="9" r="3.6"/><path d="M5.5 19.5c1.2-3 3.6-4.6 6.5-4.6s5.3 1.6 6.5 4.6"/></svg>';

  /* 登录后的头像：统一用这张图（Day 28 晚，斌哥指定）。
     ⚠️ 不再拿用户名首字当头像 —— 之前那版已废。图是资产（assets/img/avatar.png），
        alt 留空：它旁边的 aria-label 已经说了是谁，图本身不重复朗读。 */
  var AVATAR_USER = '<img class="avatar-img" src="assets/img/avatar.png" alt="">';

  /* 把头像画上去。user 为空（未登录）→ 小人图标；登录 → 统一头像图。 */
  function paintAvatar(user) {
    var btn = btnRight();
    if (!btn) return;
    if (user && user.username) {
      btn.innerHTML = AVATAR_USER;
      btn.setAttribute('aria-label', '账号：' + user.username);
    } else {
      btn.innerHTML = AVATAR_GUEST;
      btn.setAttribute('aria-label', '打开个人账号');
    }
  }

  /* ============================================
     三、右侧「个人账号」面板（真接口版）
     ============================================ */

  /* 未登录：只给一张卡，一个"登录 / 注册"的门。
     ⚠️ 不摆任何假数据 —— 参考图里的「本周战报 / 最近动态」在统计后端做出来之前
        一律不出现（Day 28 拍板：撤掉，别让真账号旁边躺着死数字）。 */
  function loggedOutHTML() {
    return '<section class="acct-card item">' +
             '<div class="acct-head">' +
               '<span class="acct-avatar" aria-hidden="true">' + AVATAR_GUEST + '</span>' +
               '<div>' +
                 '<p class="acct-name">未登录</p>' +
                 '<p class="acct-sub">登录后这里显示你的账号</p>' +
               '</div>' +
             '</div>' +
             '<a class="btn acct-cta" href="login.html">登录 / 注册</a>' +
           '</section>' +
           /* 没登录也想切游戏配色，所以这张卡照给 */
           themeRowHTML();
  }

  /* 已登录：两张卡片 —— 【个人信息】与【排行榜】分开（斌哥指示）。
     为什么拆：一张卡里塞"我是谁 + 我多久 + 别人多久"三种信息，
     读起来是糊的；分开之后，上面那张回答"我"，下面那张回答"班里"。
     头像统一用 AVATAR_USER 那张图；
     用户名来自 /api/auth/me（后端说了算，前端不记小账）。 */
  function loggedInHTML(user) {
    return '<section class="acct-card item">' +
             '<div class="acct-head">' +
               '<span class="acct-avatar" aria-hidden="true">' + AVATAR_USER + '</span>' +
               '<div>' +
                 '<p class="acct-name">' + escapeHTML(user.username) + '</p>' +
                 /* Day 28 晚：原来这里还有一行「登录保持 30 天，到期需重新登录」，
                    按斌哥指示删掉 —— 账号卡上要的是"你是谁、学了多少"，
                    登录有效期的说明属于系统细节，不该占这一块地方。 */
               '</div>' +
             '</div>' +
             /* 我的学习时长：数字等接口回来再填（先占位「—」，别显示 0 骗人） */
             '<div class="usage">' +
               '<p class="usage-mine">' +
                 '<span class="usage-label">我的学习时长</span>' +
                 '<strong class="usage-value" data-role="my-usage">—</strong>' +
                 '<span class="usage-rank" data-role="my-rank"></span>' +
               '</p>' +
             '</div>' +
             '<button type="button" class="btn acct-logout" data-action="logout">退出登录</button>' +
           '</section>' +
           /* 外观开关：按斌哥要求放在排行榜上方 */
           themeRowHTML() +
           /* 排行榜自己一张卡。⚠️ 固定 5 个栏位（哪怕一个人都没有）：
              位次本身是信息 —— 空着的那几行在说"这位置还没人占"，
              比"榜单只有 1 行"更像一张榜。
              ⚠️ 同时挂 acct-card：两卡之间那档间距由 `.acct-card + .acct-card`
                 统一给（CSS 里已有），别在这里自己写 margin —— 写两处迟早对不齐。 */
           '<section class="acct-card board-card item">' +
             '<p class="board-title">学习时长榜</p>' +
             '<ol class="usage-top" data-role="usage-top"></ol>' +
           '</section>';
  }

  /* 【P0-5】/api/auth/me 取数封装：带超时，且不因「非 JSON」崩掉。
     起因（2026-10-26 线上实测）：平台网关偶尔把 /api/auth/me 回 404 纯文本
     "Not Found"，旧代码 res.json() 直接抛错 → 进 catch → 面板显示
     「登录状态检查失败，请稍后重试」，可 token 明明是好的，纯属吓人。
     改成 res.text() + 手动 JSON.parse：非 JSON 时 data=null，
     由调用方按 status 分流（401 = 真失效；其它 = 平台抖动，重试即可）。 */
  function fetchMe(token, timeoutMs) {
    var opt = { headers: { Authorization: 'Bearer ' + token } };
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      var ctrl = new AbortController();
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 8000);
    }
    function done() { if (timer) { clearTimeout(timer); timer = null; } }
    return fetch('/api/auth/me', opt).then(function (res) {
      return res.text().then(function (t) {
        done();
        var d = null;
        try { d = JSON.parse(t); } catch (e) { d = null; }
        return { status: res.status, data: d, raw: String(t).slice(0, 40) };
      });
    }, function (err) { done(); throw err; });
  }

  /* 主渲染：有 token 就去问后端"我是谁"，没有就直接给未登录的卡。 */
  function renderAccount() {
    var panel = document.getElementById('panel-right');
    if (!panel) return;

    /* 弹簧动效（Day 31）：右栏账号卡与左栏列表同一套收养模式。
       每次 innerHTML 重渲染后都重新 enhance —— 组件内部先销毁旧实例再重建，
       重复调用安全；卡片被 innerHTML 冲掉时，销毁会自动跳过还原。 */
    function enhancePanel() {
      if (window.AnimatedList && typeof AnimatedList.enhance === 'function') {
        AnimatedList.enhance(panel, {
          rowSelector: 'section.acct-card',
          selectOnHover: false,
          enableArrowNavigation: false,
          gap: 0,
          viewportPadding: 0,
          radius: 16,
          scrollable: false
        });
      }
    }

    var token = getToken();
    if (!token) {
      stopUsageHeartbeat();
      writeUserCache('', null);
      panel.innerHTML = loggedOutHTML();
      paintAvatar(null);
      enhancePanel();
      return;
    }

    /* 有 token：先看本地有没有"上次确认过的我"。
       有 → 立刻画出来，右栏和左栏同一时刻入场，后台再核对（见下方 attempt）；
       没有（刚登录完第一次进页面）→ 才退回"正在检查登录状态…"占位。
       ⚠️ 这里不启动心跳：心跳代表"正在上报时长"，必须等后端确认登录有效才敢开。
          （缓存只负责长得快，不负责替后端说话。） */
    var cached = readUserCache(token);
    if (cached) {
      panel.innerHTML = loggedInHTML(cached);
      paintAvatar(cached);
      enhancePanel();
    } else {
      panel.innerHTML = '<p class="empty">正在检查登录状态…</p>';
      enhancePanel();
    }

    /* 失败重试 1 次。GET 是幂等的，重试没有副作用；
       只重试「非 401 的异常」，401 说明 token 真失效了，重试一百次也没用。 */
    function attempt(left) {
      fetchMe(token, 8000).then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          var user = r.data.data.user;
          writeUserCache(token, user);
          /* 缓存命中且用户名没变 → 面板开局就画好了，这里别再冲一遍 innerHTML：
             重画 = 右栏二次入场，看起来正是"晚了半拍才出现"。
             只有「没缓存」或「账号换了」（另一台设备改过名）才重画一次。 */
          if (!cached || cached.username !== user.username) {
            panel.innerHTML = loggedInHTML(user);
            enhancePanel();
          }
          paintAvatar(user);
          startUsageHeartbeat();            /* Day 28：登录态确认了，开始记时长 + 拉榜单 */
          return;
        }
        if (r.status === 401) {
          /* 401（没登录/过期/假 token）→ token 已经没用，扔掉，回到未登录的样子。
             ⚠️ 不弹"登录已过期"打扰人 —— 下次要进账号自然会重新登录。 */
          stopUsageHeartbeat();
          setToken('');
          writeUserCache('', null);        /* token 都作废了，缓存里的 user 更不能留 */
          panel.innerHTML = loggedOutHTML();
          paintAvatar(null);
          enhancePanel();
          return;
        }
        /* 404 / 500 / 非 JSON / 200 但 ok:false —— 都不是「未登录」，是这一次没拿到 */
        throw new Error('auth/me 异常：' + r.status + ' ' + (r.raw || ''));
      }).catch(function (err) {
        console.error(err);
        if (left > 0) { setTimeout(function () { attempt(left - 1); }, 600); return; }
        /* 有缓存兜着：人已经看到账号卡了，就别把它换成一张错误卡 ——
           网络抖一下不该让界面往回退。真相留在控制台，重试留给下一次进页面。 */
        if (cached) return;
        /* 重试也没成：token 留着（网络问题 ≠ 未登录），文案说清不是登录失效 */
        stopUsageHeartbeat();
        panel.innerHTML = '<section class="acct-card item">' +
                            '<p class="empty">网络不稳，账号信息暂时读不到（不影响已登录状态）。</p>' +
                            '<button type="button" class="btn acct-logout" data-action="retry-account">重试</button>' +
                          '</section>';
        paintAvatar(null);
        enhancePanel();
      });
    }
    attempt(1);
  }

  /* 退出登录：把 token 交给后端作废（删 sessions 那一行），本地清掉，面板重画。
     ⚠️ 后端那一步失败也不拦着 —— 本地 token 一扔，这个浏览器就算退出了；
        服务端残留的那行死会话等它自己 30 天过期，无害。 */
  function doLogout() {
    var token = getToken();
    /* ⚠️ Day 28：先把这一段的复读时长交上去再走 —— 顺序反了就白听了。
       （flushUsage 自己在 401 时会清 token，那是另一码事。） */
    flushUsage(false);
    stopUsageHeartbeat();
    setToken('');
    writeUserCache('', null);           /* 退出登录：缓存里的用户名也一起清掉 */
    renderAccount();
    if (!token) return;
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token }
    }).catch(function (err) { console.error('退出请求失败（本地已退出）:', err); });
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    if (el.closest('[data-action="logout"]'))        { doLogout();      return; }
    if (el.closest('[data-action="retry-account"]')) { renderAccount(); return; }
  });

  /* ============================================
     四、复读时长：心跳上报 + 榜单（Day 28）
     ------------------------------------------------------------
     分工：**player.js 负责记账**（只在放音时累加秒数），
           这里负责"按点儿交账"（心跳上报）和"把成绩显示出来"（榜单）。
     为什么不在 player.js 里直接发请求：那个文件只管播放，一沾网络就难测；
     反过来这里也不该去碰音频状态 —— 各管一段，边界清楚。

     ⚠️ 三个必须处理的意外（少一个就会丢时长或骗用户）：
       ① 关页 / 切后台：最后一笔赶不上定时器 → 用 keepalive 请求补发
       ② 上报失败（断网 / 401）：把秒数**退回 player 的账本**，下个周期再报，
          不能"报失败就当报过了" —— 那是凭空吞掉用户的学习时长
       ③ 重复上报：服务端已封顶（min(180, 间隔+90)），前端这边只交整秒，
          零头留在本地，长跑不丢精度
     ============================================ */

  var USAGE_INTERVAL_MS = 60000;   /* 心跳周期：60 秒（与服务端 180 秒上限配套） */
  var usageTimer = null;
  var lastBoardAt = 0;             /* 上次拉榜单的时刻（做节流用） */
  var BOARD_THROTTLE_MS = 5 * 60 * 1000;

  /* 秒 → 人话。榜上都是"几分钟"起步，所以到小时才显示小时。 */
  function fmtDuration(sec) {
    sec = Math.floor(sec || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + s + ' 秒';
    return s + ' 秒';
  }

  /* 只改数字，不整块重画账号卡 —— 重画会把榜单刷掉、让读屏软件重念一遍 */
  function paintMyUsage(totalSeconds) {
    var box = document.querySelector('[data-role="my-usage"]');
    if (box) box.textContent = fmtDuration(totalSeconds);
  }

  /* 把 player 账本里的秒数交给服务端。
     keepalive=true 用于"正在关页面"的那一次 —— 请求能在页面消失后继续发出去。 */
  function flushUsage(keepalive) {
    var token = getToken();
    if (!token || !window.Player || !window.Player.takeUsageSeconds) return;

    var secs = window.Player.takeUsageSeconds();
    if (secs <= 0) return;                 /* 这一分钟没在放音 → 不打扰服务端 */

    fetch('/api/usage/beat', {
      method: 'POST',
      keepalive: !!keepalive,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify({ seconds: secs })
    })
      .then(function (res) {
        return res.json().then(function (d) { return { status: res.status, d: d }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.d && r.d.ok) {
          paintMyUsage(r.d.data.totalSeconds);
          refreshBoardIfStale();
          return;
        }
        /* ⚠️ 401：token 失效了 —— 把它扔掉、退回未登录态（与 /me 的处理一致），
           但**不把秒数退回去**：这个号的登录态已经作废，退回去也只是躺在内存里。 */
        if (r.status === 401) {
          setToken('');
          renderAccount();
          return;
        }
        throw new Error('上报未成功: ' + r.status);
      })
      .catch(function (err) {
        console.error('复读时长上报失败，先退回本地，下个周期再报:', err);
        window.Player.addBackUsage(secs);
      });
  }

  /* 拉榜单（前五 + 我的名次）。⚠️ 做 5 分钟节流：
     每次心跳都拉一遍 = 每个用户每分钟 2 次请求，免费版经不起这么花，
     而榜单本来也不需要秒级新鲜。 */
  function refreshBoardIfStale(force) {
    var nowMs = Date.now();
    if (!force && nowMs - lastBoardAt < BOARD_THROTTLE_MS) return;
    lastBoardAt = nowMs;
    loadLeaderboard();
  }

  function loadLeaderboard() {
    var token = getToken();
    var list = document.querySelector('[data-role="usage-top"]');
    if (!token || !list) return;

    fetch('/api/usage/leaderboard?limit=5', {
      headers: { Authorization: 'Bearer ' + token }
    })
      .then(function (res) {
        return res.json().then(function (d) { return { status: res.status, d: d }; });
      })
      .then(function (r) {
        if (r.status !== 200 || !r.d || !r.d.ok) {
          list.innerHTML = '<li class="usage-empty">榜单暂时读不到</li>';
          return;
        }
        /* ⚠️ data 可能缺（服务端版本错位 / 网关回了个空壳 JSON）：
           直接取 r.d.data.me 会抛 TypeError，把整个榜单打成"读不到"。
           兜底成空对象，最差就是榜单空位，不至于报错。 */
        var payload = r.d.data || {};
        var me = payload.me || { totalSeconds: 0, rank: null };
        paintMyUsage(me.totalSeconds);
        var rankBox = document.querySelector('[data-role="my-rank"]');
        if (rankBox) rankBox.textContent = me.rank ? ('第 ' + me.rank + ' 名') : '榜外';

        var top = payload.top || [];
        list.innerHTML = buildBoardRows(top);
      })
      .catch(function (err) {
        console.error('榜单读取失败:', err);
        list.innerHTML = '<li class="usage-empty">榜单暂时读不到</li>';
      });
  }

  /* 榜单固定 5 个栏位：有数据就填，没有就摆一个空位（"哪怕没有人"——斌哥要求）。
     ⚠️ 名次的强弱用【两处】同时表达：数字徽标 + 名字的粗细/颜色。
        只染一处的话，色觉差异或黑白屏幕上就读不出名次了 ——
        颜色可以当装饰，但不能当唯一的信息载体。
     ⚠️ 空位不写"还没有人"这种整句：榜上 3 个空位连排会变成三段废话；
        「虚位以待」+ 破折号，一眼扫过去就知道"这位置空着"。 */
  var BOARD_SLOTS = 5;

  function buildBoardRows(top) {
    var html = '';
    for (var i = 0; i < BOARD_SLOTS; i++) {
      var t = top[i];
      var rank = i + 1;
      /* ⚠️ 只有【真有人在位】的前三名才加 is-rank-N：
         空位不该继承名次强调 —— 否则"第 3 名是空的"会被染成和真人一样的强调，
         而且两个 class 谁压谁全看 CSS 里的书写顺序（靠顺序赢的样式，早晚被人挪乱）。 */
      var cls = 'usage-row' +
                (t && rank <= 3 ? ' is-rank-' + rank : '') +
                (t ? '' : ' is-empty');
      /* ⚠️ 用户名走 escapeHTML —— 用户自己起的名字，直接拼进 innerHTML 等于开门揖盗 */
      var name = t ? escapeHTML(t.username) : '虚位以待';
      var time = t ? fmtDuration(t.totalSeconds) : '—';
      html += '<li class="' + cls + '">' +
                '<span class="usage-row__rank">' + rank + '</span>' +
                '<span class="usage-row__name">' + name + '</span>' +
                '<span class="usage-row__time">' + time + '</span>' +
              '</li>';
    }
    return html;
  }

  function startUsageHeartbeat() {
    if (usageTimer) return;
    usageTimer = setInterval(function () { flushUsage(false); }, USAGE_INTERVAL_MS);
    lastBoardAt = 0;
    refreshBoardIfStale(true);
  }

  function stopUsageHeartbeat() {
    if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
  }

  /* 关页 / 切后台：最后一笔用 keepalive 补发。
     ⚠️ 两个事件都挂是有意的 —— visibilitychange 覆盖"切标签/锁屏"，
        pagehide 覆盖"真的关掉/跳走"，各家浏览器触发时机不一致，双保险不冲突
        （flushUsage 取走秒数后就归零，重复触发不会重复上报）。 */
  function flushOnLeave() {
    if (document.visibilityState === 'hidden') flushUsage(true);
  }
  document.addEventListener('visibilitychange', flushOnLeave);
  window.addEventListener('pagehide', function () { flushUsage(true); });

  /* 外观开关（三态：浅色 / 深色 / 跟随系统）—— 放在右栏「学习时长榜」上方（斌哥指定位置）。
     ⚠️ 这里【只负责把按钮画出来】。切换逻辑、状态记忆、跟随系统都归 assets/js/theme.js：
        那份必须放在 <head> 里先跑（不然暗色用户每次进来先白闪一下），
        逻辑在两边各写一份就是两套账，迟早不一致。 */
  function themeRowHTML() {
    return '<section class="acct-card item theme-row">' +
             '<p class="theme-row__label">外观</p>' +
             '<div class="theme-seg" role="group" aria-label="外观切换">' +
               '<button type="button" class="theme-seg__btn" data-theme-mode="light" aria-pressed="false">浅色</button>' +
               '<button type="button" class="theme-seg__btn" data-theme-mode="dark" aria-pressed="false">深色</button>' +
               '<button type="button" class="theme-seg__btn" data-theme-mode="system" aria-pressed="false">跟随系统</button>' +
             '</div>' +
             /* 配色（Day 31 晚二改）：冷暖两选，浅色/暗色各有一套配方 ——
                冷 = 冷白/石墨蓝灰，暖 = 象牙暖白/暖炭灰。深色下色卡照常显示。 */
             '<div class="tint-row" role="group" aria-label="配色">' +
               '<span class="tint-row__label">配色</span>' +
               '<button type="button" class="tint-card" data-tint-mode="cool" aria-pressed="false" title="冷：冷白（浅）/ 石墨蓝灰（暗）">' +
                 '<span class="tint-card__swatch tint-card__swatch--cool" aria-hidden="true"></span>冷' +
               '</button>' +
               '<button type="button" class="tint-card" data-tint-mode="warm" aria-pressed="false" title="暖：象牙暖白（浅）/ 暖炭灰（暗）">' +
                 '<span class="tint-card__swatch tint-card__swatch--warm" aria-hidden="true"></span>暖' +
               '</button>' +
             '</div>' +
           '</section>';
  }

  /* ============================================
     启动
     ============================================ */
  document.addEventListener('DOMContentLoaded', function () {
    applyMode();
    renderAccount();
  });

  /* 给 login.js 用的小接口：登录成功要存 token，实现只留一份。
     ⚠️ 为什么不留着 login.js 里那句裸 localStorage.setItem ——
        token 现在同时要进 localStorage 和 cookie（线上登录态的关键，见上面注释），
        两处各写一遍，迟早会漏掉 cookie 那一份。 */
  window.EchoToken = { set: setToken, get: getToken };
})();
