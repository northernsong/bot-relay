# bot-relay

自托管的 **Bot（Agent）注册中心**：Bot 凭邀请码注册、在目录里互相发现、
通过「询问 → 亲自同意」交换 webhook 联系方式，然后**点对点直连互调**。
注册中心不在通话路径上——它不接收、不转发、不存储任何消息。

> 本仓库正处于重设计后的纯注册中心形态（阶段 A–D 已交付），**不兼容**旧 0.1.0
> 中继/A2A 实例：升级 = 新库新部署，所有 Bot 凭新邀请码重新注册。

## 文档

| 文档 | 给谁看 | 内容 |
| --- | --- | --- |
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | 人 | 架构与信任边界、安全要点、部署与观测（百行内） |
| [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md) | Bot / Agent | 注册、目录、询问授权、直连互调与互调鉴权、错误语义、可复制示例 |
| [`docs/redesign/PRD.md`](docs/redesign/PRD.md) | — | 需求定稿（决策 1–12） |
| [`docs/redesign/TECH-DESIGN.md`](docs/redesign/TECH-DESIGN.md) | — | 技术设计（数据模型、API、安全机制、阶段计划） |
| `docs/INTEGRATION.md`、`docs/ARCHITECTURE_AND_USAGE.md` | 归档 | **已过时**，描述旧 0.1.0 中继/A2A 形态，不再适用 |

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：ADMIN_TOKEN 与 ENCRYPTION_KEY 用 openssl rand -hex 32 生成，
# PUBLIC_BASE_URL 填你的对外域名（示例中为 https://relay.songyang.xyz）

docker compose up -d --build   # 宿主仅回环发布 127.0.0.1:8080:8080，公网入口走 Cloudflare Tunnel
# 或裸机：npm ci && npm run build && node --env-file=.env dist/index.js
```

公网入口按设计是 Cloudflare Tunnel：本机 cloudflared 把域名回源到 `127.0.0.1:8080`，
服务只监听回环，不对公网开任何端口（详见 `docs/OVERVIEW.md` 与 `docs/redesign/TECH-DESIGN.md` §12）。

## 核心概念（30 秒）

- **注册**：`POST /v1/register`（凭邀请码）→ 一次性下发 `br_` 访问令牌。
- **目录**：`GET /v1/directory` 只暴露 id / 显示名 / 能力 / 状态 / 更新时间，**永不含联系方式**。
- **询问授权**：A `POST /v1/inquiries` → bot-relay 把带 Ed25519 签名的询问送达 B 的 webhook →
  B 亲自 `POST /v1/inquiries/:id/decision` 同意/拒绝（24h 有效，无任何自动同意路径）。
- **联系方式下发**：同意后 A 经 `GET /v1/grants/:id/contact` 受控刷新获取；撤销后 410。
- **互调**：A 直连 B 的 webhook，**必须**每次先 `POST /v1/identity-token` 现取并带上 `X-Bot-Relay-Identity: <JWT>`（EdDSA，≤300s）——注册中心不在通话路径上，这个头只能由调用方自己加；
  B 用公开 JWKS 离线验签（`/.well-known/bot-relay/jwks.json`），注册中心宕机不阻断既有直连。
- **凭证只有三种**：部署者 `ADMIN_TOKEN`、Bot 访问令牌、邀请码。

## 运维界面

- `GET /health`：健康检查；`GET /metrics`：Prometheus 指标（需 `ADMIN_TOKEN`）。
- `/admin`：管理台（Bot 列表与停用/删除、邀请码、审计视图、凭据查看留痕）。
- `/register`：注册页（与 JSON API 同构，成功后附下一步可复制示例）。

## 开发

```bash
npm install
npm run typecheck
npm run test
npm run build
```

技术栈：TypeScript + Hono + `node:sqlite`，单进程 Node ≥22.13，无其他运行时依赖。
