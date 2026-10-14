/* 词库选择器：决定当前这一页用哪本词库
 *
 * 优先级：词库包 dicts.js 里用户选中的那本
 *       → window.WORDS（手写兜底，正常情况下是空的）
 *       → 空（各游戏自己退回内置的 20 词兜底词表）
 *
 * 为什么单独一个文件：四个游戏页 + 入口页都要「现在该用哪些词」这个答案，
 * 挑选逻辑放一份，免得五个地方各写一遍、改一处漏四处。
 */
(function () {
  var DEFAULT_ID = 'cet4';

  var pack = window.DICTS || null;

  // 读用户上次的选择。localStorage 在个别环境会被禁（抛异常），所以必须 try
  var id = DEFAULT_ID;
  var storageOk = true;
  try {
    var saved = window.localStorage.getItem('wordgame_dict');
    if (saved) id = saved;
  } catch (e) {
    storageOk = false;
  }

  // 选的那本不在包里（比如包重新打包后删掉了），退回默认；再不行退回第一本
  if (pack) {
    if (!pack[id]) id = pack[DEFAULT_ID] ? DEFAULT_ID : Object.keys(pack)[0];
  }

  window.DICT_STORAGE_OK = storageOk;
  window.DICT_ID = pack ? id : 'single';
  window.PICKED_WORDS = (pack && pack[id] && pack[id].words) || window.WORDS || [];

  // 下拉框要用的清单，打包器没给就自己从包里现算
  if (!window.DICT_LIST || !window.DICT_LIST.length) {
    window.DICT_LIST = pack
      ? Object.keys(pack).map(function (k) {
          return { id: k, name: pack[k].name, category: pack[k].category, count: pack[k].words.length };
        })
      : [];
  }

  /* 切换词库：写进 localStorage 再刷新页面。
     写不进去（storage 被禁）就不刷新，直接返回 false 让页面提示用户，
     否则刷新后选择会丢，用户会以为是坏的。 */
  window.setDict = function (newId) {
    if (!pack || !pack[newId]) return false;
    try {
      window.localStorage.setItem('wordgame_dict', newId);
    } catch (e) {
      return false;
    }
    window.location.reload();
    return true;
  };

  /* 当前选中那本的信息，给页面显示用 */
  window.currentDictInfo = function () {
    if (!pack) return { id: 'single', name: '单库模式', count: window.PICKED_WORDS.length };
    var d = pack[window.DICT_ID];
    return { id: window.DICT_ID, name: d.name, category: d.category, count: d.words.length };
  };
})();
