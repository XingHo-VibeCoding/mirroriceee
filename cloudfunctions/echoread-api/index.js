/* ============================================
   echoread-api —— CloudBase 云函数（**接口层**）

   Day 15：只做一件事 —— GET /api/health（健康检查，不连库）。
   Day 17：加两个真读接口，读 PostgreSQL 里的真数据
     · GET /api/boards —— 首页板块清单（读 boards 表）
     · GET /api/words  —— 词表列表（读 words 表，可按课程单元筛）
   Day 18：加第一个**写**接口，往 PostgreSQL 里插数据
     · POST /api/words —— 新增一条词条（写 words 表；必填校验 + 防重复提交）
     ⚠️ 路由器随之改形：从「非 GET/HEAD 一律 405」改成「先按路径找、再按方法分」——
        否则新接口会被自己那句 405 拦死（见 exports.main 里的 ① ②）。
   Day 19：**分层重构**（行为一字未改）——
     把本文件里「查数据库」的代码搬出去，这里只留「接口的事」：
       · lib/rdb.js              网关客户端：rdbSelect / rdbInsert（怎么跟数据库说话）
       · repositories/*.repo.js  数据访问层：一表一份，知道查哪张表、要哪些列
     ⇒ 本文件（接口层）从此**不认识数据库**：不再出现表名、列名、网关地址。
        它只做三件事：**接请求 → 调函数 → 返响应**。
   Day 22：补齐「改 / 删」两个写接口，「增删改查」四类操作闭环
     · PATCH  /api/words?id=w-xxx —— 改一条词条（可改 title / desc / tag）
     · DELETE /api/words?id=w-xxx —— 删一条词条
     ⚠️ 为什么 id 走 query 参数（?id=）而不是 /api/words/{id} 这种路径参数：
        路径参数要动网关的「路径透传」配置，能不能碰就不碰；
        而 query 参数跟 GET ?unit= 是同一套路，网关压根不用改。
     ⚠️ 「删除为什么比新增更容易出事」—— 这个答案写在这一层的 deleteWords 里，
        一句话：新增错了只是多一条，删除错了是**少一条、且找不回来**。

   Day 22 余力加练：**软删除**（soft delete）
     · DELETE 不再真删 —— 改成把 is_deleted 置 true；数据留在库里，能找回。
     · 连带改了两处：
       ① postWords —— 撞主键时先看一眼"是不是被软删过的"：是 → 复活（清标记+覆盖值），
          不是 → 才回 409。否则会出现"我删了它、再加却说已存在"的困惑。
       ② listWords（在 repo 层）—— 始终带 is_deleted=false 过滤，已删的对上层不可见。
     ⇒ 这一招让"删除"从**不可逆**变成了**可逆**：删错了，改个布尔值就回来。

   ⚠️ 数据是怎么取到的 —— 那段说明已随代码一起搬进 lib/rdb.js。
      （PG REST 网关那条路、为什么不用 pg 直连，都写在那儿了，要看细节翻它。）

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
   本文件依赖的「数据访问层」

   ⚠️ 这里只 require **仓库对象**，不 require lib/rdb.js ——
      因为「怎么跟数据库说话」是 repository 的事，接口层不需要知道。
      依赖方向永远是一条直线：index.js → repositories → lib/rdb.js，绝不回头。
   --------------------------------------------------------------------------- */
var boardsRepo = require('./repositories/boards.repo');
var wordsRepo = require('./repositories/words.repo');
/* Day 28：认证的两个新住户 ——
   authRepo 负责碰 users / sessions 两张表（走老路 rdb.js）；
   auth（lib/auth.js）只管"算"：密码哈希、随机 token、验证码签发校验。
   ⚠️ 依赖方向不变，还是一条直线：index.js → repositories / lib → rdb.js。 */
var authRepo = require('./repositories/auth.repo');
var auth = require('./lib/auth');
/* Day 28 晚：学习时长（复读时长）—— 一个人一行累计，供排行榜读。 */
var usageRepo = require('./repositories/usage.repo');

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

/* ---- rdbSelect / rdbInsert（以及它们要的环境配置）—— Day 19 起住在 lib/rdb.js ---- */

/* ---- 字段长度上限（Day 23 安全审计补的）----
   ⚠️ 为什么需要它：在这之前，接口只校验「必填 / 是字符串」，
      没人拦「长度」—— 一个 10MB 的字符串照样会被收下、发给数据库。
      轻则撑大存储、重则拖慢查询。这是安全审计里明确的「超长输入」风险。

   取值依据（不是拍脑袋）：都对着【数据库列的真实用途】留足余量 ——
     id    64  —— 形如 w-abandon，正常十几字符，64 绰绰有余
     title 64  —— 一个单词 / 短语，最长不会过几十字符
     desc 500  —— 一句释义，留够写长解释的空间
     tag   32  —— 单元标签，形如 Unit 1
   超了怎么办：不当场拒绝，而是收集齐一起报 400（同「挤牙膏」原则），
   告诉用户【哪个字段、超了多少】，而不是一句干巴巴的"参数错误"。 */
var MAX_LEN = { id: 64, title: 64, desc: 500, tag: 32 };

/* 校验单个字符串字段的长度。返回 null（没问题）或一句人话（超长）。
   为什么单独抽出来：POST 和 PATCH 都要用，写两遍早晚不一致。 */
function checkLen(label, value, max) {
  if (typeof value !== 'string') return null;   /* 类型不对由别处管，这里只查长度 */
  if (value.length > max) {
    return label + '太长（最多 ' + max + ' 个字符，当前 ' + value.length + ' 个）';
  }
  return null;
}

/* ===========================================================================
   Day 28 · 认证的常量与工具
   =========================================================================== */

/* ---- 登录态参数 ----
   ⚠️ AUTH_SECRET 不在文件里、不在仓库里：它是签名密钥（验证码包靠它防篡改），
      只能配在云函数的【环境变量】里（控制台 → 函数配置 → 环境变量）。
      谁拿到它谁就能伪造验证码包，所以按密钥对待：不发群、不截图、不写文档。 */
function authSecret() {
  var s = process.env.AUTH_SECRET;
  if (!s || String(s).length < 16) {
    /* 长度也拦一道：太短的密钥等于没锁。报错进控制台日志，对外只说 500。 */
    throw new Error('未配置 AUTH_SECRET 环境变量（或长度不足 16 位）');
  }
  return s;
}

var TOKEN_TTL_DAYS  = 30;      /* 登录态有效期：30 天。到期后 /me 会回 401，重新登录即可 */
var CAPTCHA_TTL_MS  = 120000;  /* 验证码 2 分钟有效 —— 够人看清并输入，长了只会帮倒忙 */

/* ---- 邀请码（Day 26 起替代图片验证码）----
   ⚠️ 音频有版权，注册门槛改成「开发者发放的邀请码」：不是所有人都能注册。
   邀请码配在环境变量 INVITE_CODES 里，逗号分隔可放多个 —— 现在先放一个固定码，
   后期要「批量生产一次性码」时再升级（届时可能改走数据库表 + 已用标记）。
   ⚠️ 默认值 '1'：斌哥临时定的占位码（先跑通门槛），后期换成环境变量的正式码。 */
function inviteCodes() {
  var s = process.env.INVITE_CODES || '1';
  return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

/* 用户名 / 密码的规矩。
   用户名 3~20 位、字母数字下划线（中文不收：URL 和展示层对它的处理差别太多，本期不趟）；
   密码至少 8 位 —— 再低就是摆设；上限 64 位是防"一个 1MB 的密码"这种纯恶意的输入。 */
var USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

/* 从请求头里取 Bearer token。
   ⚠️ 头名可能是 'Authorization' 也可能被平台统一成小写 'authorization' ——
      两个都看，别赌。值形如 "Bearer abc.def"，只取 token 本身。 */
function bearerToken(event) {
  var h = (event && event.headers) || {};
  var raw = h.Authorization || h.authorization || '';
  var m = /^Bearer\s+(.+)$/.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

/* 把「token → 当前用户」这条链收成一个函数 —— /me 和 logout 都要先验，
   写一处，两处行为永远不会不一致。
   返回 { ok:true, session, user } 或 { ok:false, res }（res 是现成的 401 响应）。 */
async function authByToken(event) {
  var token = bearerToken(event);
  if (!token) {
    return { ok: false, res: fail(401, 'not_logged_in', '请先登录') };
  }

  var sessions = await authRepo.findSession(token);
  if (!sessions || sessions.length === 0) {
    /* 查不到：token 从来没发过，或者已经被退出登录删掉了。 */
    return { ok: false, res: fail(401, 'not_logged_in', '登录状态已失效，请重新登录') };
  }

  var session = sessions[0];
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    /* 过期了。顺手把这行死会话删掉（懒清理）——
       不删它也能用（反正比对时间拦住了），但留着它，sessions 表只会越积越厚。 */
    try { await authRepo.deleteSession(token); } catch (e) { /* 清不掉不影响判定 */ }
    return { ok: false, res: fail(401, 'token_expired', '登录已过期，请重新登录') };
  }

  var users = await authRepo.findUserById(session.user_id);
  if (!users || users.length === 0) {
    /* 会话在、人没了（账号被删）→ 这个会话作废，删掉。 */
    try { await authRepo.deleteSession(token); } catch (e) { /* 同上 */ }
    return { ok: false, res: fail(401, 'not_logged_in', '登录状态已失效，请重新登录') };
  }

  return { ok: true, session: session, user: users[0] };
}

/* 解析 POST 请求体 → 普通对象

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
  /* ⚠️ 「查哪张表、要哪几列、怎么排序」已经搬进 boards.repo.js ——
     接口层只管拿回来、翻译、包成响应。 */
  var rows = await boardsRepo.listBoards();

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
  /* ⚠️ 「按 unit_tag 列筛」这个过滤条件也搬进 words.repo.js 了 ——
     接口层只管把 query.unit 递过去，不关心它落到哪个列上。 */
  var rows = await wordsRepo.listWords(query.unit);

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
    { key: 'id',    label: '词条 id（id）',      max: MAX_LEN.id },
    { key: 'title', label: '单词（title）',      max: MAX_LEN.title },
    { key: 'desc',  label: '释义（desc）',       max: MAX_LEN.desc }
  ];
  var missing = [];
  var badType = [];
  var tooLong = [];

  REQUIRED.forEach(function (f) {
    var v = body[f.key];
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(f.label);
    } else if (typeof v !== 'string') {
      /* 数字、布尔、对象……都不收：库里这三列是 TEXT，硬塞进去只会变成
         "[object Object]" 这样的脏数据，不如当场拒掉。 */
      badType.push(f.label);
    } else {
      /* Day 23：类型对了再查长度（超长也是「用户输入错」，要走 400 说清改什么）。 */
      var over = checkLen(f.label, v, f.max);
      if (over) tooLong.push(over);
    }
  });

  if (missing.length > 0) {
    return fail(400, 'missing_field', '缺少必填字段：' + missing.join('、'));
  }
  if (badType.length > 0) {
    return fail(400, 'invalid_field', '字段「' + badType.join('、') + '」必须是非空字符串');
  }
  /* ⚠️ 超长单独回一类 message —— 用户需要的是「哪个字段、超了多少」，好去改。 */
  if (tooLong.length > 0) {
    return fail(400, 'invalid_field', '字段过长：' + tooLong.join('；'));
  }

  /* tag 是可选字段：没给 / 给了空白 → 存 NULL（不是空字符串 —— 两者在库里含义不同）。
     Day 23：tag 也查长度（可选的字段同样可能被塞超长值）。 */
  if (body.tag !== undefined && body.tag !== null && String(body.tag).trim() !== '') {
    var tagOver = checkLen('单元（tag）', String(body.tag), MAX_LEN.tag);
    if (tagOver) return fail(400, 'invalid_field', '字段过长：' + tagOver);
  }
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
    inserted = await wordsRepo.createWord(row);
  } catch (err) {
    /* ⚠️ 「重复提交」不是服务端故障，是**业务上可预期的结果** —— 单独翻成 409，
       别让它混进 500。识别靠 rdbInsert 打的 conflict 标记（网关 409 或 SQLSTATE 23505）。
       这就是「防重复」的全部实现：**不做「先查后插」**（那样两个请求同时查、同时插，
       照样重复）—— 直接插、让**数据库主键**去拦，一次请求解决，天然没有竞态。

       ⚠️⚠️ Day 22 余力加练（软删除）在这里加了一层判断：
          主键撞车时，**先别急着报 409** —— 先查一下这个 id 是不是"被软删过的"：
            · 查得到、且 is_deleted = true  → **复活它**（把标记改回 false + 覆盖成新提交的值）
            · 查得到、且 is_deleted = false → 真的重复了 → 409（保持原行为）
            · 查不到（理论上不会，因为刚才明明撞了主键）→ 当作 409 兜底
          为什么要专门处理：软删只是"标记为删"，那一行**还占着主键**。
          用户 POST 同一个 id 时，如果直接 409，他会困惑 ——「我明明把它删了啊？」
          复活 = 让"删了再加回来"这个最自然的操作，真的能work。 */
    if (err && err.conflict) {
      /* 查这个 id（连已软删的也查得到）。查不动 / 查不到 → 按普通重复处理。 */
      var existing = [];
      try {
        existing = await wordsRepo.findWordById(row.id);
      } catch (e) {
        existing = [];
      }

      var prev = existing && existing[0];

      /* ① 找到了，而且它是被软删的 → 复活：清标记 + 覆盖字段。 */
      if (prev && prev.is_deleted === true) {
        var revived = await wordsRepo.restoreWord(row.id, {
          word:     row.word,
          meaning:  row.meaning,
          unit_tag: row.unit_tag
        });
        var rv = revived[0] || row;
        console.log('[echoread-api] POST /api/words 复活被软删的词条：id =', rv.id);
        return json(201, {
          ok: true,
          data: {
            id:    rv.id,
            title: rv.word,
            desc:  rv.meaning,
            tag:   rv.unit_tag
          }
        });
      }

      /* ② 找到了但没被删（活的），或压根查不到 → 才是真的重复 → 409。 */
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

/* ---- PATCH /api/words?id=w-xxx —— 改一条词条（Day 22 新增）----
   契约（api-contract.md 3.2 第 6 号 PATCH 子段）：
     URL 参数  id（必填）—— 改哪一条
     请求体    { title?, desc?, tag? } —— 至少给一个，不给 = 没说要改什么
     成功      200 { ok:true, data:{ id,title,desc,tag } }（改后的值）
     错误      400 missing_id / 400 invalid_body / 400 missing_field /
               400 invalid_field / 404 word_not_found / 409 duplicate_id

   ⚠️ 三个设计决定，都是有意的：
     ① **id 放 query、不放 body**：id 是「选中哪一条」，属于「定位」而不是「要改的内容」；
        放进 URL 让请求地址本身就是可复制的（curl 一条就能复现）。
     ② **id 不在可改字段里**：主键是这一行的身份，改主键 = 换了一条记录，
        不是「修改」而是「搬家」。真要换 id，那是先删后插的事。
     ③ **至少得改一个字段**：空 body（{}）不当作「什么都不改也算成功」——
        那是一次没意义的往返，直接回 400 让前端说清楚。

   ⚠️ 字段名翻译同 POST（进：网页叫法 → 库列名；出：库列名 → 网页叫法）。 */
async function patchWords(query, event) {
  /* ① 取 id（定位）。缺失直接回 400。 */
  var id = query && query.id ? String(query.id).trim() : '';
  if (!id) {
    return fail(400, 'missing_id', '缺少 id 参数：请在地址里带上 ?id=词条id');
  }

  /* ② 取请求体。 */
  var parsed = parseBody(event);
  if (!parsed.ok) {
    return fail(400, parsed.error, parsed.message);
  }
  var body = parsed.data;

  /* ③ 校验可改字段。
     可改的只有这三个（对应库里的 word / meaning / unit_tag）—— id 不在其中。
     ⚠️ 一次把缺的/错的收集齐再报，同 POST 的挤牙膏原则。 */
  var EDITABLE = [
    { key: 'title', label: '单词（title）' },
    { key: 'desc',  label: '释义（desc）' },
    { key: 'tag',   label: '单元（tag）' }
  ];

  var fields = {};      /* 库列名 → 新值（翻译后的） */
  var badType = [];
  var tooLong = [];
  var provided = 0;

  EDITABLE.forEach(function (f) {
    var v = body[f.key];
    if (v === undefined || v === null) {
      return;   /* 没给这个字段 = 不改它，正常 */
    }
    provided += 1;

    /* tag 允许「显式清空」：传空字符串 = 把单元置空（存 NULL）。
       title / desc 是必填性质的列，传空串是坏值，拒掉。
       Day 23：三个可改字段都补上长度校验。 */
    if (f.key === 'tag') {
      var tagOver = checkLen('单元（tag）', String(v), MAX_LEN.tag);
      if (tagOver) { tooLong.push(tagOver); return; }
      fields.unit_tag = (String(v).trim() === '') ? null : String(v).trim();
      return;
    }

    if (typeof v !== 'string' || v.trim() === '') {
      badType.push(f.label);
      return;
    }
    var over = checkLen(f.label, v, f.key === 'title' ? MAX_LEN.title : MAX_LEN.desc);
    if (over) { tooLong.push(over); return; }
    fields[f.key === 'title' ? 'word' : 'meaning'] = v.trim();
  });

  if (badType.length > 0) {
    return fail(400, 'invalid_field', '字段「' + badType.join('、') + '」必须是非空字符串');
  }
  /* Day 23：超长单独说 —— 告诉用户哪个字段、超了多少。 */
  if (tooLong.length > 0) {
    return fail(400, 'invalid_field', '字段过长：' + tooLong.join('；'));
  }

  if (provided === 0) {
    return fail(400, 'missing_field', '请求体里至少要有一个要改的字段：单词（title）、释义（desc）或单元（tag）');
  }

  /* ④ 改库。字段名已在上面翻成库列名（word / meaning / unit_tag）。 */
  var updated;
  try {
    updated = await wordsRepo.updateWord(id, fields);
  } catch (err) {
    /* 撞唯一约束（极少数：把某列改成了已存在的值）→ 409，与 POST 一致。 */
    if (err && err.conflict) {
      console.log('[echoread-api] PATCH /api/words 改后撞唯一约束：id =', id);
      return fail(409, 'duplicate_id', '修改后的值与已有记录冲突，请换一个值');
    }
    throw err;
  }

  /* ⑤ 空数组 = 没有任何一行匹配 → 这个 id 不存在 → 404。
     ⚠️ 这就是「删除/修改比新增更容易出事」的技术落点：新增不必先确认目标存在，
        改和删都**必须先确认目标在不在** —— 否则你会对着空气改、对着空气删，
        还以为成功了。用 return=representation 的回显来判，一次请求解决，没有竞态。 */
  if (!updated || updated.length === 0) {
    console.log('[echoread-api] PATCH /api/words 目标不存在：id =', id);
    return fail(404, 'word_not_found', '没有找到 id 为「' + id + '」的词条，无法修改');
  }

  var r = updated[0];
  console.log('[echoread-api] PATCH /api/words 修改成功：id =', r.id);

  return json(200, {
    ok: true,
    data: {
      id:    r.id,
      title: r.word,        /* word    → title */
      desc:  r.meaning,     /* meaning → desc  */
      tag:   r.unit_tag     /* unit_tag → tag  */
    }
  });
}

/* ---- DELETE /api/words?id=w-xxx —— 删一条词条（Day 22 新增）----
   契约（api-contract.md 3.2 第 6 号 DELETE 子段）：
     URL 参数  id（必填）—— 删哪一条
     成功      200 { ok:true, data:{ id,title,desc,tag } }（**被"删除"的那条**，留个底）
     错误      400 missing_id / 404 word_not_found

   ⚠️⚠️ Day 22 余力加练后：**这个接口已从"真删"改为"软删"**。
     执行的不再是 `DELETE FROM words`，而是 `UPDATE words SET is_deleted = true`：
       · 上层看到的效果一样 —— 删完 GET 就不返回它了（listWords 带 is_deleted=false 过滤）；
       · 但数据库里那一行**原封不动还在** —— 删错了、或者后悔了，把 is_deleted 改回 false 就回来了。
     ⇒ 这就是"删除比新增更容易出事"这把锁的**第二道保险**（第一道是 404 判定，第二道就是软删）。

   ⚠️ 为什么软删要用「改标记」来实现（而不是加一个"不真删"的 DELETE）：
      HTTP 的 DELETE 语义就是"删掉"，数据库层面兑现这个语义有两条路 ——
      真删（DELETE 语句）和软删（UPDATE 标记）。**方法名不变、语义升级**，
      前端和契约的形状（200 + data）都不用动，只是"删"的后果变得更可逆了。

   ⚠️ 关于"重复删同一个 id"：软删第 2 次时，那一行仍匹配（is_deleted 还是 true），
      所以回显不为空 → 返回 200。这没问题：删两次的结果都是"它不在了"，幂等。 */
async function deleteWords(query, event) {
  /* ① 取 id（定位）。缺失直接回 400。 */
  var id = query && query.id ? String(query.id).trim() : '';
  if (!id) {
    return fail(400, 'missing_id', '缺少 id 参数：请在地址里带上 ?id=词条id');
  }

  /* ② 软删（改标记，不是真删）。 */
  var removed;
  try {
    removed = await wordsRepo.softDeleteWord(id);
  } catch (err) {
    throw err;   /* 网络 / 网关 5xx 交给入口统一翻 500 */
  }

  /* ③ 空数组 = 没有匹配的行 → 这个 id 压根不存在 → 404。
     ⚠️ 这一条是「删除最会坑人的地方」的解药：不带 Prefer: return=representation 时，
        删一个不存在的 id，网关同样回成功 —— 用户会以为"删掉了"，
        实际什么都没发生（因为本来就没有）。显式判空 → 如实告诉用户"没有这条"，
        杜绝"我以为删掉了"的理解偏差。 */
  if (!removed || removed.length === 0) {
    console.log('[echoread-api] DELETE /api/words 目标不存在：id =', id);
    return fail(404, 'word_not_found', '没有找到 id 为「' + id + '」的词条，无需删除');
  }

  var r = removed[0];
  console.log('[echoread-api] DELETE /api/words 软删成功（is_deleted=true）：id =', r.id);

  /* ④ 把"被删掉"的那行**回显**出去 —— 前端能显示「已删除 w-xxx = abandon」，
     这是删除操作唯一还能拿到"删了什么"的机会（删完 GET 就没有了）。 */
  return json(200, {
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
   Day 28 · 认证接口（GET captcha / POST register,login,logout / GET me）
   ------------------------------------------------------------
   ⚠️ 响应形状沿用全站约定：成功 = {ok:true, data:{...}}，失败 = {ok:false, error, message}。
   ⚠️ 纯新增，不动 /api/words 的任何行为（契约冻结）。
   =========================================================================== */

/* ---- GET /api/auth/captcha 已停用（Day 26 起改用邀请码，见 postRegister）----
   图片验证码的签发 / 校验函数仍在 lib/auth.js 里保留着，以备后期
   「批量生产一次性邀请码」时复用它的 HMAC 签名机制。 */

/* ---- POST /api/auth/register —— 注册 ----
   请求体 { username, password, inviteCode }
   成功 201 { ok:true, data:{ id, username } }
   错误 400 invalid_invite / 400 invalid_field / 409 username_taken
   ⚠️ 注册成功【不自动登录】—— 前端紧接着调 login 走一遍完整流程。
      多一次往返，换来"注册和登录是两条路"这件事始终清晰。 */
async function postRegister(query, event) {
  var parsed = parseBody(event);
  if (!parsed.ok) return fail(400, parsed.error, parsed.message);
  var body = parsed.data;

  /* ① 先验邀请码 —— 开发者预设的固定码，不是所有人都能注册。
        不查库、不耗数据库往返（纯内存比对），把没拿到码的人拦在最便宜的一步。 */
  var invite = (typeof body.inviteCode === 'string') ? body.inviteCode.trim() : '';
  var codes = inviteCodes();
  if (!codes.length || codes.indexOf(invite) === -1) {
    console.log('[echoread-api] 注册被拒：邀请码未通过');
    return fail(400, 'invalid_invite', '邀请码不对，请向开发者获取');
  }

  /* ② 校验用户名 / 密码。一次收集齐再报，同 words 那套「不挤牙膏」的规矩。 */
  var problems = [];
  var username = (typeof body.username === 'string') ? body.username.trim() : '';
  var password = (typeof body.password === 'string') ? body.password : '';

  if (!USERNAME_RE.test(username)) {
    problems.push('用户名要 3~20 位，只能是字母、数字或下划线');
  }
  if (password.length < 8) {
    problems.push('密码至少 8 位');
  } else if (password.length > 64) {
    problems.push('密码最多 64 位');
  }
  if (problems.length > 0) {
    return fail(400, 'invalid_field', problems.join('；'));
  }

  /* ③ 查重：先查一遍是为了给人话（409 username_taken）；
        真撞了唯一约束（竞态兜底）在插入那里再接一道。 */
  var existed = await authRepo.findUserByUsername(username);
  if (existed && existed.length > 0) {
    return fail(409, 'username_taken', '这个用户名已经被注册了，换一个试试');
  }

  /* ④ 建号。⚠️ 明文密码到此为止：hashPassword 之后，明文只活在这个函数的局部变量里，
        请求一返回就没了 —— 库里只有哈希（SELECT 肉眼可查），日志里永远没有它。 */
  var rows;
  try {
    rows = await authRepo.createUser({ username: username, password_hash: auth.hashPassword(password) });
  } catch (err) {
    if (err && err.conflict) {
      return fail(409, 'username_taken', '这个用户名已经被注册了，换一个试试');
    }
    throw err;
  }

  var u = (rows && rows[0]) || { id: null, username: username };
  console.log('[echoread-api] 注册成功：id =', u.id, 'username =', u.username);
  return json(201, { ok: true, data: { id: u.id, username: u.username } });
}

/* ---- POST /api/auth/login —— 登录 ----
   请求体 { username, password }
   成功 200 { ok:true, data:{ token, expiresAt, user:{ id, username } } }
   错误 400 invalid_field / 401 bad_credentials
   ⚠️ 「用户不存在」和「密码不对」回【同一句】话、同一个码 ——
      分开说等于帮人探测"这个用户名注册过没有"，那是漏洞不是贴心。 */
async function postLogin(query, event) {
  var parsed = parseBody(event);
  if (!parsed.ok) return fail(400, parsed.error, parsed.message);
  var body = parsed.data;

  var username = (typeof body.username === 'string') ? body.username.trim() : '';
  var password = (typeof body.password === 'string') ? body.password : '';
  if (!username || !password) {
    return fail(400, 'invalid_field', '用户名和密码都要填');
  }

  var found = await authRepo.findUserByUsername(username);
  var user = (found && found[0]) || null;

  /* ⚠️ 用一个固定结尾统一两个失败路径：用户没查到也要"验一次密码"
     （跟一个假哈希比，必输）—— 让「没这个用户」和「密码错了」的耗时长得一样，
     耗时差异也是能被探测的信息。 */
  var hash = user ? user.password_hash : auth.hashPassword('placeholder-not-a-real-password');
  var passOk = auth.verifyPassword(password, hash);
  if (!user || !passOk) {
    return fail(401, 'bad_credentials', '用户名或密码不对');
  }

  /* 发 token、写会话。 */
  var token = auth.newToken();
  var expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await authRepo.createSession({ token: token, user_id: user.id, expires_at: expiresAt.toISOString() });

  console.log('[echoread-api] 登录成功：id =', user.id, 'username =', user.username);
  return json(200, {
    ok: true,
    data: {
      token: token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, username: user.username }
    }
  });
}

/* ---- GET /api/auth/me —— 我是谁（token 换用户信息）----
   请求头 Authorization: Bearer <token>
   成功 200 { ok:true, data:{ user:{ id, username } } }
   错误 401 not_logged_in / 401 token_expired */
async function getMe(query, event) {
  var authed = await authByToken(event);
  if (!authed.ok) return authed.res;

  return json(200, {
    ok: true,
    data: { user: { id: authed.user.id, username: authed.user.username } }
  });
}

/* ---- POST /api/auth/logout —— 退出登录 ----
   请求头 Authorization: Bearer <token>
   成功 200 { ok:true }
   ⚠️ 幂等：token 已经不在了（重复退出）也回成功 —— 两次退出的结果都是"不在了"，
      与 DELETE /api/words 对已删 id 再删一次的容忍是同一个道理。 */
async function postLogout(query, event) {
  var token = bearerToken(event);
  if (!token) {
    return fail(401, 'not_logged_in', '请先登录');
  }
  await authRepo.deleteSession(token);
  console.log('[echoread-api] 退出登录：token 已作废');
  return json(200, { ok: true });
}

/* ===========================================================================
   Day 28 晚 · 学习时长（复读时长）—— 上报 + 排行榜
   ---------------------------------------------------------------------------
   口径（斌哥拍板）：**只算复读功能真正在放音的时间**。
     由前端在"音频在播"时累计秒数，心跳式上报；服务端只负责"收多少算多少"，
     不去猜用户在干什么（猜不准，还会把"挂着不听"算成学习）。

   为什么是心跳而不是"进页面记一笔、退页面记一笔"：
     关页 / 断网 / 手机切后台被杀 —— 最后一笔根本发不出去，时长就丢了。
     心跳 = 每 60 秒报一次"这一段我确实在听"，丢了最多丢一个周期。

   ⚠️ 榜单口径：只回"前 N 名 + 我自己"，不回全榜 ——
      前端要的是一眼看懂，少传一份就少泄露一份（谁排第几，同班可见够了）。
   =========================================================================== */

/* 一次心跳最多认多少秒。前端心跳周期 60 秒，这里给到 180（3 个周期）——
   留足"标签页被浏览器节流、心跳迟了两拍"的余量，又不至于一次刷出几小时。 */
var MAX_BEAT_SECONDS = 180;

/* 宽限：本次可接受的秒数 = min(180, 距上次上报的秒数 + 90)。
   ⚠️ 这一条才是真正的防刷 —— 只卡 180 的绝对值，脚本一秒调一次、每次报 180，
      照样能凭空刷出天文数字。加上"不能比我实际等的时间多太多"之后，
      刷榜速度被压回真实时长附近（90 秒补偿网络往返与节流）。 */
var BEAT_GRACE_SECONDS = 90;

/* 榜单条数上限（挡 ?limit=999999 把整表拖回来） */
var LEADERBOARD_MAX = 50;
var LEADERBOARD_DEFAULT = 5;

/* 算"我的名次"时最多往下扫多少名；超出范围回 rank:null（前端显示"榜外"）。
   为什么不去扫全表：免费版云函数 3 秒超时锁死，为一个名次拉全表不划算。
   用户量真上来之后，换成"统计比我高的人数"的计数查询（网关要开 gt 过滤）。 */
var RANK_SCAN = 200;

/* ---- POST /api/usage/beat —— 上报一段复读时长 ----
   请求头 Authorization: Bearer <token>
   请求体 { seconds: <正整数> }
   成功 200 { ok:true, data:{ added, totalSeconds } }
   错误 401 not_logged_in / 400 invalid_field */
async function postUsageBeat(query, event) {
  var authed = await authByToken(event);
  if (!authed.ok) return authed.res;

  var parsed = parseBody(event);
  if (!parsed.ok) return fail(400, parsed.error, parsed.message);

  var seconds = parsed.data.seconds;
  /* ⚠️ Number.isInteger 卡死：'60' 这种字符串、1.5 这种小数、NaN 一律挡在外面。
     数字就是数字，不接受"看起来像数字"的东西 —— 这条规矩在 /api/words 也这么用。 */
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return fail(400, 'invalid_field', 'seconds 必须是正整数（秒）');
  }

  var now = new Date();
  var rows = await usageRepo.findTotalByUserId(authed.user.id);
  var row = rows[0];

  /* 封顶：先按"距上次上报过了多久 + 宽限"算上限，再压到绝对值上限里 */
  var delta = seconds;
  if (row && row.last_beat_at) {
    var elapsed = (now.getTime() - new Date(row.last_beat_at).getTime()) / 1000;
    var cap = Math.min(MAX_BEAT_SECONDS, Math.max(0, elapsed) + BEAT_GRACE_SECONDS);
    if (delta > cap) delta = Math.floor(cap);
  } else if (delta > MAX_BEAT_SECONDS) {
    delta = MAX_BEAT_SECONDS;
  }

  /* 封顶后剩 0 秒（同一瞬间重复上报）→ 什么都不写，把现状原样回给他。
     ⚠️ 不写库是有意的：让重复请求无害，也少一次数据库往返。 */
  if (delta <= 0) {
    return json(200, {
      ok: true,
      data: { added: 0, totalSeconds: row ? row.total_seconds : 0 }
    });
  }

  var total = (row ? row.total_seconds : 0) + delta;
  var patch = {
    total_seconds: total,
    last_beat_at: now.toISOString(),
    updated_at: now.toISOString()
  };

  if (row) {
    await usageRepo.updateTotal(authed.user.id, patch);
  } else {
    patch.user_id = authed.user.id;
    try {
      await usageRepo.createTotal(patch);
    } catch (err) {
      /* ⚠️ 竞态兜底：同一个人两个设备同时"第一次心跳"，两边都没读到行、
         都走插入 → 第二个撞主键。这里接住它改成更新，别把可自动化解的
          冲突抛成 500（跟注册时用唯一约束兜底是同一个思路）。 */
      if (err && err.conflict) {
        await usageRepo.updateTotal(authed.user.id, patch);
      } else {
        throw err;
      }
    }
  }

  return json(200, { ok: true, data: { added: delta, totalSeconds: total } });
}

/* ---- GET /api/usage/leaderboard?limit=5 —— 复读时长榜 ----
   请求头 Authorization: Bearer <token>（要看"我的名次"，必须登录）
   成功 200 { ok:true, data:{
              me:  { totalSeconds, rank },              rank 为 null = 榜外
              top: [ { rank, username, totalSeconds } ]
            } }
   错误 401 not_logged_in */
async function getUsageLeaderboard(query, event) {
  var authed = await authByToken(event);
  if (!authed.ok) return authed.res;

  var limit = parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = LEADERBOARD_DEFAULT;
  if (limit > LEADERBOARD_MAX) limit = LEADERBOARD_MAX;

  /* 一次取"够算名次"的量：前 limit 名一定在内，另外多扫一些好找我自己 */
  var rows = await usageRepo.listTopTotals(Math.max(limit, RANK_SCAN));
  var users = await usageRepo.listAllUsersBrief();

  var nameById = {};
  users.forEach(function (u) { nameById[String(u.id)] = u.username; });

  var top = [];
  var me = { totalSeconds: 0, rank: null };
  for (var i = 0; i < rows.length; i++) {
    var entry = {
      rank: i + 1,
      username: nameById[String(rows[i].user_id)] || '已注销账号',
      totalSeconds: rows[i].total_seconds
    };
    if (i < limit) top.push(entry);
    if (String(rows[i].user_id) === String(authed.user.id)) {
      me = { totalSeconds: rows[i].total_seconds, rank: i + 1 };
    }
  }

  return json(200, { ok: true, data: { me: me, top: top } });
}

/* ===========================================================================
   路由表：路径 → { 方法: 处理函数 }
   ⚠️ Day 18 改了形状：原来是「路径 → 函数」（隐含只支持 GET），
      现在一个路径可以挂多个方法（如 /api/words 既有 GET 又有 POST）。
      以后加接口，只在这里加一行（外加写一个处理函数），不用再动网关。
   Day 22：/api/words 再挂上 PATCH 和 DELETE —— 这一个路径现在支持四种方法，
           对应「增（POST）删（DELETE）改（PATCH）查（GET）」四类操作。
   =========================================================================== */
var ROUTES = {
  '/api/health': { GET: getHealth },
  '/api/boards': { GET: getBoards },
  '/api/words':  { GET: getWords, POST: postWords, PATCH: patchWords, DELETE: deleteWords },
  /* Day 28：认证五个端点，纯新增。⚠️ /api/words 一行没动（契约冻结）。 */
  '/api/auth/register': { POST: postRegister },
  '/api/auth/login':    { POST: postLogin },
  '/api/auth/me':       { GET: getMe },
  '/api/auth/logout':   { POST: postLogout },
  /* Day 28 晚：学习时长两个端点，纯新增（老接口一行没动，契约依旧冻结） */
  '/api/usage/beat':        { POST: postUsageBeat },
  '/api/usage/leaderboard': { GET: getUsageLeaderboard }
};

/* ===========================================================================
   请求日志（Day 23 余力加练）—— 一次请求一行，打印到控制台「日志监控」

   为什么加它：云函数出问题时，这里往往是**唯一**能还原现场的地方 ——
     CloudBase 只留平台自己的调用记录，业务层面「谁在什么时候调了什么、结果如何」
     得我们自己打。Day 22 的 `w-abandon` 丢失事件就吃过这个亏：
     **删了却没人察觉，三天后才发现**，当时想回溯「谁删的」完全没有线索。

   ⚠️ 三条刻意的取舍：
     ① **不打 query string**。`?unit=` / `?id=` 都是用户输入，可能很长
        （有人塞 10KB 的 unit 就能把日志刷爆），而且里面可能有不该落盘的内容。
        只打**路径**，够定位就行。
     ② **不打请求体**。同理，POST 的 body 里是用户数据。
     ③ **结果只打状态码 + 错误短码**，不打 message —— message 是给人看的中文，
        排查时看短码（invalid_field / not_found / db_error…）更快、更省地方。

   格式（时间 | 方法 路径 | 结果 | 耗时）：
     [echoread-api] 2026-10-12T10:55:00.000Z | GET /api/words | 200 | 137ms
     [echoread-api] 2026-10-12T10:55:01.000Z | POST /api/words | 400 invalid_field | 3ms
     [echoread-api] 2026-10-12T10:55:02.000Z | GET /api/nope | 404 not_found | 0ms
   =========================================================================== */
function logRequest(method, path, res, ms) {
  var status = (res && res.statusCode) || 0;

  /* 从响应体里抠出错误短码（成功就没有）。body 是我们自己 JSON.stringify 的，
     但解析失败也绝不该影响正常返回 —— 所以整个包在 try 里：
     **日志失败不能拖垮接口**。 */
  var code = '';
  try {
    var body = JSON.parse(res.body);
    if (body && body.ok === false && body.error) code = ' ' + body.error;
  } catch (e) {
    /* body 不是 JSON，作罢 */
  }

  console.log(
    '[echoread-api] ' + new Date().toISOString() +
    ' | ' + method + ' ' + path +
    ' | ' + status + code +
    ' | ' + ms + 'ms'
  );
}

/* ===========================================================================
   函数入口
   event   —— 这次 HTTP 请求的信息（方法、路径、头、参数、body）
   context —— 运行环境信息（函数名、环境 ID、请求上下文等）
   两个参数都由 CloudBase 注入，我们只读不写。
   =========================================================================== */
exports.main = async function (event, context) {
  var began = Date.now();   /* ① 开工时刻。收口时减一下就是耗时（Day 23 请求日志） */

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

  /* ⚠️ Day 23：所有分支只往 out 写，**出口收敛成一个 return**。
     为什么改形状：请求日志要给「每一次请求」都记一行。要是还像以前那样
     在四个分支里各 return 一次，就得在四处都插一句 logRequest —— 漏一处留一个盲区。
     收敛成一个出口后，日志只写一次，天然覆盖全部路径（含 404 / 405 / 500）。 */
  var out;

  /* ① 先按路径找。找不到 = 这个路径根本不存在 → 404
     （跟「路径在、但方法不对」是两回事，别混成一个错误）。 */
  var route = ROUTES[path];
  if (!route) {
    out = fail(404, 'not_found', '没有这个接口');
  } else {
    /* ② 再看这个方法挂没挂处理函数。
       ⚠️ Day 18 的改动就在这儿：原来「非 GET/HEAD 一律 405」是**写死**的；
          现在改成「这个路径支持哪些方法，就看路由表里挂了哪些」——
          /api/words 挂了 GET 和 POST ⇒ 这俩都通，PUT 才 405。
          message 里列出该路径**实际支持**的方法，用户一看就知道该怎么调。 */
    var handler = route[method];
    if (!handler) {
      var allowed = Object.keys(route).join('、');
      out = fail(405, 'method_not_allowed', '该接口只支持 ' + allowed);
    } else {
      try {
        /* event.queryStringParameters —— URL 上 ?a=1&b=2 那部分，CloudBase 已经解析成对象。
           没有问号参数时它可能是 undefined，兜一个空对象，省得下游到处判空。
           ⚠️ event 也一并传下去 —— 写接口（POST）要从 event.body 取请求体。 */
        var query = event.queryStringParameters || {};
        out = await handler(query, event);
      } catch (err) {
        /* 未配 Key、网关报错、网络超时……都落到这里。
           ⚠️ 不把 err.message 原样吐给前端 —— 那里面可能带主机名、状态码、内部细节。
              人话给用户，详细原因留给控制台的日志（console.error 会进「日志监控」）。 */
        console.error('[echoread-api] 接口出错:', err && err.message ? err.message : err);
        out = fail(500, 'db_error', '服务端出错，请稍后再试');
      }
    }
  }

  /* ③ 无论走的是上面哪条路，都在这里记一行，然后统一出口。 */
  logRequest(method, path, out, Date.now() - began);
  return out;
};
