/* ============================================
   server.js —— 线上发布入口（Day 9 新增）

   为什么需要这个文件：
     页面里「点某一句就播这一句」依赖音频 seek，而 seek 的前提是服务器支持
     Range（分段取数据）—— 浏览器会先要「从第 18 秒开始那一段字节」，
     服务器回 206 Partial Content + Content-Range，浏览器才允许跳。
     实测线上（静态托管）不带 Range：带 Range 头去请求，回来的仍是
     200 + 整个文件（1602297 字节）、没有 Content-Range、也没有 Accept-Ranges
     → 浏览器拿不到分段数据 → currentTime 赋值无效 → 拖动进度条跳播失效。

     平台判断「这是个 Node 应用」的依据就是根目录下有 server.js；
     把它放进来，发布时才会按 Node 服务启动，从而用上下面真正实现了 Range 的服务器。
     若没有这个文件，目录会被当成纯静态站，Range 问题依旧。

   本文件【不重复实现】Range —— 真正的实现在 dev-server.js 里
   （越界防护、MIME、Range 解析、HEAD 处理都已具备）。
   两份逻辑各写一遍早晚会不一致，所以这里只是一层入口，require 过去，
   本地开发（node dev-server.js 8000）和线上（node server.js）跑的是同一份代码。
   ⚠️ dev-server.js 已改成「argv → process.env.PORT → 8000」取值，
      所以线上由平台注入的 PORT 能直接生效，不需要在这里再传参。
   ============================================ */

require('./dev-server.js');
