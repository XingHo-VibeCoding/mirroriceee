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

  /* ---- Tab 切换：两个面板换着显示，地址栏不动 ---- */
  function showTab(name) {
    var login = document.getElementById('tab-login');
    var reg   = document.getElementById('tab-register');
    if (!login || !reg) return;

    var isLogin = (name === 'login');
    login.hidden = !isLogin;
    reg.hidden   = isLogin;

    login.setAttribute('aria-selected', String(isLogin));
    reg.setAttribute('aria-selected', String(!isLogin));
    setStatus('');
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var tab = el.closest('[data-tab]');
    if (tab) { showTab(tab.getAttribute('data-tab')); }
  });

  /* ============================================
     验证码
     ============================================ */

  var currentCaptchaId = '';

  function loadCaptcha() {
    var box = document.getElementById('captcha-box');
    if (!box) return;

    box.innerHTML = '<span class="empty">验证码加载中…</span>';
    currentCaptchaId = '';

    fetch('/api/auth/captcha')
      .then(function (res) { return res.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.message) || '验证码获取失败');
        currentCaptchaId = d.data.captchaId;
        /* svg 是后端画的整张图，直接插进容器。
           ⚠️ 内容来自我们自己的云函数（四个固定字符集 + 固定模板），不是用户输入。 */
        box.innerHTML = d.data.svg;
      })
      .catch(function (err) {
        console.error(err);
        box.innerHTML = '<span class="empty">验证码加载失败，点这里重试</span>';
      });
  }

  /* 点验证码图 = 换一张（看不清是常态，别让人刷新整个页面） */
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('#captcha-box')) {
      loadCaptcha();
    }
  });

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
      var code     = form.captchaCode.value.trim();

      if (!currentCaptchaId) {
        setStatus('验证码还没加载好，点一下验证码图换一张。', 'error');
        return;
      }

      setStatus('正在注册…');
      fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, captchaId: currentCaptchaId, captchaCode: code })
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
          /* 不管成没成，验证码都算"用过了"（或快过期了）—— 换一张最稳 */
          loadCaptcha();
          form.captchaCode.value = '';
        })
        .catch(function (err) {
          console.error(err);
          setStatus('网络连不上，注册没提交出去，请检查网络后重试。', 'error');
          loadCaptcha();
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

  document.addEventListener('DOMContentLoaded', function () {
    /* 注册 tab 在下面藏着，但验证码先拉好 —— 切过去不用等 */
    loadCaptcha();
  });
})();
