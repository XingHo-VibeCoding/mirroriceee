#!/usr/bin/env node
/* ===========================================================================
   check-offline.mjs —— 发布前检查 · 离线部分（只看磁盘，不联网、不起子进程）
   ---------------------------------------------------------------------------
   查什么（编号与 SKILL.md 对齐）：
     A 组 · 密钥与机密      A1 ~ A6
     B 组 · 发布包不夹带    B1 ~ B3
     E3  · 查询过滤已删（源码层）

   跑法（cmd / Git Bash 均可）：
     node <仓库路径>\skills\verify-project\scripts\check-offline.mjs
     或先 cd 到项目根再：node skills\verify-project\scripts\check-offline.mjs
     也可以指定别的目录：node <脚本> <项目根目录>

   ⚠️⚠️ 本脚本【不起任何子进程】（不调 git、不调 node、不调 shell）。
      原因：本机沙箱里 Node 起子进程会 EBUSY（Day 23 实测，连 `git rev-parse HEAD`
      都起不来）。一个"看环境脸色"的检查器比没有更糟，所以这里全部改成**读文件**：
        · .gitignore 是否覆盖 .env  → 直接读 .gitignore 文本，按 Git 的语义判定
        · .env 是否进过 git 历史    → 读外部预先生成的 .git-history-snapshot.txt
      快照怎么生成，见 SKILL.md「怎么跑」一节。

   退出码：0 = 执行到的项全过；1 = 有 FAIL。
   =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createReport } from './lib/report.mjs';

const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('-')
  ? process.argv[2] : process.cwd());

const rep = createReport({
  title: '离线部分（磁盘）',
  meta: [' 项目根：' + ROOT],
  notes: [
    '本脚本不联网、不起子进程 —— 只读磁盘上的文件。',
    '「⏭ 跳过」不计入通过：没查成的项必须人工确认，不许默认放行。'
  ]
});

/* ---------- 小工具 ---------- */

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function exists(p) { return fs.existsSync(p); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function stat(p) { try { return fs.statSync(p); } catch (e) { return null; } }

/* 递归收集文件，返回项目根相对路径（正斜杠） */
function walk(dir, opts) {
  const out = [];
  const exts = opts.exts || null;
  const skip = opts.skip || [];
  function go(d) {
    let names;
    try { names = fs.readdirSync(d); } catch (e) { return; }   /* 目录读不到就跳过，别炸 */
    for (const name of names) {
      const full = path.join(d, name);
      const r = rel(full);
      if (skip.some(function (s) { return r === s.replace(/\/$/, '') || r.startsWith(s); })) continue;
      const st = stat(full);
      if (!st) continue;
      if (st.isDirectory()) { go(full); continue; }
      if (exts && !exts.includes(path.extname(name).toLowerCase())) continue;
      out.push(r);
    }
  }
  go(dir);
  return out;
}

/* ===========================================================================
   A 组 · 密钥与机密
   =========================================================================== */
rep.section('A 组 · 密钥与机密');

/* ---- A1 工作区无硬编码密钥 ----
   口径：只匹配「真密钥才会有的形态」，**绝不含裸变量名**。
   为什么不搜 api_key 这种词：会把 process.env.CLOUDBASE_API_KEY 这种**正常代码**
   也命中，截图交上去像"搜到了东西"，与"0 条"的验收标准正好相反（Day 23 踩过）。 */
const SECRET_PATTERNS = [
  { name: '腾讯云 SecretId（AKID）', re: /AKID[A-Za-z0-9]{10,}/ },
  { name: '私钥文件头',             re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: '带密码的连接串',         re: /(postgres|postgresql|mysql|mongodb|redis):\/\/[^/\s]+:[^@\s]+@/ },
  { name: '硬编码密钥赋值',         re: /["']?(password|passwd|secret|api[_-]?key|access[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9_/+-]{16,}["']/i },
  { name: '长 Bearer 令牌',         re: /Bearer\s+[A-Za-z0-9_.-]{30,}/ }
];
/* ⚠️ 扫描范围排除 skills/ ：检查器自己文件里写着这些正则（比如 AKID 的形态），
   不排除就会"自己抓自己"，产生假阳性。同样排除 .workbuddy/（本机协作笔记）。 */
const SCAN_EXTS = ['.js', '.json', '.html', '.css', '.sql', '.mjs', '.cjs'];
const SCAN_SKIP = ['node_modules', '.git', '.workbuddy', 'skills', 'assets/audio'];

const secretHits = [];
walk(ROOT, { exts: SCAN_EXTS, skip: SCAN_SKIP }).forEach(function (r) {
  const text = read(path.join(ROOT, r));
  SECRET_PATTERNS.forEach(function (p) {
    if (p.re.test(text)) secretHits.push(r + '（' + p.name + '）');
  });
});
rep.check('A1', '工作区无硬编码密钥',
  secretHits.length === 0,
  secretHits.length === 0
    ? '搜索结果：0 条 —— 干净（扫描 ' + SCAN_EXTS.join('/') + '，已排除 ' + SCAN_SKIP.join(' / ') + '）'
    : '命中 ' + secretHits.length + ' 处，需人工复核：' + secretHits.join(' ｜ '));

/* ---- A2 .env 被 .gitignore 覆盖 ----
   ⚠️⚠️ 这里踩过一次漏报（Day 25 注入测试逮到的，值得记）：
      第一版规则写的是「有 `.env` 行，**或**有 `.env.*` 行」——
      看着挺合理，其实**错**：Git 里 `.env.*` 只匹配 `.env.production` 这类带后缀的，
      **挡不住 `.env` 本身**。于是把 `.env` 那一行注释掉之后，检查器照样报 ✅。
      ⇒ 一个会放行"本该拦的"检查器，等于没有。
   正解：**按 Git 的真实语义**逐行判 —— 从前往后扫，最后一条命中的规则说了算，
   `!` 开头是例外（把文件捞回来）。只处理不含 `/` 的根级模式（本项目规则都在根级）。 */
function ignoredByGit(giLines, target) {
  let ignored = false;
  let lastHit = null;
  giLines.forEach(function (raw) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') return;          /* 注释与空行不参与 */
    const neg = line.charAt(0) === '!';
    const pat = neg ? line.slice(1) : line;
    if (pat.indexOf('/') >= 0) return;                    /* 带路径的模式本脚本不处理 */
    const rx = new RegExp('^' +
      pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')           /* 先转义正则特殊字符（* 除外） */
        .replace(/\*/g, '[^/]*')                          /* 再把 glob 的 * 变成「非 / 的任意串」 */
        .replace(/\?/g, '[^/]') + '$');
    if (rx.test(target)) { ignored = !neg; lastHit = line; }
  });
  return { ignored: ignored, by: lastHit };
}
const giText = exists(path.join(ROOT, '.gitignore')) ? read(path.join(ROOT, '.gitignore')) : '';
const giLines = giText.split('\n');
const envRes = ignoredByGit(giLines, '.env');
const exRes = ignoredByGit(giLines, '.env.example');
rep.check('A2', '.env 被 .gitignore 挡住（且 .env.example 仍能进仓库）',
  !!giText && envRes.ignored && !exRes.ignored,
  !giText ? '读不到 .gitignore'
    : ('按 Git 语义判定：.env ' +
       (envRes.ignored ? '被忽略（命中「' + envRes.by + '」）' : '❌ 没有任何规则挡住它 —— 会被提交上去！') +
       ' ｜ .env.example ' +
       (exRes.ignored ? '❌ 被一起挡住了（同学拿不到模板）' : '未被忽略（可进仓库，正确）')));

/* ---- A3 .env 从未进入 git 历史 ----
   ⚠️ 为什么读快照、不自己跑 git：见文件头。
   快照不存在 → **明确报"没查"**，绝不默认通过（Day 23 定的规矩）。 */
const SNAPSHOT = path.join(ROOT, '.git-history-snapshot.txt');
if (!exists(SNAPSHOT)) {
  rep.skip('A3', '.env 从未进入 git 历史',
    '未找到 .git-history-snapshot.txt。先在项目根跑一次：' +
    'git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt');
} else {
  const snapLines = read(SNAPSHOT).split('\n').map(function (l) { return l.trim(); });
  const dirty = snapLines.filter(function (l) { return l === '.env' || l === '.env.local' || l === '.env.production'; });
  rep.check('A3', '.env 从未进入 git 历史',
    dirty.length === 0,
    dirty.length === 0
      ? '快照 ' + snapLines.filter(Boolean).length + ' 行里没有 .env —— 干净'
      : '⚠️ 历史里出现过：' + dirty.join(' / ') + '（密钥一旦进过历史，删掉也还在，需要改密钥 + 清历史）');
}

/* ---- A4 .env.example 存在且只有占位值 ---- */
const examplePath = path.join(ROOT, '.env.example');
if (!exists(examplePath)) {
  rep.check('A4', '.env.example 存在且只有占位值', false, '.env.example 不存在（同学拿不到模板）');
} else {
  const exText = read(examplePath);
  const realValue = /(AKID[A-Za-z0-9]{13,}|[a-f0-9]{32,}|:\/\/[^/\s]+:[^@\s]+@)/.test(exText);
  const hasPlaceholder = /=\s*your[_-]/i.test(exText) || /replace[_-]?me/i.test(exText);
  rep.check('A4', '.env.example 存在且只有占位值',
    !realValue && hasPlaceholder,
    realValue ? '⚠️ 模板里疑似混进了真实值（AKID / 长 hex / 带密码连接串）'
      : (hasPlaceholder ? '有占位值（your_… 形式），未见真实值' : '⚠️ 没找到占位值写法，不像模板'));
}

/* ---- A5 密钥不下发浏览器 ----
   前端文件里不该出现 CLOUDBASE_API_KEY 这个标识符 —— 它属于云函数环境变量，
   前端连名字都不该知道。（判据 = 0 次出现，比"搜不到值"更可验证。） */
const FRONT_SKIP = ['node_modules', '.git', '.workbuddy', 'skills', 'cloudfunctions', 'assets/audio'];
const frontFiles = walk(ROOT, { exts: ['.js', '.html'], skip: FRONT_SKIP });
const frontLeak = frontFiles.filter(function (r) { return /CLOUDBASE_API_KEY/.test(read(path.join(ROOT, r))); });
rep.check('A5', '密钥不下发浏览器（前端不出现 CLOUDBASE_API_KEY）',
  frontLeak.length === 0,
  frontLeak.length === 0
    ? '前端 ' + frontFiles.length + ' 个 js/html 文件里 0 次出现'
    : '⚠️ 出现在：' + frontLeak.join(' ｜ '));

/* ---- A6 错误提示不外吐 err.message ----
   收编自 Day 23 安全脚本的第 ④ 项：failureHTML 只给中文人话，
   绝不把底层 err.message 拼给用户看。 */
const commonPath = path.join(ROOT, 'assets/js/common.js');
if (!exists(commonPath)) {
  rep.check('A6', '错误提示不外吐 err.message', false, 'assets/js/common.js 不存在');
} else {
  const m = read(commonPath).match(/function failureHTML[\s\S]*?\n\}/);
  const body = m ? m[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') : '';
  const leaks = /\+\s*err\.message/.test(body);
  rep.check('A6', '错误提示不外吐 err.message（failureHTML）',
    !!m && !leaks,
    !m ? 'common.js 里找不到 failureHTML 函数'
      : (leaks ? '⚠️ failureHTML 里仍有 + err.message 直出分支' : 'failureHTML 函数体里干净'));
}

/* ===========================================================================
   B 组 · 发布包不夹带机密
   背景（Day 23 → Day 24 真实踩坑）：发布是「整目录上传、只增不删」——
   文件一旦随发布传上去，本地删了线上还在。所以唯一的兜底是**服务器层拒绝**，
   也就是 dev-server.js 里的两张黑名单。这里逐条核对那两张名单，不让它被人改松。
   =========================================================================== */
rep.section('B 组 · 发布包不夹带机密');

const devServerPath = path.join(ROOT, 'dev-server.js');
const devSrc = exists(devServerPath) ? read(devServerPath) : '';

/* 从源码里把数组字面量的内容抠出来（只认 `const NAME = [...]` 这种写法） */
function arrayLiteral(src, name) {
  const m = src.match(new RegExp('\\b' + name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  if (!m) return null;
  return m[1].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); })
    .filter(function (s) { return s !== ''; });
}

const prefixList = arrayLiteral(devSrc, 'BLOCKED_PATH_PREFIX');
const extList = arrayLiteral(devSrc, 'BLOCKED_EXT');

/* ---- B1 路径前缀黑名单齐全 ---- */
const NEED_PREFIX = ['.env', '.workbuddy/', '.git/', 'cloudfunctions/', 'db/'];
if (!prefixList) {
  rep.check('B1', 'dev-server.js 路径前缀黑名单齐全', false,
    '抠不出 BLOCKED_PATH_PREFIX —— 变量被改名或挪走了，规则失效（这是误报/漏报的分界线，请人工确认）');
} else {
  const missing = NEED_PREFIX.filter(function (p) { return !prefixList.includes(p); });
  rep.check('B1', 'dev-server.js 路径前缀黑名单齐全（' + NEED_PREFIX.join(' / ') + '）',
    missing.length === 0,
    missing.length === 0
      ? '5 个都在：' + prefixList.join(' ')
      : '⚠️ 缺：' + missing.join(' ') + '（现有：' + prefixList.join(' ') + '）');
}

/* ---- B2 后缀黑名单齐全（.md 与 .env*） ---- */
if (!extList) {
  rep.check('B2', 'dev-server.js 后缀黑名单齐全（.md 与 .env*）', false,
    '抠不出 BLOCKED_EXT —— 变量被改名或挪走了，请人工确认');
} else {
  const hasMd = extList.includes('.md');
  const hasEnv = extList.some(function (e) { return e.indexOf('.env') === 0; });
  rep.check('B2', 'dev-server.js 后缀黑名单齐全（.md 与 .env*）',
    hasMd && hasEnv,
    (hasMd ? '有 .md' : '⚠️ 缺 .md（内部文档会上公网）') + ' ｜ ' +
    (hasEnv ? '有 .env*' : '⚠️ 缺 .env*（.env 可能被直接下载）') + ' —— 现有：' + extList.join(' '));
}

/* ---- B3 交叉比对：仓库里真实存在的敏感物，逐条确认会被挡住 ----
   这是 B 组的"落到实处"那一环：名单齐全 ≠ 覆盖面够。用同一套规则
   去判**真实躺在仓库里的**那些敏感文件，看有没有漏网的。 */
const MUST_NOT_BE_PUBLIC = [
  '.env',
  '.env.example',
  '.workbuddy/memory/JOURNAL.md',
  'cloudfunctions/echoread-api/index.js',
  'cloudfunctions/echoread-api/lib/rdb.js',
  'db/schema.sql',
  'RUN.md',
  'SECURITY_CHECKLIST.md',
  'AGENTS.md'
];
function blockedByRule(r) {
  if (extList && extList.includes(path.extname(r).toLowerCase())) return '后缀规则';
  if (prefixList && prefixList.some(function (p) {
    return r === p.replace(/\/$/, '') || r.indexOf(p) === 0;
  })) return '前缀规则';
  return null;
}
if (!prefixList || !extList) {
  rep.skip('B3', '仓库敏感物 × 黑名单规则 交叉比对', '黑名单抠不出来（见 B1/B2），无法比对');
} else {
  const present = MUST_NOT_BE_PUBLIC.filter(function (r) { return exists(path.join(ROOT, r)); });
  const leaked = present.filter(function (r) { return !blockedByRule(r); });
  rep.check('B3', '仓库里的敏感物逐条能被挡住（' + present.length + ' 个实际存在的）',
    leaked.length === 0,
    leaked.length === 0
      ? '实际存在 ' + present.length + ' 个，全部命中黑名单：' + present.join(' / ')
      : '⚠️ 会被上传到公网：' + leaked.join(' / '));
}

/* ===========================================================================
   E3 · 查询过滤已删（源码层）
   =========================================================================== */
rep.section('E 组 · 数据安全（离线能查的那部分）');

const repoPath = path.join(ROOT, 'cloudfunctions/echoread-api/repositories/words.repo.js');
if (!exists(repoPath)) {
  rep.check('E3', 'listWords 始终过滤 is_deleted=false', false, '找不到 words.repo.js');
} else {
  const src = read(repoPath);
  const m = src.match(/function listWords[\s\S]*?\n\}/);
  const ok = !!m && /is_deleted/.test(m[0]);
  rep.check('E3', 'listWords 始终过滤 is_deleted=false（软删的行对上层不可见）',
    ok,
    !m ? 'words.repo.js 里找不到 listWords 函数'
      : (ok ? 'listWords 函数体里带 is_deleted 过滤' : '⚠️ listWords 里没有 is_deleted 过滤 —— 删掉的行又会被列出来'));
}

/* ---------- 输出 ---------- */
rep.print();
process.exit(rep.exitCode());
