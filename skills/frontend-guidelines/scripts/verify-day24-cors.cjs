#!/usr/bin/env node
/* ===========================================================================
   Day 24 线上回归脚本 —— 跨域（CORS）白名单有没有漏掉发布站点域名
   ---------------------------------------------------------------------------
   为什么要它：Day 24 复现的一个真实 Bug ——

     现象：从发布站点打开检查台，②③④ 区全显示「网络连不上」，F12 控制台一堆跨域红字。
     真相：**HTTP 网关的跨域白名单里没有发布站点域名** ——
           白名单内的来源，网关会自动补 access-control-allow-origin；
           白名单外的来源，一张跨域头都不给，浏览器在**预检阶段**就判不通过，
           fetch 直接 reject ⇒ 界面只能报「网络连不上」，连那个 405 都看不到。

   ⚠️ 为什么这个 Bug 特别阴 —— 它**骗过了所有 curl 测试**：
      curl 不发预检、也不校验 CORS 头，所以从 Day 17 到今天，所有 curl 命令全是通的。
      「接口坏了」和「跨域被拦」是两码事，靠 curl 永远分不出来。
      ⇒ 这个脚本只认「真实来源头 + 真实响应头」，不认源码、不认界面文字、更不认 curl 的 200。

   跑法（cmd 里，先切到仓库根目录；<仓库路径> 换成你自己的）：
     cd /d <仓库路径>
     node skills\frontend-guidelines\scripts\verify-day24-cors.cjs

   ⚠️ 别在别的目录直接敲 `node verify-day24-cors.cjs` —— 会报 Cannot find module（Day 23 踩过）。
      懒得分两步就给完整路径：
     node <仓库路径>\skills\frontend-guidelines\scripts\verify-day24-cors.cjs

   可覆盖的地址（默认就是线上那套）：
     ECHOREAD_API   接口基地址
     ECHOREAD_SITE  发布站点来源（要验的那个域名）

   退出码：全部通过 = 0；有 FAIL = 1（方便以后接进流水线）

   ✅ 这个脚本自带「反向验证」（防橡皮章）—— 而且是最硬的那种：
      **在 Bug 修好之前，【第 1 组】必然是 FAIL 的。**
      换句话说，现在这次运行本身就是"它会抓"的证明 ——
        · 改前跑：第 1 组 3 条 FAIL（发布站点拿不到跨域头）→ 退出码 1
        · 控制台把域名加进白名单后再跑：全 PASS → 退出码 0
      「改前红、改后绿」这个差值，就是修复生效的铁证。

   ⚠️ 本脚本【只读】：不写库、不造数据、不需要清理（跟 Day 23 那个不同）。
   =========================================================================== */

'use strict';

const BASE =
  process.env.ECHOREAD_API ||
  'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';

/* 本次要验的「嫌疑域名」—— 发布站点。改域名时改这里或给 ECHOREAD_SITE。
   ⚠️ 这里【必须】带协议，因为它要被塞进 Origin 请求头（Origin 的规范形态就是 scheme://host）。 */
const SITE = process.env.ECHOREAD_SITE || 'https://echoread.app.workbuddy.host';

/* ⚠️ 但填进控制台白名单时【不能】带协议 —— 官方示例与 CLI 文档都明确"不含 http:// 或 https:// 前缀"：
     · 支持完整域名（如 www.example.com）
     · 支持通配符（如 *.example.com）
     · 支持端口号（如 example.com:8080）
   存的是裸域名，网关匹配时按 host 比对、回显时才补回完整 Origin（实测：列表里存的 localhost
   对应 http://localhost:8000 被放行，且回显的就是带协议带端口的完整 Origin）。
   ⇒ 这两个形态别搞混：**头里带协议，控制台里不带**。 */
const SITE_HOST = SITE.replace(/^https?:\/\//, '');

/* 已知在白名单里、必须【继续】放行的两个来源（对照组）。
   ⚠️ 为什么要有对照组：如果只测嫌疑域名，一旦脚本本身写错（比如 Origin 头没发出去），
      得到的结果也是"无跨域头"，你会误判成"白名单果然漏了"。
      有了对照组，"本地这个有头、发布站点没头"才说明差异出在**来源**上，不是脚本坏了。 */
const KNOWN_OK = [
  { label: '本地开发源 localhost:8000', origin: 'http://localhost:8000' },
  {
    label: '控制台内置域名 tcloudbaseapp.com',
    origin: 'https://echoread-d0g1b2ez6a369d11e-1502538433.tcloudbaseapp.com',
  },
];

/* 白名单外的无关域名 —— 用来证明「白名单没被改松」。 */
const OUTSIDER = 'https://evil.example.com';

const results = [];

function rep(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
  if (detail) console.log(`           ${detail}`);
}

/* 发一个带指定 Origin 的请求，把关心的跨域头原样取回来。
   ⚠️ 用原生 fetch（Node 18+ 自带），不引任何依赖 —— 跟项目其他脚本一致。
      Origin 在浏览器里是"禁改头"，但 Node 的 fetch 允许手动设，正好用它来冒充来源。 */
async function probe(method, path, origin, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});
  if (origin) headers['Origin'] = origin;

  const res = await fetch(BASE + path, { method, headers });

  /* 204/405 这类可能是空 body，读不出来就当 null，别让它把脚本炸了 */
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* 非 JSON 响应（如 204 预检、502 网关页），保持 null */
  }

  return {
    status: res.status,
    acao: res.headers.get('access-control-allow-origin'), // 放行与否，看这一个头
    vary: res.headers.get('vary'),
    acMethods: res.headers.get('access-control-allow-methods'),
    acHeaders: res.headers.get('access-control-allow-headers'),
    creds: res.headers.get('access-control-allow-credentials'),
    json: json,
  };
}

/* 判断"这个来源有没有被放行"。
   ⚠️ 关键：不只看"有没有头"，还要看**头里回的是不是它自己** ——
      回 `*` 也算不合格（本项目允许携带凭据，`*` ＋ 凭据是无效组合，等于没放行）。 */
function allowed(r, origin) {
  if (!r.acao) return '没有 access-control-allow-origin（网关没认这个来源）';
  if (r.acao === '*') return '回的是通配符 *（本项目带凭据，* 无效，等于没放行）';
  if (r.acao !== origin) return `回的是「${r.acao}」，不是请求的来源「${origin}」`;
  return null;
}

async function main() {
  console.log('');
  console.log('============================================================');
  console.log(' Day 24 线上回归：跨域（CORS）白名单');
  console.log(' 接口：' + BASE);
  console.log(' 嫌疑来源：' + SITE);
  console.log(' 时间：' + new Date().toLocaleString('zh-CN'));
  console.log('============================================================');
  console.log(' ⚠️ 第 1 组在当前（未修）状态下【应当 FAIL】—— 那正是它有用的证据。');

  /* ---------- 第 1 组：今天的靶子 —— 发布站点来源必须被放行 ---------- */
  console.log('\n【第 1 组】发布站点来源（修好之前这里必然是 FAIL）');

  let r = await probe('GET', '/api/health', SITE);
  let bad = allowed(r, SITE);
  rep(
    'GET /api/health 带发布站点 Origin（② 区那条路）',
    bad === null,
    bad ? bad + ` ｜ HTTP ${r.status} ｜ vary=${JSON.stringify(r.vary)}` : `acao=${r.acao}，vary=${r.vary}`
  );

  /* 写入是带 JSON 的 POST，浏览器会先发预检；预检不过，写这条路必死。
     白名单内：网关自己答 204；白名单外：网关把 OPTIONS 透传给云函数 → 撞 405。 */
  r = await probe('OPTIONS', '/api/words', SITE, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  });
  bad = allowed(r, SITE);
  const preOk = bad === null && r.status === 204 && (r.acMethods || '').toUpperCase().includes('POST');
  rep(
    'OPTIONS /api/words 预检（③ 区写入那条路）→ 应 204 且放行 POST',
    preOk,
    bad
      ? bad + ` ｜ 实际 HTTP ${r.status}（405 = 被透传给了云函数）`
      : `HTTP ${r.status}，allow-methods=${JSON.stringify(r.acMethods)}` +
        (preOk ? '' : ' ← 状态或方法不对')
  );

  r = await probe('GET', '/api/words', SITE);
  bad = allowed(r, SITE);
  const readOk = bad === null && r.status === 200 && r.json && Array.isArray(r.json.words);
  rep(
    'GET /api/words 带发布站点 Origin（读真数据）',
    readOk,
    bad
      ? bad
      : `HTTP ${r.status}，${r.json && r.json.words ? r.json.words.length + ' 行' : 'body 不是预期的 {words:[…]}'}`
  );

  /* ---------- 第 2 组：对照组 —— 已知放行的来源不许被误伤 ---------- */
  console.log('\n【第 2 组】对照组：白名单内的来源必须继续放行（防"修一个坏一个"）');

  for (const k of KNOWN_OK) {
    const rr = await probe('GET', '/api/health', k.origin);
    const b = allowed(rr, k.origin);
    rep(
      `GET /api/health ｜ ${k.label}`,
      b === null,
      b ? b : `acao=${rr.acao}，vary=${rr.vary}，creds=${JSON.stringify(rr.creds)}`
    );
  }

  /* ---------- 第 3 组：反向 —— 白名单不许被改松 ---------- */
  console.log('\n【第 3 组】反向：白名单外的域名【必须仍然拿不到跨域头】');

  r = await probe('GET', '/api/health', OUTSIDER);
  rep(
    `GET /api/health ｜ 白名单外 ${OUTSIDER} 应被拒`,
    r.acao === null,
    r.acao === null
      ? '确认无 access-control-allow-origin（正确：闸门没被拆）'
      : `⚠️ 居然放行了：acao=${r.acao} —— 说明白名单被改松了，比原 Bug 更严重`
  );

  /* ---------- 第 4 组：基准 —— 接口本体活着吗（把"跨域"和"接口坏了"分开） ---------- */
  console.log('\n【第 4 组】基准：不带 Origin，确认接口本体是活的（别把两件事混一起）');

  r = await probe('GET', '/api/health', null);
  const alive = r.status === 200 && r.json && r.json.ok === true && r.json.service === 'echoread';
  rep(
    'GET /api/health（无 Origin）→ 200 {ok:true, service:"echoread"}',
    alive,
    alive ? '接口本体正常 ⇒ 出问题就只在跨域这一层' : `HTTP ${r.status}，${JSON.stringify(r.json)}`
  );

  r = await probe('GET', '/api/words', 'http://localhost:8000');
  const dataOk = r.status === 200 && r.json && Array.isArray(r.json.words);
  rep(
    'GET /api/words（本地来源）→ 200 且返回 {words:[…]}',
    dataOk,
    dataOk ? `当前 ${r.json.words.length} 行` : `HTTP ${r.status}，${JSON.stringify(r.json).slice(0, 120)}`
  );

  /* ---------- 汇总 ---------- */
  const fails = results.filter((x) => !x.pass);
  console.log('\n============================================================');
  console.log(` 汇总：${results.length - fails.length} PASS / ${fails.length} FAIL`);
  console.log('============================================================');
  if (fails.length) {
    console.log(' 未过的项：');
    fails.forEach((f) => console.log('  - ' + f.name + ' :: ' + f.detail));
    /* 只在"第 1 组那些项"失败时给出这条提示，避免误导别的故障 */
    if (fails.some((f) => /发布站点/.test(f.name))) {
      console.log('');
      console.log(' 提示：若上面 FAIL 的全是「发布站点」相关项，而第 2 组对照全 PASS，');
      console.log('       那就是跨域白名单漏了这个域名 —— 控制台「环境配置 → 安全来源 → 安全域名」');
      console.log('       点【添加域名】，填这个（⚠️ 裸域名，不要带 http:// 或 https://）：');
      console.log('         ' + SITE_HOST);
      console.log('       约 1–2 分钟生效，然后重跑本脚本应变成全 PASS。');
      console.log('       （不用改任何代码；零代码改动的 Bug，别在云函数里硬塞 CORS 头。）');
    }
  }
  console.log('');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[X] 脚本本身出错（不是接口的锅）：', e && e.message ? e.message : e);
  console.error('    排查方向：本机能否访问 ' + BASE);
  process.exit(1);
});
