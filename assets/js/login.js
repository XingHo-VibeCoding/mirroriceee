/* ============================================
   login.js —— 登录 / 注册页的交互（Day 28）
   ------------------------------------------------------------
   只干四件事：
     ① 登录 / 注册两个 tab 来回切（同一个页面，两种表单）
     ② 注册：拉验证码图（点图换一张）→ 提交注册
     ③ 登录：提交 → 拿到 token 存进 localStorage → 回首页
     ④ 失败：把后端给的那句人话（message）原样亮出来，不自己编文案
   ⚠️ 引用顺序：common.js → app-shell.js → 本文件（要用 escapeHTML）。
   ============================================ */

(function () {
  'use strict';

  /* ---- 状态位：成功 / 失败的话都写在这一个地方（role="alert" 会主动播报）---- */
  function setStatus(text, kind) {
    var box = document.getElementById('auth-status');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'form-status' + (kind ? ' form-status--' + kind : '');
  }

  /* ============================================
     失败原因的「说人话」（Day 33 加）
     ------------------------------------------------------------
     ⚠️ 原来两个 catch 都只写「网络连不上，请检查网络」——这句话害人不浅：
        它把三种完全不同的故障说成同一句，而且把锅指向「你的网」。实际多半是
        ① 页面开在了没有后端的那条链路上（静态托管 / 本地文件），
        ② 服务端回的不是 JSON（网关超时页、404 页），
        ③ 真·网络层失败 —— 这三种处置方式完全不同。

     拆法：
       · readJson：先看 content-type。不是 JSON 就抛出**带 HTTP 状态码**的错误，
         文案里直接亮出来（这才叫证据；原来 res.json() 一崩，状态码就丢了）。
       · failText：把「当前域名 + 归因 + 原始错误」拼成一句话。
         域名必须出现在文案里 —— 页面两域长得一模一样，不看域名根本分不清。 */

  function readJson(res) {
    var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (ct.indexOf('application/json') === -1) {
      return res.text().then(function (body) {
        var brief = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        throw new Error('HTTP ' + res.status + ' 返回的不是 JSON：' + brief);
      });
    }
    return res.json().then(function (d) { return { status: res.status, d: d }; });
  }

  function failText(err, action) {
    var detail = (err && err.message) ? err.message : String(err);
    var host = location.host || '(本地文件)';
    var hint;
    if (location.protocol === 'file:') {
      hint = '页面是双击本地文件打开的，接口走不通';
    } else if (/(^|\.)tcloudbaseapp\.com$/i.test(location.hostname)) {
      hint = '当前在 CloudBase 静态托管域，接口要走云函数；建议改用 echoread.app.workbuddy.host';
    } else if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(detail)) {
      hint = '请求没到服务端（被拦截、跨域拒绝或断网）';
    } else {
      hint = '服务端回的不是 JSON（多半是网关超时页），再点一次通常就好';
    }
    return action + '没成功｜' + host + '｜' + hint + '｜' + detail.slice(0, 90);
  }

  /* ---- Tab 切换：两个面板换着显示，地址栏不动 ----
     ⚠️ 切换的是【表单】（form-login / form-register），不是 tab 按钮本身。
        原函数误操作了 tab-login / tab-register 两个按钮 —— 结果是
        "点 tab 表单不切、反去隐藏 tab 按钮"。Day 26 修正。 */
  function showTab(name) {
    var loginForm = document.getElementById('form-login');
    var regForm   = document.getElementById('form-register');
    var loginTab  = document.getElementById('tab-login');
    var regTab    = document.getElementById('tab-register');
    if (!loginForm || !regForm) return;

    var isLogin = (name === 'login');
    loginForm.hidden = !isLogin;
    regForm.hidden   = isLogin;

    if (loginTab) loginTab.setAttribute('aria-selected', String(isLogin));
    if (regTab)   regTab.setAttribute('aria-selected', String(!isLogin));
    setStatus('');
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var tab = el.closest('[data-tab]');
    if (tab) { showTab(tab.getAttribute('data-tab')); }
  });

  /* ============================================
     邀请码（Day 26 起替代图片验证码）
     ------------------------------------------------------------
     ⚠️ 音频有版权，注册门槛改成「开发者发放的邀请码」：
        不是所有人都能注册。这里不再拉验证码图，注册时直接带邀请码。 */

  /* ============================================
     注册提交
     ============================================ */
  document.addEventListener('submit', function (e) {
    var form = e.target;

    /* ---------- 注册 ---------- */
    if (form.id === 'form-register') {
      e.preventDefault();
      var username = form.username.value.trim();
      var password = form.password.value;
      var code     = form.inviteCode.value.trim();

      if (!code) {
        setStatus('请填写邀请码（向开发者获取）。', 'error');
        return;
      }

      setStatus('正在注册…');
      fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, inviteCode: code })
      })
        .then(readJson)
        .then(function (r) {
          if (r.status === 201 && r.d && r.d.ok) {
            /* 注册成功 ≠ 登录成功（这是两条路）。切到登录 tab，用户名替他填好。
               ⚠️ 顺序有讲究：showTab 内部会 setStatus('')，所以「注册成功」这句
                  必须放在它【之后】。原来的顺序是反的 —— 提示一设上就被清空，
                  用户注册完看到的是空白状态栏，以为没成。
               ⚠️ 下面的界面收尾一律包 try：账号这时【已经建好了】，
                  万一 focus/setAttribute 之类抛错冒到外层 catch，
                  用户会看到「注册没成功」而重复注册，最容易坑人的地方。 */
            showTab('login');
            setStatus('注册成功，请登录。', 'ok');
            try {
              var f = document.getElementById('form-login');
              if (f) {
                f.username.value = username;
                f.password.value = '';
                if (f.password.focus) f.password.focus();
              }
            } catch (uiErr) {
              console.error('[register] 成功后的界面收尾出错（不影响注册结果）', uiErr);
            }
          } else if (r.status >= 500 || /TIME_LIMIT_EXCEEDED/i.test((r.d && r.d.code) || '')) {
            /* ⚠️ 免费体验版云函数 3 秒硬超时（不可调）。实测复现过：
               注册返回 `504 FUNCTIONS_TIME_LIMIT_EXCEEDED`，但**账号其实已经写进库了** ——
               同一秒再注册一遍会得到 `409 username_taken`。
               所以这里绝不能只说「失败」：用户会以为没成，重试撞「用户名已被注册」，
               然后就彻底懵了（"我到底注册成功没有？"）。
               处置：直接切到登录 tab、把用户名填好，让他去登录验证。 */
            showTab('login');
            setStatus('服务端 3 秒超时了，但这个账号很可能已经建好。请直接用同一个用户名登录试试，别重复注册。', 'error');
            try {
              var f2 = document.getElementById('form-login');
              if (f2) {
                f2.username.value = username;
                if (f2.password.focus) f2.password.focus();
              }
            } catch (uiErr2) {
              console.error('[register] 超时后的界面收尾出错', uiErr2);
            }
          } else {
            setStatus((r.d && r.d.message) || '注册失败，请稍后再试。', 'error');
          }
          form.inviteCode.value = '';
        })
        .catch(function (err) {
          console.error(err);
          setStatus(failText(err, '注册'), 'error');
        });
      return;
    }

    /* ---------- 登录 ---------- */
    if (form.id === 'form-login') {
      e.preventDefault();
      setStatus('正在登录…');
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value })
      })
        .then(readJson)
        .then(function (r) {
          if (r.status === 200 && r.d && r.d.ok && r.d.data.token) {
            /* ⚠️ Day 28 晚：改走 app-shell.js 暴露的 EchoToken.set ——
               它同时写 localStorage（本地用）和 cookie（线上用）。
               线上平台反向代理会吃掉 Authorization 头，cookie 是用来把身份带过去的
               唯一通道（详见 dev-server.js 里 proxyToApi 的注释）。
               别改回裸 localStorage.setItem：那样线上会一直显示"未登录"。 */
            if (window.EchoToken && window.EchoToken.set) {
              window.EchoToken.set(r.d.data.token);
            } else {
              localStorage.setItem('echoread_token', r.d.data.token);
            }
            setStatus('登录成功，正在回到跟读页…', 'ok');
            /* Day 29：这一跳是脚本自己发起的，点击拦截管不到 —— 手动叫起切页动画。
               没有它，登录成功后会有半秒"按了没反应"的空档。 */
            if (window.PageLoader) window.PageLoader.show();
            setTimeout(function () { window.location.href = 'index.html'; }, 400);
          } else if (r.status >= 500 || /TIME_LIMIT_EXCEEDED/i.test((r.d && r.d.code) || '')) {
            /* 同注册：3 秒硬超时。登录是只读操作，重试无副作用，直接让他再点一次。 */
            setStatus('服务端 3 秒超时了，再点一次「登录」通常就好。', 'error');
          } else {
            setStatus((r.d && r.d.message) || '登录失败，请稍后再试。', 'error');
          }
        })
        .catch(function (err) {
          console.error(err);
          setStatus(failText(err, '登录'), 'error');
        });
    }
  });

  /* 邀请码制：注册页不再需要预拉验证码图，页面加载即就绪 */
})();
