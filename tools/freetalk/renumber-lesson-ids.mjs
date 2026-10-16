/*
 * 课程 id 统一：与素材编号同一家族 L{等级}.{课号}
 *   L1: Lesson1..Lesson22      → L1.1 .. L1.22
 *   L2: L2-1..L2-26 / L2-U4    → L2.1 .. L2.26 / L2.U4
 * 同时改 materials[].lesson 的引用（它指向 lesson.id）。
 * title 一律不动（斌哥明确说 L1 的 title 缺陷先不理会）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = path.join(ROOT, 'data/materials.json');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function newLessonId(old) {
  let m;
  if ((m = /^L2-U(\d+)$/.exec(old))) return `L2.U${m[1]}`;
  if ((m = /^L2-(\d+)$/.exec(old))) return `L2.${m[1]}`;
  if ((m = /^Lesson(\d+)$/.exec(old))) return `L1.${m[1]}`;
  return null;
}

const d = JSON.parse(fs.readFileSync(P, 'utf8'));
const already = d.lessons.filter(l => /^L[12]\./.test(l.id));
if (already.length) { console.error(`⛔ 已有 ${already.length} 条课程是新格式（如 ${already[0].id}），不重复改。`); process.exit(2); }

const map = new Map();
for (const l of d.lessons) {
  const n = newLessonId(l.id);
  if (!n) { console.error('⛔ 认不出的课程 id：' + l.id); process.exit(3); }
  map.set(l.id, n);
}
if (new Set(map.values()).size !== map.size) { console.error('⛔ 改名后课程编号重号'); process.exit(3); }

fs.copyFileSync(P, `${P}.bak-lessonid-${stamp}`);
for (const l of d.lessons) l.id = map.get(l.id);
const orphan = [];
for (const m of d.materials) {
  if (!map.has(m.lesson)) { orphan.push(m.id + '→' + m.lesson); continue; }
  m.lesson = map.get(m.lesson);
}
fs.writeFileSync(P, JSON.stringify(d, null, 2) + '\n', 'utf8');

/* 自检 */
const back = JSON.parse(fs.readFileSync(P, 'utf8'));
const idset = new Set(back.lessons.map(l => l.id));
const badLesson = back.lessons.filter(l => !/^L[12]\./.test(l.id)).map(l => l.id);
const badRef = back.materials.filter(m => !idset.has(m.lesson)).map(m => m.id);
const L1 = back.lessons.filter(l => l.level === 'L1');
const L2 = back.lessons.filter(l => l.level === 'L2');
console.log(`课程 ${map.size} 条改名，materials 引用同步（孤儿 ${orphan.length}）`);
console.log(`  样例：Lesson1→${map.get('Lesson1')}  Lesson22→${map.get('Lesson22')}  L2-1→${map.get('L2-1')}  L2-U4→${map.get('L2-U4')}`);
console.log(`  L1 课程 ${L1.length}（${L1[0].id} … ${L1[L1.length - 1].id}）| L2 课程 ${L2.length}（${L2[0].id} … ${L2[L2.length - 1].id}）`);
console.log(`  残留旧课程 id ${badLesson.length}；materials 引用悬空 ${badRef.length}`);
if (badLesson.length || badRef.length || orphan.length) { console.error('⛔ 自检未过'); process.exit(5); }
console.log('结论：PASS');
