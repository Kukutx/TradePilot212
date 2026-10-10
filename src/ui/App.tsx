import { useApp,useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as HostApp } from "@modelcontextprotocol/ext-apps";
import { useEffect,useMemo,useState } from "react";
import type { PortfolioAnalysis,PortfolioSnapshot,Scenario,Environment,Exposure,RiskTrend } from "../domain/types";
import PersonalTradeWorkspace,{type PersonalPayload} from "./PersonalTradeWorkspace";
import type {AttentionCenter} from "../domain/attention";

type Brief={kind:"daily_brief";environment:Environment;source:string;asOf:string;summary:string;observations:string[];priorityChecks:string[];disclaimer:string;currency:string};
type Payload=PortfolioSnapshot|PortfolioAnalysis|Scenario|RiskTrend|AttentionCenter|Brief|{kind:"error";message:string};
type Locale="zh"|"en";
const wording={
  en:{
    brand:"TRADEPILOT / PERSONAL",today:"Today",overview:"Overview",risk:"Risk map",stress:"Stress test",trend:"Risk trend",brief:"Daily brief",trade:"Private trades",
    more:"More analysis",openToday:"Check my portfolio",reviewCount:"Items to review",noAlerts:"No predefined numeric threshold crossed. This does not rule out investment risk.",historical:"Past record",computed:"Calculated from account",next:"Explore",
    account:"Portfolio value",cash:"Available cash",positions:"Holdings",updated:"Observed",
    price:"Last price",avg:"Average paid",tradable:"Tradable",unrealized:"Unrealized P/L",realized:"Realized P/L",
    warning:"Data quality",holdings:"Current holdings",exposure:"Value / allocation",unpriced:"Unverified value",
    scenario:"Hypothetical uniform shock",scenarioHelp:"This is a calculation, not a forecast or trade recommendation.",
    run:"Run simulation",running:"Loading",ready:"Ready for your portfolio",readyHelp:"Ask your AI assistant for a portfolio overview, risk analysis or brief.",
    demo:"SYNTHETIC SAMPLE DATA",live:"Broker read-only data",noTrades:"Broker writes require explicit private setup, in-app confirmation and human approval",
    refresh:"Refresh",riskAlerts:"Risk observations",limitations:"Data limitations",watch:"Priority research checks",
    coverage:"Verified value coverage",concentration:"Largest holding",cashRatio:"Cash ratio",noData:"Not computable",
    totalChange:"Hypothetical portfolio change",outcome:"Hypothetical total value",assumptions:"Assumptions",
    connection:"MCP host connection",unknown:"An unexpected response was received",error:"Data unavailable",
  },
  zh:{
    brand:"TRADEPILOT / 个人交易智能平台",today:"今日重点",overview:"持仓概览",risk:"风险分析",stress:"压力测试",trend:"风险趋势",brief:"组合简报",trade:"私人交易",
    more:"更多分析",openToday:"查看我的投资组合",reviewCount:"待查看事项",noAlerts:"当前未触发预设数值阈值，但不代表投资没有风险。",historical:"历史记录",computed:"由账户数据计算",next:"深入查看",
    account:"投资组合总值",cash:"可用现金",positions:"持仓数量",updated:"数据时间",
    price:"当前价格",avg:"持仓均价",tradable:"可交易",unrealized:"未实现盈亏",realized:"已实现盈亏",
    warning:"数据质量",holdings:"当前持仓",exposure:"估值 / 占比",unpriced:"无法核实估值",
    scenario:"假设持仓价格同步变化",scenarioHelp:"仅做算术情景推演，不是价格预测或交易建议。",
    run:"计算情景",running:"加载中",ready:"等待组合数据",readyHelp:"请在 AI 对话中请求持仓概览、风险分析或投资组合简报。",
    demo:"合成示例数据，不是真实账户",live:"券商真实只读数据",noTrades:"交易仅在个人自托管授权后开放，必须人工核准，不允许 AI 自动执行",
    refresh:"刷新",riskAlerts:"风险观察",limitations:"数据限制",watch:"需要研究的问题",
    coverage:"已核实估值覆盖率",concentration:"最大持仓占比",cashRatio:"现金占比",noData:"无法可靠计算",
    totalChange:"假设组合变化金额",outcome:"假设组合总值",assumptions:"计算假设",
    connection:"MCP 宿主连接",unknown:"收到无法识别的数据",error:"数据不可用",
  },
} as const;
function fmt(value:number|null|undefined,currency:string,locale:Locale):string{
  if(value===null||value===undefined||!Number.isFinite(value))return "—";
  try{return new Intl.NumberFormat(locale==="zh"?"zh-CN":"en-US",{
    style:"currency",currency,maximumFractionDigits:2,
  }).format(value);}catch{return String(value);}
}
function number(value:number|null|undefined):string{return value===null||value===undefined?"—":`${value.toFixed(2)}%`;}
function SourceTag({source,locale}:{source:string;locale:Locale}){
  return <span className={`sourceTag ${source==="sample"?"sample":"broker"}`}>{source==="sample"?wording[locale].demo:wording[locale].live}</span>;
}
function Metric({label,value}:{label:string;value:string}){return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;}
function ExposureRow({item,currency,locale}:{item:Exposure;currency:string;locale:Locale}){
  const weight=item.weightPercent;
  return <div className="exposureRow">
    <div className="exposureTitle"><strong>{item.ticker}</strong><span>{item.name}</span></div>
    <div className="exposureValue"><strong>{fmt(item.value,currency,locale)}</strong><span>{weight===null?wording[locale].unpriced:number(weight)}</span></div>
    <div className="bar"><div style={{width:`${Math.min(Math.max(weight??0,0),100)}%`}}/></div>
  </div>;
}
export default function App(){
  const [payload,setPayload]=useState<Payload|null>(null);
  const [personalPayload,setPersonalPayload]=useState<PersonalPayload|null>(null);
  const [env,setEnv]=useState<Environment>("demo");
  const [mode,setMode]=useState<"today"|"overview"|"risk"|"stress"|"trend"|"brief"|"trade">("today");
  const [locale,setLocale]=useState<Locale>("zh");
  const [shock,setShock]=useState(-10);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [displayMode,setDisplayMode]=useState<"inline"|"fullscreen">("inline");
  const [canFullscreen,setCanFullscreen]=useState(false);
  const t=useMemo(()=>wording[locale],[locale]);
  const {app, error:appError}=useApp({
    appInfo:{name:"TradePilot 212 Personal",version:"3.0.0-alpha.2"},
    capabilities:{},
    onAppCreated:(created:HostApp)=>{
      created.ontoolresult=result=>{
        const candidate=result.structuredContent as unknown as (Payload|PersonalPayload|undefined);
        if(!candidate||typeof candidate.kind!=="string")return;
        if(["trade_draft","trade_preview","cancel_preview","trade_execution","trade_verification","trade_plan","pending_orders"].includes(candidate.kind)){
          setPersonalPayload(candidate as PersonalPayload);
          if("environment" in candidate)setEnv(candidate.environment);
          setMode("trade");
          return;
        }
        const next=candidate as Payload;
        setPayload(next);
        if("environment" in next)setEnv(next.environment);
        if(next.kind==="attention_center")setMode("today");
        if(next.kind==="portfolio")setMode("overview");
        if(next.kind==="analysis")setMode("risk");
        if(next.kind==="scenario")setMode("stress");
        if(next.kind==="risk_trend")setMode("trend");
        if(next.kind==="daily_brief")setMode("brief");
      };
      const syncHost=(context:ReturnType<HostApp["getHostContext"]>)=>{
        if(context?.locale)setLocale(context.locale.toLowerCase().startsWith("zh")?"zh":"en");
        setCanFullscreen(Boolean(context?.availableDisplayModes?.includes("fullscreen")));
        setDisplayMode(context?.displayMode==="fullscreen"?"fullscreen":"inline");
      };
      syncHost(created.getHostContext());
      created.onhostcontextchanged=syncHost;
    },
  });
  useHostStyles(app,app?.getHostContext());
  useEffect(()=>{if(appError)setError(appError.message);},[appError]);
  const currency=payload?.kind==="portfolio"?payload.account.currency:
    payload?.kind==="analysis"?payload.accountCurrency:
    payload?.kind==="daily_brief"?payload.currency:
    payload?.kind==="scenario"?payload.currency:
    payload?.kind==="risk_trend"?(payload.points.at(-1)?.accountCurrency||"USD"):
    payload?.kind==="attention_center"?payload.currency:"USD";
  const source=personalPayload&&"source" in personalPayload?personalPayload.source:(payload&&"source" in payload?payload.source:undefined);
  async function load(kind:"today"|"overview"|"risk"|"stress"|"trend"|"brief",environment=env){
    if(!app)return;
    const names={
      today:"get_personal_attention_center",overview:"get_portfolio_intelligence",risk:"analyze_portfolio_risk",
      stress:"simulate_portfolio_scenario",trend:"get_portfolio_risk_trend",brief:"get_portfolio_review_brief",
    };
    setLoading(true);setError(null);
    try{
      const result=await app.callServerTool({name:names[kind],arguments:{environment,...(kind==="stress"?{shockPercent:shock}:{})}});
      if(result.isError)throw new Error(result.content?.find(x=>x.type==="text")?.text||t.error);
      const next=result.structuredContent as unknown as Payload|undefined;
      if(!next||!["attention_center","portfolio","analysis","scenario","risk_trend","daily_brief"].includes(next.kind))throw new Error(t.unknown);
      setPayload(next);setMode(kind);setEnv(environment);
    }catch(e){setError(e instanceof Error?e.message:t.error);}finally{setLoading(false);}
  }
  function date(value?:string){return value?new Date(value).toLocaleString(locale==="zh"?"zh-CN":"en-US"):"—";}
  async function toggleFullscreen(){
    if(!app||!canFullscreen)return;
    try{
      const result=await app.requestDisplayMode({mode:displayMode==="fullscreen"?"inline":"fullscreen"});
      setDisplayMode(result.mode==="fullscreen"?"fullscreen":"inline");
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  }
  return <main className="shell">
    <header className="top">
      <div className="identity"><span className="mark">T<span>P</span></span><div><span className="eyebrow">{t.brand}</span><h1>TradePilot 212 Personal</h1></div></div>
      <div className="topActions">
        <select aria-label="Account environment" value={env} onChange={e=>{setEnv(e.target.value as Environment);setPayload(null);setPersonalPayload(null);}}><option value="demo">DEMO</option><option value="live">LIVE</option></select>
        <button type="button" onClick={()=>setLocale(locale==="zh"?"en":"zh")}>{locale==="zh"?"EN":"中文"}</button>
        {canFullscreen&&<button type="button" onClick={()=>void toggleFullscreen()}>
          {displayMode==="fullscreen"?(locale==="zh"?"返回内嵌":"Inline"):(locale==="zh"?"全屏":"Fullscreen")}
        </button>}
      </div>
    </header>
    <div className="trustBar">{source&&<SourceTag source={source} locale={locale}/>}<span>{t.noTrades}</span></div>
    <nav className="tabs" aria-label="Portfolio views">
      {(["today","overview","risk","trade"] as const).map(key=><button
        key={key} className={mode===key?"active":""} disabled={!app||loading}
        onClick={()=>key==="trade"?setMode("trade"):void load(key)}>{t[key]}</button>)}
      <details className="extraViews" key={mode}
        open={mode==="stress"||mode==="trend"||mode==="brief"}>
        <summary>{t.more}</summary>
        <div className="extraViewOptions">{(["stress","trend","brief"] as const).map(key=>
          <button type="button" key={key} className={mode===key?"active":""}
            disabled={!app||loading} onClick={()=>void load(key)}>{t[key]}</button>)}</div>
      </details>
      {mode!=="trade"&&<button className="refresh" disabled={!app||loading} onClick={()=>void load(mode)}>{loading?t.running:t.refresh}</button>}
    </nav>
    {error&&<div className="callout error" role="alert">{error}</div>}
    {mode==="trade"?<PersonalTradeWorkspace key={env} app={app} environment={env} locale={locale} initial={personalPayload}/>:!payload||payload.kind==="error"?<section className="empty">
      <div className="emptyOrb">◎</div><h2>{t.ready}</h2><p>{t.readyHelp}</p>
      {mode==="today"&&<button type="button" disabled={!app||loading}
        onClick={()=>void load("today")}>{loading?t.running:t.openToday}</button>}
      {payload?.kind==="error"&&<p role="alert">{payload.message}</p>}
    </section>:<>
      <div className="sectionMeta"><span>{mode.toUpperCase()}</span><span>{t.updated}: {date("asOf" in payload?payload.asOf:undefined)}</span></div>
      {payload.kind==="attention_center"&&<section className="panel attentionPanel">
        <div className="attentionHeader">
          <div><h2>{t.today}</h2>
            <p className="muted">{date(payload.asOf)} · {t.computed} · {payload.source.toUpperCase()}</p></div>
          <strong className="attentionValue">{fmt(payload.portfolioValue,payload.currency,locale)}</strong>
        </div>
        <div className="attentionStats">
          <span>{t.reviewCount}: <strong>{payload.reviewCount}</strong></span>
          <span>{t.cashRatio}: <strong>{number(payload.cashPercent)}</strong></span>
          <span>{t.coverage}: <strong>{number(payload.valuationCoveragePercent)}</strong></span>
        </div>
        {payload.reviewCount===0&&<p className="muted">{t.noAlerts}</p>}
        <div className="attentionList">{payload.items.map(item=>
          <article key={item.id} className={`attentionItem ${item.priority}`}>
            <strong>{item.title[locale]}</strong>
            <p>{item.detail[locale]}</p>
            {item.provenance==="saved_monitor_event"&&<small>{t.historical} · {date(item.asOf)}</small>}
          </article>)}</div>
        <p className="muted">{payload.limitations[0]?.[locale]}</p>
        <div className="attentionActions">
          <button type="button" disabled={!app||loading} onClick={()=>void load("risk")}>{t.risk}</button>
          <button type="button" disabled={!app||loading} onClick={()=>void load("overview")}>{t.overview}</button>
        </div>
      </section>}
      {payload.kind==="portfolio"&&<>
        <section className="metrics">
          <Metric label={t.account} value={fmt(payload.account.totalValue,payload.account.currency,locale)}/>
          <Metric label={t.cash} value={fmt(payload.account.availableCash,payload.account.currency,locale)}/>
          <Metric label={t.positions} value={String(payload.holdings.length)}/>
          <Metric label={t.unrealized} value={fmt(payload.account.unrealizedProfitLoss,payload.account.currency,locale)}/>
          {payload.account.realizedProfitLoss!==undefined&&<Metric label={t.realized}
            value={fmt(payload.account.realizedProfitLoss,payload.account.currency,locale)}/>}
        </section>
        <section className="panel"><h2>{t.holdings}</h2><div className="holdingList">
          {payload.holdings.map(h=><div className="holding holdingCard" key={h.ticker}>
            <div className="holdingHead">
              <span><strong>{h.ticker}</strong><small>{h.name}</small></span>
              <span className="alignRight"><strong>{h.quantity}</strong><small>{fmt(h.valueInAccountCurrency,payload.account.currency,locale)}</small></span>
            </div>
            <div className="holdingFacts">
              <span>{t.price}: <strong>{fmt(h.price,h.currency,locale)}</strong></span>
              <span>{t.avg}: <strong>{fmt(h.averagePricePaid,h.currency,locale)}</strong></span>
              <span>{t.tradable}: <strong>{h.tradableQuantity.toLocaleString()}</strong></span>
              <span>{t.unrealized}: <strong>{fmt(h.unrealizedProfitLossInAccountCurrency,payload.account.currency,locale)}</strong></span>
            </div>
          </div>)}</div></section>
        {!!payload.notes.length&&<section className="panel warning"><h2>{t.warning}</h2>{payload.notes.map((note,i)=><p key={i}>{note}</p>)}</section>}
      </>}
      {payload.kind==="analysis"&&<>
        <section className="metrics">
          <Metric label={t.coverage} value={number(payload.exposureCoveragePercent)}/>
          <Metric label={t.concentration} value={number(payload.largestPositionPercent)}/>
          <Metric label={t.cashRatio} value={number(payload.cashPercent)}/>
        </section>
        <section className="panel"><h2>{t.holdings}</h2>{payload.exposures.map(item=><ExposureRow key={item.ticker} item={item} currency={currency} locale={locale}/>)}</section>
        {!!payload.alerts.length&&<section className="panel warning"><h2>{t.riskAlerts}</h2>{payload.alerts.map((a,i)=><p key={i}>{a}</p>)}</section>}
        {!!payload.limitations.length&&<section className="panel"><h2>{t.limitations}</h2>{payload.limitations.map((a,i)=><p key={i}>{a}</p>)}</section>}
      </>}
      {payload.kind==="scenario"&&<section className="panel">
        <h2>{t.scenario} · {number(payload.shockPercent)}</h2>
        <div className="metrics two"><Metric label={t.totalChange} value={fmt(payload.hypotheticalPortfolioChange,currency,locale)}/><Metric label={t.outcome} value={fmt(payload.hypotheticalPortfolioValue,currency,locale)}/></div>
        <p className="muted">{t.scenarioHelp}</p>
        <h3>{t.assumptions}</h3>{payload.assumptions.map((a,i)=><p key={i}>{a}</p>)}
      </section>}
      {payload.kind==="risk_trend"&&<section className="panel">
        <h2>{t.trend}</h2>
        <div className="metric"><span>{locale==="zh"?"观察到的总值变化（不等于投资收益）":"Observed total-value change (not investment return)"}</span>
          <strong>{fmt(payload.absoluteValueChange,currency,locale)}</strong></div>
        {payload.points.length? <div className="trendTable">
          {payload.points.slice(-30).map((point,i)=><div className="trendRow" key={point.asOf+"-"+i}>
            <span>{date(point.asOf)}</span>
            <strong>{fmt(point.totalValue,point.accountCurrency,locale)}</strong>
            <span>{t.concentration}: {number(point.largestPositionPercent)}</span>
            <span>{t.coverage}: {number(point.exposureCoveragePercent)}</span>
          </div>)}
        </div> : <p>{locale==="zh"?"尚无每日监测记录。请先创建监测规则并运行扫描。":"No daily monitoring observations yet. Create a watch rule and run a scan."}</p>}
        {payload.notes.map((note,i)=><p className="muted" key={i}>{note}</p>)}
      </section>}
      {payload.kind==="daily_brief"&&<section className="panel"><h2>{t.brief}</h2><p>{payload.summary}</p>
        <h3>{t.riskAlerts}</h3>{payload.observations.map((a,i)=><p key={i}>{a}</p>)}
        <h3>{t.watch}</h3>{payload.priorityChecks.map((a,i)=><p key={i}>{a}</p>)}
        <p className="muted">{payload.disclaimer}</p>
      </section>}
    </>}
    {mode!=="trade"&&<section className="scenarioControls">
      <div><strong>{t.scenario}</strong><p>{t.scenarioHelp}</p></div>
      <div className="controls"><input aria-label="Shock percent" type="range" min="-40" max="40" step="5" value={shock} onChange={e=>setShock(Number(e.target.value))}/><span>{number(shock)}</span><button disabled={!app||loading} onClick={()=>void load("stress")}>{t.run}</button></div>
    </section>}
  </main>;
}
