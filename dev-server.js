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
   只挡这一种后缀，其它一律照旧。 */
const BLOCKED_EXT = ['.md'];

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

const server = http.createServer((req, res) => {
  let filePath = resolveFile(req.url);
  if (!filePath) return fail(res, 403, '403 越界访问被拒绝');

  /* Day 14：项目文档不对外（详见文件上方 BLOCKED_EXT 的说明）。
     放在越界检查之后、目录处理之前，直接当"找不到"回，不暴露文件是否存在。 */
  if (BLOCKED_EXT.includes(path.extname(filePath).toLowerCase())) {
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
