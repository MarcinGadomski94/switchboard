import { useEffect, useMemo, useState } from 'react';
import type { Folder } from '../../../core/api.ts';
import { folderPickerOptions } from '../../../core/plan-run-folder.ts';
import type { Plan } from '../../../core/plans.ts';
import { type JiraPreview, type JiraSyncMode, defaultPlanSidebarFolder, planSidebarFolderProblem } from '../../../core/plans-jira.ts';
import { api } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { useSidebarLayout } from '../../shell/SidebarSessions.tsx';
import { jiraApi } from '../../plans/jira/api.ts';
import { putPlan } from '../../plans/store.ts';
import { Button, Checkbox, Dialog, Field, Select, useToast } from '../components/index.ts';
import { useV2Router } from '../nav.tsx';
import { ImportProgress } from './ImportProgress.tsx';
import { newProgressId } from './import-progress.ts';

/**
 * D131 · lane P · Import from Jira (the Projects list): an epic key or link → the preview of its
 * tickets and their order (nothing is created) → Create project. The project's own agent starts
 * in the folder picked here (D112, "Plan · <title>"); the agent picks each step's code projects
 * (D115). The classic dialog's CLI / model / account pickers are left to their defaults here
 * (`docs/design/v2-decisions.md`, lane P); the sidebar folder (D119) is picked here too since
 * 2026-11-23 (any folder at any level, by its whole path). It is also + New › Project ›
 * Import from Jira (lane X: one v2 import dialog); there `onImported` takes over from the toast and
 * the navigation.
 */
export function JiraImportDialog({ onClose, onImported }: { readonly onClose: () => void; readonly onImported?: (plan: Plan) => void }) {
  const [epic, setEpic] = useState('');
  const [preview, setPreview] = useState<JiraPreview | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [folders, setFolders] = useState<readonly Folder[]>([]);
  const [folder, setFolder] = useState('');
  const [sync, setSync] = useState<JiraSyncMode>('off');
  const [doneOnMerge, setDoneOnMerge] = useState(true);
  // 2026-11-23 (D119 follow-up): the sidebar folder the project's own "Plan · …" folder goes into, any folder at any level
  // (before, v2 left it to the server's default). `undefined` = not picked: the D119 suggestion.
  const { layout } = useSidebarLayout();
  const listed = useSessionListOf();
  const [sidebarPick, setSidebarPick] = useState<string | null | undefined>(undefined);
  const picked = folders.find((entry) => entry.id === folder) ?? null;
  const suggestedSidebar = useMemo(
    () => defaultPlanSidebarFolder({ layout, sessions: listed.data ?? [], machine: null, workingFolder: picked ? { id: picked.id, path: picked.canonicalPath } : null }),
    [layout, listed.data, picked],
  );
  const sidebarFolderId = sidebarPick !== undefined && (sidebarPick === null || planSidebarFolderProblem(layout, sidebarPick) === null) ? sidebarPick : suggestedSidebar;
  const sidebarOptions = useMemo(() => [{ value: '', label: 'Sidebar root' }, ...folderPickerOptions(layout).map((entry) => ({ value: entry.value, label: entry.label, disabled: planSidebarFolderProblem(layout, entry.value) !== null }))], [layout]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressId, setProgressId] = useState<string | null>(null);
  const toast = useToast();
  const { navigate } = useV2Router();
  useEffect(() => {
    let alive = true;
    api
      .savedFolders()
      .then((list) => {
        if (!alive) return;
        const usable = list.filter((entry) => entry.check?.exists !== false);
        setFolders(usable);
        setFolder((current) => current || (usable.find((entry) => entry.isDefault) ?? usable[0])?.id || '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const read = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await jiraApi.previewForFolder(null, epic.trim());
      setPreview(answer);
      setTitle(answer.suggestedTitle);
      setTarget(answer.suggestedTargetBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const create = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    // D185: the server reports this import's steps on the hub for this id; the form shows them.
    const progress = newProgressId();
    setProgressId(progress);
    try {
      const answer = await jiraApi.importIntoFolder(null, { epic: preview.epic.key, title: title.trim(), targetBranch: target.trim(), ...(folder ? { folder } : {}), sidebarFolderId, sync, ...(sync === 'write' ? { doneOnMerge } : {}), progressId: progress });
      putPlan(answer.plan);
      if (onImported) {
        onImported(answer.plan);
        return;
      }
      toast({ text: `Created “${answer.plan.title}” with ${answer.plan.items.length} steps.` });
      onClose();
      navigate({ area: 'project', id: answer.plan.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const after = (key: string): string[] => (preview?.edges ?? []).filter((edge) => edge.to === key).map((edge) => edge.from);
  const why = !preview ? null : target.trim() === '' ? 'Give the branch the steps combine into.' : !folder ? 'Pick a folder for the project’s agent.' : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Import a Jira epic"
      icon="jira"
      width={640}
      testId="v2-jira-import"
      footer={
        <>
          <span className="v2-grow v2-muted v2-p-dialog-why">{busy && progressId ? <ImportProgress progressId={progressId} /> : (why ?? '')}</span>
          <Button onClick={onClose}>Cancel</Button>
          {preview ? (
            <Button variant="primary" disabled={busy || why !== null} onClick={() => void create()} data-testid="v2-jira-import-create">
              {error && progressId ? 'Try again' : `Create project with ${preview.items.length} step${preview.items.length === 1 ? '' : 's'}`}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || epic.trim() === ''} onClick={() => void read()} data-testid="v2-jira-import-preview">
              {busy ? 'Reading…' : 'Preview'}
            </Button>
          )}
        </>
      }
    >
      <Field
        label="Epic key or link"
        value={epic}
        placeholder="PROJ-123"
        autoFocus
        onChange={(event) => {
          setEpic(event.currentTarget.value);
          setPreview(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && epic.trim() !== '' && !preview) void read();
        }}
        data-testid="v2-jira-import-epic"
      />
      <p className="v2-muted v2-p-dialog-p">Each ticket becomes a step with its full description. The project gets its own agent and folder in Agents; that agent picks each step’s code projects.</p>
      {preview ? (
        <>
          <ul className="v2-card v2-p-jira-preview" data-testid="v2-jira-import-items">
            {preview.items.map((item) => (
              <li key={item.key}>
                <b>
                  {item.key} {item.summary}
                </b>
                <span className="v2-muted">
                  {[item.status, item.estimateMinutes ? `${item.estimateMinutes} min` : null, after(item.key).length > 0 ? `after ${after(item.key).join(', ')}` : item.unlinked ? 'no links' : null].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          {preview.cycles.map((cycle) => (
            <p key={cycle.text} className="v2-muted">
              {cycle.text}
            </p>
          ))}
          <Field label="Project name" value={title} onChange={(event) => setTitle(event.currentTarget.value)} data-testid="v2-jira-import-title" />
          <Field label="Branch the steps combine into" value={target} onChange={(event) => setTarget(event.currentTarget.value)} className="v2-mono" data-testid="v2-jira-import-target" />
          <Select label="Folder of the project’s agent" value={folder} onChange={(event) => setFolder(event.currentTarget.value)} options={folders.map((entry) => ({ value: entry.id, label: entry.displayName }))} data-testid="v2-jira-import-folder" />
          <Select
            label="Sidebar folder"
            value={sidebarFolderId ?? ''}
            onChange={(event) => setSidebarPick(event.currentTarget.value === '' ? null : event.currentTarget.value)}
            options={sidebarOptions}
            hint="The project gets its own folder here, with its agent first; the agents of its steps go there too."
            data-testid="v2-jira-import-sidebar"
          />
          <Select
            label="Jira sync"
            value={sync}
            onChange={(event) => setSync(event.currentTarget.value as JiraSyncMode)}
            options={[
              { value: 'off', label: 'Off · Jira is ignored' },
              { value: 'read-only', label: 'Read · read tickets, never change them' },
              { value: 'write', label: 'Update tickets · status and comments' },
            ]}
          />
          {sync === 'write' ? <Checkbox label="Move tickets to Done when their work is combined" checked={doneOnMerge} onChange={(event) => setDoneOnMerge(event.currentTarget.checked)} /> : null}
        </>
      ) : null}
      {error ? (
        <p className="v2-field-error" role="alert" data-testid="v2-jira-import-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
