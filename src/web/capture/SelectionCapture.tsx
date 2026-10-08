import { type FormEvent, type KeyboardEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { captureTitle, quoteNote } from '../../core/todo-capture.ts';
import { checkTodoTitle } from '../../core/todos.ts';
import { useToasts } from '../toast/ToastHost.tsx';
import { todoRefusal } from '../views/session/TodoStrip.tsx';
import { captureTodo } from './capture.ts';
import { type Box, floatPlace, selectionIn } from './place.ts';
import './capture.css';

/** Selection changes come in bursts while a drag or a touch handle moves: the action settles after this long. */
const SETTLE_MS = 180;

/** What was selected and where (viewport pixels). */
interface Picked {
  readonly text: string;
  readonly rect: Box;
}

/** Props of {@link SelectionCapture}. */
export interface SelectionCaptureProps {
  /** The conversation's scroller: only a selection inside it offers the action. */
  readonly container: RefObject<HTMLElement | null>;
  readonly sessionId: string;
  /** No action while the session cannot be written to (an unreachable machine). */
  readonly disabled: boolean;
}

function boxOf(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * D81 · select text in the chat → **Add to todo** (`docs/todos.md` → *Quick capture (D81)*):
 * a selection inside the conversation (mouse, keyboard, or a touch long-press) shows a small
 * floating action under it. It opens a popover with a generated short title (the selection's
 * first line, clipped) and the selection quoted as the description, both editable; **Save**
 * captures the item into this session (`from: selection`), saved bare and marked for the agent
 * to fill in. Esc or Cancel closes it; a new selection moves it.
 */
export function SelectionCapture({ container, sessionId, disabled }: SelectionCaptureProps) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState<Picked | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback((): void => {
    const selection = window.getSelection();
    const text = selectionIn(container.current, selection);
    if (text === null || !selection) {
      setPicked(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    // The end of the selection (its last line), where the developer's pointer or handle is.
    const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    const whole = range.getBoundingClientRect();
    const rect = last ? { left: whole.left, top: last.top, width: whole.width, height: last.height } : boxOf(whole);
    setPicked({ text, rect });
  }, [container]);

  useEffect(() => {
    if (disabled) {
      setPicked(null);
      return;
    }
    const onChange = (): void => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(read, SETTLE_MS);
    };
    const onScroll = (): void => setPicked(null);
    document.addEventListener('selectionchange', onChange);
    const scroller = container.current;
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', onChange);
      scroller?.removeEventListener('scroll', onScroll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [container, disabled, read]);

  // Another session's chat: nothing carries over.
  useEffect(() => {
    setPicked(null);
    setEditing(null);
  }, [sessionId]);

  if (editing) return <CapturePopover picked={editing} sessionId={sessionId} onClose={() => setEditing(null)} />;
  if (!picked) return null;
  return <FloatingAction picked={picked} onOpen={() => setEditing(picked)} />;
}

const ACTION_SIZE = { width: 128, height: 32 };

function FloatingAction({ picked, onOpen }: { readonly picked: Picked; readonly onOpen: () => void }) {
  const place = floatPlace(picked.rect, ACTION_SIZE, { width: window.innerWidth, height: window.innerHeight });
  return (
    <button
      type="button"
      className="sb-capture-action"
      data-testid="selection-todo"
      style={{ left: place.left, top: place.top }}
      // Keep the selection: pressing the button must not clear it before the click.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
    >
      <span aria-hidden="true">＋</span> Add to todo
    </button>
  );
}

const POPOVER_SIZE = { width: 360, height: 260 };

function CapturePopover({ picked, sessionId, onClose }: { readonly picked: Picked; readonly sessionId: string; readonly onClose: () => void }) {
  const { show } = useToasts();
  const [title, setTitle] = useState(() => captureTitle(picked.text));
  const [note, setNote] = useState(() => quoteNote(picked.text));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLFormElement>(null);
  const [size, setSize] = useState(POPOVER_SIZE);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const width = Math.min(POPOVER_SIZE.width, viewport.width - 16);
  const place = floatPlace(picked.rect, { width, height: size.height }, viewport);

  useLayoutEffect(() => {
    const el = panel.current;
    if (el && Math.abs(el.offsetHeight - size.height) > 1) setSize({ width, height: el.offsetHeight });
  });

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (panel.current && event.target instanceof Node && !panel.current.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const checked = checkTodoTitle(title.replace(/[\r\n]+/g, ' '));
  const save = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!checked.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      await captureTodo(sessionId, { title: checked.value, note: note.trim() === '' ? null : note, from: 'selection' });
      window.getSelection()?.removeAllRanges();
      show({ id: `todo-capture:${sessionId}`, title: 'Added to todos', sub: '', branch: '', text: checked.value, sessionId: null });
      onClose();
    } catch (refused) {
      setError(todoRefusal(refused));
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form
      ref={panel}
      className="sb-capture-popover"
      data-testid="selection-todo-popover"
      role="dialog"
      aria-label="Add to todo"
      style={{ left: place.left, top: place.top, width }}
      onSubmit={(event) => void save(event)}
      onKeyDown={onKeyDown}
    >
      <div className="sb-capture-head">Add to todo</div>
      <input
        ref={titleRef}
        className="sb-capture-title"
        data-testid="selection-todo-title"
        aria-label="Title"
        value={title}
        maxLength={240}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea className="sb-capture-note" data-testid="selection-todo-note" aria-label="Description" value={note} rows={4} onChange={(event) => setNote(event.target.value)} />
      <div className="sb-capture-hint">The agent fills in the plan, priority and estimate when it is idle.</div>
      {error || !checked.ok ? (
        <div className="sb-capture-error" role="alert" data-testid="selection-todo-error">
          {error ?? (title.trim() === '' ? 'Give it a title.' : (checked as { message: string }).message)}
        </div>
      ) : null}
      <div className="sb-capture-buttons">
        <button type="button" className="sb-button" data-testid="selection-todo-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="sb-button sb-capture-save" data-testid="selection-todo-save" disabled={!checked.ok || saving} aria-busy={saving}>
          Save
        </button>
      </div>
    </form>
  );
}
