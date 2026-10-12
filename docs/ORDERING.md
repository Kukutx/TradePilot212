# Order review and flexible sizing

TradePilot accepts flexible order intent but always converts it to an explicit Trading 212 quantity before execution.

## Supported inputs

The instrument may be supplied as a Trading 212 ticker, a market symbol, an ISIN, a company name, or a partial name. TradePilot resolves the broker instrument and rejects genuinely ambiguous matches; an ISIN listed on several exchanges returns its listings with their currencies to choose from.

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

### Risk at the stop-loss

For buys, `risk` sizes the order by what it would lose if the price fell to a stop-loss. Give `stopLossPrice` (in the instrument's currency) and either `amount` (in the account currency) or `percent` of the account value:

```json
{ "mode": "risk", "percent": 1, "stopLossPrice": 200 }
```

The entry is the worst price the buy can fill at, so the loss at the stop is never understated: the limit price for a Limit or Stop-Limit; for a Stop, the highest of its trigger, the reference price and the last price, since a trigger the price has already passed fills at once (a Stop becomes a Market order when it triggers, so after a gap it can still fill above its trigger; its review says so); for a Market order, the higher of the reference price and the last price. The last price is the holding's, or the quote source's for an instrument you do not hold. The order editor counts the loss the same way as you edit the prices. The draft's reference price stays a market price, the higher of the price given and the last price, never a Stop's trigger, so the review can still tell a Stop resting above the market from one that triggers at once. Each review of a Market or Stop raises it to the last price when that is higher and dates it then, so `POLICY_MAX_REFERENCE_AGE_SECONDS` sees a price just checked. The draft carries the stop-loss and the budget (`riskBudget`), and the review checks the loss again at the prices of the moment (for an instrument you do not hold, the quote source is read again, and so is its exchange rate when none of your holdings implies one; when the quote source has no quote just then, or no longer has the rate it gave (a rate you gave is kept), or no rate at all converts the loss to the account currency, or nothing prices the order at all, the buy is refused with `RISK_CHECK_UNAVAILABLE` rather than checked at an old price or not at all): when the price has moved, or the quantity was changed, so that the stop would now lose more than the budget, the review says so before you confirm, as it does when the order's price, or the market price for an order that can fill now (not a Stop buy still waiting for the price to rise to its trigger), is already at or under the stop-loss. The send checks once more at the prices of that moment, with the quote and rate read from the quote source itself rather than from its one-minute cache: when the stop would now lose more than the review showed (the budget, or the larger loss it named), or the price has fallen to the stop-loss since, nothing is sent and the result is `RISK_CHANGED`; the widget keeps the order in the editor, so the next review shows it at the new price. The quantity is the budget divided by the fall from the entry to the stop, converted to the account currency the same way as amounts. It is rounded down and never more than the available cash buys; when the cash sets it, the note says so and gives the smaller loss. Without the account's available cash or its currency, a risk-sized buy is refused, since its budget could not be converted or its quantity capped.

A basket (`review_order_basket`) takes a risk-sized buy as an ordinary order: it drops the budget, so the loss at the stop is checked only when the buy is reviewed on its own.

The stop-loss is not part of the order. Set it once the buy fills, for example with `review_protective_orders` or **Set stop-loss** on the holding's page. A gap can fill a stop below its price, so the loss can be larger than the budget.

The order editor shows the loss at the stop as the quantity or price is edited, and marks it when it goes over the budget.

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

## Price checks

A Limit or Stop price ten times above or below the last price is blocked (`PRICE_OUT_OF_RANGE`), because that is almost always a unit slip, such as pounds typed for an instrument quoted in pence. Smaller surprises are notes on the review:

- `STOP_ALREADY_TRIGGERED`: the stop is already at or past the last price, so the order triggers at once;
- `LIMIT_FILLS_AT_ONCE`: a buy limit more than 2% above the last price (or a sell limit 2% below) fills at once near the market price;
- `PRICE_FAR_FROM_LAST`: the price is more than 30% away from the last one;
- `STOP_SLIPPAGE`: on every Stop order, that it becomes a Market order once triggered, so after a gap it can fill past its trigger.

A Stop buy is valued at its stop price when that is above the market, so `MAX_ORDER_NOTIONAL`, the cash check and the policy see what it can cost once triggered.

## Following up an order

`get_order_status` looks up one order by id: still open (and how much filled), or how it ended, with its fills. `review_order_cancel` opens a pending order's cancellation in the widget for you to confirm; the model cannot cancel by itself. `get_trade_history` with `includeUnfilled` also lists orders that were cancelled, rejected or expired.

## Price and FX timestamps

Amount-based sizing should provide a current reference price and, when applicable, a current FX rate. The optional timestamp fields are:

- `referencePriceAt`
- `fxRateAt`

The final confirmation shows when the account snapshot was checked and warns when the reference price is missing a timestamp or is older than the configured freshness threshold used by the app.

A timestamp is context, not a price guarantee. Market orders can still execute away from the reference price.

## Unknown write results

Trading 212 writes are sent once. A network timeout or ambiguous server response does not trigger an automatic retry. The one exception is a write Trading 212 refused with 429 (rate limited), which it did not carry out: it is sent once more after the delay Trading 212 asks for (at least 2.1 seconds, because Limit and Stop orders allow one request per 2 seconds), and reported when that delay is longer than 15 seconds.

Confirmations on one environment are sent one at a time, so two orders confirmed together cannot both pass the daily limits.

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

`MAX_ORDER_NOTIONAL` is in the account currency; an order in another currency is converted at the rate implied by your holdings, or at the quote source's rate for a currency none of them is priced in. With no rate at all the order is blocked while the cap is on; pass `fxRate` with `fxRateAt` from a dated source. Set either application-level cap to `0` to disable that specific TradePilot limit. Trading 212 instrument/account constraints and explicit confirmation still apply.
