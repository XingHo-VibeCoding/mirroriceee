#!/usr/bin/env node
/* ===========================================================================
   Day 23 线上回归脚本 —— 长度校验（MAX_LEN）是否真的生效
   ---------------------------------------------------------------------------
   为什么要它：源码里写了校验 ≠ 线上生效。Day 23 实测过一次照骗 ——
     commit 9dcff11 早就提交了，但云函数没重新部署，线上照样放行超长字段。
   所以这个脚本只认「直连线上接口的真实返回」，不认源码、不认界面文字。

   跑法（cmd 里，先切到仓库根目录；<仓库路径> 换成你自己的）：
     cd /d <仓库路径>
     node skills\frontend-guidelines\scripts\verify-day23-live.cjs

   ⚠️ 别在别的目录直接敲 `node verify-day23-live.cjs` —— 会报 Cannot find module（实测踩过）。
      懒得分两步就给完整路径：
     node <仓库路径>\skills\frontend-guidelines\scripts\verify-day23-live.cjs

   退出码：全部通过 = 0；有 FAIL = 1（方便以后接进流水线）

   ✅ 这个脚本做过「反向验证」（防橡皮章）：拿一个故意模仿旧版行为的假服务器做对照组，
      同一个脚本怼上去必须大面积 FAIL。实测 真云函数 10 PASS / 0 FAIL、
      假旧版 4 PASS / 6 FAIL —— 说明它会抓，不是永远亮绿灯。

   ⚠️ 会造测试数据，但脚本自己负责删干净（末尾有清理 + 复核）。
      正常结束后库里应只剩 3 条种子：w-abandon / w-efficient / w-responsible
   =========================================================================== */

'use strict';

const BASE =
  process.env.ECHOREAD_API ||
  'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';

// 造测试数据用的 id 前缀，方便一眼认出、也方便手滑时清理
const T = 'w-verify23-';
const ID_64 = 'w-' + 'a'.repeat(62); // 正好 64（合法上界）
const ID_65 = 'w-' + 'a'.repeat(63); // 65（越界）
const ID_72 = 'w-' + 'x'.repeat(70); // 72（更明显越界）

const results = [];
let created = [];

function rep(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
  if (detail) console.log(`           ${detail}`);
}

async function call(method, path, body) {
  const url = BASE + path;
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* 非 JSON 响应，json 保持 null */
  }
  return { status: res.status, json };
}

/* 断言小工具：看 HTTP 状态 + 错误码 + 中文提示里有没有关键词 */
function expectErr(r, wantStatus, wantError, kw) {
  if (r.status !== wantStatus) return `期望 HTTP ${wantStatus}，实际 ${r.status}`;
  if (!r.json || r.json.error !== wantError)
    return `期望 error=${wantError}，实际 ${r.json && r.json.error}`;
  if (kw && !(r.json.message || '').includes(kw))
    return `中文提示里没找到「${kw}」，实际：${r.json.message}`;
  return null;
}

async function main() {
  console.log('');
  console.log('============================================================');
  console.log(' Day 23 线上回归：长度校验（MAX_LEN）');
  console.log(' 目标：' + BASE);
  console.log(' 时间：' + new Date().toLocaleString('zh-CN'));
  console.log('============================================================');

  /* ---------- 第 1 组：反例 —— 超长必须被拦 ---------- */
  console.log('\n【第 1 组】反例：超长字段应当返回 400 invalid_field（中文提示）');

  let r = await call('POST', '/api/words', { id: ID_72, title: 'reg', desc: 'reg' });
  rep(
    `超长 id（72 > 64）`,
    expectErr(r, 400, 'invalid_field', '过长') === null,
    expectErr(r, 400, 'invalid_field', '过长') || r.json && r.json.message
  );

  r = await call('POST', '/api/words', {
    id: T + 'title',
    title: 't'.repeat(80),
    desc: 'reg',
  });
  rep(
    `超长 title（80 > 64）`,
    expectErr(r, 400, 'invalid_field', '过长') === null,
    expectErr(r, 400, 'invalid_field', '过长') || r.json && r.json.message
  );

  r = await call('POST', '/api/words', {
    id: T + 'desc',
    title: 'reg',
    desc: 'd'.repeat(600),
  });
  rep(
    `超长 desc（600 > 500）`,
    expectErr(r, 400, 'invalid_field', '过长') === null,
    expectErr(r, 400, 'invalid_field', '过长') || r.json && r.json.message
  );

  r = await call('PATCH', `/api/words?id=w-efficient`, { tag: 'U'.repeat(40) });
  rep(
    `PATCH 超长 tag（40 > 32）`,
    expectErr(r, 400, 'invalid_field', '过长') === null,
    expectErr(r, 400, 'invalid_field', '过长') || r.json && r.json.message
  );

  /* ---------- 第 2 组：边界值 —— 64 过、65 拦（防"放水"的关键） ---------- */
  console.log('\n【第 2 组】边界值：64 该放行、65 该拦截');

  r = await call('POST', '/api/words', { id: ID_64, title: '边界64', desc: '边界' });
  const ok64 = r.status === 201;
  if (ok64) created.push(ID_64);
  rep(`id 正好 64 字符 → 201`, ok64, ok64 ? null : `实际 HTTP ${r.status}，${JSON.stringify(r.json)}`);

  r = await call('POST', '/api/words', { id: ID_65, title: '边界65', desc: '边界' });
  const bad65 = expectErr(r, 400, 'invalid_field', '65');
  rep(`id 65 字符 → 400`, bad65 === null, bad65 || r.json.message);

  /* ---------- 第 3 组：正例 —— 正常数据不能被误伤 ---------- */
  console.log('\n【第 3 组】正例：正常数据必须放行（校验别把好人一起拦了）');

  r = await call('POST', '/api/words', {
    id: T + 'ok',
    title: '回归正例',
    desc: '正常长度',
    tag: 'Unit 9',
  });
  const okNormal = r.status === 201 && r.json && r.json.ok === true;
  if (okNormal) created.push(T + 'ok');
  rep('正常写入 → 201 ok:true', okNormal, okNormal ? null : `实际 ${r.status} ${JSON.stringify(r.json)}`);

  r = await call('GET', '/api/words');
  const listOk = r.status === 200 && r.json && Array.isArray(r.json.words);
  rep(
    'GET /api/words 仍正常 → 200',
    listOk,
    listOk ? `当前 ${r.json.words.length} 行` : `实际 ${r.status}`
  );

  r = await call('DELETE', `/api/words?id=${T}nonexist`);
  const nf = expectErr(r, 404, 'word_not_found', '没有找到');
  rep('删除不存在的 id → 404（不许假装成功）', nf === null, nf || r.json.message);

  /* ---------- 清理：把本轮造的测试行删掉 ---------- */
  console.log('\n【清理】删除本轮造的测试数据');
  for (const id of created) {
    const d = await call('DELETE', `/api/words?id=${encodeURIComponent(id)}`);
    console.log(`  ${d.status === 200 ? '✅' : '⚠️ '} 删除 ${id} → HTTP ${d.status}`);
  }

  /* ---------- 复核：库容应回到 3 条 ---------- */
  console.log('\n【复核】库容');
  r = await call('GET', '/api/words');
  const n = r.json && r.json.words ? r.json.words.length : -1;
  rep(
    `库容回到 3 条纯种子`,
    n === 3,
    n === 3
      ? r.json.words.map((w) => w.id).join(' / ')
      : `实际 ${n} 行：${(r.json.words || []).map((w) => w.id).join(' / ')}（若有残留请手工清理）`
  );

  /* ---------- 汇总 ---------- */
  const fails = results.filter((x) => !x.pass);
  console.log('\n============================================================');
  console.log(` 汇总：${results.length - fails.length} PASS / ${fails.length} FAIL`);
  console.log('============================================================');
  if (fails.length) {
    console.log(' 未过的项：');
    fails.forEach((f) => console.log('  - ' + f.name + ' :: ' + f.detail));
  }
  console.log('');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n[X] 脚本本身出错（不是接口的锅）：', e && e.message ? e.message : e);
  console.error('    排查方向：网络能否访问 ' + BASE);
  process.exit(1);
});
