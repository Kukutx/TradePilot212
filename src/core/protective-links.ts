// Emulates one-cancels-other for stop-loss / take-profit pairs, which Trading 212 does not offer.
//
// This is the one unattended write TradePilot makes on Live: cancelling the surviving half of a
// pair after the other half filled completely. It can only remove an order that would otherwise sell
// shares you no longer hold, so a failed or unclear cancel is tried again on later ticks (cancelling
// twice is harmless) and then reported to you. A partial fill is reported and left for you to adjust.
// Set PROTECTIVE_OCO=false to turn linking off.

import type { ProtectiveLink } from "../shared/automation.js";
import type { TradingEnvironment } from "../shared/contracts.js";
import { credentialStatus, type RuntimeConfig } from "./config.js";
import type { StateStore } from "./state-store.js";
import type { TradingService } from "./trading-service.js";

const LINK_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export interface LinkReport {
  linkId: string;
  environment: TradingEnvironment;
  action: "waiting" | "cancelled_sibling" | "unlinked" | "cancel_unclear";
  message: string;
}

type Outcome = { status: string; filledQuantity: number; quantity: number };
const fullyFilled = (outcome: Outcome | undefined) =>
  !!outcome && ((/FILLED/.test(outcome.status) && !/UNFILLED|PARTIAL/.test(outcome.status))
    || (outcome.quantity > 0 && outcome.filledQuantity >= outcome.quantity * (1 - 1e-6)));
const partlyFilled = (outcome: Outcome | undefined) => !!outcome && outcome.filledQuantity > 0 && !fullyFilled(outcome);
const isClosedWithoutFill = (outcome: Outcome | undefined) =>
  !!outcome && outcome.filledQuantity <= 0 && !fullyFilled(outcome) && /CANCEL|REJECT|EXPIRE/.test(outcome.status);
/**
 * How long a pair is left alone while one of its orders is changed, at most: longer than a change can take with every
 * read waiting for its limit. The change releases it as soon as it ends.
 */
const HOLD_MS = 15 * 60_000;
/** Failed cancels of the surviving order are retried on later ticks, then left to you. */
const MAX_CANCEL_ATTEMPTS = 5;

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
    const historyByEnv = new Map<TradingEnvironment, Map<string, Outcome>>();

    // Pass 1: which links lost an order, so history is read once per environment for all of them.
    const halfOpen: Array<{ link: ProtectiveLink; survivor: ProtectiveLink["orders"][number]; gone: ProtectiveLink["orders"][number] }> = [];
    for (const link of links) {
      if (!credentials[link.environment]) continue;
      // One of its orders is being changed: for a moment it is not in the book, which is no fill.
      if (link.hold && Date.parse(link.hold.until) > Date.now()) continue;
      try {
        if (!pendingByEnv.has(link.environment)) pendingByEnv.set(link.environment, await this.deps.trading.pendingOrderIds(link.environment));
        const pending = pendingByEnv.get(link.environment)!;
        const open = link.orders.filter((order) => pending.has(order.orderId));
        if (open.length === 2) continue;
        if (open.length === 0) {
          if (!await this.unchanged(link)) continue;
          await this.drop(link, "Both protective orders have left the order book.");
          reports.push({ linkId: link.id, environment: link.environment, action: "unlinked", message: "Both orders are gone." });
          continue;
        }
        const survivor = open[0]!;
        halfOpen.push({ link, survivor, gone: link.orders.find((order) => order.orderId !== survivor.orderId)! });
      } catch (error) {
        reports.push({ linkId: link.id, environment: link.environment, action: "waiting", message: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const { link, survivor, gone } of halfOpen) {
      try {
        // Only the history read tells a fill apart from a manual cancellation.
        if (!historyByEnv.has(link.environment)) {
          const same = halfOpen.filter((entry) => entry.link.environment === link.environment);
          const since = same.map((entry) => entry.link.createdAt).sort()[0];
          historyByEnv.set(link.environment, await this.deps.trading.recentOrderOutcomes(link.environment, { wanted: same.map((entry) => entry.gone.orderId), ...(since ? { since } : {}) }));
        }
        const outcome = historyByEnv.get(link.environment)!.get(gone.orderId);
        const label = `${link.ticker} ${gone.role === "stop_loss" ? "stop-loss" : "take-profit"} ${gone.orderId}`;
        // A change of one of its orders may have started since the links were read: the pair is left to it.
        if (!await this.unchanged(link)) {
          reports.push({ linkId: link.id, environment: link.environment, action: "waiting", message: `${gone.orderId} is being changed.` });
          continue;
        }

        if (fullyFilled(outcome)) {
          const reason = `${label} filled`;
          const attempts = link.cancelAttempts ?? 0;
          const result = await this.deps.trading.cancelLinkedOrder(link.environment, survivor.orderId, reason, { quiet: attempts > 0 });
          if (result === "cancelled" || result === "gone") {
            await this.drop(link);
            reports.push({ linkId: link.id, environment: link.environment, action: "cancelled_sibling", message: `${reason}; ${result === "cancelled" ? "cancelled" : "no longer pending:"} ${survivor.orderId}.` });
          } else if (attempts + 1 >= MAX_CANCEL_ATTEMPTS) {
            await this.drop(link);
            await this.attention(link, `${reason}, but cancelling ${survivor.orderId} failed ${attempts + 1} times. Cancel it in Trading 212, or it may sell shares you buy later.`);
            reports.push({ linkId: link.id, environment: link.environment, action: "cancel_unclear", message: `${reason}; cancelling ${survivor.orderId} kept failing. Check it in Trading 212.` });
          } else {
            // Cancelling twice is harmless, so a failed or unclear cancel is tried again next tick.
            await this.deps.store.put(`link:${link.id}`, { ...link, cancelAttempts: attempts + 1 }, Date.parse(link.createdAt) + LINK_TTL_MS);
            reports.push({ linkId: link.id, environment: link.environment, action: "cancel_unclear", message: `${reason}; cancelling ${survivor.orderId} did not clearly succeed and will be tried again.` });
          }
        } else if (partlyFilled(outcome)) {
          // The survivor still covers the original quantity; cancelling it would leave the rest unprotected.
          await this.drop(link);
          await this.attention(link, `${label} filled ${outcome!.filledQuantity}${outcome!.quantity ? ` of ${outcome!.quantity}` : ""} and closed. ${survivor.orderId} still covers the original quantity; adjust it to what you hold.`);
          reports.push({ linkId: link.id, environment: link.environment, action: "unlinked", message: `${gone.orderId} filled only partly; ${survivor.orderId} was left open for you to adjust.` });
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

  /** One of a pair's orders is about to be cancelled to be changed: the pair is left alone while that runs. */
  async hold(environment: TradingEnvironment, orderId: string): Promise<void> {
    const until = new Date(Date.now() + HOLD_MS).toISOString();
    for (const link of await this.linksWith(environment, orderId)) await this.save({ ...link, hold: { orderId, until } });
  }

  /**
   * The change ended: the pair now links the order that replaced the old one, or, when none did, is checked again as
   * before (the old order closed without a fill, so the pair is unlinked and the other order stays).
   */
  async swap(environment: TradingEnvironment, orderId: string, newOrderId?: string): Promise<void> {
    for (const link of await this.linksWith(environment, orderId)) {
      const { hold: _, ...rest } = link;
      const orders = newOrderId ? link.orders.map((order) => (order.orderId === orderId ? { ...order, orderId: newOrderId } : order)) as ProtectiveLink["orders"] : link.orders;
      await this.save({ ...rest, orders });
    }
  }

  /** Whether the pair is still saved as it was read, and no change of its orders is under way. */
  private async unchanged(link: ProtectiveLink): Promise<boolean> {
    const now = await this.deps.store.get<ProtectiveLink>(`link:${link.id}`);
    if (!now || (now.hold && Date.parse(now.hold.until) > Date.now())) return false;
    return now.orders.every((order, index) => order.orderId === link.orders[index]?.orderId);
  }

  private async linksWith(environment: TradingEnvironment, orderId: string): Promise<ProtectiveLink[]> {
    return (await this.list()).filter((link) => link.environment === environment && link.orders.some((order) => order.orderId === orderId));
  }

  private save(link: ProtectiveLink) {
    return this.deps.store.put(`link:${link.id}`, link, Date.parse(link.createdAt) + LINK_TTL_MS);
  }

  private async attention(link: ProtectiveLink, note: string) {
    await this.deps.trading.recordActivity("protective_attention", link.environment, { ticker: link.ticker, outcome: note.slice(0, 200) });
  }

  private async drop(link: ProtectiveLink, note?: string) {
    await this.deps.store.delete(`link:${link.id}`);
    if (note) await this.deps.trading.recordActivity("protective_unlinked", link.environment, { ticker: link.ticker, outcome: note.slice(0, 200) });
  }
}
