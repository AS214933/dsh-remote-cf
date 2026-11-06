# 外接自有 OAuth 的可行性研究

> 只做调研，不写代码。
> 对照 `packages/plugin`、`apps/android`、`apps/server` 三处源码（v0.6.3）。

## 结论

**可行，而且不需要改任何客户端。**

OAuth 在这套协议里是**完全由服务端驱动**的：客户端只认「发现 → 建会话 → 轮询」三个动作，具体接谁、怎么跳转，全在服务端返回的字段里。所以第三方服务端可以接任意 OAuth 提供方（Logto、Keycloak、Auth0、GitHub、企业 SSO），客户端无感。

**但有一个硬约束**：二维码里那个 URL **必须和服务端同源**。这决定了架构上「谁来做 OAuth 的回调页」。

---

## 一、协议长什么样

客户端只调 3 个端点，全部是公开的（不需要预先认证）：

```
GET  /api/v1/auth/oauth/providers          → 有哪些提供方
POST <qrStartUrl>                          → 建一个登录会话，拿到二维码内容
GET  /api/v1/auth/oauth/qr/{qrId}          → 轮询，直到 complete 拿到 token
```

### 1. 发现

```json
{ "items": [
  { "id": "logto",
    "displayName": "Logto",
    "startUrl": "/api/v1/auth/oauth/start",
    "qrStartUrl": "/api/v1/auth/oauth/qr/start?provider=logto" }
] }
```

**校验规则**（`server-api.ts:198-202`）：

| 字段 | 约束 |
| --- | --- |
| `id` | `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`，不可重复 |
| `displayName` | 非空、≤128 字符、不含终端控制字符 |
| `startUrl` | 必须匹配 `^/api/v1/auth/[^\s\\#]*$` |
| `qrStartUrl` | 同上，可选 |

> **注意 `startUrl` 其实没人用。** 我搜遍了插件、Android、Web UI：
> 它只参与校验，从未被请求或打开。真正被消费的只有 `qrStartUrl` 和 `scanUrl`。
> 所以接自有 OAuth 时，`startUrl` 填个合规占位值即可。

### 2. 建会话

```
POST {qrStartUrl}   body: {}
```

```json
{ "qrId": "至少 20 字符",
  "scanUrl": "https://你的服务端/api/v1/auth/q/<id>",
  "expiresIn": 600,
  "provider": "logto" }
```

**校验规则**（`server-api.ts:218-225`）：

| 字段 | 约束 |
| --- | --- |
| `qrId` | 长度 ≥ 20 |
| **`scanUrl`** | **必须 `startsWith(`${serverUrl}/`)`** |
| `expiresIn` | 安全整数（秒） |
| `provider` | 非 zhihu 时必须与请求的 provider 一致 |

### 3. 轮询

```
GET /api/v1/auth/oauth/qr/{qrId}
```

```json
{ "status": "pending" }            // 或 "expired"
{ "status": "complete", "token": "..." }   // token 长度 ≥ 16
```

拿到 `token` 后，客户端用它调 `GET /api/v1/auth/me`，要求返回：

```json
{ "account": "非空字符串", "isAdmin": true }
```

**然后客户端用这个 token 调 `POST /api/v1/devices/register` 完成设备注册。**
也就是说——**这个 `token` 就是我们的会话 token，不需要额外发明东西。**

---

## 二、那个硬约束

```js
function normalizeOAuthScanUrl(value, baseUrl) {
  const normalized = new URL(value).href
  return normalized.startsWith(`${baseUrl}/`) ? normalized : undefined
}
```

`scanUrl` 必须同源。这带来两个直接后果：

| 后果 | 说明 |
| --- | --- |
| **回调页必须由我们的 Worker 提供** | 不能直接把 `scanUrl` 指向 Logto 的授权地址 |
| **但可以先跳转** | `scanUrl` 是我们自己的页面，那个页面再 302 到 Logto |

所以架构是：

```
二维码内容 = https://service1.example.com/api/v1/auth/q/<qrId>   ← 我们的页面
                │
                └─ 302 → Logto 授权页 → 回调到我们的 /api/v1/auth/callback
                                              │
                                              └─ 写 qrId 状态为 complete + token
```

**这个 302 完全合法**，因为 `scanUrl` 本身同源，只是它是个跳转页。

---

## 三、关键难点：扫码的到底是谁

这是整套方案里**唯一真正需要设计**的地方。

现有流程假设：**手机扫码，手机上已登录 OAuth 账号**。

但我们的场景是：**桌面端 DSH 想登录，用户用手机扫**。

两条路：

### 路线 A：手机浏览器完成 OAuth（推荐）

```
桌面端显示二维码（内容是我们的 URL）
  ↓ 手机扫
手机浏览器打开我们的页面 → 302 到 Logto
  ↓ 手机已登录 Logto（或现场登录）
Logto 回调我们的 Worker → 拿到用户身份
  ↓ Worker 把这个身份绑定到 qrId
桌面端轮询到 complete
```

**优点**：符合现有 UX，用户不用手动输密码
**要求**：手机浏览器能访问我们的服务端（可以），且 Logto 回调地址可达（可以）

### 路线 B：桌面端浏览器完成 OAuth

二维码换成「点这里在浏览器打开」，但那就不是扫码了，UX 变了。

**路线 A 是正解。**

---

## 四、需要实现什么

在现有 Worker 上加 4 个端点（都是新增，不影响已有功能）：

| 端点 | 作用 |
| --- | --- |
| `GET /api/v1/auth/oauth/providers` | 返回配置的提供方列表 |
| `POST /api/v1/auth/oauth/qr/start` | 生成 `qrId`，返回 `scanUrl` |
| `GET /api/v1/auth/oauth/qr/{qrId}` | 轮询状态 |
| `GET /api/v1/auth/q/{qrId}` | **二维码落地页**，302 到 Logto |
| `GET /api/v1/auth/oauth/callback` | Logto 回调，校验后写 complete |

会话状态（`qrId` → 状态）需要持久化。可以放 DO SQLite，加一张表：

```sql
CREATE TABLE oauth_sessions (
  qr_id      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL,   -- pending | complete | expired
  account    TEXT,
  is_admin   INTEGER,
  token      TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

---

## 五、安全性要点

这几条不做就等于没做：

| 风险 | 对策 |
| --- | --- |
| **qrId 被猜中** | 用 32 字节 CSPRNG，不是自增 |
| **OAuth state 伪造（CSRF）** | `state` 参数必须绑定 `qrId` 并校验 |
| **回调被重放** | 回调成功即标记 `complete`，二次回调拒绝 |
| **token 泄露在轮询里** | 轮询只返回一次，取走后立即清空 |
| **过期会话堆积** | `expiresIn` 到期清理，alarm 里 sweep |
| **谁都能建会话** | 限流（现有 `rate()` 可复用） |
| **id_token 未验证** | 必须验签 + 校验 `iss`/`aud`/`exp`，不能只 base64 解 |

**最后一条最容易做错**：Logto 返回的 `id_token` 是 JWT，但**不能只解码不验签**。要用 JWKS 验签。

---

## 六、和现有密码登录的关系

**可以并存**，不冲突：

- `POST /api/v1/auth/login`（账号密码）—— 保留
- OAuth 端点 —— 新增

客户端发现 `oauthProviders()` 返回非空时，UI 会显示扫码选项；返回空数组时显示「暂无可用的扫码登录方式」，也就是你现在看到的那句话。

**所以这个改动是纯增量**：不配置 OAuth 时行为和现在完全一样。

---

## 七、工作量估计

| 项 | 人天 |
| --- | --- |
| DO 表 + 会话状态机 | 1 |
| 4 个端点 + 落地页 | 2 |
| Logto OIDC 集成（授权码流 + JWKS 验签） | 3 |
| 安全性加固（state、重放、限流、清理） | 2 |
| 与真实客户端联调 | 2 |
| **合计** | **≈10 人天** |

---

## 八、风险与限制

| 项 | 说明 |
| --- | --- |
| **Logto 回调地址必须公网可达** | 本地调试要内网穿透 |
| **手机必须能访问服务端** | 当前部署满足 |
| **`startUrl` 是死字段** | 别指望用它做浏览器跳转，客户端不消费 |
| **`scanUrl` 同源硬约束** | 必须自己提供落地页，不能直指 IdP |
| **仅支持扫码流程** | 客户端没有「点击按钮跳转」的 OAuth 入口 |
| **上游可能变化** | 这是未文档化的行为，依赖源码实现 |

---

## 九、建议

**技术上完全可行，客户端零改动。** 但我不建议现在就做，理由：

1. **你现在只有一台设备、一个账号** —— 扫码登录的收益是「免输密码」，单用户场景价值有限
2. **密码登录已经能用了** —— 优先把稳定性做扎实
3. **这是 10 人天的增量** —— 不是修 bug，是新功能

**如果要做，建议顺序**：

```
1. 先跑一周，确认密码登录稳定
2. 再加 OAuth，作为「可选增强」，默认关闭
3. 用 Logto 验证（你本来就有）
```

**最关键的验证点**：先用一个假的 `providers` 响应 + 假二维码，确认客户端 UI 能正确显示并走完轮询流程。这半天就能验证协议理解对不对，比直接接 Logto 快得多。
