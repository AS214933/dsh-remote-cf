# 与原版 server 的差异清单

对照 `apps/server/src` 逐项核对（2026-11-06，原版 v0.6.3）。

## 结论

**核心协议与安全行为完全一致。** 发现的差异集中在两类：上限数值，以及我额外增加的运维能力。

---

## 一、必须修正的差异

| 项 | 原版 | 我的 | 影响 |
| --- | --- | --- | --- |
| **WebSocket 连接上限** | **256** | 512 | 超限时原版拒绝新连接；我的接受更多，免费额度下可能超支 |
| **links 上限** | **256** | 512 | 同上 |
| **`transport.selected` 阶段校验** | 仅 `accepted`/`handshake` | 任意阶段 | 我的会转发 `ready` 阶段的重复选择，原版丢弃 |
| **`lan` → `p2p` 降级** | 有 | **无** | 老客户端（未协商 lan）发出 `lan` 时，原版降级为 `p2p`，我直接拒绝 |
| **`relay` 的老 host 兼容** | `selected === 'relay' && !modernHost(other.version)` 时**静默丢弃** | 直接转发 | 老 host 会收到它不认识的帧 |

## 二、我有、原版没有的（增强）

| 项 | 说明 |
| --- | --- |
| `DELETE /api/v1/account/devices/{id}` | 账号级吊销任意设备。原版只能设备自删 |
| 418 默认响应 | 无公开网页，防指纹 |
| CORS 白名单 | 浏览器工作台需要；原版同源假设 |
| hello 拒绝原因日志 | 原版只记 `ws_hello_authenticated` 成功路径 |
| TURN 用 Cloudflare Realtime | 原版自建 coturn |

## 三、原版有、我未实现的（有意省略）

| 项 | 原因 |
| --- | --- |
| `POST /api/v1/hooks/logto` | 改用环境变量账号密码，无 Logto |
| Logto M2M 认证 | 同上 |
| 密码过期检查 | 同上 |
| `--env` 驱动的多账号 | 单账号设计 |

## 四、完全一致的部分

逐项核对确认无差异：

- **路由**：12 个 API 路由全部对齐（除 logto hook）
- **帧类型**：18 种控制帧全覆盖
- **帧预算**：512 帧 / 16 × 1 MiB 每秒
- **ICE 候选上限**：256/连接
- **慢消费者阈值**：`bufferedAmount > 4 × MAX_RELAY_FRAME_BYTES`
- **心跳**：25s 间隔、75s 断线、nonce 校验
- **`hello.ack` 字段**：逐字段一致
- **`connect.request` 校验顺序**：含 `HOST_OFFLINE` 反枚举
- **设备配额**：64/账号
- **Token 配额**：1024/账号
- **Token TTL**：access 1h、refresh 30d
- **会话 TTL**：8h
- **限流**：API 240/min、登录 20/min、账号 60/min
- **peer 响应字段**：`identityKey` 单端点有、列表剥离
