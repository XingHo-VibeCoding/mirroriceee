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
        .then(function (res) { return res.json().then(function (d) { return { status: res.status, d: d }; }); })
        .then(function (r) {
          if (r.status === 201 && r.d && r.d.ok) {
            /* 注册成功 ≠ 登录成功（这是两条路）。切到登录 tab，用户名替他填好。 */
            setStatus('注册成功，请登录。', 'ok');
            showTab('login');
            var f = document.getElementById('form-login');
            if (f) f.username.value = username;
            f.password.value = '';
            f.password.focus();
          } else {
            setStatus((r.d && r.d.message) || '注册失败，请稍后再试。', 'error');
          }
          form.inviteCode.value = '';
        })
        .catch(function (err) {
          console.error(err);
          setStatus('网络连不上，注册没提交出去，请检查网络后重试。', 'error');
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
        .then(function (res) { return res.json().then(function (d) { return { status: res.status, d: d }; }); })
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
          } else {
            setStatus((r.d && r.d.message) || '登录失败，请稍后再试。', 'error');
          }
        })
        .catch(function (err) {
          console.error(err);
          setStatus('网络连不上，登录没提交出去，请检查网络后重试。', 'error');
        });
    }
  });

  /* 邀请码制：注册页不再需要预拉验证码图，页面加载即就绪 */
})();
