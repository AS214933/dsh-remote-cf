# 运维、十人内使用与 Git 自动部署

核对日期：2026-11-07。以下是官方公开定价与模型估算，不是账单承诺。
实际以所在 Cloudflare 账户计划、仪表盘用量和最新官方条款为准。

## 当前是逻辑多租户，不是每用户独立资源

当前服务按已验证的稳定 `issuer + sub` 建立独立租户，设备、凭据、在线状态和连接操作
受认证租户范围约束，但 **所有租户仍共用一个 Gateway DO／SQLite／事件循环**。
这不是每用户一个DO、物理数据库或独立配额。默认租户记录容量十个，禁用用户也计数，
原所有者绑定前保留一个位置；详见[多租户与迁移](MULTITENANCY.md)。

默认准入仍是已验证邮箱允许列表。显式`DSH_SERVER_OIDC_ADMISSION=application`信任Logto
应用访问策略，**服务端不检查角色声明**；必须先正确配置应用准入。生产共享建议仅OIDC，
密码回退仅归旧所有者分区，不提供多用户密码注册。迁移要显式固定所有者issuer/subject，
必要时用身份登记专用门槛，不可按邮箱或首次登录自动认领旧设备。

如需更强的执行／存储资源隔离，可选择**每用户独立部署**或未来每租户DO设计。
这是替代拓扑，不是当前实现。相同Cloudflare账户下免费配额仍合计，部署十份不等于十份
免费额度；不得为规避服务条款拆号。

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

先按当前**十个逻辑租户、一个共享Gateway**估算；再单列每用户独立DO的替代方案。
租户容量上限不是免费承诺，当前每租户活动边界与全局peer/link上限见[架构](ARCHITECTURE.md#limits-and-security-boundaries)。

### 当前单 Gateway：待机、LAN/P2P 为主

P2P成功后应用数据不经过Worker Relay，但控制WS和心跳仍存在。
默认25秒心跳、全天有在线peer时，**整个共享Gateway的一条alarm循环**粗略约需
`86,400/25=3,456` 次alarm＋至少3,456次setAlarm行写／日，不是每租户各3,456次。
若十位用户各两台设备每25秒回复一次，则20个socket合计约69,120条入站WS消息／日，
按20:1折算约3,456计费请求单位；加alarm约6,912单位，尚未计HTTP、RPC、重连、
OAuth poll、普通信令及更早deadline唤醒。实际调度、连接变化与平台计量可能增加用量。

**轻量、间歇、P2P为主有机会在免费额度内**，但不是十个人必然免费。
当前pong更新WS attachment，不额外写设备SQLite行；若未来每pong额外写一行，则本例
约`69,120 + 3,456 = 72,576`行写／日，还没计其他注册、刷新、撤销和SQL索引等写入。

### 替代方案：每用户独立 Worker／DO

若真的部署十个全天在线对象，同样25秒alarm模型约34,560次alarm＋至少34,560次
setAlarm写／日；20个socket仍约69,120条入站消息，连同alarm约38,016请求单位。
若再每pong写一行，`69,120 + 34,560 = 103,680`行写／日便超过免费写额度。
这是**替代的物理分离部署估算，不是当前单Gateway实现的基线**。

### 持续 Relay

粗估 DO请求单位：`alarm + RPC/连接请求 + 入站WS条数/20`。
十人每天各用2小时、每人双向合计10条入站消息／秒，则Relay约72万条／日，折算36,000
请求单位；加当前单Gateway上述全天待机基线约42,912，尚有其他请求与CPU／duration开销。
若每人50条／秒，仅Relay约180,000请求单位／日就已超额。20:1是compute请求计费比例，
不是放宽平台消息数、CPU或分析指标限制。

duration另算：`对象活跃秒数 × 0.128 GB`。**当前一个Gateway**即使全天无法休眠，
128MB模型约11,059.2GB-s／日，占13,000份额约85%；这仍没有为同账户其他应用留足保证，
也不能消除单对象CPU、吞吐、SQL和共享可用性风险。合资格休眠空闲不应算进duration，
但不能假定有WebSocket就自动免费；未结束事件、fetch和普通计时器等会影响休眠。

若采用**十个独立DO的替代部署**且都全天无法休眠，则约110,592GB-s／日，
是免费duration的8.5倍；同时持续活跃约2小时49分钟就耗尽当日份额。
这个十对象数字不能套到当前一个共享Gateway上。

### TURN

TURN费用取决于Cloudflare到客户端的计费出站，不取决于签发API次数。
十人各100GB计费出站／月已经用完合计1,000GB；协议开销、其他Realtime应用用量也要计。
图片／文件／大量输出远比短文本容易产生流量。Worker加密Relay和Realtime TURN是两条
不同路径，不可拿TURN的1TB替代Worker/DO请求和duration配额。

### 上线建议

先完成[所有者迁移与双用户跨租户拒绝验收](MULTITENANCY.md#deployment-and-rollback-gate)，
再做7天低量试用，监测Worker请求/CPU、DO请求/duration、SQL行读写和TURN出站。
设50%/80%用量告警；现有租户/peer/link上限是防意外耗尽边界，不是每用户预留容量或账单系统。
评估预算而不是只靠平台免费硬限额保护可用性。Logto托管、域名、AI模型等另计。

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
| `DSH_SERVER_ACCOUNT` | 保留所有者密码账号／默认OIDC邮箱允许列表，不是租户定位键 |
| `DSH_SERVER_PUBLIC_URL` | 实际HTTPS origin；生成自定义域名路由 |
| `CLOUDFLARE_ACCOUNT_ID` | 可选，明确部署所属账户 |
| `DSH_SERVER_PASSWORD_LOGIN` | 仅OIDC时设置`disabled` |
| `LOGTO_ENDPOINT` / `LOGTO_CLIENT_ID` | 使用OIDC时设置；tenant根地址无`/oidc` |
| `DSH_SERVER_ALLOW_CONCURRENT_HOSTS` | 可选并发Host策略 |
| `DSH_SERVER_OIDC_ADMISSION` / `OAUTH_ALLOWED_ACCOUNTS` | 默认允许列表或显式`application`；后者依赖Logto应用访问策略，不检查角色 |
| `DSH_SERVER_MAX_TENANTS` | 租户记录容量，默认10，非每用户资源保证 |
| `DSH_SERVER_LEGACY_OWNER_ISSUER` / `DSH_SERVER_LEGACY_OWNER_SUBJECT` | 私有所有者精确身份固定；不要提交或公开 |
| `DSH_SERVER_IDENTITY_ENROLLMENT_ONLY` | 仅监督身份登记阶段设`1`，完成后移除 |

构建器是显式允许字段列表，不会把任意Build设置自动变为运行时vars。首次多租户部署前，
核对当前[生成脚本](../scripts/build-config.mjs)确实传递所需准入／所有者／登记字段；
若遗漏，先更新并测试生成器或使用正确的私有配置，不能靠文档表格假定已经生效。

运行时Secrets仍需预设：`SESSION_SECRET`、`DSH_SERVER_PASSWORD`（当前启动校验要求，即使关闭
密码入口），以及按需`LOGTO_CLIENT_SECRET`、`TURN_KEY_ID`、`TURN_KEY_API_TOKEN`。
身份登记期间另需临时runtime Secret `DSH_SERVER_IDENTITY_PROBE_KEY`，及**独立、仅操作者持有**的
`DSH_SERVER_IDENTITY_EVIDENCE_KEY`。证据不能用URL能力密钥签名；缺失／相同密钥应拒绝。
登记确认后删除临时密钥和门槛，不把任何密钥作为公开Build参数或公开URL。
脚本不会复制／覆盖运行时Secret。
Build部署API Token权限按目标账户／Worker／域名最小化，不要将全局API Key交给构建。

保留现有`GATEWAY`→`Gateway`绑定、SQLite后端、已有`v1/new_sqlite_classes`迁移和资源名。
**仅连接Git本身不需要新建DO或数据库迁移**；本次多租户应用升级另有同库事务迁移和
所有者登记门槛，必须按[MULTITENANCY](MULTITENANCY.md)操作。不要为接Git另建空命名空间，
也不要以普通旧版Wrangler回滚代替租户感知的恢复计划。当前官方也有新的declarative exports
模型，但不能与legacy migrations混用；不要为接Git顺手改造生命周期配置。
使用`wrangler deploy`应用需要的生命周期变化，不拿`versions upload`当迁移工具。

注意：Wrangler通常会回显普通vars／域名绑定，即使构建参数在控制台标为Secret；
Build日志必须保持私有且限制访问，不要直接贴到公共issue。query脱敏不覆盖构建日志。
配置不会进入Git，但这不等于不会进入Cloudflare受控日志。

当前仓库已提供生成器和离线测试；**尚未替任何账户安装GitHub App或接通自动部署**。

官方指南：[GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)、
[Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、
[DO lifecycle declarations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
