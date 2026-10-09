#!/usr/bin/env node
/* ============================================
   check-filter-interaction.mjs —— 「前端准则自查」Skill 的检查器
   职责：静态读源码，逐条核对「筛选/列表交互」有没有守住三态 ＋ 可访问性
   输出：逐条 ✅/❌ + 汇总；退出码 0 = 全过，1 = 有未过项，2 = 环境错误

   为什么写成脚本、而不是写成人话规范：
     人话叫「建议」，可以自我说服着跳过；脚本叫「检查」，跑不过就是跑不过。
     这是这个 Skill 存在的全部理由。

   术语备注：
     SKILL —— 一套给 AI 看的操作规范（含这份脚本），触发词命中时才会被用上
     启发式检查 —— 用字符串/正则去认「这段处理在不在」，不是真正执行网页
     退出码 —— 进程结束时吐给系统的一个数字，0 代表成功，非 0 代表有问题
   ============================================ */

import fs from 'node:fs';
import path from 'node:path';

/* 项目根：命令行第一个参数；不给就查当前目录 */
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

/* 本检查只认这两个文件 —— 筛选交互的「结构」在 HTML，「行为」在 JS */
const TARGETS = ['reader.html', 'assets/js/app.js'];

/* ---- 小工具 ---- */

/* 读一个文件；读不到返回 null（由调用处统一报错） */
function readIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/* 取某段文本在源码中的位置，再截它前后一小段出来 —— 用来做「附近有没有」的判定。
   为什么要「附近」：属性名可能出现在别的函数里，不限定范围就会张冠李戴。 */
function around(src, needle, before, after) {
  const i = src.indexOf(needle);
  if (i < 0) return null;
  return src.slice(Math.max(0, i - before), i + after);
}

/* 抠出一个具名函数的函数体（从它的 { 到配对的 }）。
   ⚠️ 用「大括号配平」而不是正则：函数体里还有 if / for 的花括号，正则贪不了这么深。 */
function bodyOf(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, k + 1);
    }
  }
  return null;
}

/* ---- 10 条检查项 ----
   每条：id（编号）· group（分组）· title（查什么）· hint（不过时提示期望什么）· run（判定）

   ⚠️ 为什么把判定写成函数而不是写死字符串：
      交互实现迟早会被重写（改名字、换写法），把「认什么」集中在这里，
      以后只需改一处，不用满项目找。 */
const RULES = [
  /* ========== 三态：有结果 / 无结果 / 清空恢复 ========== */
  {
    id: 'F1',
    group: '三态',
    title: '有结果：按当前筛选条件过滤出列表',
    hint: '期望 app.js 里有一个按当前条件过滤的函数（内部用 .filter），且列表渲染调用了它',
    run: ({ js }) => {
      const body = bodyOf(js, 'materialsOfActiveLevel');
      if (!body || !/\.filter\(/.test(body)) return false;
      /* 除定义处以外，还必须在别处被调用过（说明结果真的被拿去铺列表了） */
      return js.split('materialsOfActiveLevel()').length >= 3;
    }
  },
  {
    id: 'F2',
    group: '三态',
    title: '无结果：命中 0 条时给出可见文案',
    hint: '期望有空列表分支（!list.length），且分支里给出带中文的空状态文案',
    run: ({ js }) => {
      const seg = around(js, '!list.length', 0, 400);
      return !!seg && /class="empty"/.test(seg) && /[\u4e00-\u9fa5]/.test(seg);
    }
  },
  {
    id: 'F3',
    group: '三态',
    title: '清空恢复：条件清空后回到全量',
    hint: '期望过滤函数里有「条件为空 → 返回全部」的兜底（!activeLevel）',
    run: ({ js }) => /if\s*\(\s*!\s*activeLevel\s*\)\s*return\s+\w+\s*;/.test(js)
  },

  /* ========== 可访问性 ========== */
  {
    id: 'A1',
    group: '可访问性',
    title: '控件语义：筛选键是 <button>',
    hint: '期望生成筛选键的标签是 <button>，而不是 <a> 或 <div>',
    run: ({ js }) => {
      const seg = around(js, 'data-action="pick-level"', 300, 0);
      return !!seg && seg.includes('<button');
    }
  },
  {
    id: 'A2',
    group: '可访问性',
    title: '选中态语义：互斥开关用 aria-pressed',
    hint: '期望筛选键上带 aria-pressed（读屏才知道「这个键被按下了」）',
    run: ({ js }) => {
      const seg = around(js, 'data-action="pick-level"', 0, 300);
      return !!seg && /aria-pressed/.test(seg);
    }
  },
  {
    id: 'A3',
    group: '可访问性',
    title: '当前项语义：正打开的那条用 aria-current',
    hint: '期望列表项上带 aria-current（说的是「当前打开的是这一个」）',
    run: ({ js }) => {
      const seg = around(js, 'data-action="pick-file"', 0, 300);
      return !!seg && /aria-current/.test(seg);
    }
  },
  {
    id: 'A4',
    group: '可访问性',
    title: '焦点保留：切换时不重铺整排按钮',
    hint: '期望切换函数体内【不】调用重铺整排的渲染函数 —— 重铺会把用户刚点的键换掉、焦点丢掉',
    run: ({ js }) => {
      const body = bodyOf(js, 'pickLevel');
      if (!body) return false;
      return !/renderLevels\s*\(/.test(body);
    }
  },
  {
    id: 'A5',
    group: '可访问性',
    title: '容器可命名：列表容器有 aria-label',
    hint: '期望 reader.html 里两个 <nav> 容器都带 aria-label',
    run: ({ html }) =>
      /<nav[^>]*id="levels"[^>]*aria-label=/.test(html) &&
      /<nav[^>]*id="files"[^>]*aria-label=/.test(html)
  },

  /* ========== 结构 ========== */
  {
    id: 'S1',
    group: '结构',
    title: '数据驱动：选项来自 JSON，不写死在页面',
    hint: '期望页面上的选项容器是空壳，选项清单由脚本从 data/*.json 读入',
    run: ({ html, js }) => {
      const emptyShell = /<nav[^>]*id="levels"[^>]*>\s*<\/nav>/.test(html);
      const fromJSON = /\.levels\s*\|\|/.test(js);   /* levelList = result[0].levels || [] */
      return emptyShell && fromJSON;
    }
  },
  {
    id: 'S2',
    group: '结构',
    title: '切筛选先停播：别留「看不见的播放器」',
    hint: '期望切换等级、切换文件两个函数体内都先调用停止播放',
    run: ({ js }) => {
      const a = bodyOf(js, 'pickLevel');
      const b = bodyOf(js, 'pickFile');
      return !!a && !!b && /Player\.stop/.test(a) && /Player\.stop/.test(b);
    }
  }
];

/* ---- 主流程 ---- */

const files = {};
let missing = [];
for (const rel of TARGETS) {
  const content = readIfExists(path.join(ROOT, rel));
  if (content === null) missing.push(rel);
  files[rel] = content || '';
}
/* 文件路径里的 .js / .html 只是给 run() 用的键，换成短名方便调用 */
const ctx = { html: files['reader.html'], js: files['assets/js/app.js'] };

if (missing.length) {
  console.error('【前端准则自查】读不到这些文件：');
  for (const m of missing) console.error('  ✗ ' + m);
  console.error('目标目录：' + ROOT);
  console.error('请把「项目根」（含 index.html 的那一层）作为参数传进来。');
  process.exit(2);
}

console.log('【前端准则自查】目标：' + ROOT);
console.log('');

let passed = 0;
let group = '';
for (const rule of RULES) {
  if (rule.group !== group) {
    group = rule.group;
    console.log('[' + group + ']');
  }
  let ok = false;
  try {
    ok = !!rule.run(ctx);
  } catch (err) {
    ok = false;
  }
  if (ok) passed++;
  console.log(rule.id + ' ' + (ok ? '✅' : '❌') + ' ' + rule.title);
  if (!ok) console.log('      ↳ ' + rule.hint);
}

console.log('');
console.log('----------------------------------------------------------------');
console.log('汇总：' + passed + '/' + RULES.length + ' 通过 · 退出码 ' + (passed === RULES.length ? '0' : '1'));

process.exit(passed === RULES.length ? 0 : 1);
