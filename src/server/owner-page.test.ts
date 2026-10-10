import {describe,expect,it} from "vitest";
import {Script} from "node:vm";
import {renderOwnerPage} from "./owner-page.js";

describe("Owner Console independent browser delivery",()=>{
  it("is syntactically valid standalone JavaScript with no third-party CDN",async()=>{
    const {html,csp}=await renderOwnerPage();
    const script=/<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(()=>new Script(script!)).not.toThrow();
    expect(html).toContain('id="loginForm"');
    expect(html).toContain('id="confirmPane"');
    expect(html).toContain('id="prefTimezone"');
    expect(html).toContain('id="quoteSymbol"');
    expect(html).toContain('id="liveConfirm"');
    expect(html).not.toMatch(/https:\/\/[^\s"]+\.js/);
    expect(csp).toContain("frame-ancestors 'none'");
  });
  it("pins exact script/style bytes with a hash-based CSP",async()=>{
    const {html,csp}=await renderOwnerPage();
    for(const tag of ["script","style"] as const){
      const match=new RegExp("<"+tag+">([\\s\\S]*?)<\\/"+tag+">").exec(html);
      expect(match).not.toBeNull();
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(match![1]!));
      const encoded=Buffer.from(bytes).toString("base64");
      expect(csp).toContain(`'sha256-${encoded}'`);
    }
    expect(csp).not.toContain("'unsafe-inline'");
  });
  it("ships an independent WebCrypto approval algorithm rather than forwarding raw secrets",async()=>{
    const {html}=await renderOwnerPage();
    expect(html).toContain("crypto.subtle.sign");
    expect(html).toContain("tradepilot-v3-personal:");
    expect(html).toContain('q("approval").value=""');
    expect(html).toContain('q("liveConfirm").value.trim()');
    expect(html).not.toContain("eval(");
  });
});
