/* ============================================
   player.js —— 分段点播 ＋ 进度条拖拽（Day 7 第 4 步及其改造）
   一句话：整段音频只加载一次；点句子播那一句，拖进度条跳到那个时间往后连着播。
   依据：TECH_DESIGN.md「二、技术路线」2.4（原生音频 + 时间戳切窗口）、2.6（iOS 限制）
   ============================================ */

/* 术语备注：
   Audio        —— 浏览器自带的音频播放器；同一条素材本文件永远只建一个实例
   currentTime  —— 播放头的位置（秒）。拨它 = 跳到音频的某一点；换 src 则等于重新加载
   rAF          —— requestAnimationFrame：画面每次重绘前回调一次，约每秒 60 次 */

var Player = (function () {
  'use strict';

  /* 当前正在播的东西，两种模式：
       mode 'segment'：点某一句（或开着重复拖进度条）→ 播到这一句的终点
       mode 'free'   ：拖进度条 → 从落点往后连着播，高亮跟着播放头一句句走
     inWindow 是一道闸门：确认播放头真的到过指定位置，才允许做终点判断。
     理由见 checkBoundary 的注释 —— 真实浏览器里 seek 不是瞬间生效的。 */
  var audios = {};            /* 音频路径 → Audio 对象（同一条素材只建一个，iOS 上最稳） */
  var barsBySrc = {};         /* 音频路径 → 它那块素材的容器，用来在时长到手后修正进度条上限 */
  var current = null;         /* 当前载入的这一句／这一段；null = 什么都没在播 */
  var repeatOn = false;       /* 单句重复开关（R5） */

  /* ---- Day 31：倍速（0.5X–1.5X，斌哥要求）----
     选择记进 localStorage（er_play_rate），app.js 渲染下拉时读同一个键恢复选中。
     ⚠️ 音频对象按 src 缓存（audios），换素材不会新建元素——但倍速要【对所有缓存音频】生效，
        所以 change 时逐个套；新建音频时也套一次；'play' 事件里再兜底重套一次
        （Safari 换源后偶发把 playbackRate 重置回 1，多套一遍不花钱）。 */
  var RATE_KEY = 'er_play_rate';
  var rate = 1;
  try { rate = parseFloat(localStorage.getItem(RATE_KEY)) || 1; } catch (e) {}

  /* ⚠️ Day 32 修「改完倍速，几秒后自己回到 1 倍速」——
     两个必须一起设，少一个就会被浏览器偷回去：

     规范里 playbackRate 被重置时，落点是 defaultPlaybackRate（默认就是 1）。
     而会触发重置的时机，全是播放过程中会自然发生的事情：
       换源 / load() / 部分移动端（iOS Safari、微信内置浏览器）在 seek 之后或暂停恢复时。
     只设 playbackRate 的话，任何一次重置都等于「悄悄回 1 倍速」，
     用户看到的现象就是「改的时候变快了，几秒钟后又变回去了」。

     实测（Edge/Chromium，同一段音频）：
       只设 playbackRate=1.5 → 调一次 load() → playbackRate 变回 1
       两个都设 1.5         → 调一次 load() → playbackRate 仍是 1.5
     所以这里把 defaultPlaybackRate 也钉到同一个值：重置的落点也归我们管。 */
  function applyRate(a) {
    try {
      a.defaultPlaybackRate = rate;   /* 先钉默认值：重置的落点 */
      a.playbackRate = rate;          /* 再钉当前值：立刻生效的那一个 */
    } catch (e) {}
  }

  /* ---- Day 31：「上次学到」的进度记账 ----
     只更新 t（元数据由 app.js 打开素材时立账），file 对不上就不动账本，
     防止慢悠悠的后台播放把别的素材的位置写花 */
  function saveStudyT(t) {
    if (!current || !current.bar || typeof t !== 'number' || isNaN(t) || t < 0) return;
    var matId = current.bar.getAttribute('data-mat');
    if (!matId) return;
    var rec = readLastStudy();
    if (!rec || rec.file !== matId) return;
    rec.t = t;
    rec.ts = Date.now();
    saveLastStudy(rec);
  }

  /* ---- Day 28：A-B 复读的状态 ----
     ab.bar 记着"这套 A/B 是哪块素材上的"：换素材后旧标记自动作废（对不上号）。
     b === null 表示"设了 A、还在等 B"；a/b 都是秒数。
     ⚠️ 与单句重复【互斥】：两个都是"循环"模式，同时开着会互相抢播放头。
        开 A-B 自动关单句重复，开单句重复自动清 A-B（见 toggleAB / toggleRepeat）。 */
  var ab = { bar: null, a: null, b: null };
  var tickId = null;          /* rAF 句柄 */
  var seekCheckTimer = null;  /* 跳播结果复查定时器（见 verifySeek） */
  var dragging = false;       /* 用户正按着进度条：这时候不要让代码去覆盖他拖到的位置 */
  var reachedTail = false;    /* 上一次收尾是不是因为播到了整段末尾
                                 （决定播放键下次按下时"从头播"还是"从当前位置播"） */

  /* ---------- Day 28：A-B 复读 ---------- */

  /* 已设 A 且已设 B（真正在循环） / 只设了 A（还在等 B） */
  function abActive() { return !!(ab.bar && ab.a !== null && ab.b !== null); }
  function abArmed()  { return !!(ab.bar && ab.a !== null); }

  /* 时刻显示：复用 app.js 的 formatClock（同在一个页面作用域里，它先加载） */
  function clock(sec) {
    return (typeof formatClock === 'function') ? formatClock(sec) : String(sec);
  }

  /* 按钮文字 + 时刻读出，一处改两处生效。
     三态文案：
       没设      → 「A-B 复读」
       设了 A    → 「已设 A · 再点设 B」
       在循环    → 「A-B 复读 · 开」 */
  function syncABUI() {
    var btns = document.querySelectorAll('[data-action="toggle-ab"]');
    var text = abActive() ? 'A-B 复读 · 开'
             : (abArmed() ? '已设 A · 再点设 B' : 'A-B 复读');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', abActive() ? 'true' : 'false');
      btns[i].setAttribute('aria-label', abActive()
        ? ('A-B 复读开着：' + clock(ab.a) + ' 到 ' + clock(ab.b) + '，再点一次关闭')
        : (abArmed() ? ('已设 A 点 ' + clock(ab.a) + '，再点一次设 B 点') : 'A-B 复读'));
      /* ⚠️ 只改文字那个 span，别用 textContent 整个覆盖 —— 那会把按钮里的图标一起冲掉 */
      var label = btns[i].querySelector('[data-role="ab-label"]');
      if (label) label.textContent = text;
    }

    var read = document.querySelector('[data-role="ab-readout"]');
    if (read) {
      read.textContent = abActive()
        ? ('A ' + clock(ab.a) + ' → B ' + clock(ab.b) + ' · 在这一段里循环')
        : (abArmed() ? ('A ' + clock(ab.a) + ' · 播到终点时再点一次「设 B」') : '');
    }
  }

  /* 清掉 A/B 标记。挂在哪都安全（没设过就什么都不做）。
     ⚠️ 顺手把 current.mode 从 'ab' 退回 'free'：否则播放头走到 B 之后
        再也没人管边界判断，会一路播到底、也不收尾。 */
  function clearAB(bar, note) {
    var had = abArmed();
    ab = { bar: null, a: null, b: null };
    if (current && current.mode === 'ab') current.mode = 'free';
    if (had) {
      syncABUI();
      if (note && bar) setStatus(note, bar);
    }
  }

  /* 把播放头搬进 [A,B] 并进入 'ab' 模式（循环由 checkBoundary 执行） */
  function enterABRange(bar, audio) {
    var el = segAtTime(bar, ab.a);
    current = {
      el: el, bar: bar, audio: audio, mode: 'ab', inWindow: false,
      start: ab.a, end: ab.b
    };
    reachedTail = false;
    highlight(el);

    if (audio.paused) {
      audio.currentTime = ab.a;
      startAudio(audio, '没能开始播放，请再按一次播放', bar);
      startTicking();
    } else if (audio.currentTime < ab.a - 0.2 || audio.currentTime > ab.b) {
      /* 正在播但不在区间里 → 拨到 A 点 */
      audio.currentTime = ab.a;
    }
    syncProgress(bar, ab.a);
  }

  /* A-B 键：三态一个键（设 A → 设 B → 关闭） */
  function toggleAB(bar) {
    if (!bar) return;
    var src = bar.getAttribute('data-audio');
    if (!src) return;
    if (blockedByUnavailable(bar)) return;

    var audio = getAudio(src);
    registerBar(src, bar);

    /* 换了素材 → 旧的 A/B 对不上号了，先归零重来 */
    if (ab.bar && ab.bar !== bar) clearAB();

    /* "此刻"是哪一刻：正在播就用播放头，否则用进度条的位置（没播时它以 0 兜底） */
    var here = (current && current.bar === bar && !audio.paused)
      ? audio.currentTime
      : progressValue(bar);

    /* ① 还没设 A → 设 A */
    if (!abArmed()) {
      ab.bar = bar;
      ab.a = here;
      ab.b = null;
      setStatus('已设 A 点 ' + clock(ab.a) + '。播到这一段终点时，再点一次「A-B 复读」设 B 点。', bar);
      syncABUI();
      return;
    }

    /* ② 设了 A 还没设 B → 设 B 并开始循环 */
    if (ab.b === null) {
      if (here - ab.a < 0.5) {
        setStatus('B 点要比 A 点晚至少半秒。先往后播一点，再点这个键。', bar);
        return;
      }
      ab.b = here;
      /* 与单句重复互斥：两个循环模式同时开会互相抢播放头 */
      if (repeatOn) toggleRepeat();
      enterABRange(bar, audio);
      setStatus('A-B 复读已开启：' + clock(ab.a) + ' → ' + clock(ab.b) + ' 之间循环。再点一次关闭。', bar);
      syncABUI();
      return;
    }

    /* ③ 已在循环 → 关闭（播放照常继续，只是不再拉回来） */
    clearAB();
    setStatus('A-B 复读已关闭。', bar);
  }

  /* ---------- Day 28：复读时长累计 ----------
     口径（斌哥拍板）：**只在音频真的在响的时候累加**，页面挂着不算。

     ⚠️ 为什么在每帧的 tick 里按时间差累加，而不是在播放键上挂"开始/结束"事件：
        暂停可能来自任何地方（切后台、系统打断、浏览器拒绝播放、拖动进度），
        挂事件得挂一串，漏一个就把时间算歪；
        每帧问一句"这一刻音频在响吗"，天然覆盖全部情况 —— 这也是本项目
        一贯的判据方式（syncPlayButtons 也是直接问 audio.paused，不另存状态）。

     ⚠️ 单帧时间差封顶 2 秒：标签页被浏览器节流时，一帧可能隔好几十秒才来，
        不封顶就会把"根本没在听的时间"也算进去。**宁少算，不多算** ——
        排行榜是要给人看的，虚报时长等于把榜做废。 */
  var usageSeconds = 0;        /* 已累计、还没上报的秒数（保留小数，取整才交付） */
  var usageMark = 0;           /* 上一次记账的时刻 */

  function accumulateUsage() {
    var nowMs = (window.performance && performance.now) ? performance.now() : Date.now();
    if (!usageMark) { usageMark = nowMs; return; }
    var dt = (nowMs - usageMark) / 1000;
    usageMark = nowMs;

    if (!current || !current.audio || current.audio.paused) return;
    if (dt > 0 && dt <= 2) usageSeconds += dt;
  }

  /* 倍速自愈：播放中任何时刻发现「当前值不是用户选的那个」，立刻按回去。
     两道触发，覆盖两种运行状态：
       · tick()    —— 前台每帧一次，最快 16ms 就纠回来（用户听不出来）
       · timeupdate —— 后台标签页里 rAF 会被降频/冻结，但媒体事件照常，约每秒 4 次
     为什么要自愈而不是只靠 applyRate：会重置倍速的时机（换源、load、seek、
     个别移动端 webview 的省电策略）散落在播放过程里，逐个去 hook 挂不全；
     反过来盯住「最终值对不对」，谁改的都一样纠。代价只是一次数值比较。 */
  function ensureRate() {
    if (!current || !current.audio) return;
    if (Math.abs(current.audio.playbackRate - rate) > 0.001) applyRate(current.audio);
  }

  /* ---------- 取音频对象 ---------- */

  /* 有就复用，没有才新建。绝不每次 new、绝不换 src（TECH_DESIGN 2.6） */
  function getAudio(src) {
    if (!audios[src]) {
      var audio = new Audio();
      audio.preload = 'auto';
      audio.src = src;
      applyRate(audio);                 /* 新建的音频也按当前倍速来 */

      /* 时长一拿到，就把进度条的上限改成真实时长
         （进度条初始上限是"最后一句的终点"，比音频真实时长略短） */
      audio.addEventListener('loadedmetadata', function () {
        var bar = barsBySrc[src];
        if (bar) syncDuration(bar, audio);
        /* Day 34：点句后是「往后连着播」，而点的那一刻时长往往还没读出来
           （audio 对象是点下去才建的），当时只能把 end 兜底成起点。
           元数据一到就补成真实时长，别让 current.end 留个过时的值 */
        if (current && current.audio === audio && current.mode === 'free') {
          current.end = audio.duration;
        }
      });

      /* 播到文件末尾：开着单句重复就拨回本句起点接着转，否则收尾。
         不能无脑 stop() —— 否则最后一句打开重复会直接失效 */
      audio.addEventListener('ended', function () {
        if (repeatOn && current && current.audio === audio && current.mode === 'segment') {
          audio.currentTime = current.start;
          current.inWindow = false;          /* 回拨后重新等 seek 落地 */
          var again = audio.play();
          if (again && again.catch) {
            again.catch(function () { stop(); });
          }
        } else {
          reachedTail = true;                /* 整段播完了 —— 下次按播放键应该从头来 */
          stop();
        }
      });

      /* 播放状态一变就刷新播放/暂停图标。
         挂着听事件比自己记状态可靠：暂停可能来自别处（比如切走页面、系统打断） */
      audio.addEventListener('play', function () {
        applyRate(audio);               /* 兜底：个别浏览器换源后会重置倍速 */
        syncPlayButtons();
      });
      audio.addEventListener('pause', function () {
        syncPlayButtons();
        /* Day 31：暂停/切走时把播放头位置记进「上次学到」（确属当前素材才记） */
        if (current && current.audio === audio) saveStudyT(audio.currentTime);
      });

      /* 兜底：后台标签页里 rAF 会被浏览器降频甚至冻结，但媒体事件照常触发，
         所以让 timeupdate 也走一遍同一个判断 */
      audio.addEventListener('timeupdate', function () {
        if (current && current.audio === audio) {
          ensureRate();                  /* Day 32：后台也守倍速，见 ensureRate 注释 */
          checkBoundary();
        }
      });

      /* 音频文件本身读不到（404 / 断网）：必须说出来，不能让用户点了没反应。
         只标记出事的这一条，别的素材照常用（B2） */
      audio.addEventListener('error', function () { markUnavailable(src); });

      audios[src] = audio;
    }
    return audios[src];
  }

  /* 状态提示要写在「出事的那一条素材」上。
     不能全局取第一个 —— 多条素材时，第二条坏了却把提示写在第一条身上，
     用户会去查第一条，那就是误导（B2）。 */
  function setStatus(text, bar) {
    var box = bar
      ? bar.querySelector('[data-role="status"]')
      : document.querySelector('[data-role="status"]');
    if (box) box.textContent = text || '';
  }

  /* 这条素材坏掉时写给用户看的话（只有一处定义，免得改文案时漏掉某一处） */
  var UNAVAILABLE_TEXT = '素材暂不可用：音频文件读不到（可能还没上传）。其他素材不受影响。';

  /* 把某条素材标成「暂不可用」：写提示 ＋ 禁掉它的播放入口（B2）。
     别的素材完全不受影响 —— 一条坏掉不该让整页瘫掉。 */
  function markUnavailable(src) {
    var bar = barsBySrc[src];
    if (bar) {
      bar.classList.add('is-unavailable');
      var btn = bar.querySelector('[data-action="toggle-play"]');
      if (btn) btn.setAttribute('disabled', 'disabled');
    }
    setStatus(UNAVAILABLE_TEXT, bar);
  }

  /* 这条素材的音频读不到：点它也只会再报一次，直接拦下（B2） */
  function blockedByUnavailable(bar) {
    if (!bar || !bar.classList || !bar.classList.contains('is-unavailable')) return false;
    setStatus(UNAVAILABLE_TEXT, bar);
    return true;
  }

  /* ---------- 界面同步 ---------- */

  function clearHighlight() {
    var all = document.querySelectorAll('.seg.is-playing');
    for (var i = 0; i < all.length; i++) {
      all[i].classList.remove('is-playing');
    }
  }

  function highlight(el) {
    clearHighlight();
    if (el) el.classList.add('is-playing');
  }

  /* 找出某个时间点落在哪一句里；落在句子之间的空隙就返回 null */
  function segAtTime(bar, seconds) {
    var segs = bar.querySelectorAll('.seg');
    for (var i = 0; i < segs.length; i++) {
      var start = parseFloat(segs[i].getAttribute('data-start'));
      var end = parseFloat(segs[i].getAttribute('data-end'));
      if (seconds >= start && seconds < end) return segs[i];
    }
    return null;
  }

  /* 「离这一秒最近的一句」——segAtTime 的兜底版。
     只有播放头不在任何句子区间内时才有意义（开头前奏、结尾余音、句子之间的缝）。
     ⚠️ 为什么不用「第一句」或「最后一句」了事：那样在段落中段的缝里会突然跳到很远的一句。
        这里按「离得最近」取，方向也对得上 —— 前奏里取后面第一句，余音里取最后一句。 */
  function segNear(bar, seconds) {
    var segs = bar.querySelectorAll('.seg');
    if (!segs.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < segs.length; i++) {
      var s = parseFloat(segs[i].getAttribute('data-start'));
      var e = parseFloat(segs[i].getAttribute('data-end'));
      if (isNaN(s) || isNaN(e)) continue;
      if (seconds >= s && seconds < e) return segs[i];
      var d = seconds < s ? (s - seconds) : (seconds - e);
      if (d < bestD) { bestD = d; best = segs[i]; }
    }
    return best;
  }

  /* 进度条跟着播放头走。注意：用户正按着的时候不许覆盖，否则手感会"抢方向盘" */
  function syncProgress(bar, seconds) {
    if (!bar || dragging) return;
    var input = bar.querySelector('[data-role="progress"]');
    if (input) input.value = String(seconds);
  }

  function syncDuration(bar, audio) {
    var input = bar.querySelector('[data-role="progress"]');
    if (input && audio.duration && isFinite(audio.duration)) {
      input.max = String(audio.duration);
    }
  }

  function registerBar(src, bar) {
    if (!bar) return;
    barsBySrc[src] = bar;
    syncDuration(bar, getAudio(src));      /* 时长早就加载过的话，这里直接同步 */
  }

  /* 读进度条当前值（播放键"从这儿开始播"用的就是它） */
  function progressValue(bar) {
    var input = bar.querySelector('[data-role="progress"]');
    var v = input ? Number(input.value) : 0;
    return (isFinite(v) && v > 0) ? v : 0;
  }

  /* 刷新所有播放/暂停图标。
     判据是"这块素材的音频此刻真的在响吗" —— 不另外存一份状态，
     免得存的那份和音频实际情况对不上（那类 bug 最难查）。 */
  function syncPlayButtons() {
    var btns = document.querySelectorAll('[data-action="toggle-play"]');
    for (var i = 0; i < btns.length; i++) {
      var bar = btns[i].closest ? btns[i].closest('.material') : null;
      var playing = !!(current && current.audio && !current.audio.paused &&
                       (!bar || current.bar === bar));
      btns[i].setAttribute('aria-pressed', playing ? 'true' : 'false');
      /* 标签与图标都是「停止」（方块 ■）：这个键按下去的效果是停止
         （音频停 ＋ 播放头归位 ＋ 高亮清空），照实说，不再存在图标与行为对不上的问题 */
      btns[i].setAttribute('aria-label', playing ? '停止' : '播放');
    }
  }

  /* ---------- 边界判断 ---------- */

  /* 判断「该不该收尾／该高亮哪一句」。
     ⚠️ 关键：真实浏览器里给 currentTime 赋值**不是瞬间生效的**，seek 要等 1~2 帧才落地。
        刚切句的那一瞬间，播放头还停在上一句的位置；如果直接拿这个旧位置去比新句的终点，
        会误判成「已经播完了」当场停掉 —— 点靠前的句子就没声音了。
        所以必须先确认播放头**真的到过指定位置**（inWindow 这道闸），再谈别的。 */
  function checkBoundary() {
    if (!current) return;

    var audio = current.audio;
    var t = audio.currentTime;

    /* ⓪ Day 28：A-B 复读 —— 播放头碰到 B 点就拉回 A 点。
       放在最前面，因为它是"比单句更外层的循环"；两条同时生效会互相抢播放头，
       所以 toggleAB / toggleRepeat 里做了互斥（开一个自动关另一个）。 */
    if (current.mode === 'ab' && current.bar === ab.bar && abActive()) {
      if (!current.inWindow) {
        if (t < current.start - 1.0) return;      /* seek 还在路上，等下一帧 */
        current.inWindow = true;
      }
      var elAB = segAtTime(current.bar, t);
      if (elAB && elAB !== current.el) {
        highlight(elAB);
        current.el = elAB;
      }
      if (t >= current.end) {
        audio.currentTime = current.start;
        current.inWindow = false;                 /* 回拨后重新等 seek 落地 */
      }
      return;
    }
    /* 还挂着 'ab' 模式但 A-B 已经被清掉（用户点了句/拖了进度）→ 退回自由播放，
       否则下面那些分支一条都不会命中，播放就"失管"了 */
    if (current.mode === 'ab') current.mode = 'free';

    /* ① 闸门：还没确认到过位置，就只试着开闸 */
    if (!current.inWindow) {
      var arrived = current.mode === 'free'
        ? Math.abs(t - current.start) < 1.5
        : (t >= current.start && t <= current.end);
      if (!arrived) return;                  /* seek 还在路上，等下一帧再看 */
      current.inWindow = true;
    }

    /* ② 自由模式（拖进度条）：高亮跟着播放头走，不在句末停 */
    if (current.mode === 'free') {
      var el = segAtTime(current.bar, t);
      if (el && el !== current.el) {
        highlight(el);
        current.el = el;
      }
      if (audio.duration && isFinite(audio.duration) && t >= audio.duration) {
        reachedTail = true;                /* 整段播到末尾 —— 播放键下次按下从头来 */
        stop();
      }
      return;
    }

    /* ③ 分段模式（点句子）：播到本句终点就收尾，或按重复开关回到起点 */
    if (!audio.paused && t >= current.end) {
      if (repeatOn) {
        /* 单句重复：把播放头拨回起点继续播，同时重新关上闸门 ——
           否则 seek 落地前每一帧都会再拨一次，一圈能拨好几次，声音会打结。
           不能用 <audio loop> —— 那个循环的是整段音频，不是这一句（TECH_DESIGN 2.4 实现要点③）*/
        audio.currentTime = current.start;
        current.inWindow = false;
      } else {
        stop();
      }
    }
  }

  /* 每帧看一眼。
     为什么用 rAF 而不是只靠 timeupdate：timeupdate 每秒只触发约 4 次，
     而本项目最短的句子只有 1 秒，会播过界 0.25 秒左右；rAF 约每秒 60 次，切得干净。
     （timeupdate 仍保留作后台标签页的兜底，见 getAudio） */
  function tick() {
    if (!current) return;

    /* Day 32：每帧校一次倍速 —— 见上面 ensureRate 的说明。
       这是第二道闸：applyRate 已经把 defaultPlaybackRate 钉住了，
       万一某个浏览器还有别的手法把 playbackRate 改回 1，这一帧就纠回来。 */
    ensureRate();

    accumulateUsage();                       /* Day 28：先记时长，再判边界 */
    checkBoundary();
    if (!current) return;                    /* checkBoundary 里可能已经 stop() 掉了 */

    syncProgress(current.bar, current.audio.currentTime);
    tickId = requestAnimationFrame(tick);
  }

  function startTicking() {
    stopTicking();
    tickId = requestAnimationFrame(tick);
  }

  function stopTicking() {
    if (tickId !== null) {
      cancelAnimationFrame(tickId);
      tickId = null;
    }
  }

  function clearSeekCheck() {
    if (seekCheckTimer !== null) {
      clearTimeout(seekCheckTimer);
      seekCheckTimer = null;
    }
  }

  /* 这次跳播到底成没成？设完播放头后隔一小会儿回头看结果。
     失败的原因通常不在代码，而在「服务器不支持 Range」这类环境问题（本项目真踩过这个坑）——
     必须说出来，否则现象是「点哪句都从头播整段」，很容易被误判成代码坏了。 */
  function verifySeek(target) {
    clearSeekCheck();
    seekCheckTimer = setTimeout(function () {
      seekCheckTimer = null;
      if (!current || current.audio.paused) return;   /* 已经停了或换句了，不用管 */
      if (current.inWindow) return;                   /* 闸门开了 = 播放头真到位了，跳播成功 */
      if (Math.abs(current.audio.currentTime - target) < 1.5) return;

      var bar = current.bar;                          /* 先抓住，因为下一行 stop() 会把 current 清空 */
      setStatus('当前环境不支持跳播，音频无法定位到指定时间。' +
                '本地测试请用 node dev-server.js 启动（python -m http.server 不支持分段取数据）。', bar);
      stop();
    }, 700);
  }

  /* ---------- 三个播放入口 ---------- */

  /* 统一的起播动作：起播、失败要出声、图标要跟着变。
     点句 / 拖进度条 / 按播放键三条路都走这里，行为才不会各走各的 */
  function startAudio(audio, failText, bar) {
    var played = audio.play();
    if (played && played.then) {
      /* play() 是异步的：真正开始响的那一刻才算「在播」，成功后再刷一次图标。
         极少数情况浏览器会拒绝播放（如误判不是用户手势）—— 说出来，别静默失败 */
      played.then(syncPlayButtons, function () {
        setStatus(failText, bar);
        syncPlayButtons();
      });
    }
    syncPlayButtons();
  }

  /* 入口一：点某一句 —— R1 点句即播 / R2 连点不叠音 / R3 切句停旧 / R4 高亮的主路径 */
  function playSegment(segEl) {
    var bar = segEl.closest('.material');
    if (!bar) return;
    if (blockedByUnavailable(bar)) return;

    var src = bar.getAttribute('data-audio');
    var start = parseFloat(segEl.getAttribute('data-start'));
    var end = parseFloat(segEl.getAttribute('data-end'));
    if (!src || isNaN(start) || isNaN(end)) return;

    /* Day 28：点句子 = 改听单句，与 A-B 复读互斥 —— 把 A/B 标记关掉，
       否则「点第 3 句」和「在 A-B 区间循环」两个意图会打架，用户看到的随机是哪一个。
       关掉时给一句话说明，不然用户会以为 A/B 标记"凭空消失"了。 */
    if (ab.bar === bar) clearAB(bar, '已关闭 A-B 复读（改成单句播放）。');

    /* 先停旧的再起新的：R2 连点同一句、R3 切句、R7 切素材，全靠这一行防叠音 */
    if (current) current.audio.pause();

    var audio = getAudio(src);
    registerBar(src, bar);
    setStatus('', bar);
    reachedTail = false;                      /* 点句播不算「播到末尾」 */

    highlight(segEl);                         /* R4：正在播的句子高亮 */

    /* Day 34（斌哥要求）：点句子 = 从这句起【往后连着播】，不再播完这一句就停。
       实现上就是走 'free' 模式 —— 它那条边界分支正是「高亮跟着播放头一句句走、
       播到整段末尾才停」，不用另写一套；end 放宽到整段时长。
       ⚠️ 开着「单句重复」时仍用 'segment'：那个开关的语义就是"只反复这一句"，
          不能因为这次改动把它废掉（关掉它，下次点句子就恢复连续播）。
       ⚠️ inWindow 仍先关闸，等 seek 落地再开（见 checkBoundary）*/
    var loopOne = repeatOn;
    current = {
      el: segEl, bar: bar, audio: audio,
      mode: loopOne ? 'segment' : 'free',
      start: start,
      end: loopOne
        ? end
        : ((audio.duration && isFinite(audio.duration)) ? audio.duration : start),
      inWindow: false
    };

    /* 关键：只改播放头、不换 src —— iOS Safari 上换 src 容易重新触发播放限制 */
    audio.currentTime = start;
    startAudio(audio, '没能开始播放，请再点一次这一句', bar);
    saveStudyT(start);                        /* Day 31：点这句 = 学到这句 */

    syncProgress(bar, start);
    startTicking();
    verifySeek(start);                        /* 隔一会儿回头看这次跳播到底成没成 */
  }

  /* 入口二：拖进度条
     shouldPlay=false 表示用户还按着没松手：只挪播放头、换高亮，不出声；
     shouldPlay=true 表示松手了：从落点往后播。 */
  function seekByProgress(bar, seconds, shouldPlay) {
    var src = bar.getAttribute('data-audio');
    if (!src) return;
    if (blockedByUnavailable(bar)) return;

    /* Day 28：拖进度 = 手动定位，与 A-B 复读互斥（同上，关掉并说明） */
    if (ab.bar === bar) clearAB(bar, '已关闭 A-B 复读（手动拖了进度）。');

    var audio = getAudio(src);
    registerBar(src, bar);

    if (current) current.audio.pause();
    else audio.pause();

    reachedTail = false;                      /* 拖动落点播，不算「播到末尾」 */

    var target = seconds;
    var el = segAtTime(bar, target);

    if (repeatOn && el) {
      /* 开着单句重复去拖：落点在哪个句子里，就在那句里循环 */
      current = {
        el: el, bar: bar, audio: audio, mode: 'segment', inWindow: false,
        start: parseFloat(el.getAttribute('data-start')),
        end: parseFloat(el.getAttribute('data-end'))
      };
      highlight(el);
      audio.currentTime = current.start;
      target = current.start;
    } else {
      /* 普通拖动：从落点往后连着播到整段结束 */
      current = {
        el: el, bar: bar, audio: audio, mode: 'free', inWindow: false,
        start: target,
        end: (audio.duration && isFinite(audio.duration)) ? audio.duration : target
      };
      highlight(el);
      audio.currentTime = target;
      /* Day 31：不播也要让进度条停在落点上——否则「上次学到」跳回来、
         深链带 t 进来，播放头其实在 7 秒处，进度条却看着像 0 */
      syncProgress(bar, target);
    }

    setStatus('', bar);
    if (shouldPlay) {
      startAudio(audio, '没能开始播放，请再拖一次进度条', bar);
      startTicking();
      verifySeek(target);
    } else {
      stopTicking();
      syncPlayButtons();                     /* 拖动中不出声，图标这时该显示「播放」 */
    }
  }

  /* 入口三：播放/暂停图标键（音乐软件那套行为）
       正在播  → 停止（B4：音频立刻停 ＋ 高亮回到未播放状态）
       其余情况 → 从进度条当前位置往下播；上一次是播到整段末尾的话，从头开始 */
  function togglePlay(bar) {
    if (!bar) return;
    var src = bar.getAttribute('data-audio');
    if (!src) return;
    if (blockedByUnavailable(bar)) return;

    var audio = getAudio(src);
    registerBar(src, bar);
    setStatus('', bar);

    var sameBar = !!(current && current.bar === bar);

    /* ① 这块素材正在响 → 停止。
       PRD「6.5 坏路径」B4 要求「点停止 → 音频立刻停止，高亮回到未播放状态」，
       而 UI 上只剩这一个键，所以它承担停止的职责（斌哥拍板：「暂停就等于停止」）。
       直接用现成的 stop()：暂停 ＋ 播放头归位到本轮起点 ＋ 清高亮 ＋ 图标回「播放」。 */
    if (sameBar && !audio.paused) {
      stop();
      return;
    }

    /* ①.5 Day 28：A-B 复读开着 → 从 A 点重新进入循环。
       ⚠️ 停止键【不】销毁 A/B 标记是有意的：学生按下停止往往是"歇一下再听这一小段"，
          再按播放就该回到 A 点继续循环，而不是让标记凭空消失、还得重设一遍。
       ⚠️ 必须在 ③ 之前拦下 —— ③ 走的是 seekByProgress，而它会把 A-B 关掉。 */
    if (abActive() && ab.bar === bar) {
      enterABRange(bar, audio);
      return;
    }

    /* ② 兜底：还留着 current 但音频没在响（例如上一次 play() 被浏览器拒了），
       再点一次就原地接着播。正常流程走不到这里 —— 因为 ① 已用 stop() 把 current 清空了。 */
    var atEnd = audio.duration && isFinite(audio.duration) &&
                audio.currentTime >= audio.duration - 0.15;
    if (sameBar && audio.paused && !atEnd) {
      startAudio(audio, '没能继续播放，请再按一次播放', bar);
      startTicking();
      return;
    }

    /* ③ 其余情况（没用过 / 换了素材 / 已经播到末尾）→ 从进度条位置起播；
          上一次是播到整段末尾的话，改从头开始 */
    var from = reachedTail ? 0 : progressValue(bar);
    seekByProgress(bar, from, true);
  }

  /* 停止：高亮清掉、播放头归位，回到「什么都没在播」的状态 */
  function stop() {
    if (current) {
      current.audio.pause();
      current.audio.currentTime = current.start;
      syncProgress(current.bar, current.start);
    }
    current = null;
    stopTicking();
    clearSeekCheck();
    clearHighlight();
    syncPlayButtons();                        /* 停了，图标得变回「播放」 */
  }

  /* Day 33（斌哥要求）：播放途中打开「单句重复」→ 立刻就把【当前正在播的这一句】变成循环。
     —— 为什么需要这一步，而不是只翻开关：
        循环只住在 checkBoundary 的「分段模式收尾」分支里（t >= current.end 时回起点）。
        而从播放键 / 拖进度条起播是 mode 'free'，它那条分支是「播到整段末尾才停」，
        根本没有句子收尾这回事 —— 开关翻过去也不会发生任何事，用户看到的就是「点了没反应」。
     所以这里主动把状态从 free 切到 segment（切到播放头所在的那一句），并回拨到这句的开头。
     返回 false 表示「此刻没有在播的东西」，调用方不用管，只留开关等下次播放。 */
  function snapRepeatToCurrent() {
    if (!repeatOn || !current) return false;

    var audio = current.audio;
    var bar = current.bar;
    if (!audio || !bar) return false;
    if (audio.paused) return false;              /* 没在响：只留开关，等它下次播 */

    /* 播放头落在哪一句就重复哪一句。
       两级兜底，都是为了不出现「点了没反应」：
         ① 落在两句之间的静音缝里 → 退回「最近一次高亮的那一句」（current.el）
         ② 刚起播、连高亮都还没有（current.el 为 null）→ 用 segNear 找最近的一句
       ⚠️ ② 不是假想：真实素材的第一句从 3.06 秒才开始（前面是前奏），
          用户按下播放键后在那三秒里点「单句重复」，①②都不管就会静默失败。 */
    var el = segAtTime(bar, audio.currentTime) || current.el || segNear(bar, audio.currentTime);
    if (!el) return false;

    var start = parseFloat(el.getAttribute('data-start'));
    var end = parseFloat(el.getAttribute('data-end'));
    if (isNaN(start) || isNaN(end)) return false;

    /* 已经在循环这一句了 → 不重播。否则手一抖连按两下会莫名跳回句首 */
    if (current.mode === 'segment' && current.el === el &&
        Math.abs(current.start - start) < 0.001 && Math.abs(current.end - end) < 0.001) {
      return true;
    }

    /* 切到「这一句」的分段模式：起止点换成句子的起止点，
       mode 必须改 —— 留在 'free' 里循环分支永远不会命中 */
    current.mode = 'segment';
    current.el = el;
    current.start = start;
    current.end = end;
    current.inWindow = false;                    /* 回拨后重新等 seek 落地，与 playSegment 一致 */

    highlight(el);
    audio.currentTime = start;                   /* 直接回到这句的开头：让「重复」立刻听得见 */
    syncProgress(bar, start);
    startTicking();                              /* 万一之前没在跑（极少），这里补上 */
    return true;
  }

  /* 单句重复开关（R5）
     Day 28：与 A-B 复读互斥 —— 打开单句重复时清掉 A/B 标记（两个循环模式
     同时开着会互相抢播放头，谁都听不清）。 */
  function toggleRepeat() {
    repeatOn = !repeatOn;
    if (repeatOn && abArmed()) clearAB(current ? current.bar : null, '已关闭 A-B 复读（改用单句重复）。');
    var text = repeatOn ? '单句重复 · 开' : '单句重复';
    var btns = document.querySelectorAll('[data-action="toggle-repeat"]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', repeatOn ? 'true' : 'false');
      /* aria-label 跟着一起改：窄屏会用 CSS 把文字藏起来，读屏软件只剩它可念 */
      btns[i].setAttribute('aria-label', text);
      /* ⚠️ 只改文字那个 span，别用 textContent 整个覆盖 —— 那会把按钮里的图标一起冲掉 */
      var label = btns[i].querySelector('[data-role="repeat-label"]');
      if (label) label.textContent = text;
    }

    /* 打开时立刻生效（见 snapRepeatToCurrent 的说明）。关闭时不拨播放头 ——
       让这一句自然播完，符合「关掉循环就别打断我」的预期。 */
    if (repeatOn) snapRepeatToCurrent();
  }

  /* ---------- 事件代理 ---------- */
  /* 句子、按钮、进度条都是 app.js 后来渲染出来的，所以监听挂在 document 上，
     就不依赖「谁先加载完」 */

  function isProgress(el) {
    return !!el && !!el.getAttribute && el.getAttribute('data-role') === 'progress';
  }

  /* 拖动中：实时挪播放头 + 换高亮，但不出声（避免一路拖一路响） */
  document.addEventListener('input', function (e) {
    if (!isProgress(e.target)) return;
    var bar = e.target.closest('.material');
    if (!bar) return;
    dragging = true;
    seekByProgress(bar, Number(e.target.value), false);
  });

  /* 松手：从落点开始播 */
  document.addEventListener('change', function (e) {
    /* 倍速下拉（Day 31）：存 localStorage + 套到所有缓存音频上 */
    if (e.target && e.target.closest && e.target.closest('[data-role="speed"]')) {
      rate = parseFloat(e.target.value) || 1;
      try { localStorage.setItem(RATE_KEY, String(rate)); } catch (err) {}
      Object.keys(audios).forEach(function (k) { applyRate(audios[k]); });
      return;
    }
    if (!isProgress(e.target)) return;
    var bar = e.target.closest('.material');
    if (!bar) return;
    dragging = false;
    seekByProgress(bar, Number(e.target.value), true);
  });

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;

    var seg = el.closest('.seg');
    if (seg) {
      playSegment(seg);
      return;
    }

    var btn = el.closest('[data-action]');
    if (!btn) return;

    var action = btn.getAttribute('data-action');
    if (action === 'toggle-play') togglePlay(btn.closest('.material'));
    else if (action === 'toggle-repeat') toggleRepeat();
    else if (action === 'toggle-ab') toggleAB(btn.closest('.material'));
  });

  /* Day 9：句子行现在能 Tab 到了（见 app.js 里给它补的 tabindex / role），
     但能聚焦只是"走得到"，还得"按得动"。这里补上按键：
     Enter 和空格都当作"点了这一句"，和鼠标点击走同一条路（playSegment）。
     ⚠️ 空格必须 preventDefault：浏览器默认拿空格翻页，
        不挡掉的话按一下空格会「页面往下跳 + 开始播放」两个动作打架。
     ⚠️ 和上面那条 click 一样挂在 document 上、用 closest('.seg') 认目标 ——
        不为 16 个句子各绑一个监听器。
     ⚠️ 只认 .seg，别的键、别的地方一律放行：进度条要能继续用方向键调。 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var el = e.target;
    if (!el || !el.closest) return;
    var seg = el.closest('.seg');
    if (!seg) return;
    e.preventDefault();
    playSegment(seg);
  });

  /* 对外暴露，给验证脚本用 */
  return {
    playSegment: playSegment,
    seekByProgress: seekByProgress,
    togglePlay: togglePlay,
    stop: stop,
    toggleRepeat: toggleRepeat,
    toggleAB: toggleAB,              /* Day 28：A-B 复读（三态一个键） */
    clearAB: function () { clearAB(); },
    abState: function () {           /* 给验证脚本看当前 A/B 状态，别去猜 DOM */
      return { armed: abArmed(), active: abActive(), a: ab.a, b: ab.b };
    },
    /* ---- Day 28：时长累计的三个口子（上报是 app-shell.js 的事，这里只管记账）---- */
    takeUsageSeconds: function () {  /* 取走整秒（零头留着，长跑不丢精度） */
      var whole = Math.floor(usageSeconds);
      usageSeconds -= whole;
      return whole;
    },
    addBackUsage: function (sec) {   /* 上报失败时退回本地，别把用户的时长丢了 */
      if (typeof sec === 'number' && sec > 0) usageSeconds += sec;
    },
    usageSeconds: function () { return usageSeconds; },
    current: function () { return current; }
  };
})();
