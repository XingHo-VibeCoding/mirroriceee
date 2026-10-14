/* ============================================
   guard.js —— 登录门禁（Day 26）
   ------------------------------------------------------------
   版权原因：不登录不能进学习网站。本脚本在【未登录 / 登录失效】时立即回登录页。
   ⚠️ 只在【学习页】引入（index / vocab / writing），login.html 绝不能引 ——
      否则未登录时 login.html 会把自己弹回去，死循环。
   ⚠️ 诚实边界：这是「前门锁」，挡的是"没登录就用浏览器正常访问"的人；
      音频文件本身仍是静态文件（assets/audio/*.mp3），知道地址的人能直接下载。
      要真正防下载得靠后端鉴权 + 加密流，当前静态站架构做不到。
   ⚠️ 放在 <head> 里、页面解析前执行 —— 未登录时页面内容不会先闪一下再跳走。
   ============================================ */
(function () {
  'use strict';

  var TOKEN_KEY = 'echoread_token';
  var LOGIN_URL = 'login.html';

  /* 取登录令牌：先看 localStorage（本地/主存），再兜底看 cookie
     （线上平台反向代理会吃掉 Authorization 头，token 靠 cookie 带过去，见 app-shell.js） */
  function readToken() {
    var t = '';
    try { t = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (!t) {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + TOKEN_KEY + '=([^;]*)'));
      if (m) t = decodeURIComponent(m[1]);
    }
    return t;
  }

  function toLogin() {
    /* replace 而非 href：不留历史，免得用户按返回又弹一次 */
    window.location.replace(LOGIN_URL);
  }

  var token = readToken();

  /* ① 根本没登录 → 立即回登录页（同步，页面内容不闪现） */
  if (!token) { toLogin(); return; }

  /* ② 有 token，再验一下是不是真的（过期 / 伪造的也挡回去）。
        异步进行：验通过前页面照常显示，验失败再跳；断网不跳 —— 断网 ≠ 未登录。 */
  fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
    .then(function (res) {
      if (res.status === 401) {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        toLogin();
      }
    })
    .catch(function () { /* 网络问题：放行，交给页面自己的逻辑提示 */ });
})();
