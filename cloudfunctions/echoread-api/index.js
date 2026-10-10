/* ============================================
   echoread-api —— CloudBase 云函数

   Day 15：只做一件事 —— GET /api/health（健康检查，不连库）。
   Day 17：加两个真读接口，读 PostgreSQL 里的真数据
     · GET /api/boards —— 首页板块清单（读 boards 表）
     · GET /api/words  —— 词表列表（读 words 表，可按课程单元筛）

   ⚠️ 数据是怎么取到的（Day 17 改过一版，原因写在这，别下次忘了）
     原计划：云函数里用 `pg` 驱动「直连」数据库（PGHOST/PGUSER/PGPASSWORD 那一套）。
     实测 + 查证后否掉了，两条硬理由：
       ① 直连需要的「内网地址」只在开启私有网络（VPC）后才有，而本环境是
          免费体验版 / 共享集群 —— 控制台里「内网地址」那一栏就是个 `-`；
          公网直连那条路要配安全组，而安全组要求「独享集群」，共享集群下闭环堵死。
       ② 更底层：数据库里三个应用角色（anon / authenticated / service_role）
          全是 `NOLOGIN` —— 它们根本不能直接登录，只能由网关照 JWT 切换出来。
      官方开发指引的原话是「TCP 直连会引入 VPC、安全组、数据库账号密码三件套，
      全是部署后才暴露的问题，能不碰就不碰」，推荐走「SDK / 网关路径」。
     ⇒ 现在走的就是官方推荐那条：**HTTP 调「PG REST 网关」**。
       地址形如 https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表>?select=...
       带一个 `Authorization: Bearer <API Key>` 头，网关自己完成 SQL 查询。
       好处：零依赖（Node 18 自带 fetch）、不用数据库密码、不用开 VPC、不用配 GRANT
             （service_role 默认就能访问所有表）。

   ⚠️ 三个必须守住的约定（订在 api-contract.md 里，动它就等于动前端）：
     ① 响应形状：成功 = 直接给业务对象（如 {"boards":[...]}），失败 = {ok:false,error,message}
        —— 不套 {code,data} 信封，前端 home.js 认的是 data.boards
     ② 字段名翻译在【这一层】做：数据库叫 description / word / meaning / unit_tag，
        网页要的是 desc / title / desc / tag —— 翻译错了，列表页当场全空
     ③ 用户输入永远不拼进查询串 —— 必须 encodeURIComponent（这里就是「参数化」的位置）

   返回格式说明（关键，别改）：
     返回值里带 statusCode 字段时，CloudBase 会把它当作「集成响应」，
     按你写的 statusCode / headers / body 原样构造 HTTP 响应。
     不带 statusCode 时，整个对象会被当成 body 自动 JSON 化 ——
     那样就没法区分 200 和 405 了。
   ============================================ */

/* ---------------------------------------------------------------------------
   环境配置

   ENV_ID    环境 ID，不是秘密（公网地址里就有）。允许用环境变量覆盖，
             方便以后换环境；不配就用默认值。
   REST_BASE PG REST 网关的基地址，所有查询都拼在它后面。
   --------------------------------------------------------------------------- */
var ENV_ID = process.env.CLOUDBASE_ENV_ID || 'echoread-d0g1b2ez6a369d11e';
var REST_BASE = 'https://' + ENV_ID + '.api.tcloudbasegateway.com';

/* 网关调用超时（毫秒）。

   ⚠️ 为什么是 2500 而不是更长 —— 因为天花板不在我们手里：
      个人版云函数的「执行超时」**锁死在 3 秒**（控制台里那个框是灰的，改不了）。
      我们这里要是写 10 秒，等于「安全绳」比「天花板」还长 —— 真超时的时候，
      是函数先被平台整根掐掉，用户看到的是网关的一串英文错误码，
      而不是下面那句我们精心准备的中文提示。
      设 2500ms（给平台的 3 秒留 500ms 余量）→ 快到点的时候我们自己先收手，
      稳稳返回 `{"ok":false,"error":"db_error",...}`。 */
var REST_TIMEOUT_MS = 2500;

/* 统一的 JSON 响应构造器。
   注意 body 必须是「字符串」：集成响应不会帮你二次序列化，
   所以这里得自己 JSON.stringify。 */
function json(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  };
}

/* 统一的「失败」构造器 —— 形状照 api-contract.md 1.2 节：
     error   给机器看的短码（全小写下划线），前端靠它分支
     message 给人看的一句中文，可以直接显示到页面上 */
function fail(statusCode, error, message) {
  return json(statusCode, { ok: false, error: error, message: message });
}

/* ---------------------------------------------------------------------------
   从 PG REST 网关读一张表

   table   —— 表名。⚠️ 只允许传【代码里写死的常量】，绝不接受用户输入：
              这是唯一一处「名字直接进地址」的地方，放开就等于把表名交给外人挑。
   select  —— 要哪几列（PostgREST 的列选择语法，逗号分隔）
   order   —— 排序，如 sort_order.asc,id.asc
   filters —— 额外的「等值过滤」，形如 [['unit_tag', 'Unit 1']]，可空

   返回：网关给的**数组**（注意不是 { data: [...] } 那种信封）。
   出错就抛 —— 由入口函数统一翻成 500。
   --------------------------------------------------------------------------- */
async function rdbSelect(table, select, order, filters) {
  /* API Key（对应数据库的 service_role 角色，能绕过行级权限 RLS）。
     ⚠️ 它等于数据库的万能钥匙：只能从环境变量读，绝不写进代码、
        更绝不出现在任何返回给浏览器的内容里。 */
  var apiKey = process.env.CLOUDBASE_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 CLOUDBASE_API_KEY 环境变量');
  }

  var qs = ['select=' + select, 'order=' + order];
  (filters || []).forEach(function (f) {
    /* ⚠️ 用户给的值必须 encodeURIComponent —— 这就是「参数化」在这条路上的
       对应做法：值永远不参与查询串的结构，只当一个「字面量」被送过去。
       不编码的话，值里一个 & 就能凭空多长出一条查询条件。 */
    qs.push(encodeURIComponent(f[0]) + '=eq.' + encodeURIComponent(f[1]));
  });

  var url = REST_BASE + '/v1/rdb/rest/' + table + '?' + qs.join('&');

  var res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
  });

  if (!res.ok) {
    /* 把网关响应体的前 300 字夹进错误里 —— 它会进 console.error，
       也就是控制台「日志监控」，是排障时唯一能看到真相的地方。
       注意：这段**不会**返回给浏览器（入口函数对外只说一句人话）。 */
    var detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* 读不出就作罢 */ }
    var err = new Error('REST ' + res.status + ' ' + detail);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/* ===========================================================================
   各接口的处理函数
   约定：每个函数返回「已经构造好的响应对象」（json(...) 的返回值）
   =========================================================================== */

/* ---- GET /api/health —— 健康检查（Day 15 起就在，行为不变）----
   ⚠️ 它【不碰数据库】。这是有意的：接口一旦出问题，先敲这个地址 ——
      它通，说明是业务/数据问题；它不通，说明是部署或路由问题。 */
async function getHealth() {
  return json(200, {
    ok: true,
    service: 'echoread'
  });
}

/* ---- GET /api/boards —— 首页板块清单（读 boards 表）----
   契约示例（api-contract.md 3.2 第 2 号接口）：
     { "boards": [ {id,title,desc,status,href}, ... ] }
   ⚠️ 数据库列叫 description，接口字段叫 desc —— 这里翻译（前端认的是 desc）。 */
async function getBoards() {
  var rows = await rdbSelect(
    'boards',
    'id,title,description,status,href',
    'sort_order.asc,id.asc'
  );

  return json(200, {
    boards: rows.map(function (row) {
      return {
        id: row.id,
        title: row.title,
        desc: row.description,   /* description → desc */
        status: row.status,
        href: row.href
      };
    })
  });
}

/* ---- GET /api/words —— 词表列表（读 words 表）----
   契约示例（api-contract.md 3.2 第 6 号接口）：
     { "words": [ {id,title,desc,tag}, ... ] }
   请求参数：unit（可选，如 Unit 1；不传 = 全部）

   ⚠️ 契约里点名的那个坑，就在这个接口：
        数据库列   word   /  meaning  /  unit_tag
        接口字段   title  /  desc     /  tag
      为什么故意不一致 —— 词汇页和作文模板页共用同一个列表渲染器
      （assets/js/list-page.js），它只认 title/desc/tag 这三个通用名字。
      翻译放在接口层，前端一行不用改。 */
async function getWords(query) {
  /* 有 unit 就加一条等值过滤，没有就不过滤（返回全部） */
  var filters = query.unit ? [['unit_tag', query.unit]] : [];

  var rows = await rdbSelect(
    'words',
    'id,word,meaning,unit_tag',
    'sort_order.asc,id.asc',
    filters
  );

  return json(200, {
    words: rows.map(function (row) {
      return {
        id: row.id,
        title: row.word,         /* word → title */
        desc: row.meaning,       /* meaning → desc */
        tag: row.unit_tag        /* unit_tag → tag */
      };
    })
  });
}

/* ===========================================================================
   路由表：路径 → 处理函数
   网关那边配的是通配 /api/*，所以「哪个路径归哪个函数」由这张表决定。
   以后加接口，只在这里加一行（外加写一个处理函数），不用再动网关。
   =========================================================================== */
var ROUTES = {
  '/api/health': getHealth,
  '/api/boards': getBoards,
  '/api/words':  getWords
};

/* ===========================================================================
   函数入口
   event   —— 这次 HTTP 请求的信息（方法、路径、头、参数、body）
   context —— 运行环境信息（函数名、环境 ID、请求上下文等）
   两个参数都由 CloudBase 注入，我们只读不写。
   =========================================================================== */
exports.main = async function (event, context) {
  /* event.httpMethod —— 这次请求用的 HTTP 方法（GET / POST / …）。
     先转成大写再比较，避免大小写差异导致误判。 */
  var method = String(event.httpMethod || 'GET').toUpperCase();

  /* 只开放 GET。
     为什么顺带放行 HEAD：有些浏览器和监控探针会先发一个 HEAD 探一下，
     被拒会误报「接口挂了」。放行它、不返回 body 即可。
     其余方法（POST / PUT / DELETE）一律 405 —— HTTP 里「方法不允许」的标准码。 */
  if (method !== 'GET' && method !== 'HEAD') {
    return fail(405, 'method_not_allowed', '该接口只支持 GET');
  }

  /* event.path —— 请求路径。网关上开了「路径透传」时，这里会拿到完整路径
     （如 /api/boards）。去掉结尾多余的斜杠再查表，让 /api/boards/ 也能命中。 */
  var path = String(event.path || '').replace(/\/+$/, '') || '/';

  var handler = ROUTES[path];
  if (!handler) {
    return fail(404, 'not_found', '没有这个接口');
  }

  try {
    /* event.queryStringParameters —— URL 上 ?a=1&b=2 那部分，CloudBase 已经解析成对象。
       没有问号参数时它可能是 undefined，兜一个空对象，省得下游到处判空。 */
    var query = event.queryStringParameters || {};
    return await handler(query);
  } catch (err) {
    /* 未配 Key、网关报错、网络超时……都落到这里。
       ⚠️ 不把 err.message 原样吐给前端 —— 那里面可能带主机名、状态码、内部细节。
          人话给用户，详细原因留给控制台的日志（console.error 会进「日志监控」）。 */
    console.error('[echoread-api] 接口出错:', err && err.message ? err.message : err);
    return fail(500, 'db_error', '服务端读取出错，请稍后再试');
  }
};
