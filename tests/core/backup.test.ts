import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  backupFileName,
  backupsToPrune,
  compareVersions,
  isBackupFileName,
  mapJsonPaths,
  mapPath,
  mapStoredText,
  parseMapArgument,
  readBackupAuto,
  restoreRefusal,
  safeEntryName,
} from '../../src/core/backup.ts';

/** D168 (`docs/backup.md`): the pure rules of backup and restore. */

describe('mapPath: the old computer’s paths onto this one’s', () => {
  const maps = [
    { from: 'D:\\RiderProjects', to: '/Users/me/code' },
    { from: 'D:\\RiderProjects\\SwapLanguage\\workspace', to: '/Users/me/swl' },
    { from: '/home/old', to: 'C:\\Users\\me' },
  ];

  it('the longest match wins; the rest takes the target’s separator', () => {
    expect(mapPath('D:\\RiderProjects\\SwapLanguage\\workspace\\nugets\\a', maps)).toBe('/Users/me/swl/nugets/a');
    expect(mapPath('D:\\RiderProjects\\Notatio', maps)).toBe('/Users/me/code/Notatio');
    expect(mapPath('/home/old/x/y', maps)).toBe('C:\\Users\\me\\x\\y');
  });

  it('a Windows path matches regardless of case and slash; the exact folder maps too; a prefix of a name does not', () => {
    expect(mapPath('d:/riderprojects/a', maps)).toBe('/Users/me/code/a');
    expect(mapPath('D:\\RiderProjects', maps)).toBe('/Users/me/code');
    expect(mapPath('D:\\RiderProjectsOther\\a', maps)).toBeNull();
    expect(mapPath('/home/older', maps)).toBeNull();
    expect(mapPath('E:\\elsewhere', maps)).toBeNull();
    expect(mapPath('', maps)).toBeNull();
  });

  it('JSON documents: only strings under a mapped folder change; a stored text maps as JSON or as a plain path', () => {
    const out = mapJsonPaths({ dirs: ['D:\\RiderProjects\\a', 'keep'], n: 1, nested: { cwd: '/home/old' } }, maps);
    expect(out.changed).toBe(true);
    expect(out.value).toEqual({ dirs: ['/Users/me/code/a', 'keep'], n: 1, nested: { cwd: 'C:\\Users\\me' } });
    expect(mapStoredText('["D:\\\\RiderProjects\\\\b"]', maps)).toBe('["/Users/me/code/b"]');
    expect(mapStoredText('D:\\RiderProjects\\c', maps)).toBe('/Users/me/code/c');
    expect(mapStoredText('{"a":"nothing"}', maps)).toBeNull();
    expect(mapStoredText('not a path', maps)).toBeNull();
  });

  it('--map old=new keeps a Windows drive in either side', () => {
    expect(parseMapArgument('D:\\code=/Users/me/code')).toEqual({ from: 'D:\\code', to: '/Users/me/code' });
    expect(parseMapArgument('/a=C:\\b')).toEqual({ from: '/a', to: 'C:\\b' });
    expect(parseMapArgument('nothing')).toBeNull();
    expect(parseMapArgument('=x')).toBeNull();
  });
});

describe('which backup this Switchboard restores', () => {
  it('the same or an older version restores; a newer one or another format is refused', () => {
    expect(compareVersions('2.4.40', '2.4.43')).toBe(-1);
    expect(compareVersions('2.5.0', '2.4.43')).toBe(1);
    expect(restoreRefusal({ format: BACKUP_FORMAT, switchboardVersion: '2.4.40' }, '2.4.43')).toBeNull();
    expect(restoreRefusal({ format: BACKUP_FORMAT, switchboardVersion: '2.4.43' }, '2.4.43')).toBeNull();
    expect(restoreRefusal({ format: BACKUP_FORMAT, switchboardVersion: '2.5.0' }, '2.4.43')).toMatch(/newer than this one/);
    expect(restoreRefusal({ format: 99, switchboardVersion: '2.4.40' }, '2.4.43')).toMatch(/format 99/);
  });

  it('entry names: relative, known roots, no escape', () => {
    expect(safeEntryName('db/switchboard.db')).toBe('db/switchboard.db');
    expect(safeEntryName('data/profiles/claude/x/projects/s/a.jsonl')).toBe('data/profiles/claude/x/projects/s/a.jsonl');
    expect(safeEntryName('secrets.json')).toBe('secrets.json');
    for (const bad of ['../x', 'data/../../x', '/etc/passwd', 'C:/x', 'data\\x', 'other/x', 'data', 'data//x', 'secrets.json/x', '']) expect(safeEntryName(bad), bad).toBeNull();
  });
});

describe('automatic backups', () => {
  it('names sort by time; only the automatic ones count, the newest N are kept', () => {
    const name = backupFileName(new Date(2026, 10, 17, 9, 30, 5), 'auto');
    expect(name).toBe('switchboard-backup-2026-11-17-093005-auto.sbbackup');
    expect(isBackupFileName(name)).toBe(true);
    const names = ['switchboard-backup-2026-11-10-010000-auto.sbbackup', 'switchboard-backup-2026-11-11-010000-auto.sbbackup', 'switchboard-backup-2026-11-12-010000-auto.sbbackup', 'switchboard-backup-2026-11-12-020000.sbbackup', 'notes.txt'];
    expect(backupsToPrune(names, 2)).toEqual(['switchboard-backup-2026-11-10-010000-auto.sbbackup']);
    expect(backupsToPrune(names, 5)).toEqual([]);
  });

  it('settings read defensively', () => {
    expect(readBackupAuto(undefined)).toEqual({ enabled: false, folder: null, keep: 7 });
    expect(readBackupAuto({ enabled: true, folder: '/b', keep: 3 })).toEqual({ enabled: true, folder: '/b', keep: 3 });
    expect(readBackupAuto({ enabled: 'yes', keep: 0 })).toEqual({ enabled: false, folder: null, keep: 7 });
  });
});
