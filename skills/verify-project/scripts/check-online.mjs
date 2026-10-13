#!/usr/bin/env node
/* ===========================================================================
   check-online.mjs —— 发布前检查 · 联网部分（打真实接口 / 真实站点）
   ---------------------------------------------------------------------------
   查什么（编号与 SKILL.md、check-offline.mjs 对齐）：
     C 组 · 跨域（CORS）        C1 ~ C5
     D 组 · 接口契约（冻结）    D1 ~ D6
     E 组 · 数据安全（写入类）  E1 ~ E2   ← 默认不跑，要加 --write
     F 组 · 线上可达            F1 ~ F3

   跑法：
     node <仓库路径>\skills\verify-project\scripts\check-online.mjs
     node <仓库路径>\skills\verify-project\scripts\check-online.mjs --write   （启用写入类检查）

   可覆盖的地址：
     ECHOREAD_API    接口基地址（默认线上那套 ap-shanghai）
     ECHOREAD_SITE   发布站点来源（默认 https://echoread.app.workbuddy.host）

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
    'C 组在跨域白名单补上发布域名之前【必然是 FAIL】，那是它有用的证据，不是脚本坏了。'
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

/* 判断「这个来源有没有被放行」：
   不只看有没有头，还要看头里回的是不是**它自己** —— 回 `*` 也不算合格。 */
function notAllowed(r, origin) {
  if (r.netError) return '请求根本没发出去：' + r.netError;
  const acao = r.headers.get('access-control-allow-origin');
  if (!acao) return '没有 access-control-allow-origin（网关没认这个来源）';
  if (acao === '*') return '回的是通配符 *（本项目带凭据，* 无效，等于没放行）';
  if (acao !== origin) return '回的是「' + acao + '」，不是请求的来源「' + origin + '」';
  return null;
}

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
   C 组 · 跨域（CORS）
   =========================================================================== */
rep.section('C 组 · 跨域（CORS）—— 白名单里有没有发布站点域名');

const KNOWN_OK = [
  { label: '本地开发源 localhost:8000', origin: 'http://localhost:8000' },
  { label: '控制台内置域名 tcloudbaseapp.com', origin: 'https://echoread-d0g1b2ez6a369d11e-1502538433.tcloudbaseapp.com' }
];
const OUTSIDER = 'https://evil.example.com';

let r = await call('GET', '/api/health', { origin: SITE });
let bad = notAllowed(r, SITE);
rep.check('C1', '发布站点来源能拿到跨域头（GET /api/health）',
  bad === null,
  bad ? bad + ' ｜ HTTP ' + r.status + ' ｜ vary=' + JSON.stringify(r.headers.get('vary'))
      : 'acao=' + r.headers.get('access-control-allow-origin') + '，vary=' + r.headers.get('vary'));

r = await call('OPTIONS', '/api/words', {
  origin: SITE,
  headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
});
bad = notAllowed(r, SITE);
const preOk = bad === null && r.status === 204 &&
  String(r.headers.get('access-control-allow-methods') || '').toUpperCase().indexOf('POST') >= 0;
rep.check('C2', '写入预检 OPTIONS 能过（应 204 且放行 POST）',
  preOk,
  bad ? bad + ' ｜ 实际 HTTP ' + r.status + '（405 = 预检被透传给了云函数）'
      : 'HTTP ' + r.status + '，allow-methods=' + JSON.stringify(r.headers.get('access-control-allow-methods')));

let c3bad = [];
for (const k of KNOWN_OK) {
  const rr = await call('GET', '/api/health', { origin: k.origin });
  const b = notAllowed(rr, k.origin);
  if (b) c3bad.push(k.label + '：' + b);
}
rep.check('C3', '对照组：白名单内的来源没被误伤（防"修一个坏一个"）',
  c3bad.length === 0,
  c3bad.length === 0 ? 'localhost:8000 与内置域名都仍有跨域头' : c3bad.join(' ｜ '));

r = await call('GET', '/api/health', { origin: OUTSIDER });
const acaoOut = r.netError ? '(请求失败)' : r.headers.get('access-control-allow-origin');
rep.check('C4', '白名单外的域名【必须仍然】拿不到跨域头（防白名单被改松）',
  acaoOut === null,
  acaoOut === null ? '确认无 access-control-allow-origin（闸门没被拆）'
    : '⚠️ 居然放行了：acao=' + acaoOut + ' —— 白名单被改松了，比原 Bug 更严重');

r = await call('GET', '/api/health', {});
const alive = r.status === 200 && r.json && r.json.ok === true && r.json.service === 'echoread';
rep.check('C5', '接口本体是活的（不带 Origin，把"跨域被拦"和"接口坏了"分开）',
  alive,
  alive ? '200 {ok:true, service:"echoread"}' : detailOf(r));

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
  console.log(' 提示：若 FAIL 全是 C 组「发布站点」相关项，而 C3 对照全过，');
  console.log('       那就是跨域白名单漏了这个域名。控制台「环境配置 → 安全来源 → 安全域名」');
  console.log('       点【添加域名】，填这个（⚠️ 裸域名，不要带 http:// 或 https://）：');
  console.log('         ' + SITE_HOST);
  console.log('       约 1–2 分钟生效，之后重跑应变成全 PASS。不用改任何代码。');
  console.log('');
}
process.exit(rep.exitCode());
