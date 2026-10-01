import type { CliInfo } from '../../../core/api.ts';

/**
 * D62 · Settings → CLIs (`docs/providers.md` → *Settings*): the pure part. A
 * command field takes what `SWITCHBOARD_<X>_BIN` takes: a program path or name,
 * or a JSON array (the program, then its arguments). Never shell-parsed.
 */

/** The command as the field shows it: the bare program, else the JSON array. */
export function commandText(command: readonly string[]): string {
  return command.length === 1 ? (command[0] as string) : JSON.stringify(command);
}

/** The field's text as an argv prefix; `null` = not a usable command (with why). */
export function parseCommandText(text: string): { readonly ok: true; readonly command: string[] } | { readonly ok: false; readonly message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Type a program path or a JSON array' };
  if (!trimmed.startsWith('[')) return { ok: true, command: [trimmed] };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === 'string' && part.trim() !== '')) return { ok: true, command: parsed as string[] };
  } catch {
    // Falls through to the message.
  }
  return { ok: false, message: 'A JSON array of non-empty strings, e.g. ["node", "/path/to/cli.js"]' };
}

/** Where the command comes from, in words. */
export function commandSourceText(cli: CliInfo): string {
  switch (cli.commandSource) {
    case 'settings':
      return 'set here (overrides the environment)';
    case 'env':
      return `from ${cli.envVar}`;
    case 'default':
      return `looked up on PATH (set ${cli.envVar}${cli.provider === 'claude' ? '' : ' or override it here'})`;
  }
}

/** The state line: "✓ codex-cli 0.159.3 · signed in" / "Not installed" / "Signed out". */
export function cliStateText(cli: CliInfo): string {
  if (!cli.supported) return 'Not supported by this Switchboard';
  if (!cli.installed) return 'Not installed';
  const version = cli.version ? `✓ ${cli.version}` : '✓ installed';
  if (cli.signedIn === true) return `${version} · signed in${cli.account ? ` (${cli.account})` : ''}`;
  if (cli.signedIn === false) return `${version} · signed out`;
  return `${version}${cli.account ? ` · ${cli.account}` : ''}`;
}

/** The state's tone (the value color). */
export function cliStateTone(cli: CliInfo): 'ok' | 'warn' | 'off' {
  if (!cli.supported || !cli.installed) return 'off';
  return cli.signedIn === false ? 'warn' : 'ok';
}

/** The models line: their names, or why there are none yet. */
export function modelsText(cli: CliInfo): string {
  if (!cli.models || cli.models.length === 0) return cli.installed ? 'Reported by its first session (or Check)' : '—';
  return cli.models.map((model) => model.label).join(', ');
}
