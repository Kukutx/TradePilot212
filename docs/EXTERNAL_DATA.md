# V3 External Data — Source Provenance

TradePilot 212 V3 Personal does not pass AI-guessed quotes, snippets or unvalidated conversion rates to its brokerage execution core. External data is for **read-only evidence and human decisions**.

## ECB daily reference FX

MCP: `get_ecb_reference_fx`. Owner Console: research panel → ECB.

- Fixed official host: `https://data-api.ecb.europa.eu`, daily EXR series.
- Validate TIME_PERIOD, OBS_VALUE, source currency, response size and dates.
- Cross-currency conversion is returned **only if all used series have the same ECB observation date**. Values older than seven days are marked stale.
- These are dated **reference** values, not realtime bid/ask rates or executable Trading 212 FX conversions. V3 never automatically inserts these into an order.

Official docs: https://data.ecb.europa.eu/help/api/data-examples

## SEC EDGAR primary disclosures

MCP: `get_official_sec_company_filings`. Owner Console: SEC form.

- Optional `SEC_CONTACT_EMAIL=operator@example.org` required to satisfy SEC fair-access identification. This contact is sent in the User-Agent header to SEC, not to the model.
- US ticker resolved using fixed `www.sec.gov/files/company_tickers.json`; current filings retrieved from `data.sec.gov/submissions/CIK##########.json`.
- Outputs include official form, filing date and direct SEC document links; capped at ten. Hostname, ticker and generated document paths are tightly bounded. Information is **filing metadata only**, not an automatic verified summary of the filing.
- Missing contact or invalid ticker fails closed rather than pretending filings do not exist.

Official docs: https://www.sec.gov/search-filings/edgar-application-programming-interfaces

## Optional vendor quotes

MCP: `get_optional_verified_market_quote`. Owner Console: Vendor Quote.

- Set `TWELVE_DATA_API_KEY` only in self-hosted server secrets. No account key → explicit unavailable.
- Fixed `https://api.twelvedata.com/quote` GET. Confirm returned symbol, quote currency, optional exchange, finite positive close and source timestamp.
- Missing/future/older-than-five-minute provider timestamps => `isStale=true`. A short cache limits quota consumption.
- Returns `usage=research_reference_not_order_execution`. Subscription terms determine delay, coverage and rights. Model outputs and broker executions never treat these quotes as guaranteed fills.

Vendor docs: https://twelvedata.com/docs/mcp

## Important limitations

The adapters supply ECB official statistics, SEC source filings and optional vendor prices. They are **not a general licensed real-time financial news aggregation service** and do not cover all global markets. V3 does not claim fact-checking of AI-written theses or independently verified quote freshness merely because an HTTPS link exists.

No external research provider receives Trading 212 API secrets. Twelve Data sees its own API key and requested ticker; SEC sees the configured contact; optional email provider sees a limited alert summary only if the owner opts in.

All provider tests use mocks. Real subscription, rate, license, networking and accuracy QA remain manual release gates.
