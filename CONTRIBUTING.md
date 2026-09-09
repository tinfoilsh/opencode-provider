# Contributing

## Running from a checkout

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

The first run installs dependencies and can take a few minutes, printing nothing
while it works. It looks like a hang. Let it finish; every run after starts
immediately.

Typecheck with:

```bash
npm install
npm run check
```

## How the two halves fit together

`tinfoil.ts` runs in opencode's server process. It owns the `SecureClient`,
verifies the enclave, and installs the guarded fetch that blocks unverified
requests. `tui.ts` runs in the separate TUI process and draws the sidebar panel
and the `/tinfoil` dialog.

The TUI half never verifies anything itself. The server half publishes its
verdict to `~/.tinfoil/opencode-status.json` and the TUI half renders that.
Verifying separately in the TUI would be a second opinion that could disagree
with the one being enforced, and a sidebar claiming "verified" while the guard
fails closed is worse than no sidebar.

A file is used because opencode has no channel between a plugin's two halves.
`client.tui.publish` takes three fixed event types and nothing custom; provider
`options` and the `config` hook are resolved once at startup and cannot reflect
a later re-verification; and a socket would still need its path published
somewhere. The TUI watches the file, so updates arrive as soon as they land.

A verdict is only rendered while the process that published it is still running
(`process.kill(pid, 0)`), which a time window cannot check: the server rewrites
the file whenever it re-verifies, so a legitimate verdict can be hours old,
while a stale one from a killed server is seconds old. Each server also
republishes every 30 seconds, so closing one of two windows does not leave the
survivor pinned to a dead process's verdict.

The file is not a security boundary. Anything that can write it could patch the
plugin instead. That is why enforcement lives in the request guard, which never
reads it.

## Things that will bite you

**opencode fails open when a plugin fails to load.** A misspelled name, an
unpublished package, a non-callable export, a throw during module evaluation:
opencode logs it and carries on. The `tinfoil` provider still exists via
models.dev, so the session keeps working over plain TLS with no attestation and
no warning. Everything below is a variation on that theme, which is why the
plugin turns every startup failure into a state the guard can see rather than
one that unloads the guard.

**Install the guarded fetch from the `config` hook, not only from
`auth.loader`.** opencode skips `auth.loader` entirely unless the provider has a
stored auth entry, so a user with `TINFOIL_API_KEY` set and no `opencode auth
login` would otherwise get opencode's own fetch, with no attestation and no body
sealing. The status file carries a `guarded` flag for exactly this reason: a
verified enclave says nothing if opencode is not going through us to reach it.

**Do not add a non-function export to `tinfoil.ts`.** opencode's loader walks
every export of a server plugin and throws `Plugin export is not a function` on
the first one that is not callable, which unloads the whole plugin. This is why
the status-file constants are module-private and duplicated in `tui.ts` rather
than exported and shared.

**Nothing on a hook path may reject.** opencode invokes `auth.loader` and
`provider.models` through `Effect.promise`, where a rejected promise is a defect
rather than a handled error. One rejection takes down every provider in the
session, not just this one. Verification failure is a value here, never a throw.

**Do not import `@opentui/*` or `solid-js` at the top of `tui.ts`.** opencode
serves its own copies through an internal `opentui:runtime-module:` alias and
there must be exactly one of each; a second `@opentui/core` throws on load
(`OPENTUI_FORCE_WCWIDTH is already registered with different configuration`).
Static imports are hoisted and resolve before that alias applies. The dynamic
imports inside `tui()` get opencode's. When this breaks, the module never
evaluates, `tui()` is never called, and nothing is logged anywhere: the panel
simply never appears.

**Solid runs without a compiler here.** `tui.ts` calls the runtime `jsx()`
factory to avoid a build step, so a `() => value` passed as a prop is stored as
a plain function and read once. The reactive boundary is `children` on the outer
box, which Solid does track.

**`dialog.replace` has three traps.** An `onClose` that calls `dialog.clear()`
recurses, and the visible symptom is a dialog that ignores `esc` and traps every
keystroke. `replace` resets the dialog size to `medium`, so call `setSize` after
it. The overlay applies its own `paddingTop: terminalHeight / 4`, so wrapping a
child in `api.ui.Dialog` applies it twice and pushes the dialog off screen.

**Command palette entries need the deprecated API.** `api.keymap.registerLayer`
is the documented replacement for `api.command.register`, but as of opencode
1.18.27 a command registered that way is dispatchable and invisible: `ctrl+p`
shows nothing. The legacy call is also the only one that accepts a `slash` name.

## Treat the enclave's model list as untrusted

`/v1/models` is fetched over the verified channel and then cached on disk for a
week, so a single bad response is not transient. Model ids become object keys
and lookups; numbers land in opencode's context accounting. Validate on both
sides of the cache, and never let a bad entry escape as a rejection from
`provider.models`.

## Before publishing

- `npm run check`
- `npm pack --dry-run` — should list exactly `LICENSE`, `README.md`,
  `package.json`, `tinfoil.ts` and `tui.ts`
- Check fail-closed in both auth configurations: with an entry in `auth.json`,
  and with `TINFOIL_API_KEY` set and no entry. Break verification (for example
  by constructing the client against a config repo that cannot resolve) and
  confirm the request is refused with a non-zero exit and no output.
