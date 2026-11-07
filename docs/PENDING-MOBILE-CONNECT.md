# 手机连接故障：实现对照与修复记录

## 2026-11-07：已复现的服务端缺陷

前一晚关于“服务端完全正常”“卡在 accepted 就能证明客户端没发握手”“两次 TURN 请求就是 ICE 重试”的结论不成立。仅凭当时日志不能推导这些结论。

本次对照原版单进程 Server、真实 AdaptiveTransport 和 Workers 运行模型，确认并修复：

1. **休眠唤醒时 peers 为空**：旧实现只在 alarm 中重建 peers；如果第一条事件是消息或 RPC，会误报 AUTH_INVALID 或离线。改为构造时恢复。
2. **休眠丢失 links**：旧实现没有保存连接 ID、阶段、双方 Relay 计数或 ICE 预算。改为在每个 Client 的 WebSocket attachment 中保存其唯一 link，并在任何事件前恢复。用双方 socket session ID 防止把旧 link 恢复到新实例。
3. **旧 socket 迟到 error 会踢掉替代连接**：对 error 和 send-failure 清理增加 current-socket ownership 校验。
4. **新连接把已有心跳 alarm 不断往后推**：改为串行调度最早 deadline；各 peer 保留 nextPingAt，hello 和未完成 link 也有 deadline。
5. **hello timeout 实际未执行**：保存绝对 deadline，alarm 清理静默 socket，异步 token hash 后重新检查当前 attachment 状态和 deadline。
6. **60 秒规则偏离原版且会引发互踢**：撤销按连接年龄猜测同一实例的逻辑；恢复原版只把旧连接以 4003/CONNECTION_REPLACED 关闭，保持新连接不受影响。

结束 link 或 socket 前同步清除可恢复快照，避免 close/error 唤醒时丢失清理通知或复活已删除 link。

## 部署状态

- 现有生产域名已部署修复版，Worker version：`ed8f199d-8261-4c09-ae93-6dc63cf7f607`。
- 实际手机恢复待用户确认；部署成功和本地测试通过不能替代这一项。
- 部署前既有 link 没有快照，无法凭空恢复，可能需客户端或 Host 手动重连一次。未改变账号、设备身份或生产数据库。

## 验证边界

- 新增生命周期测试调用真实 Gateway handler，仅替换 SQLite 和外部 runtime 基类；socket attachment 使用深拷贝，重建 Gateway 模拟唤醒。
- 修复前新增测试出现可重复失败；修复后通过。同一真实 workerd 测试加载旧提交 `5eb8da7` 时在首次唤醒后的 connect.request 失败（收不到 connect.incoming），加载修复版通过。
- `node test/gateway-runtime.mjs` 在真实 workerd/Miniflare 中创建测试账号设备、握手与控制 WebSocket Relay，并调用显式 hibernate eviction：pending、accepted、handshake 以及 ready 后五次唤醒均保留连接；重放计数仍被拒绝；close 事件触发唤醒时也会通知另一端并清理 link。
- 这是服务端线协议/休眠测试，不等于真实 Android APK 验收、真实 Noise 密钥协商或跨网 TURN 验收。手机恢复结果仍需真实客户端确认。
- 测试 runtime 和数据完全本地隔离，不读取用户 profile/凭据，不创建生产测试设备。

## 已排除的错误解释

- `modernHost` 使用 Remote 插件 `clientVersion`，不是 Harness 或 Desktop 的产品版本。不能拿 Harness 的 `0.2.1-rc.5` 推导 Host 是 legacy。
- `relayEndpoint` / `relayTicket` 是可选的；原版和真实客户端明确支持缺省时在控制 WebSocket 上转发 opaque Relay。不能添加虚构的 assignment 来“修复”。
- Desktop 的 direct/turn/relay 多次自动尝试，不代表 Android 的路径相同；direct 打洞也不一定失败。不能据此归咎手机客户端。
- Cloudflare tail 的 `Ok` 是事件执行结果，不保证某个 HTTP 响应码，更不能证明 TURN 中继在双方网络间已可用。
- `Unknown Event` 不显示帧内容；缺少阶段日志不证明帧没到，也可能是在休眠后丢了服务端状态。

## 仍待处理的独立问题

本次以恢复连接为范围，不把下列问题宣称已修：

- 100 ms 出站字节估算不是真实 backpressure，可能误杀大突发或漏报积压。
- 协议 decoder 的完整 payload/UTF-8 大小校验与原版有差距。
- 未实现的 attach/resume capability 不应被宣告；目前 capabilities 需要进一步收紧。
- SQLite schema 初始化的 module-global 标记不适用于同 isolate 中的多个不同数据库。
- Android 对某些可重试错误的 app 级分类可能不同于 AdaptiveTransport，不能在未构建真机验证前宣称已修。
- Logto/OIDC 安全收尾和新域名部署为单独任务，本次不处理。
