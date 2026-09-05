import { describe, expect, it } from 'vitest';
import { formatAttachmentRef, parseAttachmentRef } from '../attachment-ref.js';

const REF = 'attachment:PLA-135:wia_ab12cd34ef56:image/png';

describe('parseAttachmentRef', () => {
  it('parses a well-formed ref into its three parts', () => {
    expect(parseAttachmentRef(REF)).toEqual({
      workItemId: 'PLA-135',
      attachmentId: 'wia_ab12cd34ef56',
      mime: 'image/png',
    });
  });

  it('accepts the mime shapes the attachment store actually produces', () => {
    for (const mime of ['image/jpeg', 'image/svg+xml', 'application/pdf', 'text/plain', 'application/vnd.ms-excel']) {
      expect(parseAttachmentRef(`attachment:PLA-1:wia_000000000000:${mime}`)?.mime).toBe(mime);
    }
  });

  const rejected: Array<[string, string]> = [
    ['empty string', ''],
    ['a bare filename', 'screenshot.png'],
    ['the wrong scheme', 'file:PLA-135:wia_ab12cd34ef56:image/png'],
    ['a leading space', ' attachment:PLA-135:wia_ab12cd34ef56:image/png'],
    ['a trailing space', 'attachment:PLA-135:wia_ab12cd34ef56:image/png '],
    ['inner whitespace', 'attachment:PLA-135:wia_ab12cd34ef56:image/png extra'],
    ['a tab', 'attachment:PLA-135:wia_ab12cd34ef56:image/p\tng'],
    ['a newline', 'attachment:PLA-135:wia_ab12cd34ef56:image/png\n'],
    ['a parent-directory hop', 'attachment:PLA-135:wia_ab12cd34ef56:../../etc/passwd'],
    ['a parent-directory hop in the id', 'attachment:PLA-135:wia_../../../etc:image/png'],
    ['an absolute path', 'attachment:PLA-135:wia_ab12cd34ef56:/etc/passwd'],
    ['an absolute path as the whole value', '/etc/passwd'],
    ['a slash outside the mime', 'attachment:PLA/135:wia_ab12cd34ef56:image/png'],
    ['a second slash inside the mime', 'attachment:PLA-135:wia_ab12cd34ef56:image/png/x'],
    ['a mime with no slash', 'attachment:PLA-135:wia_ab12cd34ef56:image'],
    ['a missing mime', 'attachment:PLA-135:wia_ab12cd34ef56'],
    ['a trailing separator', 'attachment:PLA-135:wia_ab12cd34ef56:'],
    ['an extra segment', 'attachment:PLA-135:wia_ab12cd34ef56:image/png:more'],
    ['a lowercase Todo prefix', 'attachment:pla-135:wia_ab12cd34ef56:image/png'],
    ['a Todo number with a leading zero', 'attachment:PLA-0135:wia_ab12cd34ef56:image/png'],
    ['a Todo number of zero', 'attachment:PLA-0:wia_ab12cd34ef56:image/png'],
    ['the wrong attachment prefix', 'attachment:PLA-135:wic_ab12cd34ef56:image/png'],
    ['an attachment id that is too short', 'attachment:PLA-135:wia_ab12cd34ef5:image/png'],
    ['an attachment id that is too long', 'attachment:PLA-135:wia_ab12cd34ef567:image/png'],
    ['an uppercase attachment id', 'attachment:PLA-135:wia_AB12CD34EF56:image/png'],
    ['an uppercase mime', 'attachment:PLA-135:wia_ab12cd34ef56:Image/PNG'],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseAttachmentRef(value)).toBeNull();
    });
  }

  it('rejects a value that is not a string', () => {
    expect(parseAttachmentRef(null)).toBeNull();
    expect(parseAttachmentRef(undefined)).toBeNull();
  });
});

describe('formatAttachmentRef', () => {
  it('round-trips through the parser', () => {
    const ref = formatAttachmentRef({ workItemId: 'PLA-135', id: 'wia_ab12cd34ef56', mime: 'image/png' });
    expect(ref).toBe(REF);
    expect(parseAttachmentRef(ref)).toEqual({
      workItemId: 'PLA-135',
      attachmentId: 'wia_ab12cd34ef56',
      mime: 'image/png',
    });
  });

  it('lower-cases the mime so the token it produces always parses', () => {
    const ref = formatAttachmentRef({ workItemId: 'PLA-135', id: 'wia_ab12cd34ef56', mime: 'IMAGE/PNG' });
    expect(parseAttachmentRef(ref)?.mime).toBe('image/png');
  });

  it('falls back to a generic mime rather than emitting a token that would not parse', () => {
    for (const mime of ['image/png; charset=utf-8', 'image', '../../etc/passwd', 'image/p..ng']) {
      const ref = formatAttachmentRef({ workItemId: 'PLA-135', id: 'wia_ab12cd34ef56', mime });
      expect(parseAttachmentRef(ref)?.mime).toBe('application/octet-stream');
    }
  });

  it('falls back to a generic mime when the stored row has none', () => {
    const ref = formatAttachmentRef({ workItemId: 'PLA-135', id: 'wia_ab12cd34ef56', mime: '' });
    expect(parseAttachmentRef(ref)?.mime).toBe('application/octet-stream');
  });
});
