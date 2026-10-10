# Privacy — TradePilot 212 V3 Personal

**Operator:** the individual self-hosting their own deployment. There is no repository-author-run shared brokerage account service, brokerage-credential broker or ad/analytics backend.

**Data handled:** account-currency totals, positions, quantities, symbols, order status, requested research briefs, local risk rules and alerts, order/cancel metadata history, short-lived confirmation and verification records, OAuth client metadata and session grants.

**Storage:** on your own Node local `.data/` or Cloudflare Durable Object. Order/activity metadata may be retained up to 90 days; ambiguous write verification 24 hours; local watch events 30 days; monitor rules persist until removed; cached portfolio reads 30 seconds; refresh grants 14 days. Container logs, infrastructure backups and optional analytics are controlled by the operator.

**Recipients:** Trading 212 receives approved GET/POST/DELETE only when authorized. ChatGPT/Claude (when you connect them) may receive portfolio or trade proposal data, and on explicit human confirmation, a **token-specific approval proof**. They do not receive the raw approval secret or API keys through designed tool outputs. Host privacy/retention rules apply independently.

**Control:** use sample mode, withhold Live keys, disable execution flags, revoke API keys, rotate owner credentials, delete local rules/state, shut down the Worker, and disconnect the AI host. Never attempt to reconcile an unknown brokerage write by deleting state; verify directly with the broker first.

**Warning:** The private self-hosted project is not a centralized multi-user product; its privacy and hosting guarantees depend on your deployment configuration and connected AI platform.
