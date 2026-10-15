import assert from "node:assert/strict"
import { after, mock, test } from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = await mkdtemp(join(tmpdir(), "tinfoil-plugin-test-"))
mock.module("node:os", { namedExports: { homedir: () => home } })
let failure
const requests = []
mock.module("tinfoil", {
  namedExports: {
    SecureClient: class {
      async ready() { if (failure) throw new Error(failure) }
      reset() {}
      getBaseURL() { return "https://verified.tinfoil.sh" }
      getVerificationDocument() { return { releaseDigest: "sha256:test", releaseTag: "test" } }
      async fetch(input, init) {
        if (input === "/v1/models") return Response.json({ data: [] })
        requests.push({ input, init })
        return Response.json({
          id: "chat-test", object: "chat.completion", created: 1, model: "test-model",
          choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }
    },
  },
})

const { default: plugin } = await import("../tinfoil.ts")
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await rm(home, { recursive: true, force: true })
})

const model = {
  id: "test-model", modelID: "test-model", providerID: "tinfoil", name: "Test",
  package: "@opencode/ai/providers/openai-compatible", time: { released: 1 },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [], status: "active", enabled: true,
  limit: { context: 128000, output: 16000 },
  cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
}

async function setupV2() {
  let sdkHook
  let retryHook
  let models = [structuredClone(model)]
  const provider = { id: "tinfoil", package: model.package }
  const dispose = await plugin.setup({
    aisdk: { async hook(name, hook) { assert.equal(name, "sdk"); sdkHook = hook } },
    session: { async hook(name, hook) { assert.equal(name, "retry"); retryHook = hook } },
    provider: {
      async transform(apply) {
        apply({
          get: () => ({ provider, models: new Map(models.map((item) => [item.id, item])) }),
          update: (id, update) => { assert.equal(id, "tinfoil"); update(provider) },
          models: { set: (id, values) => { assert.equal(id, "tinfoil"); models = values } },
        })
      },
    },
  })
  return { dispose, sdkHook, retryHook, provider, models }
}

async function generate(hook, key) {
  const event = { model, options: { baseURL: "https://inference.tinfoil.sh/v1", apiKey: key } }
  await hook(event)
  return event.sdk.languageModel("test-model").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "private prompt" }] }],
  })
}

test("OpenCode 2 sends through the guarded SDK with the resolved credential", async () => {
  const ctx = await setupV2()
  try {
    assert.equal(ctx.provider.package, "aisdk:@ai-sdk/openai-compatible")
    assert.equal(ctx.models[0].package, "aisdk:@ai-sdk/openai-compatible")
    // Both saved and environment credentials are resolved by OpenCode before this hook.
    for (const key of ["saved-test-key", "environment-test-key"]) {
      const result = await generate(ctx.sdkHook, key)
      assert.equal(result.content[0].text, "PONG")
      const request = requests.at(-1)
      assert.equal(request.input, "https://verified.tinfoil.sh/v1/chat/completions")
      assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${key}`)
    }
    const other = { model: { providerID: "other" }, sdk: {} }
    const original = other.sdk
    await ctx.sdkHook(other)
    assert.equal(other.sdk, original)
  } finally { await ctx.dispose() }
})

test("OpenCode 2 blocks the actual SDK request when attestation fails", async () => {
  failure = "test attestation failure"
  const ctx = await setupV2()
  try {
    const before = requests.length
    await assert.rejects(generate(ctx.sdkHook, "secret"), (error) => {
      assert.match(error.message, /refusing to send.*test attestation failure/)
      const retry = { error, decision: { retry: true, delay: 1000 } }
      ctx.retryHook(retry)
      assert.deepEqual(retry.decision, { retry: false })
      return true
    })
    const transient = { error: new Error("temporary network failure"), decision: { retry: true, delay: 1000 } }
    ctx.retryHook(transient)
    assert.equal(transient.decision.retry, true)
    assert.equal(requests.length, before)
  } finally { await ctx.dispose(); failure = undefined }
})

test("OpenCode 1 guards saved-key and environment-only configurations", async () => {
  failure = "test attestation failure"
  const hooks = await plugin.server({ client: { tui: { showToast: async () => {} } } })
  try {
    const config = {}
    await hooks.config(config)
    const saved = await hooks.auth.loader(async () => ({ type: "api", key: "saved-test-key" }))
    assert.equal(saved.apiKey, "saved-test-key")
    assert.equal(saved.fetch, config.provider.tinfoil.options.fetch)
    const before = requests.length
    for (const fetch of [saved.fetch, config.provider.tinfoil.options.fetch]) {
      await assert.rejects(fetch("https://inference.tinfoil.sh/v1/chat/completions"), /refusing to send/)
    }
    assert.equal(requests.length, before)
  } finally { await hooks.dispose(); failure = undefined }
})

test("the existing cache produces OpenCode 2 model records without donor identity", async () => {
  await mkdir(join(home, ".tinfoil"), { recursive: true })
  await writeFile(join(home, ".tinfoil/opencode-models.json"), JSON.stringify({
    v: 1, at: Date.now(), models: [
      { id: "new-model", context_window: 200000, pricing: { inputTokenPricePer1M: 3 } },
      { id: "__proto__" }, { id: "audio", type: "audio" },
    ],
  }))
  const ctx = await setupV2()
  try {
    assert.equal(ctx.models.length, 1)
    const discovered = ctx.models[0]
    assert.equal(discovered.id, "new-model")
    assert.equal(discovered.modelID, "new-model")
    assert.equal(discovered.time.released, 0)
    assert.deepEqual(discovered.variants, [])
    assert.equal(discovered.limit.context, 200000)
    assert.deepEqual(discovered.capabilities, { tools: true, input: ["text"], output: ["text"] })
    assert.deepEqual(discovered.cost, [{ input: 3, output: 2, cache: { read: 0, write: 0 } }])
  } finally { await ctx.dispose() }
})

mock.module("@opentui/solid/jsx-runtime", { namedExports: { jsx: (type, props) => ({ type, props }) } })
mock.module("solid-js", { namedExports: { createSignal: (initial) => {
  let value = initial
  return [() => value, (next) => { value = next }]
} } })
const { default: tui } = await import("../tui.ts")

test("OpenCode 2 TUI registers the sidebar and /tinfoil, opens details, and cleans up", async () => {
  let layer, claim, dialog, size, removed = false
  const cleanup = await tui.setup({
    theme: { text: "white", textMuted: "gray", success: "green", error: "red" },
    renderer: { terminalHeight: 40 },
    keymap: { layer: (factory) => { layer = factory() } },
    ui: {
      slot: (value) => { claim = value; return () => { removed = true } },
      dialog: { show: (render) => { dialog = render() }, set: (options) => { size = options.size } },
    },
  })
  try {
    assert.equal(claim.prepend, "sidebar.content")
    assert.equal(layer.mode, "global")
    assert.equal(layer.commands[0].slash.name, "tinfoil")
    assert.equal(layer.commands[0].palette, true)
    layer.commands[0].run()
    assert.equal(dialog.props.children[0].props.children, "Tinfoil verification")
    assert.equal(size, "xlarge")
    assert.equal(claim.render().type, "box")
  } finally { cleanup() }
  assert.equal(removed, true)
})
