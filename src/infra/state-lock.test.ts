import { describe,expect,it } from "vitest";
import { MemoryStore } from "./state.js";
describe("atomic single-owner brokerage write leases",()=>{
  it("grants exactly one concurrent claimant",async()=>{
    const store=new MemoryStore();
    const results=await Promise.all(Array.from({length:12},(_,i)=>
      store.claim("v3:broker-write-lock:demo",`token-${i}`,Date.now()+120_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner=results.findIndex(Boolean);
    expect(await store.release("v3:broker-write-lock:demo","wrong-token")).toBe(false);
    expect(await store.claim("v3:broker-write-lock:demo","another",Date.now()+120_000)).toBe(false);
    expect(await store.release("v3:broker-write-lock:demo",`token-${winner}`)).toBe(true);
    expect(await store.claim("v3:broker-write-lock:demo","another",Date.now()+120_000)).toBe(true);
  });
  it("separates Demo and Live leases",async()=>{
    const store=new MemoryStore();
    expect(await store.claim("v3:broker-write-lock:demo","a",Date.now()+120_000)).toBe(true);
    expect(await store.claim("v3:broker-write-lock:live","b",Date.now()+120_000)).toBe(true);
  });
  it("rejects invalid TTL or empty owner",async()=>{
    const store=new MemoryStore();
    await expect(store.claim("lock","",Date.now()+1000)).rejects.toThrow();
    await expect(store.claim("lock","token",Date.now()-100)).rejects.toThrow();
  });
});
