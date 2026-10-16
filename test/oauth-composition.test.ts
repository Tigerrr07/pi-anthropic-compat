// Offline tests of composing with an OAuth transport extension such as
// @gotgenes/pi-anthropic-auth, which shapes Claude subscription requests.
// Point PI_ANTHROPIC_AUTH_ENTRY at that extension's entry file (for example
// .../@gotgenes/pi-anthropic-auth/src/index.ts); without it only the
// transport unit test runs. No request leaves the process.
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { object, objects, type JsonObject } from "../extensions/anthropic-compat/json.ts";
import { finalizeRequest } from "../extensions/anthropic-compat/transport.ts";

const compat = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const auth = process.env["PI_ANTHROPIC_AUTH_ENTRY"];
const needsAuth = {
  skip:
    auth !== undefined && existsSync(auth)
      ? false
      : "set PI_ANTHROPIC_AUTH_ENTRY to the OAuth extension entry",
};
const modelId = "claude-opus-5-5";
const fakeBlock: JsonObject = {
  type: "compaction",
  content: "Synthetic saved facts",
  signature: "synthetic-signature",
  opaque: { preserved: true },
};
const BILLING = /x-anthropic-billing-header/;

type Call = { payload: JsonObject; headers: Headers };
type Compaction = { enabled: boolean; keepRecentTokens: number; reserveTokens?: number };

function sse(): Response {
  const events: JsonObject[] = [
    {
      type: "message_start",
      message: {
        id: "synthetic",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Synthetic response" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => {
      const type = event["type"];
      return `event: ${typeof type === "string" ? type : ""}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function fixture(
  order: ("auth" | "compat")[],
  oauth = true,
  compaction: Compaction = { enabled: false, keepRecentTokens: 0 },
) {
  const dir = mkdtempSync(join(tmpdir(), "pac-oauth-"));
  chmodSync(dir, 0o700);
  const oldDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = dir;
  writeFileSync(join(dir, "pi-anthropic-compat.json"), JSON.stringify({ enabled: true }), {
    mode: 0o600,
  });
  const calls: Call[] = [];
  let failTurn = false;
  let failSummary = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, "https://api.anthropic.com", "No external network");
    if (request.method === "GET") {
      return Response.json({ capabilities: { compaction: { summarize: { supported: true } } } });
    }
    const payload = object(await request.json());
    calls.push({ payload, headers: request.headers });
    if (payload["compaction"] !== undefined) {
      if (failSummary) {
        return Response.json(
          { error: { type: "api_error", message: "synthetic failure" } },
          { status: 500 },
        );
      }
      return Response.json({
        model: modelId,
        stop_reason: "compaction",
        content: [fakeBlock],
        usage: { iterations: [{ type: "compaction", input_tokens: 20, output_tokens: 5 }] },
      });
    }
    if (failTurn) {
      failTurn = false;
      return Response.json(
        { error: { type: "invalid_request_error", message: "synthetic rejection" } },
        { status: 400 },
      );
    }
    return sse();
  };
  const settingsManager = SettingsManager.inMemory({
    compaction,
    retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey(
    "anthropic",
    oauth ? "sk-ant-oat-synthetic-test-token" : "synthetic-api-key",
  );
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: order.map((entry) => (entry === "auth" ? (auth ?? "") : compat)),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = runtime.getModel("anthropic", modelId);
  assert.ok(model);
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    sessionManager: manager,
  });
  const notices: string[] = [];
  await session.bindExtensions({
    mode: "print",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: (text) => {
        notices.push(text);
      },
    },
  });
  return {
    session,
    manager,
    calls,
    notices,
    setFailTurn: () => (failTurn = true),
    setFailSummary: () => (failSummary = true),
    close() {
      session.dispose();
      globalThis.fetch = original;
      if (oldDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = oldDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const system = (call: Call) => JSON.stringify(call.payload["system"] ?? "");
const firstMessage = (call: Call | undefined) => objects(call?.payload["messages"])[0];
const beta = (call: Call | undefined) => call?.headers.get("anthropic-beta") ?? "";
const customEntries = (manager: SessionManager, type: string) =>
  manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === type);

test("final fetch replay preserves headers, signal, opaque block, and beta union", async () => {
  const controller = new AbortController();
  const request = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: "Bearer synthetic",
      "anthropic-beta": "oauth,existing",
      "content-length": "2",
    },
    body: "{}",
    signal: controller.signal,
  });
  const payload: JsonObject = {
    messages: [{ role: "assistant", content: [fakeBlock] }],
    betas: ["existing", "compact-test"],
  };
  const result = finalizeRequest(request, payload);
  assert.equal(result.headers.get("authorization"), "Bearer synthetic");
  assert.equal(result.headers.get("content-length"), null);
  assert.equal(result.headers.get("anthropic-beta"), "oauth,existing,compact-test");
  assert.deepEqual(await result.json(), { messages: payload["messages"] });
  assert.deepEqual(payload["betas"], ["existing", "compact-test"]);
  controller.abort();
  assert.equal(result.signal.aborted, true);
  assert.throws(() => finalizeRequest(request, { betas: [123] }), /Invalid Anthropic beta/);
});

for (const order of [
  ["auth", "compat"],
  ["compat", "auth"],
] as const) {
  test(
    `OAuth composition, native summary and opaque replay: ${order.join(" -> ")}`,
    needsAuth,
    async () => {
      const f = await fixture([...order]);
      try {
        await f.session.prompt("Remember synthetic facts.");
        const last = f.session.messages.at(-1);
        assert.equal(last?.role === "assistant" ? last.stopReason : undefined, "stop");
        const templates = customEntries(f.manager, "pi-anthropic-compat-template");
        assert.equal(templates.length, 1);
        const template = templates[0];
        assert.match(JSON.stringify(template?.type === "custom" ? template.data : {}), BILLING);
        const firstEntries = f.manager.getEntries().length;
        const model = f.session.modelRuntime.getModel("anthropic", modelId);
        assert.ok(model);
        await f.session.modelRuntime.completeSimple(model, {
          messages: [{ role: "user", content: "Nested synthetic call", timestamp: Date.now() }],
        });
        assert.equal(f.manager.getEntries().length, firstEntries, "Auxiliary calls record nothing");
        await f.session.compact();
        const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
        assert.equal(checkpoint?.type, "compaction");
        assert.deepEqual(object(checkpoint.details)["block"], fakeBlock);
        assert.equal(checkpoint.usage?.totalTokens, 25);
        await f.session.prompt("Recall the facts.");
        const replay = f.calls.at(-1);
        assert.deepEqual(firstMessage(replay), { role: "assistant", content: [fakeBlock] });
        assert.ok(beta(replay).includes("compact-2026-09-04"));
        assert.equal(replay?.payload["betas"], undefined);
        for (const call of f.calls) assert.match(system(call), BILLING);
        // Starting the same extension runtime again must unwrap its own previous wrapper.
        await f.session.bindExtensions({ mode: "print" });
        const before = customEntries(f.manager, "pi-anthropic-compat-request").length;
        await f.session.prompt("One more synthetic turn.");
        const after = customEntries(f.manager, "pi-anthropic-compat-request").length;
        assert.equal(after, before + 1, "No wrapper nesting or double request recording");
      } finally {
        f.close();
      }
    },
  );
}

test("API-key calls remain unshaped while native compaction still works", needsAuth, async () => {
  const f = await fixture(["auth", "compat"], false);
  try {
    await f.session.prompt("Synthetic ordinary call");
    await f.session.compact();
    await f.session.prompt("Synthetic replay");
    assert.ok(f.calls.every((call) => !BILLING.test(system(call))));
    assert.deepEqual(firstMessage(f.calls.at(-1))?.["content"], [fakeBlock]);
  } finally {
    f.close();
  }
});

test(
  "rejected turns are not captured; failed summary is single-attempt and preserves history",
  needsAuth,
  async () => {
    const f = await fixture(["auth", "compat"]);
    try {
      f.setFailTurn();
      await f.session.prompt("Reject this synthetic turn");
      assert.equal(customEntries(f.manager, "pi-anthropic-compat-template").length, 0);
      await f.session.prompt("Accept this synthetic turn");
      const before = f.manager.getLeafId();
      f.setFailSummary();
      await assert.rejects(f.session.compact());
      assert.equal(f.calls.filter((call) => call.payload["compaction"] !== undefined).length, 1);
      assert.equal(f.manager.getLeafId(), before);
      assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
      assert.ok(f.notices.some((notice) => notice.includes("HTTP 500")));
    } finally {
      f.close();
    }
  },
);

test(
  "automatic threshold compaction goes through the native summary and replays it",
  needsAuth,
  async () => {
    const f = await fixture(["auth", "compat"], true, {
      enabled: true,
      reserveTokens: 1_000_000 - 5,
      keepRecentTokens: 0,
    });
    try {
      const ends: { reason: string; ok: boolean }[] = [];
      f.session.subscribe((event) => {
        if (event.type === "compaction_end") {
          ends.push({ reason: event.reason, ok: event.result !== undefined });
        }
      });
      await f.session.prompt("Remember synthetic facts.");
      assert.deepEqual(ends, [{ reason: "threshold", ok: true }]);
      const checkpoint = f.manager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.equal(checkpoint?.type, "compaction");
      assert.deepEqual(object(checkpoint.details)["block"], fakeBlock);
      assert.equal(f.calls.filter((call) => call.payload["compaction"] !== undefined).length, 1);
      await f.session.prompt("Recall the facts.");
      const replay = f.calls.filter((call) => call.payload["compaction"] === undefined).at(-1);
      assert.deepEqual(firstMessage(replay), { role: "assistant", content: [fakeBlock] });
      assert.ok(beta(replay).includes("compact-2026-09-04"));
      for (const call of f.calls) assert.match(system(call), BILLING);
    } finally {
      f.close();
    }
  },
);
