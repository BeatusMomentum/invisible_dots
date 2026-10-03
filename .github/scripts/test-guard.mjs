// Reads a test run's report and refuses a run that only looks green.
//
// vitest and `go test` exit 0 when nothing failed, which is also what they do
// when a whole file stopped being collected, when a suite skipped itself
// because a tool or a database was missing, or when a build constraint left
// a file out. Each of those reads exactly like a pass. So the count of tests
// that really ran is checked against a floor, and every skipped test must be
// one this host is known to skip.
//
//   node .github/scripts/test-guard.mjs <report> --suite <name> [--floors <file>]
//
// <report>  vitest's JSON report (--reporter=json --outputFile) for the
//           vitest suites, the output of `go test -json` for "go".
// --suite   the entry of the floors file to apply: vitest, postgres or go.
// --floors  default .github/test-floors.json. The entry is chosen by the
//           host this runs on (linux, win32), so CI and the pre-push hook
//           read the same numbers from the same file.
//
// A floor entry: min_passed, allow_skipped (a regex over a skipped test's
// full name, "" for none), and require ({ regex: n }: at least n passed
// tests whose full name matches, e.g. the suites parametrized on pg).
//
// Raise the floors when tests are added; lowering one is a decision to write
// down in the commit that does it.
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`test-guard: REFUSED - ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const reportPath = args.shift();
const usage = "usage: test-guard.mjs <report> --suite <vitest|postgres|go> [--floors <file>]";
if (!reportPath) fail(usage);
let suite;
let floorsPath = ".github/test-floors.json";
while (args.length > 0) {
  const flag = args.shift();
  const value = args.shift();
  if (value === undefined) fail(`${flag} needs a value`);
  if (flag === "--suite") suite = value;
  else if (flag === "--floors") floorsPath = value;
  else fail(`unknown option ${flag}; ${usage}`);
}
if (!suite) fail(usage);

let floors;
try {
  floors = JSON.parse(readFileSync(floorsPath, "utf8"));
} catch (error) {
  fail(`cannot read ${floorsPath}: ${error.message}`);
}
// The host this runs on picks the floor, because each host runs a different
// set (a test that needs a real Windows PowerShell, a Go file built only on
// unix). This script is a check of the test run, not product code.
const host = process.platform;
const floor = floors[suite]?.[host];
if (!floor) fail(`${floorsPath} has no "${suite}" floor for ${host}`);
const minPassed = floor.min_passed;
if (!Number.isInteger(minPassed) || minPassed <= 0) fail(`${floorsPath} ${suite}.${host}.min_passed must be a positive integer`);
const allowSkipped = floor.allow_skipped ? new RegExp(floor.allow_skipped) : undefined;
const required = Object.entries(floor.require ?? {}).map(([pattern, min]) => ({ pattern: new RegExp(pattern), min }));

let text;
try {
  text = readFileSync(reportPath, "utf8");
} catch (error) {
  fail(`cannot read ${reportPath}: ${error.message}`);
}

/** Every test of the run as { fullName, status, file }, status passed | failed | skipped. */
function vitestTests() {
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    fail(`${reportPath} is not vitest's JSON report (${error.message}); run vitest with --reporter=json --outputFile`);
  }
  const tests = report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      fullName: test.fullName,
      status: test.status === "passed" || test.status === "failed" ? test.status : "skipped",
      file: file.name,
    })),
  );
  // A file that failed to load has no failed test of its own, only an error.
  const broken = report.testResults
    .filter((file) => file.status === "failed" && file.assertionResults.every((test) => test.status !== "failed"))
    .map((file) => `${file.name} failed outside any test: ${(file.message ?? "").split("\n")[0]}`);
  return { tests, broken, files: report.testResults.length };
}

function goTests() {
  const tests = [];
  const broken = [];
  const packages = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.Package) packages.add(event.Package);
    const action = event.Action;
    if (action !== "pass" && action !== "fail" && action !== "skip") continue;
    const pkg = event.Package.split("/").pop();
    // A package without a test name: its own result, which fails on a build error.
    if (!event.Test) {
      if (action === "fail") broken.push(`package ${event.Package} failed (a build error or a panic outside a test)`);
      continue;
    }
    tests.push({ fullName: `${pkg} ${event.Test}`, status: action === "pass" ? "passed" : action === "fail" ? "failed" : "skipped", file: event.Package });
  }
  if (packages.size === 0) fail(`${reportPath} holds no go test -json events`);
  return { tests, broken, files: packages.size };
}

const { tests, broken, files } = suite === "go" ? goTests() : vitestTests();
const passed = tests.filter((test) => test.status === "passed");
const failed = tests.filter((test) => test.status === "failed");
const skipped = tests.filter((test) => test.status === "skipped");

console.log(`test-guard: ${suite} on ${host}: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped, in ${files} files`);

const problems = [...broken];
if (failed.length > 0) problems.push(`${failed.length} failed tests`);
if (passed.length < minPassed) problems.push(`only ${passed.length} tests passed, the floor is ${minPassed}`);
for (const test of skipped) {
  if (!allowSkipped || !allowSkipped.test(test.fullName)) problems.push(`skipped without being allowed to: ${test.fullName} (${test.file})`);
}
for (const { pattern, min } of required) {
  const count = passed.filter((test) => pattern.test(test.fullName)).length;
  console.log(`test-guard: ${count} passed tests match ${pattern}`);
  if (count < min) problems.push(`${count} passed tests match ${pattern}, at least ${min} must`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`test-guard: ${problem}`);
  fail(`${problems.length} problem(s) with this run`);
}
console.log("test-guard: ok");
