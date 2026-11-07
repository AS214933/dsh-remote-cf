# 运维、十人内使用与 Git 自动部署

核对日期：2026-11-07。以下是官方公开定价与模型估算，不是账单承诺。
实际以所在 Cloudflare 账户计划、仪表盘用量和最新官方条款为准。

## 先解决隔离，而不是先数人数

当前服务是 **单账号、一个设备池、一个 Gateway DO**。把十个邮箱放进允许列表
不会给它们创建独立租户。不要将其直接作为互不信任用户的共享服务。

需要各自账号／设备隔离时，有两种路线：

- **短期：每人独立部署**。Worker、DO 命名空间、账号、会话 Secret 和认证配置各自独立。
  同一个 Cloudflare 账户下的免费配额仍是合计，部署十份不等于十份免费额度。
  用户在各自合法账户自部署时按各自计划管理，不应为规避条款拆号。
- **长期：实现真正多租户**。按经过验证的稳定 `issuer + sub` 选择每租户 DO，设备凭据
  绑定租户，并对注册、查找、WS、连接、刷新、撤销、OAuth poll、TURN 限额做全路径隔离。
  需要迁移和跨租户负面测试；本次文档整理 **没有实现** 此功能。

## 相关免费额度

| 计量项 | 当前公开免费额度 | 注意 |
| --- | --- | --- |
| Worker HTTP 请求 | 100,000／日／账户 | 不与 DO 请求合并；免费超额可能失败 |
| Worker HTTP CPU | 10 ms／请求 | 网络等待不计 CPU；不是旧 Bundled 的50ms |
| SQLite DO 请求 | 100,000／日 | RPC、连接建立、alarm等均计；入站WS消息按20:1计费请求比例 |
| DO duration | 13,000 GB-s／日 | 按每对象分配128MB计；合资格休眠空闲不计，活跃/不可休眠计 |
| SQLite DO 读／写 | 500万行读、10万行写／日 | 索引、删除等可能增加计量；每次setAlarm算1行写 |
| SQLite DO 总存储 | 5GB | 免费仅SQLite后端，另有单对象上限 |
| Realtime SFU＋TURN | 合计首1,000GB／月 | 不是每用户或每Key一份；超出$0.05/GB出站 |
| Workers Builds | 3,000构建分钟／月 | 免费1个并发，单次20分钟；与运行时配额分开 |

DO定价文档说明：免费日限额00:00UTC重置，超出某类后该类操作失败。
免费计划不应被理解为无限运行或自动无缝付费扩容。Realtime则应检查其账单／支付设置，
不要假定到1TB会自动停止。Worker付费计划有最低月费，DO与TURN又有各自用量维度。

来源：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、
[Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)、
[Builds pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)。

## 怎么估算十人以内

下面将“十个隔离用户”建模为十个独立部署／对象，**不是现有单实例已支持十租户**。

### 待机、LAN/P2P 为主

P2P成功后应用数据不经过Worker Relay，但控制WS和心跳仍存在。
默认25秒心跳，一个全天有在线peer的对象约需 `86,400/25=3,456` 次alarm；
十个对象约34,560次alarm＋至少34,560次setAlarm行写／日。
若各两台设备每25秒回复一次心跳，则约69,120条入站WS消息／日，按20:1折算约3,456
计费请求单位；连同alarm约38,016，尚未加入HTTP、RPC、重连、OAuth poll和正常信令。

这说明 **轻量、间歇使用有机会落在免费额度内**，而不是十个人必然免费。
当前pong更新WS attachment，不额外写设备SQLite行；未来若为每个pong写一行，
`69,120 + 34,560 = 103,680` 写／日便可能超过免费写配额。

### 持续 Relay

粗估 DO请求单位：`alarm + RPC/连接请求 + 入站WS条数/20`。
十人每天各用2小时、每人双向合计10条入站消息／秒，则Relay约72万条／日，折算36,000
请求单位，加上述全天待机约74,000，尚有其他请求与CPU／duration开销。
若每人50条／秒，仅Relay约180,000请求单位／日就已超额。
20:1是compute请求计费比例，不是放宽平台消息数、CPU或分析指标限制。

duration另算：`对象活跃秒数 × 0.128 GB`。十个对象若全天不能休眠约110,592GB-s／日，
是13,000的8.5倍；同时持续活跃约2小时49分钟就耗尽这一天的duration份额。
合资格休眠的空闲时间（包括运行时真正驱逐前）不应被算进duration，但不能假定所有
有WebSocket的对象都自动免费；未结束事件、fetch和普通计时器等会影响休眠。

### TURN

TURN费用取决于Cloudflare到客户端的计费出站，不取决于签发API次数。
十人各100GB计费出站／月已经用完合计1,000GB；协议开销、其他Realtime应用用量也要计。
图片／文件／大量输出远比短文本容易产生流量。Worker加密Relay和Realtime TURN是两条
不同路径，不可拿TURN的1TB替代Worker/DO请求和duration配额。

### 上线建议

先用隔离部署或完成租户改造；做7天低量试用，监测Worker请求/CPU、DO请求/duration、
SQL行读写、TURN出站，设50%/80%用量告警并为每用户设置应用限额。
评估预算而不是只靠平台免费硬限额保护服务可用性。Logto托管、域名、AI模型等另计。

## 连接 GitHub：可以，而且不需要仓库公开

推荐 **Workers Builds**，不是让运行中的Worker定时git pull，也不需要把Git凭据写进代码。
它可连接GitHub私有／公共仓库，推送指定分支后构建和部署。

1. 在现有目标Worker的 **Settings → Build → Connect repository** 连接仓库。
   GitHub安装授权由账户所有者完成，限制到所需仓库。
2. 生产分支选实际使用分支（本仓库为 `master`），项目根目录选仓库根。
   使用支持的Node版本；建议Node24 LTS。关闭不受信任分支／PR的自动预览构建。
3. 将部署身份只保存在Build设置，不提交真实域名、账号或ID。
4. 将真正机密保存在目标Worker **Variables & Secrets** 的Secret栏。
   **Build变量与运行时Secret不是同一层**；不要向构建提供无关的运行时秘密。
5. 设置下列命令，完成一次手动构建并核对新版本、域名绑定和OIDC-only状态。

Build command：

```bash
npm ci && npm run typecheck && npm test && node scripts/build-config.mjs
```

Deploy command：

```bash
npm run deploy -- --config wrangler.build.local.jsonc
```

[build-config脚本](../scripts/build-config.mjs)会生成被忽略的部署配置，不打印私有值。
所需Build设置（可按隐私需要作为Build Secret存储）：

| 设置 | 用途 |
| --- | --- |
| `DSH_BUILD_WORKER_NAME` | 必须与已连接目标Worker名一致 |
| `DSH_SERVER_ACCOUNT` | 单账号准入身份 |
| `DSH_SERVER_PUBLIC_URL` | 实际HTTPS origin；生成自定义域名路由 |
| `CLOUDFLARE_ACCOUNT_ID` | 可选，明确部署所属账户 |
| `DSH_SERVER_PASSWORD_LOGIN` | 仅OIDC时设置`disabled` |
| `LOGTO_ENDPOINT` / `LOGTO_CLIENT_ID` | 使用OIDC时设置；tenant根地址无`/oidc` |
| `DSH_SERVER_ALLOW_CONCURRENT_HOSTS` | 可选并发Host策略 |

运行时Secrets仍需预设：`SESSION_SECRET`、`DSH_SERVER_PASSWORD`（当前启动校验要求，即使关闭
密码入口），以及按需`LOGTO_CLIENT_SECRET`、`TURN_KEY_ID`、`TURN_KEY_API_TOKEN`。
脚本不会复制或覆盖这些值。Build部署API Token权限按目标账户／Worker／域名最小化，
不要将全局API Key交给构建。

保留现有`GATEWAY`→`Gateway`绑定、SQLite后端、已有`v1/new_sqlite_classes`迁移和资源名。
**连接Git不需要新建DO、不需要迁移数据库**。当前官方也提供新的declarative exports模型，
但不能与legacy migrations混用；不要为接Git顺手改造生命周期配置。
使用`wrangler deploy`应用需要的生命周期变化，不拿`versions upload`当迁移工具。

注意：Wrangler通常会回显普通vars／域名绑定，即使构建参数在控制台标为Secret；
Build日志必须保持私有且限制访问，不要直接贴到公共issue。query脱敏不覆盖构建日志。
配置不会进入Git，但这不等于不会进入Cloudflare受控日志。

当前仓库已提供生成器和离线测试；**尚未替任何账户安装GitHub App或接通自动部署**。

官方指南：[GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)、
[Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、
[DO lifecycle declarations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
