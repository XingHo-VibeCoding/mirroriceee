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
     · DELETE /api/words?id=w-xxx —— 删一条词条（**真删**）
     ⚠️ 为什么 id 走 query 参数（?id=）而不是 /api/words/{id} 这种路径参数：
        路径参数要动网关的「路径透传」配置，能不能碰就不碰；
        而 query 参数跟 GET ?unit= 是同一套路，网关压根不用改。
     ⚠️ 「删除为什么比新增更容易出事」—— 这个答案写在这一层的 deleteWords 里，
        一句话：新增错了只是多一条，删除错了是**少一条、且找不回来**。

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
    inserted = await wordsRepo.createWord(row);
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
  var provided = 0;

  EDITABLE.forEach(function (f) {
    var v = body[f.key];
    if (v === undefined || v === null) {
      return;   /* 没给这个字段 = 不改它，正常 */
    }
    provided += 1;

    /* tag 允许「显式清空」：传空字符串 = 把单元置空（存 NULL）。
       title / desc 是必填性质的列，传空串是坏值，拒掉。 */
    if (f.key === 'tag') {
      fields.unit_tag = (String(v).trim() === '') ? null : String(v).trim();
      return;
    }

    if (typeof v !== 'string' || v.trim() === '') {
      badType.push(f.label);
      return;
    }
    fields[f.key === 'title' ? 'word' : 'meaning'] = v.trim();
  });

  if (badType.length > 0) {
    return fail(400, 'invalid_field', '字段「' + badType.join('、') + '」必须是非空字符串');
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
     成功      200 { ok:true, data:{ id,title,desc,tag } }（**被删掉的那条**，留个底）
     错误      400 missing_id / 404 word_not_found

   ⚠️⚠️ 「删除为什么比新增更容易出事」—— 今天要掌握的那件事，答案在这个函数里：

     新增：插进去的东西**看得见**（GET 一查就在），错了再删一次就完了。
     删除：一执行，那一行就从业务里**消失**了，而且这是 `DELETE`（真删）——
           数据库不会给你「回收站」，找回来要靠备份或者重敲一遍。
     更要命的是「删错对象」：以为删的是测试数据，实际删的是种子数据；
     或者 id 拼错、少了个字母，命令照样"成功"。

     ⇒ 所以删除这条路上，三层都必须有：
        · 接口层（这里）：**id 不存在就明确回 404**，绝不说"删除成功"糊弄过去。
        · 前端（check.js）：**二次确认**，让人在真正动手前再看一眼「要删的是谁」。
        · 契约文档：把「这是真删、不可恢复」写明白，别让人以为能撤。
     三层里少一层，就会出现"我以为删掉了 / 我以为没删掉"这种理解偏差。 */
async function deleteWords(query, event) {
  /* ① 取 id（定位）。缺失直接回 400。 */
  var id = query && query.id ? String(query.id).trim() : '';
  if (!id) {
    return fail(400, 'missing_id', '缺少 id 参数：请在地址里带上 ?id=词条id');
  }

  /* ② 删库。 */
  var removed;
  try {
    removed = await wordsRepo.deleteWord(id);
  } catch (err) {
    throw err;   /* 网络 / 网关 5xx 交给入口统一翻 500 */
  }

  /* ③ 空数组 = 没有匹配的行 → 这个 id 压根不存在 → 404。
     ⚠️ 这一条是「删除最会坑人的地方」的解药：不带 Prefer: return=representation 时，
        删一个不存在的 id，网关同样回 204/成功 —— 用户会以为"删掉了"，
        实际什么都没发生（因为本来就没有）。显式判空 → 如实告诉用户"没有这条"，
        杜绝"我以为删掉了"的理解偏差。 */
  if (!removed || removed.length === 0) {
    console.log('[echoread-api] DELETE /api/words 目标不存在：id =', id);
    return fail(404, 'word_not_found', '没有找到 id 为「' + id + '」的词条，无需删除');
  }

  var r = removed[0];
  console.log('[echoread-api] DELETE /api/words 删除成功：id =', r.id);

  /* ④ 把被删掉的那行**回显**出去 —— 前端能显示「已删除 w-xxx = abandon」，
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
  '/api/words':  { GET: getWords, POST: postWords, PATCH: patchWords, DELETE: deleteWords }
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
