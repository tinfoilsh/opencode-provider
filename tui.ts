// The TUI half of the plugin. opencode loads this from the "./tui" subpath
// export, in the TUI process — separate from the server half in tinfoil.ts.
// It is registered in tui.json, not in the `plugin` array of opencode.json;
// `opencode plugin <spec>` writes both.
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { watch, type FSWatcher } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

/**
 * Tinfoil status panel for opencode's sidebar, alongside Context and LSP.
 *
 * This half renders and nothing else. It never verifies anything itself: the
 * server half owns the SecureClient and is what actually blocks unverified
 * requests, so it publishes its verdict and this reads it. Attesting again here
 * would be a second opinion that could disagree with the one being enforced,
 * and a sidebar claiming "verified" while the guard fails closed is worse than
 * no sidebar at all.
 */

/** Must match STATUS_PATH / TinfoilStatus in tinfoil.ts. */
const STATUS_PATH = join(homedir(), ".tinfoil", "opencode-status.json")
const STATUS_VERSION = 1

type TinfoilStatus = {
  v: number
  verified: boolean
  reason?: string
  releaseTag?: string
  releaseDigest?: string
  enclaveHost?: string
  report: string[]
  at: number
  pid: number
}

/**
 * A backstop only. The file is watched, so this exists for the filesystems
 * where watching quietly does not work rather than as the way updates arrive.
 */
const POLL_MS = 15_000

/**
 * A last-resort bound in case a pid is reused by an unrelated process. The
 * real freshness check is whether the process that published the verdict is
 * still running — see `isRunning`.
 */
const STALE_MS = 12 * 60 * 60 * 1000

const MARK_OK = "✓"
const MARK_BAD = "!"

type View =
  | { kind: "unknown" }
  | { kind: "verified"; status: TinfoilStatus }
  | { kind: "unverified"; status: TinfoilStatus }

/**
 * Is the process that published this verdict still running?
 *
 * Signal 0 checks for existence without delivering anything. `EPERM` means the
 * process is there but owned by someone else, which still counts as running.
 *
 * This is what keeps a dead server's "verified" from being presented as the
 * current state: the verdict is only as live as the process enforcing it. A
 * time window cannot do that job — the server rewrites the file whenever it
 * re-verifies, so a legitimate verdict can be hours old in a long session,
 * while a stale one from a killed server is only ever seconds old.
 */
const isRunning = (pid?: number): boolean => {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

const read = async (): Promise<View> => {
  try {
    const raw = JSON.parse(await readFile(STATUS_PATH, "utf8")) as TinfoilStatus
    if (raw?.v !== STATUS_VERSION || typeof raw.verified !== "boolean") return { kind: "unknown" }
    if (Date.now() - (raw.at ?? 0) > STALE_MS) return { kind: "unknown" }
    if (!isRunning(raw.pid)) return { kind: "unknown" }
    return raw.verified ? { kind: "verified", status: raw } : { kind: "unverified", status: raw }
  } catch {
    // No file yet (server still attesting), or unreadable. Either way we do not
    // know, and saying so is the honest render.
    return { kind: "unknown" }
  }
}

const shortHash = (value?: string) => (value ? value.replace(/^sha256:/, "").slice(0, 12) : "unknown")

const debug = (message: string) => {
  if (process.env["TINFOIL_DEBUG"]) console.error(`[tinfoil-tui] ${message}`)
}

type JsxFactory = (
  type: string | ((props: Record<string, unknown>) => unknown),
  props?: Record<string, unknown> | null,
) => unknown

const plugin: TuiPluginModule = {
  id: "tinfoil",
  async tui(api: TuiPluginApi) {
    /**
     * Imported here rather than at the top of the file, deliberately.
     *
     * opencode serves its own opentui and solid to plugins through an internal
     * `opentui:runtime-module:` alias, and there must be exactly one copy of
     * each: a second `@opentui/core` throws on load ("OPENTUI_FORCE_WCWIDTH is
     * already registered with different configuration") and a second solid-js
     * would silently break reactivity. Static imports are hoisted and resolve
     * before that alias applies, so they pick up whatever copy happens to be in
     * node_modules; by the time `tui()` runs, a dynamic import gets opencode's.
     *
     * Symptom if this regresses: the module never evaluates, `tui()` is never
     * called, and nothing is logged anywhere — the panel simply never appears.
     */
    const { jsx } = (await import("@opentui/solid/jsx-runtime")) as unknown as { jsx: JsxFactory }
    const { createSignal } = (await import("solid-js")) as unknown as {
      createSignal: <T>(value: T) => [() => T, (next: T) => void]
    }

    const [view, setView] = createSignal<View>({ kind: "unknown" })

    const refresh = async () => {
      const next = await read()
      setView(next)
      debug(`status=${next.kind}`)
    }
    void refresh()

    /**
     * Watch the directory rather than the file: the server half publishes by
     * writing a temp file and renaming it over the old one, so the inode the
     * file watch is holding is the one that gets replaced, and further updates
     * are never seen.
     */
    let watcher: FSWatcher | undefined
    try {
      watcher = watch(dirname(STATUS_PATH), (_event, changed) => {
        if (!changed || basename(String(changed)) === basename(STATUS_PATH)) void refresh()
      })
      watcher.on("error", () => watcher?.close())
      api.lifecycle.onDispose(() => watcher?.close())
      debug("watching the status file")
    } catch (error) {
      // The directory may not exist yet, or the platform may not support
      // watching it. The poll below covers both.
      debug(`could not watch the status file (${error instanceof Error ? error.message : String(error)})`)
    }

    const timer = setInterval(() => void refresh(), POLL_MS)
    api.lifecycle.onDispose(() => clearInterval(timer))

    // Re-read immediately on session activity, so the panel is right at the
    // moment someone looks at it rather than up to a poll interval later.
    api.lifecycle.onDispose(api.event.on("session.updated", () => void refresh()))

    /**
     * The detail view, and the reason the `/tinfoil` command is gone. This runs
     * entirely in the TUI: no message, no model turn, nothing added to the
     * conversation and no context re-sent. The report text was rendered by the
     * server half, so what it shows is what that process actually verified.
     */
    const showDetails = () => {
      const current = view()
      const lines =
        current.kind === "unknown"
          ? [
              "Tinfoil status unavailable.",
              "",
              "No recent verdict was published by an opencode server process.",
              "The provider plugin may not be loaded — see",
              "https://tinfoil.sh/coding-agents",
            ]
          : current.status.report

      /**
       * Deliberately not `api.ui.DialogAlert`: it takes one `message` string
       * and lays it out at whatever height that needs, so a verification
       * document — 35 lines of steps, digests and keys — ran off the bottom of
       * the terminal with no way to reach the rest. The body here is a focused
       * `scrollbox`, which arrow keys, page keys and the mouse wheel all
       * scroll.
       *
       * Also deliberately not wrapped in `api.ui.Dialog`: `dialog.replace`
       * already renders its child inside that same overlay, and nesting a
       * second one applies its `paddingTop: terminalHeight / 4` twice, which
       * pushed the whole thing to the middle of the screen and off the bottom.
       * Passing the body directly puts it where the command palette sits.
       */
      const theme = api.theme.current

      /**
       * Nothing in the overlay bounds a child's height — `dialog.setSize` picks
       * a width (60/88/116 columns) and nothing else — so the viewport has to
       * be sized here: what is left under that quarter-height offset, less the
       * title, the footer and their margins.
       */
      const rows = api.renderer.terminalHeight
      const viewportRows = Math.max(4, Math.min(lines.length, rows - Math.floor(rows / 4) - 7))

      api.ui.dialog.replace(
        () =>
          jsx("box", {
            flexDirection: "column",
            paddingLeft: 2,
            paddingRight: 2,
            children: [
              jsx("text", { fg: theme.text, children: "Tinfoil verification" }),
              jsx("scrollbox", {
                focused: true,
                scrollY: true,
                height: viewportRows,
                marginTop: 1,
                // One text per line rather than one blob with newlines: the
                // scrollbox measures its content from child heights, and a
                // single multi-line child reports one row and never scrolls.
                children: lines.map((line) => jsx("text", { fg: theme.text, children: line })),
              }),
              jsx("text", {
                fg: theme.textMuted,
                marginTop: 1,
                children: lines.length > viewportRows ? "↑/↓ scroll · esc close" : "esc close",
              }),
            ],
          }) as never,
      )
      // After `replace`, not before: it resets the stack size to "medium" (60
      // columns) on the way in, which wrapped every digest line in half.
      api.ui.dialog.setSize("xlarge")
    }

    /**
     * Registers `/tinfoil` plus the command-palette entry.
     *
     * `api.command.register` is marked deprecated in favour of
     * `api.keymap.registerLayer({ commands, bindings })`, but as of opencode
     * 1.18.27 the keymap route does not reach the command palette: a command
     * registered that way is dispatchable yet invisible, and `ctrl+p` reports
     * "No results" for it — with or without a keybinding. The legacy call is
     * the only one that lists, and the only one that takes a `slash` name.
     * Revisit when registerLayer grows palette support.
     *
     * Either entry point runs entirely in the TUI process: no message, no model
     * turn, nothing added to the conversation and no context re-sent.
     */
    if (api.command?.register) {
      api.lifecycle.onDispose(
        api.command.register(() => [
          {
            title: "Tinfoil: verification details",
            value: "tinfoil.details",
            // No `description`: opencode's own commands set none, and the
            // palette renders it inline after the title, which made this row
            // twice as long as every other one.
            category: "Plugin",
            slash: { name: "tinfoil" },
            onSelect: () => void showDetails(),
          },
        ]),
      )
      debug("registered /tinfoil and the palette entry")
    } else {
      debug("api.command.register unavailable; sidebar panel only")
    }

    /**
     * Solid renders a component body once, and normally its compiler rewrites
     * dynamic JSX expressions into getters the renderer can track. This file
     * calls the runtime `jsx()` factory directly to avoid a build step, so
     * there is no compiler and a `() => value` passed as a prop is merely
     * stored as a function — read once, never again.
     *
     * The reactive boundary is therefore `children` on the outer box: a
     * function child is an accessor Solid does track, and re-running it
     * rebuilds the inner elements from plain, already-resolved values.
     */
    const TinfoilPanel = () =>
      jsx("box", {
        flexDirection: "column",
        marginTop: 1,
        children: () => {
          const current = view()
          const theme = api.theme.current
          const headline =
            current.kind === "verified"
              ? `Tinfoil ${MARK_OK} encrypted`
              : current.kind === "unverified"
                ? `Tinfoil ${MARK_BAD} UNVERIFIED`
                : "Tinfoil · checking…"
          const detail =
            current.kind === "verified"
              ? `  ${current.status.releaseTag ?? "unknown"} · ${shortHash(current.status.releaseDigest)}`
              : current.kind === "unverified"
                ? "  requests blocked"
                : "  waiting for attestation"
          const fg =
            current.kind === "verified" ? theme.success : current.kind === "unverified" ? theme.error : theme.textMuted

          return [jsx("text", { fg, children: headline }), jsx("text", { fg: theme.textMuted, children: detail })]
        },
      })

    api.slots.register({
      slots: {
        sidebar_content: () => TinfoilPanel() as never,
      },
    })

    debug("sidebar panel registered")
  },
}

export default plugin
