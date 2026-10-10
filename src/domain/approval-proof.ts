/** The raw human-held secret never becomes an MCP tool parameter. */
export async function personalApprovalProof(
  secret:string, action:"order"|"cancel"|"reconcile", token:string,
):Promise<string>{
  if(!secret||!token)throw new Error("Secret and confirmation token are required");
  const key=await crypto.subtle.importKey(
    "raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"],
  );
  const signed=new Uint8Array(await crypto.subtle.sign("HMAC",key,
    new TextEncoder().encode(`tradepilot-v3-personal:${action}:${token}`)));
  let encoded="";for(const byte of signed)encoded+=String.fromCharCode(byte);
  return btoa(encoded).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}
export async function constantTimeEqual(a:string,b:string):Promise<boolean>{
  const enc=new TextEncoder();
  const [ha,hb]=await Promise.all([
    crypto.subtle.digest("SHA-256",enc.encode(a)),crypto.subtle.digest("SHA-256",enc.encode(b)),
  ]);
  const x=new Uint8Array(ha),y=new Uint8Array(hb);
  let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]!^y[i]!;
  return diff===0;
}
