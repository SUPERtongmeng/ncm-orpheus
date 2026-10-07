# Orpheus · 网易云 Agent 点歌桥

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933) ![MCP](https://img.shields.io/badge/MCP-stdio-6e56cf)

让 **Hermes / Codex / 任意支持 MCP 的 Agent** 用自然语言控制本机网易云音乐的播放：点歌、放歌单、查待播队列、暂停/切歌/音量。

插件跑在网易云里（负责真正操作播放器），Agent 只负责理解你的话和选歌，两者通过本机的一个小服务连接。

```
你: "放一首 Novo Amor"  →  Agent(MCP)  →  本机桥接服务(127.0.0.1:17632)  →  BetterNCM 插件  →  网易云播放器
                                              ↑ 配对令牌鉴权 / 结果回传
```

> 命名彩蛋：网易云自己的内部协议就叫 `orpheus://`，而俄耳甫斯（Orpheus）是希腊神话中的音乐之神。

## 目录结构

```
orpheus/
├── src/
│   ├── server.js         本地 HTTP + WebSocket 桥接服务（Agent ←→ 插件的中间层）
│   ├── mcp.js            MCP stdio 服务器：把 19 个工具暴露给 Agent
│   ├── tools.js          工具定义 + zod 参数校验（唯一可信的参数边界）
│   ├── client.js         内部：MCP → 桥接服务的 HTTP 客户端
│   ├── ensure-service.js 内部：MCP 启动时自动拉起桥接服务
│   ├── config.js         读写 .local/config.json（端口 + 配对令牌）
│   ├── cli.js            命令行调用单个工具（调试用）
│   └── install.js        把插件安装进 BetterNCM
├── plugin/
│   ├── manifest.json     BetterNCM 插件清单（name: Orpheus, slug: orpheus）
│   └── main.js           插件运行时：运行时探测网易云接口、执行命令、回报结果
└── test/                 单元测试（node --test）
```

## 前置条件

- Node.js **≥ 20**
- 网易云音乐 PC 版 **3.1.20 ~ 3.x**（已在 3.1.41 上实测）
- [BetterNCM](https://github.com/BetterNCM/BetterNCM) **≥ 1.3.4**（已装好并注入）
- 网易云已登录账号（歌单、权限相关操作需要）

## 安装

**1. 安装依赖**

```bash
cd outputs/orpheus
npm install
```

**2. 把插件装进 BetterNCM**（会自动生成本机配对令牌）

```bash
# 参数是 BetterNCM 的数据目录，默认 C:/betterncm
node src/install.js C:/betterncm
```

它会把 `plugin/` 复制到 `C:/betterncm/plugins_dev/orpheus/`，并写入 `connection.json`（内含本机 `ws://127.0.0.1:<port>/plugin` 和配对令牌）。然后**重启网易云**让插件加载（BetterNCM 不热重载）。

**3. 起桥接服务**（一般不用手动起——MCP 启动时会自动拉起来）

```bash
npm start        # 手动启动，监听 127.0.0.1:17632
```

健康检查：`curl -H "Authorization: Bearer <token>" http://127.0.0.1:17632/health`

## 接入 Agent

### Hermes

```bash
printf 'y\n' | hermes mcp add orpheus \
  --command "C:/Program Files/nodejs/node.exe" \
  --args "<绝对路径>/orpheus/src/mcp.js" \
  --connect-timeout 30
```

> `hermes mcp add` 会问 "Enable all 19 tools? [Y/n]"，非交互环境会被取消，所以用 `printf 'y\n' |` 喂答案。

### Codex

在 `~/.codex/config.toml` 追加：

```toml
[mcp_servers.orpheus]
command = 'C:\Program Files\nodejs\node.exe'
args = ['<绝对路径>\orpheus\src\mcp.js']
startup_timeout_sec = 60
```

### 其他 MCP 客户端

按标准 stdio 服务器配置：命令 = `node`，参数 = `src/mcp.js` 的绝对路径。

## 工具（19 个）

| 工具 | 作用 | 类型 |
|---|---|---|
| `get_player_state` | 读当前歌曲、播放状态、音量、连接能力 | 只读 |
| `search_music` | 搜真实歌曲/歌单，返回真实 ID（点歌前先核对） | 只读 |
| `list_my_playlists` | 读已登录账号的歌单（不改云端） | 只读 |
| `list_charts` | 列出官方排行榜（飙升榜/新歌榜/热歌榜/原创榜…）拿 id | 只读 |
| `play_daily` | 播放「每日推荐」歌曲（按口味每日更新） | 写·替换队列 |
| `get_lyric` | 读当前歌曲歌词（含翻译） | 只读 |
| `like_song` | 喜欢 / 取消喜欢当前歌曲 | 写 |
| `set_speed` | 播放速度 0.5–2.0 | 写 |
| `set_quality` | 切换音质（标准/极高/无损/Hi-Res/音效） | 写 |
| `blacklist` | 屏蔽当前歌曲或歌手 | 写 |
| `create_playlist` | 新建歌单 | 写·账号 |
| `add_to_playlist` | 把歌曲加入歌单（默认当前歌曲） | 写·账号 |
| `remove_from_playlist` | 从歌单移除歌曲 | 写·账号 |
| `delete_playlist` | 删除歌单（不可逆） | 写·账号 |
| `get_queue` | 分页读当前待播队列 | 只读 |
| `play_song` | 立即播放指定歌曲 ID，**保留已有待播列表** | 写 |
| `play_playlist` | 用指定歌单**替换**本地播放队列并开始播放（不改云端歌单） | 写 |
| `enqueue` | 把歌曲 ID 追加进待播队列，不打断当前歌曲 | 写 |
| `control_player` | pause / resume / next / previous / volume(0–100) / mode(list·single·random·order·fm·ai) | 写 |

## 安全设计

- 桥接服务只监听 `127.0.0.1`，不对外网开放
- 插件→服务、Agent→服务 都用配对令牌鉴权（常量时间比较）
- 拒绝带 `Origin` 的请求（防浏览器页面调用），阻塞无关的跨站请求
- **不暴露任何"执行任意代码"的工具**，参数由 zod 白名单校验（歌曲 ID 必须是数字等）
- 不导出账号 Cookie，不调用第三方音乐 API，全部走网易云客户端自身的接口

## 已知行为与限制

- **点歌确认机制**：只有客户端回读确认目标状态才返回 `verified:true`。屏蔽接口目前仅能确认请求被接受，返回 `accepted:true, verified:false`；喜欢操作未回读到目标状态也会明确返回 `verified:false`。超时返回 `TIMEOUT`，**不要自动重试写操作**
- 无版权/VIP 不可播的歌返回 `UNPLAYABLE`，不会假装成功
- `play_playlist` 会替换当前待播队列（不可逆），且受 1000 首上限约束
- `next` / `previous` 走网易云内部 dispatch（`playingList/jump2Track`；FM 模式走 `fmPlaying/playNext|playPre`），不依赖易碎的 DOM 选择器
- `volume` 通过原生音频接口设置
- 队列结构若与预期不符会明确报 `UNSUPPORTED_QUEUE`，而不是静默返回错误数据

## 测试

```bash
npm test        # 鉴权、异常消息、超时并发、云端写操作模拟、时长、真实 MCP 握手
```

## 0.1.1 可靠性与性能改进

- 异常 WebSocket 消息只关闭对应连接，不再导致桥接服务退出。
- 请求超时后保持执行锁，直到原命令结束或插件断线；避免超时后并行写入。若接口一直挂起，后续命令返回 `BUSY`，需要等待或重启网易云。
- 每次云端写入前检查截止时间，不自动换参数重试。**已经发出的网易云请求无法撤回**，超时仍可能意味着操作已执行但未确认。
- 歌单增删使用完整列表验证；无效响应、缺失数据、截断列表均不算成功。创建歌单只按返回的新 ID 验证；删除歌单逐页核对。
- `ids: []` 明确报错；省略 `ids` 仍表示当前歌曲。账号歌单查询按页读取、去重后返回指定范围，兼容接口额外附带的置顶或创建歌单。
- 播放状态 `durationMs` 统一为毫秒，增加 `pluginVersion` 便于确认加载版本。
- API 函数按需解析并缓存，歌单读取绕过客户端结果缓存；找到所需模块即停止扫描；批量歌曲比对使用 Set；文档隐藏时跳过面板刷新，主题检测最多每 5 秒一次。
- 工具清单由 `src/tools.js` 生成到插件，安装时自动同步；开发时运行 `npm run sync-tools`。测试会检测清单漂移。

升级后需重启网易云以加载新版插件，并重启本地桥接服务；不会改变账号登录配置或配对令牌。测试使用模拟云端接口，不修改真实歌单。以上改动减少了重复扫描和比对工作，但尚未测量真实客户端 CPU/内存变化。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `PLUGIN_OFFLINE: 请打开网易云并启用 Orpheus` | 网易云没开，或插件没加载 → 重启网易云；检查插件面板状态 |
| 插件面板显示"尚未配对" | 没跑 `install.js`，缺 `connection.json` |
| `NOT_CONFIRMED` | 客户端没确认目标状态；可能是版权、网络或网易云接口变化，先查当前状态 |
| 切歌报 `NOT_CONFIRMED` | 客户端 `playingList/jump2Track` 行为变化（网易云改版），需重新核对内部 dispatch |
| 端口被占用 | 服务可能已在运行；`curl .../health` 确认，或改 `.local/config.json` 的 port |

---

> 本项目通过运行时探测网易云 3.x 的 webpack 模块来定位其内部接口（搜索、歌曲详情、歌单、播放派发等），因此对客户端小版本更新有一定耐受性；但网易云改版仍可能导致接口失效，此时对应工具会明确报错而非静默失败。

## 许可证

[MIT](LICENSE) © 2026 SUPERtongmeng

仅供个人学习与自用。使用时请遵守网易云音乐的服务条款，不要用于传播版权内容或账号共享。
