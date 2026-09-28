import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_FILTERS,
  type ArtifactRowFields,
  artifactLocation,
  artifactSearchText,
  matchesArtifactQuery,
  parseTypeParam,
  typeParam,
} from '../../src/core/artifacts-view.ts';
import { ARTIFACT_TYPES } from '../../src/core/model.ts';

const row = (fields: Partial<ArtifactRowFields>): ArtifactRowFields => ({
  type: 'DIFF',
  name: 'Pages/Checkout · 2 files',
  solution: 'alpha-front',
  branch: 'session/pay',
  meta: null,
  sessionName: 'pay-flow',
  ...fields,
});

describe('Artifacts view filters (M7.3, the prototype artFilters + AMAP)', () => {
  it('lists the five pills in order with their types', () => {
    expect(ARTIFACT_FILTERS.map((f) => [f.label, f.types])).toEqual([
      ['All', null],
      ['Diffs', ['DIFF']],
      ['PRs / branches', ['PR', 'BRANCH']],
      ['Docs & contracts', ['DOC', 'CONTRACT', 'QA', 'FOLLOWUP']],
      ['Ticket replies', ['TICKET']],
    ]);
  });

  it('covers every artifact type exactly once', () => {
    const covered = ARTIFACT_FILTERS.flatMap((f) => f.types ?? []);
    expect([...covered].sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  it('turns a pill into the type= value and back', () => {
    expect(ARTIFACT_FILTERS.map(typeParam)).toEqual([undefined, 'DIFF', 'PR,BRANCH', 'DOC,CONTRACT,QA,FOLLOWUP', 'TICKET']);
    for (const filter of ARTIFACT_FILTERS) {
      expect(parseTypeParam(typeParam(filter))).toEqual({ ok: true, types: filter.types });
    }
  });
});

describe('parseTypeParam', () => {
  it('missing or blank means every type', () => {
    for (const raw of [undefined, null, '', ' ', ',', [], 42]) expect(parseTypeParam(raw)).toEqual({ ok: true, types: null });
  });

  it('accepts commas, spaces, lower case, repeats and a repeated parameter', () => {
    expect(parseTypeParam(' pr , Branch ')).toEqual({ ok: true, types: ['PR', 'BRANCH'] });
    expect(parseTypeParam(['DIFF', 'doc,DIFF'])).toEqual({ ok: true, types: ['DIFF', 'DOC'] });
  });

  it('refuses anything that is not an artifact type', () => {
    expect(parseTypeParam('PR,Diffs,INFO')).toEqual({ ok: false, unknown: ['Diffs', 'INFO'] });
  });
});

describe('artifactLocation (Solution · branch column)', () => {
  it('solution ⎇ branch, the solution alone, root for the workspace root', () => {
    expect(artifactLocation(row({}))).toBe('alpha-front ⎇ session/pay');
    expect(artifactLocation(row({ branch: null }))).toBe('alpha-front');
    expect(artifactLocation(row({ solution: null, branch: null, type: 'CONTRACT' }))).toBe('root');
    expect(artifactLocation(row({ solution: null, type: 'DOC' }))).toBe('root ⎇ session/pay');
  });

  it('a BRANCH artifact does not repeat its own branch', () => {
    expect(artifactLocation(row({ type: 'BRANCH', name: 'feature/x', branch: 'feature/x' }))).toBe('alpha-front');
    expect(artifactLocation(row({ type: 'BRANCH', name: 'feature/x', branch: 'feature/x', solution: null }))).toBe('root');
    expect(artifactLocation(row({ type: 'BRANCH', name: 'feature/x', branch: 'other' }))).toBe('alpha-front ⎇ other');
  });
});

describe('matchesArtifactQuery', () => {
  const diff = row({ meta: '+12 −3' });

  it('matches type, name, location, session and status, case-insensitively', () => {
    expect(artifactSearchText(diff)).toBe('DIFF Pages/Checkout · 2 files alpha-front ⎇ session/pay pay-flow +12 −3');
    for (const q of ['diff', 'checkout', 'ALPHA-FRONT', 'session/pay', 'pay-flow', '+12', '  files alpha  ']) {
      expect(matchesArtifactQuery(diff, q), q).toBe(true);
    }
    expect(matchesArtifactQuery(row({ solution: null, branch: null }), 'root')).toBe(true);
  });

  it('an empty query matches everything; anything else must be a substring', () => {
    expect(matchesArtifactQuery(diff, '')).toBe(true);
    expect(matchesArtifactQuery(diff, '   ')).toBe(true);
    expect(matchesArtifactQuery(diff, null)).toBe(true);
    expect(matchesArtifactQuery(diff, 'mobile')).toBe(false);
    expect(matchesArtifactQuery(row({ sessionName: null, meta: null }), 'null')).toBe(false);
  });
});
