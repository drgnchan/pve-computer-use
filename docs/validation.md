# Validation

This page records what has been verified against a real Proxmox VE host and in
the offline test suite. It is a development log, not a claim about your setup.

## Against a real PVE host

Verified against a Proxmox VE host (`https://192.0.2.10:8006`, example address),
without sending credentials and without touching any VM:

- `fingerprint`: leaf SHA-256 `<sha256-fingerprint>`, CN `pve-node.lan`, issuer
  `Proxmox Virtual Environment`, SAN `IP Address:192.0.2.10`, valid until 2028-06.
- The handshake sends **only the leaf** (chain length 1), so no CA can be derived
  from it — which is why pinning (or an explicit `caFile`) is required.
- `tlscheck`: pinning active; `/access/domains` returns `pam`/`pve`; ~41 ms round trip.

End-to-end against a real VM (VMID 105, Windows 11):

- `tlscheck` / `doctor --console` fully green; first frame 1280x800 and complete
  (`fullFrame: true`).
- Absolute pointer positioning, clicks landing on real UI, `--wait-change`
  returning in 81 ms.
- Keyboard including SAS: `ctrl,alt,delete` reveals the credential screen
  (required by machines with secure login).
- `type --from-file` + `Enter` completes a real login and reaches the desktop.
- Findings that shaped the operational guidance: software-cursor redraw lag, and
  the need for SAS on secure-login machines.

Reproduce:

```bash
pve-cu --target windows-vm doctor --console
```

## Offline test suite

`npm test` runs unit tests, an offline RFB end-to-end test (a self-hosted fake
VNC server over WebSocket, emulating PVE's `vncwebsocket`), and a mock-PVE
integration test (real `bin/pve-cu.js` → real daemon → real `PveApi`/bridge/Chromium
→ fake PVE REST + WebSocket).

Covered, among others:

- **Mock PVE full chain**: API-token and user-password auth, the
  `vncproxy(websocket=1)` request, the CSRF header, the requirement that the
  WebSocket upgrade carries API auth, PNG output, `click`/`right`/`scroll`/`drag`/
  `key`/`type`/`reset`, 401 and out-of-range rejection, `daemon stop` socket cleanup,
  no console for a stopped VM, and all three `doctor` modes.
- **Config / coordinates / keys**: validation, normalised/pixel/custom-space
  coordinates, keysym + DOM `code` planning, CLI argument parsing.
- **Bridge**: page hosting, token check, `binary` subprotocol, Cookie/Authorization
  pass-through, bidirectional byte forwarding.
- **Daemon**: serialized action dispatch, `0600` frames, frame pruning, invalid
  input rejected before it reaches the console.
- **TLS pinning**: correct fingerprint accepted across repeated requests (TLS
  session reuse is disabled because it would hide the certificate), wrong
  fingerprint rejected with **no request sent**, SAN mismatch rejected, `caFile`
  full-chain validation, and the bridge's `wss://` upstream equally protected.
- **`observe --wait-change`**: returns immediately on a server push, and
  `changed:false` on a static screen when the timeout expires.
- **Pixel channel order**: a fake server paints four quadrants (red/green/blue/white);
  the decoded canvas is read back and asserted, and `npm run mock-console` writes a
  real PNG for visual confirmation (noVNC's Raw decoder copies 32bpp bytes directly,
  so the wire order must be R,G,B,X — QEMU little-endian, red-shift 0).
- **RFB end-to-end**: 3.008 handshake, VNC auth (type 2, confirming the password
  participates in the challenge response), ServerInit/resolution, Raw framebuffer →
  PNG, absolute PointerEvents with left/right/wheel bits, QEMU extended key events
  (scancodes such as 0x1d/0x26/0xc8) with a plain KeyEvent fallback, and a visible
  authentication failure.
- **Regression tests added during review**: per-session `--wait-change` baseline
  reset on idle release and reconnect, and `releaseAll` releasing a held button at
  the last pointer position instead of the top-left corner.
