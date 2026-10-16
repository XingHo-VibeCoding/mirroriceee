/*
 * 音频编号改名：L{等级}.{课号}.{片段号}
 * =====================================================================
 *   L1.1   → L1.1.1     （星一班 Lesson1 第1段）
 *   L22.1  → L1.22.1
 *   L2-1.1 → L2.1.1     （高级班 Lesson1 第1段）
 *   L2-U4.1→ L2.U4.1    （高级班 L4 独立单元）
 *
 * 涉及：materials.json(id + audio 路径) / segments.json(materialId)
 *      / freetalk.json(src 编号 + 范文里的 [编号] 标注) / 磁盘 mp3 文件名
 * 改前自动打 .bak-renumber-<stamp>；发现已有三段式编号会中止（防重复跑）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = {
  mats: path.join(ROOT, 'data/materials.json'),
  segs: path.join(ROOT, 'data/segments.json'),
  ft: path.join(ROOT, 'data/freetalk.json'),
};
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/* 老编号 → 新编号 */
function newId(old) {
  let m;
  if ((m = /^L2-U(\d+)\.(\d+)$/.exec(old))) return `L2.U${m[1]}.${m[2]}`;   // 高级班独立单元
  if ((m = /^L2-(\d+)\.(\d+)$/.exec(old))) return `L2.${m[1]}.${m[2]}`;     // 高级班课文
  if ((m = /^L(\d+)\.(\d+)$/.exec(old))) return `L1.${m[1]}.${m[2]}`;       // 星一班（已归一）
  return null;
}
const isNew = id => /^L\d\.(?:U\d+|\d+)\.\d+$/.test(id);

const mats = JSON.parse(fs.readFileSync(F.mats, 'utf8'));
const segs = JSON.parse(fs.readFileSync(F.segs, 'utf8'));
const ft = JSON.parse(fs.readFileSync(F.ft, 'utf8'));

/* 防重复跑 */
const already = mats.materials.filter(m => isNew(m.id));
if (already.length) {
  console.error(`⛔ 已有 ${already.length} 条是新格式（如 ${already[0].id}），本次不重复改名。`);
  process.exit(2);
}

/* 建映射 */
const map = new Map();
for (const m of mats.materials) {
  const n = newId(m.id);
  if (!n) { console.error('⛔ 认不出的编号：' + m.id); process.exit(3); }
  if (map.has(m.id)) { console.error('⛔ 编号重复：' + m.id); process.exit(3); }
  map.set(m.id, n);
}
const newSet = new Set(map.values());
if (newSet.size !== map.size) { console.error('⛔ 改名后出现重号'); process.exit(3); }

/* 备份 */
for (const [k, p] of Object.entries(F)) fs.copyFileSync(p, `${p}.bak-renumber-${stamp}`);
console.log(`备份：materials / segments / freetalk .bak-renumber-${stamp}`);

/* 1. materials：id + audio */
for (const m of mats.materials) {
  const n = map.get(m.id);
  const oldAudio = m.audio;
  m.id = n;
  m.audio = path.posix.dirname(oldAudio) + '/' + n + '.mp3';
}
/* 2. segments */
for (const s of segs) s.materialId = map.get(s.materialId) || s.materialId;
/* 3. freetalk：src + 范文标注 */
let markCount = 0;
for (const t of ft.topics) {
  (t.src || []).forEach(r => { if (map.has(r[1])) r[1] = map.get(r[1]); });
  t.sample = t.sample.replace(/\[([^\]]+)\]/g, (all, id) => { markCount++; return '[' + (map.get(id) || id) + ']'; });
}

/* 4. 磁盘改名 */
let renamed = 0;
for (const m of mats.materials) {
  const oldRel = m.audio.replace('/' + m.id + '.mp3', '/' + mapOld(m.id) + '.mp3');
  const oldAbs = path.join(ROOT, oldRel);
  const newAbs = path.join(ROOT, m.audio);
  if (!fs.existsSync(oldAbs)) { console.error('⛔ 源文件不存在：' + oldRel); process.exit(4); }
  if (fs.existsSync(newAbs)) { console.error('⛔ 目标已存在：' + m.audio); process.exit(4); }
  fs.renameSync(oldAbs, newAbs);
  renamed++;
}
function mapOld(newIdStr) { for (const [o, n] of map) if (n === newIdStr) return o; return null; }

/* 5. 写回 */
fs.writeFileSync(F.mats, JSON.stringify(mats, null, 2) + '\n', 'utf8');
fs.writeFileSync(F.segs, JSON.stringify(segs, null, 2) + '\n', 'utf8');
fs.writeFileSync(F.ft, JSON.stringify(ft, null, 2) + '\n', 'utf8');

/* 6. 自检 */
const back = JSON.parse(fs.readFileSync(F.mats, 'utf8'));
const badIds = back.materials.filter(m => !isNew(m.id)).map(m => m.id);
const missingAudio = back.materials.filter(m => !fs.existsSync(path.join(ROOT, m.audio))).map(m => m.audio);
const leftOldMarks = [];
for (const t of JSON.parse(fs.readFileSync(F.ft, 'utf8')).topics) {
  [...t.sample.matchAll(/\[([^\]]+)\]/g)].forEach(m => { if (!isNew(m[1])) leftOldMarks.push(t.id + ' ' + m[1]); });
}
console.log('');
console.log(`素材 ${map.size} 条改名，磁盘 ${renamed} 个文件重命名，范文 ${markCount} 处标注改写`);
console.log(`  样例：L1.1→${map.get('L1.1')}  L22.1→${map.get('L22.1')}  L2-1.1→${map.get('L2-1.1')}  L2-U4.1→${map.get('L2-U4.1')}`);
console.log(`  残留旧编号：${badIds.length}   音频缺失：${missingAudio.length}   范文残留旧标注：${leftOldMarks.length}`);
if (badIds.length || missingAudio.length || leftOldMarks.length) {
  console.error('⛔ 自检未过'); process.exit(5);
}
const L1 = back.materials.filter(m => m.level === 'L1');
const L2 = back.materials.filter(m => m.level === 'L2');
console.log(`  分部：L1 ${L1.length} 条（${L1[0].id} … ${L1[L1.length - 1].id}）／L2 ${L2.length} 条（${L2[0].id} … ${L2[L2.length - 1].id}）`);
console.log('结论：PASS');
