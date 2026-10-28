/* ============================================
   lib/env.js —— 极简 .env 读取器（Day 32）

   为什么要自己写这 40 行，而不装 dotenv：
     整个项目至今【零生产依赖】（package.json 里没有 dependencies）。
     为了读一个 key=value 文本文件去引一个包，是拿"供应链风险 + 版本升级"
     换"少写 40 行"，不划算。规则本身也就这么多。

   三条必须写死的规矩（写错任何一条都会出现"明明填了却不生效"）：
     ① 真实环境变量优先，.env 只作补充 ——
        线上平台注入的密钥必须压过仓库里那份可能过期的 .env。
        这是"判断凭据取谁"的正确顺序，反过来就会出现线上用着本地旧 key 的怪事。
     ② 只认 KEY=VALUE，注释行（#）与空行直接跳过；
        key 不合法（含空格、中文、连字符）就整行丢弃，不做任何猜测。
     ③ 值两端的成对引号要去掉，但【只去一对】——
        值本身以引号开头结尾的情况很少，可真出现时不能越剥越少。

   ⚠️ 为什么不在文件顶部直接 console.log 加载结果：
      只报"读了几条"，绝不打印 key 名和值 —— 日志会被截图、会被发到群里。
   ============================================ */

const fs = require('fs');
const path = require('path');

/**
 * 读取 <rootDir>/.env，把里面的键值塞进 process.env。
 * @returns {number} 实际生效（此前不存在）的条数；文件不存在时返回 0
 */
function load(rootDir) {
  const file = path.join(rootDir, '.env');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return 0;                     /* 没有 .env 是完全正常的：线上靠环境变量 */
  }

  let applied = 0;

  raw.split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s || s.charAt(0) === '#') return;

    const eq = s.indexOf('=');
    if (eq < 1) return;           /* 没有等号，或 "=x" 这种没有键的，丢弃 */

    const key = s.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;

    let val = s.slice(eq + 1).trim();
    if (val.length >= 2) {
      const q = val.charAt(0);
      if ((q === '"' || q === "'") && val.charAt(val.length - 1) === q) {
        val = val.slice(1, -1);
      }
    }

    /* ① 真实环境变量优先：已经有了就一个字都不动 */
    if (process.env[key] === undefined) {
      process.env[key] = val;
      applied++;
    }
  });

  return applied;
}

module.exports = { load: load };
