#!/usr/bin/env node
/* ===========================================================================
   Day 23 余力加练验证：请求日志（时间 | 路径 | 结果 | 耗时）

   做法：把 global.fetch 换成桩，让云函数的**真代码**跑完六条分支，
        再把每一行日志原样打出来。
   ⚠️ 如实标注：transport（网关那一跳）是桩，不是真网络；
      但 index.js / rdb.js / repositories 全是真代码，日志格式与线上完全一致。
   ⚠️ 全程不碰线上数据、不发任何真实请求。
   =========================================================================== */
'use strict';
const path = require('path');

const IDX = path.join(__dirname, '..', '..', '..', 'Desktop', 'vibe-coding-30days',
  'cloudfunctions', 'echoread-api', 'index.js');

const LOGS = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { LOGS.push(a.map(String).join(' ')); };
console.error = (...a) => { LOGS.push('(err) ' + a.map(String).join(' ')); };

process.env.CLOUDBASE_API_KEY = 'dummy-key-for-local-probe';
process.env.CLOUDBASE_ENV_ID = 'echoread-d0g1b2ez6a369d11e';

const api = require(IDX);

/* 桩：成功的网关响应（3 条种子，形状与 PostgREST 一致 —— 库列名） */
const SEED = [
  { id: 'w-abandon', word: 'abandon', meaning: 'v. 放弃；抛弃', unit_tag: 'Unit 1' },
  { id: 'w-efficient', word: 'efficient', meaning: 'adj. 高效的；效率高的', unit_tag: 'Unit 1' },
  { id: 'w-responsible', word: 'responsible', meaning: 'adj. 有责任的；负责的', unit_tag: 'Unit 2' }
];
const okFetch = async () => ({ ok: true, status: 200, json: async () => SEED, text: async () => JSON.stringify(SEED) });
const boomFetch = async () => { throw new Error('simulated gateway failure'); };

const CASES = [
  ['GET   /api/words  正常读', { httpMethod: 'GET', path: '/api/words', queryStringParameters: {} }, okFetch, '200'],
  ['HEAD  /api/words  探针(应当成 GET)', { httpMethod: 'HEAD', path: '/api/words', queryStringParameters: {} }, okFetch, '200'],
  ['POST  /api/words  超长 id', { httpMethod: 'POST', path: '/api/words', queryStringParameters: {}, body: JSON.stringify({ id: 'w-' + 'x'.repeat(70), title: 'a', desc: 'b' }) }, okFetch, '400 invalid_field'],
  ['GET   /api/nope   不存在的路径', { httpMethod: 'GET', path: '/api/nope', queryStringParameters: {} }, okFetch, '404 not_found'],
  ['PUT   /api/words  未挂该方法', { httpMethod: 'PUT', path: '/api/words', queryStringParameters: {} }, okFetch, '405 method_not_allowed'],
  ['GET   /api/words  网关炸了', { httpMethod: 'GET', path: '/api/words', queryStringParameters: {} }, boomFetch, '500 db_error']
];

(async () => {
  /* ⚠️ 注意这里：我自己的打印走 `out`（真实 stdout），
     而 `console.log` / `console.error` **全程保持被拦**，专门用来收日志行 ——
     否则拦下来又立刻还原，抓取数组永远是空的（第一版就是这么写错的）。 */
  const out = realLog;

  out('============================================================');
  out(' 请求日志验证 —— 六条分支，六条日志');
  out(' 代码：cloudfunctions/echoread-api/index.js（与线上同一份）');
  out('============================================================\n');

  let allPass = true;

  for (const [name, evt, fetcher, expect] of CASES) {
    LOGS.length = 0;
    global.fetch = fetcher;
    let res;
    try {
      res = await api.main(evt, {});
    } catch (e) {
      res = { statusCode: 'THROW', body: String(e.message) };
    }
    const actual = String(res.statusCode) + (() => {
      try { const b = JSON.parse(res.body); return b && b.error ? ' ' + b.error : ''; } catch (e) { return ''; }
    })();

    const hit = LOGS.filter((l) => l.indexOf('[echoread-api]') === 0);
    const same = actual === expect;
    const oneLine = hit.length === 1;
    if (!same || !oneLine) allPass = false;

    out('■ ' + name);
    out('   期望结果 : ' + expect);
    out('   实际结果 : ' + actual + (same ? '   ✅' : '   ❌ 对不上'));
    out('   日志条数 : ' + hit.length + (oneLine ? ' 条 ✅' : ' 条 ❌（应为 1 条）'));
    out('   日志行   :');
    (hit.length ? hit : ['（没有日志 —— 这就是盲区！）']).forEach((l) => out('             ' + l));
    /* 500 那一路还会多打一条 console.error（带网关原文），一并如实展示 */
    LOGS.filter((l) => l.indexOf('(err)') === 0).forEach((l) => out('   (另有错误日志) ' + l));
    out('');
  }

  out('============================================================');
  out(' 汇总：' + (allPass ? '六条分支全部 ✅（结果对得上 ＋ 各有一条日志）' : '有 ❌，见上'));
  out(' 格式：[echoread-api] <ISO 时间> | <方法> <路径> | <状态码> [错误短码] | <耗时>ms');
  out('');
  out(' ⚠️ 路径只打 /api/words，**不带 ?id= / ?unit=** —— 查询串是用户输入，');
  out('    可能很长、也可能含不该落盘的内容，刻意不打。请求体同理。');
  out('============================================================');
  process.exit(allPass ? 0 : 1);
})();
