/**
 * NCode Protocol for Chrome Extension (plain JS + ESM).
 */

function stripGeminiArtifacts(text) {
  if (!text) return '';
  let cleaned = text.replace(/\r\n?/g, '\n');

  // Strip Gemini UI code block headers like "xml\nCopy code\n" or "Copy code\n"
  cleaned = cleaned.replace(/^(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '');
  cleaned = cleaned.replace(/\n(?:xml|html|json|markdown|text|bash|sh|zsh|ps1|powershell)?\s*(?:Copy\s*(?:code)?)\n/gmi, '\n');

  // Strip Markdown code block fences surrounding ncode tags or raw tags
  cleaned = cleaned.replace(/```(?:xml|html|json|markdown|ncode)?\s*\n?([\s\S]*?)```/g, '$1');

  return cleaned.trim();
}

function parseNCodeTurn(rawText) {
  const cleanedText = stripGeminiArtifacts(rawText);
  const result = {
    rawText,
    cleanedText
  };

  // 1. Parse <ncode_plan>[...]</ncode_plan>
  const planMatch = /<ncode_plan>([\s\S]*?)<\/ncode_plan>/i.exec(cleanedText);
  if (planMatch) {
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
      // Malformed JSON in plan
    }
  }

  // 2. Parse <ncode_tool name="...">...</ncode_tool>
  const toolMatch = /<ncode_tool(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/ncode_tool>/i.exec(cleanedText);
  if (toolMatch) {
    const tool = (toolMatch[1] ?? '').trim();
    const body = (toolMatch[2] ?? '').trim();
    let args = {};
    if (body) {
      try {
        args = JSON.parse(body);
      } catch {
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

function formatNCodePlan(plan) {
  return `<ncode_plan>\n${JSON.stringify(plan, null, 2)}\n</ncode_plan>`;
}

function formatNCodeToolCall(tool, args) {
  return `<ncode_tool name="${tool}">\n${JSON.stringify(args, null, 2)}\n</ncode_tool>`;
}

function formatNCodeResult(result) {
  const content = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return `<ncode_result id="${result.id}" tool="${result.tool}" status="${result.status}">\n${content}\n</ncode_result>`;
}

function formatNCodeCheckpoint(checkpoint) {
  return `<ncode_checkpoint>\n${JSON.stringify(checkpoint, null, 2)}\n</ncode_checkpoint>`;
}

function formatNCodeFinish(summary) {
  return `<ncode_finish>\n${summary.trim()}\n</ncode_finish>`;
}

// `var`, not `const`: re-injecting this file into a world the manifest already populated is
// normal (`background.js` repairs recorders without reloading the page), and re-declaring a
// top-level `const` there is a SyntaxError.
var NCodeProtocol = {
  stripGeminiArtifacts,
  parseNCodeTurn,
  formatNCodePlan,
  formatNCodeToolCall,
  formatNCodeResult,
  formatNCodeCheckpoint,
  formatNCodeFinish
};

if (typeof globalThis !== 'undefined') {
  globalThis.NCodeProtocol = NCodeProtocol;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NCodeProtocol;
  module.exports.default = NCodeProtocol;
  module.exports.NCodeProtocol = NCodeProtocol;
  Object.assign(module.exports, NCodeProtocol);
}
