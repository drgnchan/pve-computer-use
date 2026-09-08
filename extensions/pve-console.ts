import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { runPiConsole } from '../src/pi-tool.js';

export default function (pi: ExtensionAPI) {
  const busy = new Set<string>();
  const duration = () => Type.Optional(Type.Integer({ minimum: 0, maximum: 120000 }));
  pi.registerTool({
    name: 'pve_console',
    label: 'PVE Console',
    description: 'Observe a fixed configured PVE VM or perform ONE input action and return its screenshot inline. Load pve-computer-use skill first. Never batch dependent actions or retry input on a timeout. Inspect the returned image before proceeding; stable is a redraw heuristic, NOT proof of UI readiness/focus. text is for public ASCII only; passwords use fromFile, TOTP uses the dedicated MCP. Metadata is bounded to 16000 characters; screenshots to 20MB.',
    promptSnippet: 'PVE VM console: one action plus inline screenshot, secret-safe password file input',
    parameters: Type.Object({
      target: Type.String({ pattern: '^[a-zA-Z0-9_-]+$' }),
      action: StringEnum(['observe', 'click', 'double-click', 'move', 'scroll', 'key', 'type', 'reset'] as const),
      x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()),
      dy: Type.Optional(Type.Number()),
      button: Type.Optional(StringEnum(['left', 'right', 'middle'] as const)),
      keys: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ description: 'Public ASCII ONLY. Never passwords, tokens or OTP.' })),
      fromFile: Type.Optional(Type.String({ description: 'Absolute or ~/ path to a local password file; content never enters tool arguments.' })),
      wait: Type.Optional(StringEnum(['none', 'change', 'stable'] as const)),
      waitTimeoutMs: duration(), stableMs: duration(), minWaitMs: duration(),
    }),
    async execute(_id, params, signal) {
      if (busy.has(params.target)) throw new Error('Another pve_console call is in flight for this target. Wait and inspect its image.');
      busy.add(params.target);
      try { return await runPiConsole(params, { exec: pi.exec.bind(pi), signal }); }
      finally { busy.delete(params.target); }
    },
  });
}
