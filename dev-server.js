/* ============================================
   dev-server.js —— 本地开发服务器（Day 7 配套工具）
   为什么不用 python -m http.server：
     它不支持 Range（分段取数据）请求。浏览器要实现「跳到第 8 句」，
     底层是向服务器要「从第 18 秒开始那一段字节」，服务器必须回
     206 Partial Content + Content-Range。Python 那个极简服务器只会回
     200 + 整个文件，浏览器拿不到分段数据 → 直接不允许 seek →
     audio.currentTime = 18 变成空话 → 点哪句都从头播整段。
   本文件补上 Range，顺带关掉浏览器缓存（省得对着旧代码排查半天）。

   启动：node dev-server.js         浏览器打开 http://localhost:8000/
         node dev-server.js 8001    换端口
   ============================================ */

const http = require('http');
const https = require('https');      /* Day 27：同源代理要用它转发到云函数 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;                          /* 以本文件所在目录为网站根目录 */

/* Day 9：这里加了一级 process.env.PORT。
   起因：线上发布走静态托管时不给 Range，跳播坏掉（详见 server.js 的说明）。
   改成按 Node 应用发布后，平台是通过【环境变量 PORT】告诉服务该听哪个端口的，
   命令行参数只有本地手动跑才会给。
   顺序刻意写成 argv → PORT → 8000：
     本地 `node dev-server.js 8001` 仍以 8001 为准 —— 显式参数优先，本地行为一点没变；
     线上沙箱注入 PORT，直接生效。
   ⚠️ 少这一级的话，按 node 方式发布会在 8000 上"起不来"：
      平台等不到监听就判定启动失败，页面会直接打不开。 */
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8000;

/* 类型写错浏览器会拒绝播放，所以 mp3 必须写对 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

/* Day 14：项目文档（.md）不对外提供。
   起因：发布是「只增不删」—— 文档一旦随发布上传，就留在沙箱里删不掉了
   （实测：本地删掉后重发，线上仍返回 200）。所以只能改由服务器层拒绝。
   这是唯一能可靠下架「已经上传过的文件」的办法。

   Day 23（安全审计）：原来只挡 .md 一种，审计时发现【远远不够】——
     发布是「整目录上传」，目录里还躺着 .env 和 .workbuddy/，它们会被一起传上去：
       · .env          —— 本地机密配置（将来会填真 Key），绝不该出现在公网
       · .env.example  —— 模板也一并挡住（公网没有它的用途，少暴露一个入口）
       · .workbuddy/   —— 协作笔记 + 记忆，属于"个人台面"，更不该公开
     所以把黑名单从「只有后缀」扩成「后缀 + 路径前缀」两套。
   ⚠️ 为什么必须在【服务器层】挡，而不只是靠发布前手动挪文件：
     手动挪靠"人记得"，漏一次就出事；写在这里是"代码保证"，一次改动永久生效。
     这正是 Day 23 安全审计的思路：把安全从"人记得"变成"代码保证"。 */
const BLOCKED_EXT = ['.md', '.env', '.env.example', '.env.local', '.env.production', '.env.development', '.env.test'];
/* 路径前缀黑名单：以这些相对路径开头的请求一律拒绝（匹配的是 URL 路径，用 / 分隔）

   Day 24 补充：把 `cloudfunctions/` 挡上。
     起因：Day 24 发布前的安全体检发现，线上
       /cloudfunctions/echoread-api/index.js
       /cloudfunctions/echoread-api/lib/rdb.js
       /cloudfunctions/echoread-api/package.json
     三个文件**都能被人直接下载（200）** —— 后端全部接口逻辑、字段映射、错误码、
     网关调用方式一览无余。
     为什么之前漏了：Day 23 只想到 .env / .workbuddy / .git 这三个"机密/笔记"目录，
       没想到「后端源码」本身也是发布目录里的一员 —— 发布是**整目录上传**，
       仓库里有什么就传什么，仓库根目录下就躺着 cloudfunctions/ 和 db/。
     ⚠️ 为什么不能指望 WAF 兜底：实测 /.env 与 /db/schema.sql 的 403 是
       **腾讯云 WAF** 按攻击特征拦下的（请求根本没到我们服务器），
       但 cloudfunctions/ 不命中任何 WAF 特征 —— 靠平台兜底靠不住，得自己保证。
     ⚠️ 为什么必须在【服务器层】挡：发布是「只增不删」，文件一旦上去就删不掉了
       （与 .md 同一个道理，见上面 BLOCKED_EXT 的说明）。
       加在这里 = 新版本一上线，请求就被我们自己的服务器回 404 挡住，
       沙箱里那些旧文件即使还在，也访问不到了。

   Day 24 一并加上 `db/`：里面是 schema.sql / seed.sql，目前靠 WAF 挡着（.sql 命中规则），
     但那是"别人替我挡"；写进自家名单是零成本的纵深防御。 */
const BLOCKED_PATH_PREFIX = ['.env', '.workbuddy/', '.git/', 'cloudfunctions/', 'db/'];

/* 网址 → 本机文件路径。顺便挡住 ../../ 越界访问。
   Windows 上路径分隔符有正反两种，必须先 normalize 再比较，否则会误判 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(ROOT, decoded));
  const normRoot = path.normalize(ROOT);
  if (target !== normRoot && !target.startsWith(normRoot + path.sep)) return null;
  return target;
}

/* 解析 Range 头，只认最常见的两种写法：bytes=1000-1999 与 bytes=1000- */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  let start;
  let end;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    if (!hasEnd) return null;                    /* bytes=- 没意义 */
    start = Math.max(0, size - Number(m[2]));    /* bytes=-500 = 最后 500 字节 */
    end = size - 1;
  }
  if (isNaN(start) || isNaN(end) || start > end || start >= size) return null;
  return { start: start, end: Math.min(end, size - 1) };
}

function fail(res, code, message) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/* 【Day 27】同源代理用的上游地址 —— 只在【服务端】出现，不下发到浏览器。
   为什么需要这一整套（这不是优化，是修一个线上必现的 bug）：
     发布站点 https://echoread.app.workbuddy.host 不在 CloudBase 网关的跨域白名单里，
     浏览器直接调云函数会被 CORS 拦掉 —— 页面上一律「网络连不上」（详见 CORS_FIX.md，
     Day 23 发现、Day 24 定位，因免费体验版加不了安全域名而封存）。
   解法：让浏览器只跟【自己人】说话。页面改调 /api/boards（同源、无跨域），
     由本服务器在服务端转发给云函数 —— 服务器之间不存在 CORS 这回事。
   附带好处：云函数地址从【前端源码】挪进了【后端】，前端不再暴露它。 */
const API_ORIGIN = 'https://echoread-d0g1b2ez6a369d11e-1502538433.ap-shanghai.app.tcloudbase.com';

/* 把 /api/** 原样转发到云函数，再把云函数的响应原样送回浏览器。
   ⚠️ 转发时要【摘掉 Origin 头】：网关是拿它比对白名单的，
      不带则不进入白名单判断（CORS_FIX.md 第五节实测：无 Origin 一律 200）。
      这也正是"同源"能解决问题的地方 —— 浏览器那侧压根没有跨域请求要发生。

   ⚠️⚠️ Day 28 晚补的一层（线上登录一直显示未登录的真凶）：
      线上多了一层【平台反向代理】，它会把 Authorization 头吃掉 ——
      实测证据（同一条 token）：
        · 直连云函数 /api/auth/me           → 200
        · 走 https://echoread.app.../api/auth/me → 401
        · 加随机查询串破缓存后仍是 401      → 不是缓存问题
        · POST /api/auth/login 一路正常     → 请求本身到得了云函数
      ⇒ 结论：能过去，但"身份"过不去。于是 token 改走【cookie】——
        浏览器会自动带上它，而 cookie 是独立于 header 的通道，平台代理不会动它。
        这一层就是"把 cookie 里的 token 补回成 Authorization 头"的地方：
        浏览器那侧照旧（对云函数而言契约完全没变），补头发生在我们自己的服务器上。 */
function proxyToApi(req, res) {
  let target;
  try {
    target = new URL(req.url, API_ORIGIN);
  } catch (err) {
    return fail(res, 400, '400 请求地址不合法');
  }

  const headers = Object.assign({}, req.headers, { host: target.host });
  delete headers.origin;      /* 见上：带了反而会被白名单拦 */
  delete headers.referer;

  /* ⚠️⚠️ 身份这一块是整个线上登录的命门，两版才修对，把实证留在这儿：
     平台反向代理【会把 Authorization 头换成它自己的 JWT】——
     诊断端点实测：我们前端发的是 64 位十六进制 token，
     到达本服务器的却是 `Bearer eyJhb...`、长度 395（JWT 形状）。
     ⇒ 所以：
       ① 【cookie 里的 token 拥有最高优先级，无条件覆盖 Authorization】——
          它只可能由我们自己的前端写入，是唯一可信的来源。
          上一版写成"头缺失时才用 cookie"，结果平台塞了个头进来，
          cookie 那条路永远不触发 —— 线上依旧 401。教训：判断"自己的凭据在不在"，
          不能拿"有没有头"当依据，得看"有没有我们的值"。
       ② 头里那个 JWT 不是我们的东西，【绝不转发给云函数】——
          既不认（会被判失效），还等于把平台的身份令牌外传给第三方。
          只有形如 `Bearer <64位十六进制>` 的头才认（本地开发/直连调试走这条）。 */
  const cookieToken = readTokenCookie(req);
  if (cookieToken) {
    headers.authorization = 'Bearer ' + cookieToken;
  } else {
    const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(headers.authorization || '');
    if (!m) delete headers.authorization;      /* 不是我们的 token → 丢掉，不外传 */
  }

  const upstream = https.request(target, { method: req.method, headers: headers }, function (up) {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });

  upstream.on('error', function (err) {
    console.error('转发到云函数失败：', err.message);
    fail(res, 502, '502 上游接口暂时不可用');
  });

  req.pipe(upstream);         /* 请求体（POST 等）也一并转发 */
}

/* 从 Cookie 头里取 echoread_token。
   ⚠️ 手写解析而不是引第三方库：只需要取一个值，多一个依赖不值当。
      decodeURIComponent 兜住值里的特殊字符（token 是十六进制，本来就干净，
      但别把"本来就干净"当作"永远干净"来写）。 */
const TOKEN_COOKIE = 'echoread_token';
function readTokenCookie(req) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i].trim();
    if (piece.indexOf(TOKEN_COOKIE + '=') === 0) {
      const v = piece.slice(TOKEN_COOKIE.length + 1);
      try { return decodeURIComponent(v); } catch (e) { return v; }
    }
  }
  return '';
}

const server = http.createServer((req, res) => {
  /* Day 27：/api/** 交给代理，不当作静态文件找。
     放在最前面，是因为 /api/words 这类路径在磁盘上并不存在，
     继续往下走只会撞 404。 */
  if ((req.url || '').split('?')[0].startsWith('/api/')) {
    return proxyToApi(req, res);
  }

  let filePath = resolveFile(req.url);
  if (!filePath) return fail(res, 403, '403 越界访问被拒绝');

  /* Day 14：项目文档不对外（详见文件上方 BLOCKED_EXT 的说明）。
     放在越界检查之后、目录处理之前，直接当"找不到"回，不暴露文件是否存在。 */
  if (BLOCKED_EXT.includes(path.extname(filePath).toLowerCase())) {
    return fail(res, 404, '404 找不到：' + req.url);
  }

  /* Day 23：路径前缀黑名单 —— .env / .workbuddy/ / .git/ 一律拒绝。
     为什么单独一条：这些是「按前缀挡」，不靠后缀（.workbuddy/memory/x.md 后缀是 .md
     上面已经挡了，但 .workbuddy/memory/JOURNAL 这种没后缀的也要挡）。
     ⚠️ 比对用 URL 路径（req.url 的路径部分，统一转 / 和去前导斜杠），
        不用本地绝对路径 —— 后者带盘符，比不出前缀。 */
  var reqPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '').replace(/\\/g, '/');
  if (BLOCKED_PATH_PREFIX.some(function (p) { return reqPath === p.replace(/\/$/, '') || reqPath.startsWith(p); })) {
    return fail(res, 404, '404 找不到：' + req.url);
  }

  /* 访问目录 → 找里面的 index.html */
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (err) {
    return fail(res, 404, '404 找不到：' + req.url);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return fail(res, 404, '404 找不到：' + req.url);
  }

  const size = stat.size;
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',                    /* 告诉浏览器：我能分段给你 */
    'Cache-Control': 'no-store, must-revalidate',/* 关缓存：刷新即拿最新文件 */
    'Expires': '0',
    'Last-Modified': stat.mtime.toUTCString(),
  };

  const range = parseRange(req.headers.range, size);

  if (range) {
    headers['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + size;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);                 /* 206 = 只给你要的那一段 */
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    res.on('close', () => stream.destroy());     /* 浏览器换句时会掐断上一个请求，收干净 */
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }

  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
});

/* Day 9：显式绑 0.0.0.0。
   线上平台是把外部请求经反向代理转进来的，服务必须监听所有网卡；
   只绑 127.0.0.1 的话代理连不进去（本地测试反而看不出问题）。
   ⚠️ 这一行也顺带让手机真机调试更稳 —— 之前靠默认行为，
      不同 Node 版本/系统下默认绑定可能不同，写明更靠谱。 */
server.listen(PORT, '0.0.0.0', () => {
  console.log('本地服务器已启动：http://localhost:' + PORT + '/');
  console.log('网站根目录：' + ROOT);
  console.log('已开启 Range（音频可跳播）＋ 已关闭浏览器缓存。按 Ctrl + C 停止。');

  /* 手机真机测试要用局域网地址（G1 / G2 / G5 都要求真机） */
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) {
        console.log('手机访问（同一局域网）：http://' + info.address + ':' + PORT + '/');
      }
    });
  });
});
