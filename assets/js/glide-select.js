/* ============================================================================
   glide-select.js —— 把 <select data-role="speed"> 换成 Glide Select 外观
   Day 32（斌哥要求）：动效照搬 reactbits.dev/c/micro/glide-select，
   只把行文案换成倍速，其余行为原样。

   ⚠️ 最重要的一条：**player.js 一行都不用改。**
      做法是原生 <select> 仍然留在 DOM 里（视觉隐藏），
      点选项时写回 select.value，再 dispatch 一个 bubbles 的 change 事件。
      player.js 现有的那段：
          document.addEventListener('change', function (e) {
            if (e.target.closest('[data-role="speed"]')) { rate = parseFloat(e.target.value) ... }
          })
      不需要任何改动就能收到 —— 因为它本来监听的就是 document + 冒泡事件。
      这样「倍速切换逻辑」在代码层面完全没被碰过，只是换了个皮肤。

   ⚠️ 只被 index.html 引用。
   ========================================================================== */

(function () {
  'use strict';

  var GAP = 1;          /* 与 CSS 里 .glide-select__list 的 gap 一致 */
  var MENU_GAP = 6;     /* 菜单与按钮的间距，与 CSS 的 calc(100% + 6px) 一致 */
  var POP_OUT_MS = 120; /* = popDuration 180 × 2/3 */

  var uid = 0;

  function enhance(select) {
    if (!select || select.dataset.gsReady === '1') return;
    if (!select.options || !select.options.length) return;
    if (!select.parentNode) return;

    select.dataset.gsReady = '1';

    /* ---- 1. 从原生 select 读选项（它是唯一真相源）---- */
    var items = [];
    for (var i = 0; i < select.options.length; i++) {
      items.push({
        value: select.options[i].value,
        label: select.options[i].textContent
      });
    }

    var listId = 'gs-list-' + (++uid);

    /* ---- 2. 搭骨架 ---- */
    var root = document.createElement('div');
    root.className = 'glide-select';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'glide-select__trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listId);
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '播放倍速');

    var label = document.createElement('span');
    label.className = 'glide-select__label';

    var chevron = document.createElement('span');
    chevron.className = 'glide-select__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

    trigger.appendChild(label);
    trigger.appendChild(chevron);

    var menu = document.createElement('div');
    menu.className = 'glide-select__menu';
    menu.setAttribute('data-state', 'closed');
    menu.setAttribute('data-side', 'bottom');
    menu.setAttribute('data-align', 'right');
    menu.style.display = 'none';

    var list = document.createElement('div');
    list.className = 'glide-select__list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', trigger.getAttribute('aria-label'));

    /* 唯一的高亮药丸：整个组件就这一个，靠 translateY 在行间滑动 */
    var pill = document.createElement('span');
    pill.className = 'glide-select__pill';
    pill.setAttribute('aria-hidden', 'true');
    list.appendChild(pill);

    var rows = items.map(function (item, idx) {
      var row = document.createElement('div');
      row.className = 'glide-select__option';
      row.setAttribute('role', 'option');
      row.setAttribute('data-index', String(idx));
      row.id = listId + '-' + idx;

      var name = document.createElement('span');
      name.className = 'glide-select__name';
      name.textContent = item.label;

      var check = document.createElement('span');
      check.className = 'glide-select__check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M20 6 9 17l-5-5"/></svg>';

      row.appendChild(name);
      row.appendChild(check);
      list.appendChild(row);
      return row;
    });

    menu.appendChild(list);
    root.appendChild(trigger);
    root.appendChild(menu);

    /* ---- 3. 顶替原生 select：先在原位插入 root，再把 select 搬进 root 内部 ----
       搬进去之后 select 是 position:absolute + 1px 尺寸，不占布局，
       所以 .mat-head 这行 flex 里只剩标题 + 本组件，间距与原来一致。 */
    select.parentNode.insertBefore(root, select);
    root.appendChild(select);
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    /* ---- 3.5 展开时抬层级 ----
       为什么要抬：装着本组件的那一行（.mat-head）带入场动画，
       动画收尾的 `translate: 0 0` 把它变成了独立堆叠上下文，
       菜单的 z-index 就被关在里面比大小；而播放条排在它后面、也在另一层，
       按"同层看源序"整块压过来 —— 光调菜单的 z-index 是调不好的。
       所以展开期间连【行容器本身】一起抬，收起再摘（详见 CSS 里 .glide-select-lift）。

       抬谁：不写死 .mat-head —— 谁装着这个按钮就抬谁（root 的父元素）。
       这样以后倍速按钮挪到别处，这段逻辑不用跟着改。 */
    var host = root.parentNode;
    function lift(on) {
      if (!host || host.nodeType !== 1 || !host.classList) return;
      if (on) host.classList.add('glide-select-lift');
      else host.classList.remove('glide-select-lift');
    }

    /* ---- 4. 状态 ---- */
    var phase = 'closed';   /* closed | open | closing */
    var active = null;      /* 药丸当前停在第几行；null = 不显示 */
    var instant = false;    /* 下一次移动是否瞬移（打开瞬间、键盘操作） */
    var closeTimer = null;
    var scrub = null;       /* 按住拖动：{ id, top } */

    function stepHeight() {
      /* 行高 + 1px 间隙，和 CSS 的 grid gap 对齐 */
      var h = rows[0] ? rows[0].offsetHeight : 28;
      return h + GAP;
    }

    function selectedIndex() {
      for (var k = 0; k < items.length; k++) {
        if (items[k].value === select.value) return k;
      }
      return -1;
    }

    /* 把 select 的当前值同步到按钮文案、行选中态、对勾 */
    function syncFromSelect() {
      var si = selectedIndex();
      label.textContent = si >= 0 ? items[si].label : (items[0] ? items[0].label : '');
      if (si < 0) label.setAttribute('data-empty', '');
      else label.removeAttribute('data-empty');

      rows.forEach(function (row, idx) {
        if (idx === si) row.setAttribute('aria-selected', 'true');
        else row.removeAttribute('aria-selected');

        var check = row.querySelector('.glide-select__check');
        if (!check) return;
        if (idx === si) check.setAttribute('data-on', '');
        else check.removeAttribute('data-on');
      });

      if (si >= 0) trigger.setAttribute('aria-activedescendant', listId + '-' + si);
      else trigger.removeAttribute('aria-activedescendant');
    }

    /* 药丸落位。jump=true 用 0ms 直接到（不平滑），否则走 CSS 的 220ms */
    function placePill(idx, jump) {
      if (idx === null || idx < 0) {
        pill.style.opacity = '0';
        delete list.dataset.live;
        return;
      }
      pill.style.transitionDuration = jump ? '0ms, 150ms' : '';
      pill.style.transform = 'translateY(' + (idx * stepHeight()) + 'px)';
      pill.style.opacity = '1';
      list.dataset.live = '';
    }

    function setActive(idx, jump) {
      active = idx;
      placePill(idx, jump);
      if (idx === null) trigger.removeAttribute('aria-activedescendant');
      else trigger.setAttribute('aria-activedescendant', listId + '-' + idx);
    }

    /* 展开方向：下方放不下就翻到上方（原组件的 resolveSide） */
    function resolveSide() {
      var rect = trigger.getBoundingClientRect();
      var need = menu.offsetHeight + MENU_GAP;
      var side = 'bottom';
      if (rect.bottom + need > window.innerHeight && rect.top - need >= 0) side = 'top';
      menu.setAttribute('data-side', side);
      root.style.setProperty('--gs-origin', (side === 'bottom' ? 'top' : 'bottom') + ' right');
    }

    function open(viaKey) {
      if (phase === 'open') return;
      clearTimeout(closeTimer);
      instant = true;

      var si = selectedIndex();
      if (si >= 0) active = si;
      else active = viaKey ? 0 : null;

      menu.style.display = 'block';
      resolveSide();
      lift(true);                       /* 先抬层级，再让它长出来 —— 否则第一帧就露一下底 */

      /* 重置到起点再切到 open：每次都从头播「从角落长出」 */
      menu.setAttribute('data-state', 'closed');
      void menu.offsetHeight;
      menu.setAttribute('data-state', 'open');

      phase = 'open';
      trigger.setAttribute('aria-expanded', 'true');

      /* 药丸瞬移到选中行且先透明，避免从第 0 行滑进来 */
      pill.style.transition = 'none';
      pill.style.transform = 'translateY(' + (Math.max(0, si) * stepHeight()) + 'px)';
      pill.style.opacity = '0';
      void pill.offsetHeight;
      pill.style.transition = '';

      if (active !== null) setActive(active, true);
      instant = false;
    }

    function close(mode) {
      active = null;
      pill.style.opacity = '0';
      delete list.dataset.live;
      clearTimeout(closeTimer);

      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');

      if (mode === 'instant') {
        menu.setAttribute('data-state', 'closed');
        menu.style.display = 'none';
        phase = 'closed';
        lift(false);                    /* 已经看不见了，层级立刻还回去 */
        return;
      }

      /* 收起：用 2/3 时长播完再真正收起来 */
      menu.setAttribute('data-state', 'closed');
      phase = 'closing';
      closeTimer = setTimeout(function () {
        menu.style.display = 'none';
        phase = 'closed';
        /* ⚠️ 层级要等收起动画播完才还：动画到一半就降下去的话，
           菜单会当着用户的面"掉"到播放条背后，比一直盖着还难懂。 */
        lift(false);
      }, POP_OUT_MS + 20);
    }

    function pick(idx, viaKey) {
      var item = items[idx];
      if (!item) { close('instant'); return; }

      var changed = item.value !== select.value;
      if (changed) {
        /* ★ 核心：写回原生 select，并派发一个会冒泡的 change。
           player.js 的 document 监听器据此更新 rate / localStorage / 所有缓存音频，
           与手动操作原生下拉的路径完全一致。 */
        select.value = item.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        syncFromSelect();
        /* 换值闪烁：160ms 的 gs-swap，animationend 时自己摘掉 */
        if (!viaKey) delete root.dataset.swap;
        if (!viaKey) root.dataset.swap = '';
      }

      close('instant');
      try { trigger.focus({ preventScroll: true }); } catch (e) { trigger.focus(); }
    }

    /* ---- 5. 指针 ---- */

    trigger.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();               /* 别让 pointerdown 抢焦点导致键盘态闪一下 */
      try { trigger.focus({ preventScroll: true }); } catch (err) { trigger.focus(); }
      if (phase === 'open') close('pop');
      else open(false);
    });

    list.addEventListener('pointerover', function (e) {
      if (e.pointerType === 'touch' || scrub) return;
      var row = e.target && e.target.closest ? e.target.closest('[data-index]') : null;
      if (!row) return;
      var idx = Number(row.getAttribute('data-index'));
      if (idx === active) return;
      setActive(idx, false);            /* 悬停：滑过去（220ms） */
    });

    list.addEventListener('pointerleave', function () {
      if (scrub) return;
      /* 原组件 rememberPosition 默认 true：指针离开时药丸停在原处，不弹回选中行 */
    });

    /* 按住往下拖、松手选中（原组件的 scrub，一条手势选完） */
    list.addEventListener('pointerdown', function (e) {
      if (scrub) return;
      var top = list.getBoundingClientRect().top;
      try { list.setPointerCapture(e.pointerId); } catch (err) {}
      scrub = { id: e.pointerId, top: top };
      instant = true;
      active = rowAt(e.clientY);
      placePill(active, true);
      instant = false;
    });

    function rowAt(y) {
      if (!scrub) return null;
      var i = Math.floor((y - scrub.top - 4) / stepHeight());
      return i >= 0 && i < items.length ? i : null;
    }

    list.addEventListener('pointermove', function (e) {
      if (!scrub || scrub.id !== e.pointerId) return;
      var idx = rowAt(e.clientY);
      if (idx !== active) setActive(idx, true);
    });

    function endScrub(e) {
      if (!scrub || scrub.id !== e.pointerId) return;
      var idx = e.type === 'pointerup' ? rowAt(e.clientY) : null;
      scrub = null;
      if (idx !== null) pick(idx, false);
    }

    list.addEventListener('pointerup', endScrub);
    list.addEventListener('pointercancel', endScrub);
    list.addEventListener('lostpointercapture', endScrub);

    /* ---- 6. 点击外部关闭 ---- */
    document.addEventListener('pointerdown', function (e) {
      if (phase === 'closed') return;
      if (!root.contains(e.target)) close('pop');
    }, true);

    /* ---- 7. 键盘（按原生 combobox 的习惯）---- */
    trigger.addEventListener('keydown', function (e) {
      var k = e.key;
      var n = items.length;
      var cur = active === null ? Math.max(0, selectedIndex()) : active;

      if (phase !== 'open') {
        if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
          e.preventDefault();
          open(true);
        }
        return;
      }

      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        var next = active === null ? cur : cur + (k === 'ArrowDown' ? 1 : -1);
        next = Math.max(0, Math.min(n - 1, next));
        instant = true;
        setActive(next, true);          /* 键盘：瞬移，不滑 */
        instant = false;
      } else if (k === 'Home' || k === 'End') {
        e.preventDefault();
        instant = true;
        setActive(k === 'Home' ? 0 : n - 1, true);
        instant = false;
      } else if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        pick(cur, true);
      } else if (k === 'Escape' || k === 'Tab') {
        if (k === 'Escape') e.preventDefault();
        close('instant');
      }
    });

    /* ---- 8. 换值闪烁结束后摘标记 ---- */
    root.addEventListener('animationend', function (e) {
      if (e.animationName && e.animationName.indexOf('gs-swap') === 0) {
        delete root.dataset.swap;
      }
    });

    /* ---- 9. 首次同步 ---- */
    syncFromSelect();
  }

  function enhanceAll(scope) {
    var host = scope || document;
    var nodes = host.querySelectorAll('select[data-role="speed"]');
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  window.GlideSelect = {
    enhance: enhance,
    enhanceAll: enhanceAll
  };
})();
