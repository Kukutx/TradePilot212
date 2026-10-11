// Trading 212 pies: target-weight baskets the broker keeps invested. The API marks them deprecated
// but still serves them. Shares are fractions of 1 per instrument ticker.

import type { CredentialStatus, TradingEnvironment } from "./contracts.js";

export type DividendCashAction = "REINVEST" | "TO_ACCOUNT_CASH";
export type PieStatus = "AHEAD" | "ON_TRACK" | "BEHIND";

export interface PieResult {
  priceAvgInvestedValue?: number;
  priceAvgResult?: number;
  priceAvgResultCoef?: number;
  priceAvgValue?: number;
}

export interface PieSummary {
  id: number;
  cash?: number;
  dividendDetails?: { gained?: number; inCash?: number; reinvested?: number };
  progress?: number;
  result?: PieResult;
  status?: PieStatus | null;
}

export interface PieInstrumentIssue {
  name: string;
  severity: "IRREVERSIBLE" | "REVERSIBLE" | "INFORMATIVE";
}

export interface PieInstrument {
  ticker: string;
  currentShare?: number;
  expectedShare?: number;
  ownedQuantity?: number;
  issues?: PieInstrumentIssue[];
  result?: PieResult;
}

export interface PieSettings {
  id: number;
  name?: string;
  icon?: string;
  goal?: number;
  initialInvestment?: number;
  instrumentShares?: Record<string, number> | null;
  dividendCashAction?: DividendCashAction;
  creationDate?: string;
  endDate?: string;
  publicUrl?: string | null;
}

export interface PieDetail {
  instruments?: PieInstrument[];
  settings?: PieSettings;
}

/** Body of the create and update calls. */
export interface PieRequest {
  name: string;
  instrumentShares: Record<string, number>;
  dividendCashAction: DividendCashAction;
  icon?: string;
  goal?: number;
  endDate?: string;
}

/** A pie with the derived numbers TradePilot adds: drift from target and the largest gaps. */
export interface PieOverview {
  id: number;
  name: string;
  status: PieStatus | null;
  cash: number;
  invested: number;
  value: number;
  result: number;
  resultPercent: number | null;
  progress: number | null;
  goal?: number;
  dividends: { gained: number; reinvested: number; inCash: number };
  /** Sum of |current - target| / 2: the share of the pie that would have to move to match its targets. */
  drift?: number;
  instruments?: Array<{
    ticker: string;
    targetShare: number;
    currentShare: number;
    driftShare: number;
    ownedQuantity: number;
    value?: number;
    result?: number;
    issues: PieInstrumentIssue[];
  }>;
  settings?: PieSettings;
}

export interface PiesPayload {
  kind: "pies";
  environment: TradingEnvironment;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
  pies: PieOverview[];
  totals: { value: number; invested: number; result: number; cash: number };
  notes: string[];
  timestamp: string;
}

export type PieAction = "create" | "update" | "delete" | "duplicate";

/** What the model drafts; the widget turns it into a preview the user confirms. */
export interface PieChangeDraft {
  environment: TradingEnvironment;
  action: PieAction;
  pieId?: number;
  name?: string;
  icon?: string;
  goal?: number;
  endDate?: string;
  dividendCashAction?: DividendCashAction;
  /** Ticker (or symbol) to share; shares are normalised to sum to 1. */
  instrumentShares?: Record<string, number>;
}

export interface PieChangeDraftPayload {
  kind: "pie_change_draft";
  draft: PieChangeDraft;
  current?: PieOverview;
  credentials: CredentialStatus;
  writeEnabled?: boolean;
}

export interface PieChangePreview {
  kind: "pie_change_preview";
  token: string;
  expiresAt: string;
  environment: TradingEnvironment;
  action: PieAction;
  pieId?: number;
  /** The exact body that will be sent, after tickers were resolved and shares normalised. */
  request?: PieRequest;
  current?: PieOverview;
  changes: Array<{ ticker: string; from: number; to: number }>;
  notices: string[];
}

export interface PieChangeResult {
  kind: "pie_change_result";
  environment: TradingEnvironment;
  action: PieAction;
  ok: boolean;
  status: "submitted" | "rejected" | "unknown";
  pieId?: number;
  message: string;
  pie?: PieDetail;
}
