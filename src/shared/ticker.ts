/** Trading 212 tickers end in a venue suffix: AAPL_US_EQ, VUSAl_EQ (London), SAPd_EQ (Xetra). */
export function symbolFromTicker(ticker: string): string {
  return ticker.replace(/_US_EQ$/, "").replace(/[a-z]?_EQ$/, "") || ticker;
}
