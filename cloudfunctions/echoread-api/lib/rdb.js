/* ============================================
   lib/rdb.js —— PG REST 网关客户端（数据访问层的「地基」）

   Day 19：这个文件是**新建**的。里面的三个常量（ENV_ID / REST_BASE / REST_TIMEOUT_MS）
   和两个函数（rdbSelect / rdbInsert），原先是 index.js 中部的一大段，
   **一字未改地搬了过来** —— 行为跟搬之前完全一样，只是换了个住处。

   Day 22：补齐「写」的另一半 —— 原来只会「读一行 / 插一行」，
     今天加「改一行 / 删一行」：
       · rdbUpdate —— PATCH /v1/rdb/rest/<表>?<过滤>（改）
       · rdbDelete —— DELETE /v1/rdb/rest/<表>?<过滤>（删）
     两个都带 Prefer: return=representation，网关会把「改后 / 被删的那行」回显回来。
     ⇒ 这是它俩最有用的地方：**回显空数组 = 那一行压根不存在**，
       不用「先查再改/删」（那是竞态写法），一次请求就能兼顾「做事」和「说清结果」。

   ⚠️ 余力加练（软删除）不需要在这里加新函数 —— 两个现成家伙就够了：
      · 软删：rdbUpdate(表, { is_deleted: true }, [['id', id]])  —— 改标记，不真删
      · 过滤：rdbSelect(表, ..., [['is_deleted', 'false']])       —— 查询跳过已删
      「软删是改、不是删」这一点很重要：它复用了 rdbUpdate，rdbDelete 就留给真正的物理删除。
      （本函数库只负责「怎么跟网关说话」；「软删还是真删」是上层 repositories 的业务决定。）

   为什么单独放一个文件：
     它是【全站唯一】跟数据库网关说话的地方。「怎么把话递到数据库」
     ——拼地址、带 Key、编码参数、超时、把网关的英文错误翻成人话——
     统统关在这一个文件里。以后网关地址变了、超时该调了，只改这里，
     接口层（index.js）一行都不用动。

   ⚠️ 数据是怎么取到的（Day 17 定的，一直没变，记在这儿别忘）
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

   ⚠️ 两条必须守住的约定（订在 api-contract.md 里，动它就等于动前端）：
     ① 用户输入永远不拼进查询串 —— 必须 encodeURIComponent（这里就是「参数化」的位置）
     ② 表名只允许传【代码里写死的常量】，绝不接受用户输入
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
   改一行（PATCH /v1/rdb/rest/<表>?<过滤>）

   table   —— 表名。同前：只允许传【代码里写死的常量】。
   patch   —— 要改的字段，键是**数据库列名**（字段名翻译由调用方做完），
              值是要写进去的新值。
   filters —— 「改哪一行」的等值过滤，形如 [['id', 'w-abandon']]。
              ⚠️ 这个是**必须给的** —— 不带过滤的 PATCH 会改掉整张表，那是事故不是本事。

   返回：网关回显的**数组** —— 改成功 = 改后那一行；数组为空 = 没有匹配的行
         （也就是「这个 id 不存在」）。调用方靠 `rows.length === 0` 判 404。
   出错就抛；「唯一约束冲突」（比如把某一列改成了已存在的值）额外带 conflict = true。
   --------------------------------------------------------------------------- */
async function rdbUpdate(table, patch, filters) {
  var apiKey = process.env.CLOUDBASE_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 CLOUDBASE_API_KEY 环境变量');
  }

  var qs = ['select=*'];
  (filters || []).forEach(function (f) {
    qs.push(encodeURIComponent(f[0]) + '=eq.' + encodeURIComponent(f[1]));
  });

  var url = REST_BASE + '/v1/rdb/rest/' + table + '?' + qs.join('&');

  var res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      /* 同 rdbInsert：不加这句，网关默认 return=minimal，只回一个空 body，
         我们就分不清「改到了」和「没这行」。 */
      Prefer: 'return=representation'
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
  });

  if (!res.ok) {
    var detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* 读不出就作罢 */ }
    var err = new Error('REST ' + res.status + ' ' + detail);
    err.status = res.status;
    /* 改一个值撞了唯一约束（如把 id 改成别人已占的）→ 翻 409，与 POST 那套一致。 */
    err.conflict = (res.status === 409) || detail.indexOf('23505') !== -1;
    throw err;
  }

  var out = await res.json();
  return Array.isArray(out) ? out : [out];
}

/* ---------------------------------------------------------------------------
   删一行（DELETE /v1/rdb/rest/<表>?<过滤>）

   table   —— 表名。同前：只允许传【代码里写死的常量】。
   filters —— 「删哪一行」的等值过滤，形如 [['id', 'w-abandon']]。
              ⚠️ 同 rdbUpdate：**必须给** —— 不带过滤的 DELETE 会清空整张表。

   返回：网关回显的**数组**（return=representation）—— 删成功 = 被删掉的那一行；
         数组为空 = 没有匹配的行（即「这个 id 不存在」）。调用方靠 `rows.length === 0` 判 404。
   出错就抛。
   --------------------------------------------------------------------------- */
async function rdbDelete(table, filters) {
  var apiKey = process.env.CLOUDBASE_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 CLOUDBASE_API_KEY 环境变量');
  }

  var qs = ['select=*'];
  (filters || []).forEach(function (f) {
    qs.push(encodeURIComponent(f[0]) + '=eq.' + encodeURIComponent(f[1]));
  });

  var url = REST_BASE + '/v1/rdb/rest/' + table + '?' + qs.join('&');

  var res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json',
      /* ⚠️ 这一句是「删得明白」的关键：默认 return=minimal 只回一个 204 空响应，
         那我们就永远不知道「删掉的是哪一行」「是不是压根没这行」。
         加了它，被删的那一行原样回来 —— 前端能显示「已删除 w-xxx = abandon」，
         空数组则说明 id 不存在，可以正大光明地回 404。 */
      Prefer: 'return=representation'
    },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS)
  });

  if (!res.ok) {
    var detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* 读不出就作罢 */ }
    var err = new Error('REST ' + res.status + ' ' + detail);
    err.status = res.status;
    throw err;
  }

  /* DELETE 成功且 return=minimal 时网关回 204，这里 body 是空的 —— 兜一层，
     避免 res.json() 在空 body 上抛错（本项目一直是 representation，属防御性写法）。 */
  var text = '';
  try { text = await res.text(); } catch (e) { /* 读不出就作罢 */ }
  if (!text) return [];

  var out;
  try { out = JSON.parse(text); } catch (e) { return []; }
  return Array.isArray(out) ? out : [out];
}

/* ⚠️ 这里是这个文件对外的「接口」—— 只放上面这两个函数。
   外面（repositories / index.js）拿到的是这两个名字，不是内部细节。 */
module.exports = {
  rdbSelect: rdbSelect,
  rdbInsert: rdbInsert,
  rdbUpdate: rdbUpdate,
  rdbDelete: rdbDelete
};
