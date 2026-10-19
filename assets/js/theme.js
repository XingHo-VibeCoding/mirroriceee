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
  /* 配色变体（Day 32 改）：'cool'（缺省，冷白/石墨蓝灰 —— 冷调贴品牌深蓝 #1a2c73）
     | 'warm'（象牙暖白+橙光斑，Day 31 晚那一版，现在是可选档） */
  var TINT_KEY = 'er_tint';
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

  /* ---------- 配色变体（Day 31 晚建，Day 32 改默认）----------
     'cool' = 冷白（html[data-tint='cool']）—— 【现在的默认档】，冷调更贴品牌深蓝；
     'warm' = 象牙暖白+橙光斑（html[data-tint='warm']，Day 31 晚那一版）。
     只认得 'warm' 这一个显式值，其余（含没存过）一律落到 cool ——
     也就是说：老用户如果从没点过「暖」，改版后自动变冷白；点过「暖」的照旧留暖。
     深色下两档也各有一套配方（见 style.css 的暗色块），属性贴着不冲突。 */
  function readTint() {
    var v = null;
    try { v = localStorage.getItem(TINT_KEY); } catch (e) { /* 隐私模式 */ }
    return v === 'warm' ? 'warm' : 'cool';
  }

  function syncTint(tint) {
    var btns = document.querySelectorAll('[data-tint-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed',
        btns[i].getAttribute('data-tint-mode') === tint ? 'true' : 'false');
    }
  }

  function paintTint() {
    /* ⚠️ 两种取值都【贴属性】，不搞"默认就摘"：
       浅色下 warm 没有专属块（走 :root 那套暖白兜底值）、cool 有专属块；
       暗色下的暖炭灰是 html[data-theme='dark'][data-tint='warm'] ——
       warm 时要是把属性摘了，这一块就永远命中不了，暗色用户选「暖」会掉回石墨蓝灰。
       所以属性一律贴着，让样式自己去认。 */
    var tint = readTint();
    root.setAttribute('data-tint', tint);
    syncTint(tint);
  }

  function setTint(tint) {
    if (tint !== 'cool' && tint !== 'warm') return;
    try { localStorage.setItem(TINT_KEY, tint); } catch (e) { /* 写不进去也能切，只是记不住 */ }
    paintTint();
  }

  /* 事件委托：右栏每次重绘都会换成新按钮，绑在节点上的监听会跟着失效 */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-theme-mode]') : null;
    if (btn) setMode(btn.getAttribute('data-theme-mode'));
    var tintBtn = e.target && e.target.closest ? e.target.closest('[data-tint-mode]') : null;
    if (tintBtn) setTint(tintBtn.getAttribute('data-tint-mode'));
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
    new MutationObserver(function () { sync(read()); syncTint(readTint()); })
      .observe(panel, { childList: true, subtree: true });
  }

  paint();                      /* 第一帧就定，避免白闪 */
  paintTint();                  /* 配色变体同理，第一帧贴属性避免闪 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paint(); paintTint(); watchPanel(); });
  } else {
    watchPanel();
  }

  /* 给别处用的小接口（登录页/调试用） */
  window.EchoTheme = { set: setMode, get: read, apply: paint, setTint: setTint, getTint: readTint };
})();
