import type { Environment, PortfolioSnapshot } from "../domain/types.js";
import {
  checkDraft,resolveInstrument,resolveTradeIntent,
  type CancelPreview,type Instrument,type PendingOrder,type TradeDraft,type TradeExecution,type TradeIdea,
  type TradeIntent,type TradePreview,type TradeVerification,
} from "../domain/trading.js";
import { constantTimeEqual,personalApprovalProof } from "../domain/approval-proof.js";
import {auditResearchIdea} from "../domain/research.js";
import type { BrokerReader } from "../infra/broker.js";
import { executionPermitted,type Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";
import { BrokerKnownRejection,BrokerOperationUnknown,type BrokerTradePort } from "../infra/trade-gateway.js";

type Pending =
  | {kind:"order";draft:TradeDraft;instrument:Instrument}
  | {kind:"cancel";environment:Environment;orderId:string;ticker:string|null};
type VerificationRecord=
  | {kind:"order";draft:TradeDraft;baselineQuantity:number;at:string}
  | {kind:"cancel";environment:Environment;orderId:string;at:string};
export interface TradeActivity {
  id:string;
  asOf:string;
  environment:Environment;
  action:"order_prepared"|"order_submitted"|"order_rejected"|"order_unknown"|
    "cancel_prepared"|"cancel_submitted"|"cancel_rejected"|"cancel_unknown"|"verification";
  ticker?:string;orderId?:string;detail?:string;
}
function confirmationId():string {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  let out="";for(const b of bytes)out+=b.toString(16).padStart(2,"0");
  return out;
}
function relativeDifference(a:number,b:number):number{
  return Math.abs(a-b)/Math.max(1,Math.abs(b));
}
export class PersonalTradingService {
  constructor(
    readonly config:Configuration,
    private readonly store:StateStore,
    private readonly reader:BrokerReader,
    private readonly broker:BrokerTradePort,
  ) {}
  private assertReal() {
    if(this.config.source!=="trading212")throw new Error("Personal order workflows require real Trading 212 mode; sample data cannot execute trades");
  }
  private async instruments(environment:Environment):Promise<Instrument[]>{
    const key=`v3:instruments:${environment}`;
    const hit=await this.store.get<Instrument[]>(key);
    if(hit)return hit;
    const list=await this.broker.getInstruments(environment);
    await this.store.put(key,list,Date.now()+600_000);
    return list;
  }
  private async snapshot(environment:Environment):Promise<PortfolioSnapshot>{
    this.assertReal();
    const fresh=await this.reader.getPortfolio(environment);
    if(fresh.environment!==environment||fresh.source!=="trading212")
      throw new Error("Broker data environment/provenance mismatch");
    return fresh;
  }
  private limits(){return {
    maxQuantity:this.config.personalTrading.maxQuantity,
    maxNotional:this.config.personalTrading.maxNotional,
    allowUnquotedLiveBuys:this.config.personalTrading.allowUnquotedLiveBuys,
  };}
  async searchInstruments(environment:Environment,query:string,limit=20){
    this.assertReal();
    const q=query.trim().toUpperCase();
    if(!q)throw new Error("Search term required");
    const matches=(await this.instruments(environment))
      .filter(x=>(x.ticker+" "+x.name+" "+x.shortName).toUpperCase().includes(q))
      .slice(0,Math.min(Math.max(limit,1),50));
    return {kind:"instrument_matches",environment,source:"trading212",matches};
  }
  async pendingOrders(environment:Environment){
    this.assertReal();
    const orders=await this.broker.getPendingOrders(environment);
    return {kind:"pending_orders",environment,source:"trading212",orders,
      personalExecutionEnabled:executionPermitted(this.config,environment)};
  }
  async activity(environment:Environment){
    const rows=await this.store.list<TradeActivity>("v3:trading-activity:");
    return {kind:"trading_activity",environment,events:rows.map(row=>row.value)
      .filter(event=>event.environment===environment)
      .sort((a,b)=>b.asOf.localeCompare(a.asOf)).slice(0,50)};
  }
  private async activityEvent(environment:Environment,action:TradeActivity["action"],metadata:Omit<TradeActivity,"id"|"asOf"|"environment"|"action">={}){
    const event:TradeActivity={id:crypto.randomUUID(),asOf:new Date().toISOString(),environment,action,...metadata};
    try{await this.store.put(`v3:trading-activity:${event.asOf}:${event.id}`,event,Date.now()+90*86400_000);}
    catch{ /* Audit write errors must never trigger a second broker write. */ }
  }
  async reviewIntent(intent:TradeIntent){
    const [snapshot,instruments]=await Promise.all([this.snapshot(intent.environment),this.instruments(intent.environment)]);
    const result=resolveTradeIntent(intent,instruments,snapshot,this.limits());
    return {...result,personalExecutionEnabled:executionPermitted(this.config,intent.environment)};
  }
  async tradePlan(environment:Environment,candidates:TradeIdea[]){
    if(candidates.length<1||candidates.length>30)throw new Error("1-30 research candidates required");
    if(this.config.source==="sample")return {
      kind:"trade_plan" as const,environment,source:"sample" as const,
      candidates:candidates.map(x=>({...x,evidence:auditResearchIdea(x),warning:"SYNTHETIC sample mode: no actual broker instrument resolution."})),
      personalExecutionEnabled:false,asOf:new Date().toISOString(),
    };
    const [portfolio,instruments]=await Promise.all([this.snapshot(environment),this.instruments(environment)]);
    const enriched=candidates.map(candidate=>{
      try {
        const i=resolveInstrument(instruments,candidate.ticker||candidate.symbol||candidate.name||"");
        const holding=portfolio.holdings.find(h=>h.ticker===i.ticker);
        return {...candidate,evidence:auditResearchIdea(candidate),resolvedTicker:i.ticker,heldQuantity:holding?.quantity||0,
          availableToSell:holding?.tradableQuantity||0,
          warning:"AI-supplied thesis and scores are not verified broker research."};
      }catch(error){return {...candidate,evidence:auditResearchIdea(candidate),warning:error instanceof Error?error.message:"Cannot resolve broker instrument"};}
    });
    return {kind:"trade_plan" as const,environment,source:"trading212" as const,candidates:enriched,
      personalExecutionEnabled:executionPermitted(this.config,environment),asOf:new Date().toISOString()};
  }
  private async issue(pending:Pending){
    const token=confirmationId();
    const expiresAt=Date.now()+this.config.personalTrading.confirmationTtlSeconds*1000;
    await this.store.put(`v3:trade-confirm:${token}`,pending,expiresAt);
    return {token,expiresAt:new Date(expiresAt).toISOString()};
  }
  async prepareOrder(original:TradeDraft):Promise<TradePreview>{
    this.assertReal();
    const draft={...original,ticker:original.ticker.trim()};
    const [portfolio,instruments]=await Promise.all([this.snapshot(draft.environment),this.instruments(draft.environment)]);
    const instrument=resolveInstrument(instruments,draft.ticker);
    draft.ticker=instrument.ticker;
    const check=checkDraft(draft,instrument,portfolio,this.limits());
    const confirmation=await this.issue({kind:"order",draft,instrument});
    await this.activityEvent(draft.environment,"order_prepared",{ticker:draft.ticker});
    return {kind:"trade_preview",...confirmation,snapshotAt:portfolio.asOf,draft,instrument,
      accountCurrency:check.accountCurrency,estimatedNotional:check.estimatedNotional,
      warnings:check.warnings,environment:draft.environment,
      personalExecutionEnabled:executionPermitted(this.config,draft.environment)};
  }
  async prepareCancel(environment:Environment,orderId:string):Promise<CancelPreview>{
    this.assertReal();
    if(!/^\d{1,20}$/.test(orderId))throw new Error("Invalid order ID");
    const order=await this.broker.getOrder(environment,orderId);
    const confirmation=await this.issue({kind:"cancel",environment,orderId,ticker:order.ticker||null});
    await this.activityEvent(environment,"cancel_prepared",{orderId,ticker:order.ticker});
    return {kind:"cancel_preview",...confirmation,environment,orderId,ticker:order.ticker||null};
  }
  private async approve(environment:Environment,action:"order"|"cancel",token:string,proof:string):Promise<void>{
    if(!executionPermitted(this.config,environment))
      throw new Error(`${environment.toUpperCase()} personal execution is disabled in your private deployment`);
    if(!/^[0-9a-f]{64}$/.test(token)|| !/^[A-Za-z0-9_-]{43}$/.test(proof))
      throw new Error("Invalid execution confirmation");
    const attempts=await this.store.increment("v3:approval-attempts",600_000);
    if(attempts>8)throw new Error("Too many approval attempts; retry after the cooldown");
    const expected=await personalApprovalProof(this.config.personalTrading.approvalSecret,action,token);
    if(!(await constantTimeEqual(proof,expected)))throw new Error("Human execution approval is incorrect");
    await this.store.remove("v3:approval-attempts");
  }
  private async verificationRecord(data:VerificationRecord):Promise<string|undefined>{
    const id=confirmationId();
    try{await this.store.put(`v3:verify:${id}`,data,Date.now()+86400_000);return id;}
    catch{return undefined;}
  }
  async executeOrder(token:string,proof:string,environment:Environment):Promise<TradeExecution>{
    await this.approve(environment,"order",token,proof);
    const lockKey=`v3:broker-write-lock:${environment}`;
    if(!(await this.store.claim(lockKey,token,Date.now()+120_000)))
      throw new Error("Another broker operation is in progress or was recently uncertain. No new write was sent.");
    let pending:Pending|undefined;
    try{
      pending=await this.store.take<Pending>(`v3:trade-confirm:${token}`);
      if(!pending||pending.kind!=="order"||pending.draft.environment!==environment)
        throw new Error("Order confirmation expired or does not match environment");
    }catch(error){
      await this.store.release(lockKey,token).catch(()=>undefined);
      throw error;
    }
    const draft=pending.draft;
    let baselineQuantity=0;
    let indeterminate=false;
    try{
      const portfolio=await this.snapshot(environment);
      const meta=resolveInstrument(await this.instruments(environment),draft.ticker);
      checkDraft(draft,meta,portfolio,this.limits());
      baselineQuantity=portfolio.holdings.find(h=>h.ticker===draft.ticker)?.quantity??0;
      const ack=await this.broker.placeOrder(draft);
      await this.activityEvent(environment,"order_submitted",{ticker:draft.ticker,orderId:ack.orderId});
      return {kind:"trade_execution",environment,operation:"order",status:"submitted",
        message:"Order submitted to Trading 212 once; verify final broker status.",...(ack.orderId?{orderId:ack.orderId}:{})};
    }catch(error){
      if(error instanceof BrokerOperationUnknown){
        indeterminate=true;
        const verificationId=await this.verificationRecord({kind:"order",draft,baselineQuantity,at:new Date().toISOString()});
        await this.activityEvent(environment,"order_unknown",{ticker:draft.ticker});
        return {kind:"trade_execution",environment,operation:"order",status:"unknown",
          message:"Broker write outcome is UNKNOWN. Do not automatically retry.",
          ...(verificationId?{verificationId}:{})};
      }
      await this.activityEvent(environment,"order_rejected",{ticker:draft.ticker});
      return {kind:"trade_execution",environment,operation:"order",status:"rejected",
        message:error instanceof BrokerKnownRejection?error.message:
          "Order could not be validated or submitted. No automatic retry was attempted."};
    }finally{
      // An ambiguous write keeps the account blocked for a bounded cooldown.
      // Neither a failed audit write nor a lock-release error may resend a broker request.
      if(!indeterminate)await this.store.release(lockKey,token).catch(()=>undefined);
    }
  }
  async executeCancel(token:string,proof:string,environment:Environment):Promise<TradeExecution>{
    await this.approve(environment,"cancel",token,proof);
    const lockKey=`v3:broker-write-lock:${environment}`;
    if(!(await this.store.claim(lockKey,token,Date.now()+120_000)))
      throw new Error("Another broker operation is in progress or was recently uncertain. No new write was sent.");
    let pending:Pending|undefined;
    try{
      pending=await this.store.take<Pending>(`v3:trade-confirm:${token}`);
      if(!pending||pending.kind!=="cancel"||pending.environment!==environment)
        throw new Error("Cancellation confirmation expired or does not match environment");
    }catch(error){
      await this.store.release(lockKey,token).catch(()=>undefined);
      throw error;
    }
    let indeterminate=false;
    try{
      await this.broker.getOrder(environment,pending.orderId);
      const result=await this.broker.cancelOrder(environment,pending.orderId);
      await this.activityEvent(environment,"cancel_submitted",{orderId:result.orderId,ticker:pending.ticker??undefined});
      return {kind:"trade_execution",environment,operation:"cancel",status:"submitted",
        message:"Cancellation request sent once. Confirm broker status.",orderId:result.orderId};
    }catch(error){
      if(error instanceof BrokerOperationUnknown){
        indeterminate=true;
        const verificationId=await this.verificationRecord({kind:"cancel",environment,orderId:pending.orderId,at:new Date().toISOString()});
        await this.activityEvent(environment,"cancel_unknown",{orderId:pending.orderId});
        return {kind:"trade_execution",environment,operation:"cancel",status:"unknown",
          message:"Cancellation outcome UNKNOWN. Check broker before retry.",
          orderId:pending.orderId,...(verificationId?{verificationId}:{})};
      }
      await this.activityEvent(environment,"cancel_rejected",{orderId:pending.orderId});
      return {kind:"trade_execution",environment,operation:"cancel",status:"rejected",
        message:"Cancellation could not be validated or accepted by the broker.",orderId:pending.orderId};
    }finally{
      if(!indeterminate)await this.store.release(lockKey,token).catch(()=>undefined);
    }
  }
  async verifyOutcome(id:string,environment:Environment):Promise<TradeVerification>{
    if(!/^[0-9a-f]{64}$/.test(id))throw new Error("Invalid verification ID");
    const record=await this.store.get<VerificationRecord>(`v3:verify:${id}`);
    if(!record|| (record.kind==="order"?record.draft.environment:record.environment)!==environment)
      throw new Error("Unknown/expired verification record or wrong account environment");
    const checkedAt=new Date().toISOString();
    let result:TradeVerification;
    if(record.kind==="order"){
      const [pending,portfolio]=await Promise.all([this.broker.getPendingOrders(environment),this.snapshot(environment)]);
      const uncertainAt=Date.parse(record.at);
      const matching=pending.find(p=>{
        // A pre-existing BUY/SELL of the same size is not proof of this write.
        // Require broker-reported side, type and a valid recent timestamp.
        const created=p.createdAt?Date.parse(p.createdAt):NaN;
        if(!Number.isFinite(uncertainAt)||!Number.isFinite(created)||
           created<uncertainAt-120_000||created>Date.now()+60_000)return false;
        return p.ticker.toUpperCase()===record.draft.ticker.toUpperCase()&&
          p.side?.toUpperCase()===record.draft.side.toUpperCase()&&
          p.type?.toUpperCase().replaceAll("-","_")===record.draft.type.toUpperCase()&&
          relativeDifference(Math.abs(p.quantity),record.draft.quantity)<1e-6;
      });
      const nowQuantity=portfolio.holdings.find(h=>h.ticker===record.draft.ticker)?.quantity??0;
      const change=(nowQuantity-record.baselineQuantity)*(record.draft.side==="buy"?1:-1);
      const status=matching?"matching_pending" as const:
        record.draft.type==="market"&&change>=record.draft.quantity*0.999999?"likely_filled" as const:
        "inconclusive" as const;
      result={kind:"trade_verification",operation:"order",environment,status,checkedAt,ticker:record.draft.ticker,
        message:status==="matching_pending"?"A recent matching pending order is visible (not definitive proof of provenance). Do not submit again without broker reconciliation.":
          status==="likely_filled"?"Position moved as expected, but other activity can cause similar changes; inspect broker history.":
          "No conclusive broker evidence; do not retry automatically."};
    }else{
      try{
        await this.broker.getOrder(environment,record.orderId);
        result={kind:"trade_verification",environment,operation:"cancel",status:"still_pending",checkedAt,
          orderId:record.orderId,message:"Order still visible; broker may still be processing the cancellation."};
      }catch(error){
        if(error instanceof BrokerKnownRejection && error.status===404){
          result={kind:"trade_verification",environment,operation:"cancel",status:"no_longer_pending",checkedAt,
            orderId:record.orderId,message:"Order no longer pending; verify whether it filled or cancelled in broker history."};
        }else throw error;
      }
    }
    await this.activityEvent(environment,"verification",{orderId:result.orderId,ticker:result.ticker,detail:result.status});
    return result;
  }
}
