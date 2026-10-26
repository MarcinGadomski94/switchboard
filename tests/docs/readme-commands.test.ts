import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * Copyable command blocks must paste safely as a whole into macOS zsh (where
 * `interactive_comments` is off by default, so `# …` is run as a command),
 * Linux bash and Windows PowerShell: no comment lines, no trailing ` # `
 * comments and no `$ ` prompts. Explanations go in the prose around a block.
 */
const FILES = ['README.md', 'docs/setup.md', 'docs/updates.md', 'docs/service.md', 'docs/install-app.md', 'docs/publishing.md'];
const SHELL_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'powershell', 'ps1', 'pwsh']);

interface Block {
  lang: string;
  line: number;
  lines: string[];
}

function shellBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  markdown.split('\n').forEach((text, index) => {
    const fence = /^\s*```\s*([\w-]*)/.exec(text);
    if (fence) {
      if (open) {
        if (SHELL_LANGS.has(open.lang)) blocks.push(open);
        open = null;
      } else {
        open = { lang: (fence[1] ?? '').toLowerCase(), line: index + 1, lines: [] };
      }
      return;
    }
    open?.lines.push(text);
  });
  return blocks;
}

function problems(block: Block): string[] {
  return block.lines.flatMap((text) => {
    if (/^\s*#/.test(text)) return [`comment line: ${text}`];
    if (/\s#\s/.test(text)) return [`trailing comment: ${text}`];
    if (/^\s*\$ /.test(text)) return [`prompt: ${text}`];
    return [];
  });
}

describe('copyable command blocks', () => {
  it.each(FILES)('%s has paste-safe command blocks', (file) => {
    const blocks = shellBlocks(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const found = blocks.flatMap((block) => problems(block).map((p) => `${file}:${block.line} (${block.lang || 'untagged'}) ${p}`));
    expect(found).toEqual([]);
  });

  // The npx line comes back once @marcingadomski94/switchboard is on npm (docs/publishing.md).
  it('finds the README one-liners: install.sh piped to sh, install.ps1 piped to iex', () => {
    const blocks = shellBlocks(readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8'));
    const lines = blocks.flatMap((block) => block.lines.filter((line) => line.trim() !== ''));
    expect(lines).toEqual(expect.arrayContaining([
      'curl -fsSL https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.sh | sh',
      'irm https://raw.githubusercontent.com/MarcinGadomski94/switchboard/master/install.ps1 | iex',
    ]));
    expect(blocks.map((block) => block.lang)).toEqual(expect.arrayContaining(['sh', 'powershell']));
  });

  it('finds the manual install blocks in docs/setup.md', () => {
    const blocks = shellBlocks(readFileSync(path.join(REPO_ROOT, 'docs/setup.md'), 'utf8'));
    expect(blocks.map((block) => block.lang)).toEqual(expect.arrayContaining(['sh', 'bash', 'powershell']));
    expect(blocks.filter((block) => block.lines.includes('npm ci --omit=dev'))).toHaveLength(3);
  });

  it('flags comments and prompts', () => {
    const bad = shellBlocks('```sh\n# note\nnpm ci   # deps\n$ npm start\n```\n')[0];
    expect(bad && problems(bad)).toHaveLength(3);
  });
});
