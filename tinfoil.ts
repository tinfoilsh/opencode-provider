// Types only; opencode injects the real runtime. Kept as a peer dependency so
// the plugin tracks whatever opencode version the user already has.
import type { Plugin } from "@opencode-ai/plugin"
// Types only. The runtime import happens inside the factory, off opencode's
// startup path — see the `load` promise below. Resolves from this package's own
// node_modules when installed as an npm plugin, or from the opencode config
// directory when dropped in as a file.
import type { SecureClient as SecureClientInstance, VerificationDocument } from "tinfoil"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Tinfoil provider for opencode.
 *
 * opencode already knows the `tinfoil` provider and its models through
 * models.dev, so this plugin does not introduce a provider — it upgrades the
 * transport of the one that is already there. The `tinfoil` SDK verifies the
 * enclave's SEV-SNP attestation and its Sigstore-signed code digest in
 * process, then seals every request body to the attested HPKE key. No local
 * proxy, and no base URL, API key, or model list in opencode.json.
 *
 * Not a full external verifier (no independent AMD signature-chain check);
 * for that use github.com/tinfoilsh/tinfoil-cli.
 *
 * See README.md for setup.
 */

const PROVIDER_ID = "tinfoil"
const HELP_URL = "https://tinfoil.sh/coding-agents"

/** Hosts whose requests may be retargeted at the attested enclave. */
const TINFOIL_HOST = /(^|\.)tinfoil\.sh$/

/**
 * Where this half publishes its verdict for the TUI half to render.
 *
 * The two halves run in different processes (server vs TUI) and opencode has
 * no channel between them — `tui.publish` only accepts three built-in event
 * types. So the process that actually owns the SecureClient, and therefore
 * actually enforces, writes what it decided; the sidebar only ever renders
 * that. The panel can never claim verified while the guard is failing closed.
 *
 * Verification is a property of the enclave, not of a project, so a single
 * shared file is correct even with several opencode windows open.
 */
const STATUS_PATH = join(homedir(), ".tinfoil", "opencode-status.json")

/**
 * The enclave's model list, cached so that a startup never blocks on
 * attestation plus a round trip to fetch it. Refreshed behind each session.
 */
const CATALOG_PATH = join(homedir(), ".tinfoil", "opencode-models.json")
const CATALOG_VERSION = 1

/** Long enough to survive a holiday; short enough that a retired model goes. */
const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Bump when the shape changes; the reader ignores versions it knows nothing
 * about.
 *
 * Note these are deliberately NOT exported. opencode's plugin loader walks
 * every export of a server plugin module and throws "Plugin export is not a
 * function" on the first one that is not callable — which silently unloads the
 * whole plugin, guard included. tui.ts keeps its own copy of this contract.
 */
const STATUS_VERSION = 2

type TinfoilStatus = {
  v: number
  verified: boolean
  /**
   * Whether the guarded fetch is actually installed. Verification says the
   * enclave is trustworthy; this says opencode is going through us to reach
   * it. Both have to be true before the sidebar may claim anything.
   */
  guarded: boolean
  reason?: string
  releaseTag?: string
  releaseDigest?: string
  enclaveHost?: string
  /** Pre-rendered report, so the TUI never needs the SDK to display detail. */
  report: string[]
  at: number
  pid: number
}

/** Model discovery is a nicety; never let it hold up a session. */
const DISCOVER_TIMEOUT_MS = 8000

/** Floor between re-attestation attempts, so a hard outage cannot spin. */
const REVALIDATE_COOLDOWN_MS = 30_000

/**
 * How often to republish an unchanged verdict.
 *
 * The sidebar only trusts a verdict whose publishing process is still running,
 * and the status file holds whichever server wrote last. Close one of two
 * opencode windows and the survivor's sidebar would otherwise sit on a dead
 * process's verdict — correct to distrust, but wrong about this session. A
 * heartbeat means it recovers within one interval instead of never.
 */
const REPUBLISH_MS = 30_000

const debug = (message: string) => {
  if (process.env["TINFOIL_DEBUG"]) console.error(`[tinfoil] ${message}`)
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

// =============================================================================
// Verification state
// =============================================================================

/**
 * `pending` only exists before the first attempt settles. Everything that
 * needs a verdict awaits `verify()` rather than reading this directly.
 */
type VerifyState = { kind: "pending" } | { kind: "verified" } | { kind: "failed"; reason: string }

export const TinfoilProvider: Plugin = async ({ client }) => {
  let state: VerifyState = { kind: "pending" }

  /**
   * Set once opencode has actually taken `guardedFetch`.
   *
   * Verifying the enclave proves nothing about the transport if opencode is
   * still using its own `fetch`, so this gates every claim the plugin makes.
   * It is not a formality: the `auth.loader` route silently does not happen
   * unless the provider has a stored auth entry.
   */
  let guarded = false
  let attempt: Promise<VerifyState> | undefined
  let lastAttemptAt = 0

  /**
   * Default config: resolves the router, verifies SEV-SNP against the
   * Sigstore-signed release digest, and sets up HPKE body encryption.
   *
   * Imported here rather than at the top of the file. opencode awaits a
   * plugin's module evaluation during startup, and evaluating the `tinfoil`
   * SDK costs ~300ms — paid before opencode has even asked this plugin for
   * anything. Started here and deliberately not awaited, it overlaps the
   * startup work opencode does anyway, and everything that needs the client
   * awaits `verify()`.
   *
   * Nothing in this path may throw. When a plugin fails to load, opencode logs
   * it and carries on — and the `tinfoil` provider still exists via
   * models.dev, so the session would quietly fall back to sending prompts over
   * plain TLS with no attestation at all. A plugin that loads is a plugin that
   * can refuse; every failure becomes a state the guard can see rather than
   * one that unloads the guard.
   */
  let secure: SecureClientInstance | undefined
  let loadFailure: string | undefined
  const load = (async () => {
    try {
      const { SecureClient } = await import("tinfoil")
      secure = new SecureClient()
    } catch (error) {
      loadFailure = `could not load the Tinfoil client: ${errorMessage(error)}`
      debug(loadFailure)
    }
  })()

  /**
   * Deduplicated verification. Never rejects: opencode invokes the auth loader
   * through `Effect.promise`, where a rejected promise is a defect rather than
   * a handled error, so a throw here can take down startup instead of
   * disabling one provider. Failure is a value, and the fetch guard is what
   * turns it into a blocked request.
   */
  const verify = (): Promise<VerifyState> => {
    attempt ??= (async () => {
      lastAttemptAt = Date.now()
      await load
      if (!secure) {
        state = { kind: "failed", reason: loadFailure ?? "the Tinfoil client is unavailable" }
        void publishStatus()
        return state
      }
      try {
        await secure.ready()
        state = { kind: "verified" }
        debug(`verified ${secure.getVerificationDocument().releaseDigest}`)
      } catch (error) {
        state = { kind: "failed", reason: errorMessage(error) }
        debug(`verification failed: ${state.reason}`)
      }
      void publishStatus()
      return state
    })()
    return attempt
  }

  /**
   * Drop the cached attestation and check again from scratch. Covers both a
   * transient startup failure and an enclave that restarted under us; the
   * cooldown keeps a sustained outage from re-attesting on every request.
   */
  const revalidate = async (): Promise<VerifyState> => {
    if (!secure) return state
    if (Date.now() - lastAttemptAt < REVALIDATE_COOLDOWN_MS) return state
    secure.reset()
    attempt = undefined
    return verify()
  }

  const document = (): VerificationDocument | undefined =>
    state.kind === "verified" ? secure?.getVerificationDocument() : undefined

  // =============================================================================
  // Transport
  // =============================================================================

  /**
   * The guard. Fails closed: if the enclave is not verified, nothing leaves
   * the machine — not the API key, system prompt, tool definitions, or the
   * user's code. A failed verification cannot send your prompts anywhere.
   *
   * `secure.fetch` seals each body to the attested HPKE key, refuses any
   * origin other than the verified enclave, and re-attests on its own when the
   * server rotates keys.
   */
  const guardedFetch: typeof fetch = async (input, init) => {
    let current = await verify()
    if (current.kind !== "verified") current = await revalidate()
    if (current.kind !== "verified") {
      throw new Error(
        `Tinfoil: refusing to send this request. Enclave verification failed: ` +
          `${current.kind === "failed" ? current.reason : "verification did not complete"}. See ${HELP_URL}`,
      )
    }
    return secure!.fetch(retarget(input), init)
  }

  /**
   * Point a request at the enclave the attestation actually covers.
   *
   * Which router that is only becomes known once verification finishes, and
   * the SDK's fetch hard-refuses every other origin ("this client is bound to
   * the verified enclave/proxy"). The alternative is to hand opencode a
   * `baseURL` from the auth loader, but that means the loader has to block
   * startup on attestation — and the router genuinely varies between runs, so
   * a remembered URL is not safe either. Rewriting here costs nothing and
   * keeps the base URL question off the startup path entirely.
   *
   * Only Tinfoil hosts are rewritten. Anything else is passed through
   * untouched for the SDK to refuse, so a bug elsewhere in opencode cannot
   * turn this into an open relay to the enclave.
   */
  const retarget = (input: Parameters<typeof fetch>[0]): Parameters<typeof fetch>[0] => {
    const base = secure?.getBaseURL()
    if (!base) return input
    const requested = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    let url: URL
    try {
      url = new URL(requested)
    } catch {
      // Already relative; the SDK resolves it against the verified enclave.
      return input
    }
    if (!TINFOIL_HOST.test(url.hostname)) return input
    const target = `${new URL(base).origin}${url.pathname}${url.search}`
    if (target === url.href) return input
    debug(`retargeting ${url.origin} to the attested enclave`)
    return typeof input === "string" || input instanceof URL ? target : new Request(target, input)
  }

  // =============================================================================
  // Model discovery
  // =============================================================================

  interface TinfoilApiModel {
    id?: string
    name?: string
    type?: string
    endpoints?: string[]
    context_window?: number
    max_tokens?: number
    reasoning?: boolean
    multimodal?: boolean
    tool_calling?: boolean
    pricing?: { inputTokenPricePer1M?: number; outputTokenPricePer1M?: number }
  }

  /** A coding agent needs chat plus tool calling; anything else fails in the picker. */
  const isUsable = (raw: TinfoilApiModel): boolean => {
    if (!raw.id) return false
    if (raw.type && raw.type !== "chat") return false
    if (raw.endpoints && !raw.endpoints.includes("/v1/chat/completions")) return false
    if (raw.tool_calling === false) return false
    return true
  }

  /** /v1/models reports no output-token limit; derive a conservative one. */
  const deriveMaxTokens = (contextWindow: number): number =>
    Math.min(32768, Math.max(4096, Math.floor(contextWindow / 8)))

  /**
   * Build a catalog from what the enclave serves, keeping models.dev as the
   * schema.
   *
   * opencode replaces `provider.models` wholesale with whatever the hook
   * returns and fills in no defaults, so every entry has to be a complete
   * model record. Rather than hand-roll one — and re-break on the next schema
   * change — clone an entry opencode already built from models.dev and
   * override only the fields the enclave actually reports. Models the enclave
   * no longer serves fall out; ones models.dev has not caught up with appear.
   */
  const buildCatalog = (existing: Record<string, any>, live: TinfoilApiModel[]): Record<string, any> | undefined => {
    const template = Object.values(existing)[0]
    if (!template) {
      // No models.dev entry to clone, so there is no safe shape to build.
      // Leave the catalog alone rather than guess at required fields.
      debug("no catalog entry to use as a template")
      return undefined
    }

    const models: Record<string, any> = {}
    for (const raw of live) {
      if (!isUsable(raw)) continue
      const id = raw.id as string
      const contextWindow = raw.context_window ?? template.limit?.context ?? 128000
      const known = existing[id]
      const model = structuredClone(known ?? template)

      // A cloned template carries the donor model's identity-ish fields. Left
      // in place they would advertise variants and a release date belonging to
      // a different model; drop them and let opencode fall back to defaults.
      if (!known) {
        delete model.variants
        delete model.family
        model.status = "active"
        model.release_date = ""
      }

      model.id = id
      model.name = raw.name ?? id
      // No `api.url`: `retarget` sends every request to the attested enclave,
      // whichever router that turns out to be.
      model.api = { ...model.api, id }
      model.limit = {
        ...model.limit,
        context: contextWindow,
        output: raw.max_tokens ?? deriveMaxTokens(contextWindow),
      }
      model.capabilities = {
        ...model.capabilities,
        toolcall: true,
        reasoning: raw.reasoning === true,
        attachment: raw.multimodal === true,
        input: { ...model.capabilities?.input, text: true, image: raw.multimodal === true },
      }
      if (raw.pricing) {
        model.cost = {
          ...model.cost,
          input: raw.pricing.inputTokenPricePer1M ?? model.cost?.input ?? 0,
          output: raw.pricing.outputTokenPricePer1M ?? model.cost?.output ?? 0,
        }
      }
      models[id] = model
    }

    if (!Object.keys(models).length) {
      debug("enclave served no usable chat models")
      return undefined
    }
    return models
  }

  /** The enclave's model list as last seen, so a startup never waits for it. */
  const readCache = async (): Promise<TinfoilApiModel[] | undefined> => {
    try {
      const raw = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as {
        v?: number
        at?: number
        models?: TinfoilApiModel[]
      }
      if (raw.v !== CATALOG_VERSION || !Array.isArray(raw.models)) return undefined
      if (Date.now() - (raw.at ?? 0) > CATALOG_MAX_AGE_MS) return undefined
      return raw.models
    } catch {
      return undefined
    }
  }

  /**
   * Fetch the live list and cache it for the next start. Runs in the
   * background: model discovery is a nicety, and waiting for attestation plus
   * a round trip is startup time nobody asked for. This session keeps whatever
   * catalog it started with.
   */
  const refreshCache = async (): Promise<void> => {
    try {
      const verdict = await verify()
      if (verdict.kind !== "verified") {
        debug("skipping catalog refresh: not verified")
        return
      }
      const response = await secure!.fetch("/v1/models", {
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} from /v1/models`)
      const live = ((await response.json()) as { data?: TinfoilApiModel[] }).data ?? []
      if (!live.length) return
      await writeAtomic(CATALOG_PATH, JSON.stringify({ v: CATALOG_VERSION, at: Date.now(), models: live }))
      debug(`cached ${live.length} models from the enclave`)
    } catch (error) {
      // models.dev remains a reasonable catalog, and the guard covers every
      // request either way.
      debug(`catalog refresh failed: ${errorMessage(error)}`)
    }
  }

  /**
   * The `provider.models` hook. Returns immediately — from the cached list
   * where there is one, otherwise leaving models.dev in place — and refreshes
   * the cache behind the session.
   */
  const discover = async (provider: any): Promise<Record<string, any>> => {
    const existing: Record<string, any> = provider.models ?? {}
    void refreshCache()

    const cached = await readCache()
    if (!cached) {
      debug("no cached model list, keeping the models.dev catalog")
      return existing
    }
    const models = buildCatalog(existing, cached)
    if (!models) return existing
    debug(`serving ${Object.keys(models).length} models from the cached enclave list`)
    return models
  }

  /**
   * Write via a temp file and rename, so a reader never sees a half-written
   * document. Mode 0600: the contents are public information — a release
   * digest and public keys — but nothing else has any business writing what
   * the sidebar reads.
   */
  const writeAtomic = async (path: string, contents: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
  }

  // =============================================================================
  // Status
  // =============================================================================

  const shortHash = (value?: string) => (value ? value.replace(/^sha256:/, "").slice(0, 12) : "unknown")

  /** One-line verdict, as the sidebar headline and the failure toast show it. */
  const summary = (verdict: VerifyState): string => {
    if (!guarded) {
      return (
        `Tinfoil unprotected [!] — opencode is not routing this provider through Tinfoil, ` +
        `so requests are NOT verified or encrypted to an enclave. See ${HELP_URL}`
      )
    }
    if (verdict.kind !== "verified") {
      const reason = verdict.kind === "failed" ? verdict.reason : "verification did not complete"
      return `Tinfoil unverified [!] — ${reason}. Requests are blocked. See ${HELP_URL}`
    }
    const doc = document()
    return `Tinfoil verified [✓] ${doc?.releaseTag ?? "unknown"} ${shortHash(doc?.releaseDigest)}`
  }

  /** One step line, in the order the verifier performs the steps. */
  const stepLines = (doc: VerificationDocument): string[] => {
    const steps = doc.steps
    if (!steps) return []
    const entries: Array<[string, { status?: string; error?: string } | undefined]> = [
      ["Fetch digest", steps.fetchDigest],
      ["Verify code", steps.verifyCode],
      ["Verify enclave", steps.verifyEnclave],
      ["Compare measurements", steps.compareMeasurements],
      ["Verify certificate", steps.verifyCertificate],
    ]
    return entries
      .filter((pair): pair is [string, { status?: string; error?: string }] => pair[1] !== undefined)
      .map(([name, step]) => `  ${name.padEnd(22)}${step.status ?? "unknown"}${step.error ? `: ${step.error}` : ""}`)
  }

  /** The full document, as `/tinfoil` renders it. */
  const report = (verdict: VerifyState): string => {
    const doc = document()
    if (!guarded) {
      return [
        summary(verdict),
        "",
        "What this means",
        "  opencode is sending this provider's requests with its own HTTP client",
        "  rather than Tinfoil's, so nothing in this session is attested or",
        "  encrypted to an enclave, whatever the enclave itself reports.",
        "",
        "  This should not happen. Please report it, with your opencode version,",
        "  at https://github.com/tinfoilsh/opencode-provider/issues",
      ].join("\n")
    }
    if (verdict.kind !== "verified" || !doc) {
      return [
        summary(verdict),
        "",
        `Reason:  ${verdict.kind === "failed" ? verdict.reason : "no verification document"}`,
        `The next request retries verification. See ${HELP_URL}`,
      ].join("\n")
    }

    const enclave = doc.enclaveMeasurement ?? {}
    return [
      summary(verdict),
      "",
      "What this means",
      "  Nobody can read what you send to Tinfoil, including Tinfoil.",
      "  Your prompts and code are encrypted directly to this verified enclave,",
      "  and that is the only place they are ever decrypted.",
      "",
      "Connection",
      `  Base URL:        ${secure?.getBaseURL() ?? "unknown"}`,
      `  Enclave host:    ${doc.enclaveHost || "unknown"}`,
      `  Router endpoint: ${doc.selectedRouterEndpoint || "unknown"}`,
      `  Config repo:     ${doc.configRepo || "unknown"}`,
      "",
      "Release",
      `  Tag:             ${doc.releaseTag ?? "unknown"}`,
      `  Digest:          ${doc.releaseDigest || "unknown"}`,
      `  Code print:      ${doc.codeFingerprint || "unknown"}`,
      `  Enclave print:   ${doc.enclaveFingerprint || "unknown"}`,
      "",
      "Attested keys",
      `  TLS public key:  ${doc.tlsPublicKey || "unknown"}`,
      `  TLS fingerprint: ${enclave.tlsPublicKeyFingerprint ?? "unknown"}`,
      `  HPKE public key: ${doc.hpkePublicKey || enclave.hpkePublicKey || "unknown"}`,
      "",
      "Verification steps",
      ...stepLines(doc),
      "",
      "Verifier",
      `  Verifier:        ${doc.verifier?.name ?? "unknown"} ${doc.verifier?.version ?? ""}`.trimEnd(),
      `  Verified:        ${doc.securityVerified === true ? "yes" : "(SDK did not mark this document verified)"}`,
      `  Verified at:     ${doc.verifiedAt ?? "unknown"}`,
    ].join("\n")
  }

  /**
   * Publish the verdict for the sidebar. Written via a temp file and rename so
   * a reader never sees a half-written document, and entirely best-effort: a
   * read-only home directory should cost you the panel, not the session.
   */
  const publishStatus = async () => {
    const verdict = state
    if (verdict.kind === "pending") return
    const doc = document()
    try {
      const status: TinfoilStatus = {
        v: STATUS_VERSION,
        verified: verdict.kind === "verified",
        guarded,
        ...(verdict.kind === "failed" ? { reason: verdict.reason } : {}),
        ...(doc?.releaseTag ? { releaseTag: doc.releaseTag } : {}),
        ...(doc?.releaseDigest ? { releaseDigest: doc.releaseDigest } : {}),
        ...(doc?.enclaveHost ? { enclaveHost: doc.enclaveHost } : {}),
        report: report(verdict).split("\n"),
        at: Date.now(),
        pid: process.pid,
      }
      await writeAtomic(STATUS_PATH, JSON.stringify(status))
      debug(`published status verified=${status.verified} guarded=${status.guarded}`)
    } catch (error) {
      debug(`could not publish status: ${errorMessage(error)}`)
    }
  }

  // Kick off attestation now, but do not await it: plugin load is on
  // opencode's startup path and this is a network round trip. Everything that
  // depends on the verdict awaits `verify()` where it actually needs it.
  void verify()

  const heartbeat = setInterval(() => void publishStatus(), REPUBLISH_MS)
  heartbeat.unref?.()

  /**
   * There is no TUI in `opencode run`, and the toast call does not fail there
   * so much as never answer. Racing it keeps a headless session from stalling
   * on a cosmetic notification.
   */
  const toast = async (message: string, variant: "error") => {
    const shown = client.tui
      .showToast({ body: { title: "Tinfoil", message, variant } })
      .then(() => {})
      .catch(() => {})
    await Promise.race([shown, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())])
  }

  /**
   * Only failures toast. The sidebar panel is a standing, always-visible signal
   * for the good case, so a success toast on every session would be noise that
   * trains people to dismiss the one message that matters. A failure deserves
   * interrupting either way: requests are blocked from here on, or — worse —
   * they are not going through the guard at all.
   */
  let announced = false

  const announce = async () => {
    if (announced) return
    announced = true
    const verdict = await verify()
    if (verdict.kind === "verified" && guarded) return
    await toast(summary(verdict), "error")
  }

  return {
    /**
     * Where the guarded fetch is actually installed.
     *
     * `auth.loader` is the documented place for provider options, but opencode
     * only calls it when the provider has a stored auth entry — so a user who
     * supplies `TINFOIL_API_KEY` and never runs `opencode auth login` would get
     * opencode's own `fetch`, the models.dev base URL, and no attestation, no
     * body sealing and no guard, while this plugin cheerfully reported a
     * verified enclave. The config hook runs either way.
     *
     * The loader still sets it too, for whichever of the two opencode consults
     * first; both install the same function, so the duplication is harmless.
     */
    async config(config) {
      const providers = ((config as Record<string, any>)["provider"] ??= {})
      const entry = (providers[PROVIDER_ID] ??= {})
      const options = (entry.options ??= {})
      options.fetch = guardedFetch
      guarded = true
      debug("installed the request guard")
    },

    async dispose() {
      clearInterval(heartbeat)
    },

    /**
     * Registers "Tinfoil" under `opencode auth login` and, once a key is
     * stored, hands opencode the guarded fetch.
     *
     * Deliberately does not wait for a verdict. This runs on the startup path,
     * and the base URL it would have waited for is applied per request by
     * `retarget` instead. Nothing is sent before verification either way: the
     * guard is in the fetch.
     */
    auth: {
      provider: PROVIDER_ID,
      methods: [{ type: "api", label: "Tinfoil API key" }],
      async loader(auth) {
        // `auth()` is opencode's; a throw here would reach `Effect.promise` as
        // a defect and take down startup rather than one provider.
        let stored: any
        try {
          stored = await auth()
        } catch (error) {
          debug(`could not read stored auth: ${errorMessage(error)}`)
        }
        guarded = true
        return {
          ...(stored?.key ? { apiKey: stored.key } : {}),
          fetch: guardedFetch,
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      models: discover,
    },

    // Deliberately not awaited. opencode awaits this hook for every event, so
    // anything slow here is felt on the session's critical path; the status
    // message is cosmetic and the request guard is what actually enforces.
    async event() {
      void announce()
    },
  }
}

export default TinfoilProvider
