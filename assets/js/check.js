/* ============================================
   check.js —— 检查台（Day 20 新建，Day 22 扩到「增删改查」四类）

   这一页是干什么的：把「后端到底通不通」变成眼睛能看见的东西。
     ① 服务健康状态   —— GET /api/health（不碰数据库，通不通一看就知道）
     ② 核心表真实数据 —— GET /api/words（数据库里真有几条，列出来）
     ③ 一次写入测试   —— POST /api/words（真往库里插一条，看写入这条路通不通）
     ④ 修改 / 删除测试 —— PATCH / DELETE /api/words?id=...（Day 22 新增；
                         删除带二次确认 · ⚠️ Day 24 纠正：删除是【软删除】，不是真删）

   ⚠️ 为什么单独做一页、不挂在首页：
      首页三张卡是【数据库驱动】的（boards 表），要加第四个入口就得往库里插一行 ——
      那是写操作，且会改动已经验收过的首页。检查台是「运维视角」的页面，
      给的是自己看的证据，不必占首页那三格。所以它是一张可以直达的独立页。

   ⚠️ 这一页只把后端**已有**的接口当仪表盘读出来，自身不新增任何后端逻辑 ——
      接口的增删改查（GET/POST/PATCH/DELETE）都在 Day 22 补齐了。
   ============================================ */

/* 接口地址（Day 27 起改走【同源相对路径】）。
   ⚠️ 原先写的是云函数完整域名，理由是"两个域名不同、写相对路径必 404" —— 那时没有代理。
      现在 dev-server.js 加了 /api 代理，同源的 /api/** 会被转发到云函数，
      跨域问题从浏览器眼里消失（详见 CORS_FIX.md）。
   ⚠️ 别改回完整域名：跨域会原样回来。
   同款写法在首页的 home.js 与词汇页的 data-list-url 里各有一份（本项目不引构建工具，
   三处各留一份，代价小于为一句话的配置引一套打包流程）。 */
var HEALTH_URL = '/api/health';
var WORDS_URL = '/api/words';

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
         要确认到底是哪种，用 curl 带 Origin 头去看有没有 Access-Control-Allow-Origin）
       Day 23：话术统一走 common.js 的 network 类口径 ——
       两处（网络/跨域）合成一句"连不上＋稍后重试"，自查命令另起一行。 */
    setHTML('write-result',
      failureHTML({ kind: 'network' }, '写入接口', 'refresh-all') +
      '<span class="empty"> 自查：curl -D - -o /dev/null -H "Origin: ' +
      escapeHTML(location.origin) + '" ' + escapeHTML(HEALTH_URL) +
      ' | grep -i access-control</span>');
  });
}

/* ============================================
   ④ 修改 / 删除测试（Day 22 新增）

   这一页原本只做「读 / 写」两件已有接口，Day 22 起后端补上了 PATCH / DELETE，
   检查台跟着把它们也当仪表盘读出来 —— 「增删改查」四类操作在这里都有眼睛看得见的入口。

   ⚠️ 为什么这两个要放最后、而且删除要多一道确认：
      新增错了 → 多一条，随手能清；
      修改错了 → 值被覆盖，原来的值就没了（除非你记得）；
      删除错了 → **列表里当场看不见了**（⚠️ Day 24 纠正：是**软删**，那一行仍在库里、
                  用同一个 id 重新写入即可带回；原文误写为"整行消失，没有回收站"）。
      风险是递增的，防护也就得递增：写入口令门槛 → 改/删前先让人看清楚对象 → 删除再加一次 confirm。
      ⚠️ 补一句：既然删除是可逆的，confirm 保的就不再是"删了就没了"，
         而是"**你要删的到底是不是这一条**"—— 防的是认错对象，不是防不可逆。
   ============================================ */

/* 把接口返回的一条词条，渲染成「改前 / 改后」的对比小串。
   before / after 都是 {id,title,desc,tag} 形状（after 可能缺字段）。 */
function fieldDiff(label, before, after) {
  var b = (before === undefined || before === null || before === '') ? '（空）' : String(before);
  var a = (after   === undefined || after   === null || after   === '') ? '（空）' : String(after);
  if (b === a) {
    return escapeHTML(label) + ' ' + escapeHTML(b) + '（未变）';
  }
  return escapeHTML(label) + ' <s>' + escapeHTML(b) + '</s> → <strong>' + escapeHTML(a) + '</strong>';
}

/* ---- 4-A 修改（PATCH /api/words?id=...）----
   ⚠️ 做一个「改前先取对照」的动作：先 GET 一次当前值，
      改完再显示 改前 → 改后 的对比。截图要的正是这个「值的变化」。 */
function submitPatch(event) {
  event.preventDefault();

  var id = text('p-id');
  if (!id) return;

  /* 收集「要改的字段」：留空的字段 = 不改它，不放进 body。 */
  var body = {};
  var t = text('p-title');
  var d = text('p-desc');
  var g = text('p-tag');
  if (t) body.title = t;
  if (d) body.desc = d;
  if (g) body.tag = g;

  if (Object.keys(body).length === 0) {
    setHTML('patch-result', '<span class="check-fail">至少要填一个要改的字段（新单词 / 新释义 / 新单元）。</span>');
    return;
  }

  setHTML('patch-result', '<span class="empty">正在修改…</span>');

  /* ① 先取「改前」的样子（从 ② 区已加载的数据里找；找不到就再 GET 一次）。 */
  var before = null;
  fetch(WORDS_URL).then(function (res) { return res.json(); }).then(function (data) {
    var items = (data && Array.isArray(data.words)) ? data.words : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) { before = items[i]; break; }
    }
    if (!before) throw new Error('not_found_local');
    return null;
  }).catch(function () {
    /* 本地找不到（或 GET 失败）也继续往下走 —— 让 PATCH 自己去判 id 存不存在，
       接口会回 404 并给出中文说明，比前端猜更准。 */
    return null;
  }).then(function () {
    /* ② 发 PATCH。 */
    return fetch(WORDS_URL + '?id=' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }).then(function (r) {
    var d = r.data;

    if (r.status === 200 && d && d.ok && d.data) {
      var after = d.data;
      var lines = [];
      lines.push(fieldDiff('单词', before && before.title, after.title));
      lines.push(fieldDiff('释义', before && before.desc,  after.desc));
      lines.push(fieldDiff('单元', before && before.tag,   after.tag));
      setHTML('patch-result',
        '<span class="check-ok">修改成功（200）：' + escapeHTML(String(after.id)) + '</span><br>' +
        '<span class="empty">' + lines.join('<br>') + '</span>');
      loadWords();                 /* ② 区立刻回读，让改后的值当场可见 */
      stampUpdated();
      return;
    }

    var msg = (d && d.message) ? d.message : ('HTTP ' + r.status);
    setHTML('patch-result',
      '<span class="check-fail">修改未生效（' + r.status + '）：' + escapeHTML(String(msg)) + '</span>');
  }).catch(function () {
    /* Day 23：统一走 common.js 的 network 类口径（原来是一句自己写的"网络不通或跨域被拦"）。 */
    setHTML('patch-result', failureHTML({ kind: 'network' }, '修改接口', 'refresh-all'));
  });
}

/* ---- 4-B 删除（DELETE /api/words?id=...）----
   ⚠️⚠️ 这里就是今天要掌握的那个知识点在**前端**的落点：
      「删除为什么比新增更容易出事」—— 因为它**默认就看不见了**：
      软删（Day 22 余力加练）把那一行留在库里、只置 is_deleted=true，
      ⇒ 数据没丢，但你要靠"用同一个 id 重新写入"才能把它带回来（字段会被覆盖）。
        忘了这件事，就会像 Day 22 的 w-abandon 那样：删了却没人察觉，三天后才发现。
      ⚠️ Day 24 纠正：原文写的是"删错了找不回来"，与实现不符（那是真删的说法）。
      所以点删除按钮后，**必须先过一道确认框**（window.confirm），
      把「你要删的到底是谁」摆到人眼前，确认了才真的发请求。
      confirm 返回 false（点了取消）→ 直接中止，一个字节都不发出去。 */
function submitDelete(event) {
  event.preventDefault();

  var id = text('d-id');
  if (!id) return;

  /* ① 二次确认。把 id 原样念出来 —— 让人有机会发现"我是不是拼错了 id"。
     ⚠️ Day 24 纠正（原 Bug 的核心）：这句话原文写的是"这是真删除……而且不可恢复"，
        与实现不符 —— 后端自 Day 22 起是**软删**，那一行原封不动留在库里。
        说"能恢复"还不够，必须把**恢复的代价**一并说清（字段会被覆盖），
        否则等于换个姿势继续骗人。 */
  var okToDelete = window.confirm(
    '确定要删除这条词条吗？\n\n' +
    'id：' + id + '\n\n' +
    '⚠️ 这是软删除：删掉后列表就不再返回它，但数据仍留在库里。\n' +
    '要用同一个 id 重新写入才能把它带回来（字段会被新写入的值覆盖）。'
  );

  if (!okToDelete) {
    setHTML('delete-result', '<span class="empty">已取消删除，没有发出任何请求。</span>');
    return;
  }

  /* ② 确认了才发 DELETE。 */
  setHTML('delete-result', '<span class="empty">正在删除…</span>');

  fetch(WORDS_URL + '?id=' + encodeURIComponent(id), {
    method: 'DELETE'
  }).then(function (res) {
    return res.json().catch(function () { return null; }).then(function (data) {
      return { status: res.status, data: data };
    });
  }).then(function (r) {
    var d = r.data;

    if (r.status === 200 && d && d.ok && d.data) {
      setHTML('delete-result',
        '<span class="check-ok">删除成功（200）：已删除 ' + escapeHTML(String(d.data.id)) +
        ' = ' + escapeHTML(String(d.data.title)) + '</span> · 见下方 ② 区，条数应当 −1 且这行消失');
      loadWords();                 /* ② 区立刻回读，让"这条没了"当场可见 */
      stampUpdated();
      return;
    }

    var msg = (d && d.message) ? d.message : ('HTTP ' + r.status);
    setHTML('delete-result',
      '<span class="check-fail">删除未执行（' + r.status + '）：' + escapeHTML(String(msg)) + '</span>');
  }).catch(function () {
    /* Day 23：统一走 common.js 的 network 类口径。 */
    setHTML('delete-result', failureHTML({ kind: 'network' }, '删除接口', 'refresh-all'));
  });
}

/* ============================================
   装配：几个区一起跑。「全部刷新」也是这一件事。
   ============================================ */
function refreshAll() {
  return Promise.all([runHealth(), loadWords()]);
}

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('write-form');
  if (form) form.addEventListener('submit', submitWrite);

  var patchForm = document.getElementById('patch-form');
  if (patchForm) patchForm.addEventListener('submit', submitPatch);

  var deleteForm = document.getElementById('delete-form');
  if (deleteForm) deleteForm.addEventListener('submit', submitDelete);

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
