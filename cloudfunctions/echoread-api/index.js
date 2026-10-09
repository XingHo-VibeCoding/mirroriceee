/* ============================================
   echoread-api —— CloudBase 云函数（Day 15 新建）

   今天只做一件事：对外提供一个健康检查接口 GET /api/health。
   不连数据库、不写业务逻辑，纯粹回答一句「服务活着吗」。

   为什么先做它：
     它是后面所有接口的「探针」。等 Day 16 建了 PostgreSQL、
     Day 17 写了第一个真接口，一旦前端调不通，第一件事就是先敲
     这个地址 —— 它通，说明是业务问题；它不通，说明是部署或路由问题。
     有它，排查时就不用靠猜。

   怎么被触发：
     不走 SDK 调用，走「HTTP 访问服务」——
     在控制台把路径 /api/health 映射到这个函数，它就得到一个公网地址。

   返回格式说明（关键，别改）：
     返回值里带 statusCode 字段时，CloudBase 会把它当作「集成响应」，
     按你写的 statusCode / headers / body 原样构造 HTTP 响应。
     不带 statusCode 时，整个对象会被当成 body 自动 JSON 化 ——
     那样就没法区分 200 和 405 了。
   ============================================ */

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

/* 函数入口。
   event   —— 这次 HTTP 请求的信息（方法、路径、头、参数、body）
   context —— 运行环境信息（函数名、环境 ID、请求上下文等）
   两个参数都由 CloudBase 注入，我们只读不写。 */
exports.main = async function (event, context) {
  /* event.httpMethod —— 这次请求用的 HTTP 方法（GET / POST / …）。
     先转成大写再比较，避免大小写差异导致误判。 */
  var method = String(event.httpMethod || 'GET').toUpperCase();

  /* 今天只开放 GET。
     为什么顺带放行 HEAD：有些浏览器和监控探针会先发一个 HEAD 探一下，
     被拒会误报「接口挂了」。放行它、不返回 body 即可。
     其余方法（POST / PUT / DELETE）一律 405 —— HTTP 里「方法不允许」的标准码。 */
  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, {
      ok: false,
      error: 'method_not_allowed',
      message: '该接口只支持 GET'
    });
  }

  /* 正常路径：返回健康状态。
     service 填 "echoread" —— 项目名。将来多个服务并存时，一眼认出是谁在应答。 */
  return json(200, {
    ok: true,
    service: 'echoread'
  });
};
