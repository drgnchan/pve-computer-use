# Pi agent integration

`pve-cu` is a normal CLI and works with any agent or script. This page documents
the optional first-class integration for the [Pi](https://github.com/earendil-works/pi)
coding agent, which saves a model round-trip by returning the action and its
screenshot in a single tool call.

## `pve_console` tool

`extensions/pve-console.ts` registers a `pve_console` tool. It executes **one**
action and returns the resulting frame as an inline image, so the agent does not
have to read a path and make a second `read` call.

Install it into Pi's extensions directory and reload:

```bash
# copy or symlink extensions/pve-console.ts into your Pi extensions directory,
# then run /reload inside Pi
```

Example calls:

```json
{"target":"windows-vm","action":"observe"}
{"target":"windows-vm","action":"double-click","x":37,"y":237,"wait":"stable","minWaitMs":2500,"waitTimeoutMs":10000}
{"target":"windows-vm","action":"type","fromFile":"~/.config/pve-cu/windows-vm-password"}
```

Parameters:

| Parameter | Notes |
|---|---|
| `target` | A configured target name |
| `action` | `observe`, `click`, `double-click`, `move`, `scroll`, `key`, `type`, `reset` |
| `x`, `y`, `dy`, `button`, `keys` | Same semantics as the CLI |
| `text` | **Public ASCII only.** Never passwords, tokens or OTP codes |
| `fromFile` | Absolute or `~/` path to a `0600` secret file; the extension passes the path to the CLI and never reads the content |
| `wait` | `none` (default for `observe`), `change`, or `stable` (default for input actions) |
| `waitTimeoutMs`, `stableMs`, `minWaitMs` | Bounded wait tuning |

The extension only starts a daemon on demand and never retries input.

## Operational rules

- **Always inspect the returned image.** `stable:true` means redraws paused, not
  that a window is focused or ready.
- **One action at a time.** Do not run two actions against the same target
  concurrently; the extension rejects a second in-flight call per target.
- **Never retry input after a timeout or `observationError`.** The action may have
  been delivered; observe again first.
- **Secrets never go through `text`.** Use `fromFile`, or the CLI's `--from-file`
  / `--stdin`. Keep OTP/TOTP codes out of tool arguments as well.
- `timings`, `cliMs` and `toolTotalMs` separate input, observation and CLI time;
  they do not include the next model turn.

## CLI equivalents

Without the extension, the same loop uses the CLI plus `read`:

```bash
pve-cu --target windows-vm click --x 0.5 --y 0.5 --observe --wait-stable
pve-cu --target windows-vm observe --wait-stable --stable-ms 800 --min-wait 1500 --wait-timeout 5000
```

Then read the returned `frame.filePath`. `--observe` runs the action and the
capture in one serialized daemon task and returns `frame` plus `timings`, or
`observationError` if only the capture failed.

## Upgrading

Rebuild the bundle, stop the daemon when idle, then reload Pi:

```bash
npm run build
pve-cu --target windows-vm daemon stop   # the next command starts the new daemon
# inside Pi: /reload
```
