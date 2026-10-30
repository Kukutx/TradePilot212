# 发布模式

简体中文 · [English](../PUBLISHING.md)

TradePilot 212 有意以**开源的自托管软件**形式发布。

<a id="recommended-model"></a>
## 推荐模式

一个人 = 一个部署 = 一组 Trading 212 凭据。

```text
User A → User A's ChatGPT → User A's Worker → User A's Trading 212 keys
User B → User B's ChatGPT → User B's Worker → User B's Trading 212 keys
```

仓库所有者不需要提供共享服务器，也不应收集其他用户的券商凭据。

<a id="what-users-do"></a>
## 用户需要做什么

1. Fork 或克隆仓库。
2. 运行 `pnpm setup`。
3. 把自己的 Trading 212 API 凭据填进 `.env.local`。
4. 运行 `pnpm doctor`。
5. 运行 `pnpm deploy`，创建自己的 Cloudflare Worker。
6. 把自己 Worker 的 MCP 地址接入 ChatGPT。

<a id="do-not-share-the-authors-instance"></a>
## 不要共享作者的实例

已部署的 Worker 包含该实例配置的凭据。不要把某个人的 Worker 地址作为通用服务公开给无关用户。

真正的多用户托管产品需要独立的用户身份体系、按用户加密的凭据、租户隔离和授权。这些有意不包含在默认架构中。
