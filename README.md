# Tinfoil provider for opencode

Use [Tinfoil](https://tinfoil.sh)'s verifiably-private open models from the
[opencode](https://opencode.ai) coding agent. Inference runs inside hardware
secure enclaves that even Tinfoil cannot read into.

opencode already knows the `tinfoil` provider and its models through
[models.dev](https://models.dev), so this plugin does not add a provider, it
merely verifies the transport of the one that is already there.

## Setup

1. Install the plugin:

   ```bash
   opencode plugin @tinfoilsh/opencode-provider --global
   ```

   Use `opencode plugin`, not a hand-edited config. This package has two
   halves — the provider itself and the sidebar panel — and they are registered
   in two different files: `plugin` in `opencode.json` for the server half and
   `plugin` in `tui.json` for the TUI half. The command detects both
   ("Detected server + tui targets") and writes both. Adding the package to
   `opencode.json` by hand gives you a working provider with no sidebar.

2. Set your API key:

   ```bash
   opencode auth login
   ```

   Pick **Tinfoil**, then paste your key from the
   [Tinfoil Dashboard](https://dash.tinfoil.sh). For headless workflows, set
   `TINFOIL_API_KEY` instead.

3. Pick a Tinfoil model with `/models`, or run one directly:

   ```bash
   opencode run --model tinfoil/gpt-oss-120b "explain this repo"
   ```

## How verification works

When the plugin loads, it uses the [`tinfoil`
SDK](https://github.com/tinfoilsh/tinfoil-js) to verify the inference enclave:
it checks the enclave's SEV-SNP attestation, confirms the running code against
the release digest signed in Sigstore, and binds the attested key to the live
connection. Every request body is then encrypted end-to-end with HPKE, so only
the verified enclave can read it.

This is not a full external verifier — there is no independent AMD
signature-chain check. For that, use
[tinfoil-cli](https://github.com/tinfoilsh/tinfoil-cli).

The guard is installed through opencode's `config` hook, so it is in place
whether the key comes from `opencode auth login` or from `TINFOIL_API_KEY`.
(`auth.loader`, the documented home for provider options, is only called when
the provider has a stored auth entry — on its own it would leave an env-var-only
setup running unguarded.)

The plugin **fails closed**. If verification does not succeed, requests are
refused before anything leaves your machine — not the API key, system prompt,
tool definitions, or your code:

```
Error: Tinfoil: refusing to send this request. Enclave verification failed: <reason>
```

A failed verification cannot send your prompts anywhere. Verification is
retried on the next request, at most once every 30 seconds.

Because verification resolves which router enclave the attestation actually
covers, the plugin also overrides the base URL. The SDK's fetch refuses to talk
to any other origin.

## Seeing the verification state

The plugin adds a **Tinfoil section to the sidebar**, above Context and LSP:

```
▣ Build · GLM-5.3 Flash

    Tinfoil ✓ encrypted
      v0.0.144 · 32a9731d4762

    Context
    LSP
```

Green when the enclave is verified, red `Tinfoil ! UNVERIFIED — requests
blocked` when it is not, and muted `Tinfoil · checking…` while the first
attestation is still in flight. It is a standing signal, so there is no success
toast to dismiss; a *failure* does toast, once, because from that point on
requests are refused.

There is a third, louder state: red `Tinfoil ! NOT PROTECTED — not routed
through Tinfoil`. It means opencode is sending this provider's requests with
its own HTTP client rather than ours, so nothing is attested or encrypted to an
enclave no matter what the enclave itself reports. The panel never claims
`encrypted` on the strength of a verified enclave alone — it has to see the
guard installed as well. If you hit this state, please report it.

For the full document, type **`/tinfoil`**, or open the command palette
(`ctrl+p`) and pick **Tinfoil: verification details** — release tag and digest,
code and enclave fingerprints, attested TLS and HPKE keys, every verification
step, and the verifier version. Arrow and page keys scroll it, the mouse wheel
works too, and `esc` closes it. It renders in a dialog, entirely inside the
TUI: no message, no model turn, nothing added to the conversation and no
context re-sent.

### Where the status lives, and why it is a file

The server half publishes its verdict to `~/.tinfoil/opencode-status.json`; the
TUI half watches that file and renders it. That is the whole channel.

opencode has no channel between a plugin's server half and its TUI half — they
are separate processes, and the module shape forbids one plugin from being both
(`server?: never` / `tui?: never`). Everything else on offer can only carry a
value that was true at startup:

| Considered | Why not |
|---|---|
| `client.tui.publish` | Takes exactly three event bodies — `prompt.append`, `command.execute`, `toast.show`. There is no custom event type, and nothing plugin-defined in the event union the TUI can subscribe to. |
| Provider `options`, read in the TUI via `api.state.provider` or over HTTP at `/config/providers` | Resolved once, when the provider is built. A re-verification thirty seconds later cannot reach it. |
| The `config` hook, read back via `api.state.config` | The same startup snapshot, and it would park Tinfoil's state in the user's config. |
| Verifying again in the TUI | Two verdicts that can disagree. The sidebar has to show what the process doing the enforcing decided, not a second opinion. |
| A socket the server half listens on | Push instead of poll — but the TUI still has to find the socket, which means publishing a path somewhere, which means a file. Watching the status file is the same push without the machinery. |

`~/.tinfoil/` is the directory the Tinfoil SDKs already use (`user_cache_secret`
is written there by both the JS and Python SDKs), so this adds a file rather
than a new dotdir in your home directory. It is deliberately not under
opencode's own `~/.local/share/opencode`, which belongs to opencode; this is
Tinfoil's state. The refreshed model list lives beside it in
`~/.tinfoil/opencode-models.json`.

A verdict is shown only while the process that published it is still running
(`process.kill(pid, 0)`). That is the check a time window cannot make: the
server rewrites the file every time it re-verifies, so a legitimate verdict can
be hours old in a long session, while a stale one from a killed server is only
seconds old. No file, an unrecognised version, or a dead publisher all render
as `checking…` rather than as a claim.

Each server also republishes its verdict every 30 seconds. The file holds
whichever server wrote last, so closing one of two open windows would otherwise
leave the survivor's sidebar sitting on a dead process's verdict — right to
distrust it, wrong about that session. With the heartbeat it recovers within an
interval. The TUI half watches the file rather than polling it, so a change
shows up as soon as it lands.

Written 0600, via a temp file and a rename so a reader never sees a half-written
document. It holds nothing secret — a release tag, a digest, public keys. It is
also not a security boundary: anything that can write it could patch the plugin
instead. That is precisely why enforcement lives in the request guard and never
consults this file.

### How the two halves fit together

The sidebar never verifies anything itself. The server half owns the
`SecureClient` and is what actually blocks unverified requests, so it publishes
its verdict and its report to `~/.tinfoil/opencode-status.json`, and the TUI
half only renders that. Verifying separately in the TUI would be a second
opinion that could disagree with the one being enforced, and a sidebar claiming
verified while the guard fails closed is worse than no sidebar.

If the process that published the verdict is gone, the panel falls back to
`checking…` rather than presenting a stale verdict as current.

## Confirming the plugin is active

**This is worth doing once.** opencode reports a plugin it cannot resolve
through a no-op handler, so a name that is misspelled, not yet published, or
unreachable is skipped **silently**. The `tinfoil` provider still exists via
models.dev, so opencode will happily keep working — sending your prompts over
plain TLS with no attestation and no warning.

Check by running with `TINFOIL_DEBUG=1`:

```bash
TINFOIL_DEBUG=1 opencode run --model tinfoil/gpt-oss-120b "hi"
```

A working install prints, on stderr:

```
[tinfoil] verified 32a9731d47629d4af429f5a3a540d411f764a936d54829f9dfef9f7dd4411145
[tinfoil] discovered 7 models
```

**No `[tinfoil]` lines means the plugin is not running and you are not
verified**, regardless of whether the request succeeds. Run with
`--print-logs` to see why:

```bash
opencode run --print-logs --model tinfoil/gpt-oss-120b "hi" 2>&1 | grep plugin
```

## Model catalog

The plugin keeps the model list in step with what the enclave actually serves,
so models Tinfoil has added or retired since the last models.dev update show up
correctly. Only chat models with tool calling are listed — a coding agent needs
both.

The list is fetched over the verified channel *behind* the session and cached in
`~/.tinfoil/opencode-models.json`; each start serves the cached list and
refreshes it for the next one. That keeps attestation and a round trip off the
startup path — a session begins on the catalog it has rather than waiting for
one — at the cost of a newly added model appearing on the second start rather
than the first. Before the first refresh, or if the cache is over a week old,
the models.dev catalog is used as-is.

Model records are built by cloning what opencode already resolved from
models.dev and overriding only the fields the enclave reports, so the entries
stay valid as opencode's schema changes. Whichever catalog is in play, the guard
covers every request.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `TINFOIL_API_KEY` | _(none)_ | Your `tk_…` key, for headless workflows. Not needed if you use `opencode auth login`, the preferred login for everyday operation. |
| `TINFOIL_DEBUG` | _(unset)_ | Log verification and discovery to stderr. Use it to confirm the plugin is active. |

## Local development

The `plugin` arrays accept a local directory, so an unpublished checkout
installs the same way a published one does:

```bash
opencode plugin /path/to/opencode-provider --global --force
```

That resolves `.` to `tinfoil.ts` for the server half and `./tui` to `tui.ts`
for the TUI half, and writes both config files. Then:

```bash
TINFOIL_DEBUG=1 opencode run --model tinfoil/gpt-oss-120b "reply with exactly: PONG"
```

**The first run installs dependencies and can take a few minutes**, printing
nothing while it works — it looks like a hang. Let it finish; every run after
starts immediately.

Typecheck with:

```bash
npm install
npm run check
```

### Two things that will bite you

**Do not add a non-function export to `tinfoil.ts`.** opencode's loader walks
every export of a server plugin and throws `Plugin export is not a function` on
the first one that is not callable. That unloads the whole plugin — guard
included — and because the `tinfoil` provider still exists via models.dev, the
session keeps working and sends prompts over plain TLS with no warning. This is
why the status-file constants are module-private and duplicated in `tui.ts`
rather than exported and shared.

**Do not give `dialog.replace` an `onClose` that calls `dialog.clear()`.**
`clear()` invokes every stack entry's `onClose`, so that recurses. The visible
symptom is a dialog that ignores `esc` and `ctrl+c` and traps every keystroke
until the session is killed — it looks like a missing key binding, not a loop.
The stack's own `esc` binding closes the dialog for you; there is nothing to
wire up. Two neighbouring traps in the same API: `replace` resets the size to
`medium`, so call `setSize` *after* it, and the overlay applies its own
`paddingTop: terminalHeight / 4`, so wrapping a child in `api.ui.Dialog`
applies that twice and pushes the dialog off the bottom of the screen.

**Do not import `@opentui/*` or `solid-js` at the top of `tui.ts`.** opencode
serves its own copies through an internal `opentui:runtime-module:` alias and
there must be exactly one of each — a second `@opentui/core` throws on load
(`OPENTUI_FORCE_WCWIDTH is already registered with different configuration`).
Static imports are hoisted and resolve before that alias applies, picking up
whatever is in `node_modules`; the dynamic imports inside `tui()` get
opencode's. When this breaks, the module never evaluates, `tui()` is never
called, and **nothing is logged anywhere** — the panel just never appears. They
stay in `devDependencies` for typechecking only, and as optional peers.
