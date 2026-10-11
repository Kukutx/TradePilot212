# Pies

Trading 212 pies are target-weight baskets that the broker keeps invested. Trading 212 marks the pies endpoints of its Public API as deprecated, but still serves them, and TradePilot covers all six of them.

The API key needs the pies read permission for the read tools and the pies write permission for changes. Without it, Trading 212 answers 403 and TradePilot says which permission is missing.

## Reading pies

`list_pies` shows every pie with:

- value, invested amount, return in money and percent, and cash waiting in the pie;
- dividends gained, reinvested and paid out;
- the goal and progress toward it, and Trading 212's status (ahead, on track, behind);
- for the newest pies (10 by default), each slice's target share, current share, drift and owned quantity, plus any issue Trading 212 reports for a slice, such as a delisted instrument.

Drift is half the sum of the absolute differences between current and target shares: the share of the pie that would have to move to match the targets.

`get_pie` reads one pie in full.

Trading 212 allows one pie list read every 30 seconds and one pie detail read every 5 seconds. TradePilot caches the list for 30 seconds and each pie for 60 seconds, and the broker client waits and retries a read that hits the limit. Pass `fresh: true` to skip the cache.

## Changing pies

`review_pie_change` drafts one of four changes and opens it in the widget. It never changes anything by itself.

| Action | What is sent |
|---|---|
| `create` | A new pie with a name, slices, dividend handling (reinvest or pay out), and an optional goal, end date and icon. Creating a pie invests nothing. |
| `update` | The full settings of an existing pie. Fields you leave out keep their current values, including the slices. |
| `duplicate` | A copy of a pie with the same slices and settings, optionally with a new name. The copy starts empty. |
| `delete` | Removes the pie. Trading 212 decides what happens to its holdings, so check the app first. |

Slices are given as ticker, symbol or name to a share. Shares are scaled to sum to exactly 1 at four decimals, so `{"VUSA": 70, "EIMI": 30}` works. A pie has at most 50 slices.

In the widget, **Review change** resolves the tickers, shows each slice's share before and after, and lists what to watch out for, for example a slice that is removed while shares are still held in it. **Confirm pie change** sends it once. On Live, you also tick the box that confirms a real-money account will change, and the server refuses the change without it. An unclear result is reported and never retried; refresh your pies before trying again.

New target shares guide future investments. Trading 212 does not sell existing holdings to match them unless you rebalance the pie in the app.

## Putting money into a pie

The Public API cannot deposit into a pie. Buy the slices with an order basket (`review_order_basket` or `plan_portfolio_rebalance`), or add money to the pie in the Trading 212 app.
