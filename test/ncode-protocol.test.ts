import { describe, expect, it } from 'vitest';
import {
  stripGeminiArtifacts,
  parseNCodeTurn,
  formatNCodePlan,
  formatNCodeToolCall,
  formatNCodeResult,
  formatNCodeCheckpoint,
  formatNCodeFinish
} from '../src/shared/ncode-protocol.js';

describe('ncode protocol parser and cleaner', () => {
  it('strips markdown code blocks and Gemini UI copy artifacts', () => {
    const raw = `Here is the command:
\`\`\`xml
Copy code
<ncode_tool name="shell">
{"command": "git status"}
</ncode_tool>
\`\`\`
`;
    const cleaned = stripGeminiArtifacts(raw);
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('Copy code');
    expect(cleaned).toContain('<ncode_tool name="shell">');
  });

  it('parses ncode_plan tag with JSON array', () => {
    const text = `
<ncode_plan>
[
  {"id": "1", "title": "Inspect codebase", "status": "completed"},
  {"id": "2", "title": "Run tests", "status": "in_progress"},
  {"id": "3", "title": "Submit verification", "status": "pending"}
]
</ncode_plan>
`;
    const parsed = parseNCodeTurn(text);
    expect(parsed.plan).toBeDefined();
    expect(parsed.plan).toHaveLength(3);
    expect(parsed.plan![0]).toEqual({
      id: '1',
      title: 'Inspect codebase',
      status: 'completed'
    });
    expect(parsed.plan![1]!.status).toBe('in_progress');
  });

  it('parses ncode_tool tag with arguments', () => {
    const text = `
I will check the files.
<ncode_tool name="shell">
{
  "command": "dir"
}
</ncode_tool>
`;
    const parsed = parseNCodeTurn(text);
    expect(parsed.toolCall).toBeDefined();
    expect(parsed.toolCall!.tool).toBe('shell');
    expect(parsed.toolCall!.args).toEqual({ command: 'dir' });
  });

  it('parses ncode_result tag', () => {
    const text = `
<ncode_result id="call-123" tool="read_file" status="success">
file contents here
line 2
</ncode_result>
`;
    const parsed = parseNCodeTurn(text);
    expect(parsed.toolResult).toBeDefined();
    expect(parsed.toolResult!.id).toBe('call-123');
    expect(parsed.toolResult!.tool).toBe('read_file');
    expect(parsed.toolResult!.status).toBe('success');
    expect(parsed.toolResult!.stdout).toBe('file contents here\nline 2');
  });

  it('parses ncode_checkpoint tag', () => {
    const text = `
<ncode_checkpoint>
{
  "summary": "Completed initial setup",
  "completedTasks": ["task-1", "task-2"],
  "nextSteps": ["task-3"],
  "criticalFiles": ["src/index.ts"]
}
</ncode_checkpoint>
`;
    const parsed = parseNCodeTurn(text);
    expect(parsed.checkpoint).toBeDefined();
    expect(parsed.checkpoint!.summary).toBe('Completed initial setup');
    expect(parsed.checkpoint!.completedTasks).toEqual(['task-1', 'task-2']);
    expect(parsed.checkpoint!.nextSteps).toEqual(['task-3']);
    expect(parsed.checkpoint!.criticalFiles).toEqual(['src/index.ts']);
  });

  it('parses ncode_finish tag', () => {
    const text = `
Task is complete!
<ncode_finish>
All unit tests and build checks pass successfully.
</ncode_finish>
`;
    const parsed = parseNCodeTurn(text);
    expect(parsed.finish).toBeDefined();
    expect(parsed.finish!.summary).toBe('All unit tests and build checks pass successfully.');
  });

  it('formats protocol tags accurately', () => {
    const planFormatted = formatNCodePlan([{ id: '1', title: 'Step 1', status: 'pending' }]);
    expect(planFormatted).toContain('<ncode_plan>');
    expect(planFormatted).toContain('"id": "1"');

    const toolFormatted = formatNCodeToolCall('write_file', { path: 'a.txt', content: 'test' });
    expect(toolFormatted).toContain('<ncode_tool name="write_file">');

    const resultFormatted = formatNCodeResult({
      id: 'call-1',
      tool: 'shell',
      status: 'success',
      stdout: 'done',
      stderr: ''
    });
    expect(resultFormatted).toBe('<ncode_result id="call-1" tool="shell" status="success">\ndone\n</ncode_result>');

    const checkpointFormatted = formatNCodeCheckpoint({
      summary: 'midway',
      completedTasks: ['a'],
      nextSteps: ['b']
    });
    expect(checkpointFormatted).toContain('<ncode_checkpoint>');

    const finishFormatted = formatNCodeFinish('Verification done');
    expect(finishFormatted).toBe('<ncode_finish>\nVerification done\n</ncode_finish>');
  });
});
