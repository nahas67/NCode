/**
 * NCode Turn Wrapper: Wraps tool results with anti-drift directive,
 * live user steering notes, and Compact & Resume checkpoint requests.
 */

import { formatNCodeResult, type NCodeToolResult } from '../../shared/ncode-protocol.js';

export interface TurnWrapperOptions {
  result: NCodeToolResult;
  turnNumber: number;
  steeringNotes?: string;
  requestCheckpoint?: boolean;
}

export function buildNCodeTurnPrompt(options: TurnWrapperOptions): string {
  const { result, turnNumber, steeringNotes, requestCheckpoint } = options;

  let prompt = `${formatNCodeResult(result)}\n\n`;

  // Anti-drift directive
  prompt += `[SYSTEM DIRECTIVE - ANTI-DRIFT]\n`;
  prompt += `Stay focused on achieving the user's primary objective without deviation or unnecessary abstractions.\n`;
  prompt += `Review your plan, update task statuses with <ncode_plan> if changed, and execute the next logical step.\n`;
  prompt += `Continue invoking tools with <ncode_tool> or emit <ncode_finish> once completely verified.\n`;

  // Live user steering notes
  if (steeringNotes && steeringNotes.trim()) {
    prompt += `\n[LIVE USER STEERING NOTE]:\n${steeringNotes.trim()}\n`;
  }

  // Compact & Resume checkpoint request
  if (requestCheckpoint) {
    prompt += `\n[COMPACT & RESUME DIRECTIVE]:\n`;
    prompt += `Context threshold reached at turn ${turnNumber}.\n`;
    prompt += `Before proceeding with new tool executions, you MUST emit an <ncode_checkpoint> tag to serialize your progress:\n`;
    prompt += `<ncode_checkpoint>\n`;
    prompt += `{\n`;
    prompt += `  "summary": "<summary of progress and current state>",\n`;
    prompt += `  "completedTasks": ["<completed task 1>", "..."],\n`;
    prompt += `  "nextSteps": ["<next action item 1>", "..."],\n`;
    prompt += `  "criticalFiles": ["<important file modified or referenced>", "..."]\n`;
    prompt += `}\n`;
    prompt += `</ncode_checkpoint>\n`;
    prompt += `A new session will immediately resume your workflow from this checkpoint.\n`;
  }

  return prompt;
}
