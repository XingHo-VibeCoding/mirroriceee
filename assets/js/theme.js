/* 明暗主题 · 三态（浅色 / 深色 / 跟随系统）—— 主应用共用这一份
 *
 * 为什么它不做成 defer、而是 <head> 里同步加载：
 *   主题必须在【样式生效之前】贴到 <html> 上。晚一步，用暗色的人每次进来都会先白闪一下。
 *   全站只有这一个脚本值得阻塞渲染，它也就 3KB。
 *
 * 存储：localStorage['er_theme']，取值 'light' | 'dark' | 'system'，缺省 'light'。
 *   旧键 er_games_theme（上一版只有浅/深两态）仍读一次，用来迁移老设置。
 *
 * 作用范围：整站。主应用的暗色配方在 style.css / app-shell.css 的
 *   html[data-theme='dark'] 块里；四个单词小游戏页是独立页面，
 *   它们各自 <head> 里有一小段同样的判定（不依赖本文件，因为那几页不引 assets/）。
 */
(function () {
  'use strict';

  var KEY = 'er_theme';
  var OLD_KEY = 'er_games_theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    var v = null;
    try { v = localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY); } catch (e) { /* 隐私模式 */ }
    return (v === 'dark' || v === 'light' || v === 'system') ? v : 'light';
  }

  /* 'system' 要落到具体的明暗上；其余两态就是它自己 */
  function resolve(mode) {
    if (mode === 'system') return (mq && mq.matches) ? 'dark' : 'light';
    return mode;
  }

  /* 把按下态同步到按钮上。按钮是右栏动态渲染出来的，所以只按属性找，
     不缓存节点引用 —— 缓存了面板一重绘就指向已经不在页面上的旧节点。 */
  function sync(mode) {
    var btns = document.querySelectorAll('[data-theme-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed',
        btns[i].getAttribute('data-theme-mode') === mode ? 'true' : 'false');
    }
  }

  function paint() {
    var mode = read();
    if (resolve(mode) === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    sync(mode);
  }

  function setMode(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* 写不进去也能切，只是记不住 */ }
    paint();
  }

  /* 事件委托：右栏每次重绘都会换成新按钮，绑在节点上的监听会跟着失效 */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-theme-mode]') : null;
    if (btn) setMode(btn.getAttribute('data-theme-mode'));
  });

  /* 选「跟随系统」时，系统换了配色要立刻跟上，不能等刷新 */
  if (mq) {
    var onChange = function () { if (read() === 'system') paint(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);   /* 老 Safari */
  }

  /* 面板重绘后按钮的按下态会丢，用 MutationObserver 补回来（只盯 #panel-right） */
  function watchPanel() {
    var panel = document.getElementById('panel-right');
    if (!panel || !window.MutationObserver) return;
    new MutationObserver(function () { sync(read()); })
      .observe(panel, { childList: true, subtree: true });
  }

  paint();                      /* 第一帧就定，避免白闪 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paint(); watchPanel(); });
  } else {
    watchPanel();
  }

  /* 给别处用的小接口（登录页/调试用） */
  window.EchoTheme = { set: setMode, get: read, apply: paint };
})();
