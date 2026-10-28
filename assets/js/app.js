/* ============================================
   app.js —— 跟读页的「显示」逻辑（Day 7 第 3 步；Day 8 加等级目录 ＋ 文件列表）
   职责：把 data/ 里的两个 JSON 读出来，铺三层 ——
        等级目录（L1/L2/L3）→ 当前等级下的文件列表 → 打开某个文件才铺音频与文本
   不管播放：点句子出声是 player.js 的事
   ============================================ */

/* 术语备注：
   fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
   JSON  —— 一种纯文本数据格式，人和机器都能读，用来存素材清单与句子秒数 */

var MATERIALS_URL = 'data/materials.json';  /* 素材清单：一共有哪些音频、各属于哪个等级 */
var SEGMENTS_URL = 'data/segments.json';    /* 对齐数据：每句从第几秒到第几秒 */

/* ---- 三层视图的状态 ----
   levelList     清单里声明的等级，按声明顺序渲染成 L1 / L2 / L3 三个按钮
   allMaterials  全部素材（未筛选）；切等级时从这里挑
   allSegments   全部对齐数据；渲染每条素材时按 materialId 配对
   activeLevel   当前选中的等级；空字符串＝清单没声明等级
   activeFileId  当前【打开】的文件（素材 id）。空字符串＝还没打开任何一个 ——
                 ⚠️ 这是 Day 8 新加的一层：以前选中等级就直接把音频铺出来；
                    现在中间多了一层文件列表，必须点开具体文件才出音频与文本 */
var levelList = [];
var allLessons = [];                   /* Day 28：课程清单（L1 下的 Lesson1~Lesson23） */
var allMaterials = [];
var allSegments = [];
var activeLevel = '';
var activeLesson = '';                 /* 当前点进的课。空字符串＝还停在「课程列表页」 */
var activeFileId = '';

/* 秒数 → mm:ss，方便人一眼核对（6 → "00:06"） */
function formatClock(seconds) {
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

/* ⚠️ 下面 loadJSON / failureHTML / escapeHTML 三段，Day 23 之前是本文件自带的【复制品】。
   Day 23 收编：改由 assets/js/common.js 提供，本文件直接引用那一份。
   ⇒ 全站「失败提示」从此只有一个源头（home.js 同一天做了同样的收编）。
   ⚠️ reader.html 的 <script> 里，common.js 必须排在 app.js 之前。 */

/* ---- 两条取数捷径：筛选逻辑只写一处，免得以后改了这处漏了那处 ---- */

/* 当前等级下的素材。兜底：清单里没声明 levels（或声明为空）时不过滤，
   把素材全铺出来 —— 宁可显示得朴素一点，也不要因为少一个字段就整页空白 */
function materialsOfActiveLevel() {
  if (!activeLevel) return allMaterials;
  return allMaterials.filter(function (material) {
    return material.level === activeLevel;
  });
}

/* ---- Day 28：课程层（Lesson1~Lesson23）的两条取数捷径 ---- */

/* 当前等级声明了哪些课。没声明（L2 / L3）→ 空数组 =
   该等级没有「课程列表页」，行为跟以前一字不差 */
function lessonsOfActiveLevel() {
  if (!activeLevel) return [];
  return allLessons.filter(function (lesson) {
    return lesson.level === activeLevel;
  });
}

/* 当前等级、当前课下的素材。没点进课（activeLesson 为空）时返回空数组 ——
   ⚠️ 这是"两页互斥"的落点：课程列表页铺着的时候，音频页不该有内容。 */
function lessonsActiveMaterials() {
  if (!activeLesson) return [];
  return materialsOfActiveLevel().filter(function (material) {
    return material.lesson === activeLesson;
  });
}

/* 现在显示的是不是「课程列表页」—— 整个界面的分页开关就看它。
   两个渲染函数（renderFiles / renderMaterialView）都读这一个判断，
   免得一处改了、另一处忘了。 */
function showingLessonList() {
  return lessonsOfActiveLevel().length > 0 && !activeLesson;
}

/* 某条素材的对齐数据；没配到就返回空数组，交给调用方决定怎么提示 */
function segmentsOf(materialId) {
  var hit = allSegments.filter(function (item) {
    return item.materialId === materialId;
  })[0];
  return hit ? hit.segments : [];
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
  /* 标题行：左边标题、最右端倍速（Day 31 斌哥要求）。
     选中态从 localStorage 恢复（player.js 存的 er_play_rate），
     不靠 player.js 回填——素材卡是后来渲染的，渲染时带上 selected 最省事 */
  var savedRate = '1';
  try { savedRate = localStorage.getItem('er_play_rate') || '1'; } catch (e) {}
  var head = '<div class="mat-head">' +
               '<h2 class="mat-title">' + escapeHTML(material.title) + '</h2>' +
               '<select class="speed-select" data-role="speed" aria-label="播放倍速">' +
                 [['0.5','0.5X'],['0.75','0.75X'],['1','1X'],['1.25','1.25X'],['1.5','1.5X']]
                   .map(function (o) {
                     return '<option value="' + o[0] + '"' +
                            (o[0] === savedRate ? ' selected' : '') + '>' + o[1] + '</option>';
                   }).join('') +
               '</select>' +
             '</div>';
  /* data-mat / data-title：「上次学到」用 —— player.js 播放中只认得 DOM，
     靠这两个属性反查是哪条素材，进度才记得到正确的文件上 */
  var attrs = '<section class="material" data-audio="' + escapeHTML(material.audio) + '"' +
              ' data-mat="' + escapeHTML(material.id) + '"' +
              ' data-title="' + escapeHTML(material.title) + '">';

  /* 没有对齐数据就只显示标题，不给一个点了没反应的播放器 */
  if (!segments.length) {
    return attrs + head + '<p class="empty">这条素材还没有对齐数据</p></section>';
  }

  /* 播放控制条：上面一条时间进度条，下面一排键。
     Day 28 晚改版（斌哥要求）：播放键左右各加一个箭头（上一个 / 下一个音频），
     右侧再挂一个「A-B 复读」。
     布局（见 style.css 的 .player-controls）：
       中间一组 .player-transport = [◀] [播放/停止] [▶]  —— 三个一组，播放键仍然居中
       右边一组 .player-modes     = [单句重复] [A-B 复读]
     ⚠️ 箭头用 <button disabled> 表示"到头了"，不给一个点了没反应的键。 */
  var lastEnd = segments[segments.length - 1].end;
  var bar = '<div class="player">' +
              '<input type="range" class="progress" data-role="progress" ' +
                'min="0" step="0.1" value="0" max="' + lastEnd + '" ' +
                'aria-label="播放进度，拖动可跳到对应时间">' +
              '<div class="player-controls">' +
                '<div class="player-transport">' +
                  '<button type="button" class="icon-btn" data-action="prev-audio" aria-label="上一个音频">' +
                    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                      '<path d="M7 6h2.2v12H7zm11 0v12l-8.6-6z"></path>' +
                    '</svg>' +
                  '</button>' +
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
                  '<button type="button" class="icon-btn" data-action="next-audio" aria-label="下一个音频">' +
                    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                      '<path d="M14.8 6H17v12h-2.2zM6 6v12l8.6-6z"></path>' +
                    '</svg>' +
                  '</button>' +
                '</div>' +
                '<div class="player-modes player-modes--left">' +
                  /* 单句重复：Day 28 晚从右侧移到【左侧】（斌哥指示）——
                     两个模式键都堆在右边会和中间那组挤在一起、还会重合。
                     现在三组各占网格一格：左（单句重复）/ 中（切歌+播放）/ 右（A-B 复读）。
                     图标 + 文字，文字单独放进一个 span，
                     因为播放器切开关时要改的是这几个字，不能把图标一起冲掉。
                     aria-label 是兜底：窄屏会把文字藏起来，读屏软件得靠它念出名字 */
                  '<button type="button" class="btn item" data-action="toggle-repeat" ' +
                    'aria-pressed="false" aria-label="单句重复">' +
                    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                      '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"></path>' +
                    '</svg>' +
                    '<span data-role="repeat-label">单句重复</span>' +
                  '</button>' +
                '</div>' +
                '<div class="player-modes player-modes--right">' +
                  /* A-B 复读：三态一个键（设 A → 设 B → 循环中再点关闭），
                     状态文字由 player.js 的 syncABUI 改写；图标是两个点夹一条线（A…B）。 */
                  '<button type="button" class="btn item" data-action="toggle-ab" ' +
                    'aria-pressed="false" aria-label="A-B 复读">' +
                    '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
                      '<circle cx="6.6" cy="11.5" r="2.6"></circle>' +
                      '<circle cx="17.4" cy="11.5" r="2.6"></circle>' +
                      '<rect x="9.1" y="10.6" width="5.8" height="1.8" rx="0.9"></rect>' +
                    '</svg>' +
                    '<span data-role="ab-label">A-B 复读</span>' +
                  '</button>' +
                '</div>' +
              '</div>' +
              /* A/B 两个点的时刻写在这儿（比塞进按钮文字更好读） */
              '<p class="ab-readout" data-role="ab-readout"></p>' +
            '</div>';

  /* 每句带一个 --i（第几句），给 CSS 用来做「一句一句依次浮现」的延迟。
     ⚠️ 为什么把序号塞进 style 而不是在 CSS 里写 nth-child(1..16)：
        nth-child 要写死条数，素材多一句就漏一句；用 --i 则不管多少句都成立。
     ⚠️ CSS 那边会用 min(--i, 15) 封顶，所以长素材不会越等越久。
     ⚠️ Day 26 起按斌哥要求：不显示句子文字，只显示时间戳（序号 + 起止时刻）。 */
  var rows = segments.map(function (seg, i) {
    return '<li class="seg" style="--i:' + i + '" ' +
             'tabindex="0" role="button" ' +
             'data-start="' + seg.start + '" data-end="' + seg.end + '">' +
             '<span class="seg-idx">' + (seg.idx + 1) + '</span>' +
             '<span class="seg-body">' +
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

/* 主流程：读数据 → 铺等级目录 → 铺文件列表 → 铺音频文本区 */
function render() {
  var box = document.getElementById('reader');
  if (!box) return;

  /* R6：加载中要有状态提示。重试时也先回到这一句，用户才知道点下去有反应了 */
  box.innerHTML = '<p class="empty">正在加载素材…</p>';
  setLevelsHTML('');                       /* 重试时先收掉旧目录，免得新旧按钮混在一起 */
  setLessonsHTML('');
  setFilesHTML('');

  Promise.all([loadJSON(MATERIALS_URL), loadJSON(SEGMENTS_URL)])
    .then(function (result) {
      levelList = result[0].levels || [];
      allLessons = result[0].lessons || [];   /* Day 28：课程清单，与素材同一份文件 */
      allMaterials = result[0].materials || [];
      allSegments = result[1];

      /* 默认落在第一个等级上，但【不自动打开任何文件】——
         「点开文件才出音频」是这一层的意义所在，自动打开就等于把这一层跳过了。
         清单没声明等级时 activeLevel 留空字符串，走 materialsOfActiveLevel 的兜底。
         ⚠️ activeLesson 也跟着清空：进页面停在「课程列表页」（有课目录的等级）。 */
      activeLevel = levelList.length ? levelList[0] : '';
      activeLesson = '';
      activeFileId = '';

      /* 深链：?file=L1.1&t=13 → 自动打开该材料，定位到 t 秒（停止状态，不自动播）。
         free talk 页的「绿字」跳过来就走这条路（Day 26 加）。 */
      var params = new URLSearchParams(window.location.search);
      var dlFile = params.get('file');
      var dlT = parseFloat(params.get('t'));
      var dlMat = dlFile ? allMaterials.filter(function (m) { return m.id === dlFile; })[0] : null;
      if (dlMat) {
        activeLevel = dlMat.level;
        activeLesson = dlMat.lesson || '';
        activeFileId = dlMat.id;
      }

      renderLevels();
      renderLessons();
      renderFiles();
      renderMaterialView();

      if (dlMat && !isNaN(dlT) && window.Player) {
        var bar = document.querySelector('#reader .material');
        if (bar) window.Player.seekByProgress(bar, dlT, false);
      }
    })
    .catch(function (err) {
      /* 坏路径：读不到数据也要给人话 ＋ 重试入口，不能白屏（B1 / R6）。
         Day 23：改调 common.js 的统一版，参数（what / action）必须给全。 */
      setLevelsHTML('');
      setLessonsHTML('');
      setFilesHTML('');
      box.innerHTML = failureHTML(err, '素材', 'retry-load');
      console.error(err);
    });
}

/* 把等级目录铺成一行按钮（L1 / L2 / L3）。
   为什么用 <button> 而不是 <a>：这是「切换当前视图」，地址栏不会变；
   用链接会被读屏软件念成「跳转到另一个页面」，误导不该给。
   选中态交给 aria-pressed —— CSS 里 .btn[aria-pressed='true'] 已经有现成的高亮样式 */
function renderLevels() {
  setLevelsHTML(levelList.map(function (level) {
    return '<button type="button" class="btn item level-btn" data-action="pick-level" ' +
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

function setLessonsHTML(html) {
  var nav = document.getElementById('lessons');
  if (nav) nav.innerHTML = html;
}

function setFilesHTML(html) {
  var nav = document.getElementById('files');
  if (nav) nav.innerHTML = html;
}

/* Day 28：铺「课程列表页」—— Lesson1~Lesson23。
   ⚠️ 结构与音频行【完全同源】：两者都挂 .file-btn 那身皮（白底卡片、名称 + 小字两行、
      整宽、同样的内边距）——「尺寸都一样」不是靠对齐参数维持的，是同一套皮。
      唯一不同的名字：data-action="pick-lesson" 与 data-lesson。
   ⚠️ 只在「停在课程列表页」时铺；点进某一课后整页收起（斌哥要的是换页，不是叠页）。 */
function renderLessons() {
  var box = document.getElementById('lessons');
  var back = document.getElementById('lesson-back');
  if (!box) return;

  var lessons = lessonsOfActiveLevel();
  var listMode = lessons.length > 0 && !activeLesson;

  if (listMode) {
    /* Day 31：「上次学到」卡 —— 一键回到上次文本复读的位置。
       没有记录（第一次用）就不铺，列表页保持原样 */
    var last = readLastStudy();
    var resume = '';
    if (last && last.file && last.title) {
      /* 外观与 Lesson 卡区分（斌哥指示）：薄荷底 + 强调描边 + 左侧时钟徽标；
         尺寸/圆角/内边距仍走 .file-btn 同一套皮，不另起炉灶 */
      resume = '<button type="button" class="lesson-btn file-btn item resume" ' +
                 'data-action="resume-last">' +
                 '<span class="resume-ico" aria-hidden="true">' +
                   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
                     'stroke-linecap="round" stroke-linejoin="round">' +
                     '<circle cx="12" cy="12" r="9"></circle>' +
                     '<path d="M12 7v5l3.2 1.8"></path>' +
                   '</svg>' +
                 '</span>' +
                 '<span class="resume-txt">' +
                   '<span class="file-name">上次学到</span>' +
                   '<span class="file-meta">' + escapeHTML(last.title) + ' · ' +
                     formatClock(last.t || 0) + '</span>' +
                 '</span>' +
               '</button>';
    }
    box.innerHTML = resume + lessons.map(function (lesson) {
      var n = materialsOfActiveLevel().filter(function (m) {
        return m.lesson === lesson.id;
      }).length;
      return '<button type="button" class="lesson-btn file-btn item" data-action="pick-lesson" ' +
               'data-lesson="' + escapeHTML(lesson.id) + '">' +
               '<span class="file-name">' + escapeHTML(lesson.title) + '</span>' +
               '<span class="file-meta">' + (n ? n + ' 个音频' : '暂无素材') + '</span>' +
             '</button>';
    }).join('');
  } else {
    box.innerHTML = '';                    /* 不在列表页 → 整页收起（CSS .lessons:empty 不占位） */
  }

  /* Day 31：Lesson 列表套弹簧动效（reactbits AnimatedList 的"收养"模式）。
     ⚠️ 只加"动"（滚动入场 / 边缘渐隐），不改 .file-btn 的皮 ——
        行的样式、内容、点击委托全部原样，app.js 这里的渲染逻辑一行没变。
     ⚠️ 斌哥 19:36 指示：悬停跟随的描边滑块去掉（灰框跟着鼠标跑太扎眼）——
        所以传 selectOnHover:false + enableArrowNavigation:false，
        滑块 selected 恒为 -1，ring 永远隐藏，只留入场和渐隐。
     ⚠️ 组件未加载或列表为空时它什么都不做，业务零感知；
        每次重渲染都会重新 enhance（组件内部自己处理旧实例的清理）。
     ⚠️ 只包 Lesson 列表 —— 音频列表(#files)动不动，是另一个决定。 */
  if (window.AnimatedList && typeof AnimatedList.enhance === 'function') {
    AnimatedList.enhance(box, { selectOnHover: false, enableArrowNavigation: false });
  }

  /* 回路：「← Lesson 列表」只在"课程目录存在、且已经点进某一课"时露出来。
     进了 Lesson1 就再没别的路挑课 —— 那是死胡同，不是简洁。 */
  if (back) back.hidden = !(lessons.length > 0 && activeLesson);
}

/* 铺「文件列表」—— 当前等级下的音频文件，一条一行。
   三种显示状态都在这里收口（以前收在素材区，现在收在这一层，因为
   「这个等级没有文件」属于目录的事，不该让下面那块空白面板去说）：
     有文件   → 逐条铺
     该级为空 → 空状态（L2 / L3 现在没人放素材，点进去看到的就是这一种）
     整个清单空 → 另一种空状态（分开写，因为给用户的信息不一样）
   ⚠️ 打开态用 aria-current 而不是 aria-pressed：
      aria-pressed 念的是「这个按钮被按下了」，而这里要说的是
      「当前正打开的是这一个文件」—— 那是 aria-current 的语义。
      等级的 L1/L2/L3 用 aria-pressed 是对的（它们是互斥的开关），两者不一样。 */
function renderFiles() {
  var nav = document.getElementById('files');
  if (!nav) return;

  if (!allMaterials.length) {
    nav.innerHTML = '<p class="empty">暂无素材</p>';
    return;
  }

  /* Day 28：课程列表页铺着的时候，音频页整块让位 —— 两页互斥（斌哥要的换页） */
  if (showingLessonList()) {
    nav.innerHTML = '';
    return;
  }

  /* 点进了某一课 → 只看这一课里的音频；没点课（L2 / L3 这种没有课程目录的等级）
     → 看整个等级下的音频，行为与以前一字不差 */
  var list = activeLesson ? lessonsActiveMaterials() : materialsOfActiveLevel();
  if (!list.length) {
    /* 空状态：说清是哪一个范围没有内容，而不是让人以为整站挂了 */
    nav.innerHTML = '<p class="empty">' +
      escapeHTML(activeLesson ? activeLevel + ' · ' + activeLesson + ' 暂无素材'
                              : activeLevel + ' 暂无素材') +
      '</p>';
    return;
  }

  nav.innerHTML = list.map(function (material) {
    var segs = segmentsOf(material.id);
    var meta = segs.length
      ? '共 ' + segs.length + ' 句 · ' +
        formatClock(segs[0].start) + ' – ' + formatClock(segs[segs.length - 1].end)
      : '还没有对齐数据';
    return '<button type="button" class="file-btn item" data-action="pick-file" ' +
             'data-file="' + escapeHTML(material.id) + '" ' +
             'aria-current="' + (material.id === activeFileId ? 'true' : 'false') + '">' +
             '<span class="file-name">' + escapeHTML(material.title) + '</span>' +
             '<span class="file-meta">' + escapeHTML(meta) + '</span>' +
           '</button>';
  }).join('');
}

/* 铺「音频文本区」—— 只有打开了文件才铺。
   三种状态：
     等级下没有文件 → 整块留空（空状态已经在文件列表那边说过了，这里再说一遍就是重复）
     还没打开文件   → 给一句提示，说清「要先点上面」，而不是让人以为坏了
     打开了文件     → 铺素材卡片（音频 ＋ 文本）
   ⚠️ 留空的写法是 innerHTML = ''，CSS 里 #reader:empty 会让整块白面板收起来，
      免得页面上挂着一块空卡片还占位置 */
function renderMaterialView() {
  var box = document.getElementById('reader');
  if (!box) return;

  /* Day 28：课程列表页铺着 / 这一课里没有素材 → 素材区整块留空
     （空状态已经在文件列表那边说过了，这里再说一遍就是重复） */
  if (!allMaterials.length ||
      !materialsOfActiveLevel().length ||
      showingLessonList() ||
      (activeLesson && !lessonsActiveMaterials().length)) {
    box.innerHTML = '';
    return;
  }

  var material = allMaterials.filter(function (item) {
    return item.id === activeFileId;
  })[0];

  if (!material) {
    /* Day 28 晚（斌哥指示）：这里原来挂着一句「请从上面的列表里点开一个文件…」，
       整块白面板又大又空，删掉 —— 文件列表就紧贴在上面，怎么操作一眼就看得出来，
       不需要再写一句提示。留空即可，CSS 的 #reader:empty 会把整块面板收掉。 */
    box.innerHTML = '';
    return;
  }

  box.innerHTML = buildMaterialHTML(material, segmentsOf(material.id));
  /* Day 32（斌哥要求）：把倍速 <select> 换成 Glide Select 外观。
     只换皮不动逻辑 —— glide-select.js 内部仍然写回这个 select 的 value
     并派发原生 change，player.js 的监听器照常工作。
     ⚠️ 这一步失败（脚本没加载）也不影响功能：原生下拉原样可见可用。 */
  if (window.GlideSelect) window.GlideSelect.enhanceAll(box);
  probeAllAudio(box);
  syncAudioNav();

  /* Day 31：记「上次学到」。开新文件 → t 归零起账；
     重开同一文件 → 保留原进度（这正是「上次学到」要接上来的那笔账） */
  var lastRec = readLastStudy();
  if (!lastRec || lastRec.file !== material.id) {
    saveLastStudy({ file: material.id, title: material.title, t: 0, ts: Date.now() });
  }
}

/* ---- Day 28：上一个 / 下一个音频 ----
   箭头是"在当前这一份列表里前后挪一格"，列表的算法与文件列表完全同一套：
   点进了某一课就只在那一课里挪；没点课（L2 / L3）就在整个等级里挪。
   ⚠️ 抽成 currentFileList() 一处：列表来源只此一份，
      免得"文件的顺序"和"箭头的顺序"哪天各走各的。 */
function currentFileList() {
  return activeLesson ? lessonsActiveMaterials() : materialsOfActiveLevel();
}

/* 箭头到头了就禁用 —— 点一个没反应的键比没有键更让人疑惑 */
function syncAudioNav() {
  var list = currentFileList();
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === activeFileId) { idx = i; break; }
  }
  var prev = document.querySelector('#reader [data-action="prev-audio"]');
  var next = document.querySelector('#reader [data-action="next-audio"]');
  if (prev) prev.disabled = !(idx > 0);
  if (next) next.disabled = !(idx >= 0 && idx < list.length - 1);
}

/* 切到前一条 / 后一条音频：换 activeFileId → 重铺素材区 → 自动开始播放。
   ⚠️ 自动播是有意的：箭头的用途就是"连着听下一条"，换过去还等用户再点一次播放键，
      等于把这个功能做了一半。 */
function switchAudio(step) {
  var list = currentFileList();
  if (!list.length) return;

  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === activeFileId) { idx = i; break; }
  }
  var target = (idx < 0 ? 0 : idx + step);
  if (target < 0 || target >= list.length) return;      /* 到头了：按钮本来就是禁用的，这里是双保险 */

  if (window.Player && window.Player.stop) window.Player.stop();   /* 先把旧的停干净，别叠音 */
  activeFileId = list[target].id;

  renderFiles();                       /* 让文件列表那条的选中态跟着走 */
  renderMaterialView();

  var bar = document.querySelector('#reader .material');
  if (bar && window.Player && window.Player.togglePlay) window.Player.togglePlay(bar);
}

/* 渲染完顺手探一遍音频在不在（B2：不用等用户点下去才发现缺失）。
   先确认 box 真的有 querySelectorAll —— 测试用的假页面没有这个方法，别把测试搞崩 */
function probeAllAudio(box) {
  if (!box.querySelectorAll) return;
  var sections = box.querySelectorAll('.material');
  for (var i = 0; i < sections.length; i++) {
    var audioPath = sections[i].getAttribute('data-audio');
    if (audioPath) probeAudio(sections[i], audioPath);
  }
}

/* 切等级：先停播，再换文件列表。
   ⚠️ 那行 stop() 不能省 —— player.js 把 Audio 对象按路径缓存着，
   只换 innerHTML 只会把播放控件从画面上抹掉，声音还在响，
   变成「看不见的播放器」：页面上一片安静，后台一直有人在读课文。 */
/* Day 31：点「上次学到」→ 直接回到那次复读的素材与进度。
   跳转 = 复用深链那套：摆好 active 三件套 → 整页重铺 → seekByProgress 拨播放头。
   素材已不存在（清单换了）→ 静默收起，卡片下次渲染自然消失 */
function resumeLast() {
  var last = readLastStudy();
  if (!last || !last.file) return;
  var mat = allMaterials.filter(function (m) { return m.id === last.file; })[0];
  if (!mat) { saveLastStudy(null); return; }

  if (window.Player && window.Player.stop) window.Player.stop();
  activeLevel = mat.level;
  activeLesson = mat.lesson || '';
  activeFileId = mat.id;
  renderLevels();
  renderLessons();
  renderFiles();
  renderMaterialView();

  if ((last.t || 0) > 0 && window.Player && window.Player.seekByProgress) {
    var bar = document.querySelector('#reader .material');
    if (bar) window.Player.seekByProgress(bar, last.t, false);
  }
}

function pickLevel(level) {
  if (!level || level === activeLevel) return;
  if (window.Player && window.Player.stop) window.Player.stop();

  activeLevel = level;
  activeLesson = '';                 /* 换了等级 → 退回该等级的「课程列表页」 */
  activeFileId = '';                 /* 换了等级，原来打开的文件要合上 */

  /* 只改 aria-pressed，不重铺整排按钮 —— 重铺会把用户刚点的那个按钮换掉，
     键盘焦点会丢，读屏软件也会重新念一遍整排 */
  var btns = document.querySelectorAll('[data-action="pick-level"]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-pressed',
      btns[i].getAttribute('data-level') === level ? 'true' : 'false');
  }

  renderLessons();
  renderFiles();
  renderMaterialView();
}

/* Day 28：点进某一课 —— 从「课程列表页」换到「音频选择页」。
   先停播（同 pickLevel 的道理）：换页会把播放控件从画面上抹掉，
   player.js 缓存的 Audio 还在响，就成了"看不见的播放器"。 */
function pickLesson(id) {
  if (!id || id === activeLesson) return;
  if (window.Player && window.Player.stop) window.Player.stop();

  activeLesson = id;
  activeFileId = '';                 /* 换课 → 原来打开的文件要合上 */

  renderLessons();                   /* 课程列表收起 + 回路露出来 */
  renderFiles();
  renderMaterialView();
}

/* Day 28：回「课程列表页」。就是 pickLesson 的逆操作 ——
   清掉 activeLesson，课程列表重新铺、音频页收起。 */
function backToLessons() {
  if (!activeLesson) return;
  if (window.Player && window.Player.stop) window.Player.stop();

  activeLesson = '';
  activeFileId = '';

  renderLessons();
  renderFiles();
  renderMaterialView();
}

/* 打开一个文件（素材）。这才是「音频出现」的那一下 —— Day 8 新增的一层。
   和 pickLevel 一样：只改 aria-current、不重铺整列，免得刚点的那个按钮被换掉、键盘焦点丢掉。 */
function pickFile(id) {
  if (!id || id === activeFileId) return;
  if (window.Player && window.Player.stop) window.Player.stop();

  activeFileId = id;

  var btns = document.querySelectorAll('[data-action="pick-file"]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].setAttribute('aria-current',
      btns[i].getAttribute('data-file') === id ? 'true' : 'false');
  }

  renderMaterialView();
}

/* 点「重试」→ 整页重来一遍；点等级按钮 → 切到那个等级；点文件 → 打开它。
   三个都用事件代理挂在 document 上，不依赖按钮何时被渲染出来 */
document.addEventListener('click', function (e) {
  var el = e.target;
  if (!el || !el.closest) return;

  if (el.closest('[data-action="retry-load"]')) {
    render();
    return;
  }

  /* Day 31：「上次学到」卡 → 一键跳回上次的素材与进度 */
  if (el.closest('[data-action="resume-last"]')) {
    resumeLast();
    return;
  }

  var pick = el.closest('[data-action="pick-level"]');
  if (pick) {
    pickLevel(pick.getAttribute('data-level'));
    return;
  }

  /* Day 28：点进某一课 */
  var lesson = el.closest('[data-action="pick-lesson"]');
  if (lesson) {
    pickLesson(lesson.getAttribute('data-lesson'));
    return;
  }

  /* Day 28：从音频页回课程列表页 */
  if (el.closest('[data-action="back-lessons"]')) {
    backToLessons();
    return;
  }

  /* Day 28：上一个 / 下一个音频（列表在 app.js 手里，所以这两个键也由这里接） */
  if (el.closest('[data-action="prev-audio"]')) { switchAudio(-1); return; }
  if (el.closest('[data-action="next-audio"]')) { switchAudio(1);  return; }

  var file = el.closest('[data-action="pick-file"]');
  if (file) pickFile(file.getAttribute('data-file'));
});

document.addEventListener('DOMContentLoaded', render);
