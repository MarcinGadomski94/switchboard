/**
 * `npm run frame-helper:safari` (D28, `docs/frame-helper.md`): wraps the frame
 * helper extension (`tools/frame-helper/`) into a local macOS app for Safari with
 * Apple's `safari-web-extension-converter`, then builds it with `xcodebuild`
 * (Debug, signed to run locally: no Apple account). Everything lands in
 * `.frame-helper-safari/` at the repo root (gitignored): the staged extension, the
 * Xcode project and the build. Nothing is installed, no Safari setting is changed
 * and nothing needs sudo; the steps only the developer can take are printed at the
 * end. macOS with Xcode only.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The extension's own files (everything else in the folder, this script included, stays out). */
export const EXTENSION_FILES: readonly string[] = ['manifest.json', 'background.js', 'marker.js', 'storage-access.js'];

/** The macOS app's name (the converter's `--app-name`). */
export const APP_NAME = 'Switchboard Frame Helper';

/** The app's bundle identifier (reverse DNS; local only, never published). */
export const BUNDLE_ID = 'local.switchboard.framehelper';

/** Output folder, relative to the repo root (gitignored). */
export const OUTPUT_DIR = '.frame-helper-safari';

/**
 * The manifest as Safari gets it: without Chrome's own `minimum_chrome_version`.
 * The rest is unchanged: the rules are session rules the service worker
 * (`background.js`) sets at run time (`tabIds` + `requestDomains`, no
 * `initiatorDomains`), so no static rule needs a Safari form any more.
 */
export function safariManifest(manifest: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { minimum_chrome_version: _chromeOnly, ...rest } = manifest;
  return rest;
}

/** `xcrun` arguments of the conversion of `extensionDir` into an Xcode project under `projectLocation`. */
export function converterArgs(extensionDir: string, projectLocation: string): string[] {
  return [
    'safari-web-extension-converter',
    extensionDir,
    '--project-location',
    projectLocation,
    '--app-name',
    APP_NAME,
    '--bundle-identifier',
    BUNDLE_ID,
    '--macos-only',
    '--no-open',
    '--no-prompt',
    '--copy-resources',
  ];
}

/** `xcodebuild` arguments of a Debug build of `scheme`, signed to run locally (ad hoc, no team). */
export function xcodebuildArgs(project: string, scheme: string, derivedData: string): string[] {
  return [
    '-project',
    project,
    '-scheme',
    scheme,
    '-configuration',
    'Debug',
    '-derivedDataPath',
    derivedData,
    'CODE_SIGN_STYLE=Manual',
    'CODE_SIGN_IDENTITY=-',
    'DEVELOPMENT_TEAM=',
    'PROVISIONING_PROFILE_SPECIFIER=',
    'build',
  ];
}

/** The macOS scheme among `xcodebuild -list -json`'s: the app's own, else one ending in `(macOS)`, else the first. */
export function pickScheme(schemes: readonly string[]): string | null {
  return schemes.find((scheme) => scheme === APP_NAME) ?? schemes.find((scheme) => /\(macOS\)$/.test(scheme)) ?? schemes[0] ?? null;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
}

/** Runs `command args` (no shell), streaming its output unless `capture`. */
function run(command: string, args: readonly string[], options: { readonly cwd: string; readonly capture?: boolean }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout }));
  });
}

function fail(message: string): never {
  console.error(`\nframe-helper:safari: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') fail('Safari extensions are built on macOS with Xcode.');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const sourceDir = import.meta.dirname;
  const outDir = path.join(repoRoot, OUTPUT_DIR);
  const stagedDir = path.join(outDir, 'extension');
  const projectLocation = path.join(outDir, 'project');
  const derivedData = path.join(outDir, 'DerivedData');

  const firstLaunch = await run('xcodebuild', ['-checkFirstLaunchStatus'], { cwd: repoRoot, capture: true });
  if (firstLaunch.code !== 0) {
    fail(
      "Xcode's first-launch components are not installed (xcodebuild -checkFirstLaunchStatus exited " +
        `${firstLaunch.code}); safari-web-extension-converter crashes without them ("A required plugin failed to load").\n` +
        'Install them once yourself (it needs an admin password): open Xcode and accept the component install, or run\n' +
        '  sudo xcodebuild -runFirstLaunch\n' +
        'then run npm run frame-helper:safari again.',
    );
  }

  // 1. Stage the extension's own files, the manifest in Safari's form (docs/frame-helper.md → Safari).
  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(stagedDir, { recursive: true });
  for (const file of EXTENSION_FILES) {
    const text = await readFile(path.join(sourceDir, file), 'utf8');
    if (file === 'manifest.json') await writeFile(path.join(stagedDir, file), `${JSON.stringify(safariManifest(JSON.parse(text) as Record<string, unknown>), null, 2)}\n`);
    else await writeFile(path.join(stagedDir, file), text);
  }

  // 2. Convert (a fresh project each time: the folder is ours alone).
  await rm(projectLocation, { recursive: true, force: true });
  console.log(`\n→ xcrun ${converterArgs(path.relative(repoRoot, stagedDir), path.relative(repoRoot, projectLocation)).join(' ')}`);
  const converted = await run('xcrun', converterArgs(stagedDir, projectLocation), { cwd: repoRoot });
  if (converted.code !== 0) fail(`safari-web-extension-converter exited ${converted.code}.`);
  const projectDir = path.join(projectLocation, APP_NAME);
  const project = path.join(projectDir, `${APP_NAME}.xcodeproj`);

  // 3. Build the app: Debug, signed to run locally.
  const listed = await run('xcodebuild', ['-list', '-json', '-project', project], { cwd: projectDir, capture: true });
  let schemes: string[] = [];
  try {
    schemes = (JSON.parse(listed.stdout) as { project?: { schemes?: string[] } }).project?.schemes ?? [];
  } catch {
    schemes = [];
  }
  const scheme = pickScheme(schemes);
  if (listed.code !== 0 || !scheme) fail(`could not read the schemes of ${project} (xcodebuild -list exited ${listed.code}).`);
  console.log(`\n→ xcodebuild ${xcodebuildArgs(path.relative(repoRoot, project), scheme, path.relative(repoRoot, derivedData)).join(' ')}`);
  const built = await run('xcodebuild', xcodebuildArgs(project, scheme, derivedData), { cwd: projectDir });
  if (built.code !== 0) fail(`xcodebuild exited ${built.code}.`);
  const app = path.join(derivedData, 'Build', 'Products', 'Debug', `${APP_NAME}.app`);

  console.log(`
Built: ${app}

Next, once (docs/frame-helper.md → Safari):
  1. Open the app once, so Safari sees the extension:
       open "${app}"
  2. The app is signed to run locally only, so Safari lists it only with unsigned
     extensions allowed: Safari → Settings → Advanced → "Show features for web
     developers", then Settings → Developer → "Allow unsigned extensions" (Safari
     asks again after every restart).
  3. Safari → Settings → Extensions → turn on "Switchboard frame helper" and allow
     it on every website (or at least 127.0.0.1, localhost and your sites).
Known limit: Safari's extensions cannot remove response headers yet, so a site that
refuses frames (Jira) still shows "can't open in a frame in this browser" there.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
