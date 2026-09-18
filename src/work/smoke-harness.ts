/**
 * The program the sandbox runs for an authored skill in real mode.
 *
 * The author writes smoke.py: a `run(inputs: dict) -> dict` in the skill's
 * shape and `CASES`, its representative input dicts. It never decides its own
 * verdict. In rehearsal 1 an author's smoke test asserted that the thread
 * reply its own `run()` had built did not name the ticket it was built for,
 * and the sandbox refused a sound skill on the author's word. So in real mode
 * the sandbox is handed this harness with the author's source embedded, and
 * the harness is the test:
 *
 *   - With `CASES` declared, only the author's imports, definitions and
 *     assignments run. The harness calls `run()` once per case; the author's
 *     own calls, checks and prints are never executed.
 *   - Without `CASES` (an author that wrote the older form, or a draft kept
 *     from before this contract), the author's program runs as written with
 *     every `run()` call recorded, and the calls it made are the cases.
 *   - Either way the author's code is compiled with `optimize=1`, so no
 *     `assert` statement it wrote exists at run time.
 *
 * The verdict is the shape of what `run()` returned: a dict with an `actions`
 * list for every case, at least one action across them, and outputs that
 * differ between cases. One line per case goes to stdout, so the shared
 * verdict rule in `src/lib/skill-sandbox.ts` reads the harness's lines; a
 * failure is one `smoke harness:` line on stderr with the author's frames of
 * the traceback, which is what the retry is told.
 *
 * Both backends write this as smoke.py and run `python smoke.py`, so neither
 * changes. Mock mode never uses it: the hosted demo and the frozen evaluation
 * run the author's program as written, as they were recorded.
 *
 * Kept free of model clients and Convex imports.
 */

/** Where the author's source, base64-encoded, is written into the harness. */
const AUTHORED_SOURCE_SLOT = '__DAY0_AUTHORED_SOURCE__';

/** The harness, Python 3.12, with the slot for the author's source. */
export const SMOKE_HARNESS = String.raw`
# Day0 smoke harness: the program the sandbox runs for an authored skill.
#
# The smoke test the author wrote is embedded below and never runs as its own
# program when it declares CASES: this harness loads its definitions, calls
# run() once per case and decides the verdict itself. A smoke test without
# CASES runs as written with run() recorded. Either way no assert statement
# the author wrote is compiled, so no assertion about its own output can fail
# the check; the verdict is the shape of what run() returned.
import ast
import asyncio
import base64
import copy
import inspect
import json
import sys
import traceback

AUTHORED_FILE = "authored_smoke.py"
AUTHORED = base64.b64decode("__DAY0_AUTHORED_SOURCE__").decode("utf-8")
MIN_CASES = 2
DEFINITIONS = (
    ast.Import,
    ast.ImportFrom,
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.Assign,
    ast.AnnAssign,
) + ((ast.TypeAlias,) if hasattr(ast, "TypeAlias") else ())
VERBS = (
    "mcp.call",
    "http.request",
    "slack.postMessage",
    "ticket.update",
    "spreadsheet.appendRow",
    "twitter.reply",
)
SECRET_WORDS = ("secret", "token", "password", "authorization", "credential", "key")
MAX_CARRIED = 3
MAX_CARRIED_CHARS = 40


def fail(message, detail=""):
    """Report why the check did not pass and stop with exit status 1."""
    print("smoke harness: " + message, file=sys.stderr)
    if detail:
        print(detail, file=sys.stderr)
    sys.exit(1)


def note(message):
    """Say on stderr what the harness did, for the verification log."""
    print("smoke harness: " + message, file=sys.stderr)


def authored_frames(error):
    """The frames of an error's traceback that are in the author's file."""
    return [f for f in traceback.extract_tb(error.__traceback__) if f.filename == AUTHORED_FILE]


def authored_traceback(error):
    """The traceback of an error, keeping only the frames in the author's file."""
    frames = traceback.format_list(authored_frames(error))
    return "".join(frames + traceback.format_exception_only(type(error), error)).rstrip()


def where(error):
    """The line of the author's file an error was raised from."""
    frames = authored_frames(error)
    return f"line {frames[-1].lineno}" if frames else "its top level"


def calls_run(statement):
    """Whether evaluating a statement would call run() itself."""
    return any(
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "run"
        for node in ast.walk(statement)
    )


def compiled(statements):
    """Compile statements from the author's file with assert statements left out."""
    return compile(ast.Module(body=statements, type_ignores=[]), AUTHORED_FILE, "exec", optimize=1)


def settle(output):
    """The value of a run() call, awaited when run() is a coroutine function."""
    return asyncio.run(output) if inspect.iscoroutine(output) else output


def load_definitions(tree):
    """Run the author's imports, definitions and assignments, and nothing else."""
    namespace = {"__name__": "authored_smoke", "__file__": AUTHORED_FILE}
    for statement in tree.body:
        if not isinstance(statement, DEFINITIONS):
            continue
        if isinstance(statement, (ast.Assign, ast.AnnAssign)) and calls_run(statement):
            continue
        try:
            exec(compiled([statement]), namespace)
        except Exception as error:
            note(f"line {statement.lineno} of the smoke test was skipped: {type(error).__name__}: {error}")
    return namespace


def declared_cases(namespace):
    """The author's CASES when it is a list of at least two input dicts."""
    cases = namespace.get("CASES")
    if not isinstance(cases, (list, tuple)) or len(cases) < MIN_CASES:
        return None
    return list(cases) if all(isinstance(case, dict) for case in cases) else None


def drive(run, cases):
    """Call run() once per case, stopping at the first case it cannot run."""
    calls = []
    for index, case in enumerate(cases, 1):
        try:
            output = settle(run(copy.deepcopy(case)))
        except BaseException as error:
            fail(f"run() raised {type(error).__name__} on case {index}", authored_traceback(error))
        calls.append((case, output))
    return calls


def record_program(tree):
    """Run the author's program as written, recording every run() call it makes."""
    calls = []

    def record(run):
        def recorded(*args, **kwargs):
            inputs = args[0] if args else kwargs.get("inputs")
            try:
                kept = copy.deepcopy(inputs)
            except Exception:
                kept = inputs
            entry = {"inputs": kept}
            calls.append(entry)
            try:
                output = run(*args, **kwargs)
            except BaseException as error:
                entry["error"] = error
                raise
            if inspect.iscoroutine(output):

                async def awaited():
                    try:
                        entry["output"] = await output
                    except BaseException as error:
                        entry["error"] = error
                        raise
                    return entry["output"]

                return awaited()
            entry["output"] = output
            return output

        return recorded

    body = []
    for statement in tree.body:
        body.append(statement)
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name == "run":
            wrap = ast.parse("run = __day0_record__(run)").body[0]
            body.append(ast.fix_missing_locations(ast.copy_location(wrap, statement)))
    namespace = {"__name__": "__main__", "__file__": AUTHORED_FILE, "__day0_record__": record}
    ending = None
    try:
        exec(compiled(body), namespace)
    except SystemExit as error:
        if error.code not in (None, 0):
            ending = error
    except BaseException as error:
        ending = error
    return calls, ending


def canonical(value):
    """A stable text form of an output, for comparing and searching it."""
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, default=repr)
    except (TypeError, ValueError):
        return repr(value)


def action_label(action):
    """A short name for one emitted action: its verb, then the tool or path it names."""
    if not isinstance(action, dict):
        return type(action).__name__
    args = action.get("args") if isinstance(action.get("args"), dict) else {}
    names = []
    for value in (
        action.get("action"),
        action.get("type"),
        action.get("tool"),
        args.get("tool"),
        action.get("path"),
        args.get("path"),
    ):
        if isinstance(value, str) and value and value not in names:
            names.append(value)
    verbs = [name for name in names if name in VERBS]
    others = [name for name in names if name not in VERBS]
    return " ".join(verbs[:1] + others[:1] if verbs else others[:2]) or "action"


def carried(inputs, output):
    """The short input values that appear in an output, in the order they were given."""
    text = canonical(output)
    found = []
    for key, value in inputs.items():
        if any(word in str(key).lower() for word in SECRET_WORDS):
            continue
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            continue
        shown = str(value)
        if len(shown) < 2 or len(shown) > MAX_CARRIED_CHARS or "\n" in shown:
            continue
        if shown in text and shown not in found:
            found.append(shown)
    return found[:MAX_CARRIED]


def check(calls):
    """Decide the verdict from what run() returned, and print one line per call."""
    for index, (_, output) in enumerate(calls, 1):
        if not isinstance(output, dict):
            kind = type(output).__name__
            fail(f"run() returned {kind} for case {index}; it must return a dict with an actions list")
        if not isinstance(output.get("actions"), (list, tuple)):
            fail(
                f"run() returned no actions list for case {index}; "
                "the dict it returns carries what the skill emits under actions"
            )
    if not any(output["actions"] for _, output in calls):
        fail("run() emitted no actions for any case; a representative input makes the skill emit an action")
    if len({canonical(output) for _, output in calls}) < MIN_CASES:
        fail("run() returned the same output for every case, so its actions do not follow its inputs")
    for index, (inputs, output) in enumerate(calls, 1):
        actions = output["actions"]
        plural = "" if len(actions) == 1 else "s"
        labels = ", ".join(action_label(a) for a in actions) or "none"
        line = f"case {index}: run() emitted {len(actions)} action{plural} ({labels})"
        values = carried(inputs, output) if isinstance(inputs, dict) else []
        if values:
            line += "; carries " + ", ".join(values)
        print(line, flush=True)


def main():
    """Drive the author's smoke test and exit 0 only when run() has the skill's shape."""
    try:
        tree = ast.parse(AUTHORED, AUTHORED_FILE)
    except SyntaxError as error:
        fail(f"the smoke test is not valid Python: {error}")
    namespace = load_definitions(tree)
    run = namespace.get("run")
    cases = declared_cases(namespace)
    if cases is not None and callable(run):
        note(
            f"called run() on the {len(cases)} cases the smoke test declares; "
            "nothing else in it ran and its assert statements were not compiled"
        )
        check(drive(run, cases))
        return
    calls, ending = record_program(tree)
    for index, entry in enumerate(calls, 1):
        if ending is not None and entry.get("error") is ending:
            fail(
                f"run() raised {type(ending).__name__} on the smoke test's call {index}",
                authored_traceback(ending),
            )
    made = [(entry["inputs"], entry["output"]) for entry in calls if "output" in entry]
    stopped = ""
    if ending is not None:
        stopped = f"; the program stopped on its own check, {type(ending).__name__} at {where(ending)}"
    if len(made) < MIN_CASES:
        plural = "" if len(made) == 1 else "s"
        fail(
            f"the smoke test called run() on {len(made)} input dict{plural}; declare CASES, a list of two "
            "representative input dicts, and the harness calls run() on each" + stopped,
            authored_traceback(ending) if ending is not None else "",
        )
    note(
        "the smoke test declares no CASES, so its program ran as written with its assert statements "
        f"not compiled; {len(made)} run() calls recorded" + stopped
    )
    check(made)


main()
`.trimStart();

/**
 * The program to run for an authored smoke test in real mode.
 *
 * Args:
 *   authored: The author's smoke.py, already unwrapped from any fence.
 *
 * Returns:
 *   The harness with the author's source embedded. The source travels as
 *   base64, so no character in it can end the string it sits in.
 */
export function harnessedSmokeTest(authored: string): string {
  const encoded = Buffer.from(authored, 'utf8').toString('base64');
  return SMOKE_HARNESS.replace(AUTHORED_SOURCE_SLOT, (): string => encoded);
}
