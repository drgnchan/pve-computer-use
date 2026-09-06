import https from 'node:https';
import tls from 'node:tls';

const TIMEOUT_MS = 20_000;

/**
 * Minimal PVE REST client: authenticates, then asks for a VNC console
 * ticket. Verified against pve-qemu-server src/PVE/API2/Qemu.pm:
 *   - vncproxy with websocket=1 returns ticket ("<vnc password>:PVEVNC:..."),
 *     an explicit 8 char `password` for the RFB handshake and a local `port`;
 *   - vncwebsocket additionally requires normal API auth (cookie or API token).
 */
export class PveApi {
  constructor(config) {
    this.config = config;
    this.headers = {};
  }

  tlsOptions() { return { ...this.config.tlsOptions }; }

  request(method, pathname, values = {}) {
    const body = new URLSearchParams(values).toString();
    const url = new URL(`/api2/json${pathname}`, this.config.endpoint);
    const headers = { ...this.headers };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
      const request = https.request(url, { ...this.tlsOptions(), method, headers, timeout: TIMEOUT_MS }, response => {
        let raw = '';
        response.on('data', chunk => {
          raw += chunk;
          if (raw.length > 4_000_000) request.destroy(new Error('PVE response too large'));
        });
        response.on('end', () => {
          if (response.statusCode === 401 || response.statusCode === 403) {
            reject(new Error(`PVE rejected the request (${response.statusCode}); check credentials and that the user has VM.Console on VMID ${this.config.vmid}`));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`PVE API ${method} ${pathname} failed with HTTP ${response.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(raw).data); } catch { reject(new Error('PVE returned a malformed JSON response')); }
        });
      });
      request.on('timeout', () => request.destroy(new Error(`PVE API ${pathname} timed out after ${TIMEOUT_MS}ms`)));
      request.on('error', error => reject(new Error(describeTlsError(error, this.config))));
      request.end(method === 'POST' ? body : undefined);
    });
  }

  async authenticate() {
    const auth = this.config.auth;
    this.headers = {};
    if (auth.tokenId && auth.tokenSecretEnv) {
      const secret = process.env[auth.tokenSecretEnv];
      if (!secret) throw new Error(`Environment variable ${auth.tokenSecretEnv} (API token secret) is not set`);
      this.headers.Authorization = `PVEAPIToken=${auth.tokenId}=${secret}`;
      await this.request('GET', `/nodes/${this.config.node}/qemu/${this.config.vmid}/status/current`);
      return { method: 'api-token' };
    }
    if (auth.username && auth.passwordEnv) {
      const password = process.env[auth.passwordEnv];
      if (!password) throw new Error(`Environment variable ${auth.passwordEnv} (PVE password) is not set`);
      const login = await this.request('POST', '/access/ticket', { username: auth.username, password });
      if (login?.NeedTFA) throw new Error('This PVE user requires MFA for API login; create a dedicated user with an API token instead');
      if (!login?.ticket || !login.CSRFPreventionToken) throw new Error('PVE login succeeded but returned no usable ticket');
      // The web UI stores the ticket with escape(); percent encoding is decoded server side.
      this.headers = {
        Cookie: `PVEAuthCookie=${encodeURIComponent(login.ticket)}`,
        CSRFPreventionToken: login.CSRFPreventionToken,
      };
      return { method: 'ticket', username: login.username };
    }
    throw new Error('Target auth must set tokenId+tokenSecretEnv or username+passwordEnv');
  }

  /** Opens a console session and returns everything the bridge/page needs. */
  async openConsole() {
    const base = `/nodes/${this.config.node}/qemu/${this.config.vmid}`;
    const status = await this.request('GET', `${base}/status/current`);
    if (status?.qemu !== 'running' && status?.status !== 'running') {
      throw new Error(`VMID ${this.config.vmid} is not running (state: ${status?.qemu || status?.status || 'unknown'}); start it first`);
    }
    const proxy = await this.request('POST', `${base}/vncproxy`, { websocket: '1' });
    if (!proxy?.ticket || !proxy?.port) throw new Error('PVE did not return a usable console ticket');
    if (!proxy.password) throw new Error('PVE did not return the RFB console password; check the PVE version');
    const url = new URL(`/api2/json${base}/vncwebsocket`, this.config.endpoint);
    url.protocol = 'wss:';
    url.search = new URLSearchParams({ port: String(proxy.port), vncticket: proxy.ticket }).toString();
    return { upstreamUrl: url.href, password: proxy.password, headers: this.headers, tlsOptions: this.tlsOptions(), vmName: status.name || null };
  }

  /** Prints the served certificate digest so it can be pinned in config. */
  peerFingerprint() {
    const url = new URL(this.config.endpoint);
    return new Promise((resolve, reject) => {
      const socket = tls.connect(Number(url.port || 443), url.hostname, { ...this.tlsOptions(), servername: url.hostname, timeout: TIMEOUT_MS }, () => {
        const certificate = socket.getPeerCertificate(true);
        const digest = socket.getPeerX509Certificate?.()?.fingerprint256 || certificate.fingerprint256;
        socket.end();
        resolve({ fingerprint: String(digest || '').replace(/:/g, '').toLowerCase(), subject: certificate.subject, issuer: certificate.issuer, validTo: certificate.valid_to });
      });
      socket.on('timeout', () => socket.destroy(new Error('TLS handshake timed out')));
      socket.on('error', error => reject(new Error(describeTlsError(error, this.config))));
    });
  }
}

function describeTlsError(error, config) {
  const hint = config.caFile || config.tlsFingerprint || config.insecureTls
    ? 'verify the configured caFile/tlsFingerprint'
    : 'PVE uses a self-signed certificate: run `pve-cu --target <t> fingerprint` and pin the digest with tlsFingerprint, or set caFile';
  return `Cannot reach ${config.endpoint} (${error.code || error.message}); ${hint}`;
}
