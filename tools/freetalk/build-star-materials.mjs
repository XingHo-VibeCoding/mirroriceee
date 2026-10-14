/* 星一班音频接入「文本跟读」页 —— 一步构建：
   1. 解析时间戳文本，得到全部片段（Lesson + 文件名 + 每句 start/end）
   2. 按 Lesson 分组、组内按出现顺序编号 → L1.1 / L1.2 / L2.1 ...
   3. 把全部音频拷到 assets/audio/LessonN/ 并重命名为 L编号.mp3（避开中文/逗号/撇号文件名）
   4. 生成 data/materials.json（43 个材料）+ data/segments.json（每句只留 start/end，无 text）
   运行：export STAR_SRC="..." && node tools/freetalk/build-star-materials.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = process.env.STAR_SRC;
if (!SRC) { console.error('[缺少环境变量] 请设置 STAR_SRC 指向素材目录'); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TS_FILE = path.join(SRC, '星一班音频_带时间戳.txt');
const AUDIO_DIR = path.join(SRC, '星一班音频');
const OUT_AUDIO = path.join(ROOT, 'assets', 'audio');
const OUT_MAT = path.join(ROOT, 'data', 'materials.json');
const OUT_SEG = path.join(ROOT, 'data', 'segments.json');

/* ---- 1. 解析时间戳文本 ---- */
const ts = fs.readFileSync(TS_FILE, 'utf8');
const segs = [];               // [{ lesson, file, lines:[{s,e,text}] }]
let cur = null;
for (const line of ts.split(/\r?\n/)) {
  const head = line.match(/^(Lesson\d+)\s*\|\s*(.+\.mp3)$/i);
  if (head) { cur = { lesson: head[1], file: head[2].trim(), lines: [] }; segs.push(cur); continue; }
  const t = line.match(/^(\d+):(\d+)~(\d+):(\d+),\s*(.+)$/);
  if (t && cur) {
    cur.lines.push({ s: +t[1] * 60 + +t[2], e: +t[3] * 60 + +t[4], text: t[5].trim() });
  }
}

/* ---- 2. 编号：按 Lesson 升序，组内按出现顺序 ---- */
const byLesson = {};
for (const s of segs) (byLesson[s.lesson] = byLesson[s.lesson] || []).push(s);
const lessonIds = Object.keys(byLesson).sort((a, b) => Number(a.replace('Lesson', '')) - Number(b.replace('Lesson', '')));

const materials = [];
const segmentsOut = [];
const ids = {};   // lesson + '|' + file -> id
for (const lesson of lessonIds) {
  const items = byLesson[lesson];
  items.forEach((s, i) => {
    const id = lesson.replace('Lesson', 'L') + '.' + (i + 1);
    ids[lesson + '|' + s.file] = id;
    materials.push({
      id: id,
      level: 'L1',
      lesson: lesson,
      title: titleOf(s.file),
      audio: 'assets/audio/' + lesson + '/' + id + '.mp3'
    });
    segmentsOut.push({
      materialId: id,
      segments: s.lines.map((ln, j) => ({ idx: j, start: ln.s, end: ln.e }))
    });
  });
}

function titleOf(file) {
  return file.replace(/\.mp3$/i, '')
    .replace(/\((\d+)\)$/, '')
    .replace(/\.{2,}$/, '')
    .replace(/,/g, ', ')
    .trim();
}

/* ---- 3. 拷音频 + 重命名 ---- */
fs.rmSync(OUT_AUDIO, { recursive: true, force: true });
fs.mkdirSync(OUT_AUDIO, { recursive: true });
let copyFail = 0;
for (const s of segs) {
  const id = ids[s.lesson + '|' + s.file];
  const src = path.join(AUDIO_DIR, s.lesson, s.file);
  const dstDir = path.join(OUT_AUDIO, s.lesson);
  fs.mkdirSync(dstDir, { recursive: true });
  if (!fs.existsSync(src)) { console.error('缺失音频:', src); copyFail++; continue; }
  fs.copyFileSync(src, path.join(dstDir, id + '.mp3'));
}

/* ---- 4. 写 materials.json + segments.json ---- */
const lessons = lessonIds.map(l => ({ level: 'L1', id: l, title: l }));
const mat = { levels: ['L1', 'L2', 'L3'], lessons: lessons, materials: materials };
fs.writeFileSync(OUT_MAT, JSON.stringify(mat, null, 2) + '\n', 'utf8');
fs.writeFileSync(OUT_SEG, JSON.stringify(segmentsOut, null, 2) + '\n', 'utf8');

console.log('音频片段：', segs.length, '个 / 拷贝失败', copyFail);
console.log('Lesson 目录：', lessonIds.join(' '));
console.log('materials：', materials.length, '条；segments：', segmentsOut.length, '条（无 text）');
