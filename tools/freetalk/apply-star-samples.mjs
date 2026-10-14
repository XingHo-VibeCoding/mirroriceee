/* 把星一班范文写进 data/freetalk.json：
   - sample 替换为星一班版（含 [Lx.x] 编号）
   - 新增 src 溯源数组 [{expr, ref}]
   只读文件 + import，不起子进程（沙箱 spawn 会 EBUSY）。 */
import fs from 'fs';
import { A } from './star-samples-a.mjs';
import { B } from './star-samples-b.mjs';

const DATA = new URL('../../data/freetalk.json', import.meta.url);
const map = { ...A, ...B };

const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const topics = d.topics || [];

let replaced = 0;
const missing = [];

for (const t of topics) {
  const hit = map[t.id];
  if (!hit) { missing.push(t.id); continue; }
  t.sample = hit.sample;
  t.src = hit.src;            // [{ expr, ref }]
  replaced++;
}

// 反向检查：map 里有但题库里没有的 id（多余，提示但不报错）
const known = new Set(topics.map(t => t.id));
const extra = Object.keys(map).filter(id => !known.has(id));

console.log('题库话题数：', topics.length);
console.log('已替换范文：', replaced);
console.log('遗漏（题库有、范文没有）：', missing.length ? missing.join(', ') : '无');
console.log('多余（范文有、题库没有）：', extra.length ? extra.join(', ') : '无');

if (missing.length) {
  console.error('❌ 有遗漏，未写入文件');
  process.exit(1);
}

fs.writeFileSync(DATA, JSON.stringify(d, null, 2) + '\n', 'utf8');
console.log('✅ 已写回 data/freetalk.json');
