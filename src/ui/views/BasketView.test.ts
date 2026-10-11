import { describe, expect, it } from "vitest";
import type { BasketLeg } from "../../shared/automation";
import { withDraftReasons } from "./BasketView";

const leg = (ticker: string, side: "buy" | "sell", reason?: string): BasketLeg => ({
  draft: { environment: "demo", ticker, side, type: "stop", quantity: 1, stopPrice: 10 },
  ...(reason ? { reason } : {}),
});

describe("basket confirmation", () => {
  it("keeps each draft leg's reason after the review reorders the legs", () => {
    const drafts = [leg("AAPL_US_EQ", "sell", "Matches the existing stop"), leg("KO_US_EQ", "sell", "8% below the last price")];
    const reviewed = withDraftReasons([leg("KO_US_EQ", "sell"), leg("AAPL_US_EQ", "sell"), leg("MSFT_US_EQ", "sell")], drafts);
    expect(reviewed.map((item) => item.reason)).toEqual(["8% below the last price", "Matches the existing stop", undefined]);
    // A reason the review itself gives stays.
    expect(withDraftReasons([leg("KO_US_EQ", "sell", "own")], drafts)[0]!.reason).toBe("own");
  });
});
