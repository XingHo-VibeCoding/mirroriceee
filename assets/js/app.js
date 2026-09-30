/* ============================================
   app.js —— 跟读页的「显示」逻辑（Day 7 第 3 步；Day 8 加等级目录）
   职责：把 data/ 里的两个 JSON 读出来，铺等级目录（L1/L2/L3）与当前等级的素材
   不管播放：点句子出声是 player.js 的事
   ============================================ */

/* 术语备注：
   fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
   JSON  —— 一种纯文本数据格式，人和机器都能读，用来存素材清单与句子秒数 */

var MATERIALS_URL = 'data/materials.json';  /* 素材清单：一共有哪些音频、各属于哪个等级 */
var SEGMENTS_URL = 'data/segments.json';    /* 对齐数据：每句从第几秒到第几秒 */

/* ---- 等级目录的状态（Day 8 新增）----
   levelList    清单里声明的等级，按声明顺序渲染成 L1 / L2 / L3 三个按钮
   allMaterials 全部素材（未筛选）；切等级时从这里挑
   allSegments  全部对齐数据；渲染每条素材时按 materialId 配对
   activeLevel  当前选中的等级；空字符串＝清单没声明等级，见 renderMaterials 的兜底 */
var levelList = [];
var allMaterials = [];
var allSegments = [];
var activeLevel = '';

/* 秒数 → mm:ss，方便人一眼核对（6 → "00:06"） */
function formatClock(seconds) {
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

/* 取一个 JSON 文件；读不到就抛错，交给 render 的 catch 统一处理。
   失败原因分三类打标签（kind），因为给用户看的话不一样：
     network —— 断网 / DNS 挂了 / 被拦了（B1 断网就落这里）
     http    —— 服务器答了，但不是 200（比如 404 文件不在、500 服务器炸了）
     parse   —— 文件拿到了，但里面不是合法 JSON（手写 JSON 少个逗号就会这样） */
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

/* 把失败翻译成人话 —— 绝不能让用户看到 "Failed to fetch" 这种英文报错（B1 / R6） */
function failureHTML(err) {
  var text;
  if (err.kind === 'network') {
    text = '网络连不上，加载不了素材。请检查网络后点下面的「重试」。';
  } else if (err.kind === 'http') {
    text = '服务器没能提供素材（' + err.message + '）。请稍后点「重试」。';
  } else if (err.kind === 'parse') {
    text = '素材文件读不出来（' + err.message + '）。这是数据文件本身的问题，请联系维护者。';
  } else {
    text = '素材加载失败：' + err.message;
  }
  return '<p class="empty">' + escapeHTML(text) + '</p>' +
         /* R6 明确要求：加载失败要给「重试入口」，不能只有一句话 */
         '<button type="button" class="btn" data-action="retry-load">重试</button>';
}

/* 文本里的 & < > 要转义，否则会把页面结构冲乱 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---- 坏路径 B2：某条素材的音频不见时，主动发现并标出来 ---- */

/* 把一条素材标成「暂不可用」。
   这里用 class 当契约 —— player.js 里 blockedByUnavailable() 认的就是 is-unavailable，
   所以两个文件不用互相调用，各自独立。 */
function markAudioMissing(bar) {
  if (!bar || !bar.classList) return;
  bar.classList.add('is-unavailable');
  var btn = bar.querySelector('[data-action="toggle-play"]');
  if (btn) btn.setAttribute('disabled', 'disabled');
  var box = bar.querySelector('[data-role="status"]');
  if (box) {
    box.textContent = '素材暂不可用：音频文件读不到（可能还没上传）。其他素材不受影响。';
  }
}

/* 用 HEAD 探一下音频在不在 —— HEAD 只问「有没有」、不下载音频本体，
   所以不会拖慢页面（G2 要求手机 4G 下 3 秒内可点）。三种结果：
     在     → 什么都不做
     不在   → 标成暂不可用（B2：该条目要显示「素材暂不可用」）
     探不通 → 不标记。断网时所有请求都会失败，那是网络问题、不是「某条素材坏了」，
              标了就是误报 —— 网络问题交给 B1 的提示去说 */
function probeAudio(bar, audioPath) {
  fetch(audioPath, { method: 'HEAD' }).then(function (res) {
    if (!res.ok) markAudioMissing(bar);
  }, function () {
    /* 探不通：静默跳过，宁可漏报也不误报 */
  });
}

/* 把一条素材连同它的所有句子，拼成 HTML 字符串
   两处为第 4 步（播放器）留的接口：
     ① <section data-audio="..."> —— 播放器靠它知道这条素材的音频文件在哪
     ② 每句挂 data-start / data-end —— 播放器拨播放头时直接读，改数据不用改代码 */
function buildMaterialHTML(material, segments) {
  var head = '<h2 class="mat-title">' + escapeHTML(material.title) + '</h2>';
  var attrs = '<section class="material" data-audio="' + escapeHTML(material.audio) + '">';

  /* 没有对齐数据就只显示标题，不给一个点了没反应的播放器 */
  if (!segments.length) {
    return attrs + head + '<p class="empty">这条素材还没有对齐数据</p></section>';
  }

  /* 播放控制条：上面一条时间进度条，下面一排图标键（播放/停止 ＋ 单句重复），
     跟音乐软件的排布一样。进度条上限先用「最后一句的终点」垫着，
     播放器拿到音频真实时长后会改成真实时长 */
  var lastEnd = segments[segments.length - 1].end;
  var bar = '<div class="player">' +
              '<input type="range" class="progress" data-role="progress" ' +
                'min="0" step="0.1" value="0" max="' + lastEnd + '" ' +
                'aria-label="播放进度，拖动可跳到对应时间">' +
              '<div class="player-controls">' +
                /* 播放/停止：两个图标都放在这一个按钮里，靠 CSS 按 aria-pressed 决定露哪一个
                   （这样点一下只是切图标，不用重建按钮）。
                   ⚠️ 第二个图标是「停止方块 ■」而不是「暂停两竖杠 ⏸」：
                   这个键按下去的效果是停止（音频停 ＋ 播放头归位 ＋ 清高亮），图标必须照实。 */
                '<button type="button" class="icon-btn" data-action="toggle-play" ' +
                  'aria-pressed="false" aria-label="播放">' +
                  '<svg class="ico ico-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                    '<path d="M8 5v14l11-7z"></path>' +
                  '</svg>' +
                  '<svg class="ico ico-stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                    '<path d="M6 6h12v12H6z"></path>' +
                  '</svg>' +
                '</button>' +
                /* 单句重复：图标 + 文字。文字单独放进一个 span，
                   因为播放器切开关时要改的是这几个字，不能把图标一起冲掉。
                   aria-label 是兜底：窄屏会把文字藏起来，读屏软件得靠它念出名字 */
                '<button type="button" class="btn" data-action="toggle-repeat" ' +
                  'aria-pressed="false" aria-label="单句重复">' +
                  '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                    '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"></path>' +
                  '</svg>' +
                  '<span data-role="repeat-label">单句重复</span>' +
                '</button>' +
              '</div>' +
            '</div>';

  var rows = segments.map(function (seg) {
    return '<li class="seg" data-start="' + seg.start + '" data-end="' + seg.end + '">' +
             '<span class="seg-idx">' + (seg.idx + 1) + '</span>' +
             '<span class="seg-body">' +
               '<span class="seg-text">' + escapeHTML(seg.text) + '</span>' +
               '<span class="seg-time">' + formatClock(seg.start) + ' – ' + formatClock(seg.end) + '</span>' +
             '</span>' +
           '</li>';
  }).join('');

  return attrs + head +
         '<p class="mat-meta">共 ' + segments.length + ' 句 · ' +
           formatClock(segments[0].start) + ' – ' +
           formatClock(segments[segments.length - 1].end) + '</p>' +
         bar +
         /* 播放出问题时把原因写在这里，绝不让用户"点了没反应" */
         '<p class="player-status" data-role="status"></p>' +
         '<ol class="seg-list">' + rows + '</ol>' +
         '</section>';
}

/* 主流程：读数据 → 铺等级目录 → 铺当前等级的素材 */
function render() {
  var box = document.getElementById('reader');
  if (!box) return;

  /* R6：加载中要有状态提示。重试时也先回到这一句，用户才知道点下去有反应了 */
  box.innerHTML = '<p class="empty">正在加载素材…</p>';
  setLevelsHTML('');                       /* 重试时先收掉旧目录，免得新旧按钮混在一起 */

  Promise.all([loadJSON(MATERIALS_URL), loadJSON(SEGMENTS_URL)])
    .then(function (result) {
      levelList = result[0].levels || [];
      allMaterials = result[0].materials || [];
      allSegments = result[1];

      /* 默认落在第一个等级上（清单没声明等级时留空字符串，见 renderMaterials 的兜底） */
      activeLevel = levelList.length ? levelList[0] : '';

      renderLevels();
      renderMaterials();
    })
    .catch(function (err) {
      /* 坏路径：读不到数据也要给人话 ＋ 重试入口，不能白屏（B1 / R6） */
      setLevelsHTML('');
      box.innerHTML = failureHTML(err);
      console.error(err);
    });
}

/* 把等级目录铺成一行按钮（L1 / L2 / L3）。
   为什么用 <button> 而不是 <a>：这是「切换当前视图」，地址栏不会变；
   用链接会被读屏软件念成「跳转到另一个页面」，误导不该给。
   选中态交给 aria-pressed —— CSS 里 .btn[aria-pressed='true'] 已经有现成的高亮样式 */
function renderLevels() {
  setLevelsHTML(levelList.map(function (level) {
    return '<button type="button" class="btn level-btn" data-action="pick-level" ' +
             'data-level="' + escapeHTML(level) + '" ' +
             'aria-pressed="' + (level === activeLevel ? 'true' : 'false') + '">' +
             escapeHTML(level) +
           '</button>';
  }).join(''));
}

function setLevelsHTML(html) {
  var nav = document.getElementById('levels');
  if (nav) nav.innerHTML = html;
}

/* 铺当前等级的素材。三种显示状态都在这里收口：
     有素材   → 逐条渲染
     该级为空 → 空状态（L2 / L3 现在没人放素材，点进去看到的就是这一种）
     整个清单空 → 另一种空状态（分开写，因为给用户的信息不一样）*/
function renderMaterials() {
  var box = document.getElementById('reader');
  if (!box) return;

  /* 兜底：清单里没声明 levels（或声明为空）时不过滤，把素材全铺出来 ——
     宁可显示得朴素一点，也不要因为少一个字段就整页空白 */
  var list = activeLevel
    ? allMaterials.filter(function (material) { return material.level === activeLevel; })
    : allMaterials;

  if (!allMaterials.length) {
    box.innerHTML = '<p class="empty">暂无素材</p>';
    return;
  }

  if (!list.length) {
    /* 空状态：说清「是这个等级没有」，而不是让人以为整站挂了 */
    box.innerHTML = '<p class="empty">' + escapeHTML(activeLevel) + ' 暂无素材</p>';
    return;
  }

  box.innerHTML = list.map(function (material) {
    /* 按 materialId 从对齐数据里挑出属于这条素材的那一份 */
    var matched = allSegments.filter(function (item) {
      return item.materialId === material.id;
    })[0];
    return buildMaterialHTML(material, matched ? matched.segments : []);
  }).join('');

  probeAllAudio(box);
}

/* 渲染完顺手探一遍每条素材的音频在不在（B2：不用等用户点下去才发现缺失）。
   先确认 box 真的有 querySelectorAll —— 测试用的假页面没有这个方法，别把测试搞崩 */
function probeAllAudio(box) {
  if (!box.querySelectorAll) return;
  var sections = box.querySelectorAll('.material');
  for (var i = 0; i < sections.length; i++) {
    var audioPath = sections[i].getAttribute('data-audio');
    if (audioPath) probeAudio(sections[i], audioPath);
  }
}

/* 切等级：先停播，再换列表。
   ⚠️ 那行 stop() 不能省 —— player.js 把 Audio 对象按路径缓存着，
   只换 innerHTML 只会把播放控件从画面上抹掉，声音还在响，
   变成「看不见的播放器」：页面上一片安静，后台一直有人在读课文。 */
function pickLevel(level) {
  if (!level || level === activeLevel) return;
  if (window.Player && window.Player.stop) window.Player.stop();

  activeLevel = level;

  /* 只改 aria-pressed，不重铺整排按钮 —— 重铺会把用户刚点的那个按钮换掉，
     键盘焦点会丢，读屏软件也会重新念一遍整排 */
  var btns = document.querySelectorAll('[data-action="pick-level"]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-pressed',
      btns[i].getAttribute('data-level') === level ? 'true' : 'false');
  }

  renderMaterials();
}

/* 点「重试」→ 整页重来一遍；点等级按钮 → 切到那个等级。
   两个都用事件代理挂在 document 上，不依赖按钮何时被渲染出来 */
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.closest) return;

  if (el.closest('[data-action="retry-load"]')) {
    render();
    return;
  }

  var pick = el.closest('[data-action="pick-level"]');
  if (pick) pickLevel(pick.getAttribute('data-level'));
});

document.addEventListener('DOMContentLoaded', render);
