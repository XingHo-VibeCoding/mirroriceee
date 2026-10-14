/* Lesson 编号归一：Lesson16~23 全部减一 → Lesson15~22，让编号 1..22 连续。
   涉及四处一致性：
     ① 音频目录 assets/audio/LessonN → Lesson(N-1)
     ② materials.json 的 lesson / id / audio
     ③ segments.json 的 materialId
     ④ freetalk.json 的 src 引用编号（ref）
   运行：node tools/freetalk/rename-lessons.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIO = path.join(ROOT, 'assets', 'audio');

function shiftLesson(s) {
  const m = String(s).match(/^Lesson(\d+)$/);
  if (m && Number(m[1]) >= 16) return 'Lesson' + (Number(m[1]) - 1);
  return s;
}
function shiftId(id) {
  const m = String(id).match(/^L(\d+)\.(\d+)$/);
  if (m && Number(m[1]) >= 16) return 'L' + (Number(m[1]) - 1) + '.' + m[2];
  return id;
}

/* ① 音频目录：递增顺序重命名，避免目标目录已被占 */
let renamed = 0;
for (let n = 16; n <= 23; n++) {
  const src = path.join(AUDIO, 'Lesson' + n);
  const dst = path.join(AUDIO, 'Lesson' + (n - 1));
  if (fs.existsSync(src)) { fs.renameSync(src, dst); renamed++; }
}
console.log('重命名音频目录：', renamed, '个');

/* ② materials.json */
const matPath = path.join(ROOT, 'data', 'materials.json');
const mat = JSON.parse(fs.readFileSync(matPath, 'utf8'));
mat.lessons.forEach(l => { l.id = shiftLesson(l.id); l.title = shiftLesson(l.id); });
mat.materials.forEach(m => {
  m.lesson = shiftLesson(m.lesson);
  m.id = shiftId(m.id);
  m.audio = 'assets/audio/' + m.lesson + '/' + m.id + '.mp3';
});
fs.writeFileSync(matPath, JSON.stringify(mat, null, 2) + '\n', 'utf8');

/* ③ segments.json */
const segPath = path.join(ROOT, 'data', 'segments.json');
const seg = JSON.parse(fs.readFileSync(segPath, 'utf8'));
seg.forEach(s => { s.materialId = shiftId(s.materialId); });
fs.writeFileSync(segPath, JSON.stringify(seg, null, 2) + '\n', 'utf8');

/* ④ freetalk.json 的 src 引用编号 */
const ftPath = path.join(ROOT, 'data', 'freetalk.json');
const ft = JSON.parse(fs.readFileSync(ftPath, 'utf8'));
ft.topics.forEach(t => (t.src || []).forEach(s => { s[1] = shiftId(s[1]); }));
fs.writeFileSync(ftPath, JSON.stringify(ft, null, 2) + '\n', 'utf8');

/* 校验：lessons 是否 1..22 连续；materialId 是否都能对上 */
const lessonNums = mat.lessons.map(l => Number(l.id.replace('Lesson', ''))).sort((a, b) => a - b);
console.log('lessons：', lessonNums.join(','));
console.log('连续 1..22？', lessonNums.length === 22 && lessonNums.every((v, i) => v === i + 1));
console.log('materials：', mat.materials.length, '条');
