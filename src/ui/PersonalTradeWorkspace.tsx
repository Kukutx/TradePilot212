import {useEffect,useState} from "react";
import type {App as McpApp} from "@modelcontextprotocol/ext-apps";
import type {Environment} from "../domain/types";
import type {
  TradeSide,TradeOrderType,Sizing,TradeDraft,TradeResolution,TradePreview,
  TradeExecution,TradeVerification,CancelPreview,PendingOrder,TradeIdea,
} from "../domain/trading";
import {personalApprovalProof} from "../domain/approval-proof";
import type {ResearchAudit} from "../domain/research";

type Locale="zh"|"en";
interface Capability{kind:"personal_capabilities";environment:Environment;source:string;canReview:boolean;canExecute:boolean;}
interface PendingPayload{kind:"pending_orders";environment:Environment;source:string;orders:PendingOrder[];personalExecutionEnabled:boolean;}
interface PlanPayload{kind:"trade_plan";environment:Environment;source:string;asOf:string;candidates:Array<TradeIdea & {resolvedTicker?:string;warning?:string;heldQuantity?:number;availableToSell?:number;evidence?:ResearchAudit}>;}
interface ActivityEntry{id:string;asOf:string;action:string;ticker?:string;orderId?:string;detail?:string;}
interface ActivityPayload{kind:"trading_activity";environment:Environment;events:ActivityEntry[];}
export type PersonalPayload=TradeResolution|TradePreview|TradeExecution|TradeVerification|CancelPreview|PendingPayload|PlanPayload;
const strings={
  en:{
    title:"Personal trading",notice:"Private self-hosted integration. AI cannot execute orders by itself.",
    disabled:"Execution is disabled. Enable private trading in server configuration and authorize trading:execute scope.",
    review:"Review draft",prepare:"Validate & prepare confirmation",buy:"Buy",sell:"Sell",
    ticker:"Ticker or company name",quantity:"Shares / amount / percent",side:"Side",type:"Order type",sizing:"Sizing method",
    currency:"Input currency (for target amount)",fx:"FX rate to instrument quote currency",limit:"Limit price",stop:"Stop trigger",ref:"Reference price (estimate only)",
    extended:"Allow extended hours",validity:"Validity",cancel:"Cancel",edit:"Back to edit",
    confirmOrder:"Confirm and submit",confirmCancel:"Confirm cancellation",
    approval:"Independent execution secret (entered in widget only)",approvalHint:"Never enter this secret in the AI chat. A token-specific HMAC proof is sent instead.",
    pending:"Pending broker orders",refresh:"Refresh orders",reviewCancel:"Review cancellation",
    plans:"AI-generated research plans",planReview:"Review proposed order",
    filled:"Filled",remaining:"Remaining",orderStatus:"Broker status",
    evidence:"Research documentation",sourceUnverified:"Completeness is not factual verification",evidenceChecks:"Evidence checks",
    result:"Broker result",verify:"Read-only verification",unknown:"Unknown broker outcome: never retry automatically.",
    warnings:"Review every warning",notConfigured:"Review not enabled for this connection; reconnect with trading:review scope.",
    loading:"Checking…",sample:"SYNTHETIC sample mode cannot place real orders.",
    activity:"Recent TradePilot activity",loadActivity:"Refresh activity",noActivity:"No activity recorded",
    modified:"Quantity was manually changed after the AI draft was resolved",restore:"Restore calculated quantity",
    referenceAsOf:"Reference price as of",fxAsOf:"FX estimate as of",fullscreen:"Fullscreen",
    sizeModes:{quantity:"Exact shares",notional:"Target money",cash_percent:"% available cash",position_percent:"% held position",all_available:"All tradable shares"},
  },
  zh:{
    title:"个人交易工作台",notice:"仅供个人自托管。AI 不得独立提交或撤销订单。",
    disabled:"交易执行已禁用。需在服务器明确启用个人交易，并授权 trading:execute。",
    review:"解析订单草稿",prepare:"重新校验并生成确认",buy:"买入",sell:"卖出",
    ticker:"券商代码或公司名称",quantity:"股数 / 金额 / 百分比",side:"方向",type:"订单类型",sizing:"数量换算方式",
    currency:"输入币种（指定金额时）",fx:"兑换至标的报价币种的汇率",limit:"限价",stop:"止损触发价",ref:"参考价（仅估算）",
    extended:"允许盘前／盘后",validity:"订单有效期",cancel:"取消",edit:"返回编辑",
    confirmOrder:"最终确认并提交",confirmCancel:"确认撤销订单",
    approval:"独立交易授权密钥（仅在界面输入）",approvalHint:"切勿在 AI 对话中发送密钥。界面只发送绑定当前确认令牌的 HMAC 证明。",
    pending:"当前待处理订单",refresh:"刷新订单",reviewCancel:"检查撤单",
    plans:"AI 生成的研究候选",planReview:"检查此候选订单",
    filled:"已成交",remaining:"剩余数量",orderStatus:"券商状态",
    evidence:"研究材料完整度",sourceUnverified:"材料完整不代表事实已核实",evidenceChecks:"研究证据检查",
    result:"券商执行结果",verify:"只读核对状态",unknown:"券商执行状态不明，严禁自动重试。",
    warnings:"请逐条核对风险提示",notConfigured:"当前连接未开启交易审查权限，请重新授权 trading:review。",
    loading:"校验中…",sample:"合成示例数据不能执行真实交易。",
    activity:"最近交易操作",loadActivity:"刷新操作记录",noActivity:"暂无操作记录",
    modified:"你已手动修改根据 AI 指令换算的股数",restore:"恢复换算股数",
    referenceAsOf:"参考价格时间",fxAsOf:"汇率估算时间",fullscreen:"全屏",
    sizeModes:{quantity:"准确股数",notional:"目标金额",cash_percent:"可用现金比例",position_percent:"总持仓比例",all_available:"当前全部可卖股数"},
  },
} as const;
const amount=(value:number|null|undefined)=>
  value===null||value===undefined||!Number.isFinite(value)?"—":value.toLocaleString(undefined,{maximumFractionDigits:6});
async function call<T>(app:McpApp,name:string,args:Record<string,unknown>):Promise<T>{
  const result=await app.callServerTool({name,arguments:args});
  if(result.isError){
    const structured=result.structuredContent as {message?:string}|undefined;
    const text=result.content?.find(x=>x.type==="text");
    throw new Error(structured?.message||(text?.type==="text"?text.text:"Server refused the action"));
  }
  if(!result.structuredContent)throw new Error("No structured result returned");
  return result.structuredContent as unknown as T;
}
interface Props{app:McpApp|null;environment:Environment;locale:Locale;initial:PersonalPayload|null;}
export default function PersonalTradeWorkspace({app,environment,locale,initial}:Props){
  const t=strings[locale];
  const [cap,setCap]=useState<Capability|null>(null);
  const [name,setName]=useState("");
  const [side,setSide]=useState<TradeSide>("buy");
  const [type,setType]=useState<TradeOrderType>("market");
  const [mode,setSizingMode]=useState<Sizing["mode"]>("quantity");
  const [size,setSize]=useState("");
  const [currency,setCurrency]=useState("");
  const [fx,setFx]=useState("");
  const [ref,setRef]=useState("");
  const [limit,setLimit]=useState("");
  const [stop,setStop]=useState("");
  const [hours,setHours]=useState(false);
  const [validity,setValidity]=useState<"DAY"|"GOOD_TILL_CANCEL">("DAY");
  const [resolution,setResolution]=useState<TradeResolution|null>(null);
  const [draft,setDraft]=useState<TradeDraft|null>(null);
  const [preview,setPreview]=useState<TradePreview|null>(null);
  const [cancelPreview,setCancelPreview]=useState<CancelPreview|null>(null);
  const [execution,setExecution]=useState<TradeExecution|null>(null);
  const [verification,setVerification]=useState<TradeVerification|null>(null);
  const [plan,setPlan]=useState<PlanPayload|null>(null);
  const [pending,setPending]=useState<PendingOrder[]>([]);
  const [activity,setActivity]=useState<ActivityEntry[]>([]);
  const [approval,setApproval]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    setDraft(null);setPreview(null);setCancelPreview(null);setExecution(null);setVerification(null);setApproval("");setResolution(null);
    setPending([]);setActivity([]);setCap(null);
    if(!app)return;
    void call<Capability>(app,"get_personal_trading_capabilities",{environment})
      .then(setCap).catch(e=>setError(e instanceof Error?e.message:String(e)));
  },[app,environment]);
  // Apply the host's initial model-opened trade after environment initialization;
  // otherwise a simultaneous mount would erase the model-provided draft.
  useEffect(()=>{
    if(!initial|| !("kind" in initial))return;
    if(initial.kind==="trade_draft"){setResolution(initial);setDraft(initial.draft);setPreview(null);}
    else if(initial.kind==="trade_preview"){setPreview(initial);setDraft(initial.draft);}
    else if(initial.kind==="trade_plan"){setPlan(initial);}
    else if(initial.kind==="pending_orders"){setPending(initial.orders);}
    else if(initial.kind==="trade_execution"){setExecution(initial);}
    else if(initial.kind==="cancel_preview"){setCancelPreview(initial);}
    else if(initial.kind==="trade_verification"){setVerification(initial);}
  },[initial]);
  async function perform(operation:()=>Promise<void>){
    setBusy(true);setError(null);
    try{await operation();}catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  async function checkIntent(override?:{instrument:string;side:TradeSide;quantity:number;referencePrice?:number}){
    if(!app)return;
    await perform(async()=>{
      const value=Number(size),rate=fx.trim()?Number(fx):undefined;
      let sizing:Sizing;
      if(override)sizing={mode:"quantity",quantity:override.quantity};
      else if(mode==="all_available")sizing={mode:"all_available"};
      else if(mode==="quantity")sizing={mode:"quantity",quantity:value};
      else if(mode==="notional")sizing={mode:"notional",amount:value,
        ...(currency.trim()?{currency:currency.trim().toUpperCase()}:{}),
        ...(rate!==undefined?{fxToQuote:rate}:{})};
      else if(mode==="cash_percent")sizing={mode:"cash_percent",percent:value,
        ...(rate!==undefined?{fxToQuote:rate}:{})};
      else sizing={mode:"position_percent",percent:value};
      const currentRef=override?.referencePrice??(ref.trim()?Number(ref):undefined);
      const draftArgs:Record<string,unknown>={
        environment,instrument:override?.instrument||name,side:override?.side||side,type,
        sizing,...(currentRef!==undefined?{referencePrice:currentRef}:{}),
        ...(limit.trim()?{limitPrice:Number(limit)}:{}),
        ...(stop.trim()?{stopPrice:Number(stop)}:{}),
        extendedHours:hours,timeValidity:validity,
      };
      const result=await call<TradeResolution>(app,"review_personal_trade_intent",draftArgs);
      setResolution(result);setDraft(result.draft);setPreview(null);setCancelPreview(null);setExecution(null);
    });
  }
  async function prepare(){
    if(!app||!draft)return;
    await perform(async()=>{
      const p=await call<TradePreview>(app,"app_prepare_personal_order",draft as unknown as Record<string,unknown>);
      setPreview(p);setApproval("");
    });
  }
  async function executeOrder(){
    if(!app||!preview||!approval)return;
    await perform(async()=>{
      const proof=await personalApprovalProof(approval,"order",preview.token);
      setApproval("");
      const result=await call<TradeExecution>(app,"app_execute_personal_order",
        {environment:preview.environment,token:preview.token,proof});
      setExecution(result);setPreview(null);setDraft(null);setResolution(null);
      // Execution has already been acknowledged; a failed read-only refresh
      // must not make a successful submission appear to have failed.
      await refreshPending().catch(()=>undefined);
      await refreshActivity().catch(()=>undefined);
    });
  }
  async function refreshActivity(){
    if(!app||!cap?.canReview)return;
    const result=await call<ActivityPayload>(app,"get_personal_trading_activity",{environment});
    setActivity(result.events);
  }
  async function refreshPending(){
    if(!app||!cap?.canReview)return;
    const result=await call<PendingPayload>(app,"get_personal_pending_orders",{environment});
    setPending(result.orders);
  }
  async function reviewCancellation(orderId:string){
    if(!app)return;
    await perform(async()=>{
      const p=await call<CancelPreview>(app,"app_prepare_personal_cancel",{environment,orderId});
      setCancelPreview(p);setApproval("");setExecution(null);
    });
  }
  async function cancelOrder(){
    if(!app||!cancelPreview||!approval)return;
    await perform(async()=>{
      const proof=await personalApprovalProof(approval,"cancel",cancelPreview.token);
      setApproval("");
      const result=await call<TradeExecution>(app,"app_execute_personal_cancel",
        {environment:cancelPreview.environment,token:cancelPreview.token,proof});
      setExecution(result);setCancelPreview(null);
      await refreshPending().catch(()=>undefined);
      await refreshActivity().catch(()=>undefined);
    });
  }
  async function verify(){
    if(!app||!execution?.verificationId)return;
    await perform(async()=>{
      const result=await call<TradeVerification>(app,"app_verify_personal_execution",
        {environment:execution.environment,verificationId:execution.verificationId!});
      setVerification(result);
    });
  }
  const approvalField=<div className="tradeApproval">
    <label>{t.approval}<input type="password" value={approval} autoComplete="off" spellCheck={false}
      onChange={e=>setApproval(e.target.value)} /></label><p>{t.approvalHint}</p>
  </div>;
  return <section className="tradeStack">
    <div className="tradeIntro"><div><h2>{t.title}</h2><p>{t.notice}</p></div>
      <span className={`tradeFlag ${environment==="live"?"live":""}`}>{environment.toUpperCase()} · {cap?.canExecute?"EXECUTION ON":"REVIEW ONLY"}</span>
    </div>
    {!cap?.canReview&&<div className="callout">{cap?.source==="sample"?t.sample:t.notConfigured}</div>}
    {cap?.canReview&&!cap.canExecute&&<div className="callout">{t.disabled}</div>}
    {error&&<div className="callout error" role="alert">{error}</div>}
    {execution&&<section className="panel">
      <h2>{t.result} · {execution.status.toUpperCase()}</h2>
      <p>{execution.message}</p>
      {execution.status==="unknown"&&<p className="callout">{t.unknown}</p>}
      {execution.status==="unknown"&&execution.verificationId&&<button type="button" disabled={busy}
        onClick={()=>void verify()}>{t.verify}</button>}
      {verification&&<p>{verification.status.toUpperCase()} — {verification.message}</p>}
    </section>}
    {preview?<section className="panel tradeConfirm">
      <h2>{preview.environment==="live"?"LIVE · REAL FUNDS":"DEMO"} — {t.confirmOrder}</h2>
      <div className="tradeSummary">
        <strong>{preview.draft.ticker}</strong>
        <span>{preview.draft.side.toUpperCase()} · {preview.draft.type.toUpperCase()} · {amount(preview.draft.quantity)}</span>
        <span>{preview.estimatedNotional===null?"Notional unavailable":`${amount(preview.estimatedNotional)} ${preview.instrument.currencyCode} (estimate)`}</span>
        <small>Expires: {new Date(preview.expiresAt).toLocaleString()}</small>
        {preview.draft.referencePriceAt&&<small>{t.referenceAsOf}: {new Date(preview.draft.referencePriceAt).toLocaleString()}</small>}
        {preview.draft.fxRateAt&&<small>{t.fxAsOf}: {new Date(preview.draft.fxRateAt).toLocaleString()}</small>}
      </div>
      <h3>{t.warnings}</h3>{preview.warnings.map((warning,i)=><p key={i} className="tradeWarning">{warning}</p>)}
      {approvalField}
      <div className="tradeActions">
        <button type="button" onClick={()=>{setPreview(null);setApproval("");}}>{t.edit}</button>
        <button className="tradeDanger" type="button" disabled={!cap?.canExecute||!approval||busy}
          onClick={()=>void executeOrder()}>{busy?t.loading:t.confirmOrder}</button>
      </div>
    </section>:cancelPreview?<section className="panel tradeConfirm">
      <h2>{cancelPreview.environment==="live"?"LIVE · REAL FUNDS":"DEMO"} — {t.confirmCancel}</h2>
      <p>{cancelPreview.orderId} · {cancelPreview.ticker}</p>
      {approvalField}
      <div className="tradeActions">
        <button type="button" onClick={()=>{setCancelPreview(null);setApproval("");}}>{t.edit}</button>
        <button className="tradeDanger" type="button" disabled={!cap?.canExecute||!approval||busy}
          onClick={()=>void cancelOrder()}>{t.confirmCancel}</button>
      </div>
    </section>:<div className="tradeLayout">
      <section className="panel tradeEditor">
        <h2>{draft?t.prepare:t.review}</h2>
        {resolution&&<p className="tradeNotice">{resolution.note}</p>}
        {resolution?.warnings.map((x,i)=><p className="tradeWarning" key={i}>{x}</p>)}
        {draft&&resolution&&draft.quantity!==resolution.draft.quantity&&<div className="tradeManualEdit">
          <span>{t.modified}</span><button type="button" onClick={()=>setDraft({...draft,quantity:resolution.draft.quantity})}>{t.restore}</button>
        </div>}
        {draft?<div className="tradeFields">
          <label>{t.ticker}<input value={draft.ticker} disabled /></label>
          <label>{t.side}<select value={draft.side} onChange={e=>setDraft({...draft,side:e.target.value as TradeSide})}><option value="buy">{t.buy}</option><option value="sell">{t.sell}</option></select></label>
          <label>{t.type}<select value={draft.type} onChange={e=>setDraft({...draft,type:e.target.value as TradeOrderType})}>
            {(["market","limit","stop","stop_limit"] as const).map(x=><option key={x}>{x}</option>)}</select></label>
          <label>{t.quantity}<input type="number" min="0.00000001" step="any" value={draft.quantity}
            onChange={e=>setDraft({...draft,quantity:Number(e.target.value)})}/></label>
          {(draft.type==="limit"||draft.type==="stop_limit")&&<label>{t.limit}<input type="number" step="any" value={draft.limitPrice??""}
            onChange={e=>setDraft({...draft,limitPrice:Number(e.target.value)})}/></label>}
          {(draft.type==="stop"||draft.type==="stop_limit")&&<label>{t.stop}<input type="number" step="any" value={draft.stopPrice??""}
            onChange={e=>setDraft({...draft,stopPrice:Number(e.target.value)})}/></label>}
          <label>{t.ref}<input type="number" step="any" value={draft.referencePrice??""}
            onChange={e=>setDraft({...draft,referencePrice:Number(e.target.value)})}/></label>
        </div>:<div className="tradeFields">
          <label>{t.ticker}<input value={name} placeholder="AAPL / Apple" onChange={e=>setName(e.target.value)} /></label>
          <label>{t.side}<select value={side} onChange={e=>setSide(e.target.value as TradeSide)}><option value="buy">{t.buy}</option><option value="sell">{t.sell}</option></select></label>
          <label>{t.type}<select value={type} onChange={e=>setType(e.target.value as TradeOrderType)}>
            {(["market","limit","stop","stop_limit"] as const).map(x=><option key={x}>{x}</option>)}</select></label>
          <label>{t.sizing}<select value={mode} onChange={e=>setSizingMode(e.target.value as Sizing["mode"])}>
            {(Object.keys(t.sizeModes) as Array<Sizing["mode"]>).map(x=><option value={x} key={x}>{t.sizeModes[x]}</option>)}</select></label>
          {mode!=="all_available"&&<label>{t.quantity}<input type="number" step="any" value={size} onChange={e=>setSize(e.target.value)}/></label>}
          {mode==="notional"&&<label>{t.currency}<input value={currency} maxLength={3} onChange={e=>setCurrency(e.target.value)}/></label>}
          {(mode==="cash_percent"||mode==="notional")&&<label>{t.fx}<input type="number" step="any" value={fx} onChange={e=>setFx(e.target.value)}/></label>}
          {(type==="limit"||type==="stop_limit")&&<label>{t.limit}<input type="number" step="any" value={limit} onChange={e=>setLimit(e.target.value)}/></label>}
          {(type==="stop"||type==="stop_limit")&&<label>{t.stop}<input type="number" step="any" value={stop} onChange={e=>setStop(e.target.value)}/></label>}
          <label>{t.ref}<input type="number" step="any" value={ref} onChange={e=>setRef(e.target.value)}/></label>
          <label>{t.validity}<select value={validity} onChange={e=>setValidity(e.target.value as "DAY"|"GOOD_TILL_CANCEL")}><option value="DAY">DAY</option><option value="GOOD_TILL_CANCEL">GTC</option></select></label>
          {type==="market"&&<label className="checkRow"><input type="checkbox" checked={hours} onChange={e=>setHours(e.target.checked)}/>{t.extended}</label>}
        </div>}
        <div className="tradeActions">
          {draft&&<button type="button" onClick={()=>{setDraft(null);setResolution(null);}}>{t.edit}</button>}
          <button type="button" disabled={!app||!cap?.canReview||busy||
            (!draft && (!name.trim() || (mode!=="all_available"&&!size.trim())))}
            onClick={()=>void (draft?prepare():checkIntent())}>{busy?t.loading:draft?t.prepare:t.review}</button>
        </div>
      </section>
      <section className="panel">
        <div className="tradeTitle"><h2>{t.pending}</h2>
          <button type="button" disabled={!cap?.canReview||busy}
            onClick={()=>void perform(refreshPending)}>{t.refresh}</button></div>
        {pending.length?pending.map(p=><div className="pendingRow" key={p.id}>
          <div><strong>{p.ticker}</strong>
            <small>#{p.id} · {p.side||"?"} · {p.type||"ORDER"} · {amount(p.quantity)}</small>
            <small>{t.orderStatus}: {p.status||"—"}
              {p.filledQuantity!==undefined? ` · ${t.filled}: ${amount(p.filledQuantity)} · ${t.remaining}: ${amount(Math.max(0,Math.abs(p.quantity)-p.filledQuantity))}`:""}
            </small>
            {p.createdAt&&<small>{new Date(p.createdAt).toLocaleString(locale==="zh"?"zh-CN":"en-US")}</small>}
          </div>
          <button type="button" disabled={!cap?.canReview||busy}
            onClick={()=>void reviewCancellation(p.id)}>{t.reviewCancel}</button>
        </div>):<p>—</p>}
      </section>
      <section className="panel">
        <div className="tradeTitle"><h2>{t.activity}</h2>
          <button type="button" disabled={!cap?.canReview||busy}
            onClick={()=>void perform(refreshActivity)}>{t.loadActivity}</button></div>
        {activity.length?activity.map(event=><div className="pendingRow" key={event.id}>
          <div><strong>{event.action.replaceAll("_"," ")}</strong>
            <small>{[event.ticker,event.orderId,event.detail].filter(Boolean).join(" · ")}</small></div>
          <small>{new Date(event.asOf).toLocaleString(locale==="zh"?"zh-CN":"en-US")}</small>
        </div>):<p>{t.noActivity}</p>}
      </section>
    </div>}
    {!!plan?.candidates.length&&!preview&&!cancelPreview&&<section className="panel">
      <h2>{t.plans}</h2><div className="planCards">{plan.candidates.map((p,i)=><article className="planCard" key={i}>
        <div className="tradeTitle"><strong>{p.resolvedTicker||p.ticker||p.symbol||p.name||"—"}</strong>
          <small>{p.horizon.toUpperCase()} · {p.action.toUpperCase()} · AI SCORE {p.score}</small></div>
        <p>{p.rationale}</p>
        {p.evidence&&<div className="researchAudit">
          <strong>{t.evidence}: {p.evidence.completenessPercent}/100</strong>
          <small>{t.sourceUnverified}</small>
          {!!p.evidence.warningMessages.length&&<details>
            <summary>{t.evidenceChecks} ({p.evidence.warningMessages.length})</summary>
            {p.evidence.warningMessages.map((warning,j)=><p key={j}>{warning}</p>)}
          </details>}
        </div>}
        {p.thesis&&<details><summary>Thesis / Details</summary><p>{p.thesis}</p>
          {p.catalysts?.map((x,j)=><p key={j}>+ {x}</p>)}{p.risks?.map((x,j)=><p key={j}>! {x}</p>)}
          {p.counterCase&&<p>{p.counterCase}</p>}{p.sources?.map((x,j)=><p key={j}>{x}</p>)}</details>}
        {(p.analysisAsOf||p.referencePriceAt)&&<small>{p.analysisAsOf?`Research: ${new Date(p.analysisAsOf).toLocaleString()} `:""}{p.referencePriceAt?`· Price: ${new Date(p.referencePriceAt).toLocaleString()}`:""}</small>}
        {p.warning&&<p className="tradeWarning">{p.warning}</p>}
        {p.action!=="watch"&&<button disabled={!cap?.canReview||busy} type="button"
          onClick={()=>{
            const instrument=p.resolvedTicker||p.ticker||p.symbol||p.name||"";
            const selectedSide=p.action==="sell"?"sell":"buy";
            if(p.suggestedQuantity){
              void checkIntent({instrument,side:selectedSide,quantity:p.suggestedQuantity,referencePrice:p.referencePrice});
            }else{
              // Never invent a one-share order from a research idea with no sizing.
              // Ask the user for an explicit quantity before opening the broker draft.
              setName(instrument);setSide(selectedSide);setSizingMode("quantity");setSize("");
              setRef(p.referencePrice?String(p.referencePrice):"");
              setDraft(null);setResolution(null);setPreview(null);setError(null);
            }
          }}>{t.planReview}</button>}
      </article>)}</div>
    </section>}
  </section>;
}
