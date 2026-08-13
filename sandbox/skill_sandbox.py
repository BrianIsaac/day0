"""Day0's local skill-verification sandbox.

A skill the agent authors is not a verified skill until something has run it.
Daytona does that when its key is present; this service does it when no third
party is involved, so the account-free route can finish the skill loop instead
of stopping one step short of a callable skill.

The container this runs in *is* the boundary, so the shape of it matters more
than the code:

  - It has no network. `network_mode: none` in docker-compose.yml, which is why
    the backend reaches this over a unix socket on a shared volume rather than
    over TCP. Model-authored Python here cannot reach the Convex backend, the
    model server, this machine, or the internet - there is no interface to
    reach them through. The authoring prompt tells the model the smoke test
    runs "with no third-party packages" and must mock external calls, so
    nothing legitimate wants a network.
  - Its root filesystem is read-only and the working directory is a small
    tmpfs, so a smoke test cannot leave anything behind for the next one.
  - Nothing runs as root once this process has bound its socket. Startup is
    root - the socket lives on a volume Docker owns - and privileges are
    dropped for good before the first request is served, so every smoke test
    runs as `nobody`.
  - Memory, process count, CPU time, file size and wall-clock are all capped.
    The wall-clock cap is 60 seconds, which is what the Daytona path allows.

What it is not is a defence against someone who is trying. A container escape
is a container escape, and the smoke test shares a uid with this supervisor, so
code that wanted to could stop it serving (Docker restarts it). It is an
isolation boundary for verification - the same claim the project makes about
Daytona - and not a sandbox to run hostile code in.

The protocol is two endpoints of JSON over HTTP/1.0:

    GET  /health  -> {"ok": true, "python": "3.12.x"}
    POST /verify  -> {"skillName", "skillBody", "smokeTest"}
                  <- {"runId", "exitCode", "stdout", "stderr", "timedOut", ...}

Whether a run counts as verification is decided by the caller, not here: this
reports what happened and `src/lib/skill-sandbox.ts` applies the same rule to
both backends.

    python3 skill_sandbox.py            serve
    python3 skill_sandbox.py --health   probe the socket (the container's healthcheck)
"""

from __future__ import annotations

import json
import os
import pwd
import resource
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import time
import uuid
from http.server import BaseHTTPRequestHandler
from typing import Any, NoReturn

SOCKET_PATH = os.environ.get("SANDBOX_SOCKET", "/run/day0-sandbox/skill-sandbox.sock")
WORK_ROOT = os.environ.get("SANDBOX_WORK_DIR", "/run/sandbox-work")
RUN_AS = os.environ.get("SANDBOX_USER", "nobody")

#: Matches the timeout the Daytona path passes to `executeCommand`.
TIMEOUT_SECONDS = float(os.environ.get("SANDBOX_TIMEOUT_SECONDS", "60"))

#: Per-stream cap on what is read back. A smoke test is asked to print one
#: success line; anything past this is noise the caller cannot use anyway.
MAX_OUTPUT_BYTES = 64 * 1024

#: A SKILL.md and a smoke test, with room to spare. Refused rather than
#: buffered, so a wrong caller cannot make this process the memory problem.
MAX_REQUEST_BYTES = 2 * 1024 * 1024

CHILD_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024
CHILD_MAX_FILE_BYTES = 8 * 1024 * 1024
CHILD_MAX_PROCESSES = 32


def log(message: str) -> None:
    """Write a line to the container log.

    Args:
        message: The line to write, without a trailing newline.
    """
    print(f"skill-sandbox: {message}", file=sys.stderr, flush=True)


def _child_limits() -> None:
    """Cap what one smoke test may consume, in the child, before it execs.

    The container limits bound every run together; these bound a single one, so
    that a smoke test which loops cannot starve the next request in the way it
    would if only the container-wide caps applied. `RLIMIT_FSIZE` is the one
    doing quiet work: stdout and stderr are files on the tmpfs, so it is also
    the cap on how much a runaway `print` can produce.
    """
    cpu = int(TIMEOUT_SECONDS)
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
    resource.setrlimit(resource.RLIMIT_AS, (CHILD_ADDRESS_SPACE_BYTES, CHILD_ADDRESS_SPACE_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (CHILD_MAX_FILE_BYTES, CHILD_MAX_FILE_BYTES))
    resource.setrlimit(resource.RLIMIT_NPROC, (CHILD_MAX_PROCESSES, CHILD_MAX_PROCESSES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _read_capped(path: str) -> tuple[str, bool]:
    """Read at most `MAX_OUTPUT_BYTES` from a file.

    Args:
        path: File to read.

    Returns:
        The decoded text and whether it was truncated.
    """
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_OUTPUT_BYTES + 1)
    except OSError:
        return "", False
    if len(data) > MAX_OUTPUT_BYTES:
        return data[:MAX_OUTPUT_BYTES].decode("utf-8", "replace"), True
    return data.decode("utf-8", "replace"), False


def run_smoke_test(skill_body: str, smoke_test: str) -> dict[str, Any]:
    """Run one smoke test in a fresh directory and report what happened.

    The skill body is written alongside the test because the Daytona path does
    the same, and a smoke test that reads it should behave identically here.

    Args:
        skill_body: The authored SKILL.md, written as `SKILL.md`.
        smoke_test: The Python smoke test, written and run as `smoke.py`.

    Returns:
        A dict with `runId`, `exitCode`, `stdout`, `stderr`, `timedOut`,
        `truncated` and `durationMs`.
    """
    run_id = uuid.uuid4().hex[:12]
    run_dir = tempfile.mkdtemp(prefix=f"{run_id}-", dir=WORK_ROOT)
    stdout_path = os.path.join(run_dir, ".stdout")
    stderr_path = os.path.join(run_dir, ".stderr")
    started = time.monotonic()
    timed_out = False
    try:
        with open(os.path.join(run_dir, "SKILL.md"), "w", encoding="utf-8") as handle:
            handle.write(skill_body)
        with open(os.path.join(run_dir, "smoke.py"), "w", encoding="utf-8") as handle:
            handle.write(smoke_test)

        child_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": run_dir,
            "TMPDIR": run_dir,
            "LANG": "C.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
        }
        with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
            # Its own session, so the timeout below kills anything the smoke
            # test spawned rather than orphaning it into the next run.
            child = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                [sys.executable, "smoke.py"],
                cwd=run_dir,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                preexec_fn=_child_limits,
                start_new_session=True,
            )
            try:
                exit_code = child.wait(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(child.pid, 9)
                exit_code = child.wait()

        stdout, out_truncated = _read_capped(stdout_path)
        stderr, err_truncated = _read_capped(stderr_path)
        return {
            "runId": run_id,
            "exitCode": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "timedOut": timed_out,
            "truncated": out_truncated or err_truncated,
            "durationMs": round((time.monotonic() - started) * 1000),
        }
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


class UnixHTTPServer(socketserver.UnixStreamServer):
    """An HTTP server on a unix socket, served one request at a time.

    Serial by design rather than by omission: a verification run holds a
    subprocess for up to the timeout, and two at once would share the tmpfs and
    the container's memory cap with each other. The queue is bounded by that
    same timeout, and the loop only ever authors one skill at a time.
    """

    allow_reuse_address = False
    request_queue_size = 8

    def server_bind(self) -> None:
        super().server_bind()
        # BaseHTTPRequestHandler reaches for both when it builds a response.
        self.server_name = "skill-sandbox"
        self.server_port = 0


class Handler(BaseHTTPRequestHandler):
    """The two endpoints the Convex backend calls."""

    server_version = "day0-skill-sandbox/1"
    sys_version = ""

    def address_string(self) -> str:
        # A unix peer has no address, and the inherited implementation indexes
        # into the empty one.
        return "local"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - base class name
        # Silence per-request access logging; the verify handler logs the one
        # line that carries information.
        return

    def _respond(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - base class name
        if self.path != "/health":
            self._respond(404, {"error": "not found"})
            return
        self._respond(200, {"ok": True, "python": sys.version.split()[0]})

    def do_POST(self) -> None:  # noqa: N802 - base class name
        if self.path != "/verify":
            self._respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._respond(400, {"error": "Content-Length is not a number"})
            return
        if length <= 0:
            self._respond(400, {"error": "empty request body"})
            return
        if length > MAX_REQUEST_BYTES:
            self._respond(413, {"error": f"request body exceeds {MAX_REQUEST_BYTES} bytes"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            self._respond(400, {"error": f"request body is not JSON: {err}"})
            return

        smoke_test = payload.get("smokeTest")
        if not isinstance(smoke_test, str) or not smoke_test.strip():
            self._respond(400, {"error": "smokeTest is required"})
            return
        skill_body = payload.get("skillBody")
        if not isinstance(skill_body, str):
            skill_body = ""
        name = payload.get("skillName") if isinstance(payload.get("skillName"), str) else "(unnamed)"

        result = run_smoke_test(skill_body, smoke_test)
        log(
            f"{name} run {result['runId']} exit={result['exitCode']} "
            f"stdout={len(result['stdout'])}B stderr={len(result['stderr'])}B "
            f"{'timed out ' if result['timedOut'] else ''}in {result['durationMs']}ms"
        )
        self._respond(200, result)


def probe_health() -> int:
    """Ask the running server whether it is serving.

    Used as the container healthcheck, which is also how `pnpm check:setup`
    tells a live sandbox from a container that exited.

    Returns:
        A process exit code: 0 when the server answered, 1 otherwise.
    """
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(SOCKET_PATH)
            client.sendall(b"GET /health HTTP/1.0\r\nHost: sandbox\r\n\r\n")
            response = client.recv(4096)
    except OSError as err:
        print(f"skill-sandbox: not serving on {SOCKET_PATH}: {err}", file=sys.stderr)
        return 1
    return 0 if b" 200 " in response.split(b"\r\n", 1)[0] else 1


def drop_privileges() -> None:
    """Become `nobody` permanently, once the socket exists.

    Everything after this - including every smoke test, which inherits it -
    runs unprivileged. The socket and the working directory are prepared first
    precisely so that nothing later needs the privilege back.
    """
    if os.geteuid() != 0:
        return
    account = pwd.getpwnam(RUN_AS)
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if os.geteuid() == 0:
        raise RuntimeError("still root after dropping privileges")


def check_workspace() -> None:
    """Fail loudly, and early, if smoke tests would have nowhere to run.

    docker-compose.yml mounts the working directory as a tmpfs already owned by
    the user this process has dropped to, so that the drop needs no capability
    beyond changing user. Checking it here rather than on the first request is
    what keeps a misconfigured mount from looking like a skill that failed
    verification.

    Raises:
        RuntimeError: If the working directory is missing or not writable.
    """
    if not os.path.isdir(WORK_ROOT):
        raise RuntimeError(f"working directory {WORK_ROOT} does not exist")
    if not os.access(WORK_ROOT, os.W_OK | os.X_OK):
        raise RuntimeError(
            f"working directory {WORK_ROOT} is not writable by "
            f"{pwd.getpwuid(os.geteuid()).pw_name} - check its tmpfs uid/gid in docker-compose.yml"
        )


def bind_socket() -> UnixHTTPServer:
    """Bind the listening socket, replacing one left behind by a hard stop.

    Returns:
        The bound server.
    """
    directory = os.path.dirname(SOCKET_PATH)
    os.makedirs(directory, exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    server = UnixHTTPServer(SOCKET_PATH, Handler)
    # The Convex backend container dials this as whichever user it runs as, and
    # the two containers share nothing but the volume this socket sits on.
    os.chmod(SOCKET_PATH, 0o666)
    return server


def main() -> NoReturn:
    """Serve until stopped."""
    if "--health" in sys.argv[1:]:
        sys.exit(probe_health())

    server = bind_socket()
    drop_privileges()
    check_workspace()
    log(
        f"serving on {SOCKET_PATH} as {pwd.getpwuid(os.geteuid()).pw_name}, "
        f"python {sys.version.split()[0]}, {TIMEOUT_SECONDS:g}s per smoke test"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
