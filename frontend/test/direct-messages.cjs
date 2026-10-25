const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { readFileSync } = require("node:fs"),
  { join } = require("node:path"),
  ts = require("typescript");
const mod = { exports: {} };
const code = ts.transpileModule(
  readFileSync(join(__dirname, "../src/utils/direct-messages.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
new Function("module", "exports", code)(mod, mod.exports);
const {
  messageIdAfter,
  mergeDirectMessages,
  directMessageDraftKey,
  uncertainDirectSend,
} = mod.exports;
const row = (id, content = id) => ({
  id,
  senderId: 1,
  clientMessageId: "test-" + id,
  createdAt: "2026-10-15T00:00:00Z",
  content,
});
test("definite rejections keep drafts editable; only ambiguous sends retain their id", () => {
  for (const status of [400, 401, 403, 409, 429])
    assert.equal(uncertainDirectSend({ response: { status } }), false);
  assert.equal(uncertainDirectSend({ code: "AUTH_SESSION_CHANGED" }), false);
  assert.equal(uncertainDirectSend({ response: { status: 503 } }), true);
  assert.equal(uncertainDirectSend(new Error("network interrupted")), true);
});

test("message ordering and read targets preserve bigint IDs beyond JS precision", () => {
  assert(messageIdAfter("9007199254740993", "9007199254740992"));
  assert(!messageIdAfter("9007199254740992", "9007199254740993"));
  assert(!messageIdAfter("NaN", "1"));
  assert(!messageIdAfter("1", "not-a-cursor"));
  assert.deepEqual(
    mergeDirectMessages(
      [row("9007199254740993")],
      [row("9007199254740992"), row("11")],
    ).map((r) => r.id),
    ["11", "9007199254740992", "9007199254740993"],
  );
});
test("polling, send confirmation and history pages merge once without losing text", () => {
  const result = mergeDirectMessages(
    [row("12"), row("13")],
    [row("11"), row("13", "confirmed"), row("bad")],
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["11", "12", "13"],
  );
  assert.equal(result[2].content, "confirmed");
});
test("volatile private drafts are isolated by both account and thread", () => {
  assert.notEqual(directMessageDraftKey(1, 20), directMessageDraftKey(2, 20));
  assert.notEqual(directMessageDraftKey(1, 20), directMessageDraftKey(1, 21));
});
