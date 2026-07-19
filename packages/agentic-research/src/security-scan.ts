/**
 * Deterministic security pattern scan over a Developer diff (2026-07-19,
 * architecture review #15 "Security Review Pass"). Runs BEFORE the LLM
 * Reviewer sees the diff, as a second, independent signal - not a
 * replacement for the Reviewer's own judgment (auth/authorization logic,
 * CSRF, business-rule bypasses genuinely need semantic understanding no
 * regex can give), but a narrow, cheap, deterministic net for the specific
 * classes of issue that DON'T need judgment to recognize: a hardcoded
 * secret is a hardcoded secret regardless of what the surrounding code is
 * trying to do. Matches this project's established "never trust the model,
 * verify deterministically" principle - the scan result is handed to the
 * Reviewer as evidence to weigh (it can still call a specific match a false
 * positive, e.g. an obvious test fixture), not auto-blocking on its own,
 * since regex has no way to be certain a real project's specific context
 * doesn't make a match benign.
 *
 * Deliberately scoped to ADDED lines only (unified diff `+` lines, not
 * `+++` file headers) - this reviews what the Developer is actually
 * introducing, mirroring the Reviewer's own "only the diff, not a broader
 * audit" scope discipline (see REVIEWER_SYSTEM_PROMPT).
 */

export interface SecurityFinding {
  category: "hardcoded-secret" | "sql-injection" | "dangerous-eval" | "path-traversal";
  file: string;
  snippet: string;
}

interface DiffAddedLine {
  file: string;
  content: string;
}

function extractAddedLines(diff: string): DiffAddedLine[] {
  const lines: DiffAddedLine[] = [];
  let currentFile = "";

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      // "+++ b/path/to/file" - strip the "+++ b/" prefix.
      currentFile = rawLine.slice(4).replace(/^[ab]\//, "").trim();
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      lines.push({ file: currentFile, content: rawLine.slice(1) });
    }
  }

  return lines;
}

// Value looks like an obvious placeholder/fixture, not a real secret -
// keeps the scan from crying wolf on the most common false-positive shape
// (example configs, test fixtures, documentation snippets in the diff).
const PLACEHOLDER_VALUE_PATTERN = /^(x{3,}|your[-_]|example|changeme|change-me|placeholder|dummy|fake|test|sample|xxx|000|<[^>]*>|\{\{.*\}\}|\.\.\.|%s|\$\{)/i;
const TEST_FIXTURE_PATH_PATTERN = /\b(test|tests|spec|specs|fixture|fixtures|__tests__|__mocks__|mock|mocks|example|examples|\.env\.example)\b/i;

const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|apikey|secret(?:[_-]?key)?|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"]([^'"]{8,})['"]/i;
// Bug fix, caught by the scanner's own live test (2026-07-19): the original
// single regex excluded quote characters between the SQL keyword and the
// concatenation point ([^;"'`]{0,200}) to avoid crossing a "sentence"
// boundary - but a real SQL string built via concatenation almost ALWAYS
// has a quote character right before the concatenation point ('" . $var'),
// so the exclusion broke the exact pattern it existed to catch. Split into
// two independent, ANDed checks instead: does the line contain a SQL
// keyword pair, and does it separately contain a string-concatenated
// variable - true positive on the live test (DB::select("SELECT * FROM
// users WHERE name = '" . $name . "'")) confirmed after this fix.
const SQL_KEYWORD_PATTERN = /\bSELECT\b[^;]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b[^;]*\bSET\b|\bDELETE\s+FROM\b/i;
const STRING_CONCAT_WITH_VARIABLE_PATTERN = /['"`]\s*\.\s*\$\w+|\$\w+\s*\.\s*['"`]|['"`]\s*\+\s*\w+\s*\+?\s*['"`]?|\$\{[^}]+\}/;
const DANGEROUS_EVAL_PATTERN = /\b(eval|exec|system|shell_exec|passthru|proc_open|popen)\s*\(\s*(\$|['"`]\s*\.|`[^`]*\$\{)|new\s+Function\s*\(/;
const PATH_TRAVERSAL_PATTERN = /\b(fopen|file_get_contents|file_put_contents|readFileSync|require|include|include_once|require_once)\s*\([^)]*\$_(GET|POST|REQUEST|COOKIE)\b|\.\.\/[^'"]*\$_(GET|POST|REQUEST)\b/i;

export function scanDiffForSecurityFindings(diff: string): SecurityFinding[] {
  const addedLines = extractAddedLines(diff);
  const findings: SecurityFinding[] = [];

  for (const { file, content } of addedLines) {
    const trimmed = content.trim();

    if (!trimmed) {
      continue;
    }

    const secretMatch = SECRET_ASSIGNMENT_PATTERN.exec(trimmed);

    if (secretMatch && secretMatch[2] && !PLACEHOLDER_VALUE_PATTERN.test(secretMatch[2]) && !TEST_FIXTURE_PATH_PATTERN.test(file)) {
      findings.push({ category: "hardcoded-secret", file, snippet: trimmed.slice(0, 160) });
    }

    if (SQL_KEYWORD_PATTERN.test(trimmed) && STRING_CONCAT_WITH_VARIABLE_PATTERN.test(trimmed)) {
      findings.push({ category: "sql-injection", file, snippet: trimmed.slice(0, 160) });
    }

    if (DANGEROUS_EVAL_PATTERN.test(trimmed)) {
      findings.push({ category: "dangerous-eval", file, snippet: trimmed.slice(0, 160) });
    }

    if (PATH_TRAVERSAL_PATTERN.test(trimmed)) {
      findings.push({ category: "path-traversal", file, snippet: trimmed.slice(0, 160) });
    }
  }

  return findings;
}

const CATEGORY_LABEL: Record<SecurityFinding["category"], string> = {
  "hardcoded-secret": "Hardcoded secret/credential",
  "sql-injection": "SQL built via string concatenation (injection risk)",
  "dangerous-eval": "Dangerous dynamic execution (eval/exec/shell)",
  "path-traversal": "Unsanitized user input reaching a filesystem path",
};

/** Formats findings for injection into the Reviewer's prompt - see develop-loop.ts's callReviewer. */
export function formatSecurityFindingsForReviewer(findings: SecurityFinding[]): string {
  return findings
    .map((finding, index) => `${index + 1}. [${CATEGORY_LABEL[finding.category]}] ${finding.file}: \`${finding.snippet}\``)
    .join("\n");
}
