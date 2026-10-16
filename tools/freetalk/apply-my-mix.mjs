/*
 * 4b 应用脚本：把 my-mix-data.json 的 60 篇范文写回 data/freetalk.json。
 * =====================================================================
 * 关键：引用必须逐字命中转写原文，时间戳从原文取（不猜、不硬编码）。
 *   - L1（星一班）编号「Lesson16 起 -1」归一后，套 L1.课号.片段号；
 *   - L2（高级班）用 L2.课号.片段号 / L2.U单元号.片段号。
 * 反例：引用词形对不上、或范文里根本没写这句，都要被标出来，不许静默通过。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'tools/freetalk/my-mix-data.json');
const L1_T = process.env.L1_TRANSCRIPT;
const L2_T = process.env.L2_TRANSCRIPT;
const FREETALK = path.join(ROOT, 'data/freetalk.json');

if (!L1_T || !L2_T) { console.error('需要 L1_TRANSCRIPT / L2_TRANSCRIPT'); process.exit(2); }

/* ---------- 归一化与分词（展开缩写，容忍大小写/标点差异） ---------- */
const CONTR = [
  ["i'm", 'i am'], ["you're", 'you are'], ["he's", 'he is'], ["she's", 'she is'],
  ["it's", 'it is'], ["we're", 'we are'], ["they're", 'they are'],
  ["i've", 'i have'], ["we've", 'we have'], ["you've", 'you have'],
  ["i'd", 'i would'], ["you'd", 'you would'], ["he'd", 'he would'], ["she'd", 'she would'],
  ["don't", 'do not'], ["doesn't", 'does not'], ["didn't", 'did not'],
  ["can't", 'can not'], ["couldn't", 'could not'], ["won't", 'will not'],
  ["wouldn't", 'would not'], ["shouldn't", 'should not'], ["isn't", 'is not'],
  ["aren't", 'are not'], ["wasn't", 'was not'], ["weren't", 'were not'],
  ["haven't", 'have not'], ["hasn't", 'has not'], ["hadn't", 'had not'],
  ["that's", 'that is'], ["what's", 'what is'], ["let's", 'let us'],
  ["i'll", 'i will'], ["we'll", 'we will'], ["they'll", 'they will'],
  ["there's", 'there is'], ["who's", 'who is'], ["where's", 'where is'],
  ["gonna", 'going to'], ["wanna", 'want to'], ["gotta", 'got to'],
];
function norm(s) {
  let t = String(s).toLowerCase();
  for (const [a, b] of CONTR) t = t.split(a).join(b);
  return t.replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(s) { return norm(s).split(' ').filter(Boolean); }

/* ---------- 解析转写 → 片段 {folder, file, lines:[{start,end,text}]} ---------- */
function parseTranscript(p) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const clips = []; let cur = null;
  for (const ln of lines) {
    const h = /^(.+) \| (.+\.mp3)\s*$/.exec(ln);
    if (h) { cur = { folder: h[1].trim(), file: h[2], lines: [] }; clips.push(cur); continue; }
    const m = /^(\d+):(\d+)~(\d+):(\d+), (.+)$/.exec(ln);
    if (m && cur) cur.lines.push({
      start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4], text: m[5],
    });
  }
  return clips;
}

/* ---------- L1 编号：Lesson16 起 -1，与 materials.json 对齐 ---------- */
function l1Id(folder, idx) {
  const n = +/\d+/.exec(folder)[0];
  const m = n >= 16 ? n - 1 : n;
  return `L1.${m}.${idx}`;
}
/* L2 编号：课文 L2.课号.片段号；L4/L7 独立单元 L2.U单元号.片段号 */
function l2Id(folder, idx) {
  const f = folder.trim();
  const u = /^[Ll](\d+)$/.exec(f);
  if (u) return `L2.U${u[1]}.${idx}`;
  return `L2.${/\d+/.exec(f)[0]}.${idx}`;
}

/* ---------- 建索引：id → [{w,start,end}] ---------- */
function buildIndex(clips, idFn) {
  const idx = new Map();
  const cnt = {};
  for (const c of clips) {
    cnt[c.folder] = (cnt[c.folder] || 0) + 1;
    const id = idFn(c.folder, cnt[c.folder]);
    const words = [];
    for (const ln of c.lines) for (const w of tokens(ln.text)) words.push({ w, start: ln.start, end: ln.end });
    idx.set(id, { folder: c.folder, file: c.file, words, text: c.lines.map(l => l.text).join(' ') });
  }
  return idx;
}

/* ---------- 在 clip 里定位 expr：返回 {ok, ratio, start, end} ---------- */
function locate(expr, clip) {
  const E = tokens(expr);
  const C = clip.words.map(x => x.w);
  let best = { n: 0, i: -1 };
  for (let i = 0; i <= C.length - 1; i++) {
    let n = 0;
    while (i + n < C.length && n < E.length && C[i + n] === E[n]) n++;
    if (n > best.n) best = { n, i };
  }
  if (best.n === 0 || E.length === 0) return { ok: false, ratio: 0, start: 0, end: 0, matched: best.n, total: E.length };
  const span = clip.words.slice(best.i, best.i + best.n);
  return {
    ok: best.n === E.length, ratio: best.n / E.length,
    start: Math.min(...span.map(x => x.start)), end: Math.max(...span.map(x => x.end)),
    matched: best.n, total: E.length,
  };
}
/* expr 是否出现在范文里（词序列，按序子序列即可，容忍中间插词） */
function inSample(expr, sample) {
  const E = tokens(expr); const S = tokens(sample);
  let j = 0;
  for (const w of S) if (w === E[j]) { j++; if (j === E.length) return true; }
  return E.length === 0;
}

/* ---------- 主流程 ---------- */
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const L1 = buildIndex(parseTranscript(L1_T), l1Id);
const L2 = buildIndex(parseTranscript(L2_T), l2Id);
const idx = new Map([...L1, ...L2]);

let fail = 0, total = 0;
const problems = [];
const resolved = [];

for (const topic of data) {
  const src = [];
  for (const [expr, id] of topic.refs) {
    total++;
    const clip = idx.get(id);
    if (!clip) { fail++; problems.push(`${topic.id} [${id}] 编号不存在`); continue; }
    const loc = locate(expr, clip);
    if (!loc.ok) {
      fail++; problems.push(`${topic.id} [${id}] "${expr}" 命中 ${loc.matched}/${loc.total} 词 — 原文：${clip.text.slice(0, 90)}`);
    } else if (!inSample(expr, topic.sample)) {
      fail++; problems.push(`${topic.id} [${id}] "${expr}" 不在范文正文里`);
    } else {
      src.push([expr, id, loc.start, loc.end]);
    }
  }
  resolved.push({ id: topic.id, sample: topic.sample, src });
}

console.log(`引用总数 ${total}，解析成功 ${total - fail}，失败 ${fail}`);
problems.slice(0, 40).forEach(p => console.log('  ✗ ' + p));
if (fail) { console.error(`\n有 ${fail} 处未解析，已中止，未写回 freetalk.json`); process.exit(1); }

/* ---------- 写回 freetalk.json ---------- */
const ft = JSON.parse(fs.readFileSync(FREETALK, 'utf8'));
const byId = new Map(ft.topics.map(t => [t.id, t]));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(FREETALK, `${FREETALK}.bak-mymix-${stamp}`);
const topics = resolved.map(r => Object.assign({}, byId.get(r.id), { sample: r.sample, src: r.src }));
ft.topics = topics;
ft.meta.mixNote = '范文语料池 = 星一班 L1（47 段）+ 高级班 L2（56 段，已剔除 L9 单元），两批混用；src 四元组 [表达, 编号, 起始秒, 结束秒]，逐字命中原文';
fs.writeFileSync(FREETALK, JSON.stringify(ft, null, 2) + '\n', 'utf8');
console.log(`已写回 ${topics.length} 条，备份 ${FREETALK}.bak-mymix-${stamp}`);
process.exit(0);
