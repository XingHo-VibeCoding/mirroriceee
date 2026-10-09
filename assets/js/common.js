/* ============================================
   common.js —— 几个视图共用的取数与状态工具（Day 13）
   ------------------------------------------------------------
   为什么现在才抽出来：
     loadJSON / failureHTML / escapeHTML 这一套，Day 8 时在 home.js（首页）
     和 app.js（跟读页）里各写了一份 —— 当时只有两个页面，重复还扛得住，
     TECH_DESIGN.md §2.1 把这笔账记成「等页面多到第三、第四页，再抽成共用文件不迟」。
     Day 13 做到了第三、第四个页面（词汇速记 / 作文模板），账到这里结：
     新页面统一引这一份。

   ⚠️ 本轮【不动】home.js 与 app.js —— 那两个页面已按 PRD 第六节的验收标准跑通过，
      改它们等于把已验证的东西拉回风险里。等哪天顺手再收编，不在这天的清单内。

   术语备注：
     fetch —— 浏览器自带的「取文件」函数，从本页往下去找 data 目录下的 JSON
     JSON  —— 一种纯文本数据格式，人和机器都能读
   ============================================ */

/* 取一个 JSON 文件；读不到就抛错，交给调用方统一处理。
   失败原因分三类打标签（kind），因为给用户看的话不一样：
     network —— 断网 / DNS 挂了 / 被拦了
     http    —— 服务器答了，但不是 200（404 文件不在、500 服务器炸了）
     parse   —— 文件拿到了，但里面不是合法 JSON（手写少个逗号就会这样） */
function loadJSON(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) {
      var e = new Error('HTTP ' + res.status);
      e.kind = 'http';
      e.url = url;
      throw e;
    }
    return res.json().catch(function () {
      var e2 = new Error('内容不是合法 JSON');
      e2.kind = 'parse';
      e2.url = url;
      throw e2;
    });
  }, function () {
    /* fetch 自己 reject 了：根本没连上服务器 */
    var e3 = new Error('网络连不上');
    e3.kind = 'network';
    e3.url = url;
    throw e3;
  });
}

/* 文本里的 & < > 要转义，否则数据文件里一个尖括号就能把页面结构冲乱 */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* 把失败翻译成人话 —— 绝不能让用户看到 "Failed to fetch" 这种英文报错。
     what   这次没取到的是什么（「词表」「作文模板」…）：写进句子里，用户才知道卡在哪一步
     action 重试按钮的 data-action 值：各页面认自己的那一个，互不干扰
   返回值直接是 HTML：一句人话 ＋ 一个重试入口（PRD R6 要求失败必须能重试，不能只有一句话） */
function failureHTML(err, what, action) {
  var label = escapeHTML(what || '内容');
  var text;

  if (err.kind === 'network') {
    text = '网络连不上，加载不了' + label + '。请检查网络后点下面的「重试」。';
  } else if (err.kind === 'http') {
    text = '服务器没能提供' + label + '（' + err.message + '）。请稍后点「重试」。';
  } else if (err.kind === 'parse') {
    text = label + '读不出来（' + err.message + '）。这是数据文件本身的问题，请联系维护者。';
  } else {
    text = label + '加载失败：' + err.message;
  }

  return '<p class="empty">' + escapeHTML(text) + '</p>' +
         '<button type="button" class="btn item" data-action="' + escapeHTML(action) + '">重试</button>';
}
