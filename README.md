# dsh-pet-mcp

让任意 agent 遥控 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 桌宠的 MCP 服务器：让它开口说话、演动作、报状态。

> A zero-dependency MCP server that lets any agent drive a [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) desktop pet: make it talk, play animations, read its state. No patches to dsh-pet — it only uses the plugin's public HTTP endpoints.

零依赖、单进程、只用 dsh-pet 自带的第三方端点 —— **不改 dsh-pet 一行源码**。

```
agent ──MCP(stdio)──> dsh-pet-mcp ──HTTP──> DSH web server ──> dsh-pet 桌宠
```

## 它提供什么

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `pet_say` | 让桌宠说一句指定的话（气泡），可配一张表情包 | `text`（必填）、`image`、`pet` |
| `pet_anim` | 让桌宠播一个动画 | `name`（必填）、`pet` |
| `pet_status` | 读状态：有哪些宠物、最后说的话 / 表情包 / 动画 | `pet` |
| `pet_catalog` | 列出能播的动画与能配的表情包，可按关键词过滤 | `query`、`pet` |

动画名和表情包名都是**素材文件名**（传错就 404，表现为「点了没反应」），所以写几个字就行，服务器会做模糊匹配：

- 「吃白饭」→ `吃白饭`
- 「泡泡鲸鱼」→ `鲸鱼吐泡泡特效`（字序不同也能命中）
- 「跳舞」→ 不硬猜，回候选：`轻快摇摆舞 / 可爱宅舞 / 优雅女仆舞`

## 前置条件

1. 装好并启用 **dsh-pet**（它会在 DSH 的 web server 上注册 `/dsh-pet-7340/*` 端点）。
2. DSH 正在运行，且你知道它的 web 地址（浏览器里那个 `http://127.0.0.1:<端口>`）。
3. Node.js >= 18（需要内置 `fetch`）。

自检：把下面地址里的端口换成你的，能返回一段 JSON 就说明通：

```
http://127.0.0.1:43129/dsh-pet-7340/state
```

## 安装

不用 `npm install`，克隆下来就能跑：

```bash
git clone https://github.com/komoretz/dsh-pet-mcp.git
```

### 方式一：挂进 DeepSeek Harness（推荐）

在 profile 的 `cordis.patch.yml` 里加一段（完整样例见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)）：

```yaml
- insert:
    - id: mcp-dsh-pet
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dsh-pet
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'   # 建议写绝对路径
        args:
          - 'C:\path\to\dsh-pet-mcp\src\server.js'
        env:
          DSH_PET_BASE_URL: 'http://127.0.0.1:43129'
```

保存后重启 DSH（MCP 工具清单是启动时读的）。之后会话里就会多出 `pet_say` / `pet_anim` / `pet_status` / `pet_catalog`。

### 方式二：任何 MCP 客户端

```bash
node src/server.js --base-url http://127.0.0.1:43129
```

它是个 stdio 服务器：手动跑只会看到它在等 stdin，正常由客户端 spawn。

## 配置

| 来源 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 环境变量 | `DSH_PET_BASE_URL` | `http://127.0.0.1:43129` | DSH web 地址（端口会变，按实际填） |
| 环境变量 | `DSH_PET_ID` | 第一只 | 默认操作哪只宠物（多只时用） |
| 命令行 | `--base-url` / `--pet` | — | 优先于环境变量 |

## 用起来是什么样

> 你：让桌宠跳个舞
> agent：（调 `pet_anim("跳舞")`）→ 拿到候选 → 调 `pet_anim("轻快摇摆舞")` → 「动了动了」

> 你：跟它说「该吃饭了」
> agent：（调 `pet_say({text:"该吃饭了", image:"吃白饭"})`）→ 气泡里出现这句话和配图

## 安全边界（请读一下）

- **没有权限模型。** dsh-pet 的 `/dsh-pet-7340/*` 端点本身不做鉴权，所以任何能调用这个 MCP 服务器的 agent（或者任何能访问 `127.0.0.1:43129` 的进程）都能驱动桌宠。要「只给某个人用」，得在调用侧做（例如你的聊天机器人的工具白名单），这个服务器不提供。
- 只连**本机回环地址**。不要把 DSH 的端口暴露到公网，否则桌宠就是别人的玩具。
- 不会读写本地文件、不执行命令、不发起任意网络请求：它只对 `${DSH_PET_BASE_URL}/dsh-pet-7340/*` 发请求。
- `image` 只认 dsh-pet 配置里已有的表情包名（模糊匹配后取真名），不接受路径或 URL。
- 气泡文本上限 200 字（超出截断），避免一条消息糊住整只宠物。

## 实现说明

- **零依赖**：MCP 的 stdio 传输就是「一行一个 JSON-RPC 消息」，150 行的协议层足够；没有依赖树 = 没有安装失败、没有供应链噪音。
- **业务失败走 `isError` 而不是 JSON-RPC 错误**：连不上 DSH、名字没匹配上、桌宠拒收，这些是「工具失败」不是「服务器坏了」，模型要拿到可读原因才能换个说法重试。
- **名字匹配分两档阈值**：>= 0.75 才自动播，0.5~0.75 只当候选 —— 猜错一个字就播一段莫名其妙的动画，比让模型重挑更糟。
- 测试用假的 dsh-pet HTTP 服务（本机随机端口），不 spawn 子进程、不联网。

```bash
npm test     # 14 + 15 条断言
```

## 已知限制

- 只能「说话 / 播动画 / 读状态」。移动位置、换装、增删宠物这些 dsh-pet 没开放，做不了。
- dsh-pet 的动画名是中文文件名，不同素材包名字不一样；匹配不上时用 `pet_catalog` 看一眼。
- DSH 换端口后要改 `DSH_PET_BASE_URL`，否则会报「连不上 DSH」。

## License

MIT