import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { db, createNotification, recordHistory } from './db.ts';
import { emitUserUpdate } from './events.ts';

const execFileAsync = promisify(execFile);

export interface AnalyzerFinding {
  bug_title: string;
  bug_description: string;
  bug_category: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  confidence_score: number;
  analyzer_source: string;
  evidence: string;
  file_path: string;
  start_line: number;
  end_line: number;
  original_code: string;
  root_cause: string;
  why_it_occurs: string;
  triggering_condition: string;
  expected_behavior: string;
  actual_behavior: string;
  potential_impact: string;
  suggested_solution: string;
}

export interface SandboxedTestSuiteResult {
  total_tests: number;
  passed: number;
  failed: number;
  execution_time: number;
  results: Array<{
    test_name: string;
    test_description: string;
    test_status: 'Passed' | 'Failed';
    execution_time: number;
    error_message: string;
    output: string;
  }>;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.java': 'Java',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.cc': 'C++',
};

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.pytest_cache',
  '.mypy_cache',
]);

const MAX_ANALYZABLE_FILE_BYTES = 1024 * 1024; // 1 MB cap per source file

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function collectProjectFiles(rootDir: string): Array<{
  file_name: string;
  file_path: string;
  file_extension: string;
  file_size: number;
  programming_language: string;
}> {
  const files: Array<{
    file_name: string;
    file_path: string;
    file_extension: string;
    file_size: number;
    programming_language: string;
  }> = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
        const ext = path.extname(entry.name).toLowerCase();
        const stat = fs.statSync(abs);
        files.push({
          file_name: entry.name,
          file_path: rel,
          file_extension: ext,
          file_size: stat.size,
          programming_language: LANGUAGE_BY_EXT[ext] || 'Text',
        });
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }
  return files;
}

export function runPythonAstScanner(
  absPath: string,
  relPath: string,
  projectRoot?: string
): Promise<AnalyzerFinding[]> {
  return new Promise((resolve) => {
    const scannerScript = path.resolve(process.cwd(), 'server/python_ast_scanner.py');
    const args = projectRoot
      ? [scannerScript, absPath, relPath, projectRoot]
      : [scannerScript, absPath, relPath];
    const child = spawn('python3', args, {
      timeout: 15000,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve(Array.isArray(parsed.findings) ? parsed.findings : []);
      } catch {
        if (stderr) {
          console.error('Python AST scanner stderr:', stderr);
        }
        resolve([]);
      }
    });
    child.on('error', () => resolve([]));
  });
}

const RUNTIME_AMBIENT_GLOBALS = new Set([
  'window',
  'document',
  'fetch',
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'AbortController',
  'FormData',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'process',
  'Buffer',
  'global',
  'globalThis',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
]);

async function analyzeJsTsFile(
  absPath: string,
  relPath: string,
  lang: string
): Promise<AnalyzerFinding[]> {
  const findings: AnalyzerFinding[] = [];
  const source = fs.readFileSync(absPath, 'utf8');
  if (!source.trim()) return findings;
  const lines = source.split('\n');

  const tscBin = path.resolve(process.cwd(), 'node_modules/.bin/tsc');
  if (fs.existsSync(tscBin)) {
    try {
      const tscArgs = [
        '--noEmit',
        '--ignoreConfig',
        '--allowJs',
        '--checkJs',
        '--noImplicitAny',
        'false',
        '--strictNullChecks',
        'false',
        '--pretty',
        'false',
        '--target',
        'es2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--jsx',
        'react-jsx',
        absPath,
      ];

      let tscOutput = '';
      try {
        const res = await execFileAsync(tscBin, tscArgs, { timeout: 12000 });
        tscOutput = (res.stdout || '') + '\n' + (res.stderr || '');
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string };
        tscOutput = (e.stdout || '') + '\n' + (e.stderr || '');
      }

      const seenLineCode = new Set<string>();
      const diagRegex = /^.*?\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
      for (const rawLine of tscOutput.split('\n')) {
        const match = diagRegex.exec(rawLine.trim());
        if (!match) continue;
        const lineNo = Math.max(1, Number(match[1]));
        const colNo = Number(match[2]);
        const tsCode = match[3];
        const msg = match[4].trim();

        // Filter out ambient runtime globals or external packages when project has no package/types config
        if (tsCode === 'TS2580' || tsCode === 'TS2591') continue;
        if (tsCode === 'TS2304') {
          const nameMatch = /Cannot find name '([^']+)'/.exec(msg);
          if (nameMatch && RUNTIME_AMBIENT_GLOBALS.has(nameMatch[1])) continue;
        }
        if (tsCode === 'TS2307') {
          const modMatch = /Cannot find module '([^']+)'/.exec(msg);
          if (modMatch && !modMatch[1].startsWith('.')) continue;
        }

        const dedupKey = `${lineNo}:${tsCode}:${msg}`;
        if (seenLineCode.has(dedupKey)) continue;
        seenLineCode.add(dedupKey);

        const isSyntax = tsCode.startsWith('TS1');
        const isName = tsCode === 'TS2304' || tsCode === 'TS2552' || tsCode === 'TS2300' || tsCode === 'TS2451';
        const isCall = tsCode === 'TS2554' || tsCode === 'TS2555';
        const isImport = tsCode === 'TS2307';

        const category = isSyntax
          ? 'Syntax Error'
          : isName
          ? 'Name Error'
          : isCall
          ? 'Call Error'
          : isImport
          ? 'Import Error'
          : 'Type Error';

        const severity: AnalyzerFinding['severity'] = isSyntax
          ? 'Critical'
          : isName || isCall || isImport
          ? 'High'
          : 'Medium';

        findings.push({
          bug_title: `${lang} ${category} (${tsCode}): ${msg.slice(0, 72)}`,
          bug_description: `${msg} at ${relPath}:${lineNo}:${colNo}.`,
          bug_category: category,
          severity,
          confidence_score: isSyntax || isName || isCall ? 0.96 : 0.9,
          analyzer_source: 'TypeScript 7.0 Compiler',
          evidence: `${tsCode} at ${relPath}:${lineNo}:${colNo} — ${msg}`,
          file_path: relPath,
          start_line: lineNo,
          end_line: lineNo,
          original_code: lines[lineNo - 1] ?? '',
          root_cause: msg,
          why_it_occurs: `Compiler diagnostic ${tsCode} detected invalid ${category.toLowerCase()} at column ${colNo}.`,
          triggering_condition: `Compiling or executing ${relPath} line ${lineNo}.`,
          expected_behavior: `Valid ${lang} syntax, resolved bindings, and compatible types.`,
          actual_behavior: `TypeScript/JavaScript compiler reports ${tsCode}: ${msg}`,
          potential_impact: isSyntax
            ? 'Code fails to parse or bundle.'
            : 'Runtime ReferenceError/TypeError or failed compilation.',
          suggested_solution: `Fix ${tsCode} at line ${lineNo}: ${msg}`,
        });
      }
    } catch {
      // Fall back silently if tsc failed unexpectedly
    }
  }

  // Real security check for eval() / new Function() outside single-line comments
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
      findings.push({
        bug_title: `Unsafe dynamic code execution in ${lang}`,
        bug_description: `Dynamic eval/Function invocation detected at line ${lineNo}.`,
        bug_category: 'Security Vulnerability',
        severity: 'Critical',
        confidence_score: 0.94,
        analyzer_source: `${lang} Static Security Scanner`,
        evidence: `Matched eval()/new Function() call at ${relPath}:${lineNo}`,
        file_path: relPath,
        start_line: lineNo,
        end_line: lineNo,
        original_code: line,
        root_cause: 'eval() / Function() compiles and executes arbitrary string payloads in the active runtime.',
        why_it_occurs: 'Dynamic expression parsing used instead of JSON.parse or explicit lookup/parser.',
        triggering_condition: 'Untrusted input reaching the evaluated expression.',
        expected_behavior: 'Parse structured data with JSON.parse or safe explicit mapping.',
        actual_behavior: 'Arbitrary JavaScript code can execute with application privileges.',
        potential_impact: 'Remote Code Execution (RCE) or Cross-Site Scripting (XSS).',
        suggested_solution: 'Replace eval()/new Function() with JSON.parse() or explicit safe dispatch.',
      });
    }
  });

  return findings;
}

async function analyzeCCppFile(
  absPath: string,
  relPath: string,
  lang: string
): Promise<AnalyzerFinding[]> {
  const findings: AnalyzerFinding[] = [];
  const source = fs.readFileSync(absPath, 'utf8');
  if (!source.trim()) return findings;
  const lines = source.split('\n');

  const compiler = lang === 'C++' ? 'g++' : 'gcc';
  const ext = path.extname(relPath).toLowerCase();
  if (['.c', '.cpp', '.cc'].includes(ext)) {
    let output = '';
    try {
      const res = await execFileAsync(
        compiler,
        ['-fsyntax-only', '-Wall', '-Wextra', '-I', path.dirname(absPath), absPath],
        { timeout: 10000 }
      );
      output = (res.stdout || '') + '\n' + (res.stderr || '');
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      output = (e.stdout || '') + '\n' + (e.stderr || '');
    }

    const seen = new Set<string>();
    const gccDiagRegex = /^.+?:(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)$/;
    for (const rawLine of output.split('\n')) {
      const m = gccDiagRegex.exec(rawLine.trim());
      if (!m) continue;
      const lineNo = Math.max(1, Number(m[1]));
      const colNo = Number(m[2]);
      const kind = m[3];
      const msg = m[4].trim();
      if (kind === 'warning' && /unused variable|unused parameter/i.test(msg)) continue;

      const key = `${lineNo}:${kind}:${msg}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const isErr = kind === 'error' || kind === 'fatal error';
      findings.push({
        bug_title: `${compiler.toUpperCase()} ${isErr ? 'Compile Error' : 'Compiler Warning'}: ${msg.slice(0, 64)}`,
        bug_description: `${compiler} reported ${kind} at line ${lineNo}, column ${colNo}: ${msg}.`,
        bug_category: isErr ? 'Syntax Error' : 'Compiler Diagnostic',
        severity: isErr ? 'Critical' : 'Medium',
        confidence_score: 0.96,
        analyzer_source: `${compiler.toUpperCase()} (-fsyntax-only -Wall)`,
        evidence: `${relPath}:${lineNo}:${colNo}: ${kind}: ${msg}`,
        file_path: relPath,
        start_line: lineNo,
        end_line: lineNo,
        original_code: lines[lineNo - 1] ?? '',
        root_cause: msg,
        why_it_occurs: `${compiler} rejected or flagged construct at ${relPath}:${lineNo}:${colNo}.`,
        triggering_condition: `Compiling ${relPath}.`,
        expected_behavior: `Zero compiler errors under ${compiler} -Wall -Wextra.`,
        actual_behavior: `${kind}: ${msg}`,
        potential_impact: isErr ? 'Compilation failure.' : 'Undefined behavior or runtime defect.',
        suggested_solution: `Fix the ${kind} reported by ${compiler} at line ${lineNo}: ${msg}`,
      });
    }
  }

  // Unsafe legacy C/C++ buffer functions
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (/\b(strcpy|gets|sprintf|strcat)\s*\(/.test(line)) {
      findings.push({
        bug_title: `Buffer overflow risk in ${lang}`,
        bug_description: `Unbounded C string function detected at line ${lineNo}.`,
        bug_category: 'Memory Safety',
        severity: 'Critical',
        confidence_score: 0.94,
        analyzer_source: `${lang} Security Scanner`,
        evidence: `Matched unbounded C string function at ${relPath}:${lineNo}`,
        file_path: relPath,
        start_line: lineNo,
        end_line: lineNo,
        original_code: line,
        root_cause: 'Unbounded C string API does not enforce destination buffer capacity.',
        why_it_occurs: 'No buffer size limit passed during string operation.',
        triggering_condition: 'Input string exceeding destination buffer length.',
        expected_behavior: 'Bounded copy using snprintf / strncpy / fgets / std::string.',
        actual_behavior: 'Writes past buffer bounds, corrupting stack or heap memory.',
        potential_impact: 'Segmentation fault or arbitrary memory overwrite.',
        suggested_solution: 'Replace with bounded equivalents such as snprintf(), fgets(), or std::string.',
      });
    }
  });

  return findings;
}

function analyzeJavaFile(absPath: string, relPath: string): AnalyzerFinding[] {
  const findings: AnalyzerFinding[] = [];
  const source = fs.readFileSync(absPath, 'utf8');
  if (!source.trim()) return findings;
  const lines = source.split('\n');

  // Check unbalanced curly braces cleanly (javac not installed in environment)
  let balance = 0;
  let lastOpenLine = 1;
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    for (const ch of line) {
      if (ch === '{') {
        balance += 1;
        lastOpenLine = lineNo;
      } else if (ch === '}') {
        balance -= 1;
        if (balance < 0) {
          findings.push({
            bug_title: 'Unmatched closing brace in Java source',
            bug_description: `Unexpected '}' at line ${lineNo}.`,
            bug_category: 'Syntax Error',
            severity: 'Critical',
            confidence_score: 0.92,
            analyzer_source: 'Java Structural Checker',
            evidence: `Brace balance dropped below 0 at ${relPath}:${lineNo}`,
            file_path: relPath,
            start_line: lineNo,
            end_line: lineNo,
            original_code: line,
            root_cause: 'Extra closing brace "}" without matching opening "{".',
            why_it_occurs: 'Structural typo or incomplete refactor.',
            triggering_condition: `Compiling ${relPath}.`,
            expected_behavior: 'Balanced class and block delimiters.',
            actual_behavior: 'Compilation error due to unmatched brace.',
            potential_impact: 'Java file will fail compilation.',
            suggested_solution: 'Remove or match the unbalanced brace.',
          });
          balance = 0;
        }
      }
    }

    if (/\bRuntime\.getRuntime\(\)\.exec\s*\(/.test(line)) {
      findings.push({
        bug_title: 'Unsafe command execution via Runtime.exec() in Java',
        bug_description: `Runtime.getRuntime().exec() at line ${lineNo} risks command injection.`,
        bug_category: 'Security Vulnerability',
        severity: 'High',
        confidence_score: 0.9,
        analyzer_source: 'Java Structural Checker',
        evidence: `Matched Runtime.getRuntime().exec at ${relPath}:${lineNo}`,
        file_path: relPath,
        start_line: lineNo,
        end_line: lineNo,
        original_code: line,
        root_cause: 'OS command string execution without validated argument list.',
        why_it_occurs: 'Runtime.exec() invoked directly.',
        triggering_condition: 'Untrusted input reaching command string.',
        expected_behavior: 'Use ProcessBuilder with fixed argument arrays and input allowlisting.',
        actual_behavior: 'OS command injection hazard.',
        potential_impact: 'Arbitrary OS command execution.',
        suggested_solution: 'Use ProcessBuilder with discrete validated arguments.',
      });
    }
  });

  if (balance > 0) {
    findings.push({
      bug_title: 'Unclosed block brace in Java source',
      bug_description: `Opening '{' from line ${lastOpenLine} is missing a matching closing '}'.`,
      bug_category: 'Syntax Error',
      severity: 'Critical',
      confidence_score: 0.9,
      analyzer_source: 'Java Structural Checker',
      evidence: `Remaining unclosed brace depth=${balance} at EOF in ${relPath}`,
      file_path: relPath,
      start_line: lastOpenLine,
      end_line: lastOpenLine,
      original_code: lines[lastOpenLine - 1] ?? '',
      root_cause: 'Missing closing brace "}".',
      why_it_occurs: 'Block or method left unclosed.',
      triggering_condition: `Compiling ${relPath}.`,
      expected_behavior: 'Every opening brace has a closing match.',
      actual_behavior: 'Syntax failure at end of file.',
      potential_impact: 'Compilation error.',
      suggested_solution: 'Add the missing closing brace.',
    });
  }

  return findings;
}

export async function analyzeSourceFile(
  absPath: string,
  relPath: string,
  lang: string,
  projectRoot?: string
): Promise<AnalyzerFinding[]> {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size === 0 || stat.size > MAX_ANALYZABLE_FILE_BYTES) {
      return [];
    }
  } catch {
    return [];
  }

  if (lang === 'Python') {
    return runPythonAstScanner(absPath, relPath, projectRoot);
  }
  if (lang === 'JavaScript' || lang === 'TypeScript') {
    return analyzeJsTsFile(absPath, relPath, lang);
  }
  if (lang === 'C' || lang === 'C++') {
    return analyzeCCppFile(absPath, relPath, lang);
  }
  if (lang === 'Java') {
    return analyzeJavaFile(absPath, relPath);
  }
  return [];
}

export async function validateProposedPatchContent(params: {
  filePath: string;
  originalContent: string;
  proposedContent: string;
  projectDir: string;
  targetBug: {
    bug_title: string;
    bug_category: string;
    start_line: number;
  };
}): Promise<{ valid: boolean; reason?: string }> {
  const { filePath, originalContent, proposedContent, projectDir, targetBug } = params;
  if (!proposedContent || !proposedContent.trim()) {
    return { valid: false, reason: 'AI returned empty file content.' };
  }
  if (proposedContent.replace(/\r\n/g, '\n') === originalContent.replace(/\r\n/g, '\n')) {
    return { valid: false, reason: 'Proposed patch makes no changes to the original file.' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const lang = LANGUAGE_BY_EXT[ext] || 'Text';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopatch_validate_'));
  try {
    fs.cpSync(projectDir, tmpDir, { recursive: true });
    const tmpTarget = path.resolve(tmpDir, filePath);
    fs.mkdirSync(path.dirname(tmpTarget), { recursive: true });
    fs.writeFileSync(tmpTarget, proposedContent, 'utf8');

    const newFindings = await analyzeSourceFile(tmpTarget, filePath, lang, tmpDir);

    // 1. Reject any Syntax / Compile error in the proposed patch
    const syntaxErr = newFindings.find((f) => f.bug_category === 'Syntax Error');
    if (syntaxErr) {
      return {
        valid: false,
        reason: `Proposed patch introduced a ${syntaxErr.bug_title} at line ${syntaxErr.start_line}: ${syntaxErr.bug_description}`,
      };
    }

    // 2. Check if the exact targeted defect still persists at/near the original line
    const stillUnfixed = newFindings.find(
      (f) =>
        f.bug_title === targetBug.bug_title &&
        Math.abs(f.start_line - targetBug.start_line) <= 3
    );
    if (stillUnfixed) {
      return {
        valid: false,
        reason: `Proposed patch failed to resolve target defect "${stillUnfixed.bug_title}" at line ${stillUnfixed.start_line}.`,
      };
    }

    // 3. Reject newly introduced Critical/High security or name errors that were absent originally
    const origTarget = path.resolve(projectDir, filePath);
    const origFindings = fs.existsSync(origTarget)
      ? await analyzeSourceFile(origTarget, filePath, lang, projectDir)
      : [];
    const origTitles = new Set(origFindings.map((f) => f.bug_title));
    const newlyIntroducedCritical = newFindings.find(
      (f) =>
        (f.severity === 'Critical' || f.bug_category === 'Name Error') &&
        !origTitles.has(f.bug_title)
    );
    if (newlyIntroducedCritical) {
      return {
        valid: false,
        reason: `Proposed patch introduced a new defect: ${newlyIntroducedCritical.bug_title} (line ${newlyIntroducedCritical.start_line}).`,
      };
    }

    return { valid: true };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function isTargetBugResolvedInFile(params: {
  absPath: string;
  relPath: string;
  projectDir: string;
  bugTitle: string;
  startLine: number;
}): Promise<boolean> {
  const ext = path.extname(params.relPath).toLowerCase();
  const lang = LANGUAGE_BY_EXT[ext] || 'Text';
  const findings = await analyzeSourceFile(params.absPath, params.relPath, lang, params.projectDir);
  if (findings.some((f) => f.bug_category === 'Syntax Error')) {
    return false;
  }
  const stillMatching = findings.some(
    (f) => f.bug_title === params.bugTitle && Math.abs(f.start_line - params.startLine) <= 5
  );
  return !stillMatching;
}

export async function startProjectScanJob(projectId: number, userId: number): Promise<number> {
  const project = db
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(projectId, userId) as
    | {
        id: number;
        project_name: string;
        storage_path: string;
        programming_language: string;
      }
    | undefined;

  if (!project) {
    throw new Error('Project not found.');
  }

  const files = collectProjectFiles(project.storage_path);
  const analyzable = files.filter((f) =>
    ['Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++'].includes(f.programming_language)
  );

  // Sync project_files table
  db.prepare(`DELETE FROM project_files WHERE project_id = ?`).run(projectId);
  const insertFile = db.prepare(
    `INSERT INTO project_files (project_id, file_name, file_path, file_extension, file_size, programming_language)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insertFile.run(
      projectId,
      f.file_name,
      f.file_path,
      f.file_extension,
      f.file_size,
      f.programming_language
    );
  }

  const scanRes = db
    .prepare(
      `INSERT INTO scan_jobs (project_id, scan_status, current_stage, progress_percentage, total_files, scanned_files, total_bugs)
       VALUES (?, 'Running', 'Project Structure Analysis', 10, ?, 0, 0)`
    )
    .run(projectId, analyzable.length);
  const scanId = Number(scanRes.lastInsertRowid);

  db.prepare(`UPDATE projects SET project_status = 'Scanning', updated_at = datetime('now') WHERE id = ?`).run(
    projectId
  );
  emitUserUpdate(userId, 'scan_started', { projectId, scanId });

  setImmediate(async () => {
    try {
      await new Promise((r) => setTimeout(r, 150));
      db.prepare(
        `UPDATE scan_jobs SET current_stage = 'Dependency Analysis', progress_percentage = 28 WHERE id = ?`
      ).run(scanId);
      emitUserUpdate(userId, 'scan_stage', { projectId, scanId, stage: 'Dependency Analysis' });

      await new Promise((r) => setTimeout(r, 150));
      db.prepare(
        `UPDATE scan_jobs SET current_stage = 'Code Scanning', progress_percentage = 45 WHERE id = ?`
      ).run(scanId);
      emitUserUpdate(userId, 'scan_stage', { projectId, scanId, stage: 'Code Scanning' });

      const existingCountRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM bugs WHERE project_id = ?`)
        .get(projectId) as { cnt: number };
      let bugCounter = existingCountRow.cnt;

      const findExistingBug = db.prepare(
        `SELECT id, bug_status FROM bugs
         WHERE project_id = ? AND file_path = ? AND start_line = ? AND bug_title = ?
         ORDER BY id DESC LIMIT 1`
      );
      const insertBug = db.prepare(
        `INSERT INTO bugs (
          bug_code, project_id, scan_id, bug_title, bug_description, bug_category, severity,
          confidence_score, analyzer_source, evidence, file_path, start_line, end_line,
          original_code, root_cause, why_it_occurs, triggering_condition, expected_behavior,
          actual_behavior, potential_impact, suggested_solution, bug_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open')`
      );
      const updateExistingBug = db.prepare(
        `UPDATE bugs SET
          scan_id = ?,
          bug_description = ?,
          evidence = ?,
          end_line = ?,
          original_code = ?,
          bug_status = CASE WHEN bug_status = 'Fixed' THEN 'Open' ELSE bug_status END
         WHERE id = ?`
      );

      const allFindings: AnalyzerFinding[] = [];
      let scannedCount = 0;

      for (const file of analyzable) {
        const abs = path.join(project.storage_path, file.file_path);
        const isTestFile =
          file.file_name.startsWith('test_') ||
          file.file_name.endsWith('_test.py') ||
          /\.test\.(js|jsx|ts|tsx|mjs)$/.test(file.file_name);

        let fileFindings: AnalyzerFinding[] = [];
        if (!isTestFile) {
          fileFindings = await analyzeSourceFile(
            abs,
            file.file_path,
            file.programming_language,
            project.storage_path
          );
        }

        allFindings.push(...fileFindings);

        const activeIdsInFile = new Set<number>();
        for (const f of fileFindings) {
          const existing = findExistingBug.get(
            projectId,
            f.file_path,
            f.start_line,
            f.bug_title
          ) as { id: number; bug_status: string } | undefined;

          if (existing) {
            updateExistingBug.run(
              scanId,
              f.bug_description,
              f.evidence,
              f.end_line,
              f.original_code,
              existing.id
            );
            activeIdsInFile.add(existing.id);
          } else {
            bugCounter += 1;
            const code = `BUG-${String(bugCounter).padStart(3, '0')}`;
            const res = insertBug.run(
              code,
              projectId,
              scanId,
              f.bug_title,
              f.bug_description,
              f.bug_category,
              f.severity,
              f.confidence_score,
              f.analyzer_source,
              f.evidence,
              f.file_path,
              f.start_line,
              f.end_line,
              f.original_code,
              f.root_cause,
              f.why_it_occurs,
              f.triggering_condition,
              f.expected_behavior,
              f.actual_behavior,
              f.potential_impact,
              f.suggested_solution
            );
            activeIdsInFile.add(Number(res.lastInsertRowid));
          }
        }

        if (!isTestFile) {
          const prevOpenInFile = db
            .prepare(
              `SELECT id FROM bugs WHERE project_id = ? AND file_path = ? AND bug_status IN ('Open', 'In Review', 'Patched')`
            )
            .all(projectId, file.file_path) as Array<{ id: number }>;
          for (const prev of prevOpenInFile) {
            if (!activeIdsInFile.has(prev.id)) {
              db.prepare(`UPDATE bugs SET bug_status = 'Fixed' WHERE id = ?`).run(prev.id);
            }
          }
        }

        scannedCount += 1;
        const pct = Math.min(82, 45 + Math.round((scannedCount / Math.max(1, analyzable.length)) * 37));
        db.prepare(
          `UPDATE scan_jobs SET scanned_files = ?, progress_percentage = ?, total_bugs = ? WHERE id = ?`
        ).run(scannedCount, pct, allFindings.length, scanId);

        emitUserUpdate(userId, 'scan_file_complete', {
          projectId,
          scanId,
          filePath: file.file_path,
          scannedFiles: scannedCount,
          totalFiles: analyzable.length,
        });
        await new Promise((r) => setTimeout(r, 80));
      }

      db.prepare(
        `UPDATE scan_jobs SET current_stage = 'Bug Detection', progress_percentage = 92 WHERE id = ?`
      ).run(scanId);
      emitUserUpdate(userId, 'scan_stage', { projectId, scanId, stage: 'Bug Detection' });

      await new Promise((r) => setTimeout(r, 80));

      db.prepare(
        `UPDATE scan_jobs SET scan_status = 'Completed', current_stage = 'Analysis Completed',
         progress_percentage = 100, scanned_files = ?, total_bugs = ?, completed_at = datetime('now')
         WHERE id = ?`
      ).run(analyzable.length, allFindings.length, scanId);

      db.prepare(
        `UPDATE projects SET project_status = 'Scanned', updated_at = datetime('now') WHERE id = ?`
      ).run(projectId);

      recordHistory({
        projectId,
        userId,
        actionType: 'PROJECT_SCANNED',
        newValue: `${allFindings.length} issues detected`,
        description: `Completed scan #${scanId} across ${analyzable.length} source files (${allFindings.length} bugs detected).`,
      });

      const criticalCount = allFindings.filter((b) => b.severity === 'Critical').length;
      createNotification(
        userId,
        `Scan Completed: ${project.project_name}`,
        `Analyzed ${analyzable.length} files and detected ${allFindings.length} issues (${criticalCount} critical).`,
        criticalCount > 0 ? 'warning' : 'success'
      );
      emitUserUpdate(userId, 'scan_completed', { projectId, scanId, totalBugs: allFindings.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE scan_jobs SET scan_status = 'Failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(msg, scanId);
      db.prepare(`UPDATE projects SET project_status = 'Error' WHERE id = ?`).run(projectId);
      emitUserUpdate(userId, 'scan_failed', { projectId, scanId, error: msg });
    }
  });

  return scanId;
}

export function runSandboxedPythonTests(
  projectDir: string,
  targetRelFile: string
): Promise<SandboxedTestSuiteResult> {
  return new Promise((resolve) => {
    const runner = path.resolve(process.cwd(), 'server/python_test_runner.py');
    const startedAt = Date.now();
    let timedOut = false;

    const child = spawn('python3', [runner, projectDir, targetRelFile], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 18000);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const elapsed = Number(((Date.now() - startedAt) / 1000).toFixed(4));
      if (timedOut || signal === 'SIGXCPU' || signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve({
          total_tests: 1,
          passed: 0,
          failed: 1,
          execution_time: elapsed,
          results: [
            {
              test_name: `sandbox_timeout::${targetRelFile}`,
              test_description: `Execute ${targetRelFile} inside CPU & time-limited Python sandbox`,
              test_status: 'Failed',
              execution_time: elapsed,
              error_message:
                signal === 'SIGXCPU'
                  ? `Execution exceeded CPU time limit (${elapsed}s) — possible infinite loop.`
                  : 'Execution timed out after 18 seconds (possible infinite loop or long-running blocking call).',
              output: stdout.slice(0, 1000),
            },
          ],
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as SandboxedTestSuiteResult & { error?: string };
        if (parsed.error) {
          resolve({
            total_tests: 1,
            passed: 0,
            failed: 1,
            execution_time: elapsed,
            results: [
              {
                test_name: `runner_error::${targetRelFile}`,
                test_description: `Run tests for ${targetRelFile}`,
                test_status: 'Failed',
                execution_time: elapsed,
                error_message: parsed.error,
                output: '',
              },
            ],
          });
        } else {
          resolve(parsed);
        }
      } catch {
        resolve({
          total_tests: 1,
          passed: 0,
          failed: 1,
          execution_time: elapsed,
          results: [
            {
              test_name: `sandbox_crash::${targetRelFile}`,
              test_description: `Execute ${targetRelFile} in Python sandbox`,
              test_status: 'Failed',
              execution_time: elapsed,
              error_message: (stderr || `Python test runner exited abnormally with code ${code}`).slice(0, 1500),
              output: stdout.slice(0, 1000),
            },
          ],
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        total_tests: 1,
        passed: 0,
        failed: 1,
        execution_time: 0.01,
        results: [
          {
            test_name: `sandbox_spawn::${targetRelFile}`,
            test_description: `Spawn sandbox runner for ${targetRelFile}`,
            test_status: 'Failed',
            execution_time: 0.01,
            error_message: err.message,
            output: '',
          },
        ],
      });
    });
  });
}

export async function runSandboxedJsTsTests(
  projectDir: string,
  targetRelFile: string
): Promise<SandboxedTestSuiteResult> {
  const results: SandboxedTestSuiteResult['results'] = [];
  const tStart = Date.now();
  const absTarget = path.resolve(projectDir, targetRelFile);
  const ext = path.extname(targetRelFile).toLowerCase();
  const lang = LANGUAGE_BY_EXT[ext] || 'JavaScript';

  // 1. Static compiler check
  const tStatic = Date.now();
  const findings = await analyzeJsTsFile(absTarget, targetRelFile, lang);
  const blocking = findings.filter((f) =>
    ['Syntax Error', 'Name Error', 'Call Error', 'Type Error'].includes(f.bug_category)
  );
  const dtStatic = Number(((Date.now() - tStatic) / 1000).toFixed(4));

  if (blocking.length > 0) {
    results.push({
      test_name: `compiler_check::${targetRelFile}`,
      test_description: `Verify ${targetRelFile} passes TypeScript compiler checks`,
      test_status: 'Failed',
      execution_time: dtStatic,
      error_message: blocking.map((b) => `Line ${b.start_line}: ${b.bug_title}`).join('; ').slice(0, 1500),
      output: '',
    });
  } else {
    results.push({
      test_name: `compiler_check::${targetRelFile}`,
      test_description: `Verify ${targetRelFile} passes TypeScript compiler checks`,
      test_status: 'Passed',
      execution_time: dtStatic,
      error_message: '',
      output: `${lang} static compilation succeeded with zero errors.`,
    });
  }

  // 2. Execute top-level JS/TS file in isolated temp working directory (when not React TSX)
  if (!['.jsx', '.tsx'].includes(ext)) {
    const tRun = Date.now();
    const isTs = ext === '.ts';
    const cmd = isTs ? path.resolve(process.cwd(), 'node_modules/.bin/tsx') : 'node';
    try {
      const execRes = await execFileAsync(cmd, [absTarget], {
        cwd: projectDir,
        timeout: 12000,
      });
      const dtRun = Number(((Date.now() - tRun) / 1000).toFixed(4));
      const out = (execRes.stdout || '').trim();
      results.push({
        test_name: `runtime_exec::${targetRelFile}`,
        test_description: `Execute ${targetRelFile} in Node sandbox`,
        test_status: 'Passed',
        execution_time: dtRun,
        error_message: '',
        output: out ? `Stdout:\n${out}`.slice(0, 1500) : 'Executed with exit code 0.',
      });
    } catch (err: unknown) {
      const dtRun = Number(((Date.now() - tRun) / 1000).toFixed(4));
      const e = err as { killed?: boolean; message?: string; stdout?: string; stderr?: string };
      results.push({
        test_name: `runtime_exec::${targetRelFile}`,
        test_description: `Execute ${targetRelFile} in Node sandbox`,
        test_status: 'Failed',
        execution_time: dtRun,
        error_message: e.killed
          ? 'Execution timed out after 12 seconds.'
          : (e.stderr || e.message || 'Runtime execution failed.').slice(0, 1500),
        output: (e.stdout || '').slice(0, 1000),
      });
    }
  }

  // 3. Discover & run *.test.{js,mjs,ts} files via node --test / tsx --test
  const files = collectProjectFiles(projectDir);
  const testFiles = files.filter(
    (f) => /\.test\.(js|mjs|ts)$/.test(f.file_name) || /^test_.*\.(js|mjs|ts)$/.test(f.file_name)
  );
  for (const tf of testFiles) {
    const tTest = Date.now();
    const isTs = tf.file_extension === '.ts';
    const cmd = isTs ? path.resolve(process.cwd(), 'node_modules/.bin/tsx') : 'node';
    const tfAbs = path.resolve(projectDir, tf.file_path);
    try {
      const testRes = await execFileAsync(cmd, ['--test', tfAbs], {
        cwd: projectDir,
        timeout: 15000,
      });
      const dtTest = Number(((Date.now() - tTest) / 1000).toFixed(4));
      results.push({
        test_name: `test_suite::${tf.file_path}`,
        test_description: `Run Node test suite ${tf.file_path}`,
        test_status: 'Passed',
        execution_time: dtTest,
        error_message: '',
        output: (testRes.stdout || 'All tests passed.').slice(0, 1500),
      });
    } catch (err: unknown) {
      const dtTest = Number(((Date.now() - tTest) / 1000).toFixed(4));
      const e = err as { stdout?: string; stderr?: string; message?: string };
      results.push({
        test_name: `test_suite::${tf.file_path}`,
        test_description: `Run Node test suite ${tf.file_path}`,
        test_status: 'Failed',
        execution_time: dtTest,
        error_message: (e.stderr || e.stdout || e.message || 'Test suite failed.').slice(0, 1500),
        output: (e.stdout || '').slice(0, 1000),
      });
    }
  }

  const totalTime = Number(((Date.now() - tStart) / 1000).toFixed(4));
  const passed = results.filter((r) => r.test_status === 'Passed').length;
  const failed = results.filter((r) => r.test_status === 'Failed').length;

  return {
    total_tests: results.length,
    passed,
    failed,
    execution_time: totalTime,
    results,
  };
}

export function writeSampleBuggyPythonProject(targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });

  fs.writeFileSync(
    path.join(targetDir, 'calculator.py'),
    `"""Arithmetic calculation utilities."""


def add(a: float, b: float) -> float:
    return a + b


def divide(a: float, b: float) -> float:
    return a / b


def average(values: list[float]) -> float:
    total = sum(values)
    return total / len(values)
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'marks.py'),
    `"""Student marks and grade calculation."""


def calculate_grade(marks: float) -> str:
    if marks >= 90:
        return "A+"
    if marks >= 75:
        return "A"
    if marks >= 60:
        return "B"
    if marks >= 40:
        return "C"
    return "F"
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'student.py'),
    `"""Student record formatter."""


def format_student_summary(name: str, scores: list[int]) -> str:
    avg_score = sum(scores) / len(scores)
    return f"{name}: avg={avg_score:.1f}, status={final_status}"
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'sorting.py'),
    `"""List inspection and sorting helpers."""


def find_max(items: list[int]) -> int:
    highest = items[0]
    for i in range(len(items) + 1):
        if items[i] > highest:
            highest = items[i]
    return highest
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'main.py'),
    `"""CLI entry helpers."""


def parse_positive_int(raw: str) -> int:
    value = int(raw)
    return value


def run_cli():
    user_val = int(input("Enter count: "))
    return user_val
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(targetDir, 'test_suite.py'),
    `import unittest
from calculator import add, divide
from marks import calculate_grade
from sorting import find_max


class TestCoreModules(unittest.TestCase):
    def test_add_numbers(self):
        self.assertEqual(add(4, 6), 10)

    def test_divide_nominal(self):
        self.assertEqual(divide(10, 2), 5.0)

    def test_grade_nominal(self):
        self.assertEqual(calculate_grade(82), "A")

    def test_find_max_nominal(self):
        self.assertEqual(find_max([2, 8, 3]), 8)
`,
    'utf8'
  );
}
