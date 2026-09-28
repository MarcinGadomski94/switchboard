import { type FormEvent, useRef, useState } from 'react';
import type { Tool } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useRouter } from '../../router.tsx';
import { announceToolsChanged } from '../../tools/events.ts';
import { TOOL_DOT, probeTool, useToolState } from '../../tools/probe.ts';
import { TOOL_CARD_STATE } from './model.ts';
import { SectionTitle } from './rows.tsx';

/** A tool as `PUT /api/tools` takes it (a new one has no id yet; the service makes one; `frameUrl` is the service's, D15). */
type ToolDraft = Omit<Tool, 'id' | 'frameUrl'> & { readonly id?: string };

/** Field errors of a refused `PUT /api/tools` (`422 {error:"invalid", errors:[{field, message}]}`). */
function fieldErrors(error: unknown): Array<{ field: string; message: string }> {
  if (error instanceof ApiError && error.status === 422) {
    const errors = (error.body as { errors?: unknown } | null)?.errors;
    if (Array.isArray(errors)) return errors as Array<{ field: string; message: string }>;
  }
  return [{ field: '', message: error instanceof Error ? error.message : 'could not save' }];
}

/** `record` without `key`. */
function omit(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Sentence case for the service's messages ("the URL must be …" → "The URL must be …"). */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Embedded tools (M8.1 data, M8.2 editor; gaps #13, #14): one card per tool with
 * its reachability, the URL field, Test and Open, as in the prototype, plus Remove
 * on each card and an "Add a tool" card (name + URL). Every change is saved by
 * Switchboard through `PUT /api/tools` (the whole list), and the sidebar's TOOLS
 * rows reload. A URL is saved when the field loses focus or on Enter, and before
 * Test / Open.
 */
export function ToolsSection() {
  const loaded = useApi(api.tools);
  const [saved, setSaved] = useState<readonly Tool[] | null>(null);
  const tools = saved ?? loaded.data;
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [add, setAdd] = useState({ name: '', url: '' });
  const [addError, setAddError] = useState<string | null>(null);
  const { navigate } = useRouter();

  const put = async (list: readonly ToolDraft[]): Promise<Tool[]> => {
    const result = await api.saveTools(list as readonly Tool[]);
    setSaved(result);
    announceToolsChanged();
    return result;
  };

  // A blur followed by a click on Test / Open commits once: the second call joins the first.
  const inFlight = useRef(new Map<string, Promise<Tool | null>>());

  /** Saves the tool's URL draft, if any; the saved tool, or `null` when the service refused it. */
  const commitUrl = (tool: Tool): Promise<Tool | null> => {
    const running = inFlight.current.get(tool.id);
    if (running) return running;
    const draft = drafts[tool.id];
    if (draft === undefined || draft.trim() === (tool.url ?? '')) {
      setDrafts((current) => omit(current, tool.id));
      return Promise.resolve(tool);
    }
    const list = (tools ?? []).map((t) => (t.id === tool.id ? { ...t, url: draft.trim() === '' ? null : draft.trim() } : t));
    const job = put(list).then(
      (result) => {
        setDrafts((current) => omit(current, tool.id));
        setErrors((current) => omit(current, tool.id));
        const updated = result.find((t) => t.id === tool.id) ?? null;
        // A cleared URL reads "not set" at once (prototype `setUrl`); no request is made.
        if (updated && !updated.url) void probeTool(updated);
        return updated;
      },
      (error: unknown) => {
        setErrors((current) => ({ ...current, [tool.id]: sentence(fieldErrors(error)[0]?.message ?? 'could not save') }));
        return null;
      },
    );
    inFlight.current.set(tool.id, job);
    void job.finally(() => inFlight.current.delete(tool.id));
    return job;
  };

  const test = async (tool: Tool): Promise<void> => {
    const current = await commitUrl(tool);
    if (current) void probeTool(current);
  };

  const open = async (tool: Tool): Promise<void> => {
    const current = await commitUrl(tool);
    if (current) navigate({ view: 'tool', id: current.id });
  };

  const remove = async (tool: Tool): Promise<void> => {
    if (!window.confirm(`Remove ${tool.name} from Switchboard? Only the entry is removed; the tool itself keeps running.`)) return;
    try {
      await put((tools ?? []).filter((t) => t.id !== tool.id));
    } catch (error) {
      setErrors((current) => ({ ...current, [tool.id]: sentence(fieldErrors(error)[0]?.message ?? 'could not save') }));
    }
  };

  const submitAdd = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = add.name.trim();
    if (!name) {
      setAddError('Give the tool a name.');
      return;
    }
    const list: ToolDraft[] = [...(tools ?? []), { name, url: add.url.trim() || null, description: null, showInSidebar: true }];
    try {
      await put(list);
      setAdd({ name: '', url: '' });
      setAddError(null);
    } catch (error) {
      setAddError(sentence(fieldErrors(error)[0]?.message ?? 'could not save'));
    }
  };

  return (
    <>
      <SectionTitle withLede>Embedded tools</SectionTitle>
      <div className="sb-set-lede">Local web apps shown under Tools in the sidebar and opened in the main area. URLs are saved in Switchboard.</div>
      <div className="sb-set-tools" data-testid="settings-tools">
        {(tools ?? []).map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            draft={drafts[tool.id]}
            error={errors[tool.id] ?? null}
            onDraft={(value) => setDrafts((current) => ({ ...current, [tool.id]: value }))}
            onCommit={() => void commitUrl(tool)}
            onTest={() => void test(tool)}
            onOpen={() => void open(tool)}
            onRemove={() => void remove(tool)}
          />
        ))}
        {tools ? (
          <form className="sb-set-tool" data-kind="add" data-testid="settings-add-tool" onSubmit={(event) => void submitAdd(event)}>
            <div className="sb-set-tool-add-title">Add a tool</div>
            <div className="sb-set-tool-row">
              <input
                className="sb-set-input"
                data-kind="name"
                aria-label="Tool name"
                placeholder="Name"
                value={add.name}
                onChange={(event) => setAdd((current) => ({ ...current, name: event.target.value }))}
              />
              <input
                className="sb-set-input"
                aria-label="Tool URL"
                placeholder="http://localhost:PORT"
                value={add.url}
                onChange={(event) => setAdd((current) => ({ ...current, url: event.target.value }))}
              />
              <button type="submit" className="sb-set-tool-test" data-testid="settings-add-tool-submit">
                Add
              </button>
            </div>
            {addError ? (
              <div className="sb-set-tool-error" role="alert">
                {addError}
              </div>
            ) : null}
          </form>
        ) : null}
      </div>
      {!tools && loaded.error ? (
        <div className="sb-set-note" data-testid="settings-note">
          The tools could not be loaded.
        </div>
      ) : null}
    </>
  );
}

function ToolCard({
  tool,
  draft,
  error,
  onDraft,
  onCommit,
  onTest,
  onOpen,
  onRemove,
}: {
  readonly tool: Tool;
  readonly draft: string | undefined;
  readonly error: string | null;
  readonly onDraft: (value: string) => void;
  readonly onCommit: () => void;
  readonly onTest: () => void;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
}) {
  const state = useToolState(tool);
  return (
    <div className="sb-set-tool" data-tool={tool.id} data-tool-state={state}>
      <div className="sb-set-tool-head">
        <span className="sb-set-tool-dot" style={{ background: TOOL_DOT[state] }} />
        <span className="sb-set-tool-name">{tool.name}</span>
        <span className="sb-set-tool-desc">{tool.description ?? ''}</span>
        <span className="sb-set-tool-state" data-testid="settings-tool-state">
          {TOOL_CARD_STATE[state]}
        </span>
        <button type="button" className="sb-set-tool-remove" data-testid="settings-tool-remove" aria-label={`Remove ${tool.name}`} onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="sb-set-tool-row">
        <input
          className="sb-set-input"
          data-testid="settings-tool-url"
          aria-label={`${tool.name} URL`}
          aria-invalid={error ? true : undefined}
          placeholder="http://localhost:PORT"
          value={draft ?? tool.url ?? ''}
          onChange={(event) => onDraft(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommit();
          }}
        />
        <button type="button" className="sb-set-tool-test" data-testid="settings-tool-test" onClick={onTest}>
          Test
        </button>
        <button type="button" className="sb-set-tool-open" data-testid="settings-tool-open" onClick={onOpen}>
          Open
        </button>
      </div>
      {error ? (
        <div className="sb-set-tool-error" role="alert" data-testid="settings-tool-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
