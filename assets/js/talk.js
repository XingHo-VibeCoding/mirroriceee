/* ============================================
   talk.js —— 「AI 对话」板块的前端逻辑（Day 32）
   ------------------------------------------------------------
   这个文件是 freetalk-ai.js 的【搬家 + 改形】：
   同一套录音 / 转写 / 批改 / 朗读的本事，换成聊天界面来承载。

   为什么搬家：
     free talk 那一页的任务是"写一段回答、对照参考回答"，是【写】的节奏；
     这一页是"开口说话、听老师怎么接"，是【说】的节奏。
     两种节奏塞在同一页，麦克风永远被当成写作框旁边的附件 —— 它自己该是主角。

   ⚠️ 只干前端这半边：
       ① 录音（MediaRecorder）
       ② 录到的音频转 16k 单声道 WAV（腾讯云一句话识别认这个格式）
       ③ 上传识别、把文字变成右侧气泡
       ④ 请求 AI 批改，边收边写（SSE 流式）
       ⑤ 朗读（浏览器自带 speechSynthesis，零成本、不联网）
     密钥、签名、调腾讯云 / DeepSeek 全在服务器上，这个文件一行都不碰。

   ⚠️ 状态机（任何时刻只能处在一个状态，避免"录音还没停就点了发送"）：
       idle → listening → transcribing → analyzing → idle
       任何一步出错 → idle（错误写进状态条，不弹窗）

   ⚠️ 术语备注（英文术语给作用说明，不翻译）：
       MediaRecorder —— 浏览器自带的录音机，吐出来的是【压缩音频】（webm/opus）。
       Web Audio API —— 浏览器的音频处理台。decodeAudioData 能把压缩音频解成原始波形。
       WAV           —— 不压缩的波形格式。转成它是为了"谁都认"：腾讯云一句话识别
                        明确支持 wav/pcm/mp3，但不保证认 webm 容器。
       SSE           —— Server-Sent Events，服务器"一边想一边往外吐字"的通道。
                        这里用 fetch 读流而非 EventSource，因为要 POST。
       speechSynthesis —— 浏览器自带朗读器（TTS）。系统语音包在本机跑，
                        不花钱、不泄露要朗读的文本。
   ============================================ */

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var API_HEALTH  = '/api/talk/health';
  var API_ASR     = '/api/talk/asr';
  var API_ANALYZE = '/api/talk/analyze';
  var URL_TOPICS  = 'data/freetalk.json';

  var MAX_SEC     = 45;      /* 一次最多说 45 秒：16k×16bit 单声道 ≈ 32KB/秒，
                                45 秒 ≈ 1.4MB，base64 后 1.9MB —— 再长容易撞请求体上限 */
  var MIN_SEC     = 1;       /* 不到 1 秒直接丢：多半是误触 */
  var DAILY_LIMIT = 20;      /* 每天最多 20 次批改 —— 免费额度经不起刷 */
  var MAX_ITEMS   = 40;      /* 线程最多留 40 条：localStorage 不是数据库 */

  var K_QUOTA  = 'talk_quota';        /* { d:'2026-10-19', n: 3 } */
  var K_THREAD = 'talk_thread_v1';    /* [ 气泡, ... ] */
  var K_TOPIC  = 'talk_topic';        /* 当前话题 id */
  var K_TTS    = 'talk_tts';          /* '1' | '0' 自动朗读开关 */
  var K_SEED   = 'talk_seed';         /* free talk 带过来的草稿 { topicId, text, ts } */

  /* ---------- 状态 ---------- */
  var state = 'idle';
  var health = { asr: false, llm: false };
  var topics = [], cats = [];
  var topic = null;
  var items = [];          /* 全部气泡（唯一数据源，界面永远是它的投影） */
  var seq = 0;             /* 气泡 id 自增，用来定位 DOM */
  var ttsOn = true;

  var $ = function (id) { return document.getElementById(id); };

  /* DOM：页面里必须有以下节点，缺一个就静默不启动（不影响别的页面） */
  var elThread, elMic, elKb, elTips, elCompose, elInput, elSend,
      elStatus, elStatusText, elTimer, elVu, elNotice, elJump,
      elSheet, elSugList, elChips, elQuota, elClear, elTtsToggle;

  /* 录音相关的活对象 */
  var stream = null, recorder = null, chunks = [];
  var audioCtx = null, analyser = null, rafId = 0, tickId = 0, startedAt = 0;

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function readJSON(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  /* 开关类设置单独读，不走 readJSON。
     ⚠️ readJSON 里那句 `|| d` 会把 0 / '' / false 当成"没存过"退回默认值，
        存进去的 '0' 读出来还是"开"—— 这种"关不掉"的开关最难查（常见坑）。 */
  function readFlag(k, def) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? def : (v === '1');
    } catch (e) { return def; }
  }
  function writeFlag(k, v) {
    try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {}
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

  /* ---------- 图标（内联 SVG，不引图标库） ----------
     站内所有图标都是 24 格、stroke 1.7~2.2、圆头圆角，这里保持同一套线条语言。 */
  var SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var SVG_SPEAK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6.5 8.5H3.5v7h3L11 19V5Z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/><path d="M17.5 7a7 7 0 0 1 0 10"/></svg>';
  var SVG_COPY  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 5.8A2.2 2.2 0 0 0 12.8 3.6H5.8A2.2 2.2 0 0 0 3.6 5.8v7A2.2 2.2 0 0 0 5.8 15"/></svg>';
  var SVG_PEN   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5 17.5 10.5"/></svg>';
  var SVG_MIC   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/><path d="M9 21h6"/></svg>';

  /* ============================================
     一、渲染
     ============================================ */

  /* 一条 AI 气泡的内容：老师说的话（主）+ 批注（次）+ 接着聊（动作）。
     ⚠️ 批注放在主文本【下面】、用一条细线隔开，是为了让气泡读起来仍是"聊天"。
        把批注放上面，第一眼看到的就是一份批改单，人就不想说话了。 */
  function aiBody(it) {
    if (!it.text && it.waiting) {
      return '<p class="tk-text"><span class="tk-typing" aria-label="正在分析"><i></i><i></i><i></i></span></p>';
    }

    var html = '<p class="tk-text' + (it.streaming ? ' is-streaming' : '') + '">' + esc(it.text) + '</p>';

    if (it.zh) html += '<p class="tk-zh">' + esc(it.zh) + '</p>';

    var hasFix = it.fix && it.fix.length;
    if (hasFix || it.polish || it.fixChecked) {
      html += '<div class="tk-note">';

      if (hasFix) {
        html += '<div class="tk-note__h">' + SVG_PEN + '改 ' + it.fix.length + ' 处</div>';
        html += '<ul class="tk-fix">';
        it.fix.forEach(function (f) {
          html += '<li>';
          html += '<span class="was">' + esc(f.was) + '</span>';
          if (f.now) html += '<span class="arrow">→</span><span class="now">' + esc(f.now) + '</span>';
          if (f.why) html += '<span class="why">' + esc(f.why) + '</span>';
          html += '</li>';
        });
        html += '</ul>';
      } else if (it.fixChecked) {
        html += '<div class="tk-note__h">' + SVG_PEN + '这句没有要改的地方</div>';
      }

      if (it.polish) {
        html += '<div class="tk-note__h">更地道的说法</div>';
        html += '<div class="tk-polish">' + esc(it.polish) + '</div>';
      }

      html += '</div>';
    }

    if (it.next) {
      html += '<button type="button" class="tk-next" data-next="' + esc(it.next) + '">' +
                '<b>接着聊</b>' + esc(it.next) +
              '</button>';
    }
    return html;
  }

  /* AI 气泡右边那两个圆按钮：朗读 / 复制。
     ⚠️ data-speak 只放【气泡 id】，不放正文：
        把整段英文拼进属性，等于把模型输出塞进 HTML（虽然过了 esc），
        读的时候还得反解一次；用 id 回查 items，干净也更短。
     ⚠️ 失败的那条气泡不给按钮：朗读"这次没成功"、复制"这次没成功"都没意义。 */
  function sideHTML(it) {
    if (!it.text || it.failed) return '';
    return '<div class="tk-side">' +
      '<button type="button" class="tk-round" data-speak="' + it.id + '" aria-label="朗读这条回应">' + SVG_SPEAK + '</button>' +
      '<button type="button" class="tk-round" data-copy="' + it.id + '" aria-label="复制这条英文">' + SVG_COPY + '</button>' +
    '</div>';
  }

  function rowHTML(it) {
    if (it.role === 'div') {
      return '<div class="tk-div" data-id="' + it.id + '"><span>' + esc(it.text) + '</span></div>';
    }
    if (it.role === 'me') {
      return '<div class="tk-row tk-row--me" data-id="' + it.id + '">' +
        '<span class="tk-ok" title="已听清" aria-label="已听清">' + SVG_CHECK + '</span>' +
        '<div class="tk-bub tk-bub--me"><p class="tk-text">' + esc(it.text) + '</p></div>' +
      '</div>';
    }
    return '<div class="tk-row tk-row--ai" data-id="' + it.id + '">' +
      '<div class="tk-bub tk-bub--ai' + (it.failed ? ' is-failed' : '') + '">' + aiBody(it) + '</div>' +
      sideHTML(it) +
    '</div>';
  }

  function emptyHTML() {
    return '<div class="tk-empty">' + SVG_MIC +
      '<br>点下面的「说话」，说完自动变成文字<br>也可以点「键盘」直接打字，或者点「建议」挑个话题' +
    '</div>';
  }

  function nearBottom() {
    if (!elThread) return true;
    return elThread.scrollHeight - elThread.scrollTop - elThread.clientHeight < 90;
  }
  function scrollBottom() {
    if (elThread) elThread.scrollTop = elThread.scrollHeight;
  }

  /* 整条线程重画（进页 / 清空时用） */
  function paint() {
    if (!elThread) return;
    if (!items.length) { elThread.innerHTML = emptyHTML(); toggleJump(); return; }
    elThread.innerHTML = items.map(rowHTML).join('');
    scrollBottom();
    toggleJump();
  }

  /* 追加一条：只插新节点，不重画旧气泡 ——
     ⚠️ 每次全量重画会让所有旧气泡重跑入场动画（220ms 闪一下），
        聊到第三条就看得出"整片在抖"。 */
  function append(it) {
    items.push(it);
    if (!elThread) return;

    /* 超过上限就丢最早的整段（连带它的批注），然后重画一次。
       ⚠️ 只裁数组不重画的话，DOM 里会留下一堆"已经不在数据里"的气泡，
          刷新一次又消失 —— 那种"我明明看见过"的错觉最难查。 */
    if (items.length > MAX_ITEMS) {
      items.splice(0, items.length - MAX_ITEMS);
      paint();
      return;
    }

    if (items.length === 1) elThread.innerHTML = '';
    elThread.insertAdjacentHTML('beforeend', rowHTML(it));
    scrollBottom();
    toggleJump();
  }

  /* 流式时只刷新"正在写的那个气泡" */
  function refreshStream(it, stick) {
    if (!elThread) return;
    var row = elThread.querySelector('[data-id="' + it.id + '"]');
    if (!row) return;
    var bub = row.querySelector('.tk-bub');
    if (bub) bub.innerHTML = aiBody(it);
    if (!row.querySelector('.tk-side') && it.text) {
      row.insertAdjacentHTML('beforeend', sideHTML(it));
    }
    if (stick) scrollBottom();
  }

  function toggleJump() {
    if (!elJump || !elThread) return;
    elJump.hidden = nearBottom();
  }

  /* 存盘：只存渲染需要的数据，streaming / waiting 这些临时标记不落地 */
  function save() {
    writeJSON(K_THREAD, items.map(function (it) {
      return {
        id: it.id, role: it.role, text: it.text, zh: it.zh,
        fix: it.fix, polish: it.polish, next: it.next,
        fixChecked: it.fixChecked, dur: it.dur, ts: it.ts
      };
    }).slice(-MAX_ITEMS));
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) if (String(items[i].id) === String(id)) return items[i];
    return null;
  }

  /* ============================================
     二、状态条与额度
     ============================================ */
  var STATE_TEXT = {
    listening: '正在录音…说完再点一下',
    transcribing: '正在听写…',
    analyzing: 'AI 正在看你的回答…'
  };
  var sayTimer = 0;

  function setState(s) {
    state = s;
    var busy = (s === 'transcribing' || s === 'analyzing');

    if (elMic) {
      elMic.disabled = busy;
      elMic.classList.toggle('is-rec', s === 'listening');
      elMic.classList.toggle('is-busy', busy);
      elMic.setAttribute('aria-label', s === 'listening' ? '停止录音' : '开始录音');
    }
    if (elSend) elSend.disabled = busy;

    if (s === 'idle') {
      /* idle 不一定要藏状态条：报错信息也要挂在同一块地方 */
      if (!elStatus.getAttribute('data-error')) hideStatus();
      if (elVu) elVu.hidden = true;
      if (elTimer) elTimer.textContent = '';
      return;
    }
    elStatus.removeAttribute('data-error');
    elStatus.hidden = false;
    elStatus.classList.remove('is-error');
    elStatusText.textContent = STATE_TEXT[s] || '';
    if (elVu) elVu.hidden = (s !== 'listening');
    if (elTimer) elTimer.textContent = (s === 'listening') ? '0.0s' : '';
  }

  function hideStatus() {
    if (elStatus) { elStatus.hidden = true; elStatus.removeAttribute('data-error'); }
    if (elVu) elVu.hidden = true;
    if (elTimer) elTimer.textContent = '';
  }

  /* 出错：写在状态条里，不弹窗。
     ⚠️ 录音失败、识别为空这类事在练习过程中很常见，
        每次都弹一个窗打断节奏，人会烦到不想用。
     ⚠️ 8 秒后自动收起来：错误留在那儿不走，下一次说话前还得先瞪它一眼。 */
  function say(msg, isError) {
    if (!elStatus) return;
    if (sayTimer) { clearTimeout(sayTimer); sayTimer = 0; }
    elStatus.hidden = false;
    elStatus.classList.toggle('is-error', !!isError);
    elStatus.setAttribute('data-error', isError ? '1' : '');
    elStatusText.textContent = msg;
    if (elVu) elVu.hidden = true;
    if (elTimer) elTimer.textContent = '';
    if (isError) sayTimer = setTimeout(hideStatus, 8000);
  }

  function quotaUsed() {
    var q = readJSON(K_QUOTA, null);
    if (!q || q.d !== today()) return 0;
    return q.n || 0;
  }
  function quotaSpend() {
    var n = quotaUsed() + 1;
    writeJSON(K_QUOTA, { d: today(), n: n });
    paintQuota();
    return n;
  }
  function hasQuota() { return quotaUsed() < DAILY_LIMIT; }

  function paintQuota() {
    if (!elQuota) return;
    var n = quotaUsed();
    elQuota.textContent = '今日 ' + n + '/' + DAILY_LIMIT;
    elQuota.style.color = n >= DAILY_LIMIT ? 'var(--text)' : '';
  }

  /* ============================================
     三、话题（数据来自 free talk 的题库）
     ============================================ */
  function topicById(id) {
    for (var i = 0; i < topics.length; i++) if (topics[i].id === id) return topics[i];
    return null;
  }
  function catName(id) {
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].name;
    return id || '';
  }

  /* 开场白：问候 + 话题本身。
     参考图那句 "Hi jay! I'm Mina, your English teacher. Have you ever…" 就是这个结构 ——
     第一句建立"谁在跟你说话"，第二句直接给题目，中间不留寒暄。 */
  function greetingItem(t) {
    return {
      id: ++seq,
      role: 'ai',
      text: t ? ("Hi! I'm Mina, your English teacher. " + (t.q || ''))
              : "Hi! I'm Mina, your English teacher. What would you like to talk about today?",
      zh: t ? (t.zh || '') : '随便聊点什么都行 —— 点下面的「建议」挑个话题。',
      ts: Date.now()
    };
  }

  function storeTopic(id) {
    try { localStorage.setItem(K_TOPIC, id || ''); } catch (e) {}
  }

  function switchTopic(t) {
    if (!t) return;
    topic = t;
    storeTopic(t.id);
    append({ id: ++seq, role: 'div', text: '换了话题 · ' + (catName(t.cat) || t.part || '') });
    append(greetingItem(t));
    save();
    closeSheet();
    renderChips();
    scrollBottom();
  }

  /* ============================================
     四、录音
     ============================================ */
  function pickMime() {
    var list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < list.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(list[i])) {
        return list[i];
      }
    }
    return '';
  }

  /* 电平条：拿 AnalyserNode 的时域数据算"现在有多响"，喂给 5 根竖条。
     ⚠️ 用 requestAnimationFrame 而不是 setInterval：页面切到后台会自动停，
        不会在看不见的标签页里空转烧电。 */
  function startMeter() {
    if (!analyser || !elVu) return;
    var bars = elVu.querySelectorAll('i');
    if (!bars.length) return;
    var data = new Uint8Array(analyser.fftSize);

    function frame() {
      analyser.getByteTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) {
        var v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      for (var b = 0; b < bars.length; b++) {
        /* 每根条给一点相位差，看起来才像"声波"而不是"一根柱子整体伸缩" */
        var k = Math.sin((b + 1) * 1.1) * 0.25 + 0.75;
        var h = 4 + Math.min(1, peak * 2.4) * 16 * k;
        bars[b].style.height = h.toFixed(1) + 'px';
        bars[b].style.opacity = (0.35 + Math.min(1, peak * 2) * 0.65).toFixed(2);
      }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
  }

  function stopMeter() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (elVu) {
      var bars = elVu.querySelectorAll('i');
      for (var i = 0; i < bars.length; i++) {
        bars[i].style.height = '';
        bars[i].style.opacity = '';
      }
    }
  }

  function startRec() {
    if (state !== 'idle') return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return say('这个浏览器不支持录音。换 Chrome / Edge，或者点「键盘」直接打字。', true);
    }
    if (!hasQuota()) return say('今天已经批改 ' + DAILY_LIMIT + ' 次了，明天再来。', true);

    setState('listening');   /* 先占住状态，防止连点开出两条录音 */

    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
      .then(function (s) {
        stream = s;
        chunks = [];

        var mime = pickMime();
        try {
          recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
        } catch (e) {
          releaseStream();
          setState('idle');
          return say('这台设备的录音格式不被支持，请点「键盘」打字。', true);
        }

        recorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) chunks.push(ev.data);
        };
        recorder.onstop = function () {
          var dur = Date.now() - startedAt;
          var blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
          releaseStream();

          if (dur < MIN_SEC * 1000) {
            setState('idle');
            return say('太短了（' + fmtSec(dur) + '），说完一整句再停。', true);
          }
          if (!blob.size) {
            setState('idle');
            return say('没有录到声音，检查一下系统麦克风。', true);
          }
          transcribe(blob, dur);
        };

        recorder.start();

        /* 电平条：单独一个 AudioContext，只用来"看"声音，不参与录制 */
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          audioCtx = new Ctx();
          var src = audioCtx.createMediaStreamSource(s);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          src.connect(analyser);
          startMeter();
        } catch (e) {
          analyser = null;   /* 电平条画不出来不影响录音，静默跳过 */
        }

        startedAt = Date.now();
        if (elTimer) elTimer.textContent = '0.0s';

        tickId = setInterval(function () {
          var ms = Date.now() - startedAt;
          if (elTimer) elTimer.textContent = fmtSec(ms);
          if (ms >= MAX_SEC * 1000) stopRec();   /* 到点自动停，不用手 */
        }, 100);
      })
      .catch(function (err) {
        releaseStream();
        setState('idle');
        var name = (err && err.name) || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          say('麦克风被浏览器拦下了。点地址栏左边的小锁 → 允许麦克风，再试一次。', true);
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          say('没找到麦克风设备。插一个耳机麦，或者点「键盘」打字。', true);
        } else if (name === 'NotReadableError') {
          say('麦克风被别的程序占着（会议软件之类），关掉它再试。', true);
        } else {
          say('录音没能开始：' + (err && err.message ? err.message : '未知原因'), true);
        }
      });
  }

  function stopRec() {
    if (tickId) { clearInterval(tickId); tickId = 0; }
    stopMeter();
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();          /* 停下之后走 onstop，真正的转写在那里开始 */
    }
  }

  /* 释放麦克风和音频上下文。
     ⚠️ 一定要 stop 每条 track：不关的话地址栏的"录音中"红点会一直亮，
        用户会以为在偷听 —— 这种事一次就够毁掉信任。 */
  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      stream = null;
    }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyser = null;
    if (tickId) { clearInterval(tickId); tickId = 0; }
    stopMeter();
  }

  /* ============================================
     五、音频 → 16k 单声道 WAV
     ============================================ */
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var outLen = Math.round(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      var a = input[i0] || 0;
      var b = input[i0 + 1] || 0;
      /* 线性插值够用：语音识别的瓶颈在模型，不在重采样精度，
         上更好的核只是白烧 CPU */
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);

    function str(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }

    str(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);      /* fmt 块长度 */
    view.setUint16(20, 1, true);       /* 1 = PCM 未压缩 */
    view.setUint16(22, 1, true);       /* 单声道 */
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);   /* 每秒字节数 */
    view.setUint16(32, 2, true);       /* 每个采样的字节数 */
    view.setUint16(34, 16, true);      /* 位深 16 */
    str(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    var off = 44;
    for (var i = 0; i < samples.length; i++, off += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      /* 负数用 0x8000、正数用 0x7fff：直接乘 32768 会让 +1 溢出成负数 */
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function blobToWav16k(blob) {
    return new Promise(function (resolve, reject) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return reject(new Error('浏览器不支持音频解码'));
      var ctx = new Ctx();

      var reader = new FileReader();
      reader.onerror = function () { try { ctx.close(); } catch (e) {} reject(new Error('读取录音失败')); };
      reader.onload = function () {
        ctx.decodeAudioData(reader.result,
          function (audioBuf) {
            try {
              var ch = audioBuf.numberOfChannels;
              var len = audioBuf.length;
              var mono = new Float32Array(len);
              for (var c = 0; c < ch; c++) {
                var data = audioBuf.getChannelData(c);
                for (var i = 0; i < len; i++) mono[i] += data[i] / ch;
              }
              var out = resample(mono, audioBuf.sampleRate, 16000);
              resolve(encodeWav(out, 16000));
            } catch (e) {
              reject(e);
            } finally {
              try { ctx.close(); } catch (e) {}
            }
          },
          function () { try { ctx.close(); } catch (x) {} reject(new Error('音频解码失败')); }
        );
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('音频编码失败')); };
      fr.onload = function () {
        var s = String(fr.result);
        resolve(s.slice(s.indexOf(',') + 1));   /* 去掉 data:audio/wav;base64, 这一截 */
      };
      fr.readAsDataURL(blob);
    });
  }

  /* ============================================
     六、识别 → 提交
     ============================================ */
  function transcribe(blob, durMs) {
    setState('transcribing');

    blobToWav16k(blob)
      .then(function (wav) { return blobToBase64(wav); })
      .then(function (b64) {
        return fetch(API_ASR, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: b64, format: 'wav', sampleRate: 16000, durationMs: durMs })
        });
      })
      .then(function (res) {
        return res.json().then(function (d) { return { status: res.status, d: d }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.d && r.d.ok && r.d.data && r.d.data.text) {
          var text = String(r.d.data.text).trim();
          if (!text) {
            setState('idle');
            return say('没听出内容。说得再清楚一点，或者离麦克风近些。', true);
          }
          submit(text, durMs);
          return;
        }
        setState('idle');
        var k = (r.d && (r.d.code || r.d.error)) || '';
        if (k === 'asr_not_configured') {
          return say('语音识别还没配密钥（服务器端）。先点「键盘」打字，同样能批改。', true);
        }
        say((r.d && r.d.message) || ('听写失败（HTTP ' + r.status + '）'), true);
      })
      .catch(function (err) {
        setState('idle');
        say('听写失败：' + (err && err.message ? err.message : '网络问题'), true);
      });
  }

  /* 把学生这句话变成右侧气泡，再交给 AI */
  function submit(text, durMs) {
    if (!text) return;
    var history = historyPairs();          /* ⚠️ 先取历史，再把自己加进去 */
    append({ id: ++seq, role: 'me', text: text, dur: durMs || 0, ts: Date.now() });
    save();
    analyze(text, history);
  }

  /* 给模型的历史：最近 6 组「我说 → 老师回」，只取老师的主回应（批注不进上下文） */
  function historyPairs() {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.role === 'me' && it.text) {
        var nxt = items[i + 1];
        out.push({
          user: it.text,
          assistant: (nxt && nxt.role === 'ai' && nxt.text) ? nxt.text : ''
        });
      }
    }
    return out.slice(-6);
  }

  /* ============================================
     七、AI 批改（流式）
     ============================================ */
  var MARKS = ['FIX', 'POLISH', 'REPLY', 'NEXT'];

  /* 把模型吐出的带标记文本切成四段。
     ⚠️ 为什么不用 JSON：流式传输中 JSON 永远是"半个括号"，前端没法在中间状态解析；
        纯文本标记（[FIX]…[POLISH]…）每来一个字都能渲染，坏了也只是某一段为空。 */
  function parseSections(all) {
    var out = { FIX: '', POLISH: '', REPLY: '', NEXT: '' };
    var re = /\[(FIX|POLISH|REPLY|NEXT)\]/g;
    var marks = [];
    var m;
    while ((m = re.exec(all))) marks.push({ k: m[1], start: m.index, body: re.lastIndex });
    for (var i = 0; i < marks.length; i++) {
      var end = (i + 1 < marks.length) ? marks[i + 1].start : all.length;
      out[marks[i].k] = all.slice(marks[i].body, end).trim();
    }
    return out;
  }

  /* 修改点一行一条：「- 原说法 → 改后说法 | 中文原因」 */
  function parseFix(text) {
    var lines = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return [];
    if (lines.length === 1 && /没有|无需|no error|looks good/i.test(lines[0])) return [];

    return lines.map(function (line) {
      var s = line.replace(/^[-*•]\s*/, '');
      var why = '';
      var barIdx = s.lastIndexOf('|');
      if (barIdx > 0) { why = s.slice(barIdx + 1).trim(); s = s.slice(0, barIdx).trim(); }

      var arrowIdx = s.indexOf('→');
      var was = arrowIdx > 0 ? s.slice(0, arrowIdx).trim() : s;
      var now = arrowIdx > 0 ? s.slice(arrowIdx + 1).trim() : '';

      return { was: was, now: now, why: why };
    });
  }

  /* 把解析结果写回气泡对象。流式和最终各调一次，保证同一套规则 */
  function applySections(it, sec) {
    it.fix = parseFix(sec.FIX);
    it.fixChecked = true;
    it.polish = sec.POLISH || '';
    it.text = sec.REPLY || it.text || '';
    it.next = sec.NEXT || '';
  }

  function analyze(text, history) {
    if (!hasQuota()) {
      setState('idle');
      return say('今天已经批改 ' + DAILY_LIMIT + ' 次了，明天再来。', true);
    }

    setState('analyzing');

    var ai = { id: ++seq, role: 'ai', text: '', waiting: true, streaming: true, ts: Date.now() };
    append(ai);

    var full = '';
    var stick = true;

    fetch(API_ANALYZE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicId: (topic && topic.id) || 'free',
        question: (topic && topic.q) || '',
        transcript: text,
        history: history || []
      })
    })
      .then(function (res) {
        if (res.status !== 200) {
          return res.json().then(function (d) {
            /* ⚠️ 错误码读两个名字：新接口用 code，云函数老接口用 error。
               前端不猜"这次是谁回的"，两个都认，少一类"提示为空"的怪现象。 */
            var k = (d && (d.code || d.error)) || '';
            throw new Error(k === 'llm_not_configured'
              ? 'AI 批改还没配密钥（服务器端），先把密钥填进 .env。'
              : ((d && d.message) || ('HTTP ' + res.status)));
          });
        }
        if (!res.body || !res.body.getReader) {
          /* 老浏览器没有流式读取 —— 退化成"整包收完再显示" */
          return res.text().then(function (t) {
            full = extractSSEText(t);
            applySections(ai, parseSections(full));
            ai.waiting = false;
            ai.streaming = false;
            refreshStream(ai, true);
          });
        }

        var reader = res.body.getReader();
        var dec = new TextDecoder('utf-8');
        var buf = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              applySections(ai, parseSections(full));
              ai.waiting = false;
              ai.streaming = false;
              refreshStream(ai, true);
              return;
            }
            buf += dec.decode(r.value, { stream: true });

            var parts = buf.split('\n\n');
            buf = parts.pop() || '';

            parts.forEach(function (p) {
              var line = p.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
              if (!line) return;
              var payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') return;
              try {
                var j = JSON.parse(payload);
                var delta = j.choices && j.choices[0] && j.choices[0].delta;
                if (delta && delta.content) {
                  full += delta.content;
                  var sec = parseSections(full);
                  /* 先只更新老师说的话；批注等收完再一次性上 ——
                     边流边解析"修改点"，会出现"→"还没到、原句先出现的半截行 */
                  ai.text = sec.REPLY || '';
                  if (ai.text) ai.waiting = false;
                  refreshStream(ai, stick);
                }
              } catch (e) { /* 半截 JSON 丢掉，下一个分片会补全 */ }
            });
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        quotaSpend();
        setState('idle');
        save();
        if (ttsOn && ai.text) speak(ai.text);
      })
      .catch(function (err) {
        setState('idle');
        ai.waiting = false;
        ai.streaming = false;
        ai.failed = true;
        if (!ai.text) {
          ai.text = '这次没成功：' + (err && err.message ? err.message : '网络问题');
          ai.zh = '';
        }
        refreshStream(ai, true);
        say('AI 这次没接上，你刚才那句已经发出去了，可以直接再试一次。', true);
      });
  }

  /* 非流式的兜底：把整段 SSE 文本里的 content 抽出来拼成全文 */
  function extractSSEText(raw) {
    return String(raw || '').split('\n\n').map(function (p) {
      var line = p.split('\n').filter(function (l) { return l.indexOf('data:') === 0; })[0];
      if (!line) return '';
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return '';
      try {
        var j = JSON.parse(payload);
        var d = j.choices && j.choices[0] && j.choices[0].delta;
        return (d && d.content) || '';
      } catch (e) { return ''; }
    }).join('');
  }

  /* ============================================
     八、朗读（TTS）
     ============================================ */
  var voiceCache = null;

  function pickEnVoice() {
    if (!window.speechSynthesis) return null;
    if (voiceCache) return voiceCache;
    var vs = speechSynthesis.getVoices() || [];
    if (!vs.length) return null;          /* 首次可能还没加载好，下次再取 */

    /* 优先级：en-US 女声 > 任意 en-US > 任意 en。
       偏女声的理由很实在：英语教材录音多是女声，听起来最像上课那个"标准音"。 */
    var prefer = ['Samantha', 'Microsoft Aria', 'Microsoft Zira', 'Google US English'];
    for (var p = 0; p < prefer.length; p++) {
      for (var i = 0; i < vs.length; i++) {
        if (vs[i].name && vs[i].name.indexOf(prefer[p]) >= 0) { voiceCache = vs[i]; return voiceCache; }
      }
    }
    for (var j = 0; j < vs.length; j++) if (/^en[-_]US/i.test(vs[j].lang)) { voiceCache = vs[j]; return voiceCache; }
    for (var k = 0; k < vs.length; k++) if (/^en/i.test(vs[k].lang)) { voiceCache = vs[k]; return voiceCache; }
    return null;
  }

  function speak(text, btn) {
    if (!text) return;
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      return say('这个浏览器不支持朗读，用 Chrome / Edge 试试。', true);
    }
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'en-US';
    u.rate = 0.95;      /* 比默认稍慢：学习者听 1.0 常觉得赶 */
    var v = pickEnVoice();
    if (v) { u.voice = v; u.lang = v.lang || 'en-US'; }
    if (btn) {
      u.onstart = function () { btn.classList.add('is-on'); };
      u.onend = u.onerror = function () { btn.classList.remove('is-on'); };
    }
    speechSynthesis.speak(u);
  }

  /* ============================================
     九、健康检查（缺密钥就说缺什么，别让人瞎试）
     ============================================ */
  function checkHealth() {
    return fetch(API_HEALTH, { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        /* ⚠️ 分两种情况，别混成一句话：
           · d.ok 为真 = 路由在、只是没配密钥 → 告诉人缺哪两个变量名
           · 否则（云函数 404 / 路由不存在）= 后端这条路还没接上 → 说"没上线" */
        if (!d || !d.ok) { paintHealth(true); return; }
        health.asr = !!(d.data && d.data.asr);
        health.llm = !!(d.data && d.data.llm);
        paintHealth();
      })
      .catch(function () {
        health.asr = health.llm = false;
        paintHealth(true);
      });
  }

  function paintHealth(routeMissing) {
    if (!elNotice) return;
    if (health.asr && health.llm) { elNotice.hidden = true; elNotice.innerHTML = ''; return; }

    var lines = [];
    if (routeMissing) {
      lines.push('AI 接口还没接上（<code>/api/talk/*</code> 未上线）。界面可以照常看，语音与批改暂时不可用。');
    } else {
      if (!health.asr) lines.push('语音识别：缺 <code>TENCENT_SECRET_ID</code> / <code>TENCENT_SECRET_KEY</code>');
      if (!health.llm) lines.push('AI 批改：缺 <code>DEEPSEEK_API_KEY</code>');
      lines.push('把上面两行填进项目根目录的 <code>.env</code>，重启 <code>node dev-server.js</code> 就生效。');
    }
    elNotice.innerHTML = '<strong>还没有配密钥</strong> · ' + lines.join('<br>');
    elNotice.hidden = false;
  }

  /* ============================================
     十、建议面板（话题 + 接着聊）
     ============================================ */
  function openSheet() {
    if (!elSheet) return;
    renderSugList();
    renderChips();
    elSheet.hidden = false;
    elTips.setAttribute('aria-expanded', 'true');
  }
  function closeSheet() {
    if (!elSheet) return;
    elSheet.hidden = true;
    elTips.setAttribute('aria-expanded', 'false');
  }
  function toggleSheet() { elSheet.hidden ? openSheet() : closeSheet(); }

  function renderSugList() {
    if (!elSugList) return;
    elSugList.innerHTML = '';
    if (!topics.length) {
      elSugList.innerHTML = '<div class="tk-sug" style="cursor:default"><b>题库还没读出来</b></div>';
      return;
    }

    /* 随手挑 7 个 ≠ 当前话题的。每次都洗牌，
       不然「建议」永远只有那 7 条，第二次点就没意义了 */
    var pool = topics.filter(function (t) { return !topic || t.id !== topic.id; });
    pool = pool.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 7);

    pool.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tk-sug';
      b.innerHTML = '<em>' + (i + 1) + '</em><span><b>' + esc(t.q) + '</b><span>' +
        esc(catName(t.cat) + (t.level ? ' · ' + t.level : '')) + '</span></span>';
      b.addEventListener('click', function () { switchTopic(t); });
      elSugList.appendChild(b);
    });
  }

  /* 「接着聊」：从当前话题的追问里取 3 条，点一下塞进输入框 ——
     ⚠️ 只塞不发送：学生得先改几个词再说，直接替他发出去就成了"AI 自问自答" */
  function renderChips() {
    if (!elChips) return;
    elChips.innerHTML = '';
    var list = (topic && topic.follow) ? topic.follow.slice(0, 3) : [];
    list.forEach(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tk-chip';
      b.textContent = q;
      b.addEventListener('click', function () {
        openCompose(q);
        closeSheet();
      });
      elChips.appendChild(b);
    });
    if (!list.length) elChips.innerHTML = '<span class="tk-sug" style="cursor:default"><b>这题没有追问，直接说你的想法就行</b></span>';
  }

  /* ============================================
     十一、输入框
     ============================================ */
  function openCompose(val) {
    if (!elCompose) return;
    elCompose.hidden = false;
    elKb.setAttribute('aria-expanded', 'true');
    if (typeof val === 'string') elInput.value = val;
    growInput();
    /* ⚠️ 输入框一展开，对话区就矮了一截 —— 不补一次滚到底，
       最新那条气泡会被顶到可视区之外，人以为聊天记录丢了 */
    scrollBottom();
    elInput.focus();
  }
  function closeCompose() {
    if (!elCompose) return;
    elCompose.hidden = true;
    elKb.setAttribute('aria-expanded', 'false');
  }
  function toggleCompose() {
    if (elCompose.hidden) openCompose();
    else { closeCompose(); elMic.focus(); }
  }

  function growInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(120, elInput.scrollHeight) + 'px';
  }

  function sendTyped() {
    if (state !== 'idle') return;
    var text = elInput.value.trim();
    if (!text) return say('先写一句英文，或者点「说话」说出来。', true);
    if (text.split(/\s+/).length < 2) return say('太短了，至少写一个完整句子。', true);

    elInput.value = '';
    growInput();
    submit(text, 0);
  }

  /* ============================================
     十二、复制
     ============================================ */
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t);
    }
    /* 老浏览器 / 非 https：退回 textarea + execCommand。
       ⚠️ 不能只是"复制不了就算了"—— 学生抄一句润色版是最常见的动作 */
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  }

  /* ============================================
     十三、启动
     ============================================ */
  function bindEvents() {
    /* 麦克风：点一下开始，再点一下停（不是按住说话 —— 手机上按住会触发长按菜单） */
    elMic.addEventListener('click', function () {
      if (state === 'listening') return stopRec();
      if (state === 'idle') startRec();
    });

    elKb.addEventListener('click', toggleCompose);
    elTips.addEventListener('click', toggleSheet);
    elSend.addEventListener('click', sendTyped);

    elInput.addEventListener('input', growInput);
    elInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (e.isComposing) return;      /* 中文输入法选词中的回车不算发送 */
      e.preventDefault();
      sendTyped();
    });

    /* 气泡上的按钮：事件委托。
       ⚠️ 用 data-id 回查 items，不把正文塞进属性 */
    elThread.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      var sp = t.closest('[data-speak]');
      if (sp) {
        var it1 = findItem(sp.getAttribute('data-speak'));
        if (it1) speak(it1.text, sp);
        return;
      }

      var cp = t.closest('[data-copy]');
      if (cp) {
        var it2 = findItem(cp.getAttribute('data-copy'));
        if (!it2) return;
        copyText(it2.text).then(function () {
          cp.classList.add('is-on');
          setTimeout(function () { cp.classList.remove('is-on'); }, 1400);
          say('已复制，可以贴到笔记里。', false);
        }).catch(function () { say('这个浏览器不让复制，手动选一下文字吧。', true); });
        return;
      }

      var nx = t.closest('[data-next]');
      if (nx) {
        openCompose(nx.getAttribute('data-next'));
      }
    });

    /* 滚动：离开底部才给"回到底部" */
    elThread.addEventListener('scroll', toggleJump);
    elJump.addEventListener('click', scrollBottom);

    /* 点面板以外的地方收起建议 */
    document.addEventListener('click', function (ev) {
      if (elSheet.hidden) return;
      if (elSheet.contains(ev.target) || elTips.contains(ev.target)) return;
      closeSheet();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !elSheet.hidden) closeSheet();
    });

    /* 清空：本地历史，删了就没了 —— 用 confirm 拦一道 */
    elClear.addEventListener('click', function () {
      if (!items.length) return say('现在没有对话记录。', false);
      if (!window.confirm('清空这条对话记录？只删本机的记录，题库和额度不受影响。')) return;
      items = [];
      seq = 0;
      append(greetingItem(topic));
      save();
      setState('idle');
      say('清空了，重新开始。', false);
    });

    /* 自动朗读开关 */
    elTtsToggle.addEventListener('click', function () {
      ttsOn = !ttsOn;
      writeFlag(K_TTS, ttsOn);
      paintTtsToggle();
      if (!ttsOn && window.speechSynthesis) speechSynthesis.cancel();
    });

    /* 语音列表是异步加载的，某些浏览器第一次 getVoices() 是空的 */
    if (window.speechSynthesis && speechSynthesis.addEventListener) {
      speechSynthesis.addEventListener('voiceschanged', function () { voiceCache = null; });
    }

    /* 关页 / 切走时放开麦克风 —— 不能让"录音中"的红点跟着人到别的页面 */
    window.addEventListener('pagehide', releaseStream);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && state === 'listening') stopRec();
    });
  }

  function paintTtsToggle() {
    if (!elTtsToggle) return;
    elTtsToggle.textContent = ttsOn ? '朗读 · 开' : '朗读 · 关';
    elTtsToggle.setAttribute('aria-pressed', ttsOn ? 'true' : 'false');
  }

  /* 载入题库 → 定话题 → 铺开场白。
     ⚠️ 题库挂了也不能白屏：话题是"更好的开场"，不是"能不能用"的前提。 */
  function loadTopics() {
    return fetch(URL_TOPICS, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        topics = d.topics || [];
        cats = d.cats || [];
      })
      .catch(function () { topics = []; cats = []; });
  }

  /* 定话题：URL 上的 ?topic= 优先，其次上次记住的，最后兜底第一个。
     ⚠️ 三个来源要分开记，不能只返回一个话题 —— 下面要靠"URL 和上次不一样"
        来判断"这是从 free talk 换话题跳过来的"，从而补一条分隔线。 */
  function readTopicSources() {
    var fromUrl = '';
    try {
      var m = location.search.match(/[?&]topic=([^&]+)/);
      if (m) fromUrl = decodeURIComponent(m[1]);
    } catch (e) {}

    var stored = '';
    try { stored = localStorage.getItem(K_TOPIC) || ''; } catch (e) {}

    return {
      fromUrl: fromUrl,
      stored: stored,
      topic: topicById(fromUrl) || topicById(stored) || topics[0] || null
    };
  }

  /* free talk 带过来的草稿：只接 15 分钟内的，太旧的多半已经忘了当时想说什么 */
  function takeSeed() {
    var seed = readJSON(K_SEED, null);
    if (!seed || !seed.text) return;
    try { localStorage.removeItem(K_SEED); } catch (e) {}
    if (seed.ts && Date.now() - seed.ts > 15 * 60 * 1000) return;
    if (seed.topicId && topicById(seed.topicId)) {
      topic = topicById(seed.topicId);
      storeTopic(topic.id);
    }
    openCompose(seed.text);
    say('已经把 free talk 里那段草稿带过来了，改完按发送。', false);
  }

  function init() {
    elThread = $('tkThread');
    elMic = $('tkMic');
    elKb = $('tkKb');
    elTips = $('tkTips');
    elCompose = $('tkCompose');
    elInput = $('tkInput');
    elSend = $('tkSend');
    elStatus = $('tkStatus');
    elStatusText = $('tkStatusText');
    elTimer = $('tkTimer');
    elVu = $('tkVu');
    elNotice = $('tkNotice');
    elJump = $('tkJump');
    elSheet = $('tkSheet');
    elSugList = $('tkSugList');
    elChips = $('tkChips');
    elQuota = $('tkQuota');
    elClear = $('tkClear');
    elTtsToggle = $('tkTts');

    if (!elThread || !elMic) return false;    /* 页面没装这块，就当没这回事 */

    ttsOn = readFlag(K_TTS, true);
    paintTtsToggle();
    paintQuota();

    /* 恢复上次的对话：刷新不该把刚才说的都丢了 */
    var saved = readJSON(K_THREAD, []);
    if (saved && saved.length) {
      items = saved;
      seq = items.reduce(function (m, it) { return Math.max(m, it.id || 0); }, 0);
    }

    bindEvents();

    loadTopics().then(function () {
      var src = readTopicSources();
      topic = src.topic;

      if (!items.length) {
        if (topic) append(greetingItem(topic));
        else { paint(); }
      } else if (src.fromUrl && topic && src.fromUrl !== src.stored) {
        /* 从 free talk 带着话题跳过来，而本机已经有一条别的对话 ——
           补一条分隔线 + 新话题的开场白，而不是把人家的历史顶掉。
           ⚠️ 不覆盖旧对话：历史是证据，切换只是"接着聊另一件事"。 */
        append({ id: ++seq, role: 'div', text: '换了话题 · ' + (catName(topic.cat) || '') });
        append(greetingItem(topic));
        paint();
      } else {
        paint();
      }

      if (topic) storeTopic(topic.id);
      renderChips();
      takeSeed();
      checkHealth();
      save();     /* 开场白也落盘：刷新后不该换一句新的问候 */
    });

    return true;
  }

  if (!init()) return;
})();
