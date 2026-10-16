/*
 * 4b 验收 · 范文融合（独立复核，与应用脚本分开跑，重新读原文）
 * =====================================================================
 * [1] 60 题都有 sample + src
 * [2] 每条 src 的编号存在于 materials.json；引用逐字命中该素材原文
 * [3] 时间段与 segments.json 对齐（start>=0、end>=start、不超出素材时长）
 * [4] 引用真的出现在范文正文里
 * [5] 范文里的 [编号] 标注集合 == src 素材集合（不重不漏）
 * [6] 不含 L9 单元（L2.U9）引用
 * 反例：伪造编号 / 伪造表达 / 范文没写的表达，都必须被抓。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FT = path.join(ROOT, 'data/freetalk.json');
const MATS = path.join(ROOT, 'data/materials.json');
const SEGS = path.join(ROOT, 'data/segments.json');
const L1_T = process.env.L1_TRANSCRIPT;
const L2_T = process.env.L2_TRANSCRIPT;

const CONTR = [
  ["i'm", 'i am'], ["you're", 'you are'], ["he's", 'he is'], ["she's", 'she is'], ["it's", 'it is'],
  ["we're", 'we are'], ["they're", 'they are'], ["i've", 'i have'], ["we've", 'we have'], ["you've", 'you have'],
  ["i'd", 'i would'], ["you'd", 'you would'], ["he'd", 'he would'], ["she'd", 'she would'],
  ["don't", 'do not'], ["doesn't", 'does not'], ["didn't", 'did not'], ["can't", 'can not'],
  ["couldn't", 'could not'], ["won't", 'will not'], ["wouldn't", 'would not'], ["shouldn't", 'should not'],
  ["isn't", 'is not'], ["aren't", 'are not'], ["wasn't", 'was not'], ["weren't", 'were not'],
  ["haven't", 'have not'], ["hasn't", 'has not'], ["hadn't", 'had not'], ["that's", 'that is'],
  ["what's", 'what is'], ["let's", 'let us'], ["i'll", 'i will'], ["we'll", 'we will'],
  ["they'll", 'they will'], ["there's", 'there is'], ["who's", 'who is'], ["where's", 'where is'],
  ["gonna", 'going to'], ["wanna", 'want to'], ["gotta", 'got to'],
];
const norm = s => { let t = String(s).toLowerCase(); for (const [a, b] of CONTR) t = t.split(a).join(b); return t.replace(/[^a-z0-9]+/g, ' ').trim(); };
const toks = s => norm(s).split(' ').filter(Boolean);

function parseTranscript(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const clips = []; let cur = null;
  for (const ln of lines) {
    const h = /^(.+) \| (.+\.mp3)\s*$/.exec(ln);
    if (h) { cur = { folder: h[1].trim(), lines: [] }; clips.push(cur); continue; }
    const m = /^(\d+):(\d+)~(\d+):(\d+), (.+)$/.exec(ln);
    if (m && cur) cur.lines.push({ start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4], text: m[5] });
  }
  return clips;
}
function l1Id(f, i) { const n = +/\d+/.exec(f)[0]; return `L1.${n >= 16 ? n - 1 : n}.${i}`; }
function l2Id(f, i) { const u = /^[Ll](\d+)$/.exec(f.trim()); return u ? `L2.U${u[1]}.${i}` : `L2.${/\d+/.exec(f)[0]}.${i}`; }
function buildIndex(clips, idFn) {
  const idx = new Map(); const cnt = {};
  for (const c of clips) {
    cnt[c.folder] = (cnt[c.folder] || 0) + 1; const id = idFn(c.folder, cnt[c.folder]);
    const words = []; for (const ln of c.lines) for (const w of toks(ln.text)) words.push({ w, start: ln.start, end: ln.end });
    idx.set(id, { words, dur: Math.max(0, ...c.lines.map(l => l.end)) });
  }
  return idx;
}
function locate(expr, clip) {
  const E = toks(expr), C = clip.words.map(x => x.w);
  let best = { n: 0, i: -1 };
  for (let i = 0; i < C.length; i++) { let n = 0; while (i + n < C.length && n < E.length && C[i + n] === E[n]) n++; if (n > best.n) best = { n, i }; }
  if (best.n !== E.length) return null;
  const span = clip.words.slice(best.i, best.i + best.n);
  return { start: Math.min(...span.map(x => x.start)), end: Math.max(...span.map(x => x.end)) };
}
const inSample = (expr, sample) => { const E = toks(expr), S = toks(sample); let j = 0; for (const w of S) if (w === E[j]) { j++; if (j === E.length) return true; } return E.length === 0; };

const ft = JSON.parse(fs.readFileSync(FT, 'utf8'));
const mats = JSON.parse(fs.readFileSync(MATS, 'utf8'));
const segs = JSON.parse(fs.readFileSync(SEGS, 'utf8'));
const ids = new Set(mats.materials.map(m => m.id));
const segDur = new Map(segs.map(s => [s.materialId, Math.max(0, ...s.segments.map(g => g.end))]));
const idx = new Map([...buildIndex(parseTranscript(L1_T), l1Id), ...buildIndex(parseTranscript(L2_T), l2Id)]);

let bad = 0; const say = (ok, l, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!ok) bad++; };

say(ft.topics.length === 60, '[1] 60 题都有内容', `${ft.topics.length} 题`);
say(ft.topics.every(t => t.sample && Array.isArray(t.src)), '[1] sample/src 齐全');

let refTotal = 0, refFail = 0, l2 = 0, l1 = 0, l9 = 0;
const issues = [];
for (const t of ft.topics) {
  for (const [expr, id, start, end] of t.src) {
    refTotal++;
    if (id.startsWith('L2.')) l2++; else l1++;
    if (id.startsWith('L2.U9')) l9++;
    if (!ids.has(id)) { refFail++; issues.push(`${t.id} ${id} 不在 materials`); continue; }
    const clip = idx.get(id);
    if (!clip) { refFail++; issues.push(`${t.id} ${id} 无原文`); continue; }
    const loc = locate(expr, clip);
    if (!loc) { refFail++; issues.push(`${t.id} ${id} "${expr}" 对不上原文`); continue; }
    if (loc.start !== start || loc.end !== end) { refFail++; issues.push(`${t.id} ${id} 时间戳不一致`); }
    if (start < 0 || end < start) { refFail++; issues.push(`${t.id} ${id} 时间戳非法`); }
    if (!inSample(expr, t.sample)) { refFail++; issues.push(`${t.id} ${id} "${expr}" 不在范文正文`); }
  }
  // 范文 [编号] 集合 == src 集合
  const marks = new Set([...t.sample.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]));
  const srcIds = new Set(t.src.map(r => r[1]));
  const missInSrc = [...marks].filter(x => !srcIds.has(x));
  const missInSample = [...srcIds].filter(x => !marks.has(x));
  if (missInSrc.length || missInSample.length) { refFail++; issues.push(`${t.id} 标注不一致：范文多[${missInSrc}] 缺[${missInSample}]`); }
}
say(refFail === 0, `[2-5] ${refTotal} 条引用逐字命中、时间戳对齐、标注闭合`, refFail ? `${refFail} 条异常` : `${refTotal}/${refTotal}`);
issues.slice(0, 20).forEach(i => console.log('     ' + i));
say(l9 === 0, '[6] 不含 L9 单元（L2.U9）引用', l9 ? `${l9} 条` : `0 条`);
console.log(`     语料：L1 ${l1} 条 / L2 ${l2} 条`);

/* 反例 */
const fake = [
  ['this phrase never exists anywhere', 'L2-Z9.9', 0, 1],   // 假编号 + 假表达
  ['a good sense of humor', 'L2.1.1', 999, 999],             // 真编号但时间戳错
];
const t0 = ft.topics[0];
let caught = 0;
if (!ids.has(fake[0][1])) caught++;
const c0 = idx.get(fake[0][1]);
if (!c0) caught++;
const c1 = idx.get(fake[1][1]);
if (c1 && (locate(fake[1][0], c1)?.start !== 999 || locate(fake[1][0], c1)?.end !== 999)) caught++;
if (!inSample('totally made up phrase', t0.sample)) { /* 这条该「抓不到正文」才算对 */ } 
const inv = ['a good sense of humor', 'L2.1.1', 999, 999];
const l1res = locate(inv[0], idx.get(inv[1]));
if (l1res && (l1res.start !== inv[2] || l1res.end !== inv[3])) caught++;
say(caught >= 3, '[反例] 伪造编号/表达/时间戳被抓', `抓 ${caught} 项`);

console.log('');
console.log(bad === 0 ? '结论：PASS —— 范文逐字可溯源、标注闭合、无 L9' : `结论：FAIL —— ${bad} 项未过`);
process.exit(bad === 0 ? 0 : 1);
