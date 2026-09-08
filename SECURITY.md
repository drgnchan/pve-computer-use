# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, using GitHub's
[private security advisory](https://github.com/drgnchan/pve-computer-use/security/advisories/new)
for this repository. Do not open a public issue for an unfixed vulnerability.

Please include a description, reproduction steps, and the affected version or
commit. You can expect an initial response within a few days.

## Design notes

`pve-cu` handles PVE credentials and a live console session, so a few properties
are deliberate:

- **Credentials stay in the daemon.** The PVE password/API token, the console
  ticket and TLS verification are confined to the daemon process. The noVNC page
  loaded in the headless browser only receives a loopback bridge URL and the
  short-lived 8-character RFB password.
- **TLS pinning is real.** The custom `https.Agent` completes the handshake
  permissively, then verifies the leaf SHA-256 and the requested address (SAN)
  before releasing any queued write. On mismatch the socket is destroyed, so no
  request byte — and therefore no credential — reaches the peer. Node does not
  call `checkServerIdentity` when `rejectUnauthorized` is `false`, so that pattern
  is not used.
- **Secrets do not travel through `argv`.** Use `type --from-file` or `--stdin`;
  the environment variable names in the config are references, not secrets.
- **File permissions.** The daemon socket is `0600`; runtime directories are `0700`
  and captured frames are written `0600`.

## Scope

This tool intentionally grants control of a VM console. Treat a configured target
like shell access to that VM and keep its API token scoped to `VM.Console` +
`VM.Audit` on the single target VM.
