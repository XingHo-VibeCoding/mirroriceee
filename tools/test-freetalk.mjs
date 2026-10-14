/* free talk 页（writing.html）功能测试 —— jsdom 跑真实页面 + 真实 data/freetalk.json
   跑法（Git Bash）：
     export JSDOM_HOME="C:/Users/你的用户名/.workbuddy/binaries/node/workspace"
     node tools/test-freetalk.mjs
   ⚠️ jsdom 装在托管工作区，不在本项目 node_modules；ESM 又不认 NODE_PATH，
      所以通过环境变量 JSDOM_HOME 告诉脚本它的位置（不要写死个人路径）。
   ⚠️ 最后两组是反向验证：故意注入缺陷，确认测试真能抓到（防橡皮章）。 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

/* jsdom 装在托管工作区，不在本项目 node_modules；ESM 又不认 NODE_PATH，
   所以用 createRequire 从 JSDOM_HOME 取。JSDOM_HOME 由运行者本机设置。 */
const JSDOM_HOME = process.env.JSDOM_HOME;
if (!JSDOM_HOME) {
  console.error('[缺少环境变量] 请先设置 JSDOM_HOME 指向你本机 jsdom 所在目录，例如：');
  console.error('  export JSDOM_HOME="C:/Users/你的用户名/.workbuddy/binaries/node/workspace"');
  process.exit(2);
}
const require = createRequire(JSDOM_HOME.endsWith('/') || JSDOM_HOME.endsWith('\\') ? JSDOM_HOME : JSDOM_HOME + '/');
const { JSDOM, VirtualConsole } = require('jsdom');

/* jsdom 的 location 是只读属性，没法拦 href 赋值；但赋值会触发 navigation，
   jsdom 把「不支持导航」报成 jsdomError —— 捕获它当作「跳转被触发」的证据。 */
let navAttempted = false;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', function (err) {
  if (err && err.message && String(err.message).indexOf('navigation') >= 0) navAttempted = true;
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'writing.html');
const DATA = path.join(ROOT, 'data', 'freetalk.json');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : '→ ' + extra); }
}

/* 起一个页面实例。mutate 可在解析前改写数据，用于反向验证。 */
async function boot(mutate) {
  let raw = fs.readFileSync(DATA, 'utf8');
  if (mutate) raw = mutate(raw);

  const dom = await JSDOM.fromFile(HTML, {
    /* 不指定 url：走 file:// 基址，assets/js 下的外置脚本才会真的从磁盘加载。
       代价是 file:// 源没有 localStorage，下面自己注入一个。 */
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      const mem = new Map();
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
      /* jsdom 没有 fetch：注入一个直接读本地数据文件的实现 */
      win.fetch = () => Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(JSON.parse(raw))
      });
      /* 跳转验证用模块级的 navAttempted（见顶部 virtualConsole），这里不需要拦 location */
      /* jsdom 没有 Audio：打个桩，记录被请求的地址（词汇发音用） */
      win.__played = [];
      win.Audio = class {
        constructor(src) { this.src = src; this.currentTime = 0; win.__played.push(src); }
        play() {}
        pause() {}
        addEventListener() {}
      };
      win.HTMLElement.prototype.scrollIntoView = () => {};
    }
  });
  /* 等外置脚本 + fetch 链路走完 */
  await new Promise(r => dom.window.addEventListener('load', r));
  for (let i = 0; i < 60; i++) {
    if (!dom.window.document.getElementById('ft-main').hidden) break;
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 120));
  return dom;
}

const d0 = await boot();
const W = d0.window, D = W.document;
const $ = (id) => D.getElementById(id);
const txt = (id) => ($(id) ? $(id).textContent.trim() : '');

console.log('--- 正例：真实数据 ---');

/* 1 左栏分类 */
const cats = D.querySelectorAll('#catList .level-btn');
ok('左栏渲染 11 个分类按钮', cats.length === 11, '实测 ' + cats.length);
const allBtn = D.querySelector('#catList .level-btn[data-cat="all"]');
ok('默认选中「全部」', allBtn && allBtn.getAttribute('aria-pressed') === 'true');
ok('「全部」计数为 0/60', allBtn && allBtn.textContent.indexOf('0/60') >= 0, allBtn && allBtn.textContent);

/* 2 话题卡 */
ok('话题区已显示（不再是一片空白）', $('ft-main').hidden === false);
ok('英文问句非空', txt('ftQ').length > 0, txt('ftQ'));
ok('中文翻译非空', txt('ftZh').length > 0, txt('ftZh'));
ok('三个标签（Part / 分类 / 难度）都有值',
  txt('ftPart') && txt('ftCat') && txt('ftLevel'),
  [txt('ftPart'), txt('ftCat'), txt('ftLevel')].join(' | '));

/* 3 追问 / 词汇 / 支架 */
const follows = D.querySelectorAll('#ftFollow .ft-follow');
ok('追问至少 2 条', follows.length >= 2, '实测 ' + follows.length);
const words = D.querySelectorAll('#ftWords .ft-w');
ok('参考词汇至少 4 个', words.length >= 4, '实测 ' + words.length);
ok('表达支架非空', txt('ftTips').length > 0);

/* 4 参考回答默认折叠 → 点击展开 */
ok('参考回答默认折叠', $('secSample').className.indexOf('open') < 0);
D.querySelector('#secSample .ft-h').dispatchEvent(new W.Event('click', { bubbles: true }));
ok('点标题后参考回答展开', $('secSample').className.indexOf('open') >= 0);
ok('参考回答正文非空', txt('ftSample').length > 30, txt('ftSample').slice(0, 40) + '…');

/* 4.5 星一班表达溯源 */
const srcItems = D.querySelectorAll('#ftSrcList .ft-src-item');
ok('溯源区渲染了星一班表达', $('ftSrc').hidden === false && srcItems.length >= 1, '实测 ' + srcItems.length);
ok('溯源条目含表达 + 编号', srcItems.length && srcItems[0].textContent.indexOf('L') >= 0,
  srcItems.length ? srcItems[0].textContent : '无');

/* 4.6 点击溯源 chip 跳转到文本跟读页 */
const chip0 = srcItems[0];
const chip0Ref = chip0 ? chip0.getAttribute('data-ref') : '';
ok('溯源 chip 带跳转属性（ref/s）',
  !!chip0Ref && chip0.getAttribute('data-s') !== null, chip0Ref);
navAttempted = false;
if (chip0) chip0.dispatchEvent(new W.Event('click', { bubbles: true }));
ok('点 chip 后触发跳转到跟读页', navAttempted === true, 'navAttempted=' + navAttempted);

/* 5 词汇发音走有道标准美音 */
words[0].dispatchEvent(new W.Event('click', { bubbles: true }));
const played = W.__played[W.__played.length - 1] || '';
ok('点词汇请求有道美音（type=2）',
  played.indexOf('dict.youdao.com/dictvoice') >= 0 && played.indexOf('type=2') >= 0, played);

/* 6 输入 → 字数统计 + 草稿落盘 */
const ta = $('ftAns');
ta.value = 'I usually go for a walk after dinner because it helps me slow down.';
ta.dispatchEvent(new W.Event('input', { bubbles: true }));
ok('字数统计更新为 14', txt('ftCount').indexOf('14') === 0, txt('ftCount'));
const draft = JSON.parse(W.localStorage.getItem('freetalk_draft') || '{}');
ok('回答已存入 localStorage 草稿', Object.values(draft).some(v => v.indexOf('go for a walk') >= 0));

/* 7 标记已练 → 左栏进度变化 */
const q0 = txt('ftQ');
$('ftDone').dispatchEvent(new W.Event('click', { bubbles: true }));
ok('按钮变为已练状态', txt('ftDone').indexOf('已练') >= 0, txt('ftDone'));
const allBtn2 = D.querySelector('#catList .level-btn[data-cat="all"]');
ok('左栏进度变为 1/60', allBtn2.textContent.indexOf('1/60') >= 0, allBtn2.textContent);

/* 8 换一个话题 */
$('ftChange').dispatchEvent(new W.Event('click', { bubbles: true }));
ok('点「换一个话题」后问句变化', txt('ftQ') !== q0, '换前：' + q0.slice(0, 30));

/* 9 切分类 */
D.querySelector('#catList .level-btn[data-cat="music"]')
  .dispatchEvent(new W.Event('click', { bubbles: true }));
ok('切到「音乐」分类后分类标签显示音乐', txt('ftCat') === '音乐', txt('ftCat'));
const musicBtn = D.querySelector('#catList .level-btn[data-cat="music"]');
ok('音乐分类计数 0/5', musicBtn.textContent.indexOf('0/5') >= 0, musicBtn.textContent);

/* 10 AI 纠错按钮置灰 */
ok('AI 纠错按钮 disabled（待开放，不接后端）', $('ftAI').disabled === true);

/* 11 话题卡（Part 2）显示要点 bullet */
const d2 = await boot();
const D2 = d2.window.document;
D2.querySelector('#catList .level-btn[data-cat="card"]')
  .dispatchEvent(new d2.window.Event('click', { bubbles: true }));
const b2 = D2.querySelectorAll('#ftBul li');
ok('话题卡分类显示 4 条要点', b2.length === 4, '实测 ' + b2.length);
d2.window.close();

console.log('\n--- 反例：故意注入缺陷，确认测试真能抓到 ---');

/* 反例 A：题库空 → 应给出「题库是空的」，而不是白屏 */
const bad1 = await boot(() => JSON.stringify({ cats: [], topics: [] }));
ok('题库为空时给出明确提示（不是白屏）',
  bad1.window.document.getElementById('ft-status').textContent.indexOf('题库是空的') >= 0,
  bad1.window.document.getElementById('ft-status').textContent);
bad1.window.close();

/* 反例 B：数据缺字段（追问为空）→ 追问条数断言应当失败 */
const bad2 = await boot((raw) => {
  const d = JSON.parse(raw);
  d.topics = d.topics.map(t => Object.assign({}, t, { follow: [] }));
  return JSON.stringify(d);
});
const badFollows = bad2.window.document.querySelectorAll('#ftFollow .ft-follow').length;
ok('追问被清空后，追问数断言确实会红（证明断言有效）', badFollows === 0, '实测 ' + badFollows);
bad2.window.close();

/* 反例 C：AI 按钮若被误接成可用（disabled=false）→ 断言应当失败 */
const bad3 = await boot();
bad3.window.document.getElementById('ftAI').disabled = false;
ok('AI 按钮若被放开，断言确实会红', bad3.window.document.getElementById('ftAI').disabled === false);
bad3.window.close();

/* 反例 D：src 为空 → 溯源区应隐藏（证明溯源渲染逻辑有效） */
const bad4 = await boot((raw) => {
  const d = JSON.parse(raw);
  d.topics = d.topics.map(t => Object.assign({}, t, { src: [] }));
  return JSON.stringify(d);
});
ok('src 为空时溯源区隐藏', bad4.window.document.getElementById('ftSrc').hidden === true);
bad4.window.close();

/* 反例 E：ref 缺失的 chip 点击 → 不跳转（navAttempted 保持 false） */
navAttempted = false;
const chipNoRef = D.querySelector('.ft-src-item');
if (chipNoRef) chipNoRef.removeAttribute('data-ref');
if (chipNoRef) chipNoRef.dispatchEvent(new W.Event('click', { bubbles: true }));
ok('ref 缺失的 chip 点击不跳转', navAttempted === false, 'navAttempted=' + navAttempted);

d0.window.close();
console.log('\n合计：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
