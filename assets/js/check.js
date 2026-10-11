/* ============================================
   check.js —— 检查台（Day 20 新建）

   这一页是干什么的：把「后端到底通不通」变成眼睛能看见的三行东西。
     ① 服务健康状态   —— GET /api/health（不碰数据库，通不通一看就知道）
     ② 核心表真实数据 —— GET /api/words（数据库里真有几条，列出来）
     ③ 一次写入测试   —— POST /api/words（真往库里插一条，看写入这条路通不通）

   ⚠️ 为什么单独做一页、不挂在首页：
      首页三张卡是【数据库驱动】的（boards 表），要加第四个入口就得往库里插一行 ——
      那是写操作，且会改动已经验收过的首页。检查台是「运维视角」的页面，
      给的是自己看的证据，不必占首页那三格。所以它是一张可以直达的独立页。

   ⚠️ 这一页只做「读 / 写」两件已有接口，不新增任何后端代码 ——
      后端这周已经封版，检查台只是把这些接口当仪表盘读出来。
   ============================================ */

/* 接口基地址。⚠️ 必须写完整域名：
   本页挂在静态托管域名上，接口在云函数域名上，两个域名不同 —— 写相对路径必 404。
   同款写法在首页的 home.js 与词汇页的 data-list-url 里各有一份（本项目不引构建工具，
   三处各留一份，代价小于为一句话的配置引一套打包流程）。 */
var API_BASE = 'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';
var HEALTH_URL = API_BASE + '/api/health';
var WORDS_URL = API_BASE + '/api/words';

/* ---- ③ 区的门槛：写入测试默认收起，输对口令才展开（Day 20 拍板 B）----

   ⚠️⚠️ 先把话说透：**这不是安全机制**。
      口令就写在下面这一行、而本文件是公开可下载的 —— 任何人按 F12 都能读到。
      它能挡住的只有两种东西：**随手点一下的人** 和 **扫描器乱撞**。
      有心人用 curl 直接 POST 接口，跟这个页面一点关系都没有，照样写得进去。

      真正的拦法只有一条：**在云函数里加校验**（比如校验一个请求头里的令牌）。
      那是改后端代码，不在今天（Day 20）的任务范围内 —— 所以今天先上这道"降低概率"的门槛，
      并把它的真实分量写在这里，免得以后自己误以为"已经安全了"。

   ⚠️ 想换口令就改这一行。但别把它当密码用，也别把真密码填进来（那才是真泄密）。 */
var WRITE_GATE_PASS = 'echoread-write';

/* ---- 小工具 ---- */

function text(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setHTML(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

/* 用时显示：毫秒数 → 人话（436 → "436 毫秒"）。用来判断接口是不是慢得离谱 */
function msLabel(ms) {
  return ms + ' 毫秒';
}

/* 「最后更新时间」（余力加练）—— 只在这一页真的取到数之后才盖章。
   为什么不在页面加载时就写：那样写的是「页面打开的时间」，
   和「数据是什么时候取的」是两件事 —— 数据没取到时盖这个章反而误导。 */
function stampUpdated() {
  var now = new Date();
  var hh = String(now.getHours()).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  var ss = String(now.getSeconds()).padStart(2, '0');
  setHTML('last-updated', escapeHTML(hh + ':' + mm + ':' + ss));
}

/* ============================================
   ① 服务健康状态
   ============================================ */
function runHealth() {
  setHTML('health-status', '<span class="empty">正在检查…</span>');
  var t0 = Date.now();

  /* loadJSON 来自 common.js：读不到会抛带 kind 标签的错（network / http / parse），
     这里直接复用它的分语文案，不另写一套。 */
  return loadJSON(HEALTH_URL).then(function (data) {
    var ok = data && data.ok === true;
    setHTML('health-status',
      '<span class="' + (ok ? 'check-ok' : 'check-fail') + '">' +
        (ok ? '正常' : '有响应但 ok 不是 true') +
      '</span> · 服务名 ' + escapeHTML(String(data && data.service)) +
      ' · 用时 ' + msLabel(Date.now() - t0) +
      ' · 地址 ' + escapeHTML(HEALTH_URL));
    stampUpdated();
    return true;
  }).catch(function (err) {
    setHTML('health-status', failureHTML(err, '健康检查', 'refresh-all'));
    return false;
  });
}

/* ============================================
   ② 核心表真实数据（words 表）
   ============================================ */
function loadWords() {
  setHTML('words-status', '<span class="empty">正在加载词表…</span>');
  var list = document.getElementById('words-list');
  if (list) list.innerHTML = '';
  var t0 = Date.now();

  return loadJSON(WORDS_URL).then(function (data) {
    var items = (data && Array.isArray(data.words)) ? data.words : [];

    if (!items.length) {
      /* 空清单不是错误：表在、只是还没数据。必须说人话，不能留白 */
      setHTML('words-status', '<span class="empty">words 表里还没有数据。</span>');
      return;
    }

    setHTML('words-status',
      '<span class="check-ok">' + items.length + ' 条</span> · 用时 ' + msLabel(Date.now() - t0) +
      '（应与 CloudBase 控制台 select * from words 的行数一致）');

    /* ⚠️ 这里没有调 list-page.js 的 buildItemHTML —— 那是给 data-list-url 那套配置用的。
       检查台自己铺这几行，但【沿用同一套 class】（li-title / li-desc / li-tag），
       所以长相和词汇速记页完全一样，不会冒出第二套样式。 */
    if (list) {
      list.innerHTML = items.map(function (w) {
        var title = w.title ? '<span class="li-title">' + escapeHTML(w.title) + '</span>' : '';
        var desc  = w.desc  ? '<span class="li-desc">'  + escapeHTML(w.desc)  + '</span>' : '';
        var tag   = w.tag   ? '<span class="li-tag">'   + escapeHTML(w.tag)   + '</span>' : '';
        return '<li class="list-item item">' + title + desc + tag + '</li>';
      }).join('');
    }
    stampUpdated();
  }).catch(function (err) {
    setHTML('words-status', failureHTML(err, '词表', 'refresh-all'));
    console.error(err);
  });
}

/* ============================================
   ③ 区的门槛：展开 / 收起
   为什么要有它、以及它的分量，见文件上方 WRITE_GATE_PASS 那段说明。
   ============================================ */
function openWriteGate() {
  var input = document.getElementById('gate-pass');
  var typed = input ? input.value.trim() : '';

  if (typed !== WRITE_GATE_PASS) {
    setHTML('gate-msg', '<span class="check-fail">口令不对。</span>' +
      '<span class="empty"> 提醒：这不是安全检查，只是防止写入区被随手点开。</span>');
    return;
  }

  var gate = document.getElementById('write-gate');
  var body = document.getElementById('write-body');
  if (gate) gate.hidden = true;
  if (body) body.hidden = false;
  setHTML('gate-msg', '');
}

function closeWriteGate() {
  var gate = document.getElementById('write-gate');
  var body = document.getElementById('write-body');
  var input = document.getElementById('gate-pass');
  if (gate) gate.hidden = false;
  if (body) body.hidden = true;
  if (input) input.value = '';
  setHTML('gate-msg', '');
  setHTML('write-result', '');   /* 收起时把上一次的写入回显也清掉 */
}

/* ============================================
   ③ 一次写入测试（POST /api/words）

   ⚠️ 这一步是【真写库】，不是演习。所以：
      · 默认带一个可辨认的 id（w-check-test），方便事后从库里认出来删掉
      · 把接口返回的 message 原样显示 —— 409（重复）不是故障，是预期结果
      · 写入成功后自动重载 ② 区，好让「条数 +1」当场看得见
   ============================================ */
function submitWrite(event) {
  event.preventDefault();

  var body = { id: text('w-id'), title: text('w-title'), desc: text('w-desc') };
  var tag = text('w-tag');
  if (tag) body.tag = tag;          /* 可选字段：留空就不传，交给后端存 NULL */

  setHTML('write-result', '<span class="empty">正在写入…</span>');

  fetch(WORDS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (res) {
    /* 不管成功失败都先试着读 JSON：接口的错误形状是 {ok:false,error,message}，
       message 是给人看的中文，直接能显示。读不出来就当没有。 */
    return res.json().catch(function () { return null; }).then(function (data) {
      return { status: res.status, data: data };
    });
  }).then(function (r) {
    var d = r.data;

    if (r.status === 201 && d && d.ok) {
      setHTML('write-result',
        '<span class="check-ok">写入成功（201）：' + escapeHTML(String(d.data && d.data.id)) +
        ' = ' + escapeHTML(String(d.data && d.data.title)) + '</span> · 见下方 ② 区，条数应当 +1');
      loadWords();                   /* 立刻回读，让「变成 6 条」当场可见 */
      stampUpdated();
      return;
    }

    var msg = (d && d.message) ? d.message : ('HTTP ' + r.status);
    setHTML('write-result',
      '<span class="check-fail">写入被拒（' + r.status + '）：' + escapeHTML(String(msg)) + '</span>');
  }).catch(function () {
    /* ⚠️ fetch 自己 reject，两种可能，都得说清：
       ① 网络断了 —— 根本没连上
       ② 跨域被拦 —— 浏览器先发预检 OPTIONS，服务器没放行，fetch 直接 reject
       （curl 不触发跨域，所以【只有真浏览器才看得见这一条】；
         要确认到底是哪种，用 curl 带 Origin 头去看有没有 Access-Control-Allow-Origin） */
    setHTML('write-result',
      '<span class="check-fail">请求没发出去：网络不通，或跨域被浏览器拦了。</span>' +
      '<span class="empty"> 自查：curl -D - -o /dev/null -H "Origin: ' +
      escapeHTML(location.origin) + '" ' + escapeHTML(HEALTH_URL) +
      ' | grep -i access-control</span>');
  });
}

/* ============================================
   装配：三个区一起跑。「全部刷新」也是这一件事。
   ============================================ */
function refreshAll() {
  return Promise.all([runHealth(), loadWords()]);
}

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('write-form');
  if (form) form.addEventListener('submit', submitWrite);

  /* 口令框里按回车 = 点「展开」。省得为了一个入口去够鼠标。 */
  var gateInput = document.getElementById('gate-pass');
  if (gateInput) {
    gateInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        openWriteGate();
      }
    });
  }

  /* 「全部刷新 / 展开 / 收起」这几个按钮：事件代理挂在 document 上，
     不依赖它们何时被渲染出来。
     ⚠️ 放在 DOMContentLoaded 里统一注册，避免脚本被重复引入时挂两遍。 */
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest('[data-action="refresh-all"]')) refreshAll();
    if (el.closest('[data-action="open-write"]')) openWriteGate();
    if (el.closest('[data-action="close-write"]')) closeWriteGate();
  });

  refreshAll();
});
