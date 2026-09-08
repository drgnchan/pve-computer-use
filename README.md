# pve-cu — PVE Computer Use

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Test](https://github.com/drgnchan/pve-computer-use/actions/workflows/test.yml/badge.svg)](https://github.com/drgnchan/pve-computer-use/actions/workflows/test.yml)

Drive a Proxmox VE virtual machine through its VNC console: capture screenshots
and inject mouse and keyboard input from the command line.

No agent is required inside the guest. `pve-cu` talks to the virtual display and
virtual input devices that PVE already exposes, so it can operate the BIOS, an
installer, or a login screen just as well as a running desktop.

It is designed to be driven by an AI agent in a *screenshot → plan → act → verify*
loop, but the CLI is fully usable on its own.

> Optional AI-agent integration (Pi): [docs/pi-integration.md](docs/pi-integration.md)

---

## Features

- **No guest agent.** Works below the OS: BIOS/UEFI, installers, boot menus, login screens.
- **Screenshots + input.** Absolute pointer move, left/right/middle click, double-click, drag, wheel, text and key combos.
- **Good Windows compatibility.** Keys are sent as QEMU extended key events with a DOM `code` (scancode), with a plain keysym fallback.
- **Per-target daemon.** One Unix socket per VM, serialized action queue, frames written to disk with `0600`.
- **Credentials stay in the daemon.** The PVE password/API token, the console ticket and TLS verification never reach the browser; it only gets a loopback URL and a short-lived RFB password.
- **Real TLS pinning.** PVE's private cluster CA is pinned by leaf SHA-256, verified *before any request byte is written*.
- **Redraw-aware waiting.** `--wait-change` / `--wait-stable` instead of blind sleeps.
- **Secret-safe typing.** `type --from-file` / `--stdin` keeps passwords out of `argv` and process listings.
- **Optional one-call agent tool.** `extensions/pve-console.ts` returns one action plus its screenshot in a single tool call.

## Requirements

- **Node.js >= 20**
- **Chrome/Chromium** (default `/usr/bin/google-chrome`, configurable via `executablePath` / `PVE_CU_CHROME`)
- **Proxmox VE** reachable over HTTPS on port 8006, and a user or API token with
  `VM.Console` (to open the console) and `VM.Audit` (to read VM status).

`playwright-core` is used as a library only; it does not download a browser.

---

## Quick start

```bash
git clone https://github.com/drgnchan/pve-computer-use.git
cd pve-computer-use
npm install
npm run build                                  # bundles web/dist/console.bundle.js
ln -s "$PWD/bin/pve-cu.js" ~/.local/bin/pve-cu # or: npm link

cp config.example.json ~/.config/pve-cu/config.json
# edit ~/.config/pve-cu/config.json for your PVE host and VM
```

Then run the setup checklist — it validates the config, build artefacts,
Chromium, TLS pinning and the API endpoint **without sending credentials**:

```bash
pve-cu --target <name> fingerprint   # print the PVE certificate digest to pin
pve-cu --target <name> doctor        # config / bundle / chromium / tls / api / credentials / daemon
pve-cu --target <name> observe       # first screenshot
```

`doctor --auth` additionally logs in and reads the VM state, and
`doctor --console` opens a real console and captures one frame.

---

## Architecture

```text
 ┌──────────────────────────────────────────────────────────────┐
 │                     Agent / CLI / Script                     │
 │      inspect frame → plan → run CLI → capture again          │
 └───────────────┬──────────────────────────▲───────────────────┘
     action      │                          │ read the PNG/JPEG
                 ▼                          │
 ┌──────────────────────────────────────────────────────────────┐
 │                   pve-cu CLI / Daemon                        │
 │  one daemon per target: Unix socket, serialized queue, frames │
 │  ┌────────────────┐   ┌───────────────────────────────────┐  │
 │  │ PVE REST API   │   │ headless Chromium + noVNC (RFB)   │  │
 │  │ auth + ticket  │   │ framebuffer + mouse/keyboard      │  │
 │  └───────┬────────┘   └───────────────┬───────────────────┘  │
 │          │        loopback bridge     │                      │
 │          └────────── ws://127.0.0.1 ──┘                      │
 └────────────────────────────┬─────────────────────────────────┘
                              │ wss://pve:8006 (ticket + cookie/token)
                              ▼
                    PVE → target VM console
```

1. The daemon authenticates to the PVE API and requests a one-shot console ticket
   and RFB password via `POST .../qemu/{vmid}/vncproxy?websocket=1`.
2. It starts a loopback bridge on a random `127.0.0.1` port that both serves the
   noVNC adapter page and transparently proxies the browser WebSocket to PVE.
   **PVE credentials, the ticket and TLS verification live only in the daemon
   process**; the browser only receives the bridge URL and the 8-character RFB password.
3. Headless Chromium loads noVNC (`@novnc/novnc` 1.7.0, ESM) and maintains the framebuffer.
4. A screenshot is taken from noVNC's complete framebuffer (`RFB.toDataURL`) and
   written to disk as PNG/JPEG.
5. The mouse uses noVNC pointer events (absolute coordinates); the keyboard uses
   `RFB.sendKey(keysym, code, down)`. QEMU advertises extended key events, so every
   key carries a DOM `code` (scancode) for better Windows compatibility.

---

## Configuration

Config file: `~/.config/pve-cu/config.json` (or `$PVE_CU_CONFIG`).
See [`config.example.json`](config.example.json).

```json
{
  "executablePath": "/usr/bin/google-chrome",
  "targets": {
    "windows-vm": {
      "endpoint": "https://192.0.2.10:8006",
      "node": "pve-node",
      "vmid": 105,
      "auth": { "tokenId": "pve-cu@pve!console", "tokenSecretEnv": "PVE_CU_TOKEN_WINDOWS_VM" },
      "tlsFingerprint": "<64-char hex SHA-256>",
      "imageFormat": "png",
      "frameKeep": 20
    }
  }
}
```

| Field | Description |
|---|---|
| `endpoint` | PVE web/API origin; must be an `https://host:8006` origin |
| `node` / `vmid` | Target node and VM ID |
| `auth.tokenId` + `tokenSecretEnv` | **Recommended**: API token; the secret lives only in an environment variable |
| `auth.username` + `passwordEnv` | User password login (MFA is not supported this way) |
| `tlsFingerprint` | PVE leaf SHA-256, obtained with `fingerprint` (recommended) |
| `caFile` | Alternative: a CA PEM (e.g. `/etc/pve/pve-root-ca.pem`) for full chain validation |
| `insecureTls` | Explicitly disable verification; the daemon logs a warning on start |
| `imageFormat` / `jpegQuality` | `png` (default, crisp text) or `jpeg` |
| `cacheDir` / `socketPath` / `frameKeep` | Runtime directory, socket path, number of frames to keep |
| `executablePath` | Chrome/Chromium binary (falls back to `$PVE_CU_CHROME`) |
| `idleTimeoutMs` | Release the console session (ticket + headless browser) after this much inactivity; default `600000`, `0` disables |
| `idleCheckIntervalMs` | Idle check interval; defaults to `idleTimeoutMs/10`, clamped to 5–60s |

### PVE setup (least privilege)

Create a dedicated user and API token, and grant it only what a console needs.
On the PVE host:

```bash
# 1. dedicated user, no ACLs of its own
pveum user add pve-cu@pve --comment "pve-cu computer use"

# 2. API token with privilege separation (privsep=1, the default)
pveum user token add pve-cu@pve console
#   full-tokenid  pve-cu@pve!console
#   value         xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   (shown only once)

# 3. grant the token VM.Console + VM.Audit on the target VM only
pveum acl modify /vms/105 --tokens 'pve-cu@pve!console' --roles PVEVMUser

# 4. optional: confirm the effective permissions
pveum user token permissions pve-cu@pve 'pve-cu@pve!console'
```

> `PVEVMUser` includes `VM.Console` and `VM.Audit`. Do **not** grant `Sys.*`,
> `VM.Config.*`, `VM.Allocate`, or any other privilege.

If you prefer the token to inherit the user's ACLs instead, create it with
`--privsep 0` and grant the role to the user:

```bash
pveum user token add pve-cu@pve console --privsep 0
pveum acl modify /vms/105 --users pve-cu@pve --roles PVEVMUser
```

Then export the secret (in `~/.bashrc` or a systemd environment file — **never**
in the config file):

```bash
export PVE_CU_TOKEN_WINDOWS_VM='<token secret>'
pve-cu --target windows-vm doctor --auth   # verify login, permissions, node, VM state
```

### TLS trust

PVE signs its certificate with a private cluster CA (`pve-root-ca`) and does
**not** send that CA during the handshake, so the system trust store rejects it.
Two supported options:

```bash
# Option 1 (recommended, no PVE login needed): pin the leaf certificate digest
pve-cu --target windows-vm fingerprint
# put the printed fingerprint into config.json as tlsFingerprint
pve-cu --target windows-vm tlscheck      # reachability + pinning, sends no credentials

# Option 2: fetch the PVE root CA and validate the full chain
scp root@192.0.2.10:/etc/pve/pve-root-ca.pem ~/.config/pve-cu/pve-ca.pem
# then set "caFile": "/home/user/.config/pve-cu/pve-ca.pem"
```

Pinning is implemented with a custom `https.Agent`: after the handshake it verifies
the leaf digest **and the requested address (SAN)**, blocks every write until
verification passes, and destroys the socket on mismatch.

> Node does **not** call `checkServerIdentity` when `rejectUnauthorized` is `false`,
> so "disable verification + custom `checkServerIdentity`" is fake pinning. This
> project does not use that approach.

Two security properties are covered by tests: on a fingerprint mismatch the
**HTTPS request never reaches the peer**, and the bridge's **`wss://` upstream is
never opened** (so the `vncticket`, cookie and RFB password cannot leak to an impostor).

---

## Commands

```bash
pve-cu --target windows-vm status                    # session health, framebuffer size, ticket chain
pve-cu --target windows-vm observe                   # screenshot; prints filePath / width / height
pve-cu --target windows-vm observe --wait-change     # wait for the guest to redraw, then capture
pve-cu --target windows-vm observe --wait-change --wait-timeout 20000
pve-cu --target windows-vm click --x 0.5 --y 0.5
pve-cu --target windows-vm click --x 0.8 --y 0.2 --button right
pve-cu --target windows-vm double-click --x 0.25 --y 0.35
pve-cu --target windows-vm move --x 0.5 --y 0.5
pve-cu --target windows-vm drag --from-x 0.2 --from-y 0.3 --to-x 0.7 --to-y 0.3
pve-cu --target windows-vm scroll --x 0.5 --y 0.5 --dy 4      # dy>0 scrolls down, dy<0 up
pve-cu --target windows-vm type --text "https://example.com"
pve-cu --target windows-vm key --keys "ctrl,l"
pve-cu --target windows-vm key --keys "alt,f4"
pve-cu --target windows-vm reset                     # release every held key and mouse button
pve-cu --target windows-vm reconnect                 # request a fresh ticket and reconnect
pve-cu --target windows-vm daemon stop
pve-cu targets
pve-cu --target windows-vm fingerprint   # certificate digest to pin
pve-cu --target windows-vm tlscheck      # reachability + pinning; sends no credentials
pve-cu --target windows-vm doctor        # setup checklist (no credentials)
pve-cu --target windows-vm doctor --auth     # additionally log in and read the VM state
pve-cu --target windows-vm doctor --console  # additionally open a console and capture one frame
```

**Coordinates** are `0.0..1.0` normalised, pixels of the current framebuffer, or
any space with `--x 500 --y 500 --space 1000`. The target can also come from
`$PVE_CU_TARGET`.

**Argument parsing** accepts `--key value`, `--key=value` and `-t value`. Negative
numbers are treated as values (`--dy -2` scrolls up); any *text* starting with `-`
must use the `=` form, e.g. `pve-cu --target x type --text=-verbose`.

**Secrets must never appear in `argv`.** Use a file or stdin:

```bash
pve-cu --target windows-vm type --from-file "$HOME/.config/pve-cu/windows-vm-password"
cat secret.txt | pve-cu --target windows-vm type --stdin
```

### Waiting for the guest to redraw

- `--wait-change` uses the framebuffer counter of the **last input action** as its
  baseline, so a redraw caused by a click returns immediately. A timeout is not an
  error (a static screen pushes no updates); the frame is still valid and `changed: false`.
- `--wait-stable` waits for a bounded window of no redraws (default: at least
  `--min-wait 1500`ms observed, `--stable-ms 800`ms quiet, `--wait-timeout 5000`ms).
  It is a quiescence heuristic, **not** proof that a window is focused or ready;
  a blinking caret can keep it from settling. The final frame is always returned,
  with `stable:false` / `timedOut:true` in that case.
- Input actions accept `--observe` to run the action and the capture in one
  serialized daemon task, returning `frame` plus `timings.actionMs/observationMs/totalMs`.
  If the capture fails, the action result is preserved and `observationError` is
  added — **never retry the input because of a screenshot failure**.

`observe` output:

```json
{
  "frameId": "frame_2026-09-06_19-43-12-000_a1b2c3",
  "filePath": "/home/user/.cache/pve-cu/windows-vm/frames/frame_....png",
  "width": 1920, "height": 1080,
  "capturedAt": "2026-09-06T19:43:12.000Z",
  "framebufferUpdates": 42, "lastUpdateAt": "...",
  "changed": true, "waitedMs": 320
}
```

---

## Testing and development

```bash
npm test             # unit + offline RFB end-to-end + mock-PVE integration
npm run check        # syntax check of src/ and scripts/
npm run build        # rebuild web/dist/console.bundle.js
npm run smoke        # headless Chrome + bundle + adapter wiring (no PVE required)
npm run debug:rfb    # connect to a fake VNC server and print the handshake/input events
npm run mock-console # boot a mock PVE and capture a four-quadrant frame to eyeball pixel order
```

Tests that need a browser or `openssl` are **skipped automatically** when the
dependency is missing, so `npm test` is safe on a minimal machine. In CI, GitHub's
`ubuntu-latest` image provides Google Chrome and `openssl`.

Validation against a real PVE host is recorded in [docs/validation.md](docs/validation.md).

---

## Known limitations

- **First screenshot is slow.** The first `status`/`observe` performs auth, ticket
  exchange and a headless browser launch, and waits for the first framebuffer
  update; those commands use a 120s timeout. Do not issue concurrent retries.
- **ASCII only.** Chinese (and other non-ASCII) text cannot be injected directly;
  type pinyin in a guest input method and select candidates, verifying each step
  with a screenshot.
- **One console at a time.** Do not use the PVE web console while an agent is
  driving the VM, or input will be interleaved.
- **Pinned to `@novnc/novnc` 1.7.0.** The adapter uses internal methods
  (`_handleMouseButton`, `_sendMouse`, `_framebufferUpdate`, `_display.flush`);
  re-run `npm test` before upgrading — the offline RFB end-to-end test fails
  immediately on protocol or internal-API changes.
- **Resolution changes invalidate pixel coordinates.** The daemon resizes the
  browser viewport when the guest changes resolution; prefer normalised coordinates
  and take a fresh screenshot.
- **Idle release.** After `idleTimeoutMs` without activity, the daemon releases all
  keys and closes the session (ticket + browser) so it does not hold the console
  indefinitely. The next command transparently reconnects, so the first command
  after a long pause is slower — this is expected.
- **Chromium sandbox.** If the kernel lacks user namespaces, the daemon falls back
  to `--no-sandbox` and records it in `status.notes`.

---

## Security

- PVE credentials, console tickets and TLS verification are confined to the daemon
  process. The adapter page in the browser only receives a loopback URL and the
  short-lived RFB password.
- The daemon socket is created with `0600`; runtime directories and frames use `0700`/`0600`.
- TLS pinning verifies the leaf digest and SAN before any request byte is written;
  on mismatch the socket is destroyed rather than downgraded.
- Passwords and tokens should only ever be passed via environment variables or
  `type --from-file` / `--stdin`, never as CLI arguments.

See [SECURITY.md](SECURITY.md) for the vulnerability reporting process.

## License

[MIT](LICENSE) © 2026 drgnchan

[中文文档](README.zh-CN.md)
