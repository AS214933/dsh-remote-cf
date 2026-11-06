# 待办：手机连接需要重连多次

> 状态：**未解决**，日志已定位到卡点，但缺最后一次复现确认。
> 2026-11-06 晚。

## 现象

手机（DSH App）连 Host（EXAMPLE-WORKSTATION）需要重连好几次才成功。

## 已确认的事实

### 1. 服务端一切正常

| 检查项 | 结果 |
| --- | --- |
| 登录 | 200 |
| 设备列表 | 正常返回 |
| 设备详情（含 identityKey） | 正常 |
| TURN 凭据签发 | 正常，直连 Cloudflare API 也验证过 |
| WebSocket 升级 | 101 |

### 2. 所有设备的版本都是 modern

```
client  EXAMPLE-WORKSTATION        clientVersion=0.6.3    harnessVersion=-
host    EXAMPLE-WORKSTATION        clientVersion=0.6.3    harnessVersion=0.2.1-rc.5
client  DSH App (Android) clientVersion=1.0.11 harnessVersion=-
```

`modernHost` 判断的是 `clientVersion`，三者都远高于阈值 0.2.15。

**所以版本判定不是原因。** 我一度误判成 `0.2.1-rc.5` 被当成 legacy，那是错的 ——
那个字段（`harnessVersion`）根本不参与判断。

### 3. 真正的卡点

生产日志（`link stage` 日志）：

```
23:56:45  link stage = 'accepted'   transports: [lan, p2p, turn, relay]
23:56:45  GET /turn/credentials  Ok
23:56:47  GET /turn/credentials  Ok     ← 请求了两次，ICE 在重试
23:56:50  Unknown Event  Ok
之后：只剩 25 秒一次的心跳，再没有任何 stage 变化
```

**link 停在 `accepted`，从未进入 `handshake`，也从未 `ready`。**

按协议：

| stage | 含义 | 触发 |
| --- | --- | --- |
| `pending` | 等 Host 接受 | `connect.request` |
| `accepted` | Host 已接受 | `connect.accepted` |
| `handshake` | Noise 握手 step 1 完成 | client 发 `secure.handshake` step 1 |
| `ready` | 握手完成，可传数据 | host 发 `secure.handshake` step 2 |

**卡在 `accepted` 意味着：客户端从未发出 `secure.handshake` step 1。**

## 明天要做的

### 第一步：抓帧类型

代码已加日志（**已部署，版本 `6e0eb0cb`**）：

```ts
console.warn('frame in', { type: frame.type, deviceId: attachment.deviceId })
```

复现一次，看日志里有没有：

| 帧 | 如果缺失说明 |
| --- | --- |
| `signal.offer` / `signal.answer` / `signal.ice` | WebRTC 信令没走服务端 |
| `transport.selected` | 客户端没选传输 |
| `secure.handshake` | **Noise 握手没开始** ← 最可能 |

### 第二步：判断是「客户端在等 ICE」还是「握手帧丢了」

两种可能：

**A. 客户端在等 ICE 完成才握手**

日志里 `turn/credentials` 请求两次说明 ICE 在重试。如果 ICE 一直不通，
客户端就不会发 `secure.handshake`。

→ 需要查为什么 ICE 不通（P2P 打洞失败 + TURN 中继也失败？）

**B. 握手帧被服务端丢弃**

我的 `secure.handshake` 处理要求：

```ts
if (step === 1 && attachment.deviceId === link.client && link.stage === 'accepted')
```

日志显示 stage 就是 `accepted`，所以如果帧到了，条件满足，应该能通过。
**所以更可能是 A。**

### 第三步：验证 ICE 路径

可以在服务端日志里加 `signal.ice` 的候选统计，看双方是否交换了 relay 候选。

或者更直接：**用 `test/turn-relay.mjs` 强制走 TURN 测一次**，确认 TURN 中继
在当前网络下真的能通。

## 相关代码位置

| 文件 | 内容 |
| --- | --- |
| `src/gateway.ts` `handleConnectAnswer` | `connect.accepted` → stage = accepted |
| `src/gateway.ts` `secure.handshake` 分支 | step 1/2 的阶段推进 |
| `src/gateway.ts` `forwardSignal` | WebRTC 信令转发（含丢弃日志） |
| `src/gateway.ts` `forwardTransportSelected` | 传输选择（含 lan→p2p 降级） |

## 今晚做的其它改动（已部署）

| 改动 | 说明 |
| --- | --- |
| `modernHost` 支持 prerelease | 语义正确，但不是本次问题的原因 |
| `DSH_SERVER_ALLOW_CONCURRENT_HOSTS=1` | 允许一个 Host 多客户端；已开启 |
| 重连竞态不再回 4003 | 存活 <60s 的旧 socket 用 4001，让客户端重试 |
| `DSH_SERVER_PASSWORD_LOGIN=disabled` | 可切 OIDC-only |
| 详细的 hello 拒绝日志 | 能区分未注册 / 角色不符 / token 过期 |

## 当前部署

| 域名 | 状态 |
| --- | --- |
| `service1.example.com` | 密码登录 + TURN，最新代码 |
| `service3.example.com` | 配置就绪，等 Logto App ID / Secret |

## 关于我今晚的两个判断失误

1. **把版本判定当成原因** —— 没先查实际数据（`clientVersion` vs `harnessVersion`）
   就下结论，浪费了时间。你的质疑是对的。

2. **改 4003 时没考虑重连竞态** —— 上游用 4003 没问题，因为它的客户端通常
   干净关闭后重连；手机断网不是干净关闭。这个已修。

**教训：先看日志和实际数据，再下结论。**
