/**
 * NCode Protocol: Tag schemas, parser, cleaner, and formatters for Gemini Web communication.
 *
 * Replaces all legacy protocol tags with <ncode_*> tags:
 *   - <ncode_plan>: Dynamic JSON task plan array (id, title, status)
 *   - <ncode_tool name="...">: Tool execution request containing JSON args
 *   - <ncode_result id="..." tool="..." status="...">: Host execution feedback containing stdout/stderr
 *   - <ncode_checkpoint>: State serialization for Compact & Resume
 *   - <ncode_finish>: Verification summary when task is complete
 */

export interface NCodePlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  details?: string;
}

export interface NCodeToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface NCodeToolResult {
  id: string;
  tool: string;
  status: 'success' | 'error';
  stdout: string;
  stderr: string;
}

export interface NCodeCheckpoint {
  summary: string;
  completedTasks: string[];
  nextSteps: string[];
  criticalFiles?: string[];
  [key: string]: unknown;
}

export interface NCodeFinish {
  summary: string;
}

export interface NCodeParsedTurn {
  plan?: NCodePlanStep[];
  toolCall?: NCodeToolCall;
  toolResult?: NCodeToolResult;
  checkpoint?: NCodeCheckpoint;
  finish?: NCodeFinish;
  rawText: string;
  cleanedText: string;
}

/**
 * Strips Markdown code fences and Gemini Web UI artifacts (e.g. `xml\nCopy code`).
 */
export function stripGeminiArtifacts(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/\r\n?/g, '\n');

  // Strip Gemini UI code block headers like "xml\nCopy code\n" or "Copy code\n"
  cleaned = cleaned.replace(/^(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '');
  cleaned = cleaned.replace(/\n(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '\n');

  // Strip Markdown code block fences surrounding ncode tags or raw tags
  // ```xml ... ``` or ```ncode ... ``` or ``` ... ```
  cleaned = cleaned.replace(/```(?:xml|html|json|markdown|ncode)?\s*\n?([\s\S]*?)```/g, '$1');

  return cleaned.trim();
}

/**
 * Parses Gemini assistant text for NCode protocol tags.
 */
export function parseNCodeTurn(rawText: string): NCodeParsedTurn {
  const cleanedText = stripGeminiArtifacts(rawText);
  const result: NCodeParsedTurn = {
    rawText,
    cleanedText
  };

  // 1. Parse <ncode_plan>[...]</ncode_plan>
  const planMatch = /<ncode_plan>([\s\S]*?)<\/ncode_plan>/i.exec(cleanedText);
  if (planMatch && planMatch[1]) {
    try {
      const parsed = JSON.parse(planMatch[1].trim());
      if (Array.isArray(parsed)) {
        result.plan = parsed.map((item, idx) => ({
          id: String(item.id ?? idx + 1),
          title: String(item.title ?? item.step ?? ''),
          status: item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending',
          ...(item.details ? { details: String(item.details) } : {})
        }));
      }
    } catch {
      // Malformed JSON in plan; ignore or keep undefined
    }
  }

  // 2. Parse <ncode_tool name="...">...</ncode_tool>
  const toolMatch = /<ncode_tool(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/ncode_tool>/i.exec(cleanedText);
  if (toolMatch) {
    const tool = (toolMatch[1] ?? '').trim();
    const body = (toolMatch[2] ?? '').trim();
    let args: Record<string, unknown> = {};
    if (body) {
      try {
        args = JSON.parse(body);
      } catch {
        // Fallback for simple string argument e.g. shell command
        args = { raw: body };
      }
    }
    result.toolCall = {
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      tool: tool || (typeof args.tool === 'string' ? args.tool : 'shell'),
      args
    };
  }

  // 3. Parse <ncode_result id="..." tool="..." status="...">...</ncode_result>
  const resultMatch = /<ncode_result(?:\s+id=["']([^"']+)["'])?(?:\s+tool=["']([^"']+)["'])?(?:\s+status=["']([^"']+)["'])?>([\s\S]*?)<\/ncode_result>/i.exec(cleanedText);
  if (resultMatch) {
    result.toolResult = {
      id: resultMatch[1] ?? 'unknown',
      tool: resultMatch[2] ?? 'unknown',
      status: resultMatch[3] === 'error' ? 'error' : 'success',
      stdout: (resultMatch[4] ?? '').trim(),
      stderr: ''
    };
  }

  // 4. Parse <ncode_checkpoint>...</ncode_checkpoint>
  const checkpointMatch = /<ncode_checkpoint>([\s\S]*?)<\/ncode_checkpoint>/i.exec(cleanedText);
  if (checkpointMatch && checkpointMatch[1]) {
    const cpBody = checkpointMatch[1].trim();
    try {
      const parsed = JSON.parse(cpBody);
      result.checkpoint = {
        summary: String(parsed.summary ?? ''),
        completedTasks: Array.isArray(parsed.completedTasks) ? parsed.completedTasks.map(String) : [],
        nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
        criticalFiles: Array.isArray(parsed.criticalFiles) ? parsed.criticalFiles.map(String) : [],
        ...parsed
      };
    } catch {
      result.checkpoint = {
        summary: cpBody,
        completedTasks: [],
        nextSteps: []
      };
    }
  }

  // 5. Parse <ncode_finish>...</ncode_finish>
  const finishMatch = /<ncode_finish>([\s\S]*?)<\/ncode_finish>/i.exec(cleanedText);
  if (finishMatch) {
    result.finish = {
      summary: (finishMatch[1] ?? '').trim()
    };
  }

  return result;
}

/**
 * Format plan steps into <ncode_plan> tag.
 */
export function formatNCodePlan(plan: NCodePlanStep[]): string {
  return `<ncode_plan>\n${JSON.stringify(plan, null, 2)}\n</ncode_plan>`;
}

/**
 * Format tool call into <ncode_tool> tag.
 */
export function formatNCodeToolCall(tool: string, args: Record<string, unknown>): string {
  return `<ncode_tool name="${tool}">\n${JSON.stringify(args, null, 2)}\n</ncode_tool>`;
}

/**
 * Format tool result into <ncode_result> tag.
 */
export function formatNCodeResult(result: NCodeToolResult): string {
  const content = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return `<ncode_result id="${result.id}" tool="${result.tool}" status="${result.status}">\n${content}\n</ncode_result>`;
}

/**
 * Format checkpoint into <ncode_checkpoint> tag.
 */
export function formatNCodeCheckpoint(checkpoint: NCodeCheckpoint): string {
  return `<ncode_checkpoint>\n${JSON.stringify(checkpoint, null, 2)}\n</ncode_checkpoint>`;
}

/**
 * Format finish into <ncode_finish> tag.
 */
export function formatNCodeFinish(summary: string): string {
  return `<ncode_finish>\n${summary.trim()}\n</ncode_finish>`;
}
