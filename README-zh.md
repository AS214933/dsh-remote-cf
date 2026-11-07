# dsh-remote-cf

[English](README.md) · **简体中文**

DSH Remote 服务端的 Cloudflare Workers 实现：REST 认证与设备 API、支持休眠的 Durable Object WebSocket 网关、加密 Relay 转发，以及可选的 Cloudflare Realtime TURN 凭据签发。

> **这是单账号部署，不是多租户服务。** 密码登录或可选 Logto OIDC 都指向同一个共享设备命名空间。即使只有不超过十位用户，只要需要各自账号与设备隔离，**一个实例也不支持**。OIDC 邮箱允许列表不等于租户隔离。详见[单账号边界](docs/ARCHITECTURE.md#single-account-boundary)。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [部署](docs/DEPLOYMENT.md) | 私有配置副本、明确的 Wrangler 目标、Secret 与首次发布 |
| [认证](docs/AUTHENTICATION.md) | 密码、Logto OIDC、仅 OIDC 模式、已验证邮箱与撤销限制 |
| [架构](docs/ARCHITECTURE.md) | 单账号信任边界、传输、存储、默认 418 与已知限制 |
| [测试](docs/TESTING.md) | 隔离单元／workerd 检查，以及旧版在线诊断脚本的边界 |
| [建连耗时](docs/CONNECTION-LATENCY.md) | 服务端 RPC 合并与有界 TURN 凭据复用 |
| [运维](docs/OPERATIONS.md) | 平台费用、配额及 Git 部署运维 |
| [公开发布](docs/PUBLICATION.md) | 仓库公开前准备与发布卫生 |

本地使用受支持的现代 Node.js 版本（至少 22.13，详见测试文档）：

```bash
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
```

部署请按照[部署文档](docs/DEPLOYMENT.md)，使用已忽略的本地配置和显式 `--config`。不要把裸 `npm run deploy` 当作生产部署步骤。仓库不提供公共服务地址或登录凭据。

## 能力与边界

- 设备注册、access／refresh 凭据、在线状态与建连信令。
- 转发端到端加密会话流量，但仍处理认证材料和连接元数据；这不是独立安全认证。
- 协调 LAN/P2P、TURN 辅助的 WebRTC 和加密服务端 Relay。签发出 TURN 凭据不代表 TURN 数据通路已验证。
- 根路径及无关路由默认返回 **418**。内置静态文件是占位页，不是 Remote 网页工作台。
- 不保证零费用、无限容量、与上游完全一致或兼容所有客户端版本。请阅读[运维](docs/OPERATIONS.md)、[测试](docs/TESTING.md)和[架构限制](docs/ARCHITECTURE.md#limits-and-security-boundaries)。

## 来源与许可

原始项目是 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，另参考 [AS214933 fork](https://github.com/AS214933/ds-harness-remote) 的协议实现。本仓库是独立的 Workers 实现，不是上游官方服务。

本仓库声明 MIT，见 [LICENSE](LICENSE)。这不替代复制、改编或打包材料所适用的上游与依赖许可声明。来源与分发注意事项见[架构文档](docs/ARCHITECTURE.md#source-origin-and-licensing)。
