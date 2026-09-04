# Flexible ordering from ChatGPT

TradePilot 212 is designed so the user can speak naturally while the execution layer stays explicit.

## Supported intent styles

After connecting the MCP App, ChatGPT may use a ticker, market symbol, company name, or partial name and let TradePilot resolve the exact Trading 212 instrument.

Examples:

```text
Buy 0.2 shares of NVDA in Demo.
Buy about €100 of Nvidia in Live.
Use 20% of my available cash to buy Apple.
Sell half of my Nvidia position.
Sell all available Apple shares.
Buy 0.5 NVDA at a 220 USD limit.
Place a stop / stop-limit order.
Prepare the order only; do not submit it.
```

TradePilot supports these sizing modes:

- exact quantity,
- target monetary amount,
- percentage of available cash for a buy,
- percentage of the currently tradable position for a sell,
- all currently tradable shares for a sell.

## How flexible input becomes a broker order

Trading 212 ultimately receives a standard quantity-based order. For flexible requests TradePilot first resolves the instrument and reads the account/position when needed, then creates an editable order draft.

Amount-based sizing needs a current price. If the requested amount currency differs from the instrument quote currency, ChatGPT must also supply a current FX conversion rate. The computed quantity is rounded down to avoid intentionally overshooting the target amount.

The order is still not sent at this point.

## Confirmation boundary

Every actual order keeps the same flow:

```text
Natural-language request
→ read/resolve/size
→ editable order draft
→ server validation
→ one-time short-lived confirmation
→ explicit user confirmation
→ Trading 212 write
```

LIVE orders are never auto-confirmed by TradePilot. Ambiguous write failures are never retried automatically.

## Personal limits

Self-hosters can configure:

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
```

`DEFAULT_TRADING_ENV` applies only when the user did not explicitly choose Demo or Live.

Set either `MAX_ORDER_NOTIONAL=0` or `MAX_ORDER_QUANTITY=0` to disable that TradePilot app-level cap. Trading 212's own instrument/account rules still apply, and explicit confirmation remains required.
