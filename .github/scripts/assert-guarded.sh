#!/usr/bin/env bash
# Sends one request to a Tinfoil model through OpenCode and checks that it went
# through the plugin's verified guard. Expects TINFOIL_API_KEY to be a fake key
# and MAJOR to be the OpenCode major version (1 or 2).
set -u

args=(run --model tinfoil/gpt-oss-120b)
# OpenCode 2 would otherwise reuse a background server with whatever plugins it
# loaded earlier.
[ "$MAJOR" = 2 ] && args=(run --standalone --model tinfoil/gpt-oss-120b)

status="$HOME/.tinfoil/opencode-status.json"
out=$(mktemp)
rm -f "$status"

# The first run installs the plugin's dependencies and prints nothing meanwhile.
# -k: if OpenCode ignores the TERM, kill it rather than wait for the job timeout.
timeout -k 10 420 opencode "${args[@]}" "Reply with exactly: pong" </dev/null >"$out" 2>&1
echo "opencode exited with $?"

failed=0

# Tinfoil rejecting the fake key means the request reached Tinfoil. The plugin
# points OpenCode at a host that never resolves, so only its verified fetch
# could have taken it there.
if grep -q "Incorrect API key" "$out"; then
  echo "The request reached Tinfoil through the plugin's guard."
elif grep -q "tinfoil.invalid" "$out"; then
  echo "::error::The request skipped the plugin's guard and failed at the placeholder host."
  failed=1
elif grep -q "Tinfoil: refusing to send this request" "$out"; then
  echo "::error::The guard refused the request because enclave verification failed."
  failed=1
else
  echo "::error::The request did not reach Tinfoil through the plugin's guard."
  failed=1
fi

# Written by the plugin itself, so it also shows the plugin loaded.
# shellcheck disable=SC2016 # JavaScript, not shell: the ${} are template literals.
if ! node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  console.log(`status file: verified=${s.verified} guarded=${s.guarded}${s.reason ? ` reason=${s.reason}` : ""}`)
  process.exit(s.verified === true && s.guarded === true ? 0 : 1)
' "$status"; then
  echo "::error::The plugin did not report a verified enclave with its guard installed ($status)."
  failed=1
fi

if [ "$failed" = 0 ]; then
  tail -20 "$out"
else
  cat "$out"
fi
exit "$failed"
