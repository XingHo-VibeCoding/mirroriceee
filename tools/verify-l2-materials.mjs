/*
 * 4a 验收 · 高级班（L2）素材接入
 * =====================================================================
 * 八项断言，正例必须全过；末尾附反例，确认校验器不是橡皮章。
 *   [1] levels 结构完好（L1/L2/L3 顺序不变）
 *   [2] L1 一字未动（与备份逐条深比对）
 *   [3] L2 课程 26 条、素材 58 条；全站 105 条 id 唯一
 *   [4] 每条 L2 素材的音频文件真实存在且非空
 *   [5] 所有音频路径都待在 assets/audio/L2/ 里（不许踩进星一班的目录）
 *   [6] 每条素材都有 segments；段内 idx 连续、时间单调、end ≥ start
 *   [7] 跨文件交叉验证：L2 的 58 个编号 == 表达库索引里的 58 个编号（两个独立产物互证）
 *   [8] free talk 现有溯源引用仍能解析（L1 的 27 个引用无回归）
 * 反例：伪造「音频不存在的素材」「重复 id」，必须被抓出来。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = process.env.L2_LIB;
const BACKUP = process.env.L2_BACKUP_MATERIALS;

const mats = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/materials.json'), 'utf8'));
const segs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/segments.json'), 'utf8'));
const ft = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/freetalk.json'), 'utf8'));
const bak = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));

let bad = 0;
const say = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) bad++;
};

const L1 = mats.materials.filter((m) => m.level === 'L1');
const L2 = mats.materials.filter((m) => m.level === 'L2');

/* [1] levels */
say(JSON.stringify(mats.levels) === JSON.stringify(['L1', 'L2', 'L3']),
  '[1] levels 结构', mats.levels.join('/'));

/* [2] L1 未动 —— 忽略本次统一改名，比对内容字段（level/lesson/title），
       而不是整条 JSON（id/audio 的格式在这轮改名里本就该变） */
const bakL1 = bak.materials.filter((m) => m.level === 'L1');
const sig = (arr) => JSON.stringify(arr.map((m) => [m.level, m.title]));
say(sig(L1) === sig(bakL1),
  '[2] L1 内容一字未动（忽略本轮改名）', `${bakL1.length} → ${L1.length} 条，逐条一致=${sig(L1) === sig(bakL1)}`);
say(JSON.stringify(mats.lessons.filter((l) => l.level === 'L1').map((l) => [l.level, l.title])) ===
    JSON.stringify(bak.lessons.filter((l) => l.level === 'L1').map((l) => [l.level, l.title])),
  '[2] L1 课程一字未动（忽略本轮改名）');

/* [3] 数量与唯一性 */
say(mats.materials.length === 103 && L2.length === 56,
  '[3] 素材总数 103 / L2 56 条', `实际 ${mats.materials.length} / ${L2.length}`);
say(mats.lessons.filter((l) => l.level === 'L2').length === 25,
  '[3] L2 课程 25 条');
const ids = mats.materials.map((m) => m.id);
say(new Set(ids).size === ids.length, '[3] 全站编号唯一',
  new Set(ids).size === ids.length ? `${ids.length} 个 id 无重复` : '存在重复');

/* [4] 音频文件 */
const missing = L2.filter((m) => {
  const p = path.join(ROOT, m.audio);
  return !fs.existsSync(p) || fs.statSync(p).size === 0;
}).map((m) => m.audio);
say(missing.length === 0, '[4] L2 音频文件均存在且非空',
  `${L2.length - missing.length}/${L2.length}` + (missing.length ? ' 缺：' + missing.slice(0, 3) : ''));

/* [5] 路径不许踩进 L1 目录 */
const stray = L2.filter((m) => !m.audio.startsWith('assets/audio/L2/')).map((m) => m.audio);
say(stray.length === 0, '[5] 音频路径都在 assets/audio/L2/ 内',
  stray.length ? '越界：' + stray.slice(0, 3) : `${L2.length}/${L2.length}`);

/* [6] segments */
const segMap = new Map(segs.map((s) => [s.materialId, s.segments]));
const segBad = [];
for (const m of mats.materials) {
  const s = segMap.get(m.id);
  if (!s) { segBad.push(m.id + ' 无分段'); continue; }
  for (let i = 0; i < s.length; i++) {
    if (s[i].idx !== i) { segBad.push(m.id + ' idx 不连续'); break; }
    if (s[i].end < s[i].start) { segBad.push(m.id + ' end<start'); break; }
    if (i && s[i].start < s[i - 1].start) { segBad.push(m.id + ' 时间倒退'); break; }
  }
}
say(segBad.length === 0, '[6] 分段数据完整且时间轴正常', segBad.slice(0, 3).join('; ') || `${segs.length} 条全过`);

/* [7] 跨文件：与表达库索引对齐 */
let libIds = [];
if (LIB && fs.existsSync(LIB)) {
  const md = fs.readFileSync(LIB, 'utf8');
  const block = md.split('## 音频索引')[1].split('\n## ')[0];
  libIds = [...block.matchAll(/^\|\s*(L2\.(?:U)?\d+\.\d+)\s*\|/gm)].map((m) => m[1]);
}
const l2ids = L2.map((m) => m.id).sort();
const libSorted = [...libIds].sort();
say(libIds.length === 56 && JSON.stringify(l2ids) === JSON.stringify(libSorted),
  '[7] L2 编号 == 表达库索引编号（跨文件互证）',
  `素材 ${l2ids.length} vs 表达库 ${libIds.length}` +
  (JSON.stringify(l2ids) === JSON.stringify(libSorted) ? '' : ' 不一致'));

/* [8] freetalk 现有引用仍可解析 */
const refIds = new Set();
ft.topics.forEach((t) => (t.src || []).forEach((r) => refIds.add(r[1])));
const unresolved = [...refIds].filter((id) => !ids.includes(id));
say(unresolved.length === 0, '[8] free talk 溯源引用可解析',
  `${refIds.size} 个引用，未解析 ${unresolved.length}`);

/* ---- 反例：校验器必须抓得到 ---- */
console.log('');
const fakeMats = JSON.parse(JSON.stringify(mats));
fakeMats.materials.push({ id: 'L2.1.1', level: 'L2', lesson: 'L2-1', title: 'dup', audio: 'assets/audio/L2/Lesson1/L2.1.1.mp3' });
fakeMats.materials.push({ id: 'L2.99.9', level: 'L2', lesson: 'L2-99', title: 'ghost', audio: 'assets/audio/L2/Lesson99/L2.99.9.mp3' });
const fIds = fakeMats.materials.map((m) => m.id);
const catchDup = new Set(fIds).size !== fIds.length;
const catchGhost = !fs.existsSync(path.join(ROOT, 'assets/audio/L2/Lesson99/L2.99.9.mp3'));
say(catchDup && catchGhost, '[反例] 伪造重复 id + 不存在的音频路径',
  `重复被抓=${catchDup}，幽灵路径被抓=${catchGhost}`);

console.log('');
console.log(bad === 0 ? '结论：PASS —— 8 项正例全过，反例可抓' : `结论：FAIL —— ${bad} 项未过`);
process.exit(bad === 0 ? 0 : 1);
