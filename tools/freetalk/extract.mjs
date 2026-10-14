/* 从 MIT 仓库题库 ielts-question-bank.js 里抽出结构化题目，实测真实条数。
   只读文件 + eval，不依赖子进程（沙箱里 spawn 会 EBUSY）。 */
import fs from 'fs';

const src = fs.readFileSync(new URL('./qbank.js', import.meta.url), 'utf8');

/* 题库是 class 声明，不能直接 import；改成赋值给变量再 eval。
   末尾的 module.exports / window 赋值在 Node 里没有 window，走 module 分支会报错，
   所以先把它删掉，只取 constructor 里的 questionBank。 */
const cls = src
  .replace(/^\s*\/\/ 导出模块[\s\S]*$/m, '')
  .replace(/^\s*if \(typeof module[\s\S]*$/m, '')
  .replace(/^\s*\} else if \(typeof window[\s\S]*$/m, '');

let QB = null;
eval(cls + '\nQB = new IELTSQuestionBank().questionBank;');

const stat = { p1: 0, p2: 0, p3: 0 };
const rows = [];

/* Part 1 / Part 3：分类 → 题目数组。取每题作主问，同分类其它题作追问。 */
for (const part of ['Part 1', 'Part 3']) {
  for (const [cat, qs] of Object.entries(QB[part])) {
    qs.forEach((q, i) => {
      const follow = qs.filter((_, j) => j !== i).slice(0, 3);
      rows.push({ part, cat, q, follow });
      if (part === 'Part 1') stat.p1++; else stat.p3++;
    });
  }
}

/* Part 2：cue card，自带 topic / cue_card / follow_up */
QB['Part 2'].forEach((c) => {
  const lines = c.cue_card.split('\n').map(s => s.trim()).filter(Boolean);
  const head = lines[0];
  const bullets = lines.filter(l => l.startsWith('•')).map(l => l.replace(/^•\s*/, ''));
  rows.push({ part: 'Part 2', cat: '话题卡', q: head, follow: c.follow_up || [], bullets });
  stat.p2++;
});

console.log('实测条数：', JSON.stringify(stat), '总计', rows.length);
console.log('Part1 分类：', Object.keys(QB['Part 1']).join(' / '));
console.log('Part3 分类：', Object.keys(QB['Part 3']).join(' / '));

fs.writeFileSync(new URL('./qbank-extracted.json', import.meta.url),
  JSON.stringify(rows, null, 1), 'utf8');
console.log('已写 qbank-extracted.json');
