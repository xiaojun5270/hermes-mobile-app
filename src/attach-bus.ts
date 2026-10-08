// Bridge between the add-to-chat sheet (its own route — params can't carry
// callbacks) and the chat screen that owns the photo-staging logic. The chat
// screen registers a handler on mount; the sheet fires an action right before
// dismissing itself.

export type AttachAction = 'camera' | 'library' | 'files';

let handler: ((action: AttachAction) => void) | null = null;

/** Chat screen registers here; returns an unsubscribe. Last writer wins —
 * only one chat screen is ever mounted. */
export function setAttachHandler(h: (action: AttachAction) => void): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function requestAttach(action: AttachAction): void {
  handler?.(action);
}
