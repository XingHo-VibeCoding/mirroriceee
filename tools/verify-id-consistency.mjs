/*
 * 全站编号闭合校验（改名为 L{等级}.{课号}.{片段号} 之后）
 * =====================================================================
 * [1] materials.json 103 条编号全部符合新格式
 * [2] segments.json 的 materialId ⊆ materials 编号，且数量一致
 * [3] freetalk.json：src 编号 ⊆ materials；范文 [标注] 集合 == src 集合
 * [4] 两份表达库的索引编号 ⊆ materials（跨文件！星一班 47 / 高级班 56）
 * [5] 每条素材的音频文件在磁盘上真实存在
 * [6] 磁盘上没有遗留的旧格式文件名（两段式）
 * 反例：伪造旧格式编号 / 幽灵素材，必须被抓。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = process.env.REF_DIR;
const NEW_ID = /^L\d\.(?:U\d+|\d+)\.\d+$/;
const OLD_ID = /^L\d+\.\d+$|^L2-(?:U)?\d+\.\d+$/;

const mats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/materials.json'), 'utf8'));
const segs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/segments.json'), 'utf8'));
const ft = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/freetalk.json'), 'utf8'));
const ids = new Set(mats.materials.map(m => m.id));

let bad = 0;
const say = (ok, l, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!ok) bad++; };

/* [1] */
const notNew = mats.materials.filter(m => !NEW_ID.test(m.id)).map(m => m.id);
say(notNew.length === 0, '[1] materials 编号全为新格式', notNew.length ? '异类：' + notNew.slice(0, 5) : `${ids.size} 条`);

/* [2] */
const segIds = segs.map(s => s.materialId);
const segOrphan = segIds.filter(i => !ids.has(i));
say(segOrphan.length === 0 && segIds.length === ids.size,
  '[2] segments 与 materials 一一对应', `${segIds.length} 条，孤儿 ${segOrphan.length}`);

/* [3] */
let srcOrphan = [], markMismatch = [];
for (const t of ft.topics) {
  (t.src || []).forEach(r => { if (!ids.has(r[1])) srcOrphan.push(t.id + ':' + r[1]); });
  const marks = new Set([...t.sample.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]));
  const sid = new Set((t.src || []).map(r => r[1]));
  if ([...marks].some(x => !sid.has(x)) || [...sid].some(x => !marks.has(x))) markMismatch.push(t.id);
}
say(srcOrphan.length === 0, '[3] freetalk src 编号全部可解析', srcOrphan.slice(0, 5).join(', ') || '全部命中');
say(markMismatch.length === 0, '[3] 范文标注与 src 集合一致', markMismatch.slice(0, 5).join(', ') || '60 题一致');

/* [4] 两份表达库 */
let libStats = [];
for (const [label, file, pat] of [
  ['L1 星一班', '星一班-表达库.md', /^\|\s*(L1\.\d+\.\d+)\s*\|/gm],
  ['L2 高级班', '高级班-表达库.md', /^\|\s*(L2\.(?:U\d+|\d+)\.\d+)\s*\|/gm],
]) {
  const md = fs.readFileSync(path.join(REF, file), 'utf8');
  const block = md.split('## 音频索引')[1].split('\n## ')[0];
  const libIds = [...block.matchAll(pat)].map(m => m[1]);
  const orphan = libIds.filter(i => !ids.has(i));
  libStats.push({ label, n: libIds.length, orphan: orphan.length, sample: orphan.slice(0, 3) });
}
say(libStats.every(s => s.orphan === 0),
  '[4] 两份表达库编号 ⊆ materials（跨文件）',
  libStats.map(s => `${s.label} ${s.n} 条/孤儿 ${s.orphan}${s.orphan ? ' ' + s.sample.join(',') : ''}`).join(' | '));

/* [5] 磁盘 */
const missing = mats.materials.filter(m => !fs.existsSync(path.join(ROOT, m.audio))).map(m => m.audio);
say(missing.length === 0, '[5] 素材音频文件全部存在', missing.slice(0, 3).join(', ') || `${mats.materials.length} 个`);

/* [6] 磁盘上没有旧名残留 */
const oldFiles = [];
for (const m of mats.materials) {
  const dir = path.join(ROOT, path.posix.dirname(m.audio));
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.mp3') && !NEW_ID.test(path.basename(f, '.mp3'))) oldFiles.push(path.posix.join(path.posix.dirname(m.audio), f));
  }
}
say(oldFiles.length === 0, '[6] 磁盘无旧格式文件名残留', oldFiles.slice(0, 5).join(', ') || '干净');

/* [7] 课程 id 也必须是新家族，且 materials 的引用不悬空 */
const LESSON_ID = /^L[12]\.(?:U\d+|\d+)$/;
const badLesson = mats.lessons.filter(l => !LESSON_ID.test(l.id)).map(l => l.id);
const lessonSet = new Set(mats.lessons.map(l => l.id));
const danglingRef = mats.materials.filter(m => !lessonSet.has(m.lesson)).map(m => m.id);
say(badLesson.length === 0, '[7] 课程 id 全为新家族 L{等级}.{课号}',
  badLesson.length ? '异类：' + badLesson.slice(0, 5) : `${mats.lessons.length} 条`);
say(danglingRef.length === 0, '[7] materials.lesson 引用无悬空', danglingRef.slice(0, 5).join(', ') || '全部命中');

/* 反例 */
const fakeOld = mats.materials.some(m => OLD_ID.test('L2-1.1') && ids.has('L2-1.1'));
const fakeGhost = ids.has('L2.99.9');
say((!fakeOld && !fakeGhost), '[反例] 旧格式编号 / 幽灵素材 都不存在（判定有效）',
  `旧格式命中=${fakeOld}，幽灵命中=${fakeGhost}`);

console.log('');
console.log(bad === 0 ? '结论：PASS —— 全站编号闭合（5 个文件 + 磁盘）' : `结论：FAIL —— ${bad} 项未过`);
process.exit(bad === 0 ? 0 : 1);
