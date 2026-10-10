import { analyzePortfolio, evaluateRule, stressPortfolio } from "../domain/analytics.js";
import { samplePortfolio } from "../domain/sample.js";
import type { Environment, MonitorEvent, PortfolioSnapshot, RiskPulse, RiskTrend, RuleEvaluation, RuleKind, WatchRule } from "../domain/types.js";
import type { BrokerReader } from "../infra/broker.js";
import type { Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";

export class IntelligenceService {
  constructor(
    readonly config: Configuration,
    private readonly state: StateStore,
    private readonly broker: BrokerReader,
  ) {}
  async portfolio(environment: Environment): Promise<PortfolioSnapshot> {
    const cacheKey = `v3:snapshot:${environment}`;
    const cached = await this.state.get<PortfolioSnapshot>(cacheKey);
    if (cached) return cached;
    const snapshot = this.config.source === "sample"
      ? samplePortfolio(environment)
      : await this.broker.getPortfolio(environment);
    // Maximum 30s local cache avoids fetching account summary faster than 1 / 5 s.
    await this.state.put(cacheKey, snapshot, Date.now() + 30_000);
    return snapshot;
  }
  async analysis(environment: Environment) {
    return analyzePortfolio(await this.portfolio(environment));
  }
  async stress(environment: Environment, shockPercent: number) {
    return stressPortfolio(await this.portfolio(environment), shockPercent);
  }
  async dailyBrief(environment: Environment) {
    const snapshot = await this.portfolio(environment), analysis = analyzePortfolio(snapshot);
    return {
      kind: "daily_brief", environment, source: snapshot.source, asOf: snapshot.asOf,
      currency: snapshot.account.currency,
      summary: `Portfolio total ${snapshot.account.totalValue} ${snapshot.account.currency}; ${snapshot.holdings.length} positions. This research brief never performs broker writes.`,
      observations: [
        ...(analysis.alerts.length ? analysis.alerts : [
          analysis.largestPositionPercent === null
            ? "Concentration could not be evaluated reliably; do not infer absence of concentration risk."
            : "No predefined concentration or cash threshold triggered.",
        ]),
        ...analysis.limitations,
      ],
      priorityChecks: [
        "Review any stale or missing valuation and FX evidence before interpreting concentration.",
        "Review current broker positions, pending orders and cash directly for material changes.",
        "External news and catalysts require separately cited and date-stamped research.",
      ],
      disclaimer: "This evidence brief is descriptive, not a personalized trade recommendation.",
    };
  }
  async recentOrders(environment: Environment, cursor?: string) {
    if (this.config.source === "sample") return {
      kind: "history", environment, source: "sample" as const, asOf: new Date().toISOString(),
      orders: [], nextCursor: null, note: "Synthetic sample mode: no broker history is available.",
    };
    const history = await this.broker.getRecentOrders(environment, cursor);
    return {
      kind: "history", environment, source: "trading212" as const, asOf: new Date().toISOString(),
      orders: history.items.slice(0, 20).map((raw) => {
        const row = raw as Record<string, unknown>;
        // An intentionally narrow whitelist excludes account IDs and raw brokerage payloads.
        return { id: String(row.id ?? ""), ticker: String(row.ticker ?? ""),
          type: String(row.type ?? ""), status: String(row.status ?? ""),
          quantity: typeof row.quantity === "number" ? row.quantity : null,
          createdAt: typeof row.createdAt === "string" ? row.createdAt : null };
      }),
      nextCursor: history.nextCursor,
    };
  }
  async listRules(environment: Environment): Promise<WatchRule[]> {
    const all = await this.state.list<WatchRule>("v3:rule:");
    return all.map(v=>v.value).filter(rule=>rule.environment===environment).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  async createRule(environment: Environment, kind: RuleKind, thresholdPercent: number): Promise<WatchRule> {
    if (!Number.isFinite(thresholdPercent) || thresholdPercent < -100 || thresholdPercent > 100 ||
        (kind !== "unrealized_loss_below" && thresholdPercent < 0) ||
        (kind === "unrealized_loss_below" && thresholdPercent > 0))
      throw new Error("Invalid threshold for watch-rule kind");
    const existing=await this.state.list<WatchRule>("v3:rule:");
    if (existing.length>=30) throw new Error("A maximum of 30 local watch rules is allowed");
    const rule: WatchRule={
      id:crypto.randomUUID(),environment,kind,thresholdPercent,createdAt:new Date().toISOString(),
    };
    await this.state.put(`v3:rule:${rule.id}`,rule);
    return rule;
  }
  async deleteRule(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid rule ID");
    const rule=await this.state.take<WatchRule>(`v3:rule:${id}`);
    if (rule) await this.state.remove(`v3:rule-status:${rule.id}`);
    return Boolean(rule);
  }
  async inspectRules(environment: Environment): Promise<RuleEvaluation[]> {
    const [rules,snapshot]=await Promise.all([this.listRules(environment),this.portfolio(environment)]);
    const analysis=analyzePortfolio(snapshot);
    return rules.map(rule=>evaluateRule(rule,snapshot,analysis));
  }
  /** Called by opt-in scheduled/manual monitoring. May write local events only. */
  async scan(environment: Environment) {
    const [rules,snapshot]=await Promise.all([this.listRules(environment),this.portfolio(environment)]);
    const analysis=analyzePortfolio(snapshot);
    const evaluated=rules.map(rule=>evaluateRule(rule,snapshot,analysis));
    const pulse:RiskPulse={
      kind:"risk_pulse",environment,source:snapshot.source,asOf:snapshot.asOf,
      accountCurrency:snapshot.account.currency,totalValue:snapshot.account.totalValue,
      cashPercent:analysis.cashPercent,largestPositionPercent:analysis.largestPositionPercent,
      exposureCoveragePercent:analysis.exposureCoveragePercent,
    };
    await this.state.put(`v3:pulse:${environment}:${new Date().toISOString().slice(0,10)}`,
      pulse,Date.now()+90*86400_000);
    let created=0;
    for(const result of evaluated){
      const statusKey=`v3:rule-status:${result.rule.id}`;
      const previous=await this.state.get<string>(statusKey);
      if(previous!==result.status){
        await this.state.put(statusKey,result.status);
        if(result.status==="triggered"){
          const event:MonitorEvent={
            id:crypto.randomUUID(),ruleId:result.rule.id,environment,observedAt:new Date().toISOString(),
            status:result.status,observedPercent:result.observedPercent,
            thresholdPercent:result.rule.thresholdPercent,detail:result.explanation,
          };
          await this.state.put(`v3:event:${event.observedAt}:${event.id}`,event,Date.now()+30*86400_000);
          created++;
        }
      }
    }
    return {kind:"scan",environment,source:this.config.source,evaluated,created,brokerWrites:0};
  }
  async trend(environment:Environment):Promise<RiskTrend>{
    const entries=await this.state.list<RiskPulse>(`v3:pulse:${environment}:`);
    const points=entries.map(entry=>entry.value).filter(x=>x.source===this.config.source)
      .sort((a,b)=>a.asOf.localeCompare(b.asOf)).slice(-90);
    const first=points[0],last=points[points.length-1];
    const comparable=first&&last&&first!==last&&first.accountCurrency===last.accountCurrency;
    return {
      kind:"risk_trend",environment,source:this.config.source,points,
      absoluteValueChange:comparable?Math.round((last.totalValue-first.totalValue)*100)/100:null,
      notes:[
        "Portfolio value changes include deposits, withdrawals, currency moves and holdings changes; they are NOT investment returns.",
        "Concentration and coverage can be unavailable when trusted account-currency values are missing.",
        ...(this.config.source==="sample"?["SYNTHETIC DATA — these are not real observed portfolio trends."]:[]),
        ...(points.length<2?["At least two separate daily monitoring scans are needed for a change comparison."]:[]),
      ],
    };
  }
  async events(environment:Environment){
    const list=await this.state.list<MonitorEvent>("v3:event:");
    return {kind:"events",environment,source:this.config.source,
      events:list.map(x=>x.value).filter(x=>x.environment===environment)
        .sort((a,b)=>b.observedAt.localeCompare(a.observedAt)).slice(0,50)};
  }
}
