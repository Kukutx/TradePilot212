/** Read UTF-8 without buffering arbitrarily large, chunked remote/request bodies. */
export async function readBoundedUtf8(
  body:ReadableStream<Uint8Array>|null,
  maxBytes:number,
  sizeError="Body too large",
):Promise<string>{
  if(!body)throw new Error("Missing body");
  if(!Number.isInteger(maxBytes)||maxBytes<=0)throw new Error("Invalid body limit");
  const reader=body.getReader(),parts:Uint8Array[]=[];
  let size=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>maxBytes)throw new Error(sizeError);
      parts.push(part.value);
    }
  }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
}
