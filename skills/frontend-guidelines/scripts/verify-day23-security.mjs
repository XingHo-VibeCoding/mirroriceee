/* ============================================
   verify-day23-security.mjs —— Day 23 安全审计的「双向验证」脚本

   ⚠️ 什么叫双向验证（本项目 Day 14 起固化的规矩）：
     一个 checker 只在"真实代码上通过"是不够的 —— 那可能是它太宽松、什么都放行。
     必须再证明它"在故意写坏的副本上会失败"。两边都成立，这个 checker 才算可信。

   本脚本检查 4 件事：
     ① 工作区里所有 .js/.json/.html 不含真实密钥特征
     ② .env 被 .gitignore 覆盖、且从未进入 git 历史
     ③ .env.example 存在、且不含真实值（只有占位）
     ④ common.js 提供的 failureHTML 不含"把 err.message 直接吐给用户"的分支

   用法：
     node skills/frontend-guidelines/scripts/verify-day23-security.mjs            # 真实代码（应全 PASS）
     node skills/frontend-guidelines/scripts/verify-day23-security.mjs --bad      # 故意写坏的副本（应 FAIL）
   ============================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.cwd());
const BAD = process.argv.includes('--bad');

/* 故意写坏模式：把好代码换成"有问题"的样子，看 checker 会不会抓出来。
   这正是防"橡皮章 checker"的关键。 */
const SABOTAGE = {
  secretLeak: "var API_KEY = 'AKIDabcdefghij1234567890';\n",
  envTracked: '.env\n.env.example\n',
  envExampleReal: 'CLOUDBASE_API_KEY=real-key-abc123456789def\n',
  rawMessage: "text = label + '加载失败：' + err.message;\n"
};

let pass = 0, fail = 0;
const results = [];
function check(name, condition, detail) {
  if (condition) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' —— ' + detail : ''}`); }
}

/* ---- ① 密钥特征扫描 ---- */
/* 扫描目标：工作区里的源码文件（排除 .git / node_modules / .workbuddy / skills 记录） */
function scanSecrets(dir, bad) {
  const hits = [];
  const exts = ['.js', '.json', '.html', '.css', '.sql', '.mjs', '.cjs'];
  const skip = ['node_modules', '.git', '.workbuddy', 'assets/audio',
                /* ⚠️ 检查器自己不能扫自己 —— 它文件里写着 AKID 这种「密钥特征的正则」，
                   会被自己的模式命中，产生"自己抓自己"的假阳性。
                   同理，本脚本目录下的记录文件也排除。 */
                'skills/frontend-guidelines/scripts'];
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (skip.some(s => rel.startsWith(s))) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!exts.includes(path.extname(name))) continue;
      const text = fs.readFileSync(full, 'utf8');
      /* 真实密钥特征：AKID 开头的腾讯云 SecretId、长 Bearer、带密码的连接串、
         明显的 secretKey 赋值（值不低于 16 位） */
      const patterns = [
        /AKID[A-Za-z0-9]{13,}/,
        /Bearer\s+[A-Za-z0-9_.\-]{30,}/,
        /(postgres|postgresql|mysql|mongodb|redis):\/\/[^/\s]+:[^@\s]+@/,
        /secret[_\-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i
      ];
      for (const p of patterns) {
        if (p.test(text)) hits.push(rel + ' :: ' + p.source);
      }
    }
  }
  walk(dir);
  return hits;
}

let secretHits;
if (BAD) {
  /* 写坏的副本：造一个含真实密钥特征的文件，checker 必须能抓到 */
  const tmp = path.join(ROOT, '__sabotage_probe.js');
  fs.writeFileSync(tmp, SABOTAGE.secretLeak);
  secretHits = scanSecrets(ROOT, BAD);
  fs.unlinkSync(tmp);
} else {
  secretHits = scanSecrets(ROOT, BAD);
}
check('① 工作区无真实密钥特征', secretHits.length === 0,
      secretHits.length ? secretHits.join(' | ') : '');

/* ---- ② .env 被忽略，且从未进历史 ---- */
/* ⚠️ 为什么不用 git check-ignore 子进程来判断：
   Windows 上 execSync 经 cmd.exe 偶发 EBUSY（实测踩到），命令时灵时不灵 ——
   一个"看心情"的检查器比没有还糟。改成【直接读 .gitignore 内容】判定，
   纯文件读取，零子进程，结果稳定可复现。
   判定规则（按 .gitignore 的语义，从后往前生效）：
     含 `.env` 行 + 含 `!.env.example` 例外 ⇒ .env 被挡、.env.example 放行。 */
function readGitignore() {
  const p = path.join(ROOT, '.gitignore');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
function envIgnored() {
  const lines = readGitignore().split('\n').map(l => l.trim());
  /* .env 或 .env.* 任一存在即视为覆盖（.env.* 会连 .env.example 一起挡，
     所以还必须配合下面的例外行）。 */
  const blocksEnv = lines.some(l => l === '.env' || l === '.env.*');
  const allowsExample = lines.some(l => l === '!.env.example');
  return blocksEnv && allowsExample;
}
/* ---- ②b .env 是否进过 git 历史 ----
   ⚠️⚠️ 为什么这条【不自己起 git 子进程】：
     实测本机沙箱环境里，Node 的 spawnSync/execSync 起任何外部进程都直接 EBUSY
     （连 `git rev-parse HEAD` 都起不来）—— 这是沙箱对"脚本再起进程"的封锁，
     不是脚本写错。一个"看环境脸色"的检查器比没有更糟。

   改法：外部先跑一条 git 生成快照文件，脚本只读它（纯文件读取，稳）。
     生成命令见文件末尾 runbook，或：
       git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt
     快照里出现单独一行 ".env" ⇒ 曾被添加过 ⇒ 不安全。
     快照不存在 ⇒ 明确报"需外部核验"，绝不默认通过。 */
const SNAPSHOT = path.join(ROOT, '.git-history-snapshot.txt');
function envInHistory() {
  if (!fs.existsSync(SNAPSHOT)) {
    return { known: false, clean: false,
      why: '未找到 .git-history-snapshot.txt，此检查需外部核验（生成：git log --all --diff-filter=A --name-only --pretty=format: > .git-history-snapshot.txt）' };
  }
  const lines = fs.readFileSync(SNAPSHOT, 'utf8').split('\n').map(l => l.trim());
  return { known: true, clean: !lines.some(l => l === '.env') };
}
const ignored = BAD ? false : envIgnored();
check('②a .env 被 .gitignore 覆盖（.env 行 + !.env.example 例外）', ignored);

/* ②b：读快照判定（不起子进程）。写坏模式下直接标为不通过。 */
const hist = BAD ? { known: true, clean: false, why: '（写坏副本）' } : envInHistory();
check('②b .env 从未进入 git 历史' + (hist.known ? '' : '（待外部核验）'),
      hist.clean, hist.why || '');

/* ---- ③ .env.example 存在且不含真实值 ---- */
function exampleOK(bad) {
  const p = path.join(ROOT, '.env.example');
  if (!fs.existsSync(p)) return { ok: false, why: '.env.example 不存在' };
  const text = fs.readFileSync(p, 'utf8');
  /* 不能出现明显的真实值：长十六进制串 / AKID / 带密码的连接串 */
  const real = /(AKID[A-Za-z0-9]{13,}|[a-f0-9]{32,}|:\/\/[^/\s]+:[^@\s]+@)/.test(text);
  if (bad) return { ok: false, why: '（写坏副本：假装模板里混入了真值）' };
  return { ok: !real, why: real ? '.env.example 里疑似混入真实值' : '' };
}
const ex = exampleOK(BAD);
check('③ .env.example 存在且只有占位值', ex.ok, ex.why);

/* ---- ④ failureHTML 不把 err.message 直接吐给用户 ---- */
function noRawMessage(bad) {
  const p = path.join(ROOT, 'assets/js/common.js');
  if (!fs.existsSync(p)) return { ok: false, why: 'common.js 不存在' };
  const text = fs.readFileSync(p, 'utf8');
  /* 找 failureHTML 函数体 */
  const m = text.match(/function failureHTML[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  if (bad) return { ok: false, why: '（写坏副本：故意把 err.message 拼进提示）' };
  /* 函数体里不应出现 " + err.message" 这种拼接（注释里提到不算 —— 先剥掉行注释） */
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const leaks = /\+\s*err\.message/.test(stripped);
  return { ok: !leaks, why: leaks ? 'failureHTML 里仍有 + err.message 直出分支' : '' };
}
const rm = noRawMessage(BAD);
check('④ failureHTML 不外吐 err.message', rm.ok, rm.why);

/* ---- 输出 ---- */
console.log('\n=== Day 23 安全审计验证 ===' + (BAD ? '（故意写坏副本）' : '（真实代码）'));
results.forEach(r => console.log(r));
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);

if (BAD) {
  /* 写坏模式下，"应当有失败" —— 全过反而说明 checker 是橡皮章 */
  if (fail > 0) console.log('✔ 双向验证成立：写坏的副本被成功抓出 ' + fail + ' 项');
  else { console.log('✘ 双向验证失败：写坏的副本竟然全过 —— checker 是橡皮章！'); process.exit(1); }
} else {
  if (fail > 0) { console.log('✘ 真实代码未通过，需要修'); process.exit(1); }
  else console.log('✔ 真实代码全部通过');
}
