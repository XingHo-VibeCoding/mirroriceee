/* 修 bug：rename-lessons.mjs 当时只改了目录名、漏了目录里的文件名。
   现状：LessonN 目录里装的是 L(N+1).y.mp3（旧编号），而 materials.json 期望 LN.y.mp3。
   修：Lesson15~22 里的 L(N+1).y.mp3 → LN.y.mp3。
   运行：node tools/freetalk/fix-audio-filenames.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIO = path.join(ROOT, 'assets', 'audio');

let renamed = 0;
for (let n = 15; n <= 22; n++) {
  const dir = path.join(AUDIO, 'Lesson' + n);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^L(\d+)\.(\d+)\.mp3$/);
    if (m && Number(m[1]) === n + 1) {
      const newName = 'L' + n + '.' + m[2] + '.mp3';
      fs.renameSync(path.join(dir, f), path.join(dir, newName));
      renamed++;
    }
  }
}
console.log('重命名音频文件：', renamed, '个');

/* 校验：materials.json 里每条 audio 路径的文件是否真的存在 */
const mat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'materials.json'), 'utf8'));
const missing = mat.materials.filter((m) => !fs.existsSync(path.join(ROOT, m.audio)));
console.log('materials 音频路径校验：', mat.materials.length, '条，缺失', missing.length);
if (missing.length) missing.forEach((m) => console.log('  缺失:', m.id, m.audio));
