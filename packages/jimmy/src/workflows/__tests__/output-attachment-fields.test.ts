import { describe, expect, it } from 'vitest';
import type { WorkflowOutputSchema } from '../model.js';
import { parseWorkflowOutput, validateSubmittedFields, WorkflowOutputError } from '../output.js';

function outputSchema(
  fields: WorkflowOutputSchema['fields'] = {},
  allowAdditionalFields = false,
): WorkflowOutputSchema {
  return { fields, allowAdditionalFields };
}

function block(json: string, eol = '\n', closingEol = ''): string {
  return `\`\`\`jinn-output${eol}${json}${eol}\`\`\`${closingEol}`;
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

describe('attachment field types', () => {
  const REF = 'attachment:PLA-135:wia_ab12cd34ef56:image/png';
  const schema = outputSchema({
    shot: { type: 'attachment', required: true },
    extras: { type: 'attachment[]', required: true },
  });

  it('accepts a well-formed ref and a list of them', () => {
    const output = parseWorkflowOutput(block(`{"shot":"${REF}","extras":["${REF}","${REF}"]}`), schema);
    expect(output.fields).toEqual({ shot: REF, extras: [REF, REF] });
  });

  it('accepts an empty attachment list', () => {
    expect(parseWorkflowOutput(block(`{"shot":"${REF}","extras":[]}`), schema).fields).toEqual({ shot: REF, extras: [] });
  });

  it.each([
    ['a bare filename', '"screenshot.png"'],
    ['an absolute path', '"/var/tmp/shot.png"'],
    ['a parent-directory hop', '"attachment:PLA-135:wia_ab12cd34ef56:../../etc/passwd"'],
    ['a ref with trailing prose', `"${REF} looks good"`],
    ['a plain string array', '["a"]'],
    ['a number', '3'],
  ])('rejects %s, naming the field and the ref shape', (_label, json) => {
    const error = expectCode(() => parseWorkflowOutput(block(`{"shot":${json},"extras":[]}`), schema), 'type-mismatch');
    expect(error.message).toContain('Output field "shot" does not match declared type "attachment".');
    expect(error.message).toContain('attachment:<TODO-ID>:<attachment-id>:<mime>');
  });

  it('rejects a list holding one bad ref', () => {
    const error = expectCode(
      () => parseWorkflowOutput(block(`{"shot":"${REF}","extras":["${REF}","nope.png"]}`), schema),
      'type-mismatch',
    );
    expect(error.message).toContain('Output field "extras" does not match declared type "attachment[]".');
  });

  it('does not let an attachment type slip through the string[] check', () => {
    const single = outputSchema({ shot: { type: 'attachment', required: true } });
    expectCode(() => parseWorkflowOutput(block('{"shot":["a"]}'), single), 'type-mismatch');
  });

  it('leaves the existing types alone', () => {
    const mixed = outputSchema({ shot: { type: 'attachment', required: true }, tags: { type: 'string[]', required: true } });
    expect(parseWorkflowOutput(block(`{"shot":"${REF}","tags":["${REF}","plain"]}`), mixed).fields)
      .toEqual({ shot: REF, tags: [REF, 'plain'] });
  });

  it('persists the ref string itself, with no bytes alongside it', () => {
    const fields = validateSubmittedFields({ shot: REF, extras: [REF] }, schema);
    expect(JSON.parse(JSON.stringify(fields))).toEqual({ shot: REF, extras: [REF] });
  });
});
