# Order review and flexible sizing

TradePilot accepts flexible order intent but always converts it to an explicit Trading 212 quantity before execution.

## Supported inputs

The instrument may be supplied as a Trading 212 ticker, a market symbol, a company name, or a partial name. TradePilot resolves the broker instrument and rejects genuinely ambiguous matches.

Typical requests:

```text
Buy 0.2 shares of NVDA in Demo.
Buy about €100 of Nvidia in Live.
Use 20% of my available cash to buy Apple.
Sell half of my Nvidia position.
Sell all currently tradable Apple shares.
Buy 0.5 NVDA at a 220 USD limit.
Prepare the order only; do not submit it.
```

## Sizing modes

### Exact quantity

The requested quantity is preserved as-is and validated against the selected instrument and current account state.

### Target monetary amount

A target amount is converted to quantity using the supplied reference price. When the requested currency differs from the instrument quote currency, an FX rate is also required.

The calculated quantity is rounded down so the conversion does not intentionally overshoot the target amount.

### Percentage of available cash

For buys, TradePilot reads the account's current available cash, applies the requested percentage, then converts that amount to a quantity.

If the account currency differs from the instrument quote currency, an FX rate is required.

### Percentage of held position

For sells, the percentage is calculated from the **total held position**, not from only the currently tradable subset.

If the requested share count is larger than the currently tradable quantity, TradePilot rejects the conversion rather than silently changing the meaning of the request.

### All currently tradable shares

`all_available` is the explicit sell mode for the entire quantity Trading 212 currently reports as tradable.

## Review flow

```text
Flexible request
  ↓
resolve broker instrument
  ↓
read account/position when required
  ↓
calculate exact quantity
  ↓
editable order draft
  ↓
server validation
  ↓
short-lived one-time confirmation
  ↓
explicit user confirmation
  ↓
Trading 212 write
```

The order editor shows both the original sizing rule and the calculated quantity. If the quantity is edited manually, the UI marks it as changed and offers a restore action for the calculated value.

## Price and FX timestamps

Amount-based sizing should provide a current reference price and, when applicable, a current FX rate. The optional timestamp fields are:

- `referencePriceAt`
- `fxRateAt`

The final confirmation shows when the account snapshot was checked and warns when the reference price is missing a timestamp or is older than the configured freshness threshold used by the app.

A timestamp is context, not a price guarantee. Market orders can still execute away from the reference price.

## Unknown write results

Trading 212 writes are sent once. A network timeout or ambiguous server response does not trigger an automatic retry.

When a write result is unknown, TradePilot creates a short-lived verification record. The UI can then perform a **read-only** check:

- matching pending order found → do not resubmit;
- market-order position moved by the requested size → likely executed, verify broker activity before any retry;
- no conclusive evidence → remain uncertain and check Trading 212 before taking further action.

The verification action never repeats the original write.

## Instance limits

Self-hosters may configure:

```env
DEFAULT_TRADING_ENV=demo
MAX_ORDER_NOTIONAL=5000
MAX_ORDER_QUANTITY=100000
```

`DEFAULT_TRADING_ENV` applies only when the request does not explicitly select Demo or Live.

Set either application-level cap to `0` to disable that specific TradePilot limit. Trading 212 instrument/account constraints and explicit confirmation still apply.
