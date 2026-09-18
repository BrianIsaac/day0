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
 * The verdict is what `run()` returned, read against the skill it stands for
 * (`SmokeHarnessContract`): a dict with an `actions` list for every case and
 * actions from at least two of them; every action one of the two verbs that
 * reach a real surface, on a surface the author was shown as connected, with
 * a tool that surface allows and SKILL.md names; at least one action on the
 * skill's target surface; each case's action arguments carrying a value that
 * case supplied, and every input the executor binds from the candidate row
 * (the record, the reply target) when the case supplies it; and action
 * arguments, not merely outputs, that differ between cases. A mimic that
 * passes says nothing about a provider's answer, but one that fails any of
 * these describes a write the gate would refuse or aim at a constant.
 *
 * One line per case goes to stdout, so the shared verdict rule in
 * `src/lib/skill-sandbox.ts` reads the harness's lines; a failure is one
 * `smoke harness:` line on stderr with the author's frames of the traceback,
 * which is what the retry is told.
 *
 * Both backends write this as smoke.py and run `python smoke.py`, so neither
 * changes. Mock mode never uses it: the hosted demo and the frozen evaluation
 * run the author's program as written, as they were recorded.
 *
 * Kept free of model clients and Convex imports.
 */

import type { SurfacePath, SurfaceRecord } from '../surfaces/types';
import { verdictFor as surfaceVerdictFor } from '../surfaces/verdict';
import { CANDIDATE_BOUND_TARGET_INPUTS } from './skill-inputs';

/** Where the author's source, base64-encoded, is written into the harness. */
const AUTHORED_SOURCE_SLOT = '__DAY0_AUTHORED_SOURCE__';

/** Where the contract, base64-encoded JSON, is written into the harness. */
const CONTRACT_SLOT = '__DAY0_SMOKE_CONTRACT__';

/** One surface the author was shown as connected, as the harness reads it. */
export interface SmokeHarnessSurface {
  slug: string;
  path?: SurfacePath;
  allowedTools: string[];
}

/**
 * What the harness holds `run()`'s actions against: the skill the smoke test
 * stands for and the surfaces the author was told it may target.
 */
export interface SmokeHarnessContract {
  /** SKILL.md as it will be stored; an action's tool must be named in it. */
  body: string;
  /** The surface the skill was approved for; some case must act on it. */
  targetSurface?: string;
  /** The connected surfaces, the same list the author prompt shows. */
  surfaces: SmokeHarnessSurface[];
  /**
   * Inputs the executor binds by value from the candidate row. They name
   * where a write lands, so a case that supplies one must carry it into an
   * action argument.
   */
  boundInputs: string[];
}

/**
 * The contract for one authored skill.
 *
 * Args:
 *   body: SKILL.md as it will be stored.
 *   surfaces: The agent's surfaces.
 *   targetSurface: The surface slug the skill was approved for, if any.
 *   now: Clock for the connection verdict, as the author prompt read it.
 *
 * Returns:
 *   The body, the target, and the surfaces `surfaceInstructions` lists as
 *   connected with their allowlists.
 */
export function smokeHarnessContract(
  body: string,
  surfaces: readonly SurfaceRecord[],
  targetSurface: string | undefined,
  now: number,
): SmokeHarnessContract {
  return {
    body,
    ...(targetSurface ? { targetSurface } : {}),
    surfaces: surfaces
      .filter((surface): boolean => surfaceVerdictFor(surface, now) === 'connected')
      .map(
        (surface): SmokeHarnessSurface => ({
          slug: surface.slug,
          ...(surface.path ? { path: surface.path } : {}),
          allowedTools: [...(surface.toolAllowlist ?? [])],
        }),
      ),
    boundInputs: [...CANDIDATE_BOUND_TARGET_INPUTS],
  };
}

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
import linecache
import re
import sys
import traceback

AUTHORED_FILE = "authored_smoke.py"
AUTHORED = base64.b64decode("__DAY0_AUTHORED_SOURCE__").decode("utf-8")
CONTRACT = json.loads(base64.b64decode("__DAY0_SMOKE_CONTRACT__").decode("utf-8"))
# The author's file exists only in this string. Registered here, a traceback
# prints the line under each of its frames, which is what a failed first
# attempt is diagnosed from.
linecache.cache[AUTHORED_FILE] = (len(AUTHORED), None, AUTHORED.splitlines(True), AUTHORED_FILE)
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
REAL_VERBS = ("mcp.call", "http.request")
VERB_PATHS = {"mcp.call": ("mcp", "browser-driven"), "http.request": ("documented-api",)}
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


def action_parts(action, case_index, action_index):
    """The verb and arguments of one action, in the executor's shape or the flat one authors also write."""
    at = f"case {case_index} action {action_index}"
    if not isinstance(action, dict):
        fail(f"{at} is {type(action).__name__}; every action is a dict with a verb and its arguments")
    top = action.get("tool")
    verb = top if top in REAL_VERBS else action.get("action") or action.get("type")
    if verb not in REAL_VERBS:
        shown = verb or top or "no verb"
        fail(
            f"{at} uses {shown}; only mcp.call and http.request reach a real surface, "
            "and any other verb is refused at execution"
        )
    if isinstance(action.get("args"), dict):
        return verb, action["args"]
    return verb, {key: value for key, value in action.items() if key not in ("action", "type") and value != verb}


def names_operation(operation):
    """Whether SKILL.md names an operation as a whole word."""
    pattern = r"(?<![A-Za-z0-9_.-])" + re.escape(operation) + r"(?![A-Za-z0-9_-]|\.[A-Za-z0-9])"
    return re.search(pattern, CONTRACT["body"]) is not None


def check_action(action, case_index, action_index):
    """Refuse a verb, surface or tool the skill could not use at execution or does not name."""
    at = f"case {case_index} action {action_index}"
    verb, args = action_parts(action, case_index, action_index)
    slug = args.get("surface")
    surface = next((entry for entry in CONTRACT["surfaces"] if entry["slug"] == slug), None)
    if surface is None:
        listed = ", ".join(entry["slug"] for entry in CONTRACT["surfaces"]) or "none"
        fail(f"{at} targets surface {slug!r}, which is not a connected surface (connected: {listed})")
    if surface.get("path") not in VERB_PATHS[verb]:
        fail(f"{at} uses {verb} on {slug}, whose path is {surface.get('path') or 'unknown'}")
    if verb == "mcp.call":
        operation = args.get("tool")
    else:
        operation = re.split(r"[?#]", str(args.get("path") or ""), maxsplit=1)[0].strip("/")
    if not isinstance(operation, str) or not operation:
        fail(f"{at} names no tool for {verb} on {slug}")
    if operation not in surface["allowedTools"]:
        fail(f"{at} uses {operation}, which is not in the allowlist of {slug}")
    if not names_operation(operation):
        fail(f"{at} uses {operation}, which SKILL.md never names; a skill emits only the tools its procedure declares")
    return verb, args, operation


def leaves(value):
    """Every scalar inside a value, reading a string that holds JSON as the JSON it holds."""
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in leaves(item)]
    if isinstance(value, (list, tuple)):
        return [leaf for item in value for leaf in leaves(item)]
    if isinstance(value, str):
        text = value.strip()
        if text[:1] in ("{", "["):
            try:
                return leaves(json.loads(text))
            except ValueError:
                pass
        return [value]
    if isinstance(value, bool) or value is None:
        return []
    return [str(value)]


def supplied(inputs):
    """The scalar values a case supplies that an argument could carry."""
    return [leaf for leaf in leaves(inputs) if len(leaf.strip()) >= 2]


def carries(arguments, value):
    """Whether any argument leaf contains a supplied value."""
    return any(value in leaf for leaf in leaves(arguments))


def input_value(inputs, name):
    """A case's value for a declared input, whichever of hyphens or underscores its key uses."""
    for key, value in inputs.items():
        if str(key).replace("_", "-").strip("<>") == name:
            return value
    return None


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
    checked = []
    for index, (inputs, output) in enumerate(calls, 1):
        if not isinstance(output, dict):
            kind = type(output).__name__
            fail(f"run() returned {kind} for case {index}; it must return a dict with an actions list")
        if not isinstance(output.get("actions"), (list, tuple)):
            fail(
                f"run() returned no actions list for case {index}; "
                "the dict it returns carries what the skill emits under actions"
            )
        parts = [check_action(action, index, number) for number, action in enumerate(output["actions"], 1)]
        checked.append((index, inputs if isinstance(inputs, dict) else {}, output, parts))
    emitting = [entry for entry in checked if entry[3]]
    if len(emitting) < MIN_CASES:
        fail(
            f"run() emitted actions for {len(emitting)} of {len(checked)} cases; "
            f"{MIN_CASES} representative inputs must each make the skill emit an action"
        )
    for index, inputs, _, parts in emitting:
        arguments = [args for _, args, _ in parts]
        if supplied(inputs) and not any(carries(arguments, value) for value in supplied(inputs)):
            fail(
                f"no action argument in case {index} carries a value that case supplied; "
                "a write that ignores its inputs is hard-coded"
            )
        for name in CONTRACT["boundInputs"]:
            value = input_value(inputs, name)
            if value is None or isinstance(value, bool) or not supplied({name: value}):
                continue
            if not all(carries(arguments, leaf) for leaf in supplied({name: value})):
                fail(
                    f"case {index} supplies <{name}> but no action argument carries it; the executor binds "
                    f"<{name}> from the candidate, so a write that ignores it is aimed at a constant"
                )
    if len({canonical([args for _, args, _ in parts]) for _, _, _, parts in emitting}) < MIN_CASES:
        fail("run() emitted the same action arguments for every case, so its writes do not follow its inputs")
    target = CONTRACT.get("targetSurface")
    if target and not any(args.get("surface") == target for _, _, _, parts in emitting for _, args, _ in parts):
        fail(f"no case emits an action on {target}, the surface this skill was approved for")
    for index, inputs, output, parts in checked:
        plural = "" if len(parts) == 1 else "s"
        labels = ", ".join(f"{verb} {operation}" for verb, _, operation in parts) or "none"
        line = f"case {index}: run() emitted {len(parts)} action{plural} ({labels})"
        values = carried(inputs, output)
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
 *   contract: The skill and surfaces the actions are held against.
 *
 * Returns:
 *   The harness with the author's source and the contract embedded. Both
 *   travel as base64, so no character in either can end the string it sits in.
 */
export function harnessedSmokeTest(authored: string, contract: SmokeHarnessContract): string {
  const encoded = Buffer.from(authored, 'utf8').toString('base64');
  const encodedContract = Buffer.from(JSON.stringify(contract), 'utf8').toString('base64');
  return SMOKE_HARNESS.replace(AUTHORED_SOURCE_SLOT, (): string => encoded).replace(
    CONTRACT_SLOT,
    (): string => encodedContract,
  );
}
