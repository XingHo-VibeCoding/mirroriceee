/* ===========================================================================
   lib/report.mjs —— 「发布前检查」各脚本共用的输出与汇总框架
   ---------------------------------------------------------------------------
   为什么单独抽这一个文件：

     check-offline.mjs（离线，只看磁盘）和 check-online.mjs（联网，打真实接口）
     是两个脚本，跑法不同、依赖不同，但它们**必须说同一种话**——
     同样的检查编号、同样的 ✅ / ❌ / ⏭ 记号、同样的汇总行。
     否则两份报告拼在一起，人是会看晕的。

   所以：把「怎么打印」抽到这里，只留一份实现。
   （这就是本项目 Day 23 那条教训的延续：同一段逻辑别在三处各存一份。）

   ⚠️ 一条硬规矩：**「跳过」不等于「通过」。**
     条件不满足（比如快照文件没生成）时，脚本必须诚实地说"这项没查"，
     绝不能默认放行 —— 否则它就是一个会撒谎的橡皮章。
   =========================================================================== */

export function createReport(opts) {
  const title = opts.title || '';
  const meta = opts.meta || [];
  const notes = opts.notes || [];
  const items = [];
  let curSection = '';

  function push(kind, id, name, extra) {
    items.push(Object.assign({ kind, id, name, section: curSection }, extra));
  }

  const api = {};

  /* 开一个新的分组，例如「A 组 · 密钥与机密」 */
  api.section = function (t) { curSection = t; };

  /* 记一条通过 / 不通过 */
  api.check = function (id, name, ok, detail) {
    push('check', id, name, { ok: !!ok, detail: detail || '' });
  };

  /* 记一条"没查成" —— 独立记号，计入汇总但不计入通过 */
  api.skip = function (id, name, why) {
    push('skip', id, name, { why: why || '' });
  };

  api.print = function () {
    const bar = '='.repeat(62);
    console.log('');
    console.log(bar);
    console.log(' 发布前检查 · ' + title);
    meta.forEach(function (m) { console.log(' ' + m); });
    console.log(' 时间：' + new Date().toLocaleString('zh-CN'));
    console.log(bar);
    notes.forEach(function (n) { console.log(' ⚠️ ' + n); });
    console.log('');

    let last = null;
    items.forEach(function (it) {
      if (it.section && it.section !== last) {
        console.log('【' + it.section + '】');
        last = it.section;
      }
      const id = it.id ? it.id + '  ' : '';
      if (it.kind === 'skip') {
        console.log('  ⏭  ' + id + it.name);
        if (it.why) console.log('       ↳ 没查的原因：' + it.why);
      } else {
        console.log('  ' + (it.ok ? '✅' : '❌') + ' ' + id + it.name);
        if (it.detail) console.log('       ↳ ' + it.detail);
      }
    });

    const pass = items.filter(function (i) { return i.kind === 'check' && i.ok; }).length;
    const fail = items.filter(function (i) { return i.kind === 'check' && !i.ok; }).length;
    const skipped = items.filter(function (i) { return i.kind === 'skip'; }).length;
    const total = pass + fail;

    console.log('');
    console.log('-'.repeat(62));
    console.log(' 汇总：PASS ' + pass + ' / FAIL ' + fail + ' / 跳过 ' + skipped +
                '（共 ' + total + ' 项实际执行）');
    console.log('-'.repeat(62));

    if (fail > 0) {
      console.log(' 未过的项：');
      items.filter(function (i) { return i.kind === 'check' && !i.ok; })
        .forEach(function (i) { console.log('   ✗ ' + (i.id ? i.id + ' ' : '') + i.name + ' :: ' + i.detail); });
      console.log('');
    }
    if (skipped > 0) {
      console.log(' ⚠️ 有 ' + skipped + ' 项被跳过 —— 跳过 ≠ 通过，需要人工确认或补齐条件后重跑。');
      console.log('');
    }
    console.log(' 退出码：' + (fail > 0 ? 1 : 0) + '（0 = 全部执行到的项都过；1 = 有 FAIL）');
    console.log('');

    api.stats = { pass: pass, fail: fail, skipped: skipped, total: total };
  };

  api.exitCode = function () {
    return (api.stats && api.stats.fail > 0) ? 1 : 0;
  };

  return api;
}
