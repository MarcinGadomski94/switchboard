import { useEffect, useMemo, useRef, useState } from 'react';
import { REVIEW_ACTION_LABELS, type Review, type ReviewActionId, resolutionLabel, testsLine } from '../../core/reviews.ts';
import { ApiError, api, onDeviceOrigin } from '../api/client.ts';
import { Link } from '../router.tsx';
import {
  type ReviewForm,
  SEND_BACK_HINT,
  cleanupWarning,
  commitHint,
  discardWarning,
  needsForm,
  refusalConflicts,
  repoLine,
  reviewRefusal,
  shownActions,
  statsLine,
} from './review-card.ts';
import { type ReviewDraft, draftField } from '../../core/drafts.ts';
import { initialDraft, useDraft } from '../drafts/useDraft.ts';
import './review-card.css';

/** How many files / commits a card lists before "+ n more". */
const LIST_MAX = 12;

interface ReviewCardProps {
  readonly review: Review;
  /** `inbox`: the Inbox detail (wide); `popover`: under the session header's badge. */
  readonly variant: 'inbox' | 'popover';
  /** After an action: the card as the server answered it. */
  readonly onChanged?: (review: Review) => void;
}

/**
 * D79 "Review queue" (`docs/reviews.md` → *The card*): the session's changes as last
 * read (repo, branch → base, stats, files linking to the Diff tab, unmerged commits),
 * the agent's last message as its summary, the tests line, the last note / conflicts,
 * and the actions offered now (the first primary). Commit, Send back, Discard and
 * Clean up open their form first (a message, a comment, a confirmation); the rest run
 * on click. On a paired device Discard and Clean up are not offered (desktop only).
 */
export function ReviewCard({ review, variant, onChanged }: ReviewCardProps) {
  // D88: the Send-back comment not yet sent is the session's draft (`review:<id>`); with one, its form opens.
  const field = review.actions.includes('send-back') ? draftField.review(review.id) : null;
  const [restored] = useState(() => initialDraft<ReviewDraft>(review.sessionId, field)?.comment ?? '');
  const [form, setForm] = useState<ReviewForm | null>(restored !== '' ? 'send-back' : null);
  const [message, setMessage] = useState(review.commitMessage);
  const [comment, setComment] = useState(restored);
  const [busy, setBusy] = useState<ReviewActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<readonly string[]>(review.conflicts);
  const shownId = useRef(review.id);
  useEffect(() => {
    // Another card in the same place (not the first render: a restored draft stays).
    if (shownId.current === review.id) return;
    shownId.current = review.id;
    setForm(null);
    setComment('');
    setError(null);
  }, [review.id]);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const draftValue = useMemo<ReviewDraft>(() => ({ comment }), [comment]);
  const kept = useDraft<ReviewDraft>({
    sessionId: review.sessionId,
    field,
    value: draftValue,
    root: cardRef,
    initial: restored !== '' ? { comment: restored } : null,
    apply: (value) => {
      setComment(value?.comment ?? '');
      if (value && value.comment.trim() !== '') setForm('send-back');
    },
  });
  useEffect(() => setMessage(review.commitMessage), [review.id, review.commitMessage]);
  useEffect(() => setConflicts(review.conflicts), [review.id, review.conflicts]);

  const actions = shownActions(review.actions, onDeviceOrigin());
  const run = async (action: ReviewActionId, body?: Readonly<Record<string, unknown>>): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      const answer = await api.reviewAction(review.id, action, body);
      // D88: the comment was sent back: its draft goes.
      if (action === 'send-back') kept.clear();
      setForm(null);
      setComment('');
      onChanged?.(answer);
    } catch (caught) {
      const status = caught instanceof ApiError ? caught.status : 0;
      const bodyOf = caught instanceof ApiError ? caught.body : null;
      setError(reviewRefusal(status, bodyOf));
      const listed = refusalConflicts(bodyOf);
      if (listed.length > 0) setConflicts(listed);
    } finally {
      setBusy(null);
    }
  };
  // D88: Cancel drops the comment and its draft.
  const cancelSendBack = (): void => {
    kept.clear();
    setComment('');
    setForm(null);
  };
  const pick = (action: ReviewActionId): void => {
    if (needsForm(action)) {
      setError(null);
      setForm(form === action ? null : action);
      return;
    }
    void run(action);
  };

  const files = review.repos.flatMap((repo) => repo.files.map((file) => ({ ...file, multi: review.repos.length > 1 })));
  const commits = review.repos.flatMap((repo) => repo.commits.map((commit) => ({ ...commit, repo: repo.repo })));
  return (
    <div ref={cardRef} className="sb-review" data-testid="review-card" data-tour="review-card" data-variant={variant} data-review-id={review.id} data-state={review.state} data-mode={review.mode}>
      <div className="sb-review__repos">
        {review.repos.map((repo) => (
          <div key={`${repo.repo}\u0000${repo.dir}`} className="sb-review__repo" data-testid="review-repo">
            <span className="sb-review__repo-name">{repo.repo}</span>
            <span className="sb-review__branch">{repoLine(repo)}</span>
            {repo.prUrl ? (
              <a className="sb-review__pr" href={repo.prUrl} target="_blank" rel="noopener noreferrer" data-testid="review-pr">
                PR ↗
              </a>
            ) : null}
          </div>
        ))}
      </div>
      <div className="sb-review__stats" data-testid="review-stats">
        {statsLine(review)}
        {review.state !== 'pending' && resolutionLabel(review) ? <span className="sb-review__outcome" data-testid="review-resolution"> · {resolutionLabel(review)}</span> : null}
      </div>
      {files.length > 0 ? (
        <ul className="sb-review__files" data-testid="review-files">
          {files.slice(0, LIST_MAX).map((file) => (
            <li key={`${file.repo}\u0000${file.path}`} className="sb-review__file">
              <Link to={{ view: 'session', id: review.sessionId, tab: 'diff' }} className="sb-review__file-link" data-testid="review-file">
                {file.multi ? `${file.repo}/` : ''}
                {file.path}
              </Link>
              <span className="sb-review__file-stat">
                {file.binary ? (
                  'binary'
                ) : (
                  <>
                    <span className="sb-review__add">+{file.added}</span> <span className="sb-review__del">−{file.removed}</span>
                  </>
                )}
              </span>
              {file.uncommitted ? <span className="sb-review__tag">uncommitted</span> : null}
            </li>
          ))}
          {files.length > LIST_MAX ? <li className="sb-review__more">+ {files.length - LIST_MAX} more in the Diff tab</li> : null}
        </ul>
      ) : null}
      {commits.length > 0 ? (
        <div className="sb-review__section">
          <div className="sb-review__label">{review.mode === 'branch' ? 'Commits not merged' : 'Commits of this session'}</div>
          <ul className="sb-review__commits" data-testid="review-commits">
            {commits.slice(0, LIST_MAX).map((commit) => (
              <li key={`${commit.repo}\u0000${commit.sha}`} className="sb-review__commit">
                <span className="sb-review__sha">{commit.sha.slice(0, 7)}</span>
                <span>{commit.subject}</span>
              </li>
            ))}
            {commits.length > LIST_MAX ? <li className="sb-review__more">+ {commits.length - LIST_MAX} more</li> : null}
          </ul>
        </div>
      ) : null}
      <div className="sb-review__section">
        <div className="sb-review__label">Summary</div>
        <div className="sb-review__summary" data-testid="review-summary">
          {review.summary ?? 'The agent left no message.'}
        </div>
      </div>
      <div className="sb-review__tests" data-testid="review-tests" data-status={review.tests.status}>
        {testsLine(review.tests)}
      </div>
      {review.note ? (
        <div className="sb-review__note" data-testid="review-note">
          {review.note}
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="sb-review__conflicts" data-testid="review-conflicts">
          <div className="sb-review__label">Conflicts</div>
          {conflicts.map((file) => (
            <div key={file} className="sb-review__conflict">
              {file}
            </div>
          ))}
        </div>
      ) : null}
      {form === 'commit' ? (
        <div className="sb-review__form" data-testid="review-commit-form">
          <label className="sb-review__label" htmlFor={`review-message-${review.id}`}>
            Commit message
          </label>
          <textarea
            id={`review-message-${review.id}`}
            className="sb-review__input"
            data-testid="review-commit-message"
            rows={5}
            maxLength={4000}
            value={message}
            disabled={busy !== null}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="sb-review__hint">{commitHint(review)}</div>
          <FormButtons confirm="Commit" testId="review-commit-confirm" busy={busy !== null} disabled={message.trim() === ''} onConfirm={() => void run('commit', { message })} onCancel={() => setForm(null)} />
        </div>
      ) : null}
      {form === 'send-back' ? (
        <div className="sb-review__form" data-testid="review-send-back-form">
          <label className="sb-review__label" htmlFor={`review-comment-${review.id}`}>
            Comment for the session
          </label>
          <textarea
            id={`review-comment-${review.id}`}
            className="sb-review__input"
            data-testid="review-comment"
            rows={3}
            maxLength={4000}
            placeholder="What should change?"
            value={comment}
            disabled={busy !== null}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="sb-review__hint">{SEND_BACK_HINT}</div>
          <FormButtons confirm="Send back" testId="review-send-back-confirm" busy={busy !== null} disabled={comment.trim() === ''} onConfirm={() => void run('send-back', { comment })} onCancel={cancelSendBack} />
        </div>
      ) : null}
      {form === 'discard' ? (
        <div className="sb-review__form sb-review__form--danger" role="alertdialog" aria-label="Discard changes" data-testid="review-discard-form">
          <div className="sb-review__warning">{discardWarning(review)}</div>
          <FormButtons confirm="Discard changes" danger testId="review-discard-confirm" busy={busy !== null} onConfirm={() => void run('discard', { confirm: true })} onCancel={() => setForm(null)} />
        </div>
      ) : null}
      {form === 'cleanup' ? (
        <div className="sb-review__form" role="alertdialog" aria-label="Clean up" data-testid="review-cleanup-form">
          <div className="sb-review__warning">{cleanupWarning(review)}</div>
          <FormButtons confirm="Remove worktree and branch" testId="review-cleanup-confirm" busy={busy !== null} onConfirm={() => void run('cleanup', { confirm: true })} onCancel={() => setForm(null)} />
        </div>
      ) : null}
      {actions.length > 0 && form === null ? (
        <div className="sb-review__actions" data-testid="review-actions">
          {actions.map((action, index) => (
            <button
              key={action}
              type="button"
              className="sb-button sb-review__action"
              data-testid="review-action"
              data-action={action}
              data-primary={index === 0 ? 'true' : 'false'}
              data-danger={action === 'discard' ? 'true' : 'false'}
              disabled={busy !== null}
              onClick={() => pick(action)}
            >
              {busy === action ? `${REVIEW_ACTION_LABELS[action]}…` : action === 'dismiss' && review.state === 'cleanup' ? 'Keep worktree' : REVIEW_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="sb-review__error" role="alert" data-testid="review-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function FormButtons({
  confirm,
  testId,
  busy,
  disabled = false,
  danger = false,
  onConfirm,
  onCancel,
}: {
  readonly confirm: string;
  readonly testId: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="sb-review__actions">
      <button type="button" className="sb-button sb-review__action" data-primary="true" data-danger={danger ? 'true' : 'false'} data-testid={testId} disabled={busy || disabled} onClick={onConfirm}>
        {busy ? `${confirm}…` : confirm}
      </button>
      <button type="button" className="sb-button sb-review__action" data-primary="false" data-testid="review-form-cancel" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
