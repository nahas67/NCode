import { describe, expect, it } from 'vitest';
import { buildNCodeBootstrapPrompt } from '../src/main/prompts/ncode-bootstrap.js';
import { buildNCodeTurnPrompt } from '../src/main/prompts/ncode-turn-wrapper.js';

describe('ncode system prompts', () => {
  describe('ncode-bootstrap', () => {
    it('generates Turn 1 prompt with tool documentation and 5 rules', () => {
      const prompt = buildNCodeBootstrapPrompt({
        goal: 'Refactor repository and ensure zero collision'
      });

      expect(prompt).toContain('AVAILABLE TOOLS');
      expect(prompt).toContain('`shell`');
      expect(prompt).toContain('`read_file`');
      expect(prompt).toContain('`write_file`');
      expect(prompt).toContain('`git_diff`');
      expect(prompt).toContain('STRICT 5-RULE PROTOCOL ENFORCEMENT');
      expect(prompt).toContain('Rule 1 - Plan Tracking (<ncode_plan>)');
      expect(prompt).toContain('Rule 2 - Single Tool Calls (<ncode_tool>)');
      expect(prompt).toContain('Rule 3 - No Hallucinated Results');
      expect(prompt).toContain('Rule 4 - State Checkpointing (<ncode_checkpoint>)');
      expect(prompt).toContain('Rule 5 - Verified Completion (<ncode_finish>)');
      expect(prompt).toContain('Refactor repository and ensure zero collision');
    });

    it('injects checkpoint data when resuming', () => {
      const prompt = buildNCodeBootstrapPrompt({
        goal: 'Refactor repository',
        checkpoint: {
          summary: 'Previous refactor reached step 3',
          completedTasks: ['Task 1', 'Task 2'],
          nextSteps: ['Task 3: Tests'],
          criticalFiles: ['package.json']
        }
      });

      expect(prompt).toContain('RESUMED STATE CHECKPOINT');
      expect(prompt).toContain('Previous refactor reached step 3');
      expect(prompt).toContain('Task 1, Task 2');
      expect(prompt).toContain('Task 3: Tests');
      expect(prompt).toContain('package.json');
    });
  });

  describe('ncode-turn-wrapper', () => {
    it('appends anti-drift directive to tool result', () => {
      const prompt = buildNCodeTurnPrompt({
        result: {
          id: 'call-1',
          tool: 'shell',
          status: 'success',
          stdout: 'v20.0.0',
          stderr: ''
        },
        turnNumber: 3
      });

      expect(prompt).toContain('<ncode_result id="call-1" tool="shell" status="success">');
      expect(prompt).toContain('v20.0.0');
      expect(prompt).toContain('[SYSTEM DIRECTIVE - ANTI-DRIFT]');
      expect(prompt).not.toContain('[LIVE USER STEERING NOTE]');
      expect(prompt).not.toContain('[COMPACT & RESUME DIRECTIVE]');
    });

    it('injects user steering notes when provided', () => {
      const prompt = buildNCodeTurnPrompt({
        result: {
          id: 'call-2',
          tool: 'read_file',
          status: 'success',
          stdout: 'content',
          stderr: ''
        },
        turnNumber: 5,
        steeringNotes: 'Focus on windows compatibility first'
      });

      expect(prompt).toContain('[LIVE USER STEERING NOTE]:');
      expect(prompt).toContain('Focus on windows compatibility first');
    });

    it('injects checkpoint directive when requestCheckpoint is true', () => {
      const prompt = buildNCodeTurnPrompt({
        result: {
          id: 'call-3',
          tool: 'shell',
          status: 'success',
          stdout: 'all passed',
          stderr: ''
        },
        turnNumber: 18,
        requestCheckpoint: true
      });

      expect(prompt).toContain('[COMPACT & RESUME DIRECTIVE]:');
      expect(prompt).toContain('Context threshold reached at turn 18');
      expect(prompt).toContain('<ncode_checkpoint>');
    });
  });
});
