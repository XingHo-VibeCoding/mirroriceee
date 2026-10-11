/* ============================================
   scan-secrets.cjs —— Day 23 密钥扫描（截图专用，输出一行结论）

   ⚠️ 为什么单独做这个、而不是用 findstr / grep：
     · cmd 的 findstr 不支持正则里的"形态匹配"，只能搜字面词 ——
       搜 "api_key" 会把 process.env.CLOUDBASE_API_KEY 这种【正常代码】也命中，
       截图交上去看起来像"搜到了东西"，与"结果为 0 条"的验收标准相反。
     · 所以要按【真密钥才会有的形态】来搜，这需要正则 → 用 Node 跑最稳。

   怎么算通过：最后一行输出【搜索结果：0 条 —— 干净】。

   用法（cmd / Git Bash 均可，需先 cd 到项目根）：
     node skills/frontend-guidelines/scripts/scan-secrets.cjs
   ============================================ */

const fs = require('fs');
const path = require('path');

/* 只匹配「真密钥才会有的形态」，绝不含裸变量名（避免误伤 process.env.XXX_API_KEY） */
const PATTERNS = [
  { name: '腾讯云 SecretId',   re: /AKID[A-Za-z0-9]{10,}/ },
  { name: '私钥文件头',         re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: '带密码的连接串',     re: /(postgres|postgresql|mysql|mongodb|redis):\/\/[^/\s]+:[^@\s]+@/ },
  { name: '硬编码密钥赋值',     re: /["']?(password|passwd|secret|api[_-]?key|access[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9_/+-]{16,}["']/i },
  { name: '长 Bearer 令牌',     re: /Bearer\s+[A-Za-z0-9_.-]{30,}/ }
];

const EXTS = ['.js', '.json', '.html', '.css', '.sql', '.mjs', '.cjs'];
const SKIP_DIRS = ['node_modules', '.git', '.workbuddy', 'skills'];

const hits = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
    if (SKIP_DIRS.some(s => rel.startsWith(s))) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    if (!EXTS.includes(path.extname(name))) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const p of PATTERNS) {
      if (p.re.test(text)) hits.push(rel + '  (' + p.name + ')');
    }
  }
}

console.log('=== echoread 密钥特征扫描 ===');
console.log('扫描范围：项目内 .js / .json / .html / .css / .sql（已排除 node_modules / .git / .workbuddy / skills）');
console.log('匹配口径：真密钥形态（腾讯云 AKID / 私钥头 / 带密码连接串 / 硬编码赋值 / 长 Bearer），不含变量名');
console.log('');

walk(process.cwd());

if (hits.length === 0) {
  console.log('搜索结果：0 条 —— 干净');
} else {
  console.log('命中 ' + hits.length + ' 处，需人工复核：');
  hits.forEach(h => console.log('  · ' + h));
}
