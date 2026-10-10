import { useApp,useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as HostApp } from "@modelcontextprotocol/ext-apps";
import { useEffect,useMemo,useState } from "react";
import type { PortfolioAnalysis,PortfolioSnapshot,Scenario,Environment,Exposure } from "../domain/types";

type Brief={kind:"daily_brief";environment:Environment;source:string;asOf:string;summary:string;observations:string[];priorityChecks:string[];disclaimer:string;currency:string};
type Payload=PortfolioSnapshot|PortfolioAnalysis|Scenario|Brief|{kind:"error";message:string};
type Locale="zh"|"en";
const wording={
  en:{
    brand:"TRADEPILOT / INTELLIGENCE",overview:"Overview",risk:"Risk map",stress:"Stress test",brief:"Daily brief",
    account:"Portfolio value",cash:"Available cash",positions:"Holdings",updated:"Observed",
    warning:"Data quality",holdings:"Current holdings",exposure:"Value / allocation",unpriced:"Unverified value",
    scenario:"Hypothetical uniform shock",scenarioHelp:"This is a calculation, not a forecast or trade recommendation.",
    run:"Run simulation",running:"Loading",ready:"Ready for your portfolio",readyHelp:"Ask your AI assistant for a portfolio overview, risk analysis or brief.",
    demo:"SYNTHETIC SAMPLE DATA",live:"Broker read-only data",noTrades:"No trade execution or cancellation is available",
    refresh:"Refresh",riskAlerts:"Risk observations",limitations:"Data limitations",watch:"Priority research checks",
    coverage:"Verified value coverage",concentration:"Largest holding",cashRatio:"Cash ratio",noData:"Not computable",
    totalChange:"Hypothetical portfolio change",outcome:"Hypothetical total value",assumptions:"Assumptions",
    connection:"MCP host connection",unknown:"An unexpected response was received",error:"Data unavailable",
  },
  zh:{
    brand:"TRADEPILOT / 智能投资分析",overview:"持仓概览",risk:"风险分析",stress:"压力测试",brief:"组合简报",
    account:"投资组合总值",cash:"可用现金",positions:"持仓数量",updated:"数据时间",
    warning:"数据质量",holdings:"当前持仓",exposure:"估值 / 占比",unpriced:"无法核实估值",
    scenario:"假设持仓价格同步变化",scenarioHelp:"仅做算术情景推演，不是价格预测或交易建议。",
    run:"计算情景",running:"加载中",ready:"等待组合数据",readyHelp:"请在 AI 对话中请求持仓概览、风险分析或投资组合简报。",
    demo:"合成示例数据，不是真实账户",live:"券商真实只读数据",noTrades:"本插件不提供下单或撤单功能",
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
  const [env,setEnv]=useState<Environment>("demo");
  const [mode,setMode]=useState<"overview"|"risk"|"stress"|"brief">("overview");
  const [locale,setLocale]=useState<Locale>("zh");
  const [shock,setShock]=useState(-10);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const t=useMemo(()=>wording[locale],[locale]);
  const {app, error:appError}=useApp({
    appInfo:{name:"TradePilot Insight",version:"3.0.0-alpha.1"},
    capabilities:{},
    onAppCreated:(created:HostApp)=>{
      created.ontoolresult=result=>{
        const next=result.structuredContent as unknown as Payload|undefined;
        if(!next||typeof next.kind!=="string")return;
        setPayload(next);
        if("environment" in next)setEnv(next.environment);
        if(next.kind==="portfolio")setMode("overview");
        if(next.kind==="analysis")setMode("risk");
        if(next.kind==="scenario")setMode("stress");
        if(next.kind==="daily_brief")setMode("brief");
      };
      const context=created.getHostContext();
      if(context?.locale)setLocale(context.locale.toLowerCase().startsWith("zh")?"zh":"en");
      created.onhostcontextchanged=context=>{
        if(context?.locale)setLocale(context.locale.toLowerCase().startsWith("zh")?"zh":"en");
      };
    },
  });
  useHostStyles(app,app?.getHostContext());
  useEffect(()=>{if(appError)setError(appError.message);},[appError]);
  const currency=payload?.kind==="portfolio"?payload.account.currency:
    payload?.kind==="analysis"?payload.accountCurrency:
    payload?.kind==="daily_brief"?payload.currency:
    payload?.kind==="scenario"?payload.currency:"USD";
  const source=payload&&"source" in payload?payload.source:"sample";
  async function load(kind:"overview"|"risk"|"stress"|"brief",environment=env){
    if(!app)return;
    const names={
      overview:"get_portfolio_intelligence",risk:"analyze_portfolio_risk",
      stress:"simulate_portfolio_scenario",brief:"get_portfolio_review_brief",
    };
    setLoading(true);setError(null);
    try{
      const result=await app.callServerTool({name:names[kind],arguments:{environment,...(kind==="stress"?{shockPercent:shock}:{})}});
      if(result.isError)throw new Error(result.content?.find(x=>x.type==="text")?.text||t.error);
      const next=result.structuredContent as unknown as Payload|undefined;
      if(!next||!["portfolio","analysis","scenario","daily_brief"].includes(next.kind))throw new Error(t.unknown);
      setPayload(next);setMode(kind);setEnv(environment);
    }catch(e){setError(e instanceof Error?e.message:t.error);}finally{setLoading(false);}
  }
  function date(value?:string){return value?new Date(value).toLocaleString(locale==="zh"?"zh-CN":"en-US"):"—";}
  return <main className="shell">
    <header className="top">
      <div className="identity"><span className="mark">T<span>P</span></span><div><span className="eyebrow">{t.brand}</span><h1>Portfolio Intelligence</h1></div></div>
      <div className="topActions">
        <select aria-label="Account environment" value={env} onChange={e=>{setEnv(e.target.value as Environment);setPayload(null);}}><option value="demo">DEMO</option><option value="live">LIVE</option></select>
        <button type="button" onClick={()=>setLocale(locale==="zh"?"en":"zh")}>{locale==="zh"?"EN":"中文"}</button>
      </div>
    </header>
    <div className="trustBar"><SourceTag source={source} locale={locale}/><span>{t.noTrades}</span></div>
    <nav className="tabs" aria-label="Portfolio views">
      {(["overview","risk","stress","brief"] as const).map(key=><button
        key={key} className={mode===key?"active":""} disabled={!app||loading}
        onClick={()=>void load(key)}>{t[key]}</button>)}
      <button className="refresh" disabled={!app||loading} onClick={()=>void load(mode)}>{loading?t.running:t.refresh}</button>
    </nav>
    {error&&<div className="callout error" role="alert">{error}</div>}
    {!payload||payload.kind==="error"?<section className="empty">
      <div className="emptyOrb">◎</div><h2>{t.ready}</h2><p>{t.readyHelp}</p>
      {payload?.kind==="error"&&<p role="alert">{payload.message}</p>}
    </section>:<>
      <div className="sectionMeta"><span>{mode.toUpperCase()}</span><span>{t.updated}: {date("asOf" in payload?payload.asOf:undefined)}</span></div>
      {payload.kind==="portfolio"&&<>
        <section className="metrics">
          <Metric label={t.account} value={fmt(payload.account.totalValue,payload.account.currency,locale)}/>
          <Metric label={t.cash} value={fmt(payload.account.availableCash,payload.account.currency,locale)}/>
          <Metric label={t.positions} value={String(payload.holdings.length)}/>
        </section>
        <section className="panel"><h2>{t.holdings}</h2><div className="holdingList">
          {payload.holdings.map(h=><div className="holding" key={h.ticker}>
            <span><strong>{h.ticker}</strong><small>{h.name}</small></span>
            <span className="alignRight"><strong>{h.quantity}</strong><small>{fmt(h.valueInAccountCurrency,payload.account.currency,locale)}</small></span>
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
      {payload.kind==="daily_brief"&&<section className="panel"><h2>{t.brief}</h2><p>{payload.summary}</p>
        <h3>{t.riskAlerts}</h3>{payload.observations.map((a,i)=><p key={i}>{a}</p>)}
        <h3>{t.watch}</h3>{payload.priorityChecks.map((a,i)=><p key={i}>{a}</p>)}
        <p className="muted">{payload.disclaimer}</p>
      </section>}
    </>}
    <section className="scenarioControls">
      <div><strong>{t.scenario}</strong><p>{t.scenarioHelp}</p></div>
      <div className="controls"><input aria-label="Shock percent" type="range" min="-40" max="40" step="5" value={shock} onChange={e=>setShock(Number(e.target.value))}/><span>{number(shock)}</span><button disabled={!app||loading} onClick={()=>void load("stress")}>{t.run}</button></div>
    </section>
  </main>;
}
