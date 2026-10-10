/* ============================================
   echoread-api —— CloudBase 云函数

   Day 15：只做一件事 —— GET /api/health（健康检查，不连库）。
   Day 17：加两个真读接口，读 PostgreSQL 里的真数据
     · GET /api/boards —— 首页板块清单（读 boards 表）
     · GET /api/words  —— 词表列表（读 words 表，可按课程单元筛）
   Day 18：加第一个**写**接口，往 PostgreSQL 里插数据
     · POST /api/words —— 新增一条词条（写 words 表；必填校验 + 防重复提交）
     ⚠️ 路由器随之改形：从「非 GET/HEAD 一律 405」改成「先按路径找、再按方法分」——
        否则新接口会被自己那句 405 拦死（见 exports.main 里的 ① ②）。

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
     ① 响应形状：
        · 读接口成功 = 直接给业务对象（如 {"boards":[...]}）—— 不套 {code,data} 信封
        · 写接口成功 = {ok:true, data:{...}} —— 写操作没有「业务对象」可给
          （返回的是「写成功」这个结果）；而失败形状本来就是 {ok:false,error,message}，
          两者对称，前端看一个 ok 字段就够，不用去解析 HTTP 状态码
        · 失败一律 = {ok:false, error, message}（error 给机器、message 给人，中文）
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

/* ---------------------------------------------------------------------------
   往 PG REST 网关写一行（POST /v1/rdb/rest/<表>）

   table —— 表名。同 rdbSelect：只允许传【代码里写死的常量】。
   row   —— 要插入的一行，键是**数据库列名**（字段名翻译由调用方做完）

   返回：网关回显的**数组**（带了 Prefer: return=representation，插完把整行给回来，
         省掉「再查一次」）。万一个别网关版本回的是单对象，这里统一包成数组。
   出错就抛；「唯一约束冲突」额外带 conflict = true（由调用方翻成 409）。
   --------------------------------------------------------------------------- */
async function rdbInsert(table, row) {
  var apiKey = process.env.CLOUDBASE_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 CLOUDBASE_API_KEY 环境变量');
  }

  var url = REST_BASE + '/v1/rdb/rest/' + table + '?select=*';

  var res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      /* ⚠️ Prefer: return=representation —— 不加的话，网关默认 return=minimal，
         只回一个空 body 和一个 content-range 头（说明「1 行受影响」），拿不到刚插进去的那行。
         加了它，插入后的整行直接回来，我们就不用再发一次 SELECT。 */
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
  });

  if (!res.ok) {
    var detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* 读不出就作罢 */ }
    var err = new Error('REST ' + res.status + ' ' + detail);
    err.status = res.status;
    /* 「重复提交」的识别：PostgREST 把唯一约束冲突翻成 HTTP 409；
       再兜一层 —— 错误体里出现 PostgreSQL 的错误码 23505（unique_violation）也认。 */
    err.conflict = (res.status === 409) || detail.indexOf('23505') !== -1;
    throw err;
  }

  var out = await res.json();
  return Array.isArray(out) ? out : [out];
}

/* ---------------------------------------------------------------------------
   解析 POST 请求体 → 普通对象

   ⚠️ CloudBase 集成响应里 event.body 有两种可能，两种都要能吃：
      · 普通字符串（Content-Type: application/json 时）
      · **base64 编码**的字符串（event.isBase64Encoded === true 时，平台对二进制内容会这样传）
   返回 { ok:true, data:对象 } 或 { ok:false, error, message }（后者直接能喂给 fail()）。
   --------------------------------------------------------------------------- */
function parseBody(event) {
  var raw = event.body;

  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, error: 'invalid_body', message: '请求体必须是 JSON 对象' };
  }

  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }

  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'invalid_body', message: '请求体必须是合法的 JSON' };
  }

  /* 只收「普通对象」：数组、字符串、数字、null 一律拒。
     为什么拒数组 —— 那是批量写入的形状，本期清单明确不做（Day 18 边界）。 */
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'invalid_body', message: '请求体必须是 JSON 对象' };
  }

  return { ok: true, data: data };
}

/* ===========================================================================
   各接口的处理函数
   约定：每个函数返回「已经构造好的响应对象」（json(...) 的返回值）
   ⚠️ 签名统一为 handler(query, event)：读接口只用 query，写接口要用 event 拿 body。
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

/* ---- POST /api/words —— 新增一条词条（Day 18 今天的主角）----
   契约（api-contract.md 3.2 第 6 号 POST 子段）：
     请求体 { id, title, desc, tag? }
     成功  201 { ok:true, data:{ id,title,desc,tag } }
     错误  400 invalid_body / 400 missing_field / 400 invalid_field / 409 duplicate_id

   ⚠️ 字段名在这一层来回翻译：
       请求体（网页的叫法）    id  /  title  /  desc     /  tag
       数据库列（库里的叫法）  id  /  word   /  meaning  /  unit_tag
     进：网页 → 库（拼 row 时翻）　　出：库 → 网页（回 data 时翻回来） */
async function postWords(query, event) {
  /* ① 取请求体。解析失败直接回 400（error / message 由 parseBody 备好了）。 */
  var parsed = parseBody(event);
  if (!parsed.ok) {
    return fail(400, parsed.error, parsed.message);
  }
  var body = parsed.data;

  /* ② 校验：必填 + 格式。
     ⚠️ 一次把缺的/错的**收集齐再报**，不做「报一个、你改一个、再报下一个」的挤牙膏 ——
        前端一次就能把话说明白。 */
  var REQUIRED = [
    { key: 'id',    label: '词条 id（id）' },
    { key: 'title', label: '单词（title）' },
    { key: 'desc',  label: '释义（desc）' }
  ];
  var missing = [];
  var badType = [];

  REQUIRED.forEach(function (f) {
    var v = body[f.key];
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(f.label);
    } else if (typeof v !== 'string') {
      /* 数字、布尔、对象……都不收：库里这三列是 TEXT，硬塞进去只会变成
         "[object Object]" 这样的脏数据，不如当场拒掉。 */
      badType.push(f.label);
    }
  });

  if (missing.length > 0) {
    return fail(400, 'missing_field', '缺少必填字段：' + missing.join('、'));
  }
  if (badType.length > 0) {
    return fail(400, 'invalid_field', '字段「' + badType.join('、') + '」必须是非空字符串');
  }

  /* tag 是可选字段：没给 / 给了空白 → 存 NULL（不是空字符串 —— 两者在库里含义不同）。 */
  var tag = (body.tag === undefined || body.tag === null || String(body.tag).trim() === '')
    ? null
    : String(body.tag).trim();

  /* ③ 写库。字段名翻译：网页的叫法 → 库里的叫法。 */
  var row = {
    id:       body.id.trim(),
    word:     body.title.trim(),
    meaning:  body.desc.trim(),
    unit_tag: tag
  };

  var inserted;
  try {
    inserted = await rdbInsert('words', row);
  } catch (err) {
    /* ⚠️ 「重复提交」不是服务端故障，是**业务上可预期的结果** —— 单独翻成 409，
       别让它混进 500。识别靠 rdbInsert 打的 conflict 标记（网关 409 或 SQLSTATE 23505）。
       这就是「防重复」的全部实现：**不做「先查后插」**（那样两个请求同时查、同时插，
       照样重复）—— 直接插、让**数据库主键**去拦，一次请求解决，天然没有竞态。 */
    if (err && err.conflict) {
      console.log('[echoread-api] POST /api/words 重复提交被拒：id =', row.id);
      return fail(409, 'duplicate_id', '这个词条 id 已存在，请不要重复提交');
    }
    throw err;   /* 其它错误（未配 Key / 网络超时 / 网关 5xx）交给入口统一翻 500 */
  }

  /* ④ 回 201。字段名翻译回：库里的叫法 → 网页的叫法。
     回显优先用网关给的那行（inserted[0]）—— 万一以后加了数据库默认值（如时间戳），
     它能反映真实落库结果；取不到就退回我们自己拼的 row。 */
  var r = inserted[0] || row;

  /* 余力加练的服务端日志：写入成功记一条，方便以后排查「到底插没插进去」。 */
  console.log('[echoread-api] POST /api/words 写入成功：id =', r.id);

  return json(201, {
    ok: true,
    data: {
      id:    r.id,
      title: r.word,        /* word    → title */
      desc:  r.meaning,     /* meaning → desc  */
      tag:   r.unit_tag     /* unit_tag → tag  */
    }
  });
}

/* ===========================================================================
   路由表：路径 → { 方法: 处理函数 }
   ⚠️ Day 18 改了形状：原来是「路径 → 函数」（隐含只支持 GET），
      现在一个路径可以挂多个方法（如 /api/words 既有 GET 又有 POST）。
      以后加接口，只在这里加一行（外加写一个处理函数），不用再动网关。
   =========================================================================== */
var ROUTES = {
  '/api/health': { GET: getHealth },
  '/api/boards': { GET: getBoards },
  '/api/words':  { GET: getWords, POST: postWords }
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

  /* HEAD 当成 GET 处理：有些浏览器和监控探针会先发一个 HEAD 探一下，
     被拒会误报「接口挂了」。它和 GET 走同一个处理函数即可
     （HTTP 规范要求 HEAD 的响应头与 GET 一致、但不带 body —— 网关会替我们丢掉 body）。 */
  if (method === 'HEAD') {
    method = 'GET';
  }

  /* event.path —— 请求路径。网关上开了「路径透传」时，这里会拿到完整路径
     （如 /api/boards）。去掉结尾多余的斜杠再查表，让 /api/boards/ 也能命中。 */
  var path = String(event.path || '').replace(/\/+$/, '') || '/';

  /* ① 先按路径找。找不到 = 这个路径根本不存在 → 404
     （跟「路径在、但方法不对」是两回事，别混成一个错误）。 */
  var route = ROUTES[path];
  if (!route) {
    return fail(404, 'not_found', '没有这个接口');
  }

  /* ② 再看这个方法挂没挂处理函数。
     ⚠️ Day 18 的改动就在这儿：原来「非 GET/HEAD 一律 405」是**写死**的；
        现在改成「这个路径支持哪些方法，就看路由表里挂了哪些」——
        /api/words 挂了 GET 和 POST ⇒ 这俩都通，PUT 才 405。
        message 里列出该路径**实际支持**的方法，用户一看就知道该怎么调。 */
  var handler = route[method];
  if (!handler) {
    var allowed = Object.keys(route).join('、');
    return fail(405, 'method_not_allowed', '该接口只支持 ' + allowed);
  }

  try {
    /* event.queryStringParameters —— URL 上 ?a=1&b=2 那部分，CloudBase 已经解析成对象。
       没有问号参数时它可能是 undefined，兜一个空对象，省得下游到处判空。
       ⚠️ event 也一并传下去 —— 写接口（POST）要从 event.body 取请求体。 */
    var query = event.queryStringParameters || {};
    return await handler(query, event);
  } catch (err) {
    /* 未配 Key、网关报错、网络超时……都落到这里。
       ⚠️ 不把 err.message 原样吐给前端 —— 那里面可能带主机名、状态码、内部细节。
          人话给用户，详细原因留给控制台的日志（console.error 会进「日志监控」）。 */
    console.error('[echoread-api] 接口出错:', err && err.message ? err.message : err);
    return fail(500, 'db_error', '服务端出错，请稍后再试');
  }
};
