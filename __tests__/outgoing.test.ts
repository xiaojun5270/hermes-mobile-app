import { RpcError, DeliveryUnknownError } from '../src/api/gatewayClient';
import {
  buildFileParams, MAX_FILE_BYTES, makeFile, Outgoing, type Draft, type LiveSnapshot,
} from '../src/lib/outgoing';

const pdf = () => makeFile({ uri: 'file:///phone/a', name: '中文 报告.pdf', size: 3, mimeType: 'application/pdf' }, 'f1');
const draft = (text = '', files = [pdf()]): Draft => ({ text, files, image: null });
const snapshot = (running: boolean, queued?: string): LiveSnapshot => ({
  running, ...(queued ? { queued: { user: queued } } : {}),
});

function setup() {
  const call = jest.fn(async (method: string, _params: any): Promise<any> => {
    if (method === 'file.attach') return { attached: true, path: '/host/a', ref_path: 'attachments/中文 报告.pdf', ref_text: '@file:"attachments/中文 报告.pdf"' };
    if (method === 'image.attach_bytes') return { attached: true, path: '/host/photo.jpg' };
    return { status: 'streaming' };
  });
  const read = jest.fn(async () => 'YWJj');
  const outgoing = new Outgoing(read);
  return { outgoing, call, read };
}

describe('files and reliable delivery', () => {
  it('sends a file-only prompt with the exact returned ref and original name, never a local URI', async () => {
    const { outgoing, call } = setup();
    const result = await outgoing.submit(draft(), 's1', call);
    expect(result.status).toBe('streaming');
    expect(call.mock.calls).toEqual([
      ['file.attach', { session_id: 's1', name: '中文 报告.pdf', data_url: 'data:application/pdf;base64,YWJj' }],
      ['prompt.submit', { session_id: 's1', text: '@file:"attachments/中文 报告.pdf"', queued: true }],
    ]);
  });
  it('keeps multiple references in selection order', async () => {
    const { outgoing, call } = setup();
    call.mockImplementation(async (method: string, params?: any) => method === 'file.attach'
      ? { attached: true, ref_text: `@file:"${params.name}"` } : { status: 'streaming' });
    const d = draft('Read', [pdf(), makeFile({ uri: 'file:///b', name: '预算 表.xlsx' }, 'f2')]);
    await outgoing.submit(d, 's', call);
    expect(call.mock.calls[2][1]).toMatchObject({ text: 'Read\n\n@file:"中文 报告.pdf"\n@file:"预算 表.xlsx"' });
  });
  it('enforces the mobile size cap before reading and after decoding', async () => {
    expect(() => makeFile({ uri: 'file:///x', name: 'x', size: MAX_FILE_BYTES + 1 }, 'x')).toThrow(/10 MB/);
    expect(() => buildFileParams('s', pdf(), 'A'.repeat(Math.ceil((MAX_FILE_BYTES + 3) / 3) * 4))).toThrow(/10 MB/);
  });
  it('retries failed uploads but reuses successful uploads after submit rejection', async () => {
    const { outgoing, call, read } = setup();
    const d = draft();
    call.mockRejectedValueOnce(new RpcError('disk full', 5028));
    await expect(outgoing.submit(d, 's', call)).rejects.toThrow('disk full');
    expect(d.files[0].status).toBe('error');
    call.mockImplementation(async (method: string) => {
      if (method === 'file.attach') return { attached: true, ref_text: '@file:x' };
      throw new RpcError('busy', 4009);
    });
    await expect(outgoing.submit(d, 's', call)).rejects.toThrow('busy');
    call.mockResolvedValue({ status: 'streaming' });
    await outgoing.submit(d, 's', call);
    expect(call.mock.calls.filter(([m]) => m === 'file.attach')).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not automatically resend after an ambiguous transport failure', async () => {
    const { outgoing, call } = setup();
    call.mockRejectedValueOnce(new DeliveryUnknownError('closed'));
    const d = draft();
    await expect(outgoing.submit(d, 's', call)).rejects.toThrow();
    await expect(outgoing.submit(d, 's', call)).rejects.toThrow(/未确认/);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('detaches a staged photo on definite submit failure and reuploads only on retry', async () => {
    const { outgoing, call } = setup();
    const d = draft('photo', []);
    d.image = { uri: 'file:///photo.jpg', base64: 'YWJj' };
    call.mockImplementation(async (method: string) => {
      if (method === 'image.attach_bytes') return { attached: true, path: '/host/photo.jpg' };
      if (method === 'image.detach') return { detached: true };
      throw new RpcError('rejected', 4009);
    });
    await expect(outgoing.submit(d, 's', call)).rejects.toThrow();
    call.mockImplementation(async (method: string) => method === 'image.attach_bytes'
      ? { attached: true, path: '/host/photo.jpg' } : { status: 'streaming' });
    await outgoing.submit(d, 's', call);
    expect(call.mock.calls.filter(([m]) => m === 'image.attach_bytes')).toHaveLength(2);
    expect(call.mock.calls[2]).toEqual(['image.detach', { session_id: 's', path: '/host/photo.jpg' }]);
    expect(d.text).toBe('photo');
    expect(d.image).not.toBeNull();
  });
});

describe('FIFO and steering', () => {
  it.each([undefined, null, false])('drains an ACKed head on status idle with running=%s and retained inflight', async (running) => {
    const { outgoing, call } = setup();
    outgoing.enqueue(draft('first', []));
    const photo = draft('photo', []);
    photo.image = { uri: 'file:///photo.jpg', base64: 'YWJj' };
    outgoing.enqueue(photo);
    call.mockResolvedValueOnce({ status: 'queued' });
    await outgoing.flush({ running: true }, 's', call);
    await outgoing.flush({ running, status: 'idle', inflight: { user: 'older', streaming: true } }, 's', call);
    expect(call.mock.calls.map(([method]) => method)).toEqual(['prompt.submit', 'image.attach_bytes', 'prompt.submit']);
    expect(outgoing.queue[0].draft.text).toBe('photo');
    expect(outgoing.queue[0].state).toBe('accepted');
    await outgoing.flush({ running: false, status: 'idle' }, 's', call);
    expect(outgoing.queue).toHaveLength(0);
  });
  it('an unknown snapshot is not permission to hand off even a pending text', async () => {
    const { outgoing, call } = setup();
    outgoing.enqueue(draft('pending', []));
    await outgoing.flush({}, 's', call);
    expect(call).not.toHaveBeenCalled();
  });
  it('keeps attachments bound to entries; cancel and restore preserve selection', () => {
    const { outgoing } = setup();
    const a = outgoing.enqueue(draft('a'));
    outgoing.enqueue(draft('b', []));
    expect(outgoing.queue.map((e) => e.draft.text)).toEqual(['a', 'b']);
    expect(outgoing.take(a.id)?.files[0].name).toBe('中文 报告.pdf');
    expect(outgoing.queue.map((e) => e.draft.text)).toEqual(['b']);
  });
  it('hands only the head to the real queue and never dispatches on segment completion', async () => {
    const { outgoing, call } = setup();
    const a = outgoing.enqueue(draft('a', []));
    outgoing.enqueue(draft('b', []));
    call.mockResolvedValue({ status: 'queued' });
    await outgoing.flush(snapshot(true), 's', call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outgoing.take(a.id)).toBeNull();
    await outgoing.flush(snapshot(true, 'a'), 's', call);
    expect(call).toHaveBeenCalledTimes(1);
    await outgoing.flush({ running: true, inflight: { user: 'a', streaming: true } }, 's', call);
    expect(outgoing.queue.map((e) => e.draft.text)).toEqual(['a', 'b']);
    expect(call).toHaveBeenCalledTimes(1);
    await outgoing.flush({ running: true, inflight: { user: 'a', streaming: true } }, 's', call);
    expect(call).toHaveBeenCalledTimes(1);
    await outgoing.flush(snapshot(false), 's', call);
    expect(call.mock.calls[1][1]).toMatchObject({ text: 'b', queued: true });
  });
  it('keeps queued photos local until idle and binds file refs to only their own entry', async () => {
    const { outgoing, call } = setup();
    const a = draft('photo', []);
    a.image = { uri: 'file:///photo.jpg', base64: 'YWJj' };
    outgoing.enqueue(a);
    const fileEntry = outgoing.enqueue(draft('file'));
    await outgoing.flush(snapshot(true), 's', call);
    expect(call).not.toHaveBeenCalled();
    await outgoing.flush(snapshot(false), 's', call);
    expect(call.mock.calls[0][0]).toBe('image.attach_bytes');
    expect(call.mock.calls[1][1]).toMatchObject({ text: 'photo', queued: true });
    expect(fileEntry.draft.files[0].upload).toBeUndefined();
    expect(outgoing.queue[0].draft).toBe(a);
    expect(outgoing.queue[1]).toBe(fileEntry);
  });
  it('preserves an unknown submit despite same-text reconnect snapshots without a duplicate submit', async () => {
    const { outgoing, call } = setup();
    outgoing.enqueue(draft('a', []));
    call.mockRejectedValueOnce(new DeliveryUnknownError('closed'));
    await outgoing.flush(snapshot(true), 's', call);
    expect(outgoing.queue[0].state).toBe('unknown');
    await outgoing.flush(snapshot(true, 'a'), 's', call);
    expect(outgoing.queue[0].state).toBe('unknown');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not treat an old same-text history row as proof of a new unknown submit', async () => {
    const { outgoing, call } = setup();
    outgoing.enqueue(draft('repeat', []));
    call.mockRejectedValueOnce(new DeliveryUnknownError('closed before delivery'));
    await outgoing.flush(snapshot(true), 's', call);
    const historical: LiveSnapshot & { messages: { role: string; text: string }[] } = { running: false, messages: [{ role: 'user', text: 'repeat' }] };
    await outgoing.flush(historical, 's', call);
    expect(outgoing.queue[0]?.state).toBe('unknown');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('allows explicit cancellation of a file-upload unknown before submit and then advances its tail', async () => {
    const { outgoing, call } = setup();
    const a = outgoing.enqueue(draft('file'));
    outgoing.enqueue(draft('tail', []));
    call.mockRejectedValueOnce(new DeliveryUnknownError('file ACK lost'));
    await outgoing.flush(snapshot(true), 's', call);
    expect(outgoing.queue[0].state).toBe('upload_unknown');
    expect(outgoing.take(a.id)?.files[0].status).toBe('unknown');
    call.mockResolvedValue({ status: 'streaming' });
    await outgoing.flush(snapshot(false), 's', call);
    expect(call.mock.calls[1]).toEqual(['prompt.submit', { session_id: 's', text: 'tail', queued: true }]);
  });
  it('reports steering acceptance only as pending, keeps rejection distinct, never redirects', async () => {
    const { outgoing, call } = setup();
    call.mockResolvedValue({ status: 'queued' });
    expect(await outgoing.steer('Use Chinese', 's', call)).toBe('pending');
    call.mockResolvedValue({ status: 'rejected' });
    expect(await outgoing.steer('x', 's', call)).toBe('rejected');
    expect(call.mock.calls.map(([m]) => m)).toEqual(['session.steer', 'session.steer']);
  });
});
