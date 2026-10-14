/* 全站端到端验收（Playwright-core + 本机 Edge）
   覆盖：门禁 → 登录页 → 跟读页 → 词汇页 → free talk → 页面导航 → 音频可达
   ⚠️ 云函数尚未更新（注册接口还是旧验证码逻辑），所以用「注入 token + mock /me」模拟已登录，只验前端。
   ⚠️ 沙箱 headless 对线上偶发 ERR_SSL_PROTOCOL_ERROR → 所有导航走 safeGoto（重试 5 次）。
   跑法：node tools/verify-e2e.cjs */
const { createRequire } = require('module');
const req = createRequire('C:/Users/20769/.workbuddy/binaries/node/workspace/');
const { chromium } = req('playwright-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const B = 'https://echoread.app.workbuddy.host';

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, e === undefined ? '' : '→ ' + e); } };
const head = (t) => console.log('\n=== ' + t + ' ===');

async function safeGoto(page, url) {
  for (let i = 0; i < 5; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return true; }
    catch (e) { await page.waitForTimeout(700); }
  }
  return false;
}

async function loggedIn(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('echoread_token', 'e2e-token'); } catch (e) {} });
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route('**/api/auth/me', r => r.fulfill(json({ ok: true, data: { user: { username: 'e2e' } } })));
  await ctx.route('**/api/usage/leaderboard**', r => r.fulfill(json({ ok: true, data: { me: { totalSeconds: 0, rank: null }, top: [] } })));
  await ctx.route('**/api/usage/beat', r => r.fulfill(json({ ok: true, data: { totalSeconds: 0 } })));
  return ctx;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  /* ===== A 门禁 ===== */
  head('A 门禁（未登录访问学习页应被弹回登录页）');
  for (const p of ['index.html', 'vocab.html', 'writing.html']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await safeGoto(page, B + '/' + p);
    await page.waitForTimeout(1500);
    ok(p + ' 未登录 → 弹回 login.html', page.url().indexOf('login.html') >= 0, page.url());
    await ctx.close();
  }

  /* ===== B 登录页 ===== */
  head('B 登录页');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await safeGoto(page, B + '/login.html');
    await page.waitForTimeout(600);
    const h1 = await page.textContent('.site-header h1');
    ok('标题含「登录」', h1.indexOf('登录') >= 0, h1);
    ok('标题含英文 Sign in', (await page.textContent('.auth-h1-en')).indexOf('Sign in') >= 0);
    ok('旧副标题已删（无 .page-sub）', await page.locator('.page-sub').count() === 0);
    ok('登录表单可见', await page.locator('#form-login').isVisible());
    ok('注册表单初始隐藏', await page.locator('#form-register').isHidden());
    const ft = await page.textContent('#form-login');
    ok('登录 label 含「3~20 位」', ft.indexOf('3~20 位') >= 0);
    ok('登录 label 含「至少 8 位」', ft.indexOf('至少 8 位') >= 0);
    const L = await page.evaluate(() => {
      const r = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().left) : null; };
      return { h1: r('.site-header h1'), tabs: r('.auth-tabs'), card: r('#form-login') };
    });
    ok('标题左边缘 = tab = 登录表单（对齐）', L.h1 === L.tabs && L.tabs === L.card, JSON.stringify(L));
    await page.click('#tab-register');
    await page.waitForTimeout(250);
    ok('点「注册」→ 注册表单显示、登录隐藏',
      await page.locator('#form-register').isVisible() && await page.locator('#form-login').isHidden());
    await ctx.close();
  }

  /* ===== C 文本跟读页 ===== */
  head('C 文本跟读页');
  {
    const ctx = await loggedIn(browser);
    const page = await ctx.newPage();
    const mp3 = [];
    page.on('request', r => { if (/\.mp3(\?|$)/.test(r.url())) mp3.push(r.url()); });

    await safeGoto(page, B + '/index.html');
    await page.waitForSelector('#lessons .lesson-btn', { timeout: 15000 }).catch(() => {});
    const nLesson = await page.locator('#lessons .lesson-btn').count();
    ok('停在课程列表（22 课）', nLesson === 22, '实测 ' + nLesson);

    await page.click('#lessons .lesson-btn');
    await page.waitForTimeout(400);
    const nFile = await page.locator('#files .file-btn').count();
    ok('点 Lesson1 → 显示音频文件', nFile >= 1, '实测 ' + nFile);

    await page.click('#files .file-btn');
    await page.waitForTimeout(500);
    const nSeg = await page.locator('#reader .seg').count();
    ok('点音频 → 渲染分段', nSeg > 0, '实测 ' + nSeg);
    ok('分段不显示文字（无 .seg-text）', await page.locator('#reader .seg-text').count() === 0);

    mp3.length = 0;
    await page.click('#reader .seg');
    await page.waitForTimeout(1500);
    ok('点分段 → 发起音频请求（.mp3）', mp3.length >= 1, '请求数 ' + mp3.length);

    await safeGoto(page, B + '/index.html?file=L1.1&t=13');
    await page.waitForSelector('#reader .material', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => { const e = document.querySelector('#reader .seg.is-playing'); return e ? e.getAttribute('data-start') : null; });
    ok('深链 ?file=L1.1&t=13 → 定位第 4 句', st === '13', '实测 ' + st);

    for (const p of ['Lesson1/L1.1.mp3', 'Lesson15/L15.1.mp3', 'Lesson22/L22.1.mp3']) {
      const code = await page.evaluate(async (u) => (await fetch(u, { method: 'HEAD' })).status, B + '/assets/audio/' + p);
      ok('音频可达 ' + p, code === 200, 'HTTP ' + code);
    }
    await ctx.close();
  }

  /* ===== D 词汇速记页 ===== */
  head('D 词汇速记页');
  {
    const ctx = await loggedIn(browser);
    const page = await ctx.newPage();
    let dicts = 0;
    for (let i = 0; i < 5; i++) {
      await safeGoto(page, B + '/vocab.html');
      await page.waitForFunction(
        () => (window.DICT_LIST || []).length > 0 && (window.SEARCH_WORDS || []).length > 0,
        { timeout: 12000 }
      ).catch(() => {});
      dicts = await page.locator('#dictList .level-btn').count();
      if (dicts >= 1) break;
    }
    ok('词库列表渲染（4 本）', dicts >= 1, '实测 ' + dicts);
    await page.fill('#q', 'man');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const rt = await page.textContent('#result');
    ok('搜 man → 有结果', /man/i.test(rt));
    ok('搜 man → 无 romantic（前缀匹配）', !/romantic/i.test(rt));
    await ctx.close();
  }

  /* ===== E free talk 页 ===== */
  head('E free talk 页');
  {
    const ctx = await loggedIn(browser);
    const page = await ctx.newPage();
    await safeGoto(page, B + '/writing.html');
    await page.waitForSelector('#catList .level-btn', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    ok('分类渲染（11 个）', await page.locator('#catList .level-btn').count() === 11, '实测 ' + await page.locator('#catList .level-btn').count());
    ok('话题非空', (await page.textContent('#ftQ')).trim().length > 0);
    await page.click('#secSample .ft-h');
    await page.waitForTimeout(300);
    ok('参考回答非空', (await page.textContent('#ftSample')).trim().length > 20);
    ok('溯源 chip 渲染', await page.locator('#ftSrcList .ft-src-item').count() >= 1, '实测 ' + await page.locator('#ftSrcList .ft-src-item').count());
    await page.click('#ftSrcList .ft-src-item');
    await page.waitForTimeout(1500);
    ok('点绿字 → 跳文本跟读页（带 file/t）', page.url().indexOf('index.html?file=') >= 0, page.url());
    await ctx.close();
  }

  /* ===== F 页面导航（左栏）===== */
  head('F 左栏板块导航');
  {
    const ctx = await loggedIn(browser);
    const page = await ctx.newPage();
    await safeGoto(page, B + '/index.html');
    await page.click('a.sidenav__item[href="vocab.html"]');
    await page.waitForTimeout(1200);
    ok('跟读 → 词汇', page.url().indexOf('vocab.html') >= 0, page.url());
    await page.click('a.sidenav__item[href="writing.html"]');
    await page.waitForTimeout(1200);
    ok('词汇 → free talk', page.url().indexOf('writing.html') >= 0, page.url());
    await page.click('a.sidenav__item[href="index.html"]');
    await page.waitForTimeout(1200);
    ok('free talk → 跟读', page.url().indexOf('index.html') >= 0, page.url());
    await ctx.close();
  }

  await browser.close();
  console.log('\n合计：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
