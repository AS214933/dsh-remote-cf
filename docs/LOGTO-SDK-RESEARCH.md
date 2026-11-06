# 用 Logto SDK 接入 OAuth —— 调研结论

> 只做调研，不写代码，不部署。
> 结论基于对 `@logto/js@6.1.2` 实际源码的检查。

## 结论

**能用，但 SDK 只解决一半问题，而且最危险的一半它不解决。**

| 能力 | SDK 提供 | 说明 |
| --- | --- | --- |
| OIDC 发现 | ✅ `fetchOidcConfig` | 拉 `.well-known/openid-configuration` |
| 生成授权 URL | ✅ `generateSignInUri` | 含 PKCE、state、scope |
| code 换 token | ✅ `fetchTokenByAuthorizationCode` | 标准 authorization code flow |
| **id_token 验签** | ❌ **只有 `decodeIdToken`（纯解码）** | **必须自己补** |
| userinfo | ✅ `fetchUserInfo` | |
| 撤销 | ✅ `revoke` | |

**关键**：`@logto/js` 是给**浏览器**用的 SDK。浏览器里 id_token 已经过 TLS，且通常用 access_token 调 userinfo，所以 SDK 不验签是合理设计。但**服务端必须验签**——我们的场景正是服务端。

---

## 一、Workers 兼容性

### 可以用 `@logto/js`

```
✅ 无任何 node: 导入
✅ 纯 JS，依赖只有 js-base64、@silverhand/essentials、camelcase-keys
✅ 可在 Workers 运行
```

### 不能用 `@logto/node`

```
❌ engines: node >=22
❌ 依赖 Node 运行时（fs、crypto 等）
❌ 在 Workers 里跑不起来
```

**所以选 `@logto/js`，不是 `@logto/node`。**

---

## 二、SDK 提供的流程

```ts
// 1. 发现
const config = await fetchOidcConfig(`${logtoEndpoint}/oidc`, requester)
// → { authorizationEndpoint, tokenEndpoint, userinfoEndpoint, jwksUri, issuer, ... }

// 2. 生成授权 URL（含 PKCE）
const signInUri = generateSignInUri({
  authorizationEndpoint: config.authorizationEndpoint,
  clientId,
  redirectUri,
  codeChallenge,        // PKCE，需要自己生成
  state,
  scopes: ['openid', 'profile', 'email'],
  resources: [apiResource],
})

// 3. 用 code 换 token
const response = await fetchTokenByAuthorizationCode({
  clientId, tokenEndpoint, redirectUri, codeVerifier, code, resource,
}, requester)
// → { accessToken, idToken, refreshToken, expiresIn, scope }

// 4. 解码 id_token（⚠️ 不验签）
const claims = decodeIdToken(response.idToken)
// → { sub, email, name, ... }
```

**SDK 要求一个 `Requester` 函数**，签名大概是 `(input, init) => Promise<Response>`。Workers 里直接传 `fetch` 即可。

---

## 三、必须自己补的部分

### 1. id_token 验签（最重要）

SDK 的 `decodeIdToken` 长这样：

```js
const decodeIdToken = (token) => {
  const { 1: encodedPayload } = token.split('.')   // ← 只取第二段
  const json = urlSafeBase64.decode(encodedPayload)
  const idTokenClaims = JSON.parse(json)
  assertIdTokenClaims(idTokenClaims)                // ← 只校验字段类型
  return idTokenClaims
}
```

**没有签名验证，没有 iss/aud/exp 校验。**

必须在 Worker 里自己做：

```ts
// 1. 取 JWKS
const jwks = await fetch(`${config.jwksUri}`).then(r => r.json())
// 2. 找 kid 匹配的 key
const key = jwks.keys.find(k => k.kid === header.kid)
// 3. Web Crypto 验签（RS256）
const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signingInput)
// 4. 校验 claims
if (claims.iss !== config.issuer) throw ...
if (claims.aud !== clientId) throw ...
if (claims.exp * 1000 <= Date.now()) throw ...
```

**Workers 支持 RS256 验签**（`RSASSA-PKCS1-v1_5` + `SHA-256`），这段可以写。

### 2. PKCE

SDK 的 `generateSignInUri` 要 `codeChallenge`，但不帮你生成：

```ts
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
```

**`codeVerifier` 要存起来**，回调时用。放 DO SQLite 或签名 cookie。

### 3. 与现有客户端协议的桥接

Logto 是标准 OIDC，但**客户端协议不是**。需要转换：

| 客户端要的 | Logto 给的 |
| --- | --- |
| `qrId` / `scanUrl` | — 自己生成 |
| `status: pending/complete` | — 自己维护 |
| `token`（会话） | Logto 的 `access_token` 或 `id_token` |

**关键**：客户端的 `token` 是**我们自己的会话 token**（`/auth/me` 认它），不是 Logto 的。所以流程是：

```
Logto 登录成功
  → 取 claims.email 作为 account
  → 用现有 signSession() 签一个我们自己的 token
  → 存进 oauth_sessions，等客户端轮询取走
```

**这部分和之前写的 `oauth.ts` 一样，SDK 不改变它。**

---

## 四、SDK 带来的净收益

| 项 | 手写 | 用 SDK |
| --- | --- | --- |
| OIDC 发现 | ~30 行 | ✅ 省掉 |
| 授权 URL 拼装 | ~20 行 | ✅ 省掉 |
| code 换 token | ~40 行 | ✅ 省掉 |
| PKCE | ~10 行 | ❌ 仍要写 |
| **id_token 验签** | ~60 行 | ❌ **仍要写** |
| 客户端协议桥接 | ~150 行 | ❌ 仍要写 |

**省约 90 行，但最关键的验签和协议桥接一行没省。**

---

## 五、我的建议

### 方案 A：用 `@logto/js`（推荐）

**理由**：
- OIDC 发现和 token 交换是标准流程，用 SDK 少踩坑
- 依赖干净，Workers 能跑
- 未来 Logto 改端点，SDK 跟着更新

**代价**：多一个依赖，且仍要自己写验签。

### 方案 B：不用 SDK

**理由**：
- 我们只调 2 个端点（token、userinfo），手写约 70 行
- 已经写了 `oauth.ts`，通用 OAuth 2.0 实现
- 少一个依赖，少一层版本耦合

**代价**：OIDC 发现要自己写（但就一个 GET）。

### 我的判断

**方案 B 更合适**，因为：

1. **已经写好了** —— `oauth.ts` 是通用 OAuth 2.0，Logto 也能用（它支持标准 authorization code）
2. **SDK 不解决验签** —— 而这正是最需要帮助的地方
3. **只调 2 个端点** —— 不值得为此引入依赖
4. **Logto 的 OIDC 发现只是多一次 GET** —— 不是复杂逻辑

**但如果你更看重「少写代码、跟着官方走」，方案 A 也合理。** 关键是**验签无论如何要自己写**。

---

## 六、Logto 特有的注意事项

之前调研 Logto 时的结论仍然适用：

| 项 | 说明 |
| --- | --- |
| **自建 Logto 有双 tenant** | 默认 `:3001`、管理 `:3002`，token 不互通。OIDC 走默认 tenant |
| **M2M 不能代表用户** | M2M 的 `sub` 是 App ID，不是用户。OIDC 授权码流不受影响 |
| **Management API 只有一个 scope** | `all`。但 OIDC 用的是 `openid profile email`，无关 |
| **userinfo 返回什么** | `sub`、`email`、`name` 等，取决于 scope |
| **account 用什么** | 建议用 `email`（和现有 `DSH_SERVER_ACCOUNT` 对齐） |

---

## 七、安全清单

无论用不用 SDK，这些必须做：

| 风险 | 对策 | SDK 是否覆盖 |
| --- | --- | --- |
| **id_token 伪造** | JWKS 验签 + iss/aud/exp | ❌ 自己写 |
| **CSRF** | state 签名 + cookie 双校验 | ⚠️ 部分（SDK 生成 state 但不校验） |
| **code 拦截** | PKCE | ⚠️ 部分（SDK 用但不生成） |
| **开放重定向** | `return_to` 白名单 | ❌ 自己写 |
| **code 重放** | 一次性 | ❌ 自己写 |
| **账号越权** | 允许列表校验 | ❌ 自己写 |

**注意**：SDK 的 `generateSignInUri` **接受你传入的 state**，它不生成也不校验。所以 state 逻辑仍要自己写（我已实现）。

---

## 八、当前代码状态

已完成且未部署（在 `dsh-remote-cf` 仓库）：

| 文件 | 内容 |
| --- | --- |
| `src/oauth.ts` | 通用 OAuth 2.0：provider 解析、state 签名/校验、code 交换、身份读取、return_to 白名单 |
| `src/oauth-routes.ts` | 6 个端点：发现、建会话、轮询、落地页、直跳、回调 |
| `src/store.ts` | `oauth_sessions` 表 + 一次性 token |
| `src/gateway.ts` | 4 个 OAuth RPC |
| `test/oauth.test.ts` | **22 个测试全通过** |
| `test/oauth-e2e.mjs` | 端到端测试（需 mock IdP） |
| `test/mock-idp.mjs` | mock OAuth 提供方 |

**全部 84 个测试通过，类型检查通过，但按你的要求没有部署。**

---

## 九、如果要改用 SDK

需要改的地方很小：

```ts
// 现在：手写
const accessToken = await exchangeCode(provider, code, redirectUri)

// 换成 SDK：
const config = await fetchOidcConfig(`${logtoEndpoint}/oidc`, fetch)
const response = await fetchTokenByAuthorizationCode({
  clientId, tokenEndpoint: config.tokenEndpoint, redirectUri, codeVerifier, code,
}, fetch)
const claims = decodeIdToken(response.idToken)   // ⚠️ 仍需自己验签
```

**其余逻辑（state、会话、轮询、客户端协议）完全不变。**

---

## 十、下一步需要你确认

1. **用 SDK 还是手写？** 我倾向手写（已有代码、SDK 不解决验签）
2. **部署到哪个域名？** 需要新的 `DSH_SERVER_PUBLIC_URL`
3. **Logto 是自建还是云？** 自建要给端点；云是 `<tenant>.logto.app`
4. **账号用 `email` 还是 `sub`？** 建议 `email`，和现有账号对齐

**在你确认前我不会部署任何东西。**
