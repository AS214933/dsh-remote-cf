# 浏览器跳转式 OAuth（GitHub 那种）可行性 —— 修正版

> 只做调研，不写代码。
> 本报告推翻了我上一版的两个错误结论，依据是**对官方服务端 `service2.example.com` 的实测**。

## 先纠正我上一版的错误

| 我上一版说的 | 实际 |
| --- | --- |
| ❌「桌面端不支持浏览器跳转」 | **错。桌面端支持** —— 二维码旁边有「在浏览器打开」链接 |
| ❌「`scanUrl` 和 `startUrl` 是两条不同的路」 | **错。它们是同一个流程的两个入口** |

**正确理解：`scanUrl` 指向的页面本身就是一个 303 跳转页。** 手机扫它、桌面点它，走的是同一条路。

---

## 一、官方实测（决定性证据）

### 1. providers 同时返回两个 URL

```
GET https://service2.example.com/api/v1/auth/oauth/providers
```

```json
{"items":[
  {"id":"zhihu","displayName":"知乎",
   "startUrl":"/api/v1/auth/oauth/start",
   "qrStartUrl":"/api/v1/auth/oauth/qr/start?provider=zhihu"},
  {"id":"github","displayName":"GitHub",
   "startUrl":"/api/v1/auth/oauth/github/start",
   "qrStartUrl":"/api/v1/auth/oauth/qr/start?provider=github"},
  {"id":"google","displayName":"Google",
   "startUrl":"/api/v1/auth/oauth/google/start",
   "qrStartUrl":"/api/v1/auth/oauth/qr/start?provider=google"}
]}
```

**官方三个 provider 全部同时支持两条路。**

### 2. `startUrl` 直接 303 到 IdP

```
GET /api/v1/auth/oauth/github/start?return_to=dshremote://oauth
→ 303 See Other
→ Location: https://github.com/login/oauth/authorize
              ?client_id=Ov23liJ9BDdmuXo5RZMx
              &redirect_uri=https%3A%2F%2Fservice2.example.com%2Fapi%2Fv1%2Fauth%2Foauth%2Fgithub%2Fcallback
              &state=<JWT>
→ Set-Cookie: dsh_web_github_oauth_state=<JWT>; HttpOnly; Max-Age=600; SameSite=lax; Secure
```

### 3. `scanUrl` 也是 303 到同一个地方

```
POST /api/v1/auth/oauth/qr/start?provider=github
→ {"qrId":"dqIYCziOjXzijVx4nKM6NMWd",
   "scanUrl":"https://service2.example.com/api/v1/auth/q/dqIYCziOjXzijVx4nKM6NMWd",
   "expiresIn":600,"provider":"github"}

GET https://service2.example.com/api/v1/auth/q/dqIYCziOjXzijVx4nKM6NMWd
→ 303 See Other
→ Location: https://github.com/login/oauth/authorize?...
              &state=<JWT 里 qr_id 有值>
```

**所以 `scanUrl` 不是一张图，是一个跳转页。** 二维码里编码的就是这个 URL。

### 4. state 的结构

```json
{
  "typ": "github-oauth-state",
  "return_to": "/app",
  "nonce": "TDTvcD2xHpUt9rre7AEOqY-X",
  "qr_id": "dqIYCziOjXzijVx4nKM6NMWd",
  "iat": 1793976838,
  "exp": 1793977438
}
```

关键：**`qr_id` 为 `null` 时走 `startUrl` 流程，有值时走扫码流程。同一套 state 机制。**

---

## 二、桌面端怎么用它

`packages/plugin/src/client/settings.ts:634`：

```ts
React.createElement('a', {
  className: 'dshRemoteQrOpen',
  href: qrSession.scanUrl,
  target: '_blank',              // ← 新标签页打开
  rel: 'noopener noreferrer',
  'aria-label': t('openInBrowser'),
}, React.createElement('img', { src: qrImage, width: 184, height: 184, ... }))
```

**桌面端的 UI 是：二维码 + 旁边一个「在浏览器打开」链接。**

- 点链接 → 浏览器打开 `scanUrl` → 303 到 GitHub → 授权 → 回调 → 完成
- 手机扫码 → 同样打开 `scanUrl` → 同一条路

**这就是「GitHub 那样」的体验，桌面端已经支持，不需要改客户端。**

---

## 三、所以服务端要实现什么

### 必需端点

| 端点 | 类型 | 作用 |
| --- | --- | --- |
| `GET /api/v1/auth/oauth/providers` | JSON | 返回 provider 列表（含两个 URL） |
| `POST /api/v1/auth/oauth/qr/start?provider=X` | JSON | 建会话，返回 `qrId`/`scanUrl`/`expiresIn` |
| `GET /api/v1/auth/q/{qrId}` | **303** | 二维码落地页 → 跳 IdP |
| `GET /api/v1/auth/oauth/{provider}/start` | **303** | 浏览器直跳入口（可选但建议） |
| `GET /api/v1/auth/oauth/{provider}/callback` | **303** | IdP 回调 → 回 `return_to?token=` |
| `GET /api/v1/auth/oauth/qr/{qrId}` | JSON | 轮询状态 |

**注意 `/api/v1/auth/q/{qrId}` 不在 `/api/v1/` 之外的路径**，所以现有 418 规则要放行整个 `/api/v1/auth/*`。

### state 设计（照抄官方结构）

```json
{ "typ": "<provider>-oauth-state",
  "return_to": "dshremote://oauth" | "/app",
  "nonce": "<32字节随机>",
  "qr_id": "<qrId>" | null,
  "iat": 1234567890,
  "exp": 1234568490 }
```

- 用 **HMAC-SHA256 签名**（官方是 JWT，HS256）
- 同时写 `Set-Cookie: dsh_web_<provider>_oauth_state`，双重校验
- `exp` 600 秒

### 存储

```sql
CREATE TABLE oauth_sessions (
  qr_id      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL,   -- pending | complete | expired
  account    TEXT,
  is_admin   INTEGER,
  token      TEXT,            -- 只返回一次
  return_to  TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

---

## 四、GitHub OAuth 接入

```
1. GitHub 建 OAuth App
   - Homepage URL:              https://service1.example.com
   - Authorization callback URL: https://service1.example.com/api/v1/auth/oauth/github/callback

2. 流程
   GET /start
     → 生成 state（签名）
     → Set-Cookie
     → 303 https://github.com/login/oauth/authorize?client_id=..&state=..&scope=read:user user:email

   GET /callback?code=..&state=..
     → 验 state 签名 + 校验 cookie 一致
     → POST https://github.com/login/oauth/access_token  (code → token)
     → GET  https://api.github.com/user                  (login)
     → GET  https://api.github.com/user/emails           (primary email)
     → 建会话 token
     → 若 state.qr_id 有值：写 qr 状态为 complete，回 303 到一个「已完成」页
       若 state.qr_id 为 null：303 回 return_to?token=<token>
```

**GitHub 没有 id_token，不需要 JWKS 验签**，但必须用服务端换到的 access_token 查用户，不能信任 URL。

---

## 五、安全要点

| 风险 | 对策 |
| --- | --- |
| **CSRF** | state 签名 + cookie 双重校验 + 一次性 |
| **开放重定向（最危险）** | `return_to` **白名单**：只允许 `dshremote://oauth`、`/app` 这类固定值 |
| **code 重放** | 回调成功即标记 used |
| **qrId 被猜** | 32 字节 CSPRNG（官方是 24 字符 base64） |
| **token 泄露** | 轮询只返回一次，取走即清空 |
| **state 过期** | 600 秒，过期即拒 |
| **会话堆积** | alarm 里 sweep |

**`return_to` 是最危险的一处。** 官方把它放进签名过的 state 里，所以不可篡改——这是正确做法，必须照做，绝不能从 query 直接读。

---

## 六、工作量

| 项 | 人天 |
| --- | --- |
| `oauth_sessions` 表 + state 签名/校验 | 1.5 |
| 三个跳转端点（`/q/{id}`、`/start`、`/callback`） | 2 |
| providers + qr/start + qr 轮询 | 1.5 |
| GitHub OAuth 接入 | 1.5 |
| 安全加固 | 1.5 |
| 桌面端 + Android 联调 | 2 |
| **合计** | **≈10 人天** |

---

## 七、结论

**完全可行，而且桌面端和 Android 都支持，不需要改任何客户端。**

- 桌面端：二维码旁「在浏览器打开」链接 → GitHub 授权 → 回来
- Android：直接调 `startUrl` 或扫码
- 手机扫码：扫 `scanUrl` → 同一条路

**关键理解**：`scanUrl` 不是图片，是跳转页。搞清这点后，两条路其实是同一条。

**建议第一步**（半天）：先只实现 `providers` 返回一个假 provider + `/q/{id}` 返回 303 到任意地址，看桌面端 UI 是否正确显示二维码和「在浏览器打开」链接。验证协议理解后再接 GitHub。
