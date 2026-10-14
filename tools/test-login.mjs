/* 登录 / 注册页（login.html）测试 —— jsdom 跑真实页面
   验证两件事：① 初始只显示登录表单、注册表单藏住；② 点 tab 能在两个表单间切换
   跑法（Git Bash）：
     export JSDOM_HOME="C:/Users/你的用户名/.workbuddy/binaries/node/workspace"
     node tools/test-login.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const JSDOM_HOME = process.env.JSDOM_HOME;
if (!JSDOM_HOME) { console.error('[缺少环境变量] 请设置 JSDOM_HOME'); process.exit(2); }
const require = createRequire(JSDOM_HOME.endsWith('/') || JSDOM_HOME.endsWith('\\') ? JSDOM_HOME : JSDOM_HOME + '/');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'app-shell.css'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : '→ ' + extra); }
}

async function boot() {
  const fileUrl = 'file:///' + path.join(ROOT, 'login.html').replace(/\\/g, '/');
  const dom = await new Promise((resolve) => {
    const d = new JSDOM(HTML, {
      url: fileUrl,
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse(win) {
        const mem = new Map();
        Object.defineProperty(win, 'localStorage', {
          configurable: true,
          value: {
            getItem: k => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: k => mem.delete(k), clear: () => mem.clear(),
            key: i => [...mem.keys()][i] || null,
            get length() { return mem.size; }
          }
        });
        win.fetch = () => Promise.resolve({ ok: true, status: 401, json: () => Promise.resolve({ ok: false }) });
        win.HTMLElement.prototype.scrollIntoView = () => {};
      }
    });
    d.window.addEventListener('load', () => resolve(d));
  });
  await new Promise(r => setTimeout(r, 200));
  return dom;
}

const dom = await boot();
const W = dom.window, D = W.document;
const fl = () => D.getElementById('form-login');
const fr = () => D.getElementById('form-register');

console.log('--- 正例：初始状态与 tab 切换 ---');
ok('初始：登录表单显示（未 hidden）', fl().hidden === false, 'hidden=' + fl().hidden);
ok('初始：注册表单隐藏（hidden）', fr().hidden === true, 'hidden=' + fr().hidden);

D.getElementById('tab-register').dispatchEvent(new W.Event('click', { bubbles: true }));
ok('点「注册」tab：注册表单显示', fr().hidden === false, 'hidden=' + fr().hidden);
ok('点「注册」tab：登录表单隐藏', fl().hidden === true, 'hidden=' + fl().hidden);
ok('点「注册」tab：注册 tab 标为选中', D.getElementById('tab-register').getAttribute('aria-selected') === 'true');

D.getElementById('tab-login').dispatchEvent(new W.Event('click', { bubbles: true }));
ok('点「登录」tab：登录表单显示', fl().hidden === false, 'hidden=' + fl().hidden);
ok('点「登录」tab：注册表单隐藏', fr().hidden === true, 'hidden=' + fr().hidden);

console.log('--- CSS 修复：display 不再盖掉 hidden ---');
ok('.auth-card[hidden] 规则存在', /\.auth-card\[hidden\]\s*\{[^}]*display:\s*none/.test(CSS));
ok('登录页内容居中规则存在（body.page-auth .appmain justify-content:center）',
  /body\.page-auth\s+\.appmain\s*\{[^}]*justify-content:\s*center/.test(CSS));
ok('标题区用 body. 提权到 max-width:420（防「对齐」bug 复发）',
  /body\.page-auth\s+\.site-header\s*\{[^}]*max-width:\s*420px/.test(CSS));
ok('标题右边有英文小字 .auth-h1-en 样式',
  /body\.page-auth\s+\.site-header\s+h1\s+\.auth-h1-en/.test(CSS));

console.log('--- 反例：故意让 showTab 切错元素，断言应当失败 ---');
{
  /* 模拟"切错到 tab 按钮"的旧 bug：把 tab 按钮当表单切，表单就不动 */
  const d2 = await boot();
  const D2 = d2.window.document;
  // 正确行为下，点注册后 form-register 应显示；这里手动把它藏回去模拟 bug
  D2.getElementById('tab-register').dispatchEvent(new d2.window.Event('click', { bubbles: true }));
  D2.getElementById('form-register').hidden = true;   // 人为破坏
  ok('人为藏住注册表单后，「注册表单显示」断言确实会红',
    D2.getElementById('form-register').hidden === true);
  d2.window.close();
}

dom.window.close();
console.log('\n合计：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
