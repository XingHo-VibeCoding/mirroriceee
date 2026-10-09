/* ============================================
   verify-three-states.cjs —— 「前端准则自查」Skill 的真机三态验证
   职责：真开一个浏览器，把「筛选交互」点一遍，验证三态在【浏览器里】真的对

   为什么静态检查不够：
     check-filter-interaction.mjs 只能证明「代码里写了这三种处理」，
     证明不了「点下去真的对」。这一半必须真机跑。

   ⚠️ 为什么默认不开本地服务器（磁盘直喂）：
     项目自带的 dev-server.js 硬绑 0.0.0.0（线上平台需要），
     在公共热点下等于把整个项目（含 .env）摊给同网段的人。
     所以这里不开端口：page.route 把所有请求截下来，直接从磁盘读文件喂回去。
     浏览器照样真渲染、真执行 JS —— 只是资源来源换成磁盘。
     （Day 10 的 _probe/verify_bg.js 首次用了这条路，实测可行。）

   依赖（本机已有，不用装）：
     playwright-core —— 装在受管 Node 工作区；Edge 浏览器 —— 系统自带
   用法：
     NODE_PATH=<受管工作区>/node_modules node verify-three-states.cjs <项目根>
   可选环境变量：
     BASE_URL      设了就走真实 http（本地起好服务再用）；不设＝磁盘直喂
     BROWSER_PATH  默认本机 Edge 路径

   术语备注：
     headless —— 无界面模式，浏览器在后台跑，不弹窗口
     page.route —— playwright 的请求拦截，能在请求发出前截住、自己给答复
     aria-pressed —— 读屏用来播报「这个开关是不是按下的」属性
   ============================================ */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const EDGE = process.env.BROWSER_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SERVE_URL = process.env.BASE_URL || null;   /* 给了才走真实服务 */
const FAKE_ORIGIN = 'http://127.0.0.1:9';         /* 无人监听，请求全被截 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/* 读一眼列表容器现在的样子 —— 三种状态全靠这几个数判定 */
const readFiles = () => {
  const nav = document.getElementById('files');
  if (!nav) return null;
  const emptyEl = nav.querySelector('.empty');
  return {
    count: nav.querySelectorAll('.file-btn').length,
    names: [...nav.querySelectorAll('.file-name')].map((e) => e.textContent.trim()),
    empty: emptyEl ? emptyEl.textContent.trim() : null,
  };
};

/* 读一眼筛选键的选中态 + 当前焦点停在哪个键上 */
const readLevels = () => ({
  buttons: [...document.querySelectorAll('[data-action="pick-level"]')].map((b) => ({
    level: b.getAttribute('data-level'),
    pressed: b.getAttribute('aria-pressed'),
  })),
  focused: document.activeElement ? document.activeElement.getAttribute('data-level') : null,
});

const results = [];
function record(step, ok, actual) {
  results.push({ step, ok, actual });
  console.log((ok ? '✅' : '❌') + ' ' + step);
  console.log('    实测：' + actual);
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1278, height: 800 } });

  /* 磁盘直喂：把对 FAKE_ORIGIN 的请求全部从项目目录读文件返回 */
  if (!SERVE_URL) {
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        return route.fulfill({ status: 404, body: '404' });
      }
      route.fulfill({
        status: 200,
        contentType: MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        body: fs.readFileSync(abs),
      });
    });
  }

  const BASE = SERVE_URL || FAKE_ORIGIN;
  console.log('【三态真机验证】目标：' + BASE + '/reader.html');
  console.log('资源来源：' + (SERVE_URL ? '真实服务' : '磁盘直喂（不开端口）') +
    '｜项目根：' + ROOT);
  console.log('');

  await page.goto(BASE + '/reader.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-action="pick-level"]', { timeout: 10000 });
  await page.waitForTimeout(300);

  const pick = async (level) => {
    await page.click('[data-action="pick-level"][data-level="' + level + '"]');
    await page.waitForTimeout(250);
    return page.evaluate(readFiles);
  };

  /* ① 有结果：L1 下有素材，文件列表应出现条目 */
  const l1 = await pick('L1');
  record(
    '① 有结果 —— 选 L1（有素材），文件列表应出现条目',
    !!l1 && l1.count >= 1 && !l1.empty,
    '条数=' + (l1 ? l1.count : 'null') +
      '｜文件名=' + JSON.stringify(l1 ? l1.names : null) +
      '｜空状态=' + (l1 && l1.empty ? JSON.stringify(l1.empty) : '无')
  );

  /* ② 无结果：L2 / L3 没有素材，应给出人话空状态，而不是留白 */
  for (const lv of ['L2', 'L3']) {
    const r = await pick(lv);
    record(
      '② 无结果 —— 选 ' + lv + '（无素材），应显示「' + lv + ' 暂无素材」',
      !!r && r.count === 0 && !!r.empty && r.empty.indexOf(lv) >= 0,
      '条数=' + (r ? r.count : 'null') +
        '｜空状态=' + (r && r.empty ? JSON.stringify(r.empty) : '（无，疑似留白）')
    );
  }

  /* ③ 清空恢复：切回 L1，条目应原样回来、空状态消失 */
  const back = await pick('L1');
  record(
    '③ 清空恢复 —— 切回 L1，条目应原样回来',
    !!back && back.count >= 1 && !back.empty && back.count === (l1 ? l1.count : -1),
    '条数=' + (back ? back.count : 'null') +
      '（第①步时 ' + (l1 ? l1.count : 'null') + '）' +
      '｜空状态=' + (back && back.empty ? JSON.stringify(back.empty) : '无')
  );

  /* ④ 余力加练 · 可访问性：切换筛选后，焦点应还停在刚点的那个键上。
     若实现是「重铺整排按钮」，那个键会被换掉，焦点掉回 body —— 这条会红。 */
  await page.click('[data-action="pick-level"][data-level="L2"]');
  await page.waitForTimeout(250);
  const lv = await page.evaluate(readLevels);
  record(
    '④ 可访问性 —— 切换后焦点仍停在刚点的 L2 键上（未被重铺换掉）',
    lv.focused === 'L2',
    '焦点所在键=' + JSON.stringify(lv.focused) +
      '｜三键 aria-pressed=' +
      JSON.stringify(lv.buttons.map((b) => b.level + ':' + b.pressed))
  );

  await browser.close();

  const bad = results.filter((r) => !r.ok).length;
  console.log('');
  console.log('----------------------------------------------------------------');
  console.log('汇总：' + (results.length - bad) + '/' + results.length +
    ' 通过 · 退出码 ' + (bad ? 1 : 0));
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error('验证脚本自身出错：' + err.message);
  process.exit(2);
});
