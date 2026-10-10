import type { Environment, MonitorEvent, PortfolioAnalysis, PortfolioSnapshot, Source } from "./types.js";

export interface LocalizedMessage {
  zh: string;
  en: string;
}
export type AttentionRoute = "overview" | "risk" | "brief";
export interface AttentionItem {
  id: string;
  kind: "valuation_gap" | "concentration" | "cash_low" | "cash_high" | "monitor_event" | "sample";
  priority: "review" | "information";
  title: LocalizedMessage;
  detail: LocalizedMessage;
  asOf: string;
  provenance: "calculated" | "saved_monitor_event" | "source_disclosure";
  route: AttentionRoute;
}
export interface AttentionCenter {
  kind: "attention_center";
  environment: Environment;
  source: Source;
  asOf: string;
  generatedAt: string;
  currency: string;
  portfolioValue: number;
  positionCount: number;
  cashPercent: number | null;
  valuationCoveragePercent: number | null;
  reviewCount: number;
  items: AttentionItem[];
  limitations: LocalizedMessage[];
  brokerWrites: 0;
}
function formatPercent(value: number): string { return `${value.toFixed(2)}%`; }
/**
 * Small, deterministic read-only attention feed.
 *
 * A current broker snapshot is distinct from an independently verified quote.
 * Recorded watch events are historical, not evidence that a threshold remains
 * crossed today. Nothing in this feed is a trade signal or order instruction.
 */
export function buildAttentionCenter(
  snapshot: PortfolioSnapshot,
  analysis: PortfolioAnalysis,
  savedEvents: MonitorEvent[],
  now = new Date(),
): AttentionCenter {
  if (snapshot.environment !== analysis.environment || snapshot.source !== analysis.source)
    throw new Error("Cannot combine portfolio and risk observations from different sources");
  const items: AttentionItem[] = [];
  const add = (item: AttentionItem) => { items.push(item); };
  if (snapshot.source === "sample") add({
    id: "source:sample", kind: "sample", priority: "information", route: "overview",
    provenance: "source_disclosure", asOf: snapshot.asOf,
    title: { zh: "当前是演示账户数据", en: "Synthetic demonstration data" },
    detail: {
      zh: "以下余额与风险信号均基于合成样例，不代表真实 Trading 212 账户。",
      en: "All balances and risk signals below are synthetic; none represent your real Trading 212 account.",
    },
  });
  const coverage = analysis.exposureCoveragePercent;
  if (analysis.largestPositionPercent === null && snapshot.holdings.length > 0) add({
    id: "quality:valuation", kind: "valuation_gap", priority: "review", route: "risk",
    provenance: "calculated", asOf: snapshot.asOf,
    title: { zh: "部分持仓估值无法核实", en: "Portfolio valuation needs verification" },
    detail: {
      zh: `仓位集中度不能可靠计算，已核实估值覆盖率：${coverage === null ? "未知" : formatPercent(coverage)}。请核对币种与缺失价格。`,
      en: `Portfolio concentration is unavailable; verified valuation coverage: ${coverage === null ? "unknown" : formatPercent(coverage)}. Review missing prices and currencies.`,
    },
  });
  if (analysis.largestPositionPercent !== null && analysis.largestPositionPercent >= 35) add({
    id: "risk:concentration", kind: "concentration", priority: "review", route: "risk",
    provenance: "calculated", asOf: snapshot.asOf,
    title: { zh: "持仓集中度需要关注", en: "High position concentration" },
    detail: {
      zh: `最大持仓占账户总值 ${formatPercent(analysis.largestPositionPercent)}，超过预设的 35% 观察线，不代表需要交易。`,
      en: `Largest holding is ${formatPercent(analysis.largestPositionPercent)} of account value, exceeding a predefined 35% observation threshold; not a trade recommendation.`,
    },
  });
  if (analysis.cashPercent !== null && (analysis.cashPercent < 5 || analysis.cashPercent > 50)) {
    const low = analysis.cashPercent < 5;
    add({
      id: low ? "risk:cash_low" : "risk:cash_high",
      kind: low ? "cash_low" : "cash_high", priority: "review", route: "risk",
      provenance: "calculated", asOf: snapshot.asOf,
      title: low
        ? { zh: "现金比例偏低", en: "Low available cash ratio" }
        : { zh: "现金比例较高", en: "High available cash ratio" },
      detail: {
        zh: `可用现金占账户总值 ${formatPercent(analysis.cashPercent)}；此项仅为固定阈值观察，不对买卖作出建议。`,
        en: `Available cash is ${formatPercent(analysis.cashPercent)} of account value. This is a fixed-threshold observation, not a buy/sell signal.`,
      },
    });
  }
  const newestEvents = savedEvents.filter(x =>
    x.environment === snapshot.environment && x.source === snapshot.source &&
    x.status === "triggered" &&
    Number.isFinite(Date.parse(x.observedAt)) &&
    Date.parse(x.observedAt) <= now.getTime() &&
    Date.parse(x.observedAt) >= now.getTime() - 7 * 86400_000
  ).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 2);
  for (const event of newestEvents) add({
    id: `event:${event.id}`, kind: "monitor_event", priority: "information",
    provenance: "saved_monitor_event", asOf: event.observedAt, route: "brief",
    title: { zh: "历史监控事件", en: "Past monitoring threshold event" },
    detail: {
      zh: `在 ${event.observedAt} 记录过阈值触发；这不代表现在仍在触发。请查看最新持仓数据。`,
      en: `A saved threshold was triggered at ${event.observedAt}. The event is historical and may not be active now.`,
    },
  });
  const priorityWeight = (item: AttentionItem) =>
    item.priority === "review" ? (item.kind === "valuation_gap" ? 100 : 70) : 10;
  items.sort((a, b) => priorityWeight(b) - priorityWeight(a));
  return {
    kind: "attention_center", environment: snapshot.environment, source: snapshot.source,
    asOf: snapshot.asOf, generatedAt: now.toISOString(),
    currency: snapshot.account.currency, portfolioValue: snapshot.account.totalValue,
    positionCount: snapshot.holdings.length, cashPercent: analysis.cashPercent,
    valuationCoveragePercent: analysis.exposureCoveragePercent,
    reviewCount: items.filter(x => x.priority === "review").length,
    items: items.slice(0, 5), brokerWrites: 0,
    limitations: [
      {
        zh: "不含实时市场新闻、实时独立行情或自动交易判断。账户读取时间不等于股票报价时间。",
        en: "Excludes live news, independently verified real-time quotes and automated trade decisions. Account read time is not quote time.",
      },
      ...(snapshot.source === "sample" ? [{
        zh: "演示模式：全部数据均为合成样例。",
        en: "Sample mode: all values are synthetic.",
      }] : []),
    ],
  };
}
