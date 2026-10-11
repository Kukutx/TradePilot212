import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../core/policy";
import { createConfig } from "../../core/config";
import { createTranslator } from "../i18n";
import { policyMessage, rebalanceNoteText, rebalanceSkipText } from "./messages";

describe("policy messages", () => {
  const policy = createConfig({ POLICY_APPLY_TO: "demo", POLICY_DAILY_ORDER_LIMIT: "3", POLICY_DAILY_NOTIONAL_LIMIT: "500", POLICY_MAX_POSITION_WEIGHT: "0.25", POLICY_BLOCKED_TICKERS: "TSLA_US_EQ" }).policy.demo;
  const checks = evaluatePolicy(policy, {
    draft: { environment: "demo", ticker: "TSLA_US_EQ", side: "buy", type: "market", quantity: 1, referencePrice: 200 },
    instrument: { ticker: "TSLA_US_EQ", name: "Tesla", shortName: "TSLA", currencyCode: "EUR", type: "STOCK" },
    account: { currency: "EUR", totalValue: 1000 },
    estimatedNotional: 400,
    usage: { orders: 1, notional: 200 },
  });

  it("speaks the widget's language for every rule", () => {
    const zh = createTranslator("zh-CN");
    const text = checks.map((check) => policyMessage(check, zh, "zh-CN"));
    expect(text).toContain("TSLA_US_EQ 在禁止交易的清单中。");
    expect(text).toContain("TSLA_US_EQ 下单后将占账户 40.0%，超过 25.0% 的上限。");
    expect(text).toContain("今天第 2 笔，上限 3 笔。");
    expect(text.find((line) => line.startsWith("今日成交额"))).toMatch(/600.*500/);
    expect(text.join(" ")).not.toMatch(/[A-Za-z]{4,} (is|would|of)\b/);
  });

  it("keeps the server's English wording", () => {
    const en = createTranslator("en");
    for (const check of checks.filter((item) => item.rule !== "daily_notional_limit")) expect(policyMessage(check, en, "en")).toBe(check.message);
    expect(policyMessage({ rule: "daily_order_limit", status: "pass", message: "Server text." }, en, "en")).toBe("Server text.");
  });
});

describe("rebalance notes", () => {
  it("translates every note and skip reason the planner writes", async () => {
    const { planRebalance } = await import("../../core/rebalance");
    const position = (ticker: string, currencyCode: string, quantity: number, price: number, value: number) => ({
      instrument: { ticker, name: ticker, shortName: ticker, currencyCode }, quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: price, currentPrice: price, walletImpact: { currentValue: value },
    });
    const plan = planRebalance(
      "demo",
      { currency: "EUR", totalValue: 3000, cash: { availableToTrade: 100 } },
      [position("AAPL_US_EQ", "USD", 5, 216, 1000), position("KO_US_EQ", "USD", 10, 60, 550), position("SAPd_EQ", "EUR", 5, 200, 1000)],
      [{ ticker: "AAPL_US_EQ", weight: 0.5 }, { ticker: "SAPd_EQ", weight: 0.4 }, { ticker: "7203_JP_EQ", weight: 0.05 }],
    );
    const zh = createTranslator("zh-CN");
    const notes = (plan.noteDetails ?? []).map((note) => rebalanceNoteText(note, zh, "zh-CN"));
    expect(notes).toEqual(expect.arrayContaining(["1 个没有设目标的持仓保持不变。", "USD 的汇率取自券商对你持仓的估值。"]));
    expect(notes.find((note) => note.includes("缩减"))).toMatch(/€.*\d+%/);
    expect(notes.every((note) => !/[a-z]{5,}/.test(note))).toBe(true);
    expect(plan.skipped.map((item) => rebalanceSkipText(item, zh))).toEqual(["没有价格：未持有，报价源也取不到。"]);
  });
});
