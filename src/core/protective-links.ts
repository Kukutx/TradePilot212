// Emulates one-cancels-other for stop-loss / take-profit pairs, which Trading 212 does not offer.
//
// This is the one unattended write TradePilot makes on Live: cancelling the surviving half of a
// pair after the other half filled. It can only remove an order that would otherwise sell shares
// you no longer hold. It is sent once; an unclear result is logged for you, never retried.
// Set PROTECTIVE_OCO=false to turn linking off.

import type { ProtectiveLink } from "../shared/automation.js";
import type { TradingEnvironment } from "../shared/contracts.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

export interface LinkReport {
  linkId: string;
  environment: TradingEnvironment;
  action: "waiting" | "cancelled_sibling" | "unlinked" | "cancel_unclear";
  message: string;
}

const isFilled = (outcome: { status: string; filledQuantity: number } | undefined) =>
  !!outcome && (outcome.filledQuantity > 0 || (outcome.status.includes("FILLED") && !outcome.status.includes("UNFILLED")));
const isClosedWithoutFill = (outcome: { status: string; filledQuantity: number } | undefined) =>
  !!outcome && !isFilled(outcome) && /CANCEL|REJECT|EXPIRE/.test(outcome.status);

export class ProtectiveLinks {
  constructor(private readonly deps: { config: RuntimeConfig; store: StateStore; trading: TradingService }) {}

  async list(): Promise<ProtectiveLink[]> {
    return (await this.deps.store.list<ProtectiveLink>("link:")).map((entry) => entry.value);
  }

  async reconcile(): Promise<LinkReport[]> {
    if (!this.deps.config.protectiveLinking) return [];
    const links = await this.list();
    if (!links.length) return [];
    const reports: LinkReport[] = [];
    const credentials = credentialStatus(this.deps.config);
    const pendingByEnv = new Map<TradingEnvironment, Set<string>>();
    const historyByEnv = new Map<TradingEnvironment, Awaited<ReturnType<TradingService["recentOrderOutcomes"]>>>();

    for (const link of links) {
      if (!credentials[link.environment]) continue;
      try {
        if (!pendingByEnv.has(link.environment)) pendingByEnv.set(link.environment, await this.deps.trading.pendingOrderIds(link.environment));
        const pending = pendingByEnv.get(link.environment)!;
        const open = link.orders.filter((order) => pending.has(order.orderId));
        if (open.length === 2) continue;
        if (open.length === 0) {
          await this.drop(link, "Both protective orders have left the order book.");
          reports.push({ linkId: link.id, environment: link.environment, action: "unlinked", message: "Both orders are gone." });
          continue;
        }

        const survivor = open[0]!;
        const gone = link.orders.find((order) => order.orderId !== survivor.orderId)!;
        // Only the history read tells a fill apart from a manual cancellation.
        if (!historyByEnv.has(link.environment)) historyByEnv.set(link.environment, await this.deps.trading.recentOrderOutcomes(link.environment));
        const outcome = historyByEnv.get(link.environment)!.get(gone.orderId);

        if (isFilled(outcome)) {
          const reason = `${link.ticker} ${gone.role === "stop_loss" ? "stop-loss" : "take-profit"} ${gone.orderId} filled`;
          const result = await this.deps.trading.cancelLinkedOrder(link.environment, survivor.orderId, reason);
          await this.drop(link);
          reports.push({
            linkId: link.id,
            environment: link.environment,
            action: result === "cancelled" ? "cancelled_sibling" : "cancel_unclear",
            message: result === "cancelled" ? `${reason}; cancelled ${survivor.orderId}.` : `${reason}; cancelling ${survivor.orderId} did not clearly succeed. Check it in Trading 212.`,
          });
        } else if (isClosedWithoutFill(outcome)) {
          await this.drop(link, `${gone.orderId} was cancelled or rejected without a fill, so ${survivor.orderId} stays open.`);
          reports.push({ linkId: link.id, environment: link.environment, action: "unlinked", message: `${gone.orderId} closed without a fill.` });
        } else {
          reports.push({ linkId: link.id, environment: link.environment, action: "waiting", message: `${gone.orderId} is not in the recent history yet.` });
        }
      } catch (error) {
        reports.push({ linkId: link.id, environment: link.environment, action: "waiting", message: error instanceof Error ? error.message : String(error) });
      }
    }
    return reports;
  }

  private async drop(link: ProtectiveLink, note?: string) {
    await this.deps.store.delete(`link:${link.id}`);
    if (note) await this.deps.trading.recordActivity("protective_unlinked", link.environment, { ticker: link.ticker, outcome: note.slice(0, 200) });
  }
}
