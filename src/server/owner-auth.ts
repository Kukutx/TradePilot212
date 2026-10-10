import { constantTimeEqual } from "../domain/approval-proof.js";
import type { Configuration } from "../infra/config.js";
import type { StateStore } from "../infra/state.js";

const encoder = new TextEncoder();
const COOKIE_AGE_SECONDS = 12 * 3600;
const SESSION_PREFIX = "v3:owner-session:";
export interface OwnerSession {
  csrf: string;
  expiresAt: number;
}
function randomToken(): string {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function hashToken(value:string):Promise<string> {
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value)));
  return [...digest].map(b=>b.toString(16).padStart(2,"0")).join("");
}
export class OwnerAuthentication {
  private readonly cookieName: string;
  constructor(
    private readonly store:StateStore,
    private readonly config:Configuration,
  ) {
    this.cookieName=config.publicOrigin.startsWith("https://")?"__Host-tp212owner":"tp212owner_local";
  }
  private cookie(value:string,maxAge:number){
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.cookieName.startsWith("__Host")?"; Secure":""}`;
  }
  private extract(header:string|undefined):string|null {
    const value=header?.split(";").map(x=>x.trim()).find(part=>part.startsWith(this.cookieName+"="))
      ?.slice(this.cookieName.length+1);
    return value && /^[a-f0-9]{64}$/.test(value)?value:null;
  }
  async login(password:string) {
    const attempts=await this.store.increment("v3:owner-login-attempts",15*60_000);
    if(attempts>10)throw new Error("Owner login temporarily rate-limited");
    if(typeof password!=="string" || password.length>4096 ||
       !(await constantTimeEqual(password,this.config.ownerPassword)))
      return null;
    await this.store.remove("v3:owner-login-attempts");
    const secret=randomToken();
    const expiresAt=Date.now()+COOKIE_AGE_SECONDS*1000;
    const session:OwnerSession={csrf:randomToken(),expiresAt};
    await this.store.put(SESSION_PREFIX+await hashToken(secret),session,expiresAt);
    return {session, setCookie:this.cookie(secret,COOKIE_AGE_SECONDS)};
  }
  async get(cookieHeader:string|undefined):Promise<OwnerSession|null> {
    const token=this.extract(cookieHeader);
    if(!token)return null;
    const saved=await this.store.get<OwnerSession>(SESSION_PREFIX+await hashToken(token));
    return saved && saved.expiresAt>Date.now()?saved:null;
  }
  async verifyCsrf(session:OwnerSession,value:string|undefined):Promise<boolean> {
    return typeof value==="string" && /^[a-f0-9]{64}$/.test(value) &&
      await constantTimeEqual(session.csrf,value);
  }
  async logout(cookieHeader:string|undefined):Promise<string> {
    const token=this.extract(cookieHeader);
    if(token)await this.store.remove(SESSION_PREFIX+await hashToken(token));
    return this.cookie("",0);
  }
}
