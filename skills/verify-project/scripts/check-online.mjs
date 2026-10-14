#!/usr/bin/env node
/* ===========================================================================
   check-online.mjs —— 发布前检查 · 联网部分（打真实接口 / 真实站点）
   ---------------------------------------------------------------------------
   查什么（编号与 SKILL.md、check-offline.mjs 对齐）：
     C 组 · 跨域（CORS）        C1 ~ C6   ← Day 27 换判据：改判「同源代理」这条真实链路
     D 组 · 接口契约（冻结）    D1 ~ D6
     E 组 · 数据安全（写入类）  E1 ~ E2   ← 默认不跑，要加 --write
     F 组 · 线上可达            F1 ~ F3

   跑法：
     node <仓库路径>\skills\verify-project\scripts\check-online.mjs
     node <仓库路径>\skills\verify-project\scripts\check-online.mjs --write   （启用写入类检查）

   可覆盖的地址：
     ECHOREAD_API    接口基地址（默认线上那套 ap-shanghai）
     ECHOREAD_SITE   发布站点来源（默认 https://echoread.app.workbuddy.host）

   ⚠️⚠️ Day 27 为什么把 C 组的判据整个换掉（原判据的历史与证据见 CORS_FIX.md，那份文档没删）：
      旧 C1/C2 断言的是「网关给不给发布站点这个来源回跨域头」。Day 27 提交 `274a07f` 之后，
      **前端已经不直连云函数了** —— 发布服务器新增 `/api/**` 反向代理（转发时摘掉 `Origin` 头，
      网关就是拿它比对白名单的），页面改调**相对路径** `/api/**` ⇒ 浏览器眼里全站同源，
      **压根不产生跨域请求**。
      ⇒ 再拿"网关给不给发布站跨域头"当判据，就是**永远报红的假警报**：
        线上明明好用，脚本偏说坏 —— 这种**假红比假绿更伤**，下次真出问题就没人信它了。
      ⇒ 新判据 = **直接测用户实际走的那条路**：从发布站域名访问 `/api/**` 必须通（C1~C3）；
        外加一条**防回退**（C4）：前端源码里不许再出现云函数完整域名 —— 谁写回去，跨域立刻复发。

   ⚠️ 默认【只读】：所有请求都是"必然会被拒"或"查无此 id"的那种，不写库、不造数据。
      要验写入路径（软删可逆 / 同 id 不双写），加 --write —— 脚本自己负责清理。
      （Day 23 那条教训：为了凑证据去污染线上库，是制造现场，不是验证。）

   ⚠️ 关于 D4 / D6：这两个是「源码 ≠ 线上生效」的探测器。
      长度校验（MAX_LEN）是 Day 23 才加的，**旧版云函数没有**。
      所以用「一个不存在的 id + 越界长度」去 PATCH：
        · 新版 → 先校验长度 → 400 invalid_field
        · 旧版 → 没有长度校验 → 走到查库 → 404 word_not_found
      ⇒ 两种版本答案不同，且**两边都不会碰库**（id 不存在，改不到任何一行）。

   退出码：0 = 执行到的项全过；1 = 有 FAIL。
   =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReport } from './lib/report.mjs';

const API = process.env.ECHOREAD_API ||
  'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';
const SITE = process.env.ECHOREAD_SITE || 'https://echoread.app.workbuddy.host';
const SITE_HOST = SITE.replace(/^https?:\/\//, '');
const WRITE = process.argv.includes('--write');

/* 项目根：脚本在 skills/verify-project/scripts/ 下，往上三层 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

const rep = createReport({
  title: '联网部分（真实接口 / 真实站点）',
  meta: [' 接口：' + API, ' 站点：' + SITE, ' 写入类检查：' + (WRITE ? '已启用（--write）' : '未启用（默认只读）')],
  notes: [
    'curl 通了不等于浏览器通了 —— 跨域问题只有真实来源头才能暴露。',
    'C 组（Day 27 起）判的是【同源代理】这条真实链路：从发布站域名访问 /api/** 必须通；',
    '不再判"网关给不给发布站回跨域头"—— 那条路已经不用了，继续断言它只会永远报假红。'
  ]
});

/* ---------- 网络小工具 ---------- */

async function call(method, pathname, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.origin) headers['Origin'] = opts.origin;
  const init = { method: method, headers: headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(pathname.slice(0, 4) === 'http' ? pathname : (opts.base || API) + pathname, init);
    let json = null;
    try { json = await res.json(); } catch (e) { /* 204 / 405 / HTML 等非 JSON，保持 null */ }
    return { status: res.status, json: json, headers: res.headers };
  } catch (e) {
    return { status: 0, json: null, headers: new Headers(), netError: (e && e.message) || String(e) };
  }
}

/* ⚠️ Day 27：原 notAllowed() 已随 C 组换判据一并删掉 ——
   它判的是"这个来源有没有被网关放行"，而前端已改走同源代理、不再需要那条放行。
   原实现可用 `git show 274a07f^:skills/verify-project/scripts/check-online.mjs` 找回。 */

function isErr(r, status, code) {
  if (r.netError) return '请求发不出去：' + r.netError;
  if (r.status !== status) return '期望 HTTP ' + status + '，实际 ' + r.status;
  if (!r.json || r.json.error !== code) return '期望 error=' + code + '，实际 ' + (r.json && r.json.error);
  if (!r.json.message) return '缺中文提示 message';
  return null;
}

function detailOf(r) {
  if (r.netError) return r.netError;
  return 'HTTP ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 140);
}

const NOID = 'w-vp-nope-' + Date.now();   /* 一定不存在的 id，用来做"不写库"的探测 */

/* ===========================================================================
   C 组 · 跨域（CORS）—— Day 27 起判「同源代理」这条真实链路
   ---------------------------------------------------------------------------
   判据为什么换（完整背景见文件头注释 + 根目录 CORS_FIX.md）：
     `274a07f` 之后前端不再直连云函数 —— 发布服务器加 `/api/**` 反向代理
     （转发时摘掉 `Origin` 头），页面改调相对路径 ⇒ 浏览器眼里全站同源。
     ⇒ 旧判据（"网关给不给发布站回跨域头"）会**永远报红**：线上好用，脚本说坏。
     ⇒ 新判据直接测**用户实际走的那条路**，并加一条防回退。
   =========================================================================== */
rep.section('C 组 · 跨域（CORS）—— 发布站域名走 /api/** 必须通（同源代理）');

const OUTSIDER = 'https://evil.example.com';

/* ---- C1 同源【读】路径通（用户实际走的就是这条路）---- */
let r = await call('GET', SITE + '/api/health', {});
const c1ok = r.status === 200 && r.json && r.json.ok === true && r.json.service === 'echoread';
rep.check('C1', '同源读路径通：' + SITE_HOST + '/api/health 必须 200',
  c1ok,
  c1ok ? '200 {ok:true, service:"echoread"}（发布服务器代理到了云函数）'
    : detailOf(r) + (r.status === 404
        ? '（← 404 = 发布服务器上没有 /api 这一段，查 dev-server.js 的 proxyToApi 及其调用处）' : ''));

/* ---- C2 同源【写】路径能穿到后端（用不存在的 id，绝不写库）----
   为什么用"不存在的 id + DELETE"：错误码是云函数回的 ⇒ 证明写请求真的穿过了代理；
   而 id 不存在 ⇒ 无论代理通不通都改不到任何一行数据。 */
r = await call('DELETE', SITE + '/api/words?id=' + encodeURIComponent(NOID), {});
const c2 = isErr(r, 404, 'word_not_found');
rep.check('C2', '同源写路径通：DELETE /api/words 由云函数回 404（写请求真的穿过了代理）',
  c2 === null,
  c2 === null
    ? '404 word_not_found —— 这个短码与中文提示是云函数回的，说明写请求穿过了代理（未碰任何数据）'
    : c2 + ' ｜ ' + detailOf(r));

/* ---- C3 同源能读到真实数据 ---- */
r = await call('GET', SITE + '/api/words', {});
const c3ok = r.status === 200 && r.json && Array.isArray(r.json.words);
rep.check('C3', '同源读到真实数据：' + SITE_HOST + '/api/words 返回 {words:[…]}',
  c3ok,
  c3ok ? '当前 ' + r.json.words.length + ' 行' : detailOf(r));

/* ---- C4 防回退：前端源码里不许写死云函数完整域名 ----
   为什么这条最要紧：同源代理是靠"页面只调相对路径"撑起来的。
   谁要是把完整域名写回前端，跨域立刻复发 —— 而且**线上可能好几天没人发现**（页面能开、数据空）。
   只扫前端（根目录 *.html + assets/js/*.js）。
   ⚠️ dev-server.js / cloudfunctions/ 里出现这个域名是**对的**（后端才该知道上游地址），不要扫它们。 */
const FE_DOMAIN = 'tcloudbase.com';
const feHits = [];
try {
  const jsDir = path.join(ROOT, 'assets', 'js');
  const feFiles = fs.readdirSync(ROOT).filter(function (f) { return f.endsWith('.html'); })
    .concat(fs.existsSync(jsDir)
      ? fs.readdirSync(jsDir).filter(function (f) { return f.endsWith('.js'); })
          .map(function (f) { return path.join('assets', 'js', f); })
      : []);
  for (const rel of feFiles) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (txt.indexOf(FE_DOMAIN) >= 0) feHits.push(rel);
  }
} catch (e) {
  feHits.push('（扫描出错：' + ((e && e.message) || e) + '）');
}
rep.check('C4', '防回退：前端源码里不得写死云函数域名（写回去 = 跨域复发）',
  feHits.length === 0,
  feHits.length === 0
    ? '扫描 ' + '(根目录 *.html + assets/js/*.js) 全部干净 —— 页面只调相对路径 /api/**'
    : '⚠️ 这些前端文件里出现了 ' + FE_DOMAIN + '：' + feHits.join(' / ') + ' —— 请改回相对路径 /api/**');

/* ---- C5 云函数直连本体活着（把"代理坏了"和"云函数坏了"分开）---- */
r = await call('GET', '/api/health', {});
const alive = r.status === 200 && r.json && r.json.ok === true && r.json.service === 'echoread';
rep.check('C5', '云函数直连本体活着（不带 Origin；C1 红而 C5 绿 = 问题在代理，不在接口）',
  alive,
  alive ? '200 {ok:true, service:"echoread"}' : detailOf(r));

/* ---- C6 纵深防御：白名单没被改松 ----
   这条已**不再**决定应用可用性（前端不走白名单了），但它守的是"网关配置有没有被拆"，
   仍是值得留的一道岗：真的被改松，是比原 Bug 更严重的安全问题。 */
r = await call('GET', '/api/health', { origin: OUTSIDER });
const acaoOut = r.netError ? '(请求失败)' : r.headers.get('access-control-allow-origin');
rep.check('C6', '纵深防御：白名单外的来源直连云函数【必须仍拿不到】跨域头（防白名单被改松）',
  acaoOut === null,
  acaoOut === null ? '确认无 access-control-allow-origin（闸门没被拆）'
    : '⚠️ 居然放行了：acao=' + acaoOut + ' —— 白名单被改松了，比原 Bug 更严重');

/* ===========================================================================
   D 组 · 接口契约（冻结：路径 / 字段名 / 错误码都不许动）
   =========================================================================== */
rep.section('D 组 · 接口契约（冻结）');

r = await call('GET', '/api/health', {});
rep.check('D1', 'GET /api/health 返回约定结构',
  r.status === 200 && r.json && r.json.ok === true && r.json.service === 'echoread',
  detailOf(r));

r = await call('GET', '/api/words', { origin: 'http://localhost:8000' });
rep.check('D2', 'GET /api/words 返回 {words:[…]}',
  r.status === 200 && r.json && Array.isArray(r.json.words),
  r.status === 200 && r.json && Array.isArray(r.json.words)
    ? '当前 ' + r.json.words.length + ' 行' : detailOf(r));

/* ---- D3 五个错误短码齐全（契约文档里写着 + 线上实测都在） ----
   全是"必然被拒"的请求，不写库。 */
const codeCases = [
  ['missing_field',      () => call('POST', '/api/words', { body: { id: 'w-vp-probe-only-id' } })],
  ['invalid_field',      () => call('POST', '/api/words', { body: { id: 'w-vp-probe-toolong', title: 'a'.repeat(100), desc: 'x' } })],
  ['word_not_found',     () => call('DELETE', '/api/words?id=' + encodeURIComponent(NOID), {})],
  ['not_found',          () => call('GET', '/api/nope', {})],
  ['method_not_allowed', () => call('PUT', '/api/words', {})]
];
const codeBad = [];
const codeSeen = [];
/* 文档那一半：五个短码必须仍写在 api-contract.md 里（契约冻结，别被人从契约里删掉）。 */
const contractPath = path.join(ROOT, 'api-contract.md');
let docMissing = [];
if (!fs.existsSync(contractPath)) {
  docMissing = ['api-contract.md 读不到'];
} else {
  const doc = fs.readFileSync(contractPath, 'utf8');
  docMissing = codeCases.map(function (c) { return c[0]; })
    .filter(function (c) { return doc.indexOf(c) < 0; });
}
for (const [code, fn] of codeCases) {
  const rr = await fn();
  const want = code === 'missing_field' || code === 'invalid_field' ? 400
    : code === 'word_not_found' || code === 'not_found' ? 404 : 405;
  const e = isErr(rr, want, code);
  if (e) codeBad.push(code + '（' + e + '）'); else codeSeen.push(code);
}
rep.check('D3', '五个错误短码齐全（契约文档 + 线上实测）+ 都带中文提示',
  codeBad.length === 0 && docMissing.length === 0,
  (codeBad.length === 0 ? '线上实测通过：' + codeSeen.join(' / ') : '线上未过：' + codeBad.join(' ｜ ')) +
  (docMissing.length === 0 ? ' ｜ 契约文档里五个短码都在' : ' ｜ ⚠️ 契约文档缺：' + docMissing.join(' ')));

/* ---- D4 边界值不误伤（长度校验放行 → 走到"查无此 id"） ----
   全部走**不存在的 id**，所以既验了校验逻辑，又不会碰到任何真实数据。 */
const inBounds = [
  ['tag 32',   { tag: 'a'.repeat(32) }],
  ['title 64', { title: 'a'.repeat(64) }],
  ['desc 500', { desc: 'a'.repeat(500) }]
];
const d4bad = [];
for (const [label, body] of inBounds) {
  const rr = await call('PATCH', '/api/words?id=' + encodeURIComponent(NOID), { body: body });
  if (rr.status !== 404 || !rr.json || rr.json.error !== 'word_not_found') {
    d4bad.push(label + ' → 期望 404 word_not_found（说明校验放行），实际 ' + detailOf(rr));
  }
}
rep.check('D4', '长度边界内必须放行、别把好人一起拦了（tag32 / title64 / desc500）',
  d4bad.length === 0,
  d4bad.length === 0 ? '三个边界值都合法通过（走到了"查无此 id"）' : d4bad.join(' ｜ '));

/* ---- D5 路径式写法不认（Day 23 踩过：id 走查询参数） ---- */
r = await call('PATCH', '/api/words/' + encodeURIComponent(NOID), { body: { title: 'x' } });
const d5 = isErr(r, 404, 'not_found');
rep.check('D5', '路径式 /api/words/{id} 不支持（id 必须走查询参数）',
  d5 === null,
  d5 === null ? '路径式回 404 not_found，与契约一致' : d5 + ' ｜ ' + detailOf(r));

/* ---- D6 边界外必须拦截 = 线上跑的就是本地这份含长度校验的代码 ----
   ⚠️ 这条同时是「源码 ≠ 线上生效」的探测器（Day 23 真逮到过：代码提交了、
      云函数没重新部署、线上照样放行超长字段）。 */
const outBounds = [
  ['tag 33',   { tag: 'a'.repeat(33) }],
  ['title 65', { title: 'a'.repeat(65) }],
  ['desc 501', { desc: 'a'.repeat(501) }]
];
const d6bad = [];
for (const [label, body] of outBounds) {
  const rr = await call('PATCH', '/api/words?id=' + encodeURIComponent(NOID), { body: body });
  const e = isErr(rr, 400, 'invalid_field');
  if (e) d6bad.push(label + ' → 期望 400 invalid_field，实际 ' + detailOf(rr) +
    (rr.status === 404 ? '（← 404 说明线上还是没长度校验的旧版本，代码没部署上去）' : ''));
}
rep.check('D6', '线上已部署含长度校验的版本（边界外必须 400）',
  d6bad.length === 0,
  d6bad.length === 0 ? 'tag33 / title65 / desc501 全部 400 invalid_field —— 线上 = 本地这份代码'
    : d6bad.join(' ｜ '));

/* ===========================================================================
   E 组 · 数据安全（写入类 —— 默认不跑，--write 才开）
   =========================================================================== */
rep.section('E 组 · 数据安全（写入类，需 --write）');

const PID = 'w-vp-write-' + Date.now();
if (!WRITE) {
  rep.skip('E1', '软删可逆（删完列表看不见、但数据还在、能复活）', '默认只读模式未启用写入检查，加 --write 才跑');
  rep.skip('E2', '同一个 id 重复写入不会悄悄变成两条', '默认只读模式未启用写入检查，加 --write 才跑');
} else {
  /* 先记基线，跑完要能回到原样 */
  let base = await call('GET', '/api/words', { origin: 'http://localhost:8000' });
  const baseIds = (base.json && base.json.words) ? base.json.words.map(function (w) { return w.id; }) : [];

  async function listIds() {
    const x = await call('GET', '/api/words', { origin: 'http://localhost:8000' });
    return (x.json && x.json.words) ? x.json.words.map(function (w) { return w.id; }) : null;
  }
  function countOf(ids, id) { return ids ? ids.filter(function (v) { return v === id; }).length : -1; }

  const log = [];
  try {
    /* 1) 建一条探针行 */
    let rr = await call('POST', '/api/words', { origin: 'http://localhost:8000',
      body: { id: PID, title: '发布前检查探针', desc: '脚本自动清理', tag: 'VP' } });
    log.push('建行 → HTTP ' + rr.status);
    let ids = await listIds();
    const afterCreate = countOf(ids, PID);

    /* 2) 同 id 再写一次：必须是 409（真重复），不能悄悄多出一条 */
    rr = await call('POST', '/api/words', { origin: 'http://localhost:8000',
      body: { id: PID, title: '重复写入', desc: '不该变成两条', tag: 'VP' } });
    ids = await listIds();
    const afterDup = countOf(ids, PID);
    log.push('重复写 → HTTP ' + rr.status + '，列表里该 id 出现 ' + afterDup + ' 次');
    rep.check('E2', '同一个 id 重复写入不会悄悄变成两条',
      afterCreate === 1 && afterDup === 1 && rr.status === 409,
      '首次写入后 ' + afterCreate + ' 条；重复写入 → HTTP ' + rr.status +
      '（期望 409 duplicate_id），之后仍是 ' + afterDup + ' 条');

    /* 3) 软删 → 列表里应看不见 */
    const del = await call('DELETE', '/api/words?id=' + encodeURIComponent(PID), { origin: 'http://localhost:8000' });
    ids = await listIds();
    const afterDel = countOf(ids, PID);
    /* 4) 复活 → 应该回来，且只有一条 */
    const back = await call('POST', '/api/words', { origin: 'http://localhost:8000',
      body: { id: PID, title: '复活测试', desc: '复活后应只有一条', tag: 'VP' } });
    ids = await listIds();
    const afterBack = countOf(ids, PID);
    log.push('删除 → HTTP ' + del.status + '，列表出现 ' + afterDel + ' 次；复活 → HTTP ' + back.status + '，出现 ' + afterBack + ' 次');
    rep.check('E1', '软删可逆（删完列表看不见、但数据还在、能复活）',
      del.status === 200 && afterDel === 0 && back.status >= 200 && back.status < 300 && afterBack === 1,
      '删除 → HTTP ' + del.status + '（期望 200）；删后列表出现 ' + afterDel + ' 次（期望 0）；' +
      '重新写入 → HTTP ' + back.status + '（期望 2xx）；回来 ' + afterBack + ' 条（期望 1）');
  } catch (e) {
    rep.check('E1', '软删可逆（删完列表看不见、但数据还在、能复活）', false, '脚本出错：' + (e && e.message));
    rep.check('E2', '同一个 id 重复写入不会悄悄变成两条', false, '脚本出错：' + (e && e.message));
  } finally {
    /* 清理：无论成败都要把探针行收掉 */
    const cl = await call('DELETE', '/api/words?id=' + encodeURIComponent(PID), { origin: 'http://localhost:8000' });
    const finalIds = await listIds();
    const left = countOf(finalIds, PID);
    const okBase = finalIds && baseIds.length === finalIds.length;
    console.log('  [清理] ' + log.join(' ｜ '));
    console.log('  [清理] 收尾删除探针行 → HTTP ' + cl.status + '；该 id 现在出现 ' + left + ' 次；' +
      '库容 ' + (finalIds ? finalIds.length : '?') + '（基线 ' + baseIds.length + '）' +
      (okBase ? ' ✅ 已回到基线' : ' ⚠️ 与基线不一致，请人工核对：' + (finalIds || []).join(' / ')));
  }
}

/* ===========================================================================
   F 组 · 线上可达
   =========================================================================== */
rep.section('F 组 · 线上可达（发布站点）');

const PAGES = ['/', '/reader.html', '/vocab.html', '/writing.html'];
const pageBad = [];
const pageOk = [];
for (const p of PAGES) {
  const rr = await call('GET', SITE + p, {});
  if (rr.status === 200) pageOk.push(p); else pageBad.push(p + ' → HTTP ' + (rr.netError || rr.status));
}
rep.check('F1', '四个页面在发布站点上都能打开（200）',
  pageBad.length === 0,
  pageBad.length === 0 ? pageOk.join(' ') + ' 全部 200' : pageBad.join(' ｜ '));

r = await call('GET', SITE + '/assets/audio/oh-im-really-sorry.mp3', { headers: { Range: 'bytes=1000-1999' } });
const rangeOk = r.status === 206 && r.headers.get('content-range');
rep.check('F2', '音频支持分段请求（Range → 206，跳播的前提）',
  !!rangeOk,
  rangeOk ? 'HTTP 206，Content-Range=' + r.headers.get('content-range')
    : 'HTTP ' + (r.netError || r.status) + '（若是 200，说明服务器的 Range 支持没了，跳播一定坏）');

const SECRET_URLS = ['/RUN.md', '/.env', '/cloudfunctions/echoread-api/index.js'];
const leaky = [];
for (const p of SECRET_URLS) {
  const rr = await call('GET', SITE + p, {});
  if (rr.status === 200) leaky.push(p);
}
rep.check('F3', '线上拿不到内部文档 / .env / 后端源码（都应非 200）',
  leaky.length === 0,
  leaky.length === 0 ? 'RUN.md / .env / cloudfunctions 全部被挡（非 200）'
    : '⚠️ 公网能直接下到：' + leaky.join(' / '));

/* ---------- 汇总与收尾提示 ---------- */
rep.print();

const st = rep.stats;
if (st.fail > 0 && !WRITE) {
  console.log(' 提示：C 组红了照这个顺序看 ——');
  console.log('   C1 红（同源 /api/health 不是 200）→ 发布服务器上没有 /api 代理段：');
  console.log('        查 dev-server.js 的 proxyToApi() 与那个 if (…startsWith(\'/api/\')) 分支。');
  console.log('   C2 红而 C1 绿 → 读能过、写过不去：看代理有没有把方法/请求体透传（req.pipe(upstream)）。');
  console.log('   C5 也红 → 是云函数本身的问题（部署 / 路由 / 环境变量），不是代理的锅。');
  console.log('   C4 红 → 有前端文件把云函数完整域名写回去了，改回相对路径 /api/**。');
  console.log('   C6 红 → 网关白名单被改松了，属安全问题，优先处理。');
  console.log('   ⚠️ 别再按「控制台加安全域名」那条路去修 —— 免费体验版加不了；');
  console.log('      Day 27 已改走同源代理。历史决策与实测证据见根目录 CORS_FIX.md。');
  console.log('');
}
process.exit(rep.exitCode());
