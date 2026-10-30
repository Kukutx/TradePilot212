# 故障排查

简体中文 · [English](../TROUBLESHOOTING.md)

<a id="pnpm-doctor-says-trading-212-demolive-is-missing"></a>
## `pnpm doctor` 提示缺少 Trading 212 Demo/Live

打开 `.env.local`，确认每个已配置的环境都同时填了两个值：

```env
T212_DEMO_API_KEY=...
T212_DEMO_API_SECRET=...

T212_LIVE_API_KEY=...
T212_LIVE_API_SECRET=...
```

只填了一半的一对会被拒绝。

<a id="trading-212-returns-401403"></a>
## Trading 212 返回 401/403

- 确认 Key 是在正确的 Demo 或 Live 环境下生成的。
- 确认 API Secret 复制无误。
- 检查 API Key 是否有所需的读取/下单权限。
- 如果 Secret 丢了，在 Trading 212 里重新生成一对 Key/Secret。

<a id="pnpm-deploy-opens-cloudflare-login"></a>
## `pnpm deploy` 打开了 Cloudflare 登录

首次部署或 Cloudflare 凭据过期后，这是正常的。在浏览器里完成授权，脚本会继续执行。

<a id="chatgpt-cannot-connect-to-the-mcp-url"></a>
## ChatGPT 无法连接 MCP 地址

使用准确的端点：

```text
https://<worker>.<workers-subdomain>.workers.dev/mcp
```

在浏览器里检查 Worker 的健康检查端点：

```text
https://<worker>.<workers-subdomain>.workers.dev/health
```

它应该返回带 `ok: true` 的 JSON。

<a id="oauth-page-opens-but-does-not-return-to-chatgpt"></a>
## OAuth 页面打开了，但没有返回 ChatGPT

确认你运行的是最新版本的 TradePilot 212，然后重新部署：

```bash
git pull
pnpm install
pnpm deploy
```

如果 ChatGPT 缓存了旧的 OAuth 注册，再在 ChatGPT 里移除并重新连接这个自定义 App。

<a id="ui-still-looks-like-an-older-version-after-deployment"></a>
## 部署后界面看起来还是旧版本

在 ChatGPT 里重新连接或刷新这个自定义 App。即使 Worker 已经更新，ChatGPT 宿主也可能让已经渲染出来的组件实例继续存在。

<a id="app_login_password-rejected"></a>
## `APP_LOGIN_PASSWORD` 被拒绝

使用你本地 `.env.local` 里的值。如果你在本地改过它，运行 `pnpm deploy`，让 Cloudflare Worker 的 Secret 也同步更新。

<a id="live-buttons-are-unavailable"></a>
## LIVE 按钮不可用

逐项检查以下几点：

- 已配置 Live API Key 和 Secret。
- Trading 212 的 Key 有下单权限。
- ChatGPT 的 OAuth 连接授予了 `trade:write`。
- 你当前查看的是 LIVE 环境。

<a id="order-status-becomes-unknown"></a>
## 订单状态变成 `unknown`

**不要**立即重新提交订单。`unknown` 状态表示 Trading 212 可能已经收到写请求，但响应丢失或含义不明。

使用 TradePilot 提示里的 **检查状态**。它只对当前挂单和持仓做只读检查，从不重复原来的写操作。

- 找到匹配的挂单：不要再次提交订单。
- 找到与市价单相符的持仓变化：订单很可能已经执行；重试之前先在 Trading 212 的活动记录里确认。
- 没有确定的证据：保持结果为“不确定”，直接去 Trading 212 查看。

TradePilot 有意不自动重试结果不明的写操作。

<a id="cloudflare-worker-name-is-already-in-use-in-your-account"></a>
## 你的账户里已有同名 Cloudflare Worker

使用自定义名称：

```bash
pnpm deploy -- --name=my-tradepilot
```

<a id="local-chatgpt-testing"></a>
## 本地 ChatGPT 测试

使用：

```bash
pnpm dev:chatgpt
```

这会创建一个临时的 Cloudflare Quick Tunnel。每次运行地址都会变化；它用于开发，不适合长期托管。
