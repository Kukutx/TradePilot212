import {describe,expect,it,vi} from "vitest";
import {MemoryStore} from "./state.js";
import {BrokerPacer} from "./broker-pacer.js";

describe("per-environment atomic Trading 212 pacing",()=>{
  it("serializes concurrent same-endpoint slots without real sleeping",async()=>{
    const store=new MemoryStore();
    const waited:number[]=[];
    const pacing=new BrokerPacer(store,()=>100_000,async ms=>{waited.push(ms);});
    await Promise.all([
      pacing.pace("demo","account"),
      pacing.pace("demo","account"),
      pacing.pace("demo","account"),
      pacing.pace("live","account"),
    ]);
    expect(waited.sort((a,b)=>a-b)).toEqual([5_100,10_200]);
  });
  it("fails before any transport request if backlog is unsafe",async()=>{
    const store=new MemoryStore();
    const pacing=new BrokerPacer(store,()=>100_000,async()=>{});
    for(let i=0;i<3;i++)await pacing.pace("demo","account");
    await expect(pacing.pace("demo","account")).rejects.toThrow(/quota is busy/);
    // Failed reservation did not extend the backlog.
    const allocated=await store.reserve("v3:broker-quota:demo:account",5_100,100_000,20_000);
    expect(allocated).toBe(115_300);
  });
  it("preserves independent instrument and market-write quotas",async()=>{
    const store=new MemoryStore(), waits:number[]=[];
    const pacing=new BrokerPacer(store,()=>200_000,async ms=>{waits.push(ms);});
    await pacing.pace("demo","instruments");
    await pacing.pace("demo","market-write");
    await pacing.pace("demo","market-write");
    expect(waits).toEqual([1_500]);
    expect(await store.reserve("v3:broker-quota:demo:instruments",51_000,200_000,60_000)).toBe(251_000);
  });
});
