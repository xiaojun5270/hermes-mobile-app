import {
  MAX_ATTACH_BYTES,
  attachFilename,
  base64ByteLength,
  bubbleImageSize,
  buildAttachParams,
} from '../src/lib/image-attach';

describe('base64ByteLength', () => {
  it('handles unpadded, single- and double-padded strings', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength(Buffer.from('abc').toString('base64'))).toBe(3); // no padding
    expect(base64ByteLength(Buffer.from('ab').toString('base64'))).toBe(2); // one '='
    expect(base64ByteLength(Buffer.from('a').toString('base64'))).toBe(1); // two '='
  });

  it('tolerates embedded whitespace, like the gateway decoder', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    const spaced = b64.slice(0, 4) + '\n ' + b64.slice(4);
    expect(base64ByteLength(spaced)).toBe(11);
  });
});

describe('attachFilename', () => {
  it('prefers the asset fileName when its extension is allowed', () => {
    expect(attachFilename({ fileName: 'IMG_0042.JPG', uri: 'file:///tmp/x.png' })).toBe('IMG_0042.JPG');
  });

  it('falls back to the uri basename', () => {
    expect(attachFilename({ uri: 'file:///var/mobile/tmp/ABC-123.png' })).toBe('ABC-123.png');
  });

  it('strips query strings from uri-derived names', () => {
    expect(attachFilename({ uri: 'https://host/img/pic.webp?w=200' })).toBe('pic.webp');
  });

  it('maps the mime type when names carry no usable extension', () => {
    expect(attachFilename({ uri: 'ph://ASSET-ID', mimeType: 'image/jpeg' })).toBe('photo.jpg');
    expect(attachFilename({ mimeType: 'image/PNG' })).toBe('photo.png');
  });

  it('returns undefined for unsupported extensions so the gateway sniffs magic bytes', () => {
    expect(attachFilename({ fileName: 'live.heic', uri: 'file:///x/live.heic' })).toBeUndefined();
    expect(attachFilename({ uri: 'file:///x/clip.mov', mimeType: 'video/quicktime' })).toBeUndefined();
    expect(attachFilename({})).toBeUndefined();
  });
});

describe('bubbleImageSize', () => {
  it('caps landscape images at the max width', () => {
    expect(bubbleImageSize(4000, 3000)).toEqual({ width: 240, height: 180 });
  });

  it('caps portrait images at the max height', () => {
    expect(bubbleImageSize(3000, 4000)).toEqual({ width: 165, height: 220 });
  });

  it('scales small images up to fill the box', () => {
    expect(bubbleImageSize(40, 30)).toEqual({ width: 240, height: 180 });
  });

  it('falls back to 4:3 when dimensions are missing or degenerate', () => {
    expect(bubbleImageSize()).toEqual({ width: 240, height: 180 });
    expect(bubbleImageSize(0, 100)).toEqual({ width: 240, height: 180 });
  });
});

describe('buildAttachParams', () => {
  const base64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('builds session_id + content_base64 (+ filename when known)', () => {
    expect(buildAttachParams('s1', { uri: 'file:///t/a.png', base64 })).toEqual({
      session_id: 's1',
      content_base64: base64,
      filename: 'a.png',
    });
  });

  it('omits filename when the format is unknown', () => {
    expect(buildAttachParams('s1', { uri: 'ph://ASSET', base64 })).toEqual({
      session_id: 's1',
      content_base64: base64,
    });
  });

  it('rejects empty payloads', () => {
    expect(() => buildAttachParams('s1', { uri: 'file:///t/a.png', base64: '' })).toThrow(/图片为空/);
  });

  it('rejects payloads over the 25 MB decoded cap', () => {
    // 4 base64 chars per 3 bytes: fake the length without allocating 25 MB of real data.
    const tooBig = 'A'.repeat(Math.ceil((MAX_ATTACH_BYTES + 3) / 3) * 4);
    expect(() => buildAttachParams('s1', { uri: 'file:///t/a.png', base64: tooBig })).toThrow(/25 MB/);
  });

  it('accepts a payload exactly at the cap', () => {
    const atCap = 'A'.repeat((MAX_ATTACH_BYTES / 3) * 4); // 25 MB decodes from this length exactly
    expect(buildAttachParams('s1', { uri: 'file:///t/a.png', base64: atCap }).content_base64).toBe(atCap);
  });
});
