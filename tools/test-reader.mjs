/* 文本跟读页（index.html）测试 —— jsdom 跑真实页面 + 真实数据
   验证两件事：① 分段不显示文字、只显示时间戳；② 深链 ?file=编号&t=秒 自动打开并定位（停止状态）
   跑法（Git Bash）：
     export JSDOM_HOME="C:/Users/你的用户名/.workbuddy/binaries/node/workspace"
     node tools/test-reader.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const JSDOM_HOME = process.env.JSDOM_HOME;
if (!JSDOM_HOME) { console.error('[缺少环境变量] 请设置 JSDOM_HOME 指向 jsdom 所在目录'); process.exit(2); }
const require = createRequire(JSDOM_HOME.endsWith('/') || JSDOM_HOME.endsWith('\\') ? JSDOM_HOME : JSDOM_HOME + '/');
const { JSDOM, VirtualConsole } = require('jsdom');

/* 门禁跳转验证：jsdom 不支持真实导航，用 virtualConsole 捕获 navigation 当作"跳转被触发"的证据 */
let navAttempted = false;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', function (err) {
  if (err && err.message && String(err.message).indexOf('navigation') >= 0) navAttempted = true;
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MATERIALS = fs.readFileSync(path.join(ROOT, 'data', 'materials.json'), 'utf8');
const SEGMENTS = fs.readFileSync(path.join(ROOT, 'data', 'segments.json'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : '→ ' + extra); }
}

async function boot(query, opts) {
  opts = opts || {};
  const withToken = opts.withToken !== false;   /* 默认带 token（已登录），门禁断言单传 false */
  const fileUrl = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
  const dom = await new Promise((resolve, reject) => {
    const d = new JSDOM(HTML, {
      url: fileUrl + (query || ''),
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(win) {
        const mem = new Map();
        if (withToken) mem.set('echoread_token', 'test-token-abc');
        Object.defineProperty(win, 'localStorage', {
          configurable: true,
          value: {
            getItem: k => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: k => mem.delete(k),
            clear: () => mem.clear(),
            key: i => [...mem.keys()][i] || null,
            get length() { return mem.size; }
          }
        });
        win.fetch = (url) => {
          const u = String(url);
          let body = '[]';
          if (u.indexOf('materials.json') >= 0) body = MATERIALS;
          else if (u.indexOf('segments.json') >= 0) body = SEGMENTS;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(body)) });
        };
        win.Audio = class {
          constructor() { this.paused = true; this.currentTime = 0; this.duration = 100; }
          play() { this.paused = false; return Promise.resolve(); }
          pause() { this.paused = true; }
          addEventListener() {}
        };
        win.requestAnimationFrame = () => 0;
        win.cancelAnimationFrame = () => {};
        win.HTMLElement.prototype.scrollIntoView = () => {};
      }
    });
    d.window.addEventListener('load', () => resolve(d));
  });
  await new Promise(r => setTimeout(r, 300));
  return dom;
}

/* ---- 正例 1：默认加载 → 停在课程列表，不自动打开文件 ---- */
{
  const dom = await boot('');
  const D = dom.window.document;
  const lessons = D.querySelectorAll('#lessons .lesson-btn');
  ok('默认停在课程列表（22 课）', lessons.length === 22, '实测 ' + lessons.length);
  ok('默认不自动打开任何文件（素材区为空）', D.getElementById('reader').innerHTML.trim() === '');
  dom.window.close();
}

/* ---- 正例 2：深链 ?file=L1.1&t=13 → 自动打开并定位 ---- */
{
  const dom = await boot('?file=L1.1&t=13');
  const D = dom.window.document;
  const material = D.querySelector('#reader .material');
  ok('深链自动打开 L1.1 素材', !!material, material && material.getAttribute('data-audio'));
  const segs = D.querySelectorAll('#reader .seg');
  ok('L1.1 渲染 12 句', segs.length === 12, '实测 ' + segs.length);
  ok('分段不显示文字（无 .seg-text）', D.querySelectorAll('#reader .seg-text').length === 0);
  ok('分段显示时间戳（有 .seg-time）', D.querySelectorAll('#reader .seg-time').length === segs.length);
  const firstTime = D.querySelector('#reader .seg-time');
  ok('时间戳格式 mm:ss – mm:ss', firstTime && /^\d{2}:\d{2} – \d{2}:\d{2}$/.test(firstTime.textContent.trim()), firstTime && firstTime.textContent);
  const playing = D.querySelector('#reader .seg.is-playing');
  ok('定位到 13 秒所在句（第 4 句高亮）', !!playing && playing.getAttribute('data-start') === '13', playing && playing.getAttribute('data-start'));
  dom.window.close();
}

/* ---- 数据完整性：materials.json 的每条 audio 路径都要有对应文件 ----
   （防「Lesson 减一只改目录名、漏改目录里的文件名」那类 bug 复发）*/
{
  const MAT = JSON.parse(MATERIALS);
  const missing = MAT.materials.filter((m) => !fs.existsSync(path.join(ROOT, m.audio)));
  ok('materials 音频路径全部存在（' + MAT.materials.length + ' 条）', missing.length === 0,
    missing.length ? ('缺失: ' + missing.map((m) => m.id + '→' + m.audio).join(', ')) : '缺失 0');
}

/* ---- 门禁：未登录不能进学习页（版权要求）---- */
{
  navAttempted = false;
  const g1 = await boot('', { withToken: false });
  ok('未登录（无 token）→ 触发跳回登录页', navAttempted === true, 'navAttempted=' + navAttempted);
  g1.window.close();
}
{
  navAttempted = false;
  const g2 = await boot('');
  ok('已登录（有 token）→ 不跳转', navAttempted === false, 'navAttempted=' + navAttempted);
  g2.window.close();
}

/* ---- 反例：故意注入缺陷，证明断言真能抓到 ---- */
{
  /* 反例 A：segments 里塞回 text → 「不显示文字」断言应当失败 */
  const dom = await boot('?file=L1.1&t=13');
  const D = dom.window.document;
  D.querySelectorAll('#reader .seg').forEach((li) => {
    const body = li.querySelector('.seg-body');
    if (body) {
      const t = D.createElement('span');
      t.className = 'seg-text'; t.textContent = 'x';
      body.insertBefore(t, body.firstChild);
    }
  });
  ok('手动塞回 .seg-text 后，「无文字」断言确实会红',
    D.querySelectorAll('#reader .seg-text').length > 0, '实测 ' + D.querySelectorAll('#reader .seg-text').length);
  dom.window.close();
}

console.log('\n合计：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
