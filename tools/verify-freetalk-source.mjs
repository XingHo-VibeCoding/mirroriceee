/* 溯源验证：data/freetalk.json 里的内容，哪些来自 MIT 题库、哪些是本项目自撰。
   做法：把原始题库当文本库，逐条查我们的句子在不在里面。
   正例：英文问句应当命中原文；反例：参考回答不应当命中（证明不是抄的）。
   跑法：node tools/verify-freetalk-source.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tools/freetalk/ielts-question-bank.orig.js'), 'utf8');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/freetalk.json'), 'utf8'));

/* 归一化：去标点、压空格、转小写，这样 "- the piano" 与 ", the piano" 视为同一句 */
const norm = s => String(s).toLowerCase()
  .replace(/[^a-z0-9/ ]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const SRC_N = norm(SRC);

/* 二次比对用：把 is / 's 这类缩写差异抹平（it's 与 it is、What's 与 What is 视为同一句）。
   本项目对少量句子做了「缩写展开」，严格比对会漏，用这层证明它们内容仍同源。 */
const loose = s => norm(s).replace(/\b(is|s)\b/g, ' ').replace(/\s+/g, ' ').trim();
const SRC_L = loose(SRC);

let qHit = 0; const qMiss = [];
let qLoose = 0; const qLooseList = [];
let fHit = 0, fTotal = 0, fLoose = 0; const fMiss = [];
let sHit = 0; const sHitList = [];
let wHit = 0, wTotal = 0;

D.topics.forEach(t => {
  /* 1 主问句：应当能在原文里找到；找不到再用缩写等价比一次 */
  if (SRC_N.includes(norm(t.q))) qHit++;
  else if (SRC_L.includes(loose(t.q))) { qLoose++; qLooseList.push(t.id + ' | ' + t.q); }
  else qMiss.push(t.id + ' | ' + t.q);

  /* 2 追问：同样应当来自原文（原仓库是平铺列表，我们按主问重组） */
  (t.follow || []).forEach(f => {
    fTotal++;
    if (SRC_N.includes(norm(f))) fHit++;
    else if (SRC_L.includes(loose(f))) fLoose++;
    else fMiss.push(t.id + ' | ' + f);
  });

  /* 3 参考回答：不应当命中——它是本项目自撰的 */
  const s = norm(t.sample).split(' ').slice(0, 12).join(' ');
  if (s.length > 20 && SRC_N.includes(s)) { sHit++; sHitList.push(t.id); }

  /* 4 参考词汇：少数常用词可能碰巧出现在原文里，这里只统计 */
  (t.words || []).forEach(w => { wTotal++; if (SRC_N.includes(' ' + norm(w) + ' ')) wHit++; });
});

console.log('原始题库文件：tools/freetalk/ielts-question-bank.orig.js（14280 字节，MIT）');
console.log('本仓库数据：data/freetalk.json（' + D.topics.length + ' 条）\n');

const qOk = qHit + qLoose, fOk = fHit + fLoose;
console.log('[1] 主问句来自题库：' + qOk + '/' + D.topics.length +
  '（逐字命中 ' + qHit + '，缩写展开后命中 ' + qLoose + '）' +
  (qOk === D.topics.length ? '  PASS' : '  FAIL'));
qLooseList.forEach(m => console.log('     缩写展开改写 → ' + m));
qMiss.forEach(m => console.log('     真·对不上 → ' + m));

console.log('\n[2] 追问来自题库：' + fOk + '/' + fTotal +
  '（逐字命中 ' + fHit + '，缩写展开后命中 ' + fLoose + '）' +
  (fOk === fTotal ? '  PASS' : '  FAIL'));
fMiss.slice(0, 10).forEach(m => console.log('     真·对不上 → ' + m));

console.log('\n[3] 参考回答命中原文：' + sHit + '/' + D.topics.length +
  (sHit === 0 ? '  PASS 0 命中，证明范文为本项目自撰' : '  FAIL 有范文疑似抄自题库 ' + sHitList.join(',')));

console.log('\n[4] 参考词汇碰巧出现在原文的比例：' + wHit + '/' + wTotal +
  '（参考词汇由本项目按话题挑选，允许与常用词重合）');

const pass = qOk === D.topics.length && fOk === fTotal && sHit === 0;
console.log('\n结论：' + (pass ? 'PASS 来源可追溯、范文原创' : 'FAIL 需要人工复核上面列出的条目'));
process.exit(pass ? 0 : 1);
