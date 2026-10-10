import {describe,expect,it} from "vitest";
import {MemoryStore} from "../infra/state.js";
import {defaultPreferences,OwnerPreferencesStore,preferencesSchema,zonedHourAndDate} from "./preferences.js";
describe("private owner preferences",()=>{
  it("defaults to read-only monitoring disabled and no email opt-in",async()=>{
    const prefs=await new OwnerPreferencesStore(new MemoryStore(),"demo").get();
    expect(prefs.defaultEnvironment).toBe("demo");
    expect(prefs.dailyBrief.enabled).toBe(false);
    expect(prefs.dailyBrief.email).toBe(false);
    expect(prefs.dailyBrief.includeLive).toBe(false);
  });
  it("persists only strict validated preferences and rejects non-IANA zones",async()=>{
    const store=new OwnerPreferencesStore(new MemoryStore());
    await expect(store.save({...defaultPreferences(),timezone:"Mars/Olympus"}))
      .rejects.toThrow();
    await expect(store.save({...defaultPreferences(),dailyBrief:{...defaultPreferences().dailyBrief,hour:24}}))
      .rejects.toThrow();
    await expect(store.save({...defaultPreferences(),approvalSecret:"forbidden"}))
      .rejects.toThrow();
    const updated={...defaultPreferences(),timezone:"Europe/Rome",
      dailyBrief:{...defaultPreferences().dailyBrief,enabled:true,hour:8}};
    expect(await store.save(updated)).toEqual(updated);
    expect(await store.get()).toEqual(updated);
    expect(preferencesSchema.safeParse(updated).success).toBe(true);
  });
  it("uses the owner time zone for schedule, not UTC guessing",()=>{
    expect(zonedHourAndDate(new Date("2026-07-10T06:00:00Z"),"Europe/Rome"))
      .toEqual({day:"2026-07-10",hour:8});
    expect(zonedHourAndDate(new Date("2026-12-10T07:00:00Z"),"Europe/Rome"))
      .toEqual({day:"2026-12-10",hour:8});
  });
});
