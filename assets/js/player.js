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
  var tickId = null;          /* rAF 句柄 */
  var seekCheckTimer = null;  /* 跳播结果复查定时器（见 verifySeek） */
  var dragging = false;       /* 用户正按着进度条：这时候不要让代码去覆盖他拖到的位置 */
  var reachedTail = false;    /* 上一次收尾是不是因为播到了整段末尾
                                 （决定播放键下次按下时"从头播"还是"从当前位置播"） */

  /* ---------- 取音频对象 ---------- */

  /* 有就复用，没有才新建。绝不每次 new、绝不换 src（TECH_DESIGN 2.6） */
  function getAudio(src) {
    if (!audios[src]) {
      var audio = new Audio();
      audio.preload = 'auto';
      audio.src = src;

      /* 时长一拿到，就把进度条的上限改成真实时长
         （进度条初始上限是"最后一句的终点"，比音频真实时长略短） */
      audio.addEventListener('loadedmetadata', function () {
        var bar = barsBySrc[src];
        if (bar) syncDuration(bar, audio);
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
      audio.addEventListener('play', syncPlayButtons);
      audio.addEventListener('pause', syncPlayButtons);

      /* 兜底：后台标签页里 rAF 会被浏览器降频甚至冻结，但媒体事件照常触发，
         所以让 timeupdate 也走一遍同一个判断 */
      audio.addEventListener('timeupdate', function () {
        if (current && current.audio === audio) checkBoundary();
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

    /* 先停旧的再起新的：R2 连点同一句、R3 切句、R7 切素材，全靠这一行防叠音 */
    if (current) current.audio.pause();

    var audio = getAudio(src);
    registerBar(src, bar);
    setStatus('', bar);
    reachedTail = false;                      /* 点句播不算「播到末尾」 */

    highlight(segEl);                         /* R4：正在播的句子高亮 */

    /* inWindow 先关闸，等 seek 落地、播放头真的进来之后再打开（见 checkBoundary） */
    current = {
      el: segEl, bar: bar, audio: audio, mode: 'segment',
      start: start, end: end, inWindow: false
    };

    /* 关键：只改播放头、不换 src —— iOS Safari 上换 src 容易重新触发播放限制 */
    audio.currentTime = start;
    startAudio(audio, '没能开始播放，请再点一次这一句', bar);

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

  /* 单句重复开关（R5） */
  function toggleRepeat() {
    repeatOn = !repeatOn;
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
  });

  /* 对外暴露，给验证脚本用 */
  return {
    playSegment: playSegment,
    seekByProgress: seekByProgress,
    togglePlay: togglePlay,
    stop: stop,
    toggleRepeat: toggleRepeat,
    current: function () { return current; }
  };
})();
