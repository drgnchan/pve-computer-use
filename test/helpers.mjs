import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** Self-signed leaf with an IP SAN for 127.0.0.1, like a PVE host certificate. */
export function selfSignedCert(dir, cn = '127.0.0.1') {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', `/CN=${cn}/O=Fake PVE`,
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}
