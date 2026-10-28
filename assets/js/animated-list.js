/* ============================================
   animated-list.js —— 弹簧列表（原生 JS 移植版）
   ------------------------------------------------------------
   出处：https://www.reactbits.dev/components/animated-list
        原始实现是 React 组件（hooks + Hugeicons 图标包）。

   ⚠️ 为什么不是直接抄：
      本项目纯静态、零构建、无 React。原版的 JSX/hooks 全部剥掉，
      保留了它真正的三样看家本领（数值与曲线【逐字保留】，手感全在这）：
        ① 弹簧滑块 —— 选中框用弹簧积分滑到目标行（ω=30, ζ=0.78），
           比 CSS transition 多一层"速度连续"，悬停换行时是"甩"过去的；
        ② 滚动入场 —— 行按可视位置从上/下滑入，带 stagger 阶梯延迟；
        ③ 边缘渐隐 —— 上下两端的遮罩随滚动位置实时收放。

   与原版的差异（有意的）：
      · 图标不依赖 @hugeicons —— items 里直接给内联 SVG 字符串；
      · 主题不走 prop，跟站内 html[data-theme='dark'] 联动（见 css 文件）；
      · 未移植 renderItem —— 原生版固定用 title/description/meta/icon 结构，
        需要自定义再说，不为用不上的参数加复杂度。

   用法：
      AnimatedList.mount({
        mountPoint: '#al-slot',        // 挂载点（元素或选择器）
        items: [ { icon, title, description, meta }, ... ],
        onItemSelect: function (item, index) {}
      });
   ============================================ */

(function (window, document) {
  'use strict';

  if (window.AnimatedList) return;

  /* ---------- 常量（与原版逐字一致）---------- */

  // 弹簧关键帧：先冲过头 8%，再回落 —— CSS 里叫 linear() 缓动，比 cubic-bezier 更"弹"
  var SPRING =
    'linear(0, 0.0603, 0.2033, 0.3821, 0.5633, 0.7258, 0.8584, 0.9574, 1.0242, 1.0634, 1.0809, 1.0828, 1.0747, 1.0613, 1.046, 1.0313, 1.0186, 1.0085, 1.0012, 0.9965, 0.994, 0.9931, 0.9933, 0.9941, 0.9953, 0.9966, 0.9978, 0.9988, 1)';

  var HIDDEN = {
    pop:   { above: 'translate3d(0, -12px, 0) scale(0.8)',  below: 'translate3d(0, 12px, 0) scale(0.8)' },
    slide: { above: 'translate3d(0, -28px, 0) scale(0.98)', below: 'translate3d(0, 28px, 0) scale(0.98)' },
    fade:  { above: 'translate3d(0, -4px, 0)',              below: 'translate3d(0, 4px, 0)' }
  };

  var smootherstep = function (t) { return t * t * t * (t * (t * 6 - 15) + 10); };

  // 渐隐遮罩：8 段渐变，靠 --al-fade-top/bottom 两个变量实时收放
  var FADE_MASK = (function () {
    var steps = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1];
    var top = steps.map(function (t) {
      return 'rgba(0, 0, 0, ' + smootherstep(t).toFixed(3) + ') calc(var(--al-fade-top) * ' + t + ')';
    });
    var bottom = steps.slice().reverse().map(function (t) {
      return 'rgba(0, 0, 0, ' + smootherstep(t).toFixed(3) + ') calc(100% - var(--al-fade-bottom) * ' + t + ')';
    });
    return 'linear-gradient(to bottom, ' + top.concat(bottom).join(', ') + ')';
  })();

  /* ---------- 默认参数 ---------- */
  var DEFAULTS = {
    items: [],
    onItemSelect: null,
    initialSelectedIndex: -1,
    selectOnHover: true,
    enableArrowNavigation: true,
    loop: false,
    animation: 'pop',      // pop | slide | fade | none
    animateOnce: false,
    stagger: 0.05,
    showGradients: true,
    fadeSize: 56,
    displayScrollbar: true,
    frame: true,
    radius: 14,
    gap: 8,
    width: 420,
    maxHeight: 440,
    accentColor: ''
  };

  function pick(base, over) {
    var out = {};
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    if (over) {
      for (var j in over) {
        if (Object.prototype.hasOwnProperty.call(over, j) && over[j] !== undefined) out[j] = over[j];
      }
    }
    return out;
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function px(v) { return typeof v === 'number' ? v + 'px' : v; }

  /* ============================================
     mount(options) → { destroy, setItems, select }
     ============================================ */
  function mount(options) {
    var cfg = pick(DEFAULTS, options);
    var host = typeof cfg.mountPoint === 'string'
      ? document.querySelector(cfg.mountPoint)
      : cfg.mountPoint;
    if (!host) throw new Error('AnimatedList: 找不到挂载点 ' + cfg.mountPoint);

    var selected = cfg.initialSelectedIndex;
    var entered = false;
    var engaged = false;
    var navigating = false;   // 键盘导航中 —— 鼠标一动就交还控制权
    var lastKeyWasKeyboard = false;
    var destroyed = false;

    /* ---- 构建 DOM（结构与原版 JSX 一致）---- */
    var root = el('div', 'animated-list');
    if (cfg.frame) root.classList.add('animated-list--framed');
    if (cfg.animation !== 'none') root.setAttribute('data-animated', '');
    root.style.setProperty('--al-radius', Math.max(0, cfg.radius) + 'px');
    root.style.setProperty('--al-gap', Math.max(0, cfg.gap) + 'px');
    root.style.setProperty('--al-width', px(cfg.width));
    if (cfg.accentColor) {
      root.style.setProperty('--al-accent', cfg.accentColor);
      root.style.setProperty('--al-ring', cfg.accentColor);
      root.style.setProperty('--al-ring-fill', 'color-mix(in srgb, ' + cfg.accentColor + ' 8%, transparent)');
    }

    var viewport = el('div', 'animated-list__viewport');
    if (!cfg.displayScrollbar) viewport.classList.add('animated-list__viewport--bare');
    viewport.setAttribute('role', 'listbox');
    viewport.tabIndex = 0;
    if (cfg.showGradients) {
      viewport.style.maskImage = FADE_MASK;
      viewport.style.webkitMaskImage = FADE_MASK;
    }
    viewport.style.maxHeight = px(cfg.maxHeight);

    var track = el('div', 'animated-list__track');
    viewport.appendChild(track);
    root.appendChild(viewport);

    if (cfg.frame) root.appendChild(el('span', 'animated-list__frame-rim'));
    host.appendChild(root);

    /* ---- 行元素 ----
       ⚠️ indicator / ring 是外层引擎要每帧写的引用 —— 这里【不能】用 var 重新声明，
          否则局部变量遮蔽外层，外层永远是 null，滑块一行都画不出来（已踩过）。 */
    var itemRefs = [];
    var indicator = null;
    var ring = null;

    function buildItems() {
      track.querySelectorAll('.animated-list__item, .animated-list__indicator').forEach(function (n) { n.remove(); });
      itemRefs = [];
      cfg.items.forEach(function (raw, index) {
        var entry = (raw !== null && typeof raw === 'object') ? raw : { title: String(raw) };
        var item = el('div', 'animated-list__item');
        item.setAttribute('role', 'option');
        item.setAttribute('data-index', index);
        item.id = 'al-item-' + index;

        if (entry.icon) {
          var lead = el('span', 'animated-list__lead');
          lead.innerHTML = entry.icon;
          item.appendChild(lead);
        }
        var text = el('span', 'animated-list__text');
        var title = el('span', 'animated-list__title');
        title.textContent = entry.title;
        text.appendChild(title);
        if (entry.description) {
          var desc = el('span', 'animated-list__description');
          desc.textContent = entry.description;
          text.appendChild(desc);
        }
        item.appendChild(text);
        if (entry.meta) {
          var meta = el('span', 'animated-list__meta');
          meta.textContent = entry.meta;
          item.appendChild(meta);
        }
        item.appendChild(el('span', 'animated-list__rim'));
        track.appendChild(item);
        itemRefs[index] = item;
      });

      indicator = el('span', 'animated-list__indicator');
      indicator.setAttribute('aria-hidden', 'true');
      ring = el('span', 'animated-list__ring');
      indicator.appendChild(ring);
      track.appendChild(indicator);
      itemRefs.length = cfg.items.length;
      paintSelection();
    }

    /* ---- 引擎状态 ---- */
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var springEase = (window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)'))
      ? SPRING
      : 'cubic-bezier(0.34, 1.4, 0.64, 1)';
    var TRANSITION = 'transform 620ms ' + springEase + ', opacity 300ms cubic-bezier(0.22, 1, 0.36, 1), filter 200ms ease';

    var motion = { y: 0, h: 0, vy: 0, vh: 0, ty: 0, th: 0, ready: false };
    var fades = { top: '', bottom: '' };
    var boxes = [];
    var current = null;
    var raf = 0;
    var last = 0;
    var pointer = [0, 0];

    function mode() {
      var chosen = cfg.animation;
      if (chosen === 'none' || !HIDDEN[chosen]) return 'none';
      return reduced ? 'fade' : chosen;
    }

    function apply(element, state) {
      element.dataset.state = state;
      var pose = (current && current !== 'none' && state !== 'in') ? HIDDEN[current][state] : '';
      element.style.transform = pose;
      element.style.opacity = pose ? '0' : '';
    }

    function syncRing() {
      var item = itemRefs[selected];
      if (!item || !ring) return;
      var state = item.dataset.state || 'in';
      if (state === ring.dataset.state) return;
      ring.style.transitionDelay = item.style.transitionDelay;
      apply(ring, state);
    }

    function write() {
      if (!indicator) return;
      indicator.style.transform = 'translate3d(0, ' + motion.y.toFixed(2) + 'px, 0)';
      indicator.style.height = motion.h.toFixed(2) + 'px';
    }

    function frame(now) {
      raf = 0;
      var dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      // ω=30（响应快），ζ=0.78（轻微过冲）—— 这个手感别改
      var omega = 30;
      var zeta = 0.78;
      var steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      var h = dt / steps;
      for (var i = 0; i < steps; i++) {
        motion.vy += (omega * omega * (motion.ty - motion.y) - 2 * zeta * omega * motion.vy) * h;
        motion.vh += (omega * omega * (motion.th - motion.h) - 2 * zeta * omega * motion.vh) * h;
        motion.y += motion.vy * h;
        motion.h += motion.vh * h;
      }
      var moving =
        Math.abs(motion.ty - motion.y) > 0.05 ||
        Math.abs(motion.th - motion.h) > 0.05 ||
        Math.abs(motion.vy) + Math.abs(motion.vh) > 0.5;
      if (!moving) {
        motion.y = motion.ty;
        motion.h = motion.th;
        motion.vy = motion.vh = 0;
      }
      write();
      if (moving) raf = window.requestAnimationFrame(frame);
    }

    function place(snap) {
      if (!indicator) return;
      var item = itemRefs[selected];
      if (!item) {
        indicator.style.opacity = '0';
        motion.ready = false;
        return;
      }
      indicator.style.opacity = '1';
      motion.ty = item.offsetTop;
      motion.th = item.offsetHeight;
      if (snap || reduced || !motion.ready) {
        motion.y = motion.ty;
        motion.h = motion.th;
        motion.vy = motion.vh = 0;
        motion.ready = true;
        write();
        return;
      }
      if (!raf) {
        last = window.performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    }

    function updateFades() {
      var span = Math.max(1, cfg.fadeSize);
      var scrollTop = viewport.scrollTop;
      var scrollHeight = viewport.scrollHeight;
      var clientHeight = viewport.clientHeight;
      var top = cfg.showGradients ? Math.min(span, Math.max(0, scrollTop)) : 0;
      var bottom = cfg.showGradients ? Math.min(span, Math.max(0, scrollHeight - clientHeight - scrollTop)) : 0;
      var nextTop = top.toFixed(1) + 'px';
      var nextBottom = bottom.toFixed(1) + 'px';
      if (nextTop !== fades.top) {
        fades.top = nextTop;
        viewport.style.setProperty('--al-fade-top', nextTop);
      }
      if (nextBottom !== fades.bottom) {
        fades.bottom = nextBottom;
        viewport.style.setProperty('--al-fade-bottom', nextBottom);
      }
    }

    function measure() {
      var offset = track.offsetTop;
      boxes = itemRefs.map(function (item) {
        return item ? [offset + item.offsetTop, item.offsetHeight] : null;
      });
    }

    function reveal(entrance) {
      if (!entered) return;
      var top = viewport.scrollTop;
      var view = viewport.clientHeight;
      var order = 0;
      itemRefs.forEach(function (item, index) {
        var box = boxes[index];
        if (!item || !box) return;
        var start = box[0] - top;
        var overlap = Math.min(view, start + box[1]) - Math.max(0, start);
        var hidden =
          current !== 'none' &&
          overlap < Math.min(box[1], view) * 0.5 &&
          !(cfg.animateOnce && item.dataset.seen);
        var state = hidden ? ((start + box[1] / 2 < view / 2) ? 'above' : 'below') : 'in';
        if (state === item.dataset.state) return;
        var delay = (entrance && !hidden) ? ((order++ * Math.max(0, cfg.stagger)).toFixed(3)) : 0;
        item.style.transitionDelay = delay ? (delay + 's, ' + delay + 's, 0s') : '';
        if (!hidden) item.dataset.seen = 'true';
        apply(item, state);
      });
      syncRing();
    }

    function sync() {
      var items = itemRefs.filter(Boolean);
      var next = mode();
      var changed = next !== current;
      var restyle = changed ? items : items.filter(function (item) { return !item.dataset.state; });
      current = next;
      if (current === 'none') entered = true;
      if (restyle.length) {
        var elements = changed ? restyle.concat([ring]) : restyle;
        elements.forEach(function (element) { element.style.transition = 'none'; });
        restyle.forEach(function (item) {
          apply(item, current === 'none' ? 'in' : (item.dataset.state || 'below'));
        });
        if (changed && ring) apply(ring, (itemRefs[selected] && itemRefs[selected].dataset.state) || 'in');
        void root.offsetHeight;   // 强制回流，让"无过渡落位 → 有过渡入场"两段分开
        elements.forEach(function (element) { element.style.transition = TRANSITION; });
      }
      measure();
      reveal(restyle.length > 0);
    }

    function paintSelection() {
      itemRefs.forEach(function (item, index) {
        if (!item) return;
        var isSel = index === selected;
        if (isSel) item.setAttribute('data-selected', '');
        else item.removeAttribute('data-selected');
        item.setAttribute('aria-selected', isSel ? 'true' : 'false');
      });
      if (viewport && selected >= 0 && selected < cfg.items.length) {
        viewport.setAttribute('aria-activedescendant', 'al-item-' + selected);
      } else if (viewport) {
        viewport.removeAttribute('aria-activedescendant');
      }
    }

    function setSelected(next, opts) {
      next = Math.min(cfg.items.length - 1, Math.max(-1, next));
      if (next === selected) return;
      selected = next;
      paintSelection();
      place(false);
      syncRing();
      if (opts && opts.scroll) scrollSelectedIntoView();
    }

    function scrollSelectedIntoView() {
      var item = itemRefs[selected];
      if (!item) return;
      var top = track.offsetTop + item.offsetTop;
      var bottom = top + item.offsetHeight;
      var room = Math.max(0, (viewport.clientHeight - item.offsetHeight) / 2);
      var margin = Math.min(cfg.showGradients ? Math.max(12, cfg.fadeSize) : 12, room);
      if (top < viewport.scrollTop + margin) {
        viewport.scrollTo({ top: Math.max(0, top - margin), behavior: 'smooth' });
      } else if (bottom > viewport.scrollTop + viewport.clientHeight - margin) {
        viewport.scrollTo({ top: bottom - viewport.clientHeight + margin, behavior: 'smooth' });
      }
    }

    /* ---- 事件 ---- */

    function onScroll() {
      updateFades();
      reveal(false);
    }

    function onKey(event) {
      if (!cfg.enableArrowNavigation || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      var active = document.activeElement;
      var focused = active === viewport;
      var idle = !active || active === document.body || active === document.documentElement;
      if (!focused && !(engaged && idle)) return;
      var count = cfg.items.length;
      if (!count) return;
      var index = selected;
      var next = null;
      if (event.key === 'ArrowDown') next = index < 0 ? 0 : index + 1;
      else if (event.key === 'ArrowUp') next = index < 0 ? count - 1 : index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = count - 1;
      else if ((event.key === 'Enter' || (focused && event.key === ' ')) && index >= 0 && index < count) {
        event.preventDefault();
        if (cfg.onItemSelect) cfg.onItemSelect(cfg.items[index], index);
        return;
      }
      if (next === null) return;
      event.preventDefault();
      next = cfg.loop ? (next + count) % count : Math.min(count - 1, Math.max(0, next));
      lastKeyWasKeyboard = true;
      navigating = true;
      setSelected(next, { scroll: true });
    }

    function onPointerMove(event) {
      var moved = event.clientX !== pointer[0] || event.clientY !== pointer[1];
      pointer = [event.clientX, event.clientY];
      if (!navigating || !moved) return;
      navigating = false;    // 键盘选完，鼠标一动就把控制权还给鼠标
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (target && root.contains(target) && cfg.selectOnHover) {
        setSelected(Number(target.dataset.index));
      }
    }

    function onEnter() { engaged = true; }
    function onLeave() { engaged = false; }

    function onItemClick(event) {
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (!target || !root.contains(target)) return;
      var index = Number(target.dataset.index);
      setSelected(index);
      if (cfg.onItemSelect) cfg.onItemSelect(cfg.items[index], index);
    }

    function onItemPointerEnter(event) {
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (!target || !cfg.selectOnHover) return;
      if (!navigating) setSelected(Number(target.dataset.index));
    }

    viewport.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointermove', onPointerMove);
    track.addEventListener('click', onItemClick);
    track.addEventListener('pointerenter', onItemPointerEnter, true);

    /* ---- 入场门控：滚到可视区才播入场动画 ---- */
    var gate = (typeof IntersectionObserver === 'undefined')
      ? null
      : new IntersectionObserver(function (entries, observer) {
          var any = entries.some(function (entry) { return entry.isIntersecting; });
          if (!any) return;
          observer.disconnect();
          if (entered) return;
          entered = true;
          measure();
          reveal(true);
        }, { rootMargin: '0px 0px -10% 0px' });

    /* ---- 尺寸变化：重放滑块、刷新渐隐 ---- */
    var resizeObserver = new ResizeObserver(function () {
      place(true);
      updateFades();
      measure();
      reveal(false);
    });

    buildItems();
    resizeObserver.observe(viewport);
    resizeObserver.observe(track);
    if (!entered) {
      if (gate) gate.observe(root);
      else { entered = true; reveal(true); }
    }

    updateFades();
    place(true);
    syncRing();

    return {
      destroy: function () {
        destroyed = true;
        if (raf) window.cancelAnimationFrame(raf);
        if (gate) gate.disconnect();
        resizeObserver.disconnect();
        viewport.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKey);
        root.removeEventListener('pointerenter', onEnter);
        root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointermove', onPointerMove);
        track.removeEventListener('click', onItemClick);
        track.removeEventListener('pointerenter', onItemPointerEnter, true);
        root.remove();
      },
      // 替换数据源（会重放入场动画）
      setItems: function (items) {
        cfg.items = items || [];
        buildItems();
        sync();
        place(true);
        updateFades();
      },
      // 程序化选中某一行（-1 = 取消选中）
      select: function (index) {
        setSelected(index, { scroll: true });
      }
    };
  }

  /* ============================================
     enhance(container, options) —— 收养模式
     ------------------------------------------------------------
     用途：把【已经渲染好的】业务列表（如 app.js 铺的 Lesson 按钮）
          包进弹簧列表的结构里，只加三样动效：
            ① 滑块 ring 悬停跟随  ② 滚动/入场动画  ③ 边缘渐隐。
     ⚠️ 与 mount 的分工（为什么不复用一份引擎）：
        mount 是"数据驱动"—— items 变了它重建行；
        enhance 是"DOM 收养"—— 行的生杀大权在业务代码（app.js 的
        innerHTML）手里，每次重渲染后由业务方重新调 enhance。
        两者的生命周期完全不同，强行共用会把简单的事搅复杂。
        弹簧/渐隐的【数值】与 mount 同源（本文件顶部常量），手感一致。
     ⚠️ 不改行的皮：不加 .animated-list__item 类，原 button 的
        .file-btn 样式原样保留 —— 本组件只提供"动"，不抢"形"。
     行为约定：
        · 点击/回车 → onItemSelect(item=按钮元素, index)，【不】preventDefault，
          业务自己的点击委托照常工作；
        · 初始无选中（ring 藏着），鼠标划到哪跟到哪；
        · 重复调用安全：旧实例挂在 container.__alCtl 上，先销毁再新建
          （app.js 每次重渲染都会调一次，不清理会漏监听器）。
     ============================================ */
  function enhance(container, options) {
    var opts = pick({
      selectOnHover: true,
      enableArrowNavigation: true,
      radius: 16,          // 跟站内 --radius-card 对齐，ring 才贴得住行圆角
      gap: 8,              // 跟 .lessons 原本的 gap 一致
      fadeSize: 56,
      showGradients: true,
      stagger: 0.05,
      animation: 'pop',
      rowSelector: 'button',    // 行收集选择器：默认 'button'（原行为），
                                // 主内容区的行不是按钮时由调用方指定（如 '.vg-wcard'）
      viewportPadding: 6,       // viewport 内边距：侧栏列表的皮；主内容区传 0 免得版心被挤窄
      trackClass: '',           // 追加到 track 上的类：行不是竖排列表时由调用方改布局
                                // （如单词小游戏是 2×2 网格，传类名后用页面局部 CSS 恢复 grid）
      gateThreshold: 0,         // 入场所需可见比例（0~1）。0=原行为（露头即播）；
                                // 页面中段板块传 0.85 等，防止动画在用户看到之前放完
      scrollable: true,         // viewport 是否自滚。主内容区传 false：滚动交给页面窗口，
                                // 滚动条永远停在窗口最右缘，内容区不再冒出内层滚动条
      restoreTransition: false, // 入场落定后清掉行内 transition，把 hover 过渡还给行自己的 CSS
                                // （行内 TRANSITION 会盖住 .vg-card 的 transform/box-shadow 过渡）
      onItemSelect: null
    }, options);

    if (!container || container.nodeType !== 1) return null;

    // 重复调用保护：先拆旧的（旧实例的 window keydown 监听不能留着指向死 DOM）
    if (container.__alCtl && typeof container.__alCtl.destroy === 'function') {
      container.__alCtl.destroy();
      container.__alCtl = null;
    }

    var rows = [];
    Array.prototype.forEach.call(container.children, function (n) {
      if (n.nodeType !== 1) return;
      // rowSelector === 'button' 走原路径（tagName 判断，不依赖 matches）；
      // 其余按选择器收养，行自己的皮肤/间距全保留
      if (opts.rowSelector === 'button'
        ? n.tagName === 'BUTTON'
        : (n.matches && n.matches(opts.rowSelector))) rows.push(n);
    });
    if (!rows.length) return null;

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var springEase = (window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)'))
      ? SPRING
      : 'cubic-bezier(0.34, 1.4, 0.64, 1)';
    var TRANSITION = 'transform 620ms ' + springEase + ', opacity 300ms cubic-bezier(0.22, 1, 0.36, 1), filter 200ms ease';

    /* ---- 包结构：container > root > viewport > track > (rows + indicator) ---- */
    var root = el('div', 'animated-list al-embedded');
    root.style.setProperty('--al-radius', Math.max(0, opts.radius) + 'px');
    root.style.setProperty('--al-gap', Math.max(0, opts.gap) + 'px');

    var viewport = el('div', 'animated-list__viewport');
    viewport.setAttribute('role', 'listbox');
    viewport.tabIndex = 0;
    // CSS 里 viewport 固定 padding:6px；主内容区传 0 时在这里压回（内联样式优先级更高）
    viewport.style.padding = Math.max(0, opts.viewportPadding) + 'px';
    // scrollable:false：内容区不自滚（高度本就随内容生长），杜绝内层滚动条；
    // overflow 双向 visible，入场位移也不会被裁
    if (!opts.scrollable) viewport.style.overflow = 'visible';
    if (opts.showGradients) {
      viewport.style.maskImage = FADE_MASK;
      viewport.style.webkitMaskImage = FADE_MASK;
    }

    // trackClass：行不是竖排列表时由调用方传类名改布局（如单词小游戏的 2×2 网格）
    var track = el('div', 'animated-list__track' + (opts.trackClass ? ' ' + opts.trackClass : ''));
    rows.forEach(function (btn, index) {
      btn.setAttribute('data-index', index);
      track.appendChild(btn);
    });

    var indicator = el('span', 'animated-list__indicator');
    indicator.setAttribute('aria-hidden', 'true');
    var ring = el('span', 'animated-list__ring');
    indicator.appendChild(ring);
    track.appendChild(indicator);

    viewport.appendChild(track);
    root.appendChild(viewport);
    container.appendChild(root);

    /* ---- 引擎（弹簧滑块 + 入场 + 渐隐；数值与 mount 同源）---- */
    var selected = -1;
    var entered = false;
    var engaged = false;
    var navigating = false;
    var transitionRestored = false; // restoreTransition 用：入场过渡是否已还给行
    var motion = { y: 0, h: 0, vy: 0, vh: 0, ty: 0, th: 0, ready: false };
    var fades = { top: '', bottom: '' };
    var boxes = [];
    var current = null;
    var raf = 0;
    var last = 0;
    var pointer = [0, 0];

    function mode() {
      var chosen = opts.animation;
      if (chosen === 'none' || !HIDDEN[chosen]) return 'none';
      return reduced ? 'fade' : chosen;
    }

    function apply(element, state) {
      element.dataset.state = state;
      var pose = (current && current !== 'none' && state !== 'in') ? HIDDEN[current][state] : '';
      element.style.transform = pose;
      element.style.opacity = pose ? '0' : '';
    }

    function syncRing() {
      var item = rows[selected];
      if (!item || !ring) return;
      var state = item.dataset.state || 'in';
      if (state === ring.dataset.state) return;
      ring.style.transitionDelay = item.style.transitionDelay;
      apply(ring, state);
    }

    function write() {
      indicator.style.transform = 'translate3d(0, ' + motion.y.toFixed(2) + 'px, 0)';
      indicator.style.height = motion.h.toFixed(2) + 'px';
    }

    function frame(now) {
      raf = 0;
      var dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      var omega = 30;
      var zeta = 0.78;
      var steps = Math.max(1, Math.ceil(dt / (1 / 240)));
      var h = dt / steps;
      for (var i = 0; i < steps; i++) {
        motion.vy += (omega * omega * (motion.ty - motion.y) - 2 * zeta * omega * motion.vy) * h;
        motion.vh += (omega * omega * (motion.th - motion.h) - 2 * zeta * omega * motion.vh) * h;
        motion.y += motion.vy * h;
        motion.h += motion.vh * h;
      }
      var moving =
        Math.abs(motion.ty - motion.y) > 0.05 ||
        Math.abs(motion.th - motion.h) > 0.05 ||
        Math.abs(motion.vy) + Math.abs(motion.vh) > 0.5;
      if (!moving) {
        motion.y = motion.ty;
        motion.h = motion.th;
        motion.vy = motion.vh = 0;
      }
      write();
      if (moving) raf = window.requestAnimationFrame(frame);
    }

    function place(snap) {
      var item = rows[selected];
      if (!item) {
        indicator.style.opacity = '0';
        motion.ready = false;
        return;
      }
      indicator.style.opacity = '1';
      motion.ty = item.offsetTop;
      motion.th = item.offsetHeight;
      if (snap || reduced || !motion.ready) {
        motion.y = motion.ty;
        motion.h = motion.th;
        motion.vy = motion.vh = 0;
        motion.ready = true;
        write();
        return;
      }
      if (!raf) {
        last = window.performance.now();
        raf = window.requestAnimationFrame(frame);
      }
    }

    function updateFades() {
      var span = Math.max(1, opts.fadeSize);
      var top = opts.showGradients ? Math.min(span, Math.max(0, viewport.scrollTop)) : 0;
      var bottom = opts.showGradients ? Math.min(span, Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)) : 0;
      var nextTop = top.toFixed(1) + 'px';
      var nextBottom = bottom.toFixed(1) + 'px';
      if (nextTop !== fades.top) { fades.top = nextTop; viewport.style.setProperty('--al-fade-top', nextTop); }
      if (nextBottom !== fades.bottom) { fades.bottom = nextBottom; viewport.style.setProperty('--al-fade-bottom', nextBottom); }
    }

    function measure() {
      var offset = track.offsetTop;
      boxes = rows.map(function (item) {
        return item ? [offset + item.offsetTop, item.offsetHeight] : null;
      });
    }

    function reveal(entrance) {
      if (!entered) return;
      var top = viewport.scrollTop;
      var view = viewport.clientHeight;
      var order = 0;
      rows.forEach(function (item, index) {
        var box = boxes[index];
        if (!item || !box) return;
        var start = box[0] - top;
        var overlap = Math.min(view, start + box[1]) - Math.max(0, start);
        var hidden = current !== 'none' && overlap < Math.min(box[1], view) * 0.5 && !item.dataset.seen;
        var state = hidden ? ((start + box[1] / 2 < view / 2) ? 'above' : 'below') : 'in';
        if (state === item.dataset.state) return;
        var delay = (entrance && !hidden) ? ((order++ * Math.max(0, opts.stagger)).toFixed(3)) : 0;
        item.style.transitionDelay = delay ? (delay + 's, ' + delay + 's, 0s') : '';
        if (!hidden) item.dataset.seen = 'true';
        apply(item, state);
      });
      /* restoreTransition：入场全部落定后清掉行内 transition，把 hover/box-shadow 过渡
         还给行自己的 CSS（行内 TRANSITION 会盖住 .vg-card 这类带 hover 动效的皮）。
         enhance 的行「见过不再回隐」（dataset.seen），清了也不会破坏后续入场。 */
      if (entrance && opts.restoreTransition && !transitionRestored &&
          rows.length && rows.every(function (item) { return item.dataset.state === 'in'; })) {
        transitionRestored = true;
        var settleWait = 700 + rows.length * Math.max(0, opts.stagger) * 1000;
        setTimeout(function () {
          rows.forEach(function (item) { item.style.transition = ''; item.style.transitionDelay = ''; });
          ring.style.transition = ''; ring.style.transitionDelay = '';
        }, settleWait);
      }
      syncRing();
    }

    function sync() {
      var next = mode();
      var changed = next !== current;
      current = next;
      if (current === 'none') entered = true;
      if (changed) {
        var elements = rows.concat([ring]);
        elements.forEach(function (element) { element.style.transition = 'none'; });
        rows.forEach(function (item) { apply(item, current === 'none' ? 'in' : (item.dataset.state || 'below')); });
        apply(ring, (rows[selected] && rows[selected].dataset.state) || 'in');
        void root.offsetHeight;
        elements.forEach(function (element) { element.style.transition = TRANSITION; });
      }
      measure();
      reveal(true);
    }

    function setSelected(next) {
      next = Math.min(rows.length - 1, Math.max(-1, next));
      if (next === selected) return;
      selected = next;
      rows.forEach(function (item, index) {
        if (index === selected) item.setAttribute('data-selected', '');
        else item.removeAttribute('data-selected');
        item.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      });
      if (selected >= 0) viewport.setAttribute('aria-activedescendant', rows[selected].id || '');
      place(false);
      syncRing();
    }

    /* ---- 事件 ---- */
    function onScroll() { updateFades(); reveal(false); }

    function onKey(event) {
      if (!opts.enableArrowNavigation || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      var active = document.activeElement;
      var focused = active === viewport;
      var idle = !active || active === document.body || active === document.documentElement;
      if (!focused && !(engaged && idle)) return;
      if (!rows.length) return;
      var index = selected;
      var next = null;
      if (event.key === 'ArrowDown') next = index < 0 ? 0 : index + 1;
      else if (event.key === 'ArrowUp') next = index < 0 ? rows.length - 1 : index - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = rows.length - 1;
      else if (event.key === 'Enter' && focused && index >= 0 && index < rows.length) {
        event.preventDefault();
        if (opts.onItemSelect) opts.onItemSelect(rows[index], index);
        return;
      }
      if (next === null) return;
      event.preventDefault();
      setSelected(next);
      // 键盘换行后把行滚进可视区（跟原版一致的边距算法）
      var item = rows[selected];
      if (!item) return;
      var top = track.offsetTop + item.offsetTop;
      var bottom = top + item.offsetHeight;
      var room = Math.max(0, (viewport.clientHeight - item.offsetHeight) / 2);
      var margin = Math.min(Math.max(12, opts.fadeSize), room);
      if (top < viewport.scrollTop + margin) {
        viewport.scrollTo({ top: Math.max(0, top - margin), behavior: 'smooth' });
      } else if (bottom > viewport.scrollTop + viewport.clientHeight - margin) {
        viewport.scrollTo({ top: bottom - viewport.clientHeight + margin, behavior: 'smooth' });
      }
    }

    function onPointerMove(event) {
      var moved = event.clientX !== pointer[0] || event.clientY !== pointer[1];
      pointer = [event.clientX, event.clientY];
      if (!navigating || !moved) return;
      navigating = false;
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (target && root.contains(target) && opts.selectOnHover) setSelected(Number(target.dataset.index));
    }

    function onEnter() { engaged = true; }
    function onLeave() { engaged = false; }

    function onItemClick(event) {
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (!target || !root.contains(target)) return;
      var index = Number(target.dataset.index);
      setSelected(index);
      if (opts.onItemSelect) opts.onItemSelect(rows[index], index);
      // ⚠️ 不 preventDefault —— 业务在自己的委托里处理跳转
    }

    function onItemPointerEnter(event) {
      var target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      if (!target || !opts.selectOnHover) return;
      if (!navigating) setSelected(Number(target.dataset.index));
    }

    viewport.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointermove', onPointerMove);
    track.addEventListener('click', onItemClick);
    track.addEventListener('pointerenter', onItemPointerEnter, true);

    /* ---- 入场门控 + 尺寸跟随 ----
       gateThreshold：入场所需的【可见比例】（0~1，默认 0 = 露头就播）。
       页面中段的板块（如单词小游戏网格）加载时就已部分入视口，
       若露头即播，动画会在用户看到之前放完 —— 传 0.85 之类，等滚到基本
       完整可见才触发；底边进入视口（再滚也不会更可见）也放行，防永不触发。 */
    var gate = (typeof IntersectionObserver === 'undefined')
      ? null
      : new IntersectionObserver(function (entries, observer) {
          var hit = entries.some(function (entry) {
            if (!entry.isIntersecting) return false;
            if (opts.gateThreshold <= 0) return true;
            if (entry.intersectionRatio >= opts.gateThreshold) return true;
            var rb = entry.rootBounds, br = entry.boundingClientRect;
            return rb ? br.bottom <= rb.bottom + 1 : true;
          });
          if (!hit) return; // 还没到阈值：保持观察，不 disconnect
          observer.disconnect();
          if (entered) return;
          entered = true;
          measure();
          reveal(true);
        }, (function () {
          var o = { rootMargin: '0px 0px -10% 0px' };
          if (opts.gateThreshold > 0) o.threshold = [0, Math.min(0.99, opts.gateThreshold)];
          return o;
        })());

    var resizeObserver = new ResizeObserver(function () {
      place(true);
      updateFades();
      measure();
      reveal(false);
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(track);

    sync();
    updateFades();
    place(true);
    syncRing();
    if (!entered) {
      if (gate) gate.observe(root);
      else { entered = true; reveal(true); }
    }

    var ctl = {
      refresh: function () { enhance(container, opts); },
      destroy: function () {
        if (raf) window.cancelAnimationFrame(raf);
        if (gate) gate.disconnect();
        resizeObserver.disconnect();
        viewport.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKey);
        root.removeEventListener('pointerenter', onEnter);
        root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointermove', onPointerMove);
        track.removeEventListener('click', onItemClick);
        track.removeEventListener('pointerenter', onItemPointerEnter, true);
        // 还原 DOM：行挪回 container 顶层，包装撤掉（innerHTML 重建场景下这步是空操作）
        if (root.parentNode === container) {
          rows.forEach(function (btn) {
            btn.removeAttribute('data-index');
            btn.removeAttribute('data-selected');
            btn.removeAttribute('aria-selected');
            btn.style.transform = '';
            btn.style.opacity = '';
            btn.style.transition = '';
            btn.style.transitionDelay = '';
            container.appendChild(btn);
          });
          root.remove();
        }
        if (container.__alCtl === ctl) container.__alCtl = null;
      }
    };
    container.__alCtl = ctl;
    return ctl;
  }

  window.AnimatedList = { mount: mount, enhance: enhance };
})(window, document);
