/** Standalone, same-origin owner experience: no AI host, vendor CDN, or analytics. */
const css=String.raw`
:root{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;background:#101821;color:#e9f0f5;line-height:1.5}
main{max-width:1090px;margin:0 auto;padding:26px 18px 60px}
h1,h2,h3,p{margin-top:0}h1{font-size:clamp(23px,3vw,34px);letter-spacing:-.045em}
h2{font-size:18px;margin-bottom:14px}h3{font-size:14px}
small,.muted{color:#a5b5c4}small{font-size:11px}
.brand{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 25px}
.mark{display:inline-flex;width:42px;height:42px;border-radius:12px;background:#114a40;align-items:center;justify-content:center;color:#9ff3d6;font-weight:800}
.tag{font-size:11px;background:#183b32;border:1px solid #2d6c59;border-radius:40px;padding:6px 11px}
.tag.live{background:#50252a;border-color:#ac454d;color:#ffdcde}
section,.panel{background:#182430;border:1px solid #334457;border-radius:18px;padding:22px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
#loginView{max-width:460px;margin:9vh auto}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.stack{display:grid;gap:16px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
label{display:grid;gap:6px;font-size:12px;color:#c5d2dc}
input,select,button{font:inherit;font-size:14px;border-radius:10px;padding:11px 12px}
input,select{width:100%;background:#101b25;border:1px solid #40566b;color:#e9f0f5}
input:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #74d6ba;outline-offset:2px}
button{background:#207b66;border:1px solid #31937b;color:white;font-weight:650;cursor:pointer}
button.secondary{background:#213244;border-color:#455c72}
button.danger{background:#a43038;border-color:#d7515c}
button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.row>div{min-width:0}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.metric{border:1px solid #354a5e;border-radius:12px;padding:15px}
.metric strong{display:block;font-size:clamp(16px,2vw,26px);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.metric small{display:block;margin-bottom:7px}
.feed{display:grid;gap:10px}
.feed article{padding:12px;border:1px solid #3d5162;border-radius:12px}
.feed article p{margin:5px 0 0;font-size:12px}
.feed article.review{border-left:3px solid #c88e4a}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin:13px 0}
.notice{border:1px solid #795b31;border-radius:11px;background:#392e23;padding:12px;margin-top:10px;font-size:12px}
.notice.error{background:#522a31;border-color:#ba4f5c}
.pendingItem{padding:10px 0;border-top:1px solid #334457;display:flex;justify-content:space-between;align-items:center;gap:10px}
.pendingItem small{display:block}
.output{padding:14px;border:1px solid #435a6e;border-radius:11px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:13px}
.actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px;margin-top:15px}
[hidden]{display:none!important}
footer{font-size:11px;color:#a5b5c4;text-align:center;margin-top:24px}
@media(max-width:710px){main{padding:12px}.grid,.fields,.cards{grid-template-columns:1fr}.brand{margin:0 0 14px}.panel,section{padding:15px}}

.settingsGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.checkSetting{display:flex;align-items:center;gap:9px}
.checkSetting input{width:18px;height:18px}
.researchOutput{font-size:12px;line-height:1.6;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word}
@media(max-width:710px){.settingsGrid{grid-template-columns:1fr}}
`;
const js=String.raw`
(function(){
  "use strict";
  var csrf="",snapshot=null,draft=null,preview=null,environment="demo",busy=false;
  var q=function(id){return document.getElementById(id);};
  var text=function(id,value){q(id).textContent=String(value===null||value===undefined?"—":value);};
  var show=function(id,on){q(id).hidden=!on;};
  function fail(err){text("status",err instanceof Error?err.message:String(err));show("status",true);}
  function money(v,c){
    if(typeof v!=="number"||!Number.isFinite(v))return "—";
    try{return new Intl.NumberFormat(undefined,{style:"currency",currency:c,maximumFractionDigits:2}).format(v);}
    catch{return String(v);}
  }
  async function api(path,payload){
    var post=payload!==undefined;
    var response=await fetch(path,{
      method:post?"POST":"GET",credentials:"same-origin",
      headers:post?{"Content-Type":"application/json","X-Owner-CSRF":csrf}:{},
      ...(post?{body:JSON.stringify(payload)}:{})
    });
    var data=await response.json();
    if(!response.ok)throw new Error(data.error||"Operation unavailable");
    return data;
  }
  function item(label,detail,priority){
    var row=document.createElement("article");row.className=priority||"";
    var heading=document.createElement("strong");heading.textContent=label;row.appendChild(heading);
    var p=document.createElement("p");p.textContent=detail;row.appendChild(p);return row;
  }
  function setEnvironment(value){
    environment=value;draft=null;preview=null;
    q("draftPane").hidden=true;q("confirmPane").hidden=true;
    q("liveNotice").hidden=environment!=="live";
  }
  async function loadOverview(){
    var data=await api("/owner/api/overview?environment="+encodeURIComponent(environment));
    snapshot=data;var p=data.portfolio;
    text("balance",money(p.account.totalValue,p.account.currency));
    text("cash",money(p.account.availableCash,p.account.currency));
    text("positions",p.holdings.length);
    text("observed",p.asOf+" · "+p.source.toUpperCase());
    var feed=q("feed");feed.replaceChildren();
    var alerts=data.center.items;
    if(!alerts.length)feed.appendChild(item("No numeric alert triggered","This does not prove the account has no investment risks.",""));
    alerts.forEach(function(a){feed.appendChild(item(a.title.zh,a.detail.zh,a.priority));});
    var pending=q("pending");pending.replaceChildren();
    if(data.pending.kind==="pending_unavailable")pending.appendChild(item("Orders unavailable",data.pending.message,"review"));
    else if(!data.pending.orders.length)pending.appendChild(item("No pending orders","This is a read-only broker observation.",""));
    else data.pending.orders.forEach(function(order){
      var row=document.createElement("div");row.className="pendingItem";
      var info=document.createElement("div");
      var title=document.createElement("strong");title.textContent=(order.ticker||"—")+" · "+(order.side||"?");
      var description=document.createElement("small");
      description.textContent="#"+order.id+" · "+(order.status||"unknown")+" · "+String(order.quantity)+" shares";
      info.append(title,description);row.appendChild(info);
      var btn=document.createElement("button");btn.type="button";btn.className="secondary";
      btn.textContent="撤单审查";btn.disabled=!data.executionEnabled;
      btn.addEventListener("click",function(){void run(async function(){
        preview=await api("/owner/api/cancel/prepare",{environment:environment,orderId:order.id});
        renderConfirmation();
      });});
      row.appendChild(btn);pending.appendChild(row);
    });
    q("tradeEnabled").textContent=data.executionEnabled?"可人工确认交易":"仅供审查（交易已禁用）";
  }
  async function run(fn){
    if(busy)return;busy=true;text("status","正在读取／核验……");show("status",true);
    try{await fn();}catch(err){fail(err);}finally{busy=false;}
  }
  function parseIntent(){
    var mode=q("sizing").value;
    var size=q("size").value.trim();
    if(mode!=="all_available" && (!size||!Number.isFinite(Number(size))||Number(size)<=0))
      throw new Error("请填写合法的数量、金额或比例。");
    if(!q("instrument").value.trim())throw new Error("请输入 Trading 212 标的代码或公司名称。");
    var sizing={mode:mode};
    if(mode==="quantity")sizing.quantity=Number(size);
    if(mode==="notional"){sizing.amount=Number(size);if(q("currency").value.trim())sizing.currency=q("currency").value.trim().toUpperCase();}
    if(mode==="cash_percent"||mode==="position_percent")sizing.percent=Number(size);
    if((mode==="notional"||mode==="cash_percent")&&q("fx").value.trim())
      sizing.fxToQuote=Number(q("fx").value);
    var intent={environment:environment,instrument:q("instrument").value.trim(),
      side:q("side").value,type:q("orderType").value,sizing:sizing};
    if(q("limit").value.trim())intent.limitPrice=Number(q("limit").value);
    if(q("stop").value.trim())intent.stopPrice=Number(q("stop").value);
    if(q("reference").value.trim())intent.referencePrice=Number(q("reference").value);
    return intent;
  }
  function renderDraft(){
    if(!draft)return;
    show("draftPane",true);show("confirmPane",false);
    text("draftText",draft.ticker+" · "+draft.side.toUpperCase()+" · "+draft.type+
      " · "+draft.quantity+" shares"+
      (draft.limitPrice?" · Limit "+draft.limitPrice:"")+
      (draft.stopPrice?" · Stop "+draft.stopPrice:""));
  }
  function renderConfirmation(){
    if(!preview)return;
    show("draftPane",false);show("confirmPane",true);
    var summary=preview.kind==="trade_preview"
      ?preview.draft.ticker+" · "+preview.draft.side+" · "+preview.draft.type+
        " · "+preview.draft.quantity+" shares · "+String(preview.estimatedNotional||"unknown")+" estimated notional"
      :"Cancel pending order #"+preview.orderId;
    text("previewText",(environment==="live"?"LIVE REAL MONEY\n":"DEMO\n")+summary+
      "\nExpires "+preview.expiresAt+
      "\n"+(preview.warnings||[]).join("\n"));
    show("liveWord",environment==="live");
    q("liveConfirm").value="";
    q("approval").value="";
  }
  async function sign(secret,action,token){
    var enc=new TextEncoder();
    var key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    var data=new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode("tradepilot-v3-personal:"+action+":"+token)));
    var raw="";data.forEach(function(byte){raw+=String.fromCharCode(byte);});
    return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  async function confirm(){
    if(!preview)return;
    if(!snapshot||!snapshot.executionEnabled)throw new Error("服务器当前未允许此账户执行交易。");
    if(environment==="live"&&q("liveConfirm").value.trim()!=="LIVE")
      throw new Error("Live 真实资金交易必须输入 LIVE 才可继续。");
    var secret=q("approval").value;
    q("approval").value="";
    if(secret.length<24)throw new Error("请输入独立的个人交易批准密钥。");
    var action=preview.kind==="trade_preview"?"order":"cancel";
    var proof=await sign(secret,action,preview.token);secret="";
    var result=await api(action==="order"?"/owner/api/execute":"/owner/api/cancel/execute",
      {environment:environment,token:preview.token,proof:proof});
    // Never auto-retry a possibly completed broker write, including lost responses.
    preview=null;show("confirmPane",false);
    text("status",result.status.toUpperCase()+" — "+result.message);
    if(result.verificationId){
      show("verifyBtn",true);
      q("verifyBtn").dataset.verificationId=result.verificationId;
    }
    await loadOverview().catch(function(){});
  }
  function authenticated(session){
    csrf=session.csrf;show("loginView",false);show("ownerView",true);
    q("demoOption").disabled=false;
    q("liveOption").disabled=false;
  }
  async function startup(){
    try{var session=await api("/owner/api/me");authenticated(session);
      await loadOverview();}
    catch{show("loginView",true);show("ownerView",false);}
  }
  q("loginForm").addEventListener("submit",function(e){e.preventDefault();
    void run(async function(){
      var password=q("ownerPassword").value;q("ownerPassword").value="";
      var session=await api("/owner/api/login",{password:password});password="";
      authenticated(session);await loadOverview();
    });
  });
  q("environment").addEventListener("change",function(){setEnvironment(this.value);void run(loadOverview);});
  q("reload").addEventListener("click",function(){void run(loadOverview);});
  q("logout").addEventListener("click",function(){void run(async function(){
    await api("/owner/api/logout",{});csrf="";snapshot=null;draft=null;preview=null;
    show("ownerView",false);show("loginView",true);show("status",false);
  });});
  q("review").addEventListener("click",function(){void run(async function(){
    var reviewed=await api("/owner/api/review",parseIntent());
    draft=reviewed.draft;renderDraft();
  });});
  q("prepare").addEventListener("click",function(){void run(async function(){
    if(!draft)throw new Error("请先审查草稿");
    preview=await api("/owner/api/prepare",draft);renderConfirmation();
  });});
  q("send").addEventListener("click",function(){void run(confirm);});
  q("back").addEventListener("click",function(){show("confirmPane",false);show("draftPane",true);q("approval").value="";});
  q("verifyBtn").addEventListener("click",function(){void run(async function(){
    var id=q("verifyBtn").dataset.verificationId;
    var result=await api("/owner/api/verify?environment="+environment+"&id="+encodeURIComponent(id));
    text("status",result.status.toUpperCase()+" — "+result.message);
  });});
  void startup();
})();
`;
function digestBase64(bytes:Uint8Array):string{
  let data=""; for(const b of bytes)data+=String.fromCharCode(b);
  return btoa(data);
}
async function hash(value:string):Promise<string>{
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return digestBase64(new Uint8Array(digest));
}
export async function renderOwnerPage():Promise<{html:string;csp:string}>{
  const [scriptHash,styleHash]=await Promise.all([hash(js),hash(css)]);
  const csp=[
    "default-src 'none'","base-uri 'none'","object-src 'none'",
    "form-action 'self'","connect-src 'self'","img-src 'none'",
    "frame-ancestors 'none'",`script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
  ].join("; ");
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>TradePilot 212 Personal · Owner Console</title>
  <style>${css}</style></head><body><main>
    <div class="brand"><div class="toolbar"><span class="mark">TP</span>
      <span><strong>TradePilot 212</strong><br><small>Personal Owner Console</small></span></div>
      <span class="tag">自托管 · 独立于 ChatGPT / Claude</span></div>
    <section id="loginView" hidden><h1>解锁个人投资工作台</h1>
      <p class="muted">仅使用你的自托管管理员密码。Trading 212 密钥和交易批准密钥不可粘贴到 AI 对话。</p>
      <form id="loginForm"><label>管理员密码
        <input id="ownerPassword" type="password" minlength="24" autocomplete="current-password" required></label>
        <div class="actions"><button type="submit">安全登录</button></div></form></section>
    <div id="ownerView" class="stack" hidden>
      <header><div><h1>我的投资组合</h1><p class="muted">券商数据与个人执行路径分离，所有订单需要本人独立确认。</p></div>
        <div class="toolbar"><label>账户环境
          <select id="environment"><option id="demoOption" value="demo">DEMO</option>
            <option id="liveOption" value="live">LIVE</option></select></label>
          <button id="reload" class="secondary" type="button">刷新</button>
          <button id="logout" class="secondary" type="button">退出</button></div></header>
      <p id="liveNotice" class="notice" hidden>LIVE 涉及真实资金；即使 AI 建议交易，也必须本人复核数量、价格、币种及订单类型。</p>
      <section><div class="row"><h2>账户概览</h2><small id="observed">—</small></div>
        <div class="cards"><div class="metric"><small>账户总值</small><strong id="balance">—</strong></div>
          <div class="metric"><small>可用现金</small><strong id="cash">—</strong></div>
          <div class="metric"><small>持仓数量</small><strong id="positions">—</strong></div></div></section>
      <div class="grid">
        <section><h2>今日重点</h2><div id="feed" class="feed"></div></section>
        <section><h2>券商待处理订单</h2><div id="pending"></div></section>
      </div>
      <section class="stack"><header><h2>仅由本人确认的私人交易</h2><span id="tradeEnabled" class="tag">—</span></header>
        <p class="muted">先审查草稿，再从 Trading 212 实时数据复核；不同聊天宿主不会影响此工作台。</p>
        <div class="fields">
          <label>券商代码或公司名称<input id="instrument" placeholder="例如 AAPL / Apple" autocomplete="off"></label>
          <label>方向<select id="side"><option value="buy">买入</option><option value="sell">卖出</option></select></label>
          <label>订单类型<select id="orderType"><option value="market">Market</option><option value="limit">Limit</option>
            <option value="stop">Stop</option><option value="stop_limit">Stop-Limit</option></select></label>
          <label>数量输入方式<select id="sizing"><option value="quantity">准确股数</option>
            <option value="notional">目标金额</option><option value="cash_percent">可用现金%</option>
            <option value="position_percent">已持仓%</option><option value="all_available">卖出全部可交易</option></select></label>
          <label>数量／金额／百分比<input id="size" type="number" min="0" step="any" placeholder="由本人填写"></label>
          <label>输入币种（可选）<input id="currency" maxlength="3" placeholder="USD / EUR"></label>
          <label>外部 FX 转换率（可选）<input id="fx" type="number" min="0" step="any" placeholder="不是实时行情"></label>
          <label>限价（需要时）<input id="limit" type="number" min="0" step="any"></label>
          <label>止损触发价（需要时）<input id="stop" type="number" min="0" step="any"></label>
          <label>参考价（仅估算）<input id="reference" type="number" min="0" step="any"></label>
        </div>
        <div class="actions"><button id="review" type="button" class="secondary">1 · 审查订单草稿（不提交）</button></div>
        <div class="panel" id="draftPane" hidden><h3>审查后的精确订单</h3><p id="draftText" class="output"></p>
          <div class="actions"><button id="prepare" type="button">2 · 重新核对与准备确认</button></div></div>
        <div class="panel" id="confirmPane" hidden><h3>最终人工确认</h3><p id="previewText" class="output"></p>
          <p class="notice">确认时，批准密钥只在本页通过 WebCrypto 生成一次性 HMAC；服务端不接收密钥原文。</p>
          <label>独立批准密钥<input id="approval" type="password" autocomplete="off" spellcheck="false"></label>
          <label id="liveWord" hidden>Live 真实资金：输入 LIVE<input id="liveConfirm" type="text" autocomplete="off" aria-label="输入 LIVE 以确认真实资金风险"></label>
          <div class="actions"><button id="back" type="button" class="secondary">返回审查</button>
            <button id="send" type="button" class="danger">3 · 本人明确确认并提交一次</button></div></div>
      </section>
      <section class="stack" aria-labelledby="preferencesHeading">
        <header><div><h2 id="preferencesHeading">个性化与自动简报</h2>
          <p class="muted">设置仅保存在私人实例；定时扫描只读取券商。邮件必须另外配置经过验证的发件账户。</p></div></header>
        <div class="settingsGrid">
          <label>偏好语言<select id="prefLocale"><option value="zh">中文</option><option value="en">English</option></select></label>
          <label>默认环境<select id="prefEnvironment"><option value="demo">DEMO</option><option value="live">LIVE</option></select></label>
          <label>IANA 时区<input id="prefTimezone" value="UTC" autocomplete="off" placeholder="Europe/Rome"></label>
          <label>每日简报时刻（当地小时 0–23）<input id="prefHour" type="number" min="0" max="23" value="8"></label>
          <label class="checkSetting"><input id="prefDaily" type="checkbox">启用只读每日简报</label>
          <label class="checkSetting"><input id="prefOnChange" type="checkbox" checked>只在重要变化时通知</label>
          <label class="checkSetting"><input id="prefLive" type="checkbox">同时关注 Live 账户</label>
          <label class="checkSetting"><input id="prefEmail" type="checkbox">可选邮件推送（必须已配置发件服务）</label>
        </div>
        <p class="muted" id="providerStatus">邮件提供商状态：读取中</p>
        <div class="actions"><button id="setupWatch" type="button" class="secondary">一键配置基础只读监测</button>
          <button id="savePrefs" type="button">保存个人偏好</button></div>
        <div class="panel"><div class="row"><h3>近期自动简报</h3>
          <button id="loadReports" class="secondary" type="button">查看记录</button></div>
          <div id="reports" class="feed"></div></div>
      </section>
      <section class="stack" aria-labelledby="researchHeading">
        <h2 id="researchHeading">可信研究来源（只读，不替代券商成交报价）</h2>
        <p class="muted">ECB 汇率是历史参考值；SEC 是正式申报原始文件；行情报价需要独立配置 Twelve Data Key。默认不会自动带入真实订单。</p>
        <div class="settingsGrid">
          <label>ECB 原始币种<input id="fxFrom" value="EUR" maxlength="3"></label>
          <label>ECB 目标币种<input id="fxTo" value="USD" maxlength="3"></label>
          <label>SEC 美国公司代码<input id="secSymbol" placeholder="AAPL" autocomplete="off"></label>
          <label>行情代码<input id="quoteSymbol" placeholder="AAPL" autocomplete="off"></label>
          <label>预期币种<input id="quoteCurrency" placeholder="USD" maxlength="3"></label>
          <label>交易所（可选）<input id="quoteExchange" placeholder="NASDAQ"></label>
        </div>
        <div class="actions">
          <button id="getFx" class="secondary" type="button">查看 ECB 汇率</button>
          <button id="getSec" class="secondary" type="button">查看 SEC 申报</button>
          <button id="getQuote" class="secondary" type="button">查看供应商报价</button>
        </div>
        <pre id="researchOutput" class="output researchOutput" aria-live="polite">选择一个研究来源。</pre>
      </section>
      <div id="status" class="notice" role="status" aria-live="polite" hidden></div>
      <div class="actions"><button id="verifyBtn" type="button" class="secondary" hidden>只读核对上次不明确的券商结果</button></div>
    </div>
    <footer>Source & timestamp disclosed · No model-autonomous broker writes · Personal single-owner instance</footer>
  </main><script>${js}</script></body></html>`;
  return {html,csp};
}
