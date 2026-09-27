/** Closed catalog of runner diagnostics. Match complete output lines, never nearby numbers. */
export type TestRunner = "vitest" | "jest" | "karma" | "pytest" | "maven-surefire" | "gradle";
export interface TestRunProblem {
  runner: TestRunner;
  kind: "no-tests" | "load-error";
  line: string;
}

/** Exact runner-reported file (or JVM class) and full case name; no wildcard exemptions. */
export interface TestFailure {
  file: string;
  case: string;
}

export function isTestFailure(value: unknown): value is TestFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return [entry.file, entry.case].every(
    (part) => typeof part === "string" && part.trim().length > 0,
  );
}

export function testFailureKey(failure: TestFailure): string {
  return JSON.stringify([failure.file.trim().replace(/\\/g, "/"), failure.case.trim()]);
}

const CATALOG: { runner: TestRunner; empty: RegExp[]; load: RegExp[] }[] = [
  {
    runner: "vitest",
    empty: [
      /^No test files found\b/i,
      /^(?:Tests\s+)?0 tests?\s*$/i,
      /^Tests\s+(?:no tests|0 total)\s*$/i,
    ],
    load: [
      /^FAIL\s+(\S+)\s+\[\s*\1\s*\]\s*$/,
      /^Failed to load (?:url|config)\b/i,
      /^Error: Failed to load (?:url|config)\b/i,
    ],
  },
  {
    runner: "jest",
    empty: [/^No tests found\b/i, /^Tests:\s+0 total\s*$/],
    load: [/^(?:●\s*)?Test suite failed to run\s*$/],
  },
  {
    runner: "karma",
    empty: [/^TOTAL:\s+0 SUCCESS\s*$/],
    load: [
      /^(?:.*?\[?(?:ERROR|error)\]?\s*\[karma-server\]:?\s*)?(?:Error:\s*)?Found [1-9]\d* load errors?\s*$/,
      /^Found [1-9]\d* load errors?\s*$/,
    ],
  },
  {
    runner: "pytest",
    empty: [/^collected 0 items\b/, /^(?:=+\s*)?no tests ran in [\d.]+s(?:\s*=+)?$/],
    load: [
      /^ERROR collecting\b/,
      /^_+\s*ERROR collecting\b.*_+$/,
      /^ImportError while (?:importing test module|loading conftest)\b/,
    ],
  },
  {
    runner: "maven-surefire",
    empty: [
      /^(?:\[INFO\]\s*)?No tests to run\.?$/,
      /^(?:\[(?:INFO|WARNING)\]\s*)?Tests run:\s*0,\s*Failures:\s*0,\s*Errors:\s*0\b/,
    ],
    load: [
      /^(?:\[ERROR\]\s*)?There was an error in the forked process\s*$/,
      /^(?:\[ERROR\]\s*)?TestEngine with ID '.+' failed to discover tests\s*$/,
    ],
  },
  {
    runner: "gradle",
    empty: [
      /^> Task :(?:[\w.-]+:)*(?:test|integrationTest) NO-SOURCE\s*$/,
      /^0 tests completed\b/,
      /^No tests found for given includes:\s*\[.*\]/,
    ],
    load: [/^(?:>\s*)?Could not (?:complete execution for|start) Gradle Test Executor\b/],
  },
];

/** ANSI colors and CR progress redraws are presentation, not evidence. */
export function testOutputLines(detail: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal SGR sequences
  const plain = detail.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return plain.split(/\r\n|\r|\n/).map((line) => line.trim());
}

export function testRunProblem(detail: string): TestRunProblem | null {
  const browsers = new Map<string, TestRunProblem | null>();
  for (const line of testOutputLines(detail)) {
    // Karma's progress reporter starts at zero. Only the last observation for
    // each browser proves whether that browser actually ran any tests.
    const progress = /^(?:(.+?):\s*)?Executed (\d+) of \d+\b/.exec(line);
    if (progress !== null) {
      browsers.set(
        progress[1] ?? "",
        Number(progress[2]) === 0 ? { runner: "karma", kind: "no-tests", line } : null,
      );
      continue;
    }
    const problem = catalogProblem(line);
    if (problem !== null) return problem;
  }
  return [...browsers.values()].find((problem) => problem !== null) ?? null;
}

function catalogProblem(line: string): TestRunProblem | null {
  for (const entry of CATALOG) {
    if (entry.load.some((pattern) => pattern.test(line)))
      return { runner: entry.runner, kind: "load-error", line };
    if (entry.empty.some((pattern) => pattern.test(line)))
      return { runner: entry.runner, kind: "no-tests", line };
  }
  return null;
}

export interface TestFailures {
  failures: TestFailure[];
  unreadable: string[];
}

interface FailureScan {
  cases: Map<string, TestFailure>;
  byRunner: Map<string, Set<string>>;
  files: Map<TestRunner, Set<string>>;
  unreadable: string[];
  expected: Map<string, { count: number; line: string }>;
  summaries: Set<string>;
  jestFile: string | null;
  jestCases: number;
  karmaCase: string | null;
  karmaBrowser: string;
}

/** Output without file/case identity cannot prove that a red was already known. */
export function readTestFailures(detail: string): TestFailures {
  const scan: FailureScan = {
    cases: new Map(),
    byRunner: new Map(),
    files: new Map(),
    unreadable: [],
    expected: new Map(),
    summaries: new Set(),
    jestFile: null,
    jestCases: 0,
    karmaCase: null,
    karmaBrowser: "",
  };
  for (const line of testOutputLines(detail)) {
    if (runBoundary(line)) finishRun(scan);
    readFailureLine(scan, line);
  }
  finishRun(scan);
  return { failures: [...scan.cases.values()], unreadable: scan.unreadable };
}

function runBoundary(line: string): boolean {
  return (
    /^(?:RUN|RERUN)\s+v\d/.test(line) ||
    /^=+ test session starts =+$/.test(line) ||
    /^> Task :(?:[\w.-]+:)*(?:test|integrationTest)(?:\s|$)/.test(line) ||
    /^\[INFO\] --- .*surefire.*:test\b/.test(line) ||
    /^Ran all test suites\b/.test(line)
  );
}

function finishRun(scan: FailureScan): void {
  finishJest(scan);
  if (scan.karmaCase !== null) scan.unreadable.push(scan.karmaCase);
  scan.karmaCase = null;
  for (const [runner, summary] of scan.expected) {
    const named = scan.byRunner.get(runner)?.size ?? 0;
    if (summary.count > named) scan.unreadable.push(summary.line);
  }
  scan.expected.clear();
  scan.summaries.clear();
  scan.byRunner.clear();
  scan.files.clear();
}

function addFailure(scan: FailureScan, runner: TestRunner, file: string, name: string): void {
  const failure = { file, case: name };
  const key = testFailureKey(failure);
  scan.cases.set(key, failure);
  const cases = scan.byRunner.get(runner) ?? new Set<string>();
  // Karma counts browser executions, not unique file/case identities.
  cases.add(runner === "karma" ? JSON.stringify([scan.karmaBrowser, key]) : key);
  scan.byRunner.set(runner, cases);
  if (runner === "karma") {
    const browserKey = `karma:${scan.karmaBrowser}`;
    const browserCases = scan.byRunner.get(browserKey) ?? new Set<string>();
    browserCases.add(key);
    scan.byRunner.set(browserKey, browserCases);
  }
  const files = scan.files.get(runner) ?? new Set<string>();
  files.add(file);
  scan.files.set(runner, files);
  scan.byRunner.set(`${runner}:files`, files);
}

function finishJest(scan: FailureScan): void {
  if (scan.jestFile !== null && scan.jestCases === 0) scan.unreadable.push(`FAIL ${scan.jestFile}`);
  scan.jestFile = null;
  scan.jestCases = 0;
}

const FAILURE_LINES: [TestRunner, RegExp][] = [
  ["vitest", /^FAIL\s+(\S+)\s+>\s+(.+)$/],
  ["pytest", /^(?:FAILED|ERROR)\s+(.+?)::(.+?)(?:\s+-\s+.*)?$/],
  ["gradle", /^([\w.$]+)\s+>\s+(.+?)\s+FAILED$/],
  [
    "maven-surefire",
    /^(?:\[ERROR\]\s*)?([\w.$]+)\.([\w$]+(?:\([^)]*\))?)\s+--\s+Time elapsed:.*<<< (?:FAILURE|ERROR)!$/,
  ],
];

function readFailureLine(scan: FailureScan, line: string): void {
  for (const [runner, pattern] of FAILURE_LINES) {
    const match = pattern.exec(line);
    if (match?.[1] && match[2]) {
      addFailure(scan, runner, match[1], match[2]);
      return;
    }
  }
  if (readContextFailure(scan, line)) return;
  readFailureSummary(scan, line);
}

function readContextFailure(scan: FailureScan, line: string): boolean {
  const jest = /^FAIL\s+([^\s]+\.(?:[cm]?[jt]sx?))(?:\s+\([\d.]+\s*s\))?$/.exec(line);
  if (jest?.[1]) {
    finishJest(scan);
    scan.jestFile = jest[1];
    return true;
  }
  const name = /^●\s+(.+)$/.exec(line);
  if (name?.[1] && scan.jestFile !== null) {
    addFailure(scan, "jest", scan.jestFile, name[1]);
    scan.jestCases++;
    return true;
  }
  const karma =
    /^((?:Chrome(?: Headless)?|Firefox|Safari|Edge|WebKit)\s+.+?\))\s+(.+?)\s+FAILED$/.exec(line);
  if (karma?.[1] && karma[2]) {
    if (scan.karmaCase !== null) scan.unreadable.push(scan.karmaCase);
    scan.karmaBrowser = karma[1];
    scan.karmaCase = karma[2];
    return true;
  }
  if (scan.karmaCase !== null) {
    const location = /(?:\(|\s)((?:src|tests)\/[^\s():]+\.[cm]?[jt]sx?):\d+:\d+/.exec(line);
    if (location?.[1]) {
      addFailure(scan, "karma", location[1], scan.karmaCase);
      scan.karmaCase = null;
      return true;
    }
  }
  return false;
}

function readFailureSummary(scan: FailureScan, line: string): void {
  const progress = /^(.+?):\s*Executed \d+ of \d+.*?\(([1-9]\d*) FAILED\)/.exec(line);
  if (progress?.[1]) {
    requireCount(scan, `karma:${progress[1]}`, Number(progress[2]), line, true);
    return;
  }
  const suites = /^(Test Suites:|Test Files)\s+([1-9]\d*) failed\b/.exec(line);
  if (suites) {
    requireCount(
      scan,
      `${suites[1] === "Test Files" ? "vitest" : "jest"}:files`,
      Number(suites[2]),
      line,
      false,
    );
    return;
  }
  const count = failureCount(line);
  if (count !== null) {
    // Surefire deliberately repeats class and aggregate summaries. Other catalog
    // runners emit one test-count summary per run: a second without a boundary
    // cannot borrow the first run's identities.
    requireCount(scan, count[0], count[1], line, !isPrimarySummary(count[0], line));
    return;
  }
  // An unknown failure diagnostic never borrows an identity from a known case.
  if (
    /^(?:FAIL(?:ED)?(?:\s|:)|FAILURES!|ERROR(?:\s|:)|Tests? failed\b|FAILURE:|> There were failing tests)/.test(
      line,
    )
  ) {
    scan.unreadable.push(line);
  }
}

function requireCount(
  scan: FailureScan,
  key: string,
  count: number,
  line: string,
  repeatable: boolean,
): void {
  if (!repeatable) {
    if (scan.summaries.has(key) && count > 0) scan.unreadable.push(line);
    scan.summaries.add(key);
  }
  if (count > (scan.expected.get(key)?.count ?? 0)) scan.expected.set(key, { count, line });
}

function isPrimarySummary(runner: TestRunner | "unknown", line: string): boolean {
  return (
    runner !== "maven-surefire" &&
    (runner === "pytest" || /^(?:Tests:?\s+|TOTAL:|\d+ tests completed,)/.test(line))
  );
}

function failureCount(line: string): [TestRunner | "unknown", number] | null {
  const junit =
    /^(?:\[(?:INFO|ERROR|WARNING)\]\s*)?Tests run:\s*\d+,\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/.exec(
      line,
    );
  if (junit) return ["maven-surefire", Number(junit[1]) + Number(junit[2])];
  const summaries: [TestRunner, RegExp][] = [
    ["vitest", /^Tests\s+(\d+) failed\b/],
    ["jest", /^Tests:\s+(\d+) failed\b/],
    ["karma", /^TOTAL:\s+(\d+) FAILED\b/],
    ["gradle", /^\d+ tests completed,\s*(\d+) failed\b/],
  ];
  for (const [runner, pattern] of summaries) {
    const match = pattern.exec(line);
    if (match) return [runner, Number(match[1])];
  }
  if (
    /^(?:=+\s*|\d+ (?:passed|failed|error|skipped))/.test(line) &&
    /\bin [\d.]+s(?:\s*=+)?$/.test(line)
  ) {
    return [
      "pytest",
      [...line.matchAll(/(\d+) (?:failed|errors?)\b/g)].reduce((sum, m) => sum + Number(m[1]), 0),
    ];
  }
  if (/^(?:FAILURE: Build failed with an exception\.|> There were failing tests)/.test(line))
    return ["gradle", 1];
  const unknown = /^(\d+) (?:tests? )?(?:failed|failing|failures?|errors?)\b/.exec(line);
  if (unknown) return ["unknown", Number(unknown[1])];
  return null;
}
