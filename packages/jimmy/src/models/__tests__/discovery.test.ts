import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { discoverModels } from "../discovery.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-discovery-test-"));
afterAll(() => fs.rmSync(dir, { force: true, recursive: true }));
function binary(name: string, code: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\nconst readline = require('node:readline');\nconst send = o => process.stdout.write(JSON.stringify(o)+'\\n');\nreadline.createInterface({input:process.stdin}).on('line', line => { const msg = JSON.parse(line); ${code} });\n`, { mode: 0o700 });
  return file;
}
describe("CLI discovery transport", () => {
  it("initializes Codex, follows pagination, filters hidden rows and never starts inference", async () => {
    const bin = binary("codex", `
      if(msg.method==='initialize') send({id:msg.id,result:{}});
      else if(msg.method==='initialized') {}
      else if(msg.method==='model/list') {
        send({id:msg.id,result:msg.params.cursor ? {data:[{model:'future-sol',displayName:'Future',supportedReasoningEfforts:[]}],nextCursor:null} : {data:[{model:'private',hidden:true}],nextCursor:'page2'}});
      } else process.exit(7);
    `);
    expect(await discoverModels("codex", bin)).toMatchObject([{ id: "future-sol" }]);
  });
  it("reads Claude initialize response without submitting a user message", async () => {
    const bin = binary("claude", `
      if(msg.type!=='control_request'||msg.request.subtype!=='initialize') process.exit(7);
      send({type:'control_response',response:{subtype:'success',request_id:msg.request_id,response:{models:[{value:'default',resolvedModel:'claude-next',displayName:'Next'}]}}});
    `);
    expect(await discoverModels("claude", bin)).toMatchObject([{ id: "claude-next", isDefault: true }]);
  });
  it("fails closed on malformed/pagination-loop responses without leaking upstream errors", async () => {
    const bin = binary("bad-codex", `
      if(msg.method==='initialize') send({id:msg.id,result:{}});
      else if(msg.method==='model/list') send({id:msg.id,result:{data:[],nextCursor:'same'}});
    `);
    await expect(discoverModels("codex", bin)).rejects.toThrow("pagination");
    const failed = binary("failed", `send({id:msg.id,error:{message:'private-token-xyz'}});`);
    await expect(discoverModels("codex", failed)).rejects.toThrow("Codex model discovery failed");
  });
});
