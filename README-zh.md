# dsh-remote-cf

[English](README.md) · **简体中文**

DSH Remote 服务端的 Cloudflare Workers 实现：REST 认证与设备 API、支持休眠的 Durable Object WebSocket 网关、加密 Relay 转发，以及可选的 Cloudflare Realtime TURN 凭据签发。

> **现已支持 OIDC 多租户逻辑隔离。** 经验证的 `issuer + sub` 身份拥有独立设备／凭据命名空间，租户记录容量默认十个。当前仍共用**一个 Gateway Durable Object**，不是每用户独立进程、物理数据库或免费配额。邀请用户前必须配置准入、原所有者迁移和共享资源边界，详见[多租户](docs/MULTITENANCY.md)。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [部署](docs/DEPLOYMENT.md) | 私有配置、明确的 Wrangler 目标、Secret 与发布步骤 |
| [多租户](docs/MULTITENANCY.md) | 稳定身份、准入策略、所有者登记／迁移与回滚门槛 |
| [认证](docs/AUTHENTICATION.md) | Logto OIDC、仅 OIDC、旧所有者密码回退与撤销边界 |
| [架构](docs/ARCHITECTURE.md) | 逻辑租户边界、共享 Gateway、传输、存储与限制 |
| [测试](docs/TESTING.md) | 隔离单元／workerd 检查，以及旧版在线诊断脚本的边界 |
| [建连耗时](docs/CONNECTION-LATENCY.md) | 服务端 RPC 合并与有界 TURN 凭据复用 |
| [运维](docs/OPERATIONS.md) | 平台额度、单 Gateway／每用户部署估算和 Git 自动部署 |
| [公开发布](docs/PUBLICATION.md) | 仓库公开前准备与发布卫生 |

使用受支持的现代 Node.js 版本（至少 22.13，详见测试文档）：

```bash
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
npm run test:tenant-runtime
npm run test:enrollment-runtime
```

部署请按照[部署文档](docs/DEPLOYMENT.md)，使用已忽略的本地配置和显式 `--config`。不要把裸 `npm run deploy` 当作生产部署步骤。仓库不提供公共服务地址或登录凭据。

## 能力与边界

- 按租户隔离设备注册、access／refresh 凭据、在线状态、信令与加密 Relay。
- OIDC 使用稳定 issuer／subject 定位租户；已验证邮箱仅作准入／显示元数据，不作为设备归属键。应用准入模式信任已配置的 Logto 应用访问策略，**不做服务端角色声明校验**。
- 协调 LAN/P2P、TURN 辅助的 WebRTC 和加密服务端 Relay；签发凭据不代表 TURN 数据通路已验证。
- 根路径及无关路由默认 **418**；内置静态文件是占位页，不是 Remote 网页工作台。
- 不保证零费用、每租户预留容量、完全上游兼容或独立安全认证。请阅读[共享资源限制](docs/ARCHITECTURE.md#limits-and-security-boundaries)及[迁移／回滚门槛](docs/MULTITENANCY.md#deployment-and-rollback-gate)。

## 来源与许可

原始项目是 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，另参考 [AS214933 fork](https://github.com/AS214933/ds-harness-remote) 的协议实现。本仓库是独立的 Workers 实现，不是上游官方服务。

本仓库声明 MIT，见 [LICENSE](LICENSE)。这不替代复制、改编或打包材料所适用的上游与依赖许可声明，详见[来源与分发注意事项](docs/ARCHITECTURE.md#source-origin-and-licensing)。
