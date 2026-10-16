/*
 * 4a：把「高级班最新音频」作为等级 L2 接进网站（与星一班 L1 并列）
 * =====================================================================
 * 输入（环境变量）：
 *   L2_SRC        高级班音频源目录（含 Lesson 1…Lesson 26 / L4 / L7 / L9 子目录）
 *   L2_TRANSCRIPT 转写文档（高级班音频_带时间戳.txt），用来生成时间戳分段
 * 产出：
 *   assets/audio/L2/<LessonN|UN>/<编号>.mp3      音频按课分目录落位
 *   data/materials.json  追加 26 条 lessons(level:L2) + 58 条 materials(level:L2)
 *   data/segments.json   追加 58 条 { materialId, segments:[{idx,start,end}] }
 *   *.bak-l2-<时间戳>    改前的两份备份
 *
 * 编号：课文 L2-课号.片段号；L4/L7 独立单元 L2-U单元号.片段号
 * ⚠️ 本脚本产出的是**改名前**的两段式编号。2026-10-16 全站已统一为
 *    L{等级}.{课号}.{片段号}（见 renumber-audio-ids.mjs）。若重跑本脚本，
 *    **必须再跑一次 renumber-audio-ids.mjs**，否则编号会退回旧格式。
 * ⚠️ 只用 fs，不起任何子进程（本沙箱里 spawn 会 EBUSY）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = process.env.L2_SRC;
const TRANSCRIPT = process.env.L2_TRANSCRIPT;

if (!SRC || !TRANSCRIPT) {
  console.error('缺少环境变量 L2_SRC / L2_TRANSCRIPT');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const MATERIALS = path.join(ROOT, 'data/materials.json');
const SEGMENTS = path.join(ROOT, 'data/segments.json');
const AUDIO_ROOT = path.join(ROOT, 'assets/audio/L2');

/* ---------- 1. 解析转写文档 → 有序片段（含时间戳分段） ---------- */
function parseTranscript(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const clips = [];
  let cur = null;
  for (const ln of lines) {
    const h = /^(.+) \| (.+\.mp3)\s*$/.exec(ln);
    if (h) {
      cur = { folder: h[1], file: h[2], segments: [] };
      clips.push(cur);
      continue;
    }
    const s = /^(\d+):(\d+)~(\d+):(\d+), /.exec(ln);
    if (s && cur) {
      cur.segments.push({
        idx: cur.segments.length,
        start: Number(s[1]) * 60 + Number(s[2]),
        end: Number(s[3]) * 60 + Number(s[4]),
      });
    }
  }
  return clips;
}

/* ---------- 2. 编号与课程归属 ---------- */
function unitOf(folder) {
  const f = folder.trim();
  const unit = /^[Ll](\d+)$/.exec(f);                  // L4 / L7 / L9 → 独立单元
  if (unit) return { unit: 'L2-U' + unit[1], lessonTitle: 'L' + unit[1] + ' 单元', dir: 'U' + unit[1] };
  const lesson = /(\d+)/.exec(f);                      // Lesson 12 / lesson 7
  return { unit: 'L2-' + lesson[1], lessonTitle: 'Lesson' + lesson[1], dir: 'Lesson' + lesson[1] };
}

function titleOf(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/^\d+\s*/, '')            // 去掉文件名开头的题号
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- 3. 主流程 ---------- */
/* ⚠️ 转写文档里的片段顺序取自文件系统的字典序（Lesson1, Lesson10, … Lesson2, …），
   直接照抄会让站点课程列表乱序。这里显式改回数字序：课文按课号升序在前，
   L4/L7/L9 独立单元按单元号升序在后；同一课内保持文档里的原相对顺序。 */
function orderOf(folder) {
  const f = folder.trim();
  const u = /^[Ll](\d+)$/.exec(f);
  if (u) return [1, Number(u[1])];
  return [0, Number(/(\d+)/.exec(f)[1])];
}

const clips = parseTranscript(TRANSCRIPT)
  .map((c, i) => ({ ...c, oi: i }))
  .sort((a, b) => {
    const ka = orderOf(a.folder);
    const kb = orderOf(b.folder);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.oi - b.oi;
  });
const seen = {};
const lessonOrder = [];
const materials = [];
const segments = [];
const plan = [];

for (const c of clips) {
  const { unit, lessonTitle, dir } = unitOf(c.folder);
  seen[unit] = (seen[unit] || 0) + 1;
  const id = `${unit}.${seen[unit]}`;
  const srcFile = path.join(SRC, c.folder, c.file);
  if (!fs.existsSync(srcFile)) {
    console.error('源文件不存在：' + srcFile);
    process.exit(3);
  }
  const audio = `assets/audio/L2/${dir}/${id}.mp3`;
  if (!lessonOrder.some((l) => l.id === unit)) {
    lessonOrder.push({ level: 'L2', id: unit, title: lessonTitle });
  }
  materials.push({ id, level: 'L2', lesson: unit, title: titleOf(c.file), audio });
  segments.push({ materialId: id, segments: c.segments });
  plan.push({ id, srcFile, dest: path.join(ROOT, audio) });
}

console.log(`解析片段      : ${clips.length}`);
console.log(`课程数        : ${lessonOrder.length}  (${lessonOrder.map((l) => l.title).join(', ')})`);
console.log(`编号样例      : ${materials[0].id} … ${materials[materials.length - 1].id}`);

/* ---------- 4. 冲突检查（撞 id 就停，不静默覆盖） ---------- */
const mats = JSON.parse(fs.readFileSync(MATERIALS, 'utf8'));
const segs = JSON.parse(fs.readFileSync(SEGMENTS, 'utf8'));
const oldIds = new Set(mats.materials.map((m) => m.id));
const clash = materials.filter((m) => oldIds.has(m.id)).map((m) => m.id);
if (clash.length) {
  console.error('⛔ 编号与现有素材冲突，已中止：' + clash.join(', '));
  process.exit(4);
}
if (mats.materials.some((m) => m.level === 'L2')) {
  console.error('⛔ materials.json 里已有 L2 素材，本次不重复接入。先移除再跑。');
  process.exit(4);
}

/* ---------- 5. 备份 ---------- */
fs.copyFileSync(MATERIALS, `${MATERIALS}.bak-l2-${stamp}`);
fs.copyFileSync(SEGMENTS, `${SEGMENTS}.bak-l2-${stamp}`);
console.log(`备份          : materials.json.bak-l2-${stamp} / segments.json.bak-l2-${stamp}`);
const bakL1lessons = JSON.parse(fs.readFileSync(`${MATERIALS}.bak-l2-${stamp}`, 'utf8')).lessons;
const bakL1mats = JSON.parse(fs.readFileSync(`${MATERIALS}.bak-l2-${stamp}`, 'utf8')).materials;
const bakSegs = JSON.parse(fs.readFileSync(`${SEGMENTS}.bak-l2-${stamp}`, 'utf8'));

/* ---------- 6. 拷音频 ---------- */
let bytes = 0;
for (const p of plan) {
  fs.mkdirSync(path.dirname(p.dest), { recursive: true });
  fs.copyFileSync(p.srcFile, p.dest);
  bytes += fs.statSync(p.dest).size;
}
console.log(`拷贝音频      : ${plan.length} 个，共 ${(bytes / 1048576).toFixed(1)} MB → assets/audio/L2/`);

/* ---------- 7. 写数据 ---------- */
if (!mats.levels.includes('L2')) mats.levels.push('L2');
mats.lessons = mats.lessons.concat(lessonOrder);
mats.materials = mats.materials.concat(materials);
segs.push(...segments);

fs.writeFileSync(MATERIALS, JSON.stringify(mats, null, 2) + '\n', 'utf8');
fs.writeFileSync(SEGMENTS, JSON.stringify(segs, null, 2) + '\n', 'utf8');

/* ---------- 8. 回归：L1 必须一字未动 ---------- */
const after = JSON.parse(fs.readFileSync(MATERIALS, 'utf8'));
const afterL1lessons = after.lessons.filter((l) => l.level === 'L1');
const afterL1mats = after.materials.filter((m) => m.level === 'L1');
const sameLessons = JSON.stringify(afterL1lessons) === JSON.stringify(bakL1lessons);
const sameMats = JSON.stringify(afterL1mats) === JSON.stringify(bakL1mats);
const afterSegs = JSON.parse(fs.readFileSync(SEGMENTS, 'utf8'));
const sameSegs = JSON.stringify(afterSegs.slice(0, bakSegs.length)) === JSON.stringify(bakSegs);

console.log('');
console.log('回归检查：');
console.log(`  L1 lessons    : 改前 ${bakL1lessons.length} → 改后 ${afterL1lessons.length}  ${sameLessons ? 'PASS 一字未动' : 'FAIL 被改动'}`);
console.log(`  L1 materials  : 改前 ${bakL1mats.length} → 改后 ${afterL1mats.length}  ${sameMats ? 'PASS 一字未动' : 'FAIL 被改动'}`);
console.log(`  L1 段（segments 前 ${bakSegs.length} 条）: ${sameSegs ? 'PASS 一字未动' : 'FAIL 被改动'}`);
console.log(`  合计 lessons  : ${after.lessons.length}`);
console.log(`  合计 materials: ${after.materials.length}`);
console.log(`  合计 segments : ${afterSegs.length}`);
console.log(`  levels        : ${after.levels.join(' / ')}`);

process.exit(sameLessons && sameMats && sameSegs ? 0 : 1);
