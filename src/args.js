/**
 * Argument parsing shared by the CLI and its tests.
 *
 * Values may be given as `--key value`, `--key=value` or `-k value`. A token
 * starting with `-` is still consumed as a value when it looks numeric, so
 * `--dy -2` scrolls up instead of turning `dy` into a boolean flag. Use the
 * `=` form for any other value that begins with a dash (e.g. `--text=-v`).
 */
const NUMERIC = /^-[0-9.]/;

export function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }

    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.replace(/^-+/, '');
      const equals = body.indexOf('=');
      if (equals !== -1) {
        options[normalize(body.slice(0, equals))] = body.slice(equals + 1);
        continue;
      }
      const name = normalize(body);
      const next = argv[index + 1];
      if (next !== undefined && (!next.startsWith('-') || NUMERIC.test(next))) {
        options[name] = next;
        index++;
      } else {
        options[name] = true;
      }
      continue;
    }

    positional.push(arg);
  }

  return { command: positional.shift() || 'status', positional, options };
}

function normalize(key) {
  return key === 't' ? 'target' : key;
}
