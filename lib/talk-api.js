/* ============================================
   lib/talk-api.js —— 「AI 对话」后端三条路由（Day 32）

   这个文件承担三件事：
     GET  /api/talk/health   告诉你密钥配没配（不撒谎，缺就说缺）
     POST /api/talk/asr      一段 wav → 一句话识别 → 文字
     POST /api/talk/analyze  学生这句话 → DeepSeek 流式批改（SSE）

   为什么放在这里、而不是塞进 dev-server.js：
     dev-server.js 已经 300 行，管的是"静态文件 + Range + /api 同源代理"，
     再塞进签名、prompt、SSE 会变成谁都不敢改的一坨。拆成模块，
     但【仍由 dev-server 在服务端 require】，线上 server.js 是 require 它的，
     所以本地和线上跑的是同一份代码，不会出现"本地好的线上坏"。

   ⚠️ 为什么把文件放在 lib/ 下：
     发布是整目录上传，仓库里有什么就传什么。Day 24 已经吃过一次亏 ——
     cloudfunctions/ 被公网直接下载（200），接口逻辑一览无余。
     所以 lib/ 已加进 dev-server.js 的 BLOCKED_PATH_PREFIX，浏览器取不到。

   ⚠️⚠️ 密钥只在这一层用，前端【一个字符都拿不到】：
     浏览器只知道 /api/talk/*，不知道腾讯云和 DeepSeek 存在。
   ============================================ */

const https = require('https');
const crypto = require('crypto');

/* ---------- 一、外部服务的固定地址 ---------- */

/* 一句话识别：这是【地域无关】的接口，但签名仍要求带一个 Region。
   ap-shanghai 与项目 CloudBase 环境同区，网络路径最短。 */
const ASR_HOST = 'asr.tencentcloudapi.com';
const ASR_SERVICE = 'asr';
const ASR_VERSION = '2019-06-14';
const ASR_REGION = 'ap-shanghai';

/* DeepSeek 走 OpenAI 兼容协议，所以前端那套 `data: {"choices":[...]}` 解析
   可以原样用 —— 我们只做搬运，不做协议转换。 */
const LLM_HOST = 'api.deepseek.com';
const LLM_PATH = '/chat/completions';

/* ---------- 二、护栏（都是钱） ---------- */

const MAX_BODY = 8 * 1024 * 1024;   /* 45 秒 16k 单声道 wav ≈ 1.4MB，base64 后约 1.9MB；
                                       留到 8MB 是给"录满 60 秒 + 浏览器多算了一点"兜底 */
const MAX_TEXT = 2000;              /* 学生一句话的字数上限，防有人贴一整篇文章进来烧 token */
const MAX_AUDIO = 5 * 1024 * 1024;  /* 腾讯云一句话识别的单次音频上限 */
const RATE_MAX = 60;                /* 每分钟全站最多 60 次 AI 请求 */

/* ⚠️ 为什么是"全站合计"而不是"每人"：
     线上多一层平台反向代理，req.socket.remoteAddress 拿到的是【代理的 IP】，
     所有学生看着都像同一个人 —— 按 IP 限流会把全班算成一个人。
     与其写一个"看起来按人限流、实际按全局限流"的假象，不如老实做一个全局闸门，
     并在提示里说清楚。真要做按人限流，得先有登录态，那是下一步的事。 */
let bucket = { start: 0, n: 0 };

function rateOK() {
  const now = Date.now();
  if (now - bucket.start > 60000) { bucket.start = now; bucket.n = 0; }
  bucket.n++;
  return bucket.n <= RATE_MAX;
}

/* ---------- 三、小工具 ---------- */

function env(key, dflt) {
  const v = process.env[key];
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  return s || dflt || '';
}

function hasAsr() {
  return !!(env('TENCENT_SECRET_ID') && env('TENCENT_SECRET_KEY'));
}

function hasLlm() {
  return !!env('DEEPSEEK_API_KEY');
}

/* 带 HTTP 状态和错误码的异常。前端认 code（新接口）与 error（云函数老接口）两个名字 */
function apiError(code, message, status) {
  const e = new Error(message);
  e.apiCode = code;
  e.status = status || 400;
  return e;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* 把超长文本截断 —— 不是"防君子"，是防止一段 10 万字的粘贴把 token 直接打穿 */
function clip(v, max) {
  const s = String(v === undefined || v === null ? '' : v);
  return s.length > max ? s.slice(0, max) : s;
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    let aborted = false;
    const chunks = [];

    req.on('data', function (c) {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        aborted = true;
        chunks.length = 0;          /* 超限就立刻放掉已收的，不为一个坏请求留内存 */

        /* ⚠️ 这里只能 reject + pause，【绝对不能】req.destroy()：
           一旦 destroy，socket 就没了，后面 catch 想回一个 413 JSON 时
           res 已经写不出去 —— 浏览器看到的是"连接被重置"，而不是"太大了"。
           pause() 让入站数据停在 TCP 缓冲里，客户端上传自然卡住，
           我们从容把错误回完，Node 收尾时再关连接。
           （这条是实测时想清楚的：让用户看得懂错误，比省那点流量重要。） */
        req.pause();
        reject(apiError('payload_too_large',
          '上传内容太大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）', 413));
        return;
      }
      chunks.push(c);
    });

    req.on('end', function () {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', function (err) {
      if (!aborted) reject(apiError('network_error', '读请求体失败：' + err.message, 400));
    });
  });
}

async function readJSON(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) throw apiError('empty_body', '请求体是空的', 400);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw apiError('bad_json', '请求体不是合法 JSON', 400);
  }
}

/* ---------- 四、腾讯云 TC3-HMAC-SHA256 签名 ----------
   这是整条链路最容易写错的一环，把每个"为什么"都写在这儿，
   下次改代码不用再去翻那篇几十页的官方文档：

   ① 日期必须是【UTC 日期】（YYYY-MM-DD），不是本地日期。
      本地是东八区，晚上 8 点之后 UTC 已经是第二天 —— 用本地日期签，
      每天有 8 小时窗口会报 SignatureFailure，且时好时坏极难排查。
   ② 参与签名的 CanonicalHeaders 必须与真正发出去的请求头【一字不差】，
      content-type 写 `application/json; charset=utf-8` 就必须发一模一样的，
      少个空格都签不过。所以这里把常量抽出来，签名与发送共用同一个值。
   ③ 签名密钥是一层层 HMAC 派生出来的：TC3+SecretKey → 日期 → 服务名 → tc3_request，
      顺序错一步结果就完全不同，且报错永远是同一句 SignatureFailure。
   ④ 请求体参与哈希，所以【必须先把 body 序列化成字符串再签】，发出去的也得是这一份。
      这就是下面 signTC3 接收 payloadStr（字符串）而不是对象的原因。 */

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hmac(key, s) {
  return crypto.createHmac('sha256', key).update(s, 'utf8').digest();
}

function signTC3(payloadStr, action) {
  const secretId = env('TENCENT_SECRET_ID');
  const secretKey = env('TENCENT_SECRET_KEY');

  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);   /* ① UTC 日期 */

  const contentType = 'application/json; charset=utf-8';          /* ② 与发送共用 */
  const headers = {
    'Content-Type': contentType,
    'Host': ASR_HOST,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(ts),
    'X-TC-Version': ASR_VERSION,
    'X-TC-Region': ASR_REGION
  };

  const signedHeaders = 'content-type;host';
  const canonicalHeaders = 'content-type:' + contentType + '\n' +
                           'host:' + ASR_HOST + '\n';

  /* 空字符串那一位是 CanonicalQueryString —— 本接口没有查询参数，但位置不能少 */
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payloadStr)
  ].join('\n');

  const scope = date + '/' + ASR_SERVICE + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256', String(ts), scope, sha256Hex(canonicalRequest)
  ].join('\n');

  /* ③ 四层派生，一步都不能省 */
  const kDate = hmac('TC3' + secretKey, date);
  const kService = hmac(kDate, ASR_SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.Authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  return headers;
}

/* ---------- 五、一句话识别 ---------- */

/* 腾讯云的错误码翻译成学生看得懂的中文。
   ⚠️ 为什么不把原始 Code 直接丢给页面：
      那串英文码对使用者零帮助，而"额度用完了"和"密钥错了"
      对斌哥来说是完全不同的两件事，必须分开说。 */
function asrHint(code, message) {
  if (/AuthFailure|Signature|SecretId/i.test(code)) {
    return '腾讯云密钥不对或已失效（检查 TENCENT_SECRET_ID / TENCENT_SECRET_KEY）';
  }
  if (/RequestLimitExceeded|ResourceUnavailable|LimitExceeded/i.test(code)) {
    return '语音识别调用太频繁或免费额度用完了，稍后再试';
  }
  if (/InvalidParameter|UnsupportedOperation/i.test(code)) {
    return '音频格式不被接受（' + code + '）';
  }
  return '语音识别失败：' + (message || code);
}

async function recognize(audioB64, format) {
  if (!hasAsr()) {
    throw apiError('asr_not_configured',
      '服务器没配腾讯云密钥（TENCENT_SECRET_ID / TENCENT_SECRET_KEY），语音识别不可用', 501);
  }

  const base64 = String(audioB64 || '');
  if (!base64) throw apiError('audio_empty', '没有收到音频数据');

  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw apiError('audio_empty', '音频解出来是空的');
  if (bytes.length > MAX_AUDIO) {
    throw apiError('audio_too_large', '这段录音太长了，一次不要超过 60 秒');
  }

  /* 只认 wav/mp3/m4a 这类朴素格式名，防止有人往参数里塞奇怪的东西 */
  const fmt = /^[a-z0-9]{2,5}$/i.test(String(format || '')) ? String(format).toLowerCase() : 'wav';

  /* DataLen 要的是【解码后的字节数】，不是 base64 字符串的长度 —— 这里差一位都报错 */
  const payload = {
    EngSerViceType: env('ASR_ENGINE', '16k_en'),  /* 学生练英文；说中文为主可改成 16k_zh */
    SourceType: 1,                                /* 1 = 直接传音频数据（0 是传 URL） */
    VoiceFormat: fmt,
    Data: base64,
    DataLen: bytes.length,
    WordInfo: 0,          /* 不要词级时间戳，用不上还增大响应 */
    FilterDirty: 1,       /* 过滤脏词 */
    FilterModal: 1,       /* 过滤"嗯、呃"这类语气词：转写出来更干净，批改也更准 */
    FilterPunc: 0,        /* 【保留】标点：有标点学生一眼能看出断句对不对 */
    ConvertNumMode: 0     /* 不把英文数字转成阿拉伯数字，保持 "eight years" 的写法 */
  };

  const payloadStr = JSON.stringify(payload);
  let headers;
  try {
    headers = signTC3(payloadStr, 'SentenceRecognition');
  } catch (e) {
    throw apiError('sign_failed', '本地签名失败：' + e.message, 500);
  }

  const r = await postJSON(ASR_HOST, '/', headers, payloadStr, 12000);
  const body = r.json && r.json.Response;

  if (!body) {
    throw apiError('asr_bad_response', '语音识别返回了看不懂的内容（HTTP ' + r.status + '）', 502);
  }

  /* ⚠️ 关键细节：腾讯云在【业务失败时 HTTP 依然是 200】，
      错误藏在 Response.Error 里。只看 statusCode 会把失败当成功。 */
  if (body.Error) {
    /* 留一条服务端日志，带原始 Code 与 RequestId：
       页面上给的是人话（"密钥不对"），排查时要的是原始码。
       两者各归各位，别把 Code 甩到界面上让人猜。 */
    console.error('[talk] 语音识别上游报错：' + body.Error.Code + ' | ' + body.Error.Message +
      ' | RequestId=' + (body.RequestId || '-'));
    throw apiError('asr_failed', asrHint(body.Error.Code, body.Error.Message), 502);
  }

  return {
    text: String(body.Result || '').trim(),
    duration: body.AudioDuration || 0,
    requestId: body.RequestId || ''
  };
}

/* ---------- 六、通用 HTTPS POST（返回解析好的 JSON） ---------- */

function postJSON(hostname, pathname, headers, bodyStr, timeout) {
  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: hostname,
      path: pathname,
      method: 'POST',
      headers: headers
    }, function (up) {
      let raw = '';
      up.setEncoding('utf8');
      up.on('data', function (c) { raw += c; });
      up.on('end', function () {
        try {
          resolve({ status: up.statusCode, json: JSON.parse(raw) });
        } catch (e) {
          reject(apiError('upstream_bad_json',
            '上游返回的不是 JSON（HTTP ' + up.statusCode + '）', 502));
        }
      });
    });

    req.on('error', function (e) {
      reject(apiError('upstream_unreachable', '连不上上游服务：' + e.message, 502));
    });

    req.setTimeout(timeout || 15000, function () {
      req.destroy();
      reject(apiError('upstream_timeout', '上游响应超时（' + Math.round((timeout || 15000) / 1000) + ' 秒）', 504));
    });

    req.end(bodyStr);
  });
}

/* ---------- 七、给模型的指令 ----------
   这份 prompt 的每一段都对着前端的一个渲染位，改动前先看 talk.js 的 parseSections：

     [FIX]     → 逐条渲染成「原说法 → 改后说法 | 中文原因」
     [POLISH]  → 「更地道的说法」整句
     [REPLY]   → 老师气泡的正文（也是 TTS 朗读的内容，所以必须纯英文）
     [NEXT]    → 气泡底部「接着聊」按钮

   三条不能违反的约束：
     ① 「原说法」必须逐字复制学生原句 —— 前端会把它和原话并排放，
        模型一旦"顺手改写"，学生就找不到自己到底哪句错了，纠错就失去证据。
     ② [REPLY] 和 [NEXT] 只能英文 —— 它直接进 TTS 朗读，混进中文会用英文音色念中文。
     ③ 没有错误时必须输出「没有明显错误」这一行 —— 前端靠这个关键词把整段隐藏，
        否则会显示成"改 1 处"却列不出内容。 */

const SYSTEM_PROMPT = [
  '你是一位耐心、专业的英语口语陪练老师，正在和一位中国学生做一对一对话练习。',
  '学生这句话来自语音转写，可能带有口误、碎片、断句错误。',
  '',
  '严格按下面四个标记输出，顺序固定，每个标记单独占一行开头。',
  '不要输出代码块，不要输出这四个标记以外的任何标记，不要输出开场白或结尾总结。',
  '',
  '[FIX]',
  '语法与用词纠错。规则：',
  '- 一行一条，格式固定为：原说法 → 改后说法 | 中文原因',
  '- 「原说法」必须逐字复制学生原话里的片段，一个字都不能改写、不能补充',
  '- 「中文原因」不超过 15 个字，说清是什么问题（时态 / 冠词 / 单复数 / 介词 / 搭配 / 中式表达）',
  '- 只改真正影响正确性的错误；标点、大小写、ok / well 这类口语填充词不算错误',
  '- 最多 4 条，按严重程度从高到低排列',
  '- 如果这句话没有需要修改的地方，只写这一行：没有明显错误',
  '',
  '[POLISH]',
  '把学生这句话改写成更地道、更自然的英文（一句话）。保持原意，不加解释，不加中文。',
  '',
  '[REPLY]',
  '用英文回应学生说的内容，像真人聊天一样自然，1 到 2 句，最多 40 个词。',
  '- 不要复述学生的话，不要在这里纠错（纠错是 [FIX] 的事）',
  '- 可以表达兴趣、共鸣，或补充一点自己的想法',
  '',
  '[NEXT]',
  '用英文提出一个能让学生继续说下去的追问，一句话。',
  '不要问只需要回答 yes 或 no 的问题，也不要重复你刚才问过的问题。'
].join('\n');

function buildMessages(body) {
  const question = clip(body.question, 300).trim();
  const transcript = clip(body.transcript, MAX_TEXT).trim();

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  /* 历史只取最近 6 组，且只放"我说 → 老师答"的主干。
     为什么不把每轮的 [FIX] 也塞回去：那会让上下文膨胀两三倍，
     而批改本身是"就句论句"的活，前几轮错在哪对判断这一句没什么用。
     ⚠️ 历史放在学生这句话【之前】，顺序反了模型会以为老师先说话。 */
  if (Array.isArray(body.history)) {
    body.history.slice(-6).forEach(function (h) {
      const u = clip(h && h.user, MAX_TEXT).trim();
      const a = clip(h && h.assistant, MAX_TEXT).trim();
      if (!u) return;
      messages.push({ role: 'user', content: u });
      if (a) messages.push({ role: 'assistant', content: a });
    });
  }

  const parts = [];
  if (question) parts.push('本轮话题（学生正在回答的问题）：' + question);
  parts.push('学生刚才说的话（语音转写，可能有错）：\n"""' + transcript + '"""');
  messages.push({ role: 'user', content: parts.join('\n\n') });

  return messages;
}

/* ---------- 八、DeepSeek 流式转发 ----------

   ⚠️ 顺序上的一个关键决定：**先等上游应答，再决定回什么**。
      常见写法是先 writeHead(200, event-stream) 再去请求上游，结果上游返回 401/402 时，
      浏览器已经在读一个"成功"的流，错误只能塞进流里 —— 前端解析不出：
      它只认 choices[0].delta.content，会得到一个【空白气泡】，看起来像 AI 没说话。
      所以这里把上游的响应头等回来，确认是 200 才提交 SSE 头；
      不是 200 就还能正常回一个 JSON 错误，前端能把原因显示出来。
      代价是多等 0.5–1 秒 TTFB，换"失败一定看得见"，值得。 */

function llmErrorMessage(status, raw) {
  let msg = '';
  try {
    const j = JSON.parse(raw);
    msg = (j && j.error && (j.error.message || j.error.type)) || '';
  } catch (e) { /* 不是 JSON 就不强求 */ }

  if (status === 401) return 'DeepSeek 密钥无效（检查 DEEPSEEK_API_KEY）';
  if (status === 402) return 'DeepSeek 账户余额不足，请充值后再试';
  if (status === 429) return '调用太频繁，被 DeepSeek 限流了，等几秒再试';
  if (status >= 500) return 'DeepSeek 服务暂时不可用（HTTP ' + status + '）';
  return 'DeepSeek 返回错误（HTTP ' + status + '）' + (msg ? '：' + msg : '');
}

function streamLLM(req, res, payload) {
  const bodyStr = JSON.stringify(payload);

  const upstream = https.request({
    hostname: LLM_HOST,
    path: LLM_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env('DEEPSEEK_API_KEY'),
      'Accept': 'text/event-stream'
    }
  }, function (up) {
    /* 上游不认，就还能回 JSON —— 见上面那段注释 */
    if (up.statusCode !== 200) {
      let raw = '';
      up.setEncoding('utf8');
      up.on('data', function (c) { raw += c; });
      up.on('end', function () {
        const status = up.statusCode === 401 ? 502 : (up.statusCode === 402 ? 402 : 502);
        sendJSON(res, status, {
          ok: false,
          code: up.statusCode === 401 ? 'llm_auth_failed'
              : (up.statusCode === 402 ? 'llm_no_balance' : 'llm_upstream_error'),
          message: llmErrorMessage(up.statusCode, raw)
        });
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'      /* 请求 nginx 类代理别缓冲 —— 平台那层认不认，只能实测 */
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    /* 先吐一个注释帧。它不是给前端看的（前端只挑 data: 开头的行），
       作用是让代理在"第一秒"就确认这是一条长连接，别攒着等攒满一个缓冲区。 */
    res.write(': open\n\n');

    /* 心跳：模型偶尔 3 秒才吐第一个字，代理或浏览器可能判定超时。
       每 15 秒一个注释帧，成本几乎为零。 */
    const beat = setInterval(function () {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);

    let buf = '';
    let contentChars = 0;

    up.setEncoding('utf8');
    up.on('data', function (chunk) {
      buf += chunk;

      /* 按行切，只把 data: 行重新组成完整事件。
         为什么不原样转发 chunk：SSE 的一帧可能被 TCP 切成两半，
         原样转发虽然浏览器多半能拼上，但一旦我们中间插了心跳帧就会串位。
         重新成帧 = 每一帧都完整，顺序不乱。 */
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue;

        const payloadStr = line.slice(5).trim();
        if (!payloadStr) continue;

        if (payloadStr !== '[DONE]') {
          try {
            const j = JSON.parse(payloadStr);
            const d = j && j.choices && j.choices[0] && j.choices[0].delta;
            if (d && d.content) contentChars += d.content.length;
          } catch (e) { /* 半截 JSON 忽略，不影响转发 */ }
        }

        if (!res.writableEnded) res.write('data: ' + payloadStr + '\n\n');
      }
    });

    up.on('end', function () {
      clearInterval(beat);

      /* 尾巴上可能还剩一行没换行符的 data */
      const tail = buf.trim();
      if (tail.indexOf('data:') === 0 && !res.writableEnded) {
        res.write('data: ' + tail.slice(5).trim() + '\n\n');
      }

      /* ⚠️ 一个字都没收到，但上游是 200 —— 极少见（内容被审核拦截时会这样）。
         这种情况下前端会得到一个空白气泡，比报错更让人困惑。
         所以补一句人话进去，学生知道"不是我没说话，是 AI 这次空手而归"。 */
      if (contentChars === 0 && !res.writableEnded) {
        const fallback = '[FIX]\n没有明显错误\n[POLISH]\n\n[REPLY]\n' +
          'Sorry, I lost my train of thought there — could you say that once more?\n[NEXT]\n';
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { content: fallback } }]
        }) + '\n\n');
      }

      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    up.on('error', function () {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    });
  });

  upstream.on('error', function (err) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    sendJSON(res, 502, {
      ok: false,
      code: 'upstream_unreachable',
      message: '连不上 DeepSeek：' + err.message
    });
  });

  /* 学生关页面 / 点"清空"时，把上游请求一起掐掉 ——
     否则模型那边还在算，token 照扣。

     ⚠️⚠️ 监听的一定是 res 的 close，【不是 req 的 close】。
         Node 16 起，req 的 'close' 在"请求体读完"时就触发 —— 那不是断线，
         是正常读完；照那个写，上游刚发出就被我们自己 destroy，
         页面表现是"永远没有回应"，而且极难看出原因。
         res 的 'close' 才是连接层面的关闭；再判断 writableEnded 区分
         "正常结束"与"用户中途跑掉"，只有后者才需要掐上游。 */
  res.on('close', function () {
    if (!res.writableEnded) upstream.destroy();
  });

  upstream.end(bodyStr);
}

/* ---------- 九、三条路由 ---------- */

function handleHealth(req, res) {
  /* 只放 GET。为什么不连 HEAD 一起放行：HEAD 按协议不能带响应体，
     而下面 sendJSON 会写 body —— 与其写一条"HEAD 时不发 body"的支路
     （永远没人测得到），不如干脆只允许真正用得上的那一种。 */
  if (req.method !== 'GET') {
    throw apiError('method_not_allowed', '这个接口只接受 GET', 405);
  }
  /* ⚠️ 这里只回答"配没配"，绝不回显密钥、不回显长度、不回显前几位。
     页面需要的就两个布尔值。 */
  sendJSON(res, 200, {
    ok: true,
    data: {
      asr: hasAsr(),
      llm: hasLlm()
    }
  });
}

/* 三条路由的判定顺序是刻意排的，别随手调换：
     method（405）→ 请求体能否解析（400）→ 服务端有没有能力（501）→ 频率（429）
   理由：400 说的是"你的请求有问题"，501 说的是"我这台机器干不了这活"，
   两者混了就会出现"明明是我 JSON 写错了，却被告知缺密钥"这种误导。
   429 放最后，是因为没能力干的请求不该消耗配额。 */

async function handleAsr(req, res) {
  if (req.method !== 'POST') throw apiError('method_not_allowed', '这个接口只接受 POST', 405);

  const body = await readJSON(req, MAX_BODY);

  if (!hasAsr()) {
    throw apiError('asr_not_configured',
      '服务器没配腾讯云密钥（TENCENT_SECRET_ID / TENCENT_SECRET_KEY），语音识别不可用', 501);
  }
  if (!rateOK()) throw apiError('rate_limited', '这一分钟请求太多，等一下再试', 429);

  const out = await recognize(body.audio, body.format);

  sendJSON(res, 200, { ok: true, data: out });
}

async function handleAnalyze(req, res) {
  if (req.method !== 'POST') throw apiError('method_not_allowed', '这个接口只接受 POST', 405);

  /* 文本请求给 256KB 足够 —— 别照抄音频那条的 8MB，
     一个"聊天"接口没有理由收 8MB 的请求体 */
  const body = await readJSON(req, 256 * 1024);

  if (!hasLlm()) {
    throw apiError('llm_not_configured',
      '服务器没配 DEEPSEEK_API_KEY，AI 批改不可用', 501);
  }

  const transcript = clip(body.transcript, MAX_TEXT).trim();
  if (!transcript) throw apiError('empty_transcript', '没有收到要批改的内容');

  if (!rateOK()) throw apiError('rate_limited', '这一分钟请求太多，等一下再试', 429);

  const payload = {
    model: env('DEEPSEEK_MODEL', 'deepseek-chat'),
    messages: buildMessages(body),
    stream: true,
    temperature: 0.6,      /* 批改要稳，不能太飘；0 会过于死板，0.6 兼顾自然 */
    max_tokens: 700        /* 四段内容满打满算用不到 700，封顶防跑飞 */
  };

  streamLLM(req, res, payload);
}

/* 路由表：新增接口只改这里，不用动 dev-server.js */
const ROUTES = {
  '/api/talk/health': handleHealth,
  '/api/talk/asr': handleAsr,
  '/api/talk/analyze': handleAnalyze
};

/**
 * dev-server 的挂载入口。
 * @returns {boolean} true = 这个请求归我管（已处理），false = 不认识，还给你
 */
function handle(req, res) {
  const pathname = (req.url || '').split('?')[0];
  const fn = ROUTES[pathname];
  if (!fn) return false;

  /* 统一兜异常：任何一条路由抛错都变成结构化 JSON，
     绝不把堆栈或"空响应"丢给浏览器 —— 前端要靠 code 决定提示什么。 */
  Promise.resolve()
    .then(function () { return fn(req, res); })
    .catch(function (err) {
      const code = (err && err.apiCode) || 'internal_error';
      const status = (err && err.status) || 500;
      const message = (err && err.message) || '服务器内部错误';

      if (res.headersSent) {
        /* 已经在流里了，只能收尾；日志留一条，方便排查 */
        console.error('[talk] 流中出错：', code, message);
        try { if (!res.writableEnded) res.end(); } catch (e) {}
        return;
      }

      if (code === 'internal_error') console.error('[talk] 未预期错误：', err);
      sendJSON(res, status, { ok: false, code: code, message: message });
    });

  return true;
}

module.exports = {
  handle: handle,
  /* 导出这几个只为自测脚本能单独验签名、prompt、限流，运行时不依赖它们 */
  _internal: {
    signTC3: signTC3,
    buildMessages: buildMessages,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    hasAsr: hasAsr,
    hasLlm: hasLlm,
    rateOK: rateOK
  }
};
