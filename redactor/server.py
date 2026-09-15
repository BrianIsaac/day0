"""Day0's redaction component: a span model behind a small HTTP API.

Documentation sync, provider outcomes and the planner's grounding read hand
their text to this service and get back the spans a model reads as a secret
or as personal data. The decision of what to do with a span - store it as a
credential, replace it with a marker, or keep it because the entity policy
says a coworker's name is working material - is not made here. It is made in
`src/redaction/` on the caller's side, as data, so that this process holds no
policy and can be swapped for another model without touching a call site.

The model is `urchade/gliner_multi_pii-v1` (Apache-2.0, 289M parameters,
mDeBERTa-v3-base backbone) unless REDACTOR_MODEL says otherwise. Its snapshot
lives on a volume, fetched at first start and verified file by file against
the sha256 manifest in `models.sha256` before it is loaded: a file that does
not match is refused rather than served, and the health check says so. A
snapshot already on the volume is never fetched again, so a machine that
started once on a network starts again without one.

Chunking is done here, on line boundaries, because the model reads at most
384 tokens at a time and the caller should not need to know that. Offsets in
the reply are UTF-16 code-unit offsets, matching JavaScript string slicing.

    GET  /healthz     -> {"ok": true, "model": ..., "device": ..., "manifest": "verified"}
    POST /v1/spans    -> {"text", "labels", "threshold"}
                      <- {"spans": [{"start", "end", "label", "score"}]}

    python3 server.py            serve on REDACTOR_PORT (8000)
    python3 server.py --health   probe the running server (the container's healthcheck)
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MODEL_ID = os.environ.get("REDACTOR_MODEL", "urchade/gliner_multi_pii-v1")
PORT = int(os.environ.get("REDACTOR_PORT", "8000"))
MODELS_DIR = Path(os.environ.get("REDACTOR_MODELS_DIR", "/models"))
# The volume is the Hub cache, so the model library finds the verified files
# by repository id without a network. Set before anything imports the hub.
os.environ["HF_HUB_CACHE"] = str(MODELS_DIR)
MANIFEST = Path(os.environ.get("REDACTOR_MANIFEST", "/opt/day0/models.sha256"))
DEVICE = os.environ.get("REDACTOR_DEVICE", "cpu")
MAX_BODY = 1_000_000
CHUNK_CHARS = 1_400
MAX_LABELS = 25


def read_manifest() -> dict[str, dict[str, str]]:
    """Read `models.sha256`: lines of `<sha256>  <repo>/<file>`, grouped by repo."""
    manifest: dict[str, dict[str, str]] = {}
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        digest, path = line.split(None, 1)
        repo, _, name = path.rpartition("/")
        manifest.setdefault(repo, {})[name] = digest
    return manifest


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_and_verify(repo: str, expected: dict[str, str]) -> Path:
    """Fetch one repository's listed files into the volume and verify every one.

    Raises:
        RuntimeError: If a file is missing after the fetch or its digest differs.
    """
    from huggingface_hub import snapshot_download

    patterns = list(expected)
    try:
        snapshot = Path(snapshot_download(repo, allow_patterns=patterns, cache_dir=MODELS_DIR, local_files_only=True))
        if any(not (snapshot / name).exists() for name in expected):
            raise FileNotFoundError(repo)
    except Exception:  # noqa: BLE001 - any local miss means fetch
        print(f"redactor: fetching {repo} ({', '.join(patterns)})", flush=True)
        snapshot = Path(snapshot_download(repo, allow_patterns=patterns, cache_dir=MODELS_DIR))
    for name, digest in expected.items():
        path = snapshot / name
        if not path.exists():
            raise RuntimeError(f"{repo}/{name} is missing after fetch")
        actual = sha256_of(path.resolve())
        if actual != digest:
            raise RuntimeError(f"{repo}/{name} sha256 {actual} does not match the manifest ({digest})")
    return snapshot


def load_model() -> tuple[Any, str]:
    manifest = read_manifest()
    if MODEL_ID not in manifest:
        raise RuntimeError(f"{MODEL_ID} is not in {MANIFEST}; add its files and digests first")
    for repo, files in manifest.items():
        fetch_and_verify(repo, files)
    os.environ["HF_HUB_OFFLINE"] = "1"
    from gliner import GLiNER

    model = GLiNER.from_pretrained(MODEL_ID)
    device = "cpu"
    if DEVICE == "cuda":
        import torch

        if torch.cuda.is_available():
            model = model.to("cuda")
            device = torch.cuda.get_device_name(0)
        else:
            print("redactor: REDACTOR_DEVICE=cuda but no CUDA device is visible; using the CPU", flush=True)
    model.eval()
    return model, device


def chunks(text: str) -> list[tuple[int, str]]:
    """Split on line boundaries so no chunk exceeds CHUNK_CHARS; a longer line is cut."""
    out: list[tuple[int, str]] = []
    start, buffer, position = 0, "", 0
    for line in text.splitlines(keepends=True):
        if buffer and len(buffer) + len(line) > CHUNK_CHARS:
            out.append((start, buffer))
            start, buffer = position, ""
        buffer += line
        position += len(line)
    if buffer:
        out.append((start, buffer))
    split: list[tuple[int, str]] = []
    for offset, chunk in out:
        if len(chunk) <= CHUNK_CHARS * 2:
            split.append((offset, chunk))
            continue
        for index in range(0, len(chunk), CHUNK_CHARS):
            split.append((offset + index, chunk[index : index + CHUNK_CHARS]))
    return split


class Redactor:
    def __init__(self) -> None:
        started = time.monotonic()
        self.model, self.device = load_model()
        self.loaded_in = time.monotonic() - started
        self.predict("warm up: the password is hunter2", ["password"], 0.3)

    def predict(self, text: str, labels: list[str], threshold: float) -> list[dict[str, Any]]:
        spans: list[dict[str, Any]] = []
        utf16 = [0]
        for character in text:
            utf16.append(utf16[-1] + (2 if ord(character) > 0xFFFF else 1))
        for offset, chunk in chunks(text):
            for entity in self.model.predict_entities(chunk, labels, threshold=threshold, flat_ner=True):
                spans.append(
                    {
                        "start": utf16[offset + int(entity["start"])],
                        "end": utf16[offset + int(entity["end"])],
                        "label": str(entity["label"]),
                        "score": float(entity["score"]),
                    }
                )
        return spans


class Handler(BaseHTTPRequestHandler):
    redactor: Redactor

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler's name
        pass

    def reply(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - http.server's name
        if self.path != "/healthz":
            return self.reply(404, {"error": "not found"})
        self.reply(200, {"ok": True, "model": MODEL_ID, "device": self.redactor.device, "manifest": "verified"})

    def do_POST(self) -> None:  # noqa: N802 - http.server's name
        if self.path != "/v1/spans":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413 if length > MAX_BODY else 400, {"error": f"body must be 1 to {MAX_BODY} bytes"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            text = body["text"]
            labels = body["labels"]
            threshold = float(body.get("threshold", 0.3))
            if not isinstance(text, str) or not isinstance(labels, list) or not labels:
                raise ValueError("text must be a string and labels a non-empty list")
            if len(labels) > MAX_LABELS or any(not isinstance(label, str) or not label for label in labels):
                raise ValueError(f"labels must be 1 to {MAX_LABELS} non-empty strings")
            if not 0 < threshold < 1:
                raise ValueError("threshold must be between 0 and 1")
        except (KeyError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        started = time.monotonic()
        spans = self.redactor.predict(text, labels, threshold)
        self.reply(200, {"spans": spans, "ms": round((time.monotonic() - started) * 1000, 1)})


def probe() -> int:
    try:
        text = "the password is hunter2"
        request = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/v1/spans",
            data=json.dumps({"text": text, "labels": ["password"], "threshold": 0.3}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
            detected = any(
                span.get("label") == "password"
                and span.get("start") == text.index("hunter2")
                and span.get("end") == len(text)
                for span in body.get("spans", [])
            )
            return 0 if detected else 1
    except Exception:  # noqa: BLE001 - any failure is an unhealthy container
        return 1


def main() -> int:
    if "--health" in sys.argv[1:]:
        return probe()
    try:
        Handler.redactor = Redactor()
    except Exception as error:  # noqa: BLE001 - the reason is the whole point of the message
        print(f"redactor: refusing to start: {error}", file=sys.stderr, flush=True)
        return 1
    print(
        f"redactor: {MODEL_ID} on {Handler.redactor.device}, loaded in {Handler.redactor.loaded_in:.1f} s, serving on {PORT}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
