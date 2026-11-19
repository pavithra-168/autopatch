import { GoogleGenAI, Type } from '@google/genai';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add your Gemini API key in environment secrets to enable AI root-cause analysis and patch generation.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/429|RESOURCE_EXHAUSTED/i.test(raw)) {
    return new Error('Gemini API rate limit exceeded (429). Please retry in a few seconds.');
  }
  if (/503|UNAVAILABLE|high demand/i.test(raw)) {
    return new Error('Gemini AI model is temporarily experiencing high demand (503). Please retry in a few seconds.');
  }
  if (/403|PERMISSION_DENIED|API_KEY_INVALID/i.test(raw)) {
    return new Error('Gemini API key is invalid or lacks permission. Verify GEMINI_API_KEY configuration.');
  }
  if (/404|NOT_FOUND/i.test(raw)) {
    return new Error(`Gemini model endpoint returned 404: ${raw}`);
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return new Error(parsed.error.message);
    }
  } catch {
    // raw is plain text
  }
  return new Error(raw || 'Gemini API request failed.');
}

async function generateWithRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|temporarily|high demand/i.test(msg);
      if (!isTransient || attempt === maxRetries) {
        throw formatGeminiError(err);
      }
      const delayMs = 800 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw formatGeminiError(lastErr);
}

function buildNumberedExcerpt(fileContent: string, startLine: number, endLine: number, radius = 15): string {
  const lines = fileContent.split('\n');
  const fromIdx = Math.max(0, Math.max(1, startLine) - 1 - radius);
  const toIdx = Math.min(lines.length, Math.max(startLine, endLine) + radius);
  const out: string[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const ln = i + 1;
    const marker = ln >= startLine && ln <= endLine ? '>>>' : '   ';
    out.push(`${marker} ${String(ln).padStart(4, ' ')} | ${lines[i]}`);
  }
  return out.join('\n');
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.replace(/\r\n/g, '\n').trim();
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  if (match) {
    return match[1] + '\n';
  }
  return raw;
}

export interface RootCauseAnalysisResult {
  bug_description: string;
  root_cause: string;
  why_it_occurs: string;
  triggering_condition: string;
  expected_behavior: string;
  actual_behavior: string;
  potential_impact: string;
  suggested_solution: string;
  confidence_score: number;
}

export interface PatchGenerationResult {
  proposed_file_content: string;
  explanation: string;
  repair_reason: string;
}

export async function analyzeBugRootCauseWithAI(params: {
  bugTitle: string;
  bugDescription: string;
  bugCategory: string;
  severity: string;
  analyzerSource?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  evidence: string;
  fileContent: string;
  recentTestOutputs?: string;
}): Promise<RootCauseAnalysisResult> {
  const ai = getGeminiClient();
  const numberedContext = buildNumberedExcerpt(params.fileContent, params.startLine, params.endLine, 20);
  const numberedFullFile = params.fileContent
    .slice(0, 16000)
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');

  const prompt = `You are a senior software reliability engineer performing evidence-based root-cause analysis on a verified defect.

Strict Rules:
- Base EVERY claim strictly on the actual source code, analyzer diagnostic, and execution output below.
- Do NOT invent missing files, symbols, runtime errors, or behaviors not present in the code.
- If the available evidence is ambiguous or incomplete for any part, state explicitly what additional runtime input, dependency, or test evidence is needed.

Defect Record:
- Bug Title: ${params.bugTitle}
- Category: ${params.bugCategory}
- Severity: ${params.severity}
- Analyzer: ${params.analyzerSource || 'Static Analyzer'}
- File Path: ${params.filePath}
- Line Range: ${params.startLine}-${params.endLine}
- Static Analyzer Evidence: ${params.evidence}
- Initial Summary: ${params.bugDescription}

Focused Surrounding Source Code (>>> marks flagged lines):
\`\`\`
${numberedContext}
\`\`\`

${
  params.recentTestOutputs
    ? `Available Sandbox Execution & Test Output:\n\`\`\`\n${params.recentTestOutputs.slice(0, 4000)}\n\`\`\`\n`
    : 'Available Sandbox Execution Output: Not yet executed for this issue.\n'
}
Complete File Source (numbered):
\`\`\`
${numberedFullFile}
\`\`\`

Populate the structured JSON fields thoroughly covering:
- bug_description: Quote the problematic code from ${params.filePath} line(s) ${params.startLine}-${params.endLine} and explain precisely why that code is incorrect.
- root_cause: Underlying technical root cause in the program logic, scope, types, or control flow.
- why_it_occurs: Why this failure happens at compile/runtime and what evidence proves it.
- triggering_condition: Specific input, call, or execution path that triggers the defect.
- expected_behavior: Exact expected behavior of this code.
- actual_behavior: Actual behavior or exception produced by the current code.
- potential_impact: Runtime impact AND any potential side effects to watch out for when modifying this logic.
- suggested_solution: Include (1) the exact corrected code snippet, (2) explanation of the correction, and (3) concrete validation test cases to verify the fix.
- confidence_score: Calibrated numeric confidence between 0.0 and 1.0 (lower it if evidence is incomplete).`;

  const response = await generateWithRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You analyze real source code defects strictly from the supplied source code, line numbers, diagnostics, and execution logs. Never fabricate facts or generic boilerplate.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            bug_description: { type: Type.STRING },
            root_cause: { type: Type.STRING },
            why_it_occurs: { type: Type.STRING },
            triggering_condition: { type: Type.STRING },
            expected_behavior: { type: Type.STRING },
            actual_behavior: { type: Type.STRING },
            potential_impact: { type: Type.STRING },
            suggested_solution: { type: Type.STRING },
            confidence_score: { type: Type.NUMBER },
          },
          required: [
            'bug_description',
            'root_cause',
            'why_it_occurs',
            'triggering_condition',
            'expected_behavior',
            'actual_behavior',
            'potential_impact',
            'suggested_solution',
            'confidence_score',
          ],
        },
      },
    })
  );

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as RootCauseAnalysisResult;
  const conf = Number(parsed.confidence_score);
  return {
    ...parsed,
    confidence_score: Number.isFinite(conf) ? Math.min(0.99, Math.max(0.2, conf)) : 0.85,
  };
}

export async function generatePatchWithAI(params: {
  bugTitle: string;
  bugDescription: string;
  rootCause: string;
  suggestedSolution: string;
  evidence?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  fileContent: string;
  recentTestOutputs?: string;
  validationFeedback?: string;
}): Promise<PatchGenerationResult> {
  const ai = getGeminiClient();
  const numberedContext = buildNumberedExcerpt(params.fileContent, params.startLine, params.endLine, 20);

  const prompt = `You are a senior software engineer creating a minimal, surgical, syntactically valid source code patch for a confirmed bug.

Target File: ${params.filePath}
Bug: ${params.bugTitle} (lines ${params.startLine}-${params.endLine})
Description: ${params.bugDescription}
Analyzer Evidence: ${params.evidence || 'See source lines below'}
Root Cause: ${params.rootCause}
Recommended Solution: ${params.suggestedSolution}

Focused Region (>>> marks target lines):
\`\`\`
${numberedContext}
\`\`\`

${
  params.recentTestOutputs
    ? `Recent Execution / Failure Output:\n\`\`\`\n${params.recentTestOutputs.slice(0, 3000)}\n\`\`\`\n`
    : ''
}${
    params.validationFeedback
      ? `IMPORTANT - Your previous candidate patch failed automated validation:\n${params.validationFeedback}\nFix this cleanly in the new patch.\n`
      : ''
  }
Complete Original File Content (preserve EVERYTHING outside the targeted bug):
\`\`\`
${params.fileContent}
\`\`\`

Strict Patch Rules:
1. "proposed_file_content" MUST contain the COMPLETE updated file content — raw source text only, NO markdown \`\`\` fences.
2. Modify ONLY the minimum lines necessary to fix the bug cleanly; preserve all unrelated functions, classes, imports, print/log statements, docstrings, comments, and formatting.
3. Preserve indentation and trailing newline style.
4. Ensure the fix actually resolves the bug at lines ${params.startLine}-${params.endLine} and introduces zero new syntax errors, undefined names, or dangerous calls (eval/exec).
5. In "explanation", describe clearly what lines were modified, why the change resolves the root cause, and any potential side effects or edge cases.
6. In "repair_reason", provide a concise summary of the exact fix applied.`;

  const response = await generateWithRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You output clean, minimal, syntactically valid complete-file source repairs as structured JSON. Never fabricate unrelated code or return markdown fences inside proposed_file_content.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            proposed_file_content: { type: Type.STRING },
            explanation: { type: Type.STRING },
            repair_reason: { type: Type.STRING },
          },
          required: ['proposed_file_content', 'explanation', 'repair_reason'],
        },
      },
    })
  );

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as PatchGenerationResult;
  return {
    ...parsed,
    proposed_file_content: stripCodeFences(String(parsed.proposed_file_content ?? '')),
  };
}
