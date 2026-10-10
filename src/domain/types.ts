export type Environment = "demo" | "live";
export type Source = "sample" | "trading212";

export interface Account {
  currency: string;
  totalValue: number;
  availableCash: number;
  investmentValue: number;
  unrealizedProfitLoss: number | null;
}
export interface Holding {
  ticker: string;
  name: string;
  currency: string;
  quantity: number;
  tradableQuantity: number;
  price: number | null;
  // Only populated if broker supplied the holding value in account currency,
  // or the quote currency and account currency are identical.
  valueInAccountCurrency: number | null;
  valueProvenance: "same_currency_quote" | "broker_account_value" | "unknown";
}
export interface PortfolioSnapshot {
  kind: "portfolio";
  environment: Environment;
  source: Source;
  asOf: string;
  account: Account;
  holdings: Holding[];
  notes: string[];
}
export interface Exposure {
  ticker: string;
  name: string;
  value: number | null;
  weightPercent: number | null;
  source: Holding["valueProvenance"];
}
export interface PortfolioAnalysis {
  kind: "analysis";
  environment: Environment;
  source: Source;
  asOf: string;
  accountCurrency: string;
  exposureCoveragePercent: number | null;
  largestPositionPercent: number | null;
  cashPercent: number | null;
  concentrationHhi: number | null;
  exposures: Exposure[];
  alerts: string[];
  limitations: string[];
}
export interface Scenario {
  kind: "scenario";
  environment: Environment;
  source: Source;
  asOf: string;
  shockPercent: number;
  currency: string;
  hypotheticalPortfolioChange: number | null;
  hypotheticalPortfolioValue: number | null;
  assumptions: string[];
}
export type RuleKind = "cash_below" | "largest_position_above" | "unrealized_loss_below";
export interface WatchRule {
  id: string;
  environment: Environment;
  kind: RuleKind;
  thresholdPercent: number;
  createdAt: string;
}
export interface RuleEvaluation {
  rule: WatchRule;
  status: "triggered" | "clear" | "unavailable";
  observedPercent: number | null;
  explanation: string;
}
export interface MonitorEvent {
  id: string;
  ruleId: string;
  environment: Environment;
  observedAt: string;
  status: RuleEvaluation["status"];
  observedPercent: number | null;
  thresholdPercent: number;
  detail: string;
}
