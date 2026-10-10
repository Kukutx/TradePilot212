import type { Environment, PortfolioSnapshot } from "./types.js";

export type TradeSide = "buy" | "sell";
export type TradeOrderType = "market" | "limit" | "stop" | "stop_limit";
export type TradeValidity = "DAY" | "GOOD_TILL_CANCEL";
export type Sizing =
  | { mode: "quantity"; quantity: number }
  | { mode: "notional"; amount: number; currency?: string; fxToQuote?: number }
  | { mode: "cash_percent"; percent: number; fxToQuote?: number }
  | { mode: "position_percent"; percent: number }
  | { mode: "all_available" };
export interface Instrument {
  ticker: string;
  name: string;
  shortName: string;
  currencyCode: string;
  type?: string;
  extendedHours?: boolean;
  maxOpenQuantity?: number;
}
export interface TradeIntent {
  environment: Environment;
  instrument: string;
  side: TradeSide;
  type: TradeOrderType;
  sizing: Sizing;
  referencePrice?: number;
  referencePriceAt?: string;
  fxRateAt?: string;
  limitPrice?: number;
  stopPrice?: number;
  extendedHours?: boolean;
  timeValidity?: TradeValidity;
}
export interface TradeDraft {
  environment: Environment;
  ticker: string;
  side: TradeSide;
  type: TradeOrderType;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  referencePrice?: number;
  referencePriceAt?: string;
  fxRateAt?: string;
  extendedHours?: boolean;
  timeValidity?: TradeValidity;
}
export interface TradeResolution {
  kind: "trade_draft";
  draft: TradeDraft;
  instrument: Instrument;
  source: "trading212";
  sizing: Sizing;
  note: string;
  estimatedNotional: number | null;
  quoteCurrency: string;
  accountCurrency: string;
  heldQuantity: number;
  tradableQuantity: number;
  warnings: string[];
}
export interface TradePreview {
  kind: "trade_preview";
  token: string;
  expiresAt: string;
  snapshotAt: string;
  draft: TradeDraft;
  instrument: Instrument;
  accountCurrency: string;
  estimatedNotional: number | null;
  warnings: string[];
  environment: Environment;
  personalExecutionEnabled: boolean;
}
export interface CancelPreview {
  kind: "cancel_preview";
  token: string;
  expiresAt: string;
  environment: Environment;
  orderId: string;
  ticker: string | null;
}
export interface PendingOrder {
  id: string;
  ticker: string;
  quantity: number;
  side?: string;
  type?: string;
  status?: string;
  createdAt?: string;
}
export interface TradeExecution {
  kind: "trade_execution";
  environment: Environment;
  operation: "order" | "cancel";
  status: "submitted" | "rejected" | "unknown";
  message: string;
  orderId?: string;
  verificationId?: string;
}
export interface TradeVerification {
  kind: "trade_verification";
  environment: Environment;
  operation: "order" | "cancel";
  status: "matching_pending" | "likely_filled" | "still_pending" | "no_longer_pending" | "inconclusive";
  checkedAt: string;
  message: string;
  orderId?: string;
  ticker?: string;
}
export interface TradeIdea {
  ticker?: string;
  symbol?: string;
  name?: string;
  horizon: "short" | "medium" | "long";
  action: "buy" | "sell" | "watch";
  score: number;
  risk: "low" | "medium" | "high";
  rationale: string;
  thesis?: string;
  catalysts?: string[];
  risks?: string[];
  counterCase?: string;
  sources?: string[];
  analysisAsOf?: string;
  suggestedQuantity?: number;
  referencePrice?: number;
  referencePriceAt?: string;
}
export interface TradingLimits {
  maxQuantity: number;
  maxNotional: number;
}
function requirePositive(name: string, value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}
function roundDown(n: number): number {
  return Math.floor((n + Number.EPSILON) * 1e8) / 1e8;
}
function label(value: string): string { return value.trim().toUpperCase(); }

/** Broker-specific tickers win. Stock names resolve only when the matching listing is unambiguous. */
export function resolveInstrument(instruments: Instrument[], query: string): Instrument {
  const q=label(query);
  if (!q) throw new Error("An instrument name or ticker is required");
  const exactTicker=instruments.find(i=>label(i.ticker)===q);
  if (exactTicker) return exactTicker;
  const symbolMatches=instruments.filter(i=>label(i.shortName)===q || label(i.ticker).startsWith(q+"_") || label(i.ticker).startsWith(q+"-"));
  if (symbolMatches.length===1) return symbolMatches[0]!;
  if (symbolMatches.length>1) {
    const us=symbolMatches.filter(i=>/_US_EQ$/i.test(i.ticker) && label(i.type||"STOCK")==="STOCK");
    if(us.length===1) return us[0]!;
    throw new Error(`Ambiguous symbol: ${symbolMatches.slice(0,8).map(i=>i.ticker).join(", ")}`);
  }
  const matches=instruments.filter(i=>label(i.name)===q || label(i.name).includes(q));
  if(matches.length===1)return matches[0]!;
  if(matches.length>1){
    const exact=matches.filter(i=>label(i.name)===q && label(i.type||"STOCK")==="STOCK");
    const preferred=exact.filter(i=>/_US_EQ$/i.test(i.ticker));
    if(preferred.length===1)return preferred[0]!;
    if(exact.length===1)return exact[0]!;
    throw new Error(`Ambiguous name: ${matches.slice(0,8).map(i=>i.ticker).join(", ")}`);
  }
  throw new Error(`No matching Trading 212 instrument for ${query}`);
}

/** Revalidate a draft against fresh account + position data before issuing and again before writing. */
export function checkDraft(draft: TradeDraft, instrument: Instrument, account: PortfolioSnapshot, limits: TradingLimits) {
  if(draft.ticker!==instrument.ticker || draft.environment!==account.environment)throw new Error("Ticker/environment mismatch");
  requirePositive("quantity", draft.quantity);
  if(limits.maxQuantity>0&&draft.quantity>limits.maxQuantity)throw new Error("MAX_ORDER_QUANTITY exceeded");
  if(draft.type==="limit"||draft.type==="stop_limit")requirePositive("limitPrice",draft.limitPrice);
  if(draft.type==="stop"||draft.type==="stop_limit")requirePositive("stopPrice",draft.stopPrice);
  if(draft.extendedHours&&draft.type!=="market")throw new Error("Extended hours are available only for market orders");
  if(draft.extendedHours&&!instrument.extendedHours)throw new Error("Instrument does not support extended hours");
  const held=account.holdings.find(h=>h.ticker===draft.ticker);
  const heldQuantity=held?.quantity??0;
  const tradableQuantity=held?.tradableQuantity??0;
  if(draft.side==="sell"&&draft.quantity>tradableQuantity+1e-8)throw new Error("Insufficient tradable shares");
  if(draft.side==="buy"&&instrument.maxOpenQuantity&&heldQuantity+draft.quantity>instrument.maxOpenQuantity+1e-8)
    throw new Error("Instrument maxOpenQuantity exceeded");
  const price = draft.type==="limit"||draft.type==="stop_limit" ? draft.limitPrice
    : draft.type==="stop" ? draft.stopPrice : (held?.price&&held.price>0 ? held.price : draft.referencePrice);
  const amount=price&&price>0?price*draft.quantity:null;
  if(limits.maxNotional>0){
    if(amount===null)throw new Error("Reference price is required to estimate capped order notional");
    if(amount>limits.maxNotional)throw new Error("MAX_ORDER_NOTIONAL exceeded");
  }
  const warnings:string[]=[];
  if(draft.environment==="live")warnings.push("LIVE ORDER: real money may be used.");
  if(draft.type==="market")warnings.push("Market order may fill at a different price; estimated notional is not a guaranteed cap.");
  if(draft.side==="buy" && draft.type==="stop")warnings.push("Stop buy becomes a market order after the trigger and may slip.");
  if(draft.side==="buy" && account.account.currency===instrument.currencyCode && amount!==null &&
     amount>account.account.availableCash)throw new Error("Insufficient estimated cash balance");
  if(draft.side==="buy" && account.account.currency!==instrument.currencyCode)
    warnings.push("Cross-currency funds estimate is not authoritative; Trading 212 performs final currency/funds checks.");
  if(draft.type==="market" && !(held?.price && held.price>0))
    warnings.push("Reference price is not a broker-observed current quote for this unheld instrument.");
  if(draft.referencePrice!==undefined){
    const age=draft.referencePriceAt ? Date.now()-Date.parse(draft.referencePriceAt) : NaN;
    if(!Number.isFinite(age))warnings.push("Reference-price timestamp is unknown.");
    else if(age>300_000 || age< -30_000)warnings.push("Reference price may be stale or have a future timestamp.");
  }
  if(draft.fxRateAt){
    const age=Date.now()-Date.parse(draft.fxRateAt);
    if(!Number.isFinite(age)||age>300_000||age< -30_000)warnings.push("FX conversion may be stale or unverified.");
  }
  if(amount===null)warnings.push("Notional estimate unavailable.");
  return {estimatedNotional:amount, accountCurrency:account.account.currency, heldQuantity,tradableQuantity,warnings};
}
export function resolveTradeIntent(
  intent: TradeIntent, instruments: Instrument[], account: PortfolioSnapshot, limits: TradingLimits,
): TradeResolution {
  if(intent.environment!==account.environment || account.source!=="trading212")
    throw new Error("A fresh real broker snapshot from the selected environment is required");
  const instrument=resolveInstrument(instruments,intent.instrument);
  const held=account.holdings.find(h=>h.ticker===instrument.ticker);
  const heldQuantity=held?.quantity??0,tradableQuantity=held?.tradableQuantity??0;
  // Money sizing must use the broker-enforceable limit for Limit/Stop-Limit,
  // not an AI-provided reference which might differ by orders of magnitude.
  // Market sizing uses the observed held price if available.
  const price=(intent.type==="limit"||intent.type==="stop_limit")
    ? intent.limitPrice
    : intent.type==="stop" ? intent.stopPrice
      : (held?.price!==null && held?.price!==undefined && held.price>0 ? held.price : intent.referencePrice);
  const sizing=intent.sizing;
  let quantity:number;
  let note:string;
  let usedManualFx=false;
  if(sizing.mode==="quantity"){requirePositive("quantity",sizing.quantity);quantity=sizing.quantity;note=`Exact ${quantity} shares.`;}
  else if(sizing.mode==="position_percent"){
    if(intent.side!=="sell")throw new Error("position_percent requires sell side");
    requirePositive("percent",sizing.percent);
    if(sizing.percent>100)throw new Error("Position percent must be <= 100");
    quantity=sizing.percent===100?heldQuantity:roundDown(heldQuantity*sizing.percent/100);
    note=`Sell ${sizing.percent}% of the held position.`;
  }else if(sizing.mode==="all_available"){
    if(intent.side!=="sell")throw new Error("all_available requires sell side");
    quantity=tradableQuantity;note="Sell all currently tradable shares.";
  }else{
    if(sizing.mode==="cash_percent"&&intent.side!=="buy")throw new Error("cash_percent requires buy side");
    const amount=sizing.mode==="notional"?sizing.amount:account.account.availableCash*sizing.percent/100;
    if(sizing.mode==="cash_percent"&&sizing.percent>100)throw new Error("Cash percent must be <= 100");
    requirePositive("amount",amount);requirePositive("referencePrice",price);
    const requestedCurrency=sizing.mode==="notional"?(sizing.currency||instrument.currencyCode):account.account.currency;
    usedManualFx=label(requestedCurrency)!==label(instrument.currencyCode);
    const quote=usedManualFx?amount*(sizing.fxToQuote??NaN):amount;
    requirePositive("fxToQuote",quote);
    quantity=roundDown(quote/price);
    note=sizing.mode==="notional"?`Approximate ${amount} ${requestedCurrency} target.`:
      `Spend approximately ${sizing.percent}% of available ${account.account.currency} cash.`;
  }
  requirePositive("resolved quantity",quantity);
  const draft:TradeDraft={environment:intent.environment,ticker:instrument.ticker,side:intent.side,type:intent.type,quantity,
    ...(intent.referencePrice===undefined&&price===undefined?{}:{referencePrice:price}),
    ...(intent.referencePriceAt?{referencePriceAt:intent.referencePriceAt}:{}),
    ...(intent.fxRateAt?{fxRateAt:intent.fxRateAt}:{}),
    ...(intent.limitPrice===undefined?{}:{limitPrice:intent.limitPrice}),
    ...(intent.stopPrice===undefined?{}:{stopPrice:intent.stopPrice}),
    ...(intent.extendedHours===undefined?{}:{extendedHours:intent.extendedHours}),
    ...(intent.timeValidity?{timeValidity:intent.timeValidity}:{}),
  };
  const valid=checkDraft(draft,instrument,account,limits);
  return {kind:"trade_draft",draft,instrument,source:"trading212",sizing,note,
    estimatedNotional:valid.estimatedNotional,quoteCurrency:instrument.currencyCode,
    accountCurrency:valid.accountCurrency,heldQuantity:valid.heldQuantity,tradableQuantity:valid.tradableQuantity,
    warnings:[...valid.warnings,...(usedManualFx&&!intent.fxRateAt
      ? ["An external FX rate was provided without a verification timestamp; inspect currency conversion before approval."]:[])],
  };
}
