import { describe, expect, it, vi } from "vitest";
import type { BrokerGateway } from "./broker-port.js";
import { createConfig } from "./config.js";
import { ExecutionStatusUnknownError } from "./trading212-client.js";
import { MemoryStateStore } from "./state-store.js";
import { TradingService } from "./trading-service.js";
import type { OrderDraft, TradingEnvironment } from "../shared/contracts.js";
import { createExecutionApprovalProof } from "../shared/execution-proof.js";

const instrument = {
  ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL",
  currencyCode: "USD", type: "STOCK", maxOpenQuantity: 100,
};
const draft: OrderDraft = {
  environment: "demo", ticker: "AAPL_US_EQ", side: "buy",
  type: "market", quantity: 0.5, referencePrice: 100,
};
const secret = "independent-human-approval-secret";
function fixture(overrides: { placeOrder?: BrokerGateway["placeOrder"] } = {}) {
  const config = createConfig({
    APP_LOGIN_PASSWORD: "long-login-password",
    AUTH_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    EXECUTION_APPROVAL_SECRET: secret,
    T212_DEMO_API_KEY: "test-key", T212_DEMO_API_SECRET: "test-secret",
    T212_LIVE_API_KEY: "test-key", T212_LIVE_API_SECRET: "test-secret",
  });
  const placeOrder = vi.fn(overrides.placeOrder ?? (async () => ({ id: "1000" })));
  const cancelOrder = vi.fn(async () => ({ id: "1000", cancelled: true }));
  const factory = (environment: TradingEnvironment): BrokerGateway => ({
    environment,
    getAccountSummary: async () => ({ currency: "USD", cash: { availableToTrade: 1000 } }),
    getPositions: async () => [{ instrument, quantity: 1, quantityAvailableForTrading: 1, quantityInPies: 0, averagePricePaid: 90, currentPrice: 100 }],
    getOrders: async () => [],
    getOrder: async (id) => ({ id, ticker: "AAPL_US_EQ" }),
    getInstruments: async () => [instrument],
    placeOrder,
    cancelOrder,
  });
  const service = new TradingService({ config, store: new MemoryStateStore(), brokerFactory: factory });
  return { service, placeOrder, cancelOrder };
}

describe("order lifecycle boundary", () => {
  it("rejects missing or wrong human approval without consuming the token or trading", async () => {
    const { service, placeOrder } = fixture();
    const preview = await service.prepareOrder(draft);
    const proof = await createExecutionApprovalProof(secret, "order", preview.token);
    await expect(service.executeOrder(preview.token, "")).rejects.toThrow(/incorrect/);
    const wrongActionProof = await createExecutionApprovalProof(secret, "cancel", preview.token);
    await expect(service.executeOrder(preview.token, wrongActionProof)).rejects.toThrow(/incorrect/);
    expect(placeOrder).not.toHaveBeenCalled();
    const result = await service.executeOrder(preview.token, proof);
    expect(result.status).toBe("submitted");
    expect(placeOrder).toHaveBeenCalledTimes(1);
    await expect(service.executeOrder(preview.token, proof)).rejects.toThrow(/expired/);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain broker outcomes read-only and never retries the write", async () => {
    const { service, placeOrder } = fixture({
      placeOrder: async () => { throw new ExecutionStatusUnknownError("upstream connection lost"); },
    });
    const preview = await service.prepareOrder(draft);
    const proof = await createExecutionApprovalProof(secret, "order", preview.token);
    const result = await service.executeOrder(preview.token, proof);
    expect(result.status).toBe("unknown");
    expect(result.verificationId).toBeTruthy();
    const verification = await service.verifyExecution(result.verificationId!);
    expect(verification.status).toBe("no_evidence");
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("requires separate approval for Live cancellation and preserves environment", async () => {
    const { service, cancelOrder } = fixture();
    const preview = await service.prepareCancel("live", "1000");
    const proof = await createExecutionApprovalProof(secret, "cancel", preview.token);
    await expect(service.executeCancel(preview.token, "wrong")).rejects.toThrow(/incorrect/);
    expect(cancelOrder).not.toHaveBeenCalled();
    const result = await service.executeCancel(preview.token, proof);
    expect(result.environment).toBe("live");
    expect(result.status).toBe("submitted");
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    await expect(service.executeCancel(preview.token, proof)).rejects.toThrow(/expired/);
  });
});
