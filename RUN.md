# RUN.md · 运行与自验说明

本项目是纯前端静态站点：**没有构建步骤，没有需要安装的依赖**。
但**必须用一个支持 Range（分段请求）的本地服务器打开**，不能双击 HTML 文件——原因见第四节。

## 一、环境要求

- Node.js 18 或以上（只用到标准库 `http` / `fs` / `path` / `os`，无第三方依赖）
- 现代浏览器（Chrome / Edge / Safari）
- 全程本地运行，不需要联网

## 二、启动

在项目根目录执行：

```
node dev-server.js
```

默认端口 8000。端口被占用时换一个：

```
node dev-server.js 8001
```

启动成功后终端会打印四行：本地访问地址、网站根目录、一行状态说明、以及手机访问用的局域网地址。

## 三、打开

- **电脑**：浏览器访问 `http://localhost:8000/`
  - 首页点「文本跟读」即可进入跟读页
  - 跟读页直达：`http://localhost:8000/reader.html`
- **手机（真机验收用 —— 本期暂缓）**：本期以 PC 端验收为准（见 `PRD.md` §2.3）。若日后要手机验证：手机与电脑连同一个 Wi-Fi，访问启动时打印的那条局域网地址
- **停止**：在跑服务器的那个终端窗口按 `Ctrl + C`

## 四、为什么不能用别的方式打开（两种都踩过）

### 双击 `index.html` 不行

双击打开时地址栏是 `file:///...`。浏览器出于安全限制会拦截本地文件发起的 `fetch` 请求，导致 `data/materials.json` 读不到，页面停在「正在加载素材…」。
另外，课程完成标准也要求地址栏是 `localhost` 开头。

### `python -m http.server` 也不行

它**不支持 Range（分段请求）**。
「点第 8 句、从第 18 秒开始播」这个动作，底层是浏览器向服务器索取「从第 18 秒对应的字节开始的那一段」：支持 Range 的服务器回 `206 Partial Content` + `Content-Range`，浏览器才允许跳播；Python 那个极简服务器只会回 `200` + 整个文件，浏览器拿不到分段数据，于是**直接禁止 seek**——`audio.currentTime = 18` 落空，点哪一句都从头播整段。

所以项目自带 `dev-server.js`，它做三件事：支持 Range、关闭浏览器缓存、启动时打印局域网地址。

## 五、自验（三条命令，看输出就知道对不对）

```bash
# 1) 页面能打开 —— 期望 200
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/
curl -o /dev/null -w "%{http_code}\n" http://localhost:8000/reader.html

# 2) 音频能分段 —— 期望 206（这条是关键，坏了跳播就一定是坏的）
curl -s -o /dev/null -D - -H "Range: bytes=1000-1999" http://localhost:8000/assets/audio/oh-im-really-sorry.mp3
```

第 2 条要能看到 `HTTP/1.1 206 Partial Content` 与 `Content-Range: bytes 1000-1999/1602297`（`1602297` 是当前这个音频文件的总字节数）。
如果看到的是 `200`，说明你用的服务器不是 `dev-server.js`，跳播功能一定不工作。

## 六、目录结构

```
vibe-coding-30days/
├─ index.html          首页（三个板块入口；当前只有「文本跟读」可进入）
├─ reader.html         跟读页
├─ dev-server.js       本地服务器（支持 Range）
├─ RUN.md              本文件
├─ data/
│   ├─ materials.json  素材清单
│   └─ segments.json   每一句的起止秒数与文本
└─ assets/
    ├─ css/style.css   样式；配色变量集中在文件顶部 :root
    ├─ js/app.js       读取数据、渲染素材与句子、加载失败提示
    ├─ js/player.js    播放控制（点句播放 / 进度条跳播 / 单句重复）
    └─ audio/          音频素材
```
