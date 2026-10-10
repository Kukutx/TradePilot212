---
name: tradepilot212-personal-onboarding
description: Guide a single owner through safe self-hosted TradePilot 212 setup and custom MCP connection; never collect credentials in chat.
---

# Owner onboarding (private V3 only)

1. **Choose a self-hosted runtime.** Read the current V3 `README.zh-CN.md` and `docs/OPERATIONS.md`. Use Node 24/pnpm 11, Docker, or Cloudflare Worker. Do not mix this V3 with the previous V2 deployment or OAuth.
2. **Generate secrets locally**, not inside the AI conversation: `pnpm setup`, then `pnpm doctor`, `pnpm check` and `pnpm smoke`.
3. **Start in sample mode**, and verify that all amounts say synthetic. For real brokerage account reads, the owner configures Trading 212 Demo credentials in their own local/private secret store. NEVER ask them to paste API keys, passwords, approval secret or session tokens into ChatGPT or Claude.
4. **Connect the owner-hosted MCP URL** through the host's supported custom MCP workflow. For ChatGPT, use a stable HTTPS `/mcp` URL or a Secure MCP Tunnel where supported. For Claude, use its custom connector interface where supported; host features/entitlements vary.
5. **Authorize least privilege:** `portfolio:read` only at first. Add `monitor:write` for local monitoring configuration, `trading:review` for safe order drafts; `trading:execute` is entirely optional and must never be requested solely to show portfolio analytics.
6. **Try safe prompts:** "What are today's portfolio data-quality or risk observations?" and "Create my basic read-only monitoring thresholds". The latter updates only the private instance, not the broker.
7. **Enable daily briefs and optional email** in the private Owner Console `/owner` after configuring any required provider secrets. Email is OFF by default and requires a verified sender domain. For Node set up an owner-controlled scheduler; Cloudflare Cron is already configured.
8. **Trade execution only after real Demo acceptance:** if the owner explicitly wants personal execution, configure Demo-only execution flags and review one order through the owner's browser. All Live writes require separately enabled flags and actual host/security QA. If the AI host blocks high-risk actions, use the independent authenticated Owner Console—never request a legacy connector downgrade.
9. **Never autonomously place, cancel, or repeat brokerage orders.** A network error or unreadable response is UNKNOWN, not proof of failure. Inspect actual Trading 212 pending orders/fills before further action.
10. **No directory publishing:** this is a one-owner private integration with financial transaction capability. A hypothetical public read-only analytical product is a different release, not a reason to delete valid private V3 features.

Sources: `docs/EXPERIENCE_2026.md`, `docs/FEATURE_PARITY.md`, `SECURITY.md`. Current host capabilities and availability require real-account testing.
