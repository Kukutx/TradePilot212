import { describe,expect,it,vi } from "vitest";
import { readConfiguration } from "../infra/config.js";
import { MemoryStore } from "../infra/state.js";
import { lookupClient,permittedClient,validateClientDocument } from "./client-metadata.js";
const config=readConfiguration({OWNER_PASSWORD:"owner-password-at-least-24-characters",JWT_SIGNING_SECRET:"0123456789abcdef".repeat(3)});
const id="https://chatgpt.com/oauth/client.json";
const meta={client_id:id,redirect_uris:["https://chatgpt.com/connector_platform_oauth_redirect"],token_endpoint_auth_methods_supported:["none","private_key_jwt"]};
describe("modern-only OAuth CIMD",()=>{
  it("strictly filters SSRF and forgery",()=>{
    expect(permittedClient(id,config)).toBe(true);
    expect(permittedClient("http://127.0.0.1/latest",config)).toBe(false);
    expect(permittedClient("https://chatgpt.com.attacker.test/oauth/client.json",config)).toBe(false);
    expect(permittedClient("https://chatgpt.com/oauth/client.json?x=1",config)).toBe(false);
    expect(()=>validateClientDocument(id,{...meta,client_id:"https://evil.test"})).toThrow();
  });
  it("accepts modern plural public-client auth methods",()=>{
    expect(validateClientDocument(id,meta).client_id).toBe(id);
  });
  it("never fetches arbitrary URLs",async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(meta)));
    const store=new MemoryStore();
    await lookupClient(id,config,store,fetcher as typeof fetch);
    await lookupClient(id,config,store,fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(lookupClient("https://evil.test/info.json",config,store,fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
