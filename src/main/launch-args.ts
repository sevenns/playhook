// Pure command-line argument helpers, split out of game-launcher.ts.
// game-launcher.ts imports koffi and evaluates koffi.struct/union at module load, which drags a
// native FFI addon into any importer — impossible to unit-test in plain Node. These helpers are
// pure string logic (quoting rules, installer flag families) with no koffi/electron dependency, so
// they live here and can be covered directly. game-launcher.ts re-exports them for its own use.
import { type InstallManifest } from '../shared/types';

/**
 * Quotes a single argument for ShellExecuteEx's raw lpParameters command line, following the
 * CommandLineToArgvW rules (backslashes are literal except before a quote). spawn did this for us;
 * the elevated path passes one raw string, so we must quote args containing whitespace or quotes.
 */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Escape the run of backslashes (each doubled) plus the quote itself.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes precede the closing quote → double them so they stay literal.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

export function buildParameters(args: readonly string[]): string {
  return args.map(quoteArg).join(' ');
}

/**
 * Builds the FINAL installer argument tokens for a silent install into `dir`, with each family's
 * silent flags and the dir-key:
 * - `nsis`  → `/S` … `/D=<dir>` — `/D=` MUST be last and always UNQUOTED (NSIS reads everything after
 *   it, to end of line, as the path — even with spaces), on both platforms.
 * - `inno`  → `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=<dir>` … — Inno's `/DIR=` quoting is the
 *   ONLY platform-varying piece (Р7): see `quoteDir`.
 * - `custom`→ the card author's own args, with `{dir}` substituted; they own the quoting/flags.
 * Extra `customArgs` for nsis/inno are appended (after the silent flags, before the trailing `/D=` for nsis).
 *
 * `quoteDir` decides whether Inno's `/DIR=` value is wrapped in quotes:
 * - win32 (`true`): the tokens are passed VERBATIM (`windowsVerbatimArguments: true`), so the quotes must
 *   be baked in — Inno needs `/DIR="<dir>"`.
 * - linux (`false`): the tokens travel as SEPARATE argv strings through umu → python → Proton → wine (no
 *   `windowsVerbatimArguments`), so baked-in quotes would reach Inno escaped. The install dir has no
 *   spaces by construction (`%LOCALAPPDATA%`-free `C:\playhook\games\<id>`), so `/DIR=<dir>` is safe.
 */
export function buildInstallerArgs(
  type: InstallManifest['type'],
  dir: string,
  customArgs: readonly string[],
  quoteDir: boolean,
): string[] {
  switch (type) {
    case 'nsis':
      return ['/S', ...customArgs, `/D=${dir}`];
    case 'inno': {
      const dirArg = quoteDir ? `/DIR="${dir}"` : `/DIR=${dir}`;
      return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', dirArg, ...customArgs];
    }
    case 'custom':
      return customArgs.map((arg) => arg.replaceAll('{dir}', dir));
  }
}
