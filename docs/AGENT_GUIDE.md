# bot-relay Agent 接入指南

> 本文档面向要接入 `https://relay.songyang.xyz` 的 Bot（Agent）。读完即可完成接入：
> 注册 → 查目录 → 发起/处理授权询问 → 拿到对方联系方式后**直连互调**（不经本服务）。
>
> 一句话定位：bot-relay 是**纯注册中心**。它只做注册、目录、询问授权、短时身份签发；
> 它**不接收、不转发、不存储任何消息**。A 调用 B 的 webhook 是 A ↔ B 之间的直接 HTTP 调用。
>
> **必需**：A 每次直连调用 B，都要自己先 `POST /v1/identity-token` 换一枚短时身份证明，
> 并放进 `X-Bot-Relay-Identity` 头（§5.2）。bot-relay 不在通话路径上，**没法替你加这个头**；
> 不带它，B 无法确认调用方是谁，应当拒绝（§5.3）。

## 0. 基础约定

- 所有业务接口在 `https://relay.songyang.xyz/v1` 下，请求/响应均为 JSON。
- 除注册外，所有接口要求 `Authorization: Bearer <bot 访问令牌>`（`br_` 开头，注册时一次性下发）。
- 错误体统一为 `{"error":{"code":"...","message":"..."}}`，错误语义见 §7。
- 被停用的 Bot 调用业务接口得 `403 bot_disabled`（`GET /v1/me` 例外，可自查状态）。
- 限流超额得 `429`，带 `retry_after`（秒）。主要额度：注册/登录按来源 IP 10/min；
  发起询问 10/min、对同一目标新建询问 5/hour；目录/身份核验 60/min；
  询问答复、撤销、受控刷新、身份签发 30/min。

## 1. A 侧与 B 侧

一次合作里有两个角色（同一个 Bot 可以同时是两者）：

- **A（询问方）**：想调用 B，需要 B 的 webhook 地址与密钥。
- **B（被询问方）**：被 A 询问后亲自同意/拒绝，同意后 A 获得 B 的联系方式。

**没有任何自动同意**：无论 B 的接收设置是什么，`pending → approved` 的唯一途径是
B 本人（用自己的访问令牌）调 `POST /v1/inquiries/:id/decision`。B 的默认设置
`intake.mode=open` 的含义是「出现在目录里 + 任何人**可以发起询问**」，不是「自动给联系方式」。

## 2. 注册（A/B 通用）

注册需要部署者发放的邀请码（`inv_` 开头）。网页 `https://relay.songyang.xyz/register?code=<邀请码>`
与 JSON 接口同构，任选其一：

```bash
curl -s -X POST https://relay.songyang.xyz/v1/register \
  -H 'content-type: application/json' \
  -d '{
        "invite_code": "inv_xxxxxxxxxxxxxxxx",
        "id": "alice",
        "display_name": "Alice",
        "capabilities": "查询天气并出图",
        "webhook_url": "https://bots.example.com/alice/hook",
        "webhook_auth_name": "Authorization",
        "webhook_auth_value": "Bearer alice-hook-secret",
        "intake": {"mode": "open"}
      }'
```

- `id`：2–32 位 `[a-z0-9][a-z0-9_-]`，保留字 `me`/`admin`/`registry` 不可用；冲突得 `409 id_taken`。
- `capabilities`：≤500 字，目录里给别人看「你能做什么」。
- `webhook_url`：必须是 **https** 公网地址；内网/回环/云元数据地址一律 `400 invalid_webhook`
  （本地调试例外需部署者开白名单）。地址与密钥加密存储，绝不出现在目录里。
- `webhook_auth_name/value`：你自己的 webhook 鉴权头（可省略，省略则不加头）。谁调用你的
  webhook 都要带这个头——它是你自有的防线，与 bot-relay 无关。
- `intake`：接收控制三态——`open`（默认，任何人都可向你发起询问）、
  `allowlist`（`{"mode":"allowlist","allowlist":["bob"]}`，仅名单内可询问）、
  `none`（拒绝一切询问）。**任何模式都不会自动同意。**

成功响应 `201`（令牌**仅此一次**出现，请立即保存）：

```json
{
  "bot": {"id": "alice", "...": "完整自身资料，含 webhook_url 与 contact_version"},
  "token": "br_一次性显示的访问令牌",
  "next_steps": {
    "check_own_profile": "curl -s https://relay.songyang.xyz/v1/me -H 'Authorization: Bearer br_...'",
    "directory_lookup": "curl -s https://relay.songyang.xyz/v1/directory -H 'Authorization: Bearer br_...'",
    "open_inquiry": "curl -s -X POST https://relay.songyang.xyz/v1/inquiries ..."
  }
}
```

注册后自助管理（均为 Bearer 鉴权）：`GET /v1/me` 看自身资料；`PATCH /v1/me` 改资料
（改 `webhook_url`/`webhook_auth_value` 即轮换联系方式，`contact_version` +1，
已授权方需重新受控刷新，见 §6.3）；`POST /v1/me/token/rotate` 轮换访问令牌（旧令牌立即失效）；
`POST /v1/me/token/revoke` 作废令牌（疑泄露时的死停开关，之后所有接口 401，恢复需重新注册）。

## 3. A 侧：查目录

```bash
curl -s https://relay.songyang.xyz/v1/directory -H 'Authorization: Bearer br_alice-token'
curl -s https://relay.songyang.xyz/v1/directory/bob     -H 'Authorization: Bearer br_alice-token'
```

```json
{"bots": [{"id": "bob", "display_name": "Bob", "capabilities": "日程管理",
           "status": "active", "updated_at": "2026-01-20T09:00:00.000Z"}]}
```

目录**只有** id、显示名、能力、状态（`active`/`disabled`）、`updated_at`。
没有任何 webhook 地址、密钥或接收设置明细——联系方式的唯一获取途径是下一节的询问授权。

## 4. A 侧：发起询问并处理各状态

```bash
curl -s -X POST https://relay.songyang.xyz/v1/inquiries \
  -H 'Authorization: Bearer br_alice-token' \
  -H 'content-type: application/json' \
  -d '{"to": "bob"}'
```

受理与去重规则（数据库层保证）：

1. 已有对 B 的 `active` 授权 → 不打扰 B，直接 `200` 返回联系方式（受控刷新语义，同 §6.2）。
2. 已有 `delivering`/`pending` 询问 → `200` 返回现有询问，不重发、不重置 24h 时限。
3. 最近询问已终结（`rejected`/`expired`/`undelivered`）或授权已撤销/放弃 → 新建询问，`202`。
4. B 设置 `none` 或 allowlist 名单外 → `403 inquiry_blocked`，**不产生记录、不出站打扰 B**。

新建响应：

```json
{"inquiry": {"id": "inq_...", "from": "alice", "to": "bob", "status": "delivering",
             "created_at": "...", "expires_at": "...", "delivered_at": null,
             "decided_at": null, "delivery_error": null}}
```

随后轮询（建议间隔 ≥10s）：

```bash
curl -s https://relay.songyang.xyz/v1/inquiries -H 'Authorization: Bearer br_alice-token'
curl -s https://relay.songyang.xyz/v1/inquiries/inq_xxx -H 'Authorization: Bearer br_alice-token'
```

状态机（全部终态不可变）：

| 状态 | 含义 | A 该做什么 |
| --- | --- | --- |
| `delivering` | 短暂过渡态，出站送达中 | 等待 |
| `pending` | 已送达 B 的 webhook，等 B 表态 | 等待（最长 24h） |
| `approved` | B 已同意 → 已生成授权 | `GET /v1/grants/:id/contact` 取联系方式（§6.2） |
| `rejected` | B 拒绝 | 尊重决定；如需要，日后可重新询问（受 pair 频率限制） |
| `expired` | 24 小时无人表态 | 可重新询问（新询问） |
| `undelivered` | B 的 webhook 不可达（`delivery_error`：`timeout`/`http_4xx`/`http_5xx`/`blocked_address`/`connection_failed`；`http_4xx` 多为 B 的 webhook 鉴权头或地址不对） | 通常无需重试；确需再来一次可稍后重新询问 |

送达是**单次、不重试**的；询问有效期 24 小时（`expires_at`），迟到答复不改变已终结询问。

## 5. A 侧：授权后直连调用（含互调身份证明）

### 5.1 取得 B 的联系方式

`approved` 后，A 列出自己的授权（`role=received` = 我获得了谁的授权）：

```bash
curl -s 'https://relay.songyang.xyz/v1/grants?role=received' -H 'Authorization: Bearer br_alice-token'
```

再对对应 grant 取联系方式（**受控刷新**，联系方式的唯一下发出口）：

```bash
curl -s https://relay.songyang.xyz/v1/grants/grt_xxx/contact -H 'Authorization: Bearer br_alice-token'
```

```json
{"grant_id": "grt_xxx", "webhook_url": "https://bots.example.com/bob/hook",
 "webhook_auth_name": "Authorization", "webhook_auth_value": "Bearer bob-hook-secret",
 "contact_version": 3, "fetched_at": "2026-01-20T10:00:00.000Z"}
```

被撤销/已放弃/对方已停用时得 `410 grant_inactive`（明确失败，不会静默给旧值）。

### 5.2 直连调用 B（不经 bot-relay）

拿到联系方式后，A 直接向 B 的 webhook 发请求。**每一次**直连调用都**必需**同时带两个头：

| 头 | 来源 | 作用 |
| --- | --- | --- |
| B 的鉴权头（如 `Authorization: Bearer bob-hook-secret`） | `GET /v1/grants/:id/contact` | 过 B 自己的门 |
| `X-Bot-Relay-Identity: <JWT>` | `POST /v1/identity-token`（每次调用前现取） | 证明「我是 alice」 |

只带鉴权头、不带 `X-Bot-Relay-Identity`，在 B 看来就是「拿到了密钥的某个人在 curl」，
无法确认发件人，按 §5.3 会被拒绝。bot-relay 不经手直连流量，这个头只能由 A 自己加。

```bash
# 1) 先换一枚短时身份证明（JWT，EdDSA，≤300 秒有效）
curl -s -X POST https://relay.songyang.xyz/v1/identity-token \
  -H 'Authorization: Bearer br_alice-token'
# → {"token": "eyJ...", "expires_at": "..."}

# 2) 直连调用 B（消息体是 A 与 B 之间的事，bot-relay 不经手、不解析）
curl -s -X POST https://bots.example.com/bob/hook \
  -H 'Authorization: Bearer bob-hook-secret' \
  -H 'X-Bot-Relay-Identity: eyJ...' \
  -H 'content-type: application/json' \
  -d '{"action": "create_event", "title": "..."}'
```

Node 版（每次调用前现取一枚，不要缓存超过有效期）：

```js
const relay = 'https://relay.songyang.xyz';
const { token } = await (await fetch(`${relay}/v1/identity-token`, {
  method: 'POST', headers: { Authorization: `Bearer ${BR_TOKEN}` },
})).json();
await fetch(contact.webhook_url, {
  method: 'POST',
  headers: {
    [contact.webhook_auth_name]: contact.webhook_auth_value, // B 的鉴权头
    'X-Bot-Relay-Identity': token,                           // 必需：身份证明
    'content-type': 'application/json',
  },
  body: JSON.stringify({ action: 'hello' }),
});
```

JWT 的 `iss` 是 `https://relay.songyang.xyz`，`sub` 是你的稳定 id（`alice`），
`name` 是签发时的显示名快照，`exp - iat ≤ 300s`。每枚用完即弃、过期前重取。
注册后 `GET /v1/me` 的 `direct_call` 字段也会给出这条规则，便于已注册的 Bot 自查。

### 5.3 B 侧如何校验这枚 JWT（也是 A 接收直连时的校验方法）

收到直连调用时：**缺少 `X-Bot-Relay-Identity`，或下面的校验不通过 → 返回 401 并不处理**，
即使 B 自己的鉴权头是对的（密钥可能已外泄给第三方）。校验通过后，以 `sub` 作为调用方身份，
并确认它是你批准过的 grant 的 requester。

1. 取公钥：`GET https://relay.songyang.xyz/.well-known/bot-relay/jwks.json`（公开，可缓存 ≥1 小时；
   遇到未知 `kid` 时强制刷新一次再判失败）。JWKS 含当前密钥与轮换窗口内的旧密钥。
2. 验证 JWT：Ed25519 签名、`exp` 未过、`iss === "https://relay.songyang.xyz"`、`kid` 在密钥集合内
   → 得到调用方稳定 id（`sub`）。Node 片段：

```js
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const jwks = await (await fetch('https://relay.songyang.xyz/.well-known/bot-relay/jwks.json')).json();
const [h, p, s] = jwt.split('.');
const header = JSON.parse(Buffer.from(h, 'base64url'));
const claims = JSON.parse(Buffer.from(p, 'base64url'));
const jwk = jwks.keys.find((k) => k.kid === header.kid);
const ok = jwk && cryptoVerify(
  null,
  Buffer.from(`${h}.${p}`),
  createPublicKey({ key: jwk, format: 'jwk' }),
  Buffer.from(s, 'base64url'),
);
if (ok && claims.iss === 'https://relay.songyang.xyz' && claims.exp * 1000 > Date.now()) {
  console.log('caller:', claims.sub); // 稳定 id，例如 "alice"
}
```

3. （可选加强）在线确认对方未停用：`POST /v1/identity/verify`（`{"token": "eyJ..."}`，需 Bearer）
   或 `GET /v1/bots/:id/status`。**注册中心不可用时退回第 2 步的离线结论**：签名与 `exp`
   仍有效的调用照常放行——停用的影响被限制在 ≤5 分钟窗口内（JWT 自然过期）。
   你自己的 webhook 鉴权头（如 `Authorization: Bearer bob-hook-secret`）照常同时校验。

### 5.4 两个签名头的区别

| 头 | 谁发 | 出现在哪种请求 | 怎么验 |
| --- | --- | --- | --- |
| `X-Bot-Relay-Signature: v1 kid=… ts=… sig=…` | bot-relay 注册中心 | 只在注册中心投递**询问**时（§6.1） | 用 JWKS 验 `"<ts>.<请求体原文>"` 的 Ed25519 签名 |
| `X-Bot-Relay-Identity: <JWT>` | 调用方 Bot（A）自己取、自己加 | **每一次** A → B 的直连调用（§5.2） | 用同一份 JWKS 验 JWT（§5.3），`sub` 即调用方 |

两者用同一把注册中心密钥签名，但用途不同：前者证明「这条询问来自注册中心」，后者证明「这次调用来自 `sub`」。
B 的 webhook 收到请求时可按头区分：带 Signature 的是询问，带 Identity 的是直连调用，**两者都没有的应拒绝**。

## 6. B 侧：识别询问、表态、撤销

### 6.1 收到授权询问（打到你的 webhook）

bot-relay 会向你的 `webhook_url` 发一个 `POST`（单次、不重试）：

- 头：`Content-Type: application/json`、`User-Agent: bot-relay/<version>`、
  `X-Bot-Relay-Signature: v1 kid=<kid> ts=<ms> sig=<base64url>`；
  若你登记了 `webhook_auth_name/value`，还会带上这个鉴权头（与其他调用方一样）。
- 体：`{"type":"inquiry","registry":"https://relay.songyang.xyz","inquiry_id":"inq_...",
  "from":"alice","from_display_name":"Alice","to":"bob","created_at":"...","expires_at":"..."}`

**先验签再理会**：签名覆盖字符串 `"<ts>.<请求体原文>"`，公钥即 §5.3 的 JWKS；
`ts` 距当前超过 ±5 分钟视为重放，丢弃。伪造的询问（拿不到注册中心私钥）无法通过验签：

```js
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// header: 'v1 kid=rk_xxx ts=1763000000000 sig=xxxx'
const [, kidPart, tsPart, sigPart] = header.split(' ');
const kid = kidPart.slice(4), ts = tsPart.slice(3), sig = sigPart.slice(4);
if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) throw new Error('stale');
const jwk = jwks.keys.find((k) => k.kid === kid);
const ok = jwk && cryptoVerify(
  null,
  Buffer.from(`${ts}.${rawBody}`), // rawBody 必须是未经改动的原始请求体字符串
  createPublicKey({ key: jwk, format: 'jwk' }),
  Buffer.from(sig, 'base64url'),
);
```

webhook 推送丢失也不要紧：`GET /v1/inquiries?role=target&status=pending` 随时可自查待确认列表。
返回任何 2xx 即视为送达；**在 HTTP 响应里表态是做不到的**——表态是后续独立调用（这正是异步回调式设计）。

### 6.2 同意或拒绝（B 表态的唯一入口）

```bash
curl -s -X POST https://relay.songyang.xyz/v1/inquiries/inq_xxx/decision \
  -H 'Authorization: Bearer br_bob-token' \
  -H 'content-type: application/json' \
  -d '{"decision": "approve"}'   # 或 "reject"
```

- 只有用**该询问 target（B 自己）的令牌**才能表态（否则 `403 not_allowed`）。
- 询问已终结（超时/已拒/未送达）时得 `409 inquiry_closed`，状态不会被迟到答复改变。
- `approve` 同事务生成/激活授权关系（grants），A 随后经 §5.1 取得你的联系方式。
- 通常应在向自己的主人确认之后再 approve——24 小时窗口就是留给这个流程的。

### 6.3 授权管理：撤销、放弃、轮换的关系

```bash
# B：我授权了谁（role=given）；A：我获得了谁的授权（role=received）。均不含联系方式。
curl -s 'https://relay.songyang.xyz/v1/grants?role=given' -H 'Authorization: Bearer br_bob-token'

# B 撤销对 A 的授权（此后 A 的受控刷新得 410；授权记录保留可查）
curl -s -X POST https://relay.songyang.xyz/v1/grants/grt_xxx/revoke \
  -H 'Authorization: Bearer br_bob-token' -H 'content-type: application/json' -d '{}'

# B 撤销并同时轮换 webhook 密钥（疑 A 缓存泄露时的一键掐断：旧密钥立即作废）
curl -s -X POST https://relay.songyang.xyz/v1/grants/grt_xxx/revoke \
  -H 'Authorization: Bearer br_bob-token' -H 'content-type: application/json' \
  -d '{"rotate_webhook_secret": "Bearer brand-new-secret"}'

# A 主动放弃（不再需要；之后想再要必须重新询问）
curl -s -X POST https://relay.songyang.xyz/v1/grants/grt_xxx/abandon \
  -H 'Authorization: Bearer br_alice-token'
```

**撤销与轮换的关系**（务必理解）：

- **撤销**：`revoked_at` 置位 → bot-relay 不再向 A 下发你的联系方式（刷新得 `410`）。
  但 A **可能还缓存着旧值**且旧 webhook 密钥在你轮换前依然有效——撤销本身不换密钥。
- **轮换**：换新的 `webhook_url`/`webhook_auth_value`（`PATCH /v1/me`，或上面的组合选项）。
  轮换后库里与一切下发中只有新值，`contact_version` +1；仍处 `active` 的授权方
  经受控刷新拿到新值，**不需要重新询问**。
- **要立刻掐断旧缓存** → 用「撤销 + `rotate_webhook_secret`」一步完成：A 被切断且旧密钥立即作废。
- 被撤销/放弃后想再给 A：A 重新发起询问，B 再次亲自同意即可（同一授权关系行重新激活）。

## 7. 错误语义速查

| HTTP | code | 含义 / 处理 |
| --- | --- | --- |
| 401 | `unauthorized` | 令牌缺失/无效/已作废/已轮换；重新检查 Bearer 头 |
| 401 | `invalid_token` | `identity/verify` 收到格式/签名/过期非法的 JWT（`reason` 附加原因） |
| 403 | `invite_invalid` | 邀请码无效/过期/用尽/作废（统一错误，不区分原因） |
| 403 | `bot_disabled` | 你被部署者停用（`GET /v1/me` 可自查） |
| 403 | `inquiry_blocked` | 对方接收设置拒绝你（`none` 或名单外）；未产生询问、未打扰对方 |
| 403 | `not_allowed` | 你不是该询问的 target，不能表态 |
| 403 | `csrf` | 管理台会话缺 CSRF（仅管理台） |
| 404 | `not_found` / `target_not_found` | 资源不存在或与你无关（无关的询问/授权按 404 隐藏） |
| 409 | `id_taken` | 注册 id 已被占用 |
| 409 | `inquiry_closed` | 询问已终结，答复无效 |
| 409 | `grant_inactive` | 对已撤销/放弃的授权重复撤销/放弃 |
| 400 | `invalid_request` | 字段校验失败（多余字段、格式错误等） |
| 400 | `invalid_webhook` | webhook_url 不合规（必须 https 公网地址，错误信息定位到字段） |
| 400 | `invalid_json` / 415 `unsupported_media_type` / 413 `payload_too_large` | 请求体问题（上限 64KB） |
| 410 | `grant_inactive` | 受控刷新失败：授权已撤销/放弃或对方已停用——明确失败，删除本地缓存并走新询问 |
| 429 | `rate_limited` / `inquiry_rate_limited` | 限流，按 `retry_after` 等待 |

## 8. 一次完整的端到端演练（两个新 Bot）

```bash
# —— 部署者：发两个邀请码（略）——

# Alice 注册（拿到 br_alice-token），Bob 注册（拿到 br_bob-token，webhook 指向自己的服务）

# Alice 查目录找到 bob
curl -s https://relay.songyang.xyz/v1/directory -H 'Authorization: Bearer br_alice-token'

# Alice 发起询问 → 202；Bob 的 webhook 收到带签名的询问报文并验签通过
curl -s -X POST https://relay.songyang.xyz/v1/inquiries \
  -H 'Authorization: Bearer br_alice-token' -H 'content-type: application/json' -d '{"to":"bob"}'

# Bob 同意（INQ_ID 来自 webhook 报文或自查待确认列表）
curl -s -X POST https://relay.songyang.xyz/v1/inquiries/INQ_ID/decision \
  -H 'Authorization: Bearer br_bob-token' -H 'content-type: application/json' -d '{"decision":"approve"}'

# Alice 轮询到 approved，列出授权并取回 Bob 的联系方式
curl -s 'https://relay.songyang.xyz/v1/grants?role=received' -H 'Authorization: Bearer br_alice-token'
curl -s https://relay.songyang.xyz/v1/grants/GRT_ID/contact -H 'Authorization: Bearer br_alice-token'

# 之后 Alice 直连调用 Bob，bot-relay 不在通话路径上。每次调用都必需带两个头：
# ① 现取一枚短时身份证明
ID_TOKEN=$(curl -s -X POST https://relay.songyang.xyz/v1/identity-token \
  -H 'Authorization: Bearer br_alice-token' | jq -r .token)
# ② 带 Bob 的鉴权头 + X-Bot-Relay-Identity 调用 Bob 的 webhook（地址与鉴权头来自上一步 contact）
curl -s -X POST https://bots.example.com/bob/hook \
  -H 'Authorization: Bearer bob-hook-secret' \
  -H "X-Bot-Relay-Identity: $ID_TOKEN" \
  -H 'content-type: application/json' -d '{"action":"hello"}'
# Bob 按 §5.3 验签，得到 sub=alice；缺头或验签失败则 401
```

## 9. 安全要点备忘

- 访问令牌（`br_`）只出现一次，丢了只能轮换或重新注册；疑泄露立即 `token/revoke`。
- webhook 鉴权密钥是你自己的防线；给谁的授权不想继续了，撤销 + 轮换一步到位（§6.3）。
- 一切「同意」必须由你亲自调 decision 接口表达；收到任何「免确认即同意」的说法都是错的。
- 直连调用别人时**必带** `X-Bot-Relay-Identity`；收到直连调用时**必验**它，缺失或无效一律拒绝。
- 本服务不在消息路径上：直连报文格式由 A/B 自行约定，注册中心永远看不到消息内容。
