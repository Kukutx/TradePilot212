import type { Configuration } from "./config.js";

export interface NotificationPayload {
  environment:"demo"|"live";
  day:string;
  reviewCount:number;
  lines:string[];
  source:"trading212";
}
export interface Notifier {
  configured():boolean;
  send(payload:NotificationPayload):Promise<{sent:boolean;provider:string}>;
}
export class NoopNotifier implements Notifier {
  configured(){return false;}
  async send(){return {sent:false,provider:"none"};}
}
/** Fixed HTTPS provider endpoint; never forward API keys, auth or broker data to untrusted URLs. */
export class ResendEmailNotifier implements Notifier {
  constructor(private readonly config:Configuration,private readonly fetcher:typeof fetch=fetch){}
  configured(){return this.config.notifications.provider==="resend";}
  async send(payload:NotificationPayload){
    if(!this.config.notifications.key || this.config.notifications.provider!=="resend")
      throw new Error("Resend is not configured");
    const subject=`TradePilot 212 ${payload.environment.toUpperCase()} · ${payload.reviewCount} observations (${payload.day})`;
    const message=[
      "This personal portfolio report contains only read-only threshold observations.",
      "Source: Trading 212 · " + payload.environment.toUpperCase(),
      "Local day: "+payload.day,
      ...payload.lines.map(s=>s.slice(0,320)),
      "No order was executed. Log in to your private Owner Console to inspect underlying evidence.",
    ].join("\n");
    let response:Response;
    try{
      response=await this.fetcher("https://api.resend.com/emails",{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(10_000),
        headers:{
          Authorization:`Bearer ${this.config.notifications.key}`,
          "Content-Type":"application/json",Accept:"application/json",
        },
        body:JSON.stringify({
          from:this.config.notifications.from,to:[this.config.notifications.to],
          subject,text:message,
        }),
      });
    }catch{
      throw new Error("Notification transport uncertain; no automatic resend");
    }
    if(!response.ok)throw new Error(`Email provider rejected notification (HTTP ${response.status})`);
    return {sent:true,provider:"resend"};
  }
}
export function createNotifier(config:Configuration,fetcher:typeof fetch=fetch):Notifier{
  return config.notifications.provider==="resend"
    ? new ResendEmailNotifier(config,fetcher):new NoopNotifier();
}
