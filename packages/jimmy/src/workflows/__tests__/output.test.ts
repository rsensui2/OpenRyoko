import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { WorkflowOutputSchema } from '../model.js';
import { parseWorkflowOutput, validateSubmittedFields, WorkflowOutputError } from '../output.js';

const LIMIT = 262_144;

function outputSchema(
  fields: WorkflowOutputSchema['fields'] = {},
  allowAdditionalFields = false,
): WorkflowOutputSchema {
  return { fields, allowAdditionalFields };
}

function block(json: string, eol = '\n', closingEol = ''): string {
  return `\`\`\`jinn-output${eol}${json}${eol}\`\`\`${closingEol}`;
}

function rawObjectAtBytes(bytes: number, unit = 'x'): string {
  const prefix = '{"value":"';
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix + suffix + '\n', 'utf8');
  const unitBytes = Buffer.byteLength(unit, 'utf8');
  const remaining = bytes - fixedBytes;
  if (remaining < 0) throw new Error('byte fixture is too small');
  const raw = `${prefix}${unit.repeat(Math.floor(remaining / unitBytes))}${'x'.repeat(remaining % unitBytes)}${suffix}\n`;
  expect(Buffer.byteLength(raw, 'utf8')).toBe(bytes);
  return raw;
}

function rawBlock(raw: string): string {
  return `\`\`\`jinn-output\n${raw}\`\`\``;
}

function expectCode(run: () => unknown, code: WorkflowOutputError['code']): WorkflowOutputError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkflowOutputError);
  expect(thrown).toMatchObject({ name: 'WorkflowOutputError', code });
  return thrown as WorkflowOutputError;
}

describe('prose and fenced-block extraction', () => {
  it('returns prose unchanged with no schema or an optional-only schema', () => {
    expect(parseWorkflowOutput('Plain response.')).toEqual({ text: 'Plain response.', fields: {} });
    expect(parseWorkflowOutput('Plain response.', outputSchema({ note: { type: 'string', required: false } })))
      .toEqual({ text: 'Plain response.', fields: {} });
  });

  it('reports a missing required field when no block is present', () => {
    const error = expectCode(
      () => parseWorkflowOutput('Plain response.', outputSchema({ result: { type: 'string', required: true } })),
      'missing-field',
    );
    expect(error.message).toBe('Required output field "result" is missing.');
  });

  it.each(['\n', '\r\n'])('extracts start, middle, end, and block-only responses with %j', (eol) => {
    const json = '{"result":"ok"}';
    const expectedFields = { result: 'ok' };
    expect(parseWorkflowOutput(`${block(json, eol, eol)}after`)).toEqual({ text: 'after', fields: expectedFields });
    expect(parseWorkflowOutput(`before${eol}${block(json, eol, eol)}after`)).toEqual({
      text: `before${eol}after`,
      fields: expectedFields,
    });
    expect(parseWorkflowOutput(`before${eol}${block(json, eol)}`)).toEqual({ text: `before${eol}`, fields: expectedFields });
    expect(parseWorkflowOutput(block(json, eol))).toEqual({ text: '', fields: expectedFields });
  });

  it('preserves all unrelated prose, Unicode, whitespace, and other fences byte-for-byte', () => {
    const prefix = 'α  \n```json\n{"kept":true}\n```\n\n';
    const suffix = '  ω\t';
    const input = `${prefix}${block('{"result":"✓"}', '\n', '\n')}${suffix}`;
    expect(parseWorkflowOutput(input)).toEqual({ text: prefix + suffix, fields: { result: '✓' } });
  });

  it.each([
    'inline ```jinn-output\n{"x":1}\n``` text',
    '```json\n{"x":1}\n```',
    '```JINN-OUTPUT\n{"x":1}\n```',
    '``` jinn-output\n{"x":1}\n```',
    '````jinn-output\n{"x":1}\n````',
    '```jinn-output suffix\n{"x":1}\n```',
    ' ```jinn-output\n{"x":1}\n```',
    '\t```jinn-output\n{"x":1}\n```',
    '```jinn_output\n{"x":1}\n```',
    'ordinary `backticks` and ``` markers',
  ])('leaves nonmatching fence syntax as prose: %j', (text) => {
    expect(parseWorkflowOutput(text)).toEqual({ text, fields: {} });
  });

  it('accepts only horizontal whitespace after exact opener and closer markers', () => {
    const input = 'before\n```jinn-output \t\n{"x":1}\n```\t \nafter';
    expect(parseWorkflowOutput(input)).toEqual({ text: 'before\nafter', fields: { x: 1 } });
  });
});

describe('syntax and JSON failure priority', () => {
  it.each([
    `${block('{bad')}\n${block('{"ok":true}')}`,
    '```jinn-output\n{"first":true}\n```jinn-output\n{"second":true}\n```',
    '```jinn-output\n{}\n```\n```jinn-output\n{}\n```\n```jinn-output',
  ])('reports multiple recognized openers before inspecting payloads', (text) => {
    expectCode(() => parseWorkflowOutput(text), 'multiple-blocks');
  });

  it.each([
    '```jinn-output',
    '```jinn-output\n{"x":1}',
    '```jinn-output\r\n{"x":1}\r\n````',
    '```jinn-output\n{"x":1}\n ```',
  ])('reports an opener without a valid later closing line as invalid shape', (text) => {
    expectCode(() => parseWorkflowOutput(text), 'invalid-shape');
  });

  it.each(['{', '{"x":1,}', '// comment\n{"x":1}', 'undefined'])('rejects malformed JSON without repair: %j', (json) => {
    expectCode(() => parseWorkflowOutput(block(json)), 'invalid-json');
  });

  it.each(['null', '[]', '[1]', 'true', 'false', '1', '"value"'])('rejects non-object JSON: %s', (json) => {
    expectCode(() => parseWorkflowOutput(block(json)), 'invalid-shape');
  });

  it('uses native JSON duplicate-key last-value semantics', () => {
    expect(parseWorkflowOutput(block('{"result":"first","result":"last"}')))
      .toEqual({ text: '', fields: { result: 'last' } });
  });
});

describe('raw payload byte limit', () => {
  it.each([262_143, LIMIT])('accepts a valid object at exactly %i raw UTF-8 bytes', (bytes) => {
    const raw = rawObjectAtBytes(bytes);
    expect(parseWorkflowOutput(rawBlock(raw)).fields.value).toHaveLength(bytes - 13);
  });

  it('rejects 262145 raw bytes before JSON parsing', () => {
    const raw = `${'!'.repeat(LIMIT)}\n`;
    expect(Buffer.byteLength(raw, 'utf8')).toBe(LIMIT + 1);
    expectCode(() => parseWorkflowOutput(rawBlock(raw)), 'too-large');
  });

  it('counts multibyte payloads in UTF-8 at the exact boundary', () => {
    const exact = rawObjectAtBytes(LIMIT, 'é');
    expect(parseWorkflowOutput(rawBlock(exact)).fields.value).toEqual(expect.any(String));
    const oversized = `${exact.slice(0, -1)}x\n`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(LIMIT + 1);
    expectCode(() => parseWorkflowOutput(rawBlock(oversized)), 'too-large');
  });

  it('does not cap prose outside the structured block', () => {
    const prose = `α${'x'.repeat(LIMIT + 1)}ω`;
    expect(parseWorkflowOutput(prose)).toEqual({ text: prose, fields: {} });
  });
});

describe('declared output fields', () => {
  const everyType = outputSchema({
    title: { type: 'string', required: true },
    score: { type: 'number', required: true },
    approved: { type: 'boolean', required: true },
    tags: { type: 'string[]', required: true },
    note: { type: 'string', required: false },
  });

  it('accepts every exact field type and an absent optional field', () => {
    const output = parseWorkflowOutput(block('{"title":"done","score":1.5,"approved":false,"tags":["a","b"]}'), everyType);
    expect(output).toEqual({
      text: '',
      fields: { title: 'done', score: 1.5, approved: false, tags: ['a', 'b'] },
    });
  });

  it.each([
    ['title', '{"title":1,"score":1,"approved":true,"tags":[]}'],
    ['score', '{"title":"x","score":"1","approved":true,"tags":[]}'],
    ['approved', '{"title":"x","score":1,"approved":1,"tags":[]}'],
    ['tags', '{"title":"x","score":1,"approved":true,"tags":"a"}'],
    ['tags', '{"title":"x","score":1,"approved":true,"tags":["a",1]}'],
  ])('rejects an exact type mismatch for %s without coercion', (field, json) => {
    const error = expectCode(() => parseWorkflowOutput(block(json), everyType), 'type-mismatch');
    expect(error.message).toBe(`Output field "${field}" does not match declared type "${
      field === 'title' ? 'string' : field === 'score' ? 'number' : field === 'approved' ? 'boolean' : 'string[]'
    }".`);
  });

  it('accepts an empty primitive-string array', () => {
    const schema = outputSchema({ tags: { type: 'string[]', required: true } });
    expect(parseWorkflowOutput(block('{"tags":[]}'), schema).fields).toEqual({ tags: [] });
  });

  it('rejects extras when closed and preserves detached nested JSON when open', () => {
    const fields = { result: { type: 'string', required: true } } as const;
    expectCode(() => parseWorkflowOutput(block('{"result":"ok","extra":{"items":[null,true,2]}}'), outputSchema(fields)), 'invalid-shape');
    expect(parseWorkflowOutput(
      block('{"result":"ok","extra":{"items":[null,true,2]}}'),
      outputSchema(fields, true),
    ).fields).toEqual({ result: 'ok', extra: { items: [null, true, 2] } });
  });

  it('applies deterministic missing, type, then extra-field priority', () => {
    const schema = outputSchema({
      first: { type: 'string', required: true },
      second: { type: 'boolean', required: true },
    });
    expectCode(() => parseWorkflowOutput(block('{"second":1,"extra":true}'), schema), 'missing-field');
    expectCode(() => parseWorkflowOutput(block('{"first":"ok","second":1,"extra":true}'), schema), 'type-mismatch');
    expectCode(() => parseWorkflowOutput(block('{"first":"ok","second":true,"extra":true}'), schema), 'invalid-shape');
  });
});

describe('submitted output field boundary', () => {
  it('normalizes undefined to empty fields when no schema is declared', () => {
    expect(validateSubmittedFields(undefined)).toEqual({});
  });

  it('rejects undefined when a declared required field is missing', () => {
    const error = expectCode(
      () => validateSubmittedFields(undefined, outputSchema({ result: { type: 'string', required: true } })),
      'missing-field',
    );
    expect(error.message).toContain('"result"');
  });

  it('rejects the wrong field type with the field name and declared type', () => {
    const error = expectCode(
      () => validateSubmittedFields({ score: 'high' }, outputSchema({ score: { type: 'number', required: true } })),
      'type-mismatch',
    );
    expect(error.message).toContain('"score"');
    expect(error.message).toContain('number');
  });

  it('rejects an extra field when additional fields are disabled', () => {
    const error = expectCode(
      () => validateSubmittedFields(
        { result: 'ok', extra: true },
        outputSchema({ result: { type: 'string', required: true } }),
      ),
      'invalid-shape',
    );
    expect(error.message).toContain('"extra"');
  });
});

describe('safe object handling', () => {
  it.each(['__proto__', 'prototype', 'constructor'])('rejects dangerous top-level key %s before required-field checks', (key) => {
    const schema = outputSchema({ result: { type: 'string', required: true } }, true);
    expectCode(() => parseWorkflowOutput(block(`{"${key}":true}`), schema), 'invalid-shape');
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it.each(['__proto__', 'prototype', 'constructor'])('rejects dangerous nested key %s', (key) => {
    expectCode(() => parseWorkflowOutput(block(`{"safe":{"${key}":true}}`)), 'invalid-shape');
  });

  it('returns detached safe fields without mutating the schema', () => {
    const schema = outputSchema({ result: { type: 'string', required: true, description: 'A result.' } }, true);
    const snapshot = structuredClone(schema);
    const first = parseWorkflowOutput(block('{"result":"ok","nested":{"value":1}}'), schema);
    const second = parseWorkflowOutput(block('{"result":"ok","nested":{"value":1}}'), schema);
    (first.fields.nested as Record<string, unknown>).value = 2;
    expect(second.fields).toEqual({ result: 'ok', nested: { value: 1 } });
    expect(schema).toEqual(snapshot);
    expect(Object.getPrototypeOf(second.fields)).toBeNull();
    expect(Object.getPrototypeOf(second.fields.nested as object)).toBeNull();
  });

  it('parses Unicode, JSON newlines, and escaped fence-like string content without recursion', () => {
    const json = JSON.stringify({ message: 'Привет\n```jinn-output\n{"nested":true}\n```\n世界' });
    expect(parseWorkflowOutput(block(json))).toEqual({
      text: '',
      fields: { message: 'Привет\n```jinn-output\n{"nested":true}\n```\n世界' },
    });
  });
});

describe('hostile runtime misuse', () => {
  it.each([null, undefined, 1, true, {}, [], new String('text')])('rejects a nonstring finalText without stringification', (value) => {
    expectCode(() => parseWorkflowOutput(value as string), 'invalid-shape');
  });

  it('does not invoke finalText coercion or Proxy traps', () => {
    let calls = 0;
    const hostile = new Proxy({}, {
      get() { calls += 1; throw new Error('get trap'); },
      getOwnPropertyDescriptor() { calls += 1; throw new Error('descriptor trap'); },
      ownKeys() { calls += 1; throw new Error('keys trap'); },
    });
    expectCode(() => parseWorkflowOutput(hostile as string), 'invalid-shape');
    expect(calls).toBe(0);
  });

  it('rejects hostile schema Proxies without invoking traps', () => {
    let calls = 0;
    const hostile = new Proxy({}, {
      get() { calls += 1; throw new Error('get trap'); },
      getPrototypeOf() { calls += 1; throw new Error('prototype trap'); },
      ownKeys() { calls += 1; throw new Error('keys trap'); },
    });
    expectCode(() => parseWorkflowOutput(block('{}'), hostile as WorkflowOutputSchema), 'invalid-shape');
    expect(calls).toBe(0);
  });

  it('rejects schema accessors and coercion hooks without invoking them', () => {
    let calls = 0;
    const accessor: Record<string, unknown> = { allowAdditionalFields: false };
    Object.defineProperty(accessor, 'fields', { enumerable: true, get() { calls += 1; throw new Error('getter'); } });
    const coercion = outputSchema();
    Object.defineProperty(coercion, Symbol.toPrimitive, { get() { calls += 1; throw new Error('coercion'); } });
    expectCode(() => parseWorkflowOutput(block('{}'), accessor as WorkflowOutputSchema), 'invalid-shape');
    expectCode(() => parseWorkflowOutput(block('{}'), coercion), 'invalid-shape');
    expect(calls).toBe(0);
  });

  it.each([
    null,
    {},
    { fields: {}, allowAdditionalFields: 'yes' },
    { fields: { 'bad.key': { type: 'string', required: true } }, allowAdditionalFields: false },
    { fields: { ok: { type: 'object', required: true } }, allowAdditionalFields: false },
    { fields: { ok: { type: 'string', required: true, extra: true } }, allowAdditionalFields: false },
    { fields: {}, allowAdditionalFields: false, extra: true },
  ])('maps invalid runtime schema shapes to WorkflowOutputError', (schema) => {
    expectCode(() => parseWorkflowOutput(block('{}'), schema as unknown as WorkflowOutputSchema), 'invalid-shape');
  });
});

describe('error class contract', () => {
  it('exposes all six stable codes with safe deterministic messages', () => {
    const required = outputSchema({ result: { type: 'string', required: true } });
    const cases: Array<[WorkflowOutputError['code'], () => unknown]> = [
      ['multiple-blocks', () => parseWorkflowOutput(`${block('{}')}\n${block('{}')}`)],
      ['invalid-json', () => parseWorkflowOutput(block('{'))],
      ['invalid-shape', () => parseWorkflowOutput(block('null'))],
      ['missing-field', () => parseWorkflowOutput(block('{}'), required)],
      ['type-mismatch', () => parseWorkflowOutput(block('{"result":1}'), required)],
      ['too-large', () => parseWorkflowOutput(rawBlock(`${'x'.repeat(LIMIT)}\n`))],
    ];
    for (const [code, run] of cases) {
      const error = expectCode(run, code);
      expect(error.message).not.toMatch(/[{}\[\]]|undefined|null|x{8}/);
    }
  });
});
