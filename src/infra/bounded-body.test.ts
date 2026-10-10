import {describe,expect,it} from "vitest";
import {readBoundedUtf8} from "./bounded-body.js";
function chunked(...chunks:Uint8Array[]){
  return new ReadableStream<Uint8Array>({
    start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}
  });
}
describe("bounded streaming UTF-8 reader",()=>{
  it("reads valid Unicode without confusing bytes and character count",async()=>{
    const encoded=new TextEncoder().encode("测试-123");
    expect(await readBoundedUtf8(chunked(encoded.subarray(0,2),encoded.subarray(2)),64))
      .toBe("测试-123");
    await expect(readBoundedUtf8(chunked(encoded),8))
      .rejects.toThrow(/Body too large/);
  });
  it("aborts overlong chunked streams without reading every chunk",async()=>{
    let pulls=0;
    const stream=new ReadableStream<Uint8Array>({
      pull(controller){
        pulls++;
        controller.enqueue(new Uint8Array(9_000));
      },
    });
    await expect(readBoundedUtf8(stream,16_384,"Form too large"))
      .rejects.toThrow(/Form too large/);
    expect(pulls).toBeLessThanOrEqual(5);
  });
  it("rejects undecodable UTF-8 rather than misparsing financial source values",async()=>{
    await expect(readBoundedUtf8(chunked(new Uint8Array([0xff])),10))
      .rejects.toThrow();
  });
});
