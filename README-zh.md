<div align="right">

[English](README.md) | **简体中文**

</div>

# dsh-remote-cf

[DSH Remote](https://github.com/AS214933/ds-harness-remote) 服务端的 Cloudflare Workers 移植版。

单账号，和自托管原版一致：一个来自环境变量的账号，没有用户表，没有身份提供方。
区别只在运行位置——跑在 Cloudflare 边缘，用一个 Durable Object 持有全部 WebSocket。

> 英文文档见 [README.md](README.md)。

## 为什么做这个移植

原版服务端是单个 Node 进程，把所有连接放在内存里。这几乎能一比一映射到 Durable
Object：一个实例、一个有状态 actor、长连接。在这个平台上单账号成本是 **$0/月**，
而且不需要维护服务器。

两个平台事实让这个方案成立，都是**实测**而非假设：

- **1 MiB 的 WebSocket 消息完整通过** —— 协议的帧上限正好是 1 MiB，实测 2 MiB
  也能原样往返，所以帧契约不需要任何改动。
- **25 秒的 alarm 心跳可用** —— 实测间隔 25,021 ms，协议声明的间隔可以照用，
  不需要放宽。

## 它做什么

```
客户端 / Host ──WSS──► Worker（无状态）
                       ├── /api/*  → REST
                       ├── /ws/*   → Durable Object
                       ├── /healthz
                       └── 其他一切 → 418
                                       ├── 全部 WebSocket
                                       ├── peers / links
                                       ├── relay 转发
                                       └── SQLite：devices、tokens、lockout
```

- 设备注册、凭据签发/刷新/吊销
- WebSocket 网关：`hello` 认证、peer 管理、link 状态机
- 两端之间的不透明加密 relay
- WebRTC 信令转发（offer/answer/ice、传输选择）
- Cloudflare Realtime TURN 凭据（可选；没有它 Relay 仍可用）
- alarm 驱动的心跳、登录锁定、按账号和按来源的限流

**服务端看不到明文**：它只转发 Noise 密文、协调传输方式。它无法解密会话内容、
提示词或工具输出。

## 部署

```bash
npm install

# 必需密钥 —— 必须用 secret，不能写成 var（var 在面板可读、会被 deploy 回显）
npx wrangler secret put SESSION_SECRET          # >= 16 字符，签会话 cookie
npx wrangler secret put DSH_SERVER_PASSWORD     # >= 8 字符

# 改 wrangler.jsonc 里的 account_id 和 PUBLIC_URL，然后：
npx wrangler deploy
```

`wrangler.jsonc` 的 `vars` 放非敏感配置：

| 变量 | 含义 |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | 唯一账号，例如你的邮箱 |
| `DSH_SERVER_PUBLIC_URL` | 公开 origin，必须和浏览器 origin 完全一致 |
| `DSH_SERVER_ROOT_PAGE` | 设为 `assets` 时 `/` 返回静态页面；默认返回 418 |
| `DSH_SERVER_ALLOWED_ORIGINS` | 允许跨域调用 API 的浏览器源，逗号分隔 |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | 可选，Cloudflare Realtime TURN |
| `DSH_SERVER_HEARTBEAT_INTERVAL_MS` | 可选，默认 25000，范围 5000–120000 |

然后把客户端指向部署地址：`DSH_REMOTE_SERVER=https://<你的-worker>`。

### 修改账号密码

账号是普通变量，改 `wrangler.jsonc` 的 `DSH_SERVER_ACCOUNT` 后重新 deploy：

```bash
# 改密码
npx wrangler secret put DSH_SERVER_PASSWORD

# 改账号
# 编辑 wrangler.jsonc 里的 DSH_SERVER_ACCOUNT，然后：
npx wrangler deploy
```

两者都**不影响已签发的会话**。要强制所有设备重新登录，轮换 `SESSION_SECRET` 并
在后台吊销设备。

### 关于 TURN Key

`TURN_KEY_API_TOKEN` 是高权限密钥：拿到它的人可以**无限签发 TURN 凭据**，
吃光免费额度。必须用 `wrangler secret put`，绝不能写进 `vars`、代码或日志。

## 默认返回 418

这个部署**没有公开网页**。客户端只用 `/api/*` 和 `/ws/v1/connect`，其他路径一律
返回 **418 I'm a teapot**：

```
GET /              → 418
GET /.env          → 418
GET /admin         → 418
GET /wp-admin      → 418
```

这是刻意的：

- 扫描器探测管理面板、`.env`、WordPress 时，得到的回应和真实访问者完全一样，
  无法从状态码差异推断这里跑的是什么。
- 不返回 HTML，所以没有技术栈线索，也不会被搜索引擎索引（带 `X-Robots-Tag`）。
- 阻止静态资源处理器把任意未知路径都变成 200 的 SPA 页面——那会让服务器看起来
  有一个它其实没有的网页界面。

如果确实要提供网页界面，把 `DSH_SERVER_ROOT_PAGE` 设为 `assets`，`/` 就会返回
`public/` 里的静态文件。

## 本地开发

```bash
npx wrangler dev -c wrangler.dev.jsonc   # 用文件里的测试凭据
node test/e2e.mjs                        # 23 项端到端检查
npx vitest run                           # 45 个单元测试
```

`wrangler.dev.jsonc` 仅供本地使用，里面是一次性凭据。真实配置是
`wrangler.jsonc`。

## 测试

| 套件 | 覆盖内容 |
| --- | --- |
| `test/protocol.test.ts` | 帧解码、上限、重复键拒绝、标识符与版本解析 |
| `test/crypto.test.ts` | 摘要、会话 cookie 签名/篡改/过期、时间均衡、配置边界 |
| `test/e2e.mjs` | 真实 Worker + DO：登录、设备生命周期、token 轮换与重用、WS 握手 |
| `test/host-connect.mjs` | **真实 Host 插件客户端** 连真实服务端 |
| `test/data-plane.mjs` | **真实 Noise IK 隧道** 穿过服务端 relay |
| `test/webrtc-path.mjs` | **真实 WebRTC 数据通道** 经服务端协商 |
| `test/turn-relay.mjs` | **强制走 TURN**（`iceTransportPolicy: relay`）证明中继可用 |
| `test/client-flow.mjs` | **插件真实登录流程**，含 Host 认领环节 |

`e2e.mjs` 跑在真实 `wrangler dev` 上而非 mock —— 目的就是把 SQLite 存储、
alarm 心跳和网关放在真实运行时里一起验证。

`host-connect.mjs` 更进一步：从 `ds-harness-remote` 检出里 import
`HostServerApi`、`IdentityStore`、`ServerCredentialStore`，直接驱动它们访问本服务端，
所以契约不匹配会在这里暴露，而不是在生产环境。用 `DSH_REPO` 指向那个检出：

```bash
DSH_REPO=/path/to/ds-harness-remote npx tsx test/host-connect.mjs \
  https://your-worker you@example.com 'your-password'
```

它覆盖：真实 X25519 身份生成、通过正版 API 的账号登录与设备注册、凭据加载、
host 的读取路径、控制 WebSocket hello、以及心跳 ping/pong 往返。

`data-plane.mjs` 再深一层，是证明服务端**真的有用**的那个测试：两个 peer 经服务端
信令完成 **Noise IK 握手**，然后穿过它交换**加密载荷**——client 到 host、host 回
client、256 KiB 载荷按 Noise 分片大小切块、以及一个被故意倒回的重放计数（服务端拒绝）。

`webrtc-path.mjs` 和 `turn-relay.mjs` 用 `@roamhq/wrtc`（真实原生 WebRTC 栈，
所以 ICE、DTLS、SCTP 都是真的）覆盖协商传输。后者是运维上最关键的那个：它设置
`iceTransportPolicy: 'relay'`，让 ICE 代理**只**收集 relay 候选，因此连接一旦成立
就必然经过 TURN 服务器。这正是对称 NAT 下 peer 所处的处境，也是唯一能证明签发的
凭据**真的能中继流量**、而不只是格式正确的办法。

## 生产验证结果

部署在 `https://dsh-relay.example.workers.dev`，全部在真实边缘环境验证：

| 项目 | 结果 |
| --- | --- |
| 真实 Host 插件 | 17/17 |
| Noise 加密数据面 | 13/13 |
| WebRTC P2P 数据通道 | 12/12 |
| TURN 强制中继 | 12/12 |
| 单元测试 | 45 通过 |
| 本地端到端 | 23 通过 |

## 设计说明

**单账号、扁平模型。** 没有 D1、没有分片、没有多租户：所有设备属于那一个账号，
所以 `peers` 和 `links` 就是普通 Map，也没有跨账号校验可以写错。

**错误以数据形式跨越 RPC 边界。** 抛出的错误在 structured clone 里会丢掉 `code`
和 `status`，所以 Gateway 的 RPC 返回 `Result` 信封，由 Worker 映射成 HTTP。
没有这层，所有失败都会变成 `500`。

**alarm 绝不碰 SQLite。** 会写库的心跳会和进行中的登录争同一个数据库句柄，而登录
时的 busy timeout 就是一次故障。alarm 只发帧和重排自己。

**失败路径做时间均衡。** 错密码和不存在的地址必须耗时相同，否则响应时间就成了
账号名枚举器。两个摘要总是都计算并比较，绝不短路。

**refresh 重用会吊销设备。** 被重放的 refresh token 意味着上一个响应被截获了；
再发一对新凭据等于让攻击者续期。

**连接级失败不拖垮整个 Host。** 一个 peer 的协议错误只丢弃那一条 link，否则
Host 的其它客户端会被一起踢掉。

## 限制

- **TURN 需要 Cloudflare Realtime TURN 或另建 coturn。** Workers 无法承载 TURN
  服务器，只能签发凭据。
- **代码发布会断开 WebSocket。** 客户端本来就会重连。
- **只支持单账号。** 多账号需要每账号一个 DO 加 D1，而且心跳就得避开会阻止休眠
  的定时器。
- **与上游项目无隶属关系。** 这是对一个协议设计的独立移植，协议本身由上游记录。

## 许可

MIT
