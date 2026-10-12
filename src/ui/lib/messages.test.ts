import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../core/policy";
import { createConfig } from "../../core/config";
import { createTranslator } from "../i18n";
import type { BasketExecutionResult } from "../../shared/automation";
import type { PieChangePreview } from "../../shared/pies";
import { money, pct } from "./format";
import {
  activityLabel,
  activityNeedsAttention,
  basketNoteText,
  basketResultText,
  basketTitle,
  countText,
  envLabel,
  formatProblem,
  instrumentTypeLabel,
  legReason,
  purposeLabel,
  legSkipText,
  noticeText,
  orderStatusLabel,
  pieNoticeText,
  policyMessage,
  quoteProviderLabel,
  rebalanceNoteText,
  rebalanceSkipText,
  tradeEstimateText,
  validityLabel,
  sizingText,
} from "./messages";

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
    // Apple and Coca-Cola are in dollars: the fee is on those trades only.
    expect(notes.find((note) => note.includes("汇兑费"))).toMatch(/^这些交易中有 €[\d,.]+ 涉及其他货币，按 0\.15% 的汇兑费计约 €[\d,.]+；/);
    expect(notes.every((note) => !/[a-z]{5,}/.test(note))).toBe(true);
    expect(plan.skipped.map((item) => rebalanceSkipText(item, zh))).toEqual(["没有价格：未持有，报价源也取不到。"]);
  });

  it("says what a band leaves as it is, and names the basket it plans", async () => {
    const { planRebalance } = await import("../../core/rebalance");
    const held = (ticker: string, quantity: number, price: number) => ({
      instrument: { ticker, name: ticker, shortName: ticker, currencyCode: "EUR" }, quantity, quantityAvailableForTrading: quantity, quantityInPies: 0, averagePricePaid: price, currentPrice: price,
    });
    const account = { currency: "EUR", totalValue: 10_000, cash: { availableToTrade: 2000 } };
    const positions = [held("EQ", 60, 100), held("BOND", 40, 50)];
    const targets = [{ ticker: "EQ", weight: 0.52 }, { ticker: "BOND", weight: 0.18 }];
    const en = createTranslator("en");
    const zh = createTranslator("zh-CN");
    const band = (plan: ReturnType<typeof planRebalance>) => plan.noteDetails!.find((note) => note.code === "within_band")!;
    const some = planRebalance("demo", account, positions, targets, { cashWeight: 0.3, band: 0.05 });
    expect(rebalanceNoteText(band(some), en, "en")).toBe("Only the targets more than 5.0 points off their weight are traded; 1 of 2 is left as it is.");
    expect(rebalanceNoteText(band(some), zh, "zh-CN")).toBe("只调整偏离目标超过 5.0 个百分点的；2 个目标中有 1 个保持不变。");
    expect(rebalanceNoteText({ code: "within_band", message: "x", details: { count: 2, total: 3, band: 0.025 } }, en, "en")).toBe("Only the targets more than 2.5 points off their weight are traded; 2 of 3 are left as they are.");
    const none = planRebalance("demo", account, positions, targets, { cashWeight: 0.3, band: 0.1 });
    expect(rebalanceNoteText(band(none), zh, "zh-CN")).toBe("每个目标的偏离都在 10.0 个百分点以内，无需交易。");
    expect(basketTitle({ purpose: "rebalance", title: "Rebalance what drifted", legs: [] }, zh)).toBe("只调偏离过大的");
  });

  it("estimates a rebalance of only the targets over the threshold, naming them", () => {
    const en = createTranslator("en");
    const zh = createTranslator("zh-CN");
    const totals = { currency: "EUR", bought: 0, sold: 1200, converted: 1200, fxFee: 1.8, fxFeeRate: 0.0015 };
    const vars = { points: "5.0", list: "Apple" };
    expect(tradeEstimateText(totals, "over", en, "en", vars)).toBe("Rebalancing only those more than 5.0 points off (Apple) would sell about €1,200.00. €1,200.00 of it is in other currencies: about €1.80 in FX fees at 0.15%, none on a trade paid from or into a balance in that currency.");
    expect(tradeEstimateText({ ...totals, sold: 0, converted: 0, fxFee: 0, buysScaled: 0 }, "over", zh, "zh-CN", { ...vars, list: "苹果、可口可乐" }))
      .toBe("只调偏离超过 5.0 个百分点的（苹果、可口可乐）买不了任何标的：目标现金之外没有可用现金，它们之中也没有可卖出的来筹钱。");
  });
});

describe("structured server codes", () => {
  const en = createTranslator("en");
  const zh = createTranslator("zh-CN");

  it("explains a price far from the last price, with the pence hint for GBX", () => {
    const usd = { code: "PRICE_OUT_OF_RANGE" as const, message: "Server text.", details: { field: "limitPrice", price: 2150, last: 215, currency: "USD" } };
    expect(formatProblem(usd, en, "en")).toBe("Limit price $2,150.00 is 10 times or more away from the last price $215.00. Check the unit.");
    const gbx = { code: "PRICE_OUT_OF_RANGE" as const, message: "Server text.", details: { field: "stopPrice", price: 7.5, last: 750, currency: "GBX" } };
    expect(formatProblem(gbx, zh, "zh-CN")).toContain("便士");
    expect(formatProblem(gbx, zh, "zh-CN")).toContain(zh("stopPrice"));
    expect(formatProblem({ code: "PRICE_OUT_OF_RANGE", message: "Server text." }, en, "en")).toBe("Server text.");
  });

  it("says a busy execution leaves the confirmation valid", () => {
    expect(formatProblem({ code: "EXECUTION_BUSY", message: "busy" }, zh, "zh-CN")).toBe("这个账户还有一笔订单正在发送。请稍后再试，本次确认仍然有效。");
  });

  it("says a risk-sized buy was not sent because the price moved after its review", () => {
    expect(formatProblem({ code: "RISK_CHANGED", message: "x", details: { loss: 56.25, budget: 30, accountCurrency: "EUR", currency: "USD", stopLossPrice: 200 } }, en, "en"))
      .toBe("The price moved after the review: at the stop-loss this order would now lose about €56.25, more than the review showed. Nothing was sent; review the order again.");
    expect(formatProblem({ code: "RISK_CHANGED", message: "x", details: { stopLossPrice: 200, price: 190, currency: "USD" } }, zh, "zh-CN"))
      .toBe("复核之后价格变了，已在止损价 US$200.00 或以下。订单没有发出，请重新复核。");
    expect(formatProblem({ code: "RISK_CHECK_UNAVAILABLE", message: "x", details: { missing: "fx_rate", from: "EUR", to: "CHF" } }, en, "en"))
      .toBe("The quote source has no EUR to CHF exchange rate just now, so the loss at the stop-loss can't be checked. Nothing was sent; try again in a moment.");
    expect(formatProblem({ code: "RISK_CHECK_UNAVAILABLE", message: "x", details: { missing: "quote", ticker: "MSFT_US_EQ" } }, zh, "zh-CN"))
      .toBe("行情源暂时没有这只标的的价格，无法核对到止损价的亏损。订单没有发出，请稍后再试。");
    expect(formatProblem({ code: "RISK_CHECK_UNAVAILABLE", message: "x", details: { missing: "account_currency" } }, en, "en")).toMatch(/^Trading 212 did not give the account currency just now/);
    expect(formatProblem({ code: "RISK_CHECK_UNAVAILABLE", message: "x", details: { missing: "price", ticker: "MSFT_US_EQ" } }, zh, "zh-CN")).toMatch(/请填写参考价。$/);
  });

  it("words the new order notices from their values", () => {
    expect(noticeText({ code: "STOP_ALREADY_TRIGGERED", message: "x", details: { stopPrice: 200, last: 190, currency: "USD" } }, en, "en"))
      .toBe("The stop price $200.00 has already been reached (last price $190.00), so the order triggers as soon as it is placed.");
    expect(noticeText({ code: "LIMIT_FILLS_AT_ONCE", message: "x", details: { limitPrice: 220, last: 215, currency: "USD" } }, zh, "zh-CN")).toBe("最新价为 US$215.00，限价 US$220.00 可能会立即以接近市价的价格成交。");
    expect(noticeText({ code: "PRICE_FAR_FROM_LAST", message: "x", details: { percent: -18, last: 100, currency: "EUR" } }, en, "en")).toBe("The order price is 18% below the last price €100.00.");
    expect(noticeText({ code: "PRICE_FAR_FROM_LAST", message: "x", details: { percent: 25, last: 100, currency: "EUR" } }, zh, "zh-CN")).toBe("订单价格比最新价 €100.00 高 25%。");
    expect(noticeText({ code: "MARKET_HOURS_UNKNOWN", message: "x", details: { reason: "no_schedule" } }, zh, "zh-CN")).toContain("没有提供该标的的交易时段");
    expect(noticeText({ code: "MARKET_HOURS_UNKNOWN", message: "Server text." }, en, "en")).toBe("Server text.");
    expect(noticeText({ code: "STOP_SLIPPAGE", message: "x", details: { side: "sell", riskSized: false } }, en, "en")).toBe("A Stop order becomes a Market order once it triggers, so after a gap it can fill below its trigger price.");
    expect(noticeText({ code: "STOP_SLIPPAGE", message: "x", details: { side: "buy", riskSized: true } }, zh, "zh-CN")).toBe("止损单触发后按市价成交，价格跳空时可能高于触发价成交。到止损价的亏损按触发价、参考价和最新价中最高的一个计算，成交价更高时亏得更多。");
  });

  it("names statuses, types, providers and environments instead of showing codes", () => {
    expect(orderStatusLabel("NEW", en)).toBe("Open");
    expect(orderStatusLabel("NEW", zh)).toBe("挂单中");
    expect(instrumentTypeLabel("STOCK", zh)).not.toBe("STOCK");
    expect(instrumentTypeLabel("ETF", en)).toBe("ETFs");
    expect(quoteProviderLabel("none", en)).toBe("Not set up");
    expect(validityLabel("GOOD_TILL_CANCEL", en)).toBe("Good till cancelled");
    expect(envLabel("live", zh)).toBe("实盘");
    expect(envLabel("demo", zh)).toBe("模拟盘");
  });

  it("flags protective orders that need attention", () => {
    const event = { id: "1", timestamp: "2026-10-01T10:00:00Z", environment: "demo" as const, type: "protective_attention" as const, ticker: "VUSAl_EQ" };
    expect(activityLabel(event, zh)).toBe("保护单需要你处理");
    expect(activityNeedsAttention(event)).toBe(true);
  });
});

describe("counts and signs", () => {
  it("uses plural rules for counts", () => {
    const en = createTranslator("en");
    expect(countText("candidates", 1, en, "en")).toBe("1 candidate");
    expect(countText("candidates", 3, en, "en")).toBe("3 candidates");
    expect(countText("candidates", 3, createTranslator("zh-CN"), "zh-CN")).toBe("3 个候选");
  });

  it("signs changes but never balances or zero", () => {
    expect(money(12.5, "USD", "en", { signed: true })).toBe("+$12.50");
    expect(money(-12.5, "USD", "en", { signed: true })).toBe("-$12.50");
    expect(money(0, "USD", "en", { signed: true })).toBe("$0.00");
    expect(money(12.5, "USD", "en")).toBe("$12.50");
    expect(pct(0.034, "en", 1, { signed: true })).toBe("+3.4%");
  });
});

describe("server-written basket text", () => {
  const zh = createTranslator("zh-CN");
  const vusa = { ticker: "VUSAl_EQ", name: "Vanguard S&P 500 UCITS ETF", shortName: "VUSA", currencyCode: "GBP", type: "ETF" };
  const protective = {
    purpose: "protective" as const,
    title: "Protect VUSA",
    legs: [
      { draft: { environment: "demo" as const, ticker: "VUSAl_EQ", side: "sell" as const, type: "stop" as const, quantity: 4, stopPrice: 80 }, instrument: vusa },
      { draft: { environment: "demo" as const, ticker: "VUSAl_EQ", side: "sell" as const, type: "limit" as const, quantity: 4, limitPrice: 110 }, instrument: vusa },
    ],
  };

  it("rebuilds titles, reasons and notes from the basket's structure", () => {
    expect(basketTitle(protective, zh)).toBe("为 Vanguard S&P 500 UCITS ETF 设置止损止盈");
    expect(basketTitle({ purpose: "rebalance", title: "Rebalance", legs: [] }, zh)).toBe("按目标权重再平衡");
    expect(basketTitle({ purpose: "custom", title: "My tech trim", legs: [] }, zh)).toBe("My tech trim");
    expect(legReason(protective.legs[0]!, protective, zh)).toBe(zh("stopLoss"));
    expect(basketNoteText("Both orders stay at Trading 212 until they fill or you cancel them.", protective, zh, "zh-CN")).toBe("两张订单会一直留在 Trading 212，直到成交或你撤单。");
    expect(basketNoteText("An unknown note.", protective, zh, "zh-CN")).toBe("An unknown note.");
    const dca = { purpose: "dca" as const, title: "Monthly", legs: [] };
    const sized = basketNoteText("Sized from each holding's last broker price, or an external quote for legs not held yet; 100 EUR VUSAl_EQ, 50 EUR AAPL_US_EQ.", dca, zh, "zh-CN", { VUSAl_EQ: { name: "Vanguard S&P 500 UCITS ETF" } });
    expect(sized).toBe("按各持仓的券商最新价计算数量，尚未持有的使用外部报价：€100.00 Vanguard S&P 500 UCITS ETF、€50.00 AAPL。");
  });

  it("translates the stop basket the server drafts for unprotected holdings", () => {
    // The exact sentences src/core/trading-service.ts writes; automation.test.ts pins the same text.
    const stops = { purpose: "protective" as const, title: "Stop-losses for unprotected holdings", legs: [protective.legs[0]!] };
    expect(basketTitle(stops, zh)).toBe("为未保护的持仓设置止损");
    expect(purposeLabel(stops.purpose, zh, stops.legs)).toBe(zh("stopLoss"));
    expect(purposeLabel(protective.purpose, zh, protective.legs)).toBe(zh("basketPurposeProtective"));
    expect(legReason({ ...stops.legs[0]!, reason: "Matches the existing stop" }, stops, zh)).toBe("与现有止损同价");
    expect(legReason({ ...stops.legs[0]!, reason: "8% below the last price" }, stops, zh)).toBe("比现价低 8%");
    expect(basketNoteText("Each order stays at Trading 212 until it triggers or you cancel it.", stops, zh, "zh-CN")).toBe(zh("stopsNoteStays"));
    expect(basketNoteText("A holding that already has a stop gets one at the same price for its uncovered shares; the others start 8% below the last price.", stops, zh, "zh-CN"))
      .toBe("已有止损的持仓，未覆盖的部分沿用同一止损价；其余持仓的止损价设在现价下方 8%。");
    expect(basketNoteText("3 more holding(s) without a full stop were left out; a basket holds at most 20 orders.", stops, zh, "zh-CN"))
      .toBe("另有 3 只没有完整止损的持仓未列入，一个篮子最多 20 张订单。");
  });

  it("counts a basket result from its legs", () => {
    const result = {
      kind: "basket_execution", environment: "demo", purpose: "protective", ok: false, status: "partial", message: "1 of 2 orders submitted.",
      legs: [
        { draft: protective.legs[0]!.draft, result: { ok: true, status: "submitted", environment: "demo", message: "ok" } },
        { draft: protective.legs[1]!.draft, skipped: "Not sent: an earlier order's result is uncertain. Verify it before sending the rest." },
      ],
    } as unknown as BasketExecutionResult;
    expect(basketResultText(result, createTranslator("en"), "en")).toMatch(/^1 of 2/);
    expect(legSkipText(result.legs[1]!.skipped!, zh)).toBe(zh("legStopUncertain"));
  });

  it("names removed pie slices from the preview", () => {
    const preview = {
      kind: "pie_change_preview", token: "t", expiresAt: "2026-10-01T10:00:00Z", environment: "demo", action: "update",
      current: { id: 1, name: "Core", currency: "EUR", value: 1000, instruments: [{ ticker: "AAPL_US_EQ", targetShare: 0.5, currentShare: 0.5, driftShare: 0, ownedQuantity: 2, issues: [] }] },
      changes: [{ ticker: "AAPL_US_EQ", from: 0.5, to: 0 }],
      notices: [],
    } as unknown as PieChangePreview;
    expect(pieNoticeText("Removing AAPL_US_EQ takes it out of the pie.", preview, zh, "zh-CN", { AAPL_US_EQ: { name: "Apple" } })).toContain("移除 Apple");
  });
});

describe("risk sizing", () => {
  it("names the budget and the stop", () => {
    const apple = { ticker: "AAPL_US_EQ", name: "Apple", shortName: "AAPL", currencyCode: "USD" };
    expect(sizingText({ mode: "risk", percent: 1, stopLossPrice: 200 }, apple, "en", createTranslator("en"), "EUR")).toBe("Risk at the stop · 1% of account value · stop $200.00");
    expect(sizingText({ mode: "risk", amount: 30, stopLossPrice: 200 }, apple, "zh-CN", createTranslator("zh-CN"), "EUR")).toBe("止损风险 · €30.00 · 止损 US$200.00");
  });
});
