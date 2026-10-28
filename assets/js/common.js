/* ============================================
   common.js —— 几个视图共用的取数与状态工具（Day 13）
   ------------------------------------------------------------
   为什么现在才抽出来：
     loadJSON / failureHTML / escapeHTML 这一套，Day 8 时在 home.js（首页）
     和 app.js（跟读页）里各写了一份 —— 当时只有两个页面，重复还扛得住，
     TECH_DESIGN.md §2.1 把这笔账记成「等页面多到第三、第四页，再抽成共用文件不迟」。
     Day 13 做到了第三、第四个页面（词汇速记 / 作文模板），账到这里结：
     新页面统一引这一份。

   ⚠️ 本轮【不动】home.js 与 app.js —— 那两个页面已按 PRD 第六节的验收标准跑通过，
      改它们等于把已验证的东西拉回风险里。等哪天顺手再收编，不在这天的清单内。

   术语备注：
     fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
     JSON  —— 一种纯文本数据格式，人和机器都能读
   ============================================ */

/* 取一个 JSON 文件；读不到就抛错，交给调用方统一处理。
   失败原因分三类打标签（kind），因为给用户看的话不一样：
     network —— 断网 / DNS 挂了 / 被拦了
     http    —— 服务器答了，但不是 200（404 文件不在、500 服务器炸了）
     parse   —— 文件拿到了，但里面不是合法 JSON（手写少个逗号就会这样） */
function loadJSON(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.kind = 'http';
      e.url = url;
      throw e;
    }
    return res.json().catch(function () {
      var e2 = new Error('内容不是合法 JSON');
      e2.kind = 'parse';
      e2.url = url;
      throw e2;
    });
  }, function () {
    /* fetch 自己 reject 了：根本没连上服务器 */
    var e3 = new Error('网络连不上');
    e3.kind = 'network';
    e3.url = url;
    throw e3;
  });
}

/* 文本里的 & < > 要转义，否则数据文件里一个尖括号就能把页面结构冲乱 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ============================================
   把失败翻译成人话 —— 全站【唯一】一份（Day 23 统一）

   Day 23 之前，home.js / app.js 各带一份「复制版」，改一处另两处不生效。
   今天收编到这里：那两个页面改为直接引用本文件，各自的副本删掉。
   ⇒ 从此「错误提示长什么样」只有这一个源头，改文案不会漏。

   ⚠️ 硬规矩：绝不让用户看到 "Failed to fetch" / "HTTP 500" 这种英文或机器话。

   ---- 三类错误，三种说法（这就是今天要掌握的分类）----
     ① 用户输入错（invalid / missing）—— 告诉他【改什么】，别只说"错了"
     ② 网络 / 接口错（network / http）—— 提示【稍后再试】，带重试入口
     ③ 服务端错（server / parse）    —— 【记日志 + 通用提示】，不透内部细节
   为什么必须分：三类里只有 ② 是用户能自救的（重试）；① 要他改输入；
                 ③ 他做什么都没用，只能说"稍后再试"，真相留在控制台。
   ============================================ */

/* 三个「类别」→ 一句给人看的中文。集中在这里，方便一眼看清全站口径。
   ⚠️ 文案里【不带】err.message 这种技术原文 —— 那可能含主机名、状态码、内部细节。 */
var FAIL_TEXT = {
  /* ① 用户输入错：指出改什么 */
  invalid:  '填写的内容不符合要求，请检查后重试。',
  /* ② 网络 / 接口错：用户能自救 —— 检查网络、稍后重试 */
  network:  '网络连不上，请检查网络后点下面的「重试」。',
  http:     '服务暂时没能响应，请稍后点下面的「重试」。',
  /* ③ 服务端错：用户做啥都没用，说清"不是你的问题"，真相留在日志 */
  server:   '服务端出错了，请稍后再试。',
  parse:    '数据读不出来，这是服务端的问题，请稍后再试或联系维护者。'
};

/* 把「错误对象的 kind」归到上面三类之一。
   ⚠️ 为什么要有这一层映射：kind 是技术分类（network/http/parse），
      而"给用户看哪一句"是产品分类（能自救 / 要改输入 / 只能等）——
      两者不是一一对应，中间必须有个翻译。 */
function failClassOf(kind) {
  if (kind === 'network' || kind === 'http') return kind;      /* ② 网络/接口 */
  if (kind === 'parse') return 'parse';                        /* ③ 服务端 */
  if (kind === 'invalid') return 'invalid';                    /* ① 用户输入 */
  return 'server';                                             /* 兜底 = ③ 服务端 */
}

/* 统一的人话入口。
     err    带 kind 标签的错误（loadJSON 抛的那些）或 {kind:'server'} 兜底
     what   这次没取到的是什么（「词表」「作文模板」…）：写进句子，用户才知道卡在哪
     action 重试按钮的 data-action 值：各页面认自己的那一个，互不干扰
   返回值直接是 HTML：一句人话 ＋ 一个重试入口（PRD R6：失败必须能重试）。 */
function failureHTML(err, what, action) {
  var label = escapeHTML(what || '内容');
  var cls = failClassOf(err && err.kind);
  var text = FAIL_TEXT[cls] || FAIL_TEXT.server;

  /* 把「哪块内容」和「该怎么自救」缝进句子；句子本身不带 err.message 原文。 */
  if (cls === 'network') {
    text = '网络连不上，加载不了' + label + '。请检查网络后点下面的「重试」。';
  } else if (cls === 'http') {
    text = '服务器没能提供' + label + '，请稍后点下面的「重试」。';
  } else if (cls === 'parse') {
    text = label + '读不出来，这是数据本身的问题，请联系维护者。';
  } else if (cls === 'invalid') {
    text = label + '填写的内容不符合要求，请检查后重试。';
  } else {
    /* ③ 兜底：不管底层抛的是什么（含 err.message），对外只说这一句 ——
       详细原因由各页面 console.error 记进控制台日志，不给用户看。 */
    text = label + '加载失败，请稍后再试。';
  }

  return '<p class="empty">' + escapeHTML(text) + '</p>' +
         '<button type="button" class="btn item" data-action="' + escapeHTML(action || 'retry') + '">重试</button>';
}

/* ============================================
   API 基址（Day 26 加）—— 前端的 /api/* 到底打到哪
   ------------------------------------------------------------
   取决于页面托管在哪：
     · CloudBase 静态托管（*.tcloudbaseapp.com）：该域【没有】/api 路由，
       故直接拼上云函数完整地址。CloudBase 网关会自动回 CORS 头
       （实测 allow-headers 含 authorization、allow-credentials: true），跨域可通。
     · 其他（workbuddy.host 等）：保持相对 /api/*，交给该平台的 dev-server
       代理转发到云函数（线上反向代理会吃 Authorization 头，靠 cookie 补回，
       见 app-shell.js 与 dev-server.js 的注释）。
   实现：只把【以 /api/ 开头】的字符串请求加前缀，其余（本地 data/*.json 等）原样不动。
   ⚠️ 必须放在 common.js（每个页面最先加载），赶在 app-shell.js 等发请求之前。
   ============================================ */
(function () {
  var CLOUD_FN = 'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';
  var onCloudHosting = /(^|\.)tcloudbaseapp\.com$/i.test(location.hostname);
  window.API_BASE = onCloudHosting ? CLOUD_FN : '';
  if (!window.API_BASE || !window.fetch) return;
  var rawFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.indexOf('/api/') === 0) {
      input = window.API_BASE + input;
    }
    return rawFetch.call(window, input, init);
  };
})();

/* ---- Day 31：「上次学到」的存取（跟读页用，app.js 与 player.js 共享）----
   结构 { file, title, t, ts }：file=素材 id；t=进度（秒）；ts=最后交互时间戳。
   放 common.js 不放 app.js：player.js 播放中也要更新 t，两边都得够得着 */
function readLastStudy() {
  try { return JSON.parse(localStorage.getItem('er_last_study') || 'null'); }
  catch (e) { return null; }
}
function saveLastStudy(rec) {
  try { localStorage.setItem('er_last_study', JSON.stringify(rec)); } catch (e) {}
}
