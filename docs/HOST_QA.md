# V3 Personal — manual host and broker acceptance matrix

This is a release gate, NOT proof any of the following production checks were completed. CI tests use in-memory fake API endpoints and fabricated credentials. Keep PR #13 as Draft; don't deploy or use Live trading credentials merely because the checks turn green.

| Check | Required owner environment | Current state |
| --- | --- | --- |
| ChatGPT private MCP OAuth | Owner eligible ChatGPT account, hosted HTTPS MCP, CIMD / PKCE | NOT TESTED |
| ChatGPT Intelligent UI | Eligible ChatGPT with supported model mode, source-labelled data | NOT TESTED |
| ChatGPT sidebar / thread entrypoints | Host supporting optional OpenAI-specific extension | Declared; NOT TESTED |
| Claude remote MCP and portable app | Eligible Claude account and browser/desktop host supporting 2026 MCP | NOT TESTED |
| Owner Console | Chrome, Firefox, Safari, HTTPS, cookie, logout, CSRF, error and Live consent | Mock-tested; REAL BROWSER NOT TESTED |
| Responsive accessibility | Supported ChatGPT/Claude mobile, keyboard and screen reader | NOT TESTED |
| Trading 212 Demo reads | Read-only Demo API credentials, primary-currency and FX holdings | NOT TESTED |
| Trading 212 Demo orders/cancel | Separately authorized Demo key, Market / Limit / Stop / Stop-Limit, partial fills | Simulated; REAL BROKER NOT TESTED |
| Live real money | Independent Live approval plus financial/security review | DISABLED BY DEFAULT; NOT TESTED |
| ECB reference rates | Public ECB API with daily dated CSV and holidays | Mock-tested only |
| SEC EDGAR filings | Owner contact User-Agent and zero-padded 10-digit STRING CIK | Mock-tested only |
| Twelve Data prices | Owner vendor account and explicit quote subscription | Mock-tested only |
| Resend notifications | Verified sender domain plus owner opt-in in Owner Console | Mock-tested; NO REAL EMAIL SENT |
| Cloudflare / Node / Docker | Owner staging secrets, hostname/TLS and persistent state | **Node HTTP and Docker synthetic startup checked in GitHub CI; Cloudflare Wrangler dry-run passes; real Cloudflare deployment/TLS NOT TESTED** |

## Owner steps before accepting this release

Deploy an isolated V3 staging server and generate new secrets with pnpm setup. Use a private env file or Cloudflare Secrets; never paste brokerage keys, owner password, approval key or session cookie into chat or GitHub. Main V2 stays separate.

Test sample first, then a real read-only Demo account. Validate source timestamps, compact-position currency fields, empty positions, historical pagination, broker quotas and the empty-state UI. Run real ChatGPT and Claude session QA without assuming optional Intelligent UI or sidebar controls are present. Verify responsive UI and the standalone Owner Console in real browsers.

Only after explicit owner permission perform very limited Demo order / cancellation tests, confirm broker-side fills and reconcile uncertain responses. No production Live writes are part of CI or this QA document. Do not perform trial trades without the owner's direct authorization.

## Runtime limitations

The AI host owns its generated response visuals; plugin code cannot compel a particular Intelligent UI layout. MCP Apps provides a portable deterministic UI for supported clients. OpenAI sidebar/thread metadata is optional. Older MCP handshakes requiring compatibility shims are intentionally unsupported.

See docs/OPERATIONS.md, docs/OWNER_CONSOLE.md, docs/EXPERIENCE_2026.md.
