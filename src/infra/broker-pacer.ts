import type { Environment } from "../domain/types.js";
import type { StateStore } from "./state.js";

/**
 * Broker API quotas are PER ACCOUNT, shared across API keys and concurrent hosts.
 * Reservations are atomic in the single-owner StateStore (Node or Durable Object).
 * Every broker request, including GET retries and personal writes, reserves a slot.
 */
export type BrokerBucket =
  | "account" | "positions" | "instruments" | "pending" | "order-detail"
  | "history-orders" | "market-write" | "conditional-write" | "cancel-write";
export const BROKER_MIN_INTERVAL_MS: Record<BrokerBucket, number> = {
  account: 5_100, positions: 1_100, instruments: 51_000,
  pending: 5_100, "order-detail": 1_100, "history-orders": 10_500,
  "market-write": 1_500, "conditional-write": 2_200, "cancel-write": 2_200,
};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class BrokerPacer {
  constructor(
    private readonly state:StateStore,
    private readonly now:()=>number=Date.now,
    private readonly wait:(ms:number)=>Promise<void>=sleep,
  ) {}
  async pace(environment:Environment,bucket:BrokerBucket):Promise<void>{
    const maxDelay = bucket==="instruments" ? 60_000 : 15_000;
    const now=this.now();
    const slot=await this.state.reserve(
      `v3:broker-quota:${environment}:${bucket}`,
      BROKER_MIN_INTERVAL_MS[bucket],now,maxDelay,
    );
    if(slot===null)throw new Error(`Trading 212 ${bucket} request quota is busy; no broker request was sent. Retry manually later.`);
    if(slot>now)await this.wait(slot-now);
  }
}
