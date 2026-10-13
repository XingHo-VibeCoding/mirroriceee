/* ============================================
   lib/auth.js —— 认证的【纯加密逻辑】（Day 28）

   为什么单独一个文件、而且它连 lib/rdb.js 都不 require：
     这个文件里全是「算」：密码哈希、随机 token、验证码签名。
     它不碰数据库、不碰 HTTP、不读环境变量（密钥由接口层递进来）。
     ⇒ 好处一：本地 node 就能测（不用起云函数、不用连库）；
       好处二：算法要升级（比如换参数、换编码）只动这里，
       接口层和仓库层一行不改。

   术语备注（斌哥第一次见的东西，一个一个说清）：
     scrypt —— 一种"故意算得慢"的密码哈希算法。密码为什么不能快？
               快的话，别人偷走库里那串哈希，一秒能试上亿个密码（暴力破解）。
               scrypt 每算一次都要花约 50ms 和 16MB 内存，试密码的速度
               被硬生生摁到每秒十几次 —— 这就是它的全部意义。
               它是 Node 自带的（crypto 模块），不用装任何包。
     salt   —— 盐：一串随机数，和密码搅在一起再哈希。
               没有盐的话，两个用户密码相同 → 哈希也相同，一眼看穿；
               加了盐，同样的密码每人算出来都不一样。盐不保密，跟哈希存一起。
     HMAC   —— 带密钥的哈希：只有拿着同一把密钥的人才能算出/验证这个值。
               验证码的答案就靠它锁住（见下）。
     timingSafeEqual —— "恒时比较"。普通的 === 比较字符串，遇到第一个不同的字符
               就返回，比较耗时能泄露"错在第几位"；恒时比较不管对错都花一样的时间，
               把这条旁门侧路堵死。凡是比密钥/哈希，都用它。
   ============================================ */

var crypto = require('crypto');

/* ---------------------------------------------------------------------------
   一、密码哈希（scrypt）
   --------------------------------------------------------------------------- */

/* 存储格式：s1$<盐十六进制>$<哈希十六进制>
   开头的 s1 是版本号 —— 将来要换算法/换参数，老数据还能认出来，
   新数据用新版本，登录时按版本分别验证。没有版本号 = 升级即断粮。 */
var HASH_VERSION = 's1';

/* scrypt 输出长度 64 字节。盐 16 字节（128 位）——足够唯一，不省这点。 */
var HASH_BYTES = 64;
var SALT_BYTES = 16;

/* 把明文密码算成存储格式。
   ⚠️ 这个函数【只在两处】被调：注册时、改密码时（本期只有注册）。
      明文密码用完即弃，绝不落库、绝不打日志。 */
function hashPassword(password) {
  var salt = crypto.randomBytes(SALT_BYTES);
  var hash = crypto.scryptSync(String(password), salt, HASH_BYTES);
  return HASH_VERSION + '$' + salt.toString('hex') + '$' + hash.toString('hex');
}

/* 验证密码：按存储格式把盐拆出来，用同样的盐把用户这次输的密码重算一遍，
   两个哈希恒时比对。一致 = 密码对。
   ⚠️ 存储串被人为改坏（格式不对）时返回 false 而不是抛错 ——
      坏数据不该炸接口，更不该把错误细节漏给调用方。 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  var parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== HASH_VERSION) return false;

  var salt, expect;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expect = Buffer.from(parts[2], 'hex');
  } catch (e) {
    return false;
  }
  if (salt.length === 0 || expect.length === 0) return false;

  var actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expect.length);
  } catch (e) {
    return false;
  }
  return timingSafeEq(actual, expect);
}

/* 恒时比较（内部用）。长度不同的两个串没法恒时比，先比长度 ——
   长度本身不算秘密（哈希长度是固定的），这里兜住即可。 */
function timingSafeEq(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------------------
   二、登录令牌（token）
   --------------------------------------------------------------------------- */

/* 32 字节纯随机 → 64 位十六进制，正好对上 sessions.token varchar(64)。
   ⚠️ 为什么不用时间戳/自增数当 token：那能被猜。token 的全部安全性
      就在"猜不到"这三个字上，所以必须是密码学安全的随机数。 */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ---------------------------------------------------------------------------
   三、图形验证码（签发 + 校验 + 画图）

   难点只有一个：服务端是【无状态】的 —— 验证码发出去之后，云函数不存任何
   "刚才发了什么"（不加表）。答案怎么在发出去之后还能被校验？
   做法：把答案的 HMAC 和过期时刻一起打包，用密钥签名，整包当 captchaId 发出去：

     captchaId = base64url({h: HMAC(密钥, 答案), e: 过期时刻}) + '.' + HMAC(密钥, 前半段)

   用户提交时带回来，服务端只做三件事：验签（没被改过）→ 看过期 → 比对答案。
   全程不查库、不占存储。⚠️ 答案在包里放的是 HMAC 不是明文 ——
   base64 谁都能解开，放明文等于把答案印在票面上。
   --------------------------------------------------------------------------- */

/* 去掉人眼最容易认错的一批字符（0/O、1/I/L）—— 图形验证码本来就糊，
   再放几个"长得一样"的进去，就是故意刁难用户，不是安全。 */
var CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var CAPTCHA_LEN = 4;

function genCaptchaText() {
  var out = '';
  for (var i = 0; i < CAPTCHA_LEN; i++) {
    out += CAPTCHA_ALPHABET[crypto.randomInt(CAPTCHA_ALPHABET.length)];
  }
  return out;
}

/* base64url：标准 base64 里的 + / = 在 URL 和 JSON 里都得转义，麻烦；
   换成 URL 安全的字母表，token 类字符串一律用它。 */
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4 !== 0) str += '=';
  return Buffer.from(str, 'base64');
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', String(secret)).update(String(text)).digest('hex');
}

/* 签发。返回 { captchaId } —— 答案本身只进 SVG 图片，绝不进 captchaId 明文。 */
function signCaptcha(answer, secret, ttlMs) {
  var payload = b64url(JSON.stringify({
    h: hmacHex(secret, 'captcha:' + String(answer).toLowerCase()),
    e: Date.now() + ttlMs
  }));
  return { captchaId: payload + '.' + hmacHex(secret, payload) };
}

/* 校验。返回 {ok:true} 或 {ok:false, reason}（reason 只区分三种，进日志用）：
   bad_format（包都拆不开）/ bad_sig（签名对不上 = 被篡改）/ expired（过期）。 */
function verifyCaptcha(captchaId, input, secret) {
  if (typeof captchaId !== 'string' || captchaId.indexOf('.') === -1) {
    return { ok: false, reason: 'bad_format' };
  }
  var dot = captchaId.lastIndexOf('.');
  var payload = captchaId.slice(0, dot);
  var sig = captchaId.slice(dot + 1);

  /* ① 验签：包体只要改了一个字符，签名就对不上。恒时比较。 */
  if (!timingSafeEq(Buffer.from(hmacHex(secret, payload)), Buffer.from(String(sig)))) {
    return { ok: false, reason: 'bad_sig' };
  }

  var data;
  try {
    data = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'bad_format' };
  }
  if (!data || typeof data.h !== 'string' || typeof data.e !== 'number') {
    return { ok: false, reason: 'bad_format' };
  }

  /* ② 过期。 */
  if (Date.now() > data.e) {
    return { ok: false, reason: 'expired' };
  }

  /* ③ 比对答案（不区分大小写 —— 用户看着图片抄，大小写本来就是瞎猜）。 */
  if (!timingSafeEq(
        Buffer.from(data.h),
        Buffer.from(hmacHex(secret, 'captcha:' + String(input || '').toLowerCase())))) {
    return { ok: false, reason: 'answer' };
  }

  return { ok: true };
}

/* 画一张 SVG。四个字符各自随机旋转 / 上下抖动 / 换颜色，
   再铺几条干扰线和噪点。⚠️ 诚实说明：SVG 里的字符仍是文本节点，
   会写解析器的人挡不住 —— 它挡的是"随手提交的机器"，不是专业刷子。 */
function renderCaptchaSvg(text) {
  var W = 132, H = 46;
  var palette = ['#0f6e56', '#1a2c73', '#b4531f', '#5f4b8b'];
  var i, x, y, r, part = [];

  /* 干扰线：先画，垫在字符底下 */
  for (i = 0; i < 4; i++) {
    part.push('<path d="M0 ' + (8 + Math.random() * 30).toFixed(1) +
      ' Q ' + (W / 2).toFixed(1) + ' ' + (Math.random() * H).toFixed(1) +
      ' ' + W + ' ' + (8 + Math.random() * 30).toFixed(1) +
      '" fill="none" stroke="#dfe1e6" stroke-width="1.4"/>');
  }

  /* 字符：每个单独定位 / 旋转 / 着色 */
  for (i = 0; i < text.length; i++) {
    x = 14 + i * ((W - 28) / (text.length - 1)) + (Math.random() * 6 - 3);
    y = H / 2 + 9 + (Math.random() * 8 - 4);
    r = Math.random() * 44 - 22;
    part.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
      '" transform="rotate(' + r.toFixed(1) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"' +
      ' font-family="Georgia, serif" font-size="' + (24 + Math.random() * 6).toFixed(0) +
      '" font-weight="700" fill="' + palette[i % palette.length] + '">' +
      text[i] + '</text>');
  }

  /* 噪点 */
  for (i = 0; i < 26; i++) {
    part.push('<circle cx="' + (Math.random() * W).toFixed(1) +
      '" cy="' + (Math.random() * H).toFixed(1) +
      '" r="1" fill="#c9ced6"/>');
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="验证码图片">' +
    '<rect width="100%" height="100%" fill="#f4f5f7"/>' + part.join('') + '</svg>';
}

/* ⚠️ 对外只给这些名字。明文密码和验证码答案都只在入参/返回里过一手，
   不写日志、不进任何存储 —— 这是本文件最后一条，也是最要紧的一条。 */
module.exports = {
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  newToken: newToken,
  genCaptchaText: genCaptchaText,
  signCaptcha: signCaptcha,
  verifyCaptcha: verifyCaptcha,
  renderCaptchaSvg: renderCaptchaSvg
};
