/* 校验 data/freetalk.json：JSON 合法性 + 条数 + 每条必填字段 + 分类闭合 + id 唯一 */
import fs from 'fs';
const p = new URL('../data/freetalk.json', import.meta.url);
const raw = fs.readFileSync(p, 'utf8');

let d;
try { d = JSON.parse(raw); } catch (e) { console.log('FAIL JSON 解析：', e.message); process.exit(1); }
console.log('PASS JSON 合法，文件大小', (raw.length / 1024).toFixed(1) + ' KB');

const T = d.topics;
console.log('声明条数 meta.count =', d.meta.count, '｜实际条数 =', T.length,
  d.meta.count === T.length ? 'PASS' : 'FAIL');

const need = ['id', 'part', 'cat', 'level', 'q', 'zh', 'follow', 'words', 'tips', 'sample'];
let bad = 0;
T.forEach((t, i) => {
  const miss = need.filter(k => !t[k] || (Array.isArray(t[k]) && t[k].length === 0));
  if (miss.length) { console.log('FAIL', t.id, '缺字段', miss.join(',')); bad++; }
  if (t.follow && t.follow.length < 2) { console.log('WARN', t.id, '追问少于 2 条'); }
  if (t.sample && t.sample.split(/\s+/).length < 35) { console.log('WARN', t.id, '范文偏短', t.sample.split(/\s+/).length, '词'); }
});
console.log(bad === 0 ? 'PASS 60 条字段齐全' : 'FAIL 有 ' + bad + ' 条缺字段');

const ids = new Set(T.map(t => t.id));
console.log(ids.size === T.length ? 'PASS id 唯一' : 'FAIL id 有重复');

const catIds = new Set(d.cats.map(c => c.id));
const used = new Set(T.map(t => t.cat));
const orphan = [...used].filter(c => !catIds.has(c));
console.log(orphan.length === 0 ? 'PASS 分类 id 全部在 cats 里定义' : 'FAIL 未定义分类 ' + orphan.join(','));

const byPart = {}, byCat = {}, byLevel = {};
T.forEach(t => {
  byPart[t.part] = (byPart[t.part] || 0) + 1;
  byCat[t.cat] = (byCat[t.cat] || 0) + 1;
  byLevel[t.level] = (byLevel[t.level] || 0) + 1;
});
console.log('分布 part  ', JSON.stringify(byPart));
console.log('分布 cat   ', JSON.stringify(byCat));
console.log('分布 level ', JSON.stringify(byLevel));
const wc = T.reduce((s, t) => s + t.sample.split(/\s+/).length, 0);
console.log('范文总词数', wc, '平均', Math.round(wc / T.length), '词/条');
