import type {
  AccountSummary,
  Instrument,
  OrderDraft,
  PendingOrder,
  Position,
  TradingEnvironment,
} from "../shared/contracts.js";

/**
 * Domain-facing broker port. An adapter is responsible for API transport,
 * credential isolation, rate limits, and classifying ambiguous writes.
 *
 * Broker implementations MUST NOT automatically retry order/cancel commands.
 */
export interface BrokerGateway {
  readonly environment: TradingEnvironment;
  getAccountSummary(): Promise<AccountSummary>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<PendingOrder[]>;
  getOrder(orderId: string): Promise<PendingOrder>;
  getInstruments(): Promise<Instrument[]>;
  placeOrder(draft: OrderDraft): Promise<unknown>;
  cancelOrder(orderId: string): Promise<unknown>;
}

export type BrokerFactory = (environment: TradingEnvironment) => BrokerGateway;
