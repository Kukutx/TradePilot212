import {describe,expect,it,vi} from "vitest";
import {readConfiguration} from "./config.js";
import {createNotifier} from "./notification.js";
const base={
  OWNER_PASSWORD:"owner-password-is-long-enough-123",
  JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3),
};
describe("opt-in verified-provider notifications",()=>{
  it("is disabled by default and never makes network calls",async()=>{
    const fetcher=vi.fn();
    const notify=createNotifier(readConfiguration(base),fetcher as typeof fetch);
    expect(notify.configured()).toBe(false);
    expect((await notify.send({environment:"demo",day:"2026-10-10",reviewCount:1,
      source:"trading212",lines:["risk"]})).sent).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires sender/recipient addresses, never silently enables email",()=>{
    expect(()=>readConfiguration({...base,NOTIFY_PROVIDER:"resend",
      RESEND_API_KEY:"resend_example_test_key"})).toThrow(/requires/);
  });
  it("uses one fixed provider origin with a bounded privacy-first text payload",async()=>{
    const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>
      new Response(JSON.stringify({id:"email-test"}),{status:200}));
    const config=readConfiguration({...base,NOTIFY_PROVIDER:"resend",
      RESEND_API_KEY:"resend_test_api_key_abcdefgh",
      NOTIFY_FROM:"alerts@example.org",NOTIFY_TO:"owner@example.org"});
    const notifier=createNotifier(config,fetcher as typeof fetch);
    const done=await notifier.send({
      environment:"demo",day:"2026-10-10",reviewCount:2,
      source:"trading212",lines:["High concentration","Low cash"],
    });
    expect(done).toEqual({sent:true,provider:"resend"});
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,init]=fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string,string>).Authorization).toMatch(/^Bearer resend_/);
    const message=JSON.parse(String(init.body)) as {subject:string;text:string};
    expect(message.subject).toContain("DEMO");
    expect(message.text).toContain("No order was executed");
    expect(message.text).not.toContain("resend_test_api_key");
  });
});
