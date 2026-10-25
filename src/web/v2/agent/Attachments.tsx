import { useState } from 'react';
import type { Attachment } from '../../../core/api.ts';
import { formatSize } from '../../../core/attachments.ts';
import { type DraftAttachment, attachmentUrl } from '../../components/attachments.ts';
import { Dialog, Icon, IconButton } from '../components/index.ts';

/**
 * D131 · lane S · attachments in v2 style (the prototype's `.achip`): the draft's
 * chips above the box (an image as a thumbnail, a file as a chip; each removable,
 * its upload state shown) and a sent message's attachments under its pill (an
 * image opens larger; a file downloads, a PDF opens). The uploads and caps are the
 * classic composer's (`components/Attachments.tsx`, D57).
 */
export function DraftChips({ items, notice, onRemove }: { readonly items: readonly DraftAttachment[]; readonly notice: string | null; readonly onRemove: (key: string) => void }) {
  if (items.length === 0 && !notice) return null;
  return (
    <div className="v2-ag-atts" data-testid="v2-agent-draft-attachments" aria-label="Attachments to send">
      {items.map((item) => (
        <span key={item.key} className="v2-ag-achip" data-kind={item.kind} data-state={item.state} data-testid="v2-agent-draft-chip" title={item.error ?? `${item.name} · ${formatSize(item.size)}`}>
          {item.kind === 'image' && item.previewUrl ? (
            <span className="v2-ag-athumb">
              <img src={item.previewUrl} alt={item.name} />
            </span>
          ) : (
            <Icon name="clip" size="s" />
          )}
          <span className="v2-ag-aname">{item.name}</span>
          {item.state === 'uploading' || item.state === 'reading' ? <span className="v2-muted">…</span> : null}
          {item.state === 'error' ? <Icon name="alert" size="s" label={item.error ?? 'Could not attach'} /> : null}
          <IconButton icon="x" label={`Remove ${item.name}`} size="m" onClick={() => onRemove(item.key)} />
        </span>
      ))}
      {notice ? (
        <span className="v2-ag-dock-error" role="alert">
          {notice}
        </span>
      ) : null}
    </div>
  );
}

/** A sent message's attachments (under its pill). */
export function SentAttachments({ sessionId, attachments }: { readonly sessionId: string; readonly attachments: readonly Attachment[] }) {
  const [open, setOpen] = useState<{ readonly src: string; readonly name: string } | null>(null);
  if (attachments.length === 0) return null;
  return (
    <div className="v2-ag-atts v2-ag-atts-sent" data-testid="v2-agent-message-attachments">
      {attachments.map((attachment, index) => {
        const key = attachment.id ?? `placeholder-${index}`;
        if (attachment.kind === 'image' && attachment.id !== null) {
          const src = attachmentUrl(sessionId, attachment.id);
          return (
            <button key={key} type="button" className="v2-ag-achip" data-big="" data-kind="image" data-testid="v2-agent-message-image" title={attachment.name} onClick={() => setOpen({ src, name: attachment.name })}>
              <span className="v2-ag-athumb">
                <img src={src} alt={attachment.name} />
              </span>
              <span className="v2-ag-aname">{attachment.name}</span>
            </button>
          );
        }
        const href = attachment.id !== null ? attachmentUrl(sessionId, attachment.id, attachment.kind !== 'pdf') : undefined;
        return (
          <a key={key} className="v2-ag-achip" data-kind={attachment.kind} data-testid="v2-agent-message-file" href={href} {...(attachment.kind === 'pdf' ? { target: '_blank', rel: 'noopener noreferrer' } : { download: attachment.name })} title={`${attachment.name} · ${formatSize(attachment.size)}`}>
            <Icon name="clip" size="s" />
            <span className="v2-ag-aname">{attachment.name}</span>
            <span className="v2-muted">{formatSize(attachment.size)}</span>
          </a>
        );
      })}
      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? ''} icon="image" width={900} testId="v2-agent-image-view">
        {open ? <img className="v2-ag-lightbox" src={open.src} alt={open.name} /> : null}
      </Dialog>
    </div>
  );
}
