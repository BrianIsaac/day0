import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasHostTool } from '../../setup/host-tools';
import { redactText } from '../../../src/redaction/redact';
import type { ModelSpan } from '../../../src/redaction/client';

/** The redactor's server module, by path from this file rather than the working directory. */
const SERVER = fileURLToPath(new URL('../../../redactor/server.py', import.meta.url));

/** The server is Python; a machine without `python3` skips these rather than failing. */
const HAS_PYTHON = hasHostTool('python3');

/**
 * Run a Python snippet with the server module loaded as `server`.
 *
 * @returns The snippet's standard output.
 */
function withServer(code: string): string {
  return execFileSync(
    'python3',
    [
      '-c',
      `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('redactor_server', sys.argv[1])
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
${code}`,
      SERVER,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** GLiNER's own words splitter: an unspaced Chinese run is one word. */
const GLINER_SPLITTER = `
import re
def gliner_splitter(text):
    for match in re.finditer(r'\\w+(?:[-_]\\w+)*|\\S', text):
        yield match.group(), match.start(), match.end()
`;

describe.skipIf(!HAS_PYTHON)('sidecar wire offsets (needs python3)', () => {
  it('uses UTF-16 offsets after non-BMP characters', async () => {
    const output = withServer(`
import json
class Detector:
    def predict_entities(self, text, labels, **kwargs):
        start = text.index('hunter2')
        return [{'start': start, 'end': start + 7, 'label': 'password', 'score': 0.9}]
redactor = server.Redactor.__new__(server.Redactor)
redactor.lock = server.threading.Lock()
redactor.model = Detector()
text = chr(0x1f9ea) + ' Password: hunter2'
print(json.dumps({'text': text, 'spans': redactor.predict(text, ['password'], 0.3)}))
`);
    const { text, spans } = JSON.parse(output) as { text: string; spans: ModelSpan[] };
    const result = await redactText(text, 'documentation', {
      model: { name: 'wire', spans: async () => spans },
      onUnavailable: 'throw',
    });
    expect(result.text).toBe('\u{1f9ea} Password: <redacted>');
  });
});

describe.skipIf(!HAS_PYTHON)('sidecar health (needs python3)', () => {
  it('fails when HTTP is responsive but prediction finds no password', () => {
    const output = withServer(`
import io, json
requests = []
def urlopen(request, **kwargs):
    requests.append(request if isinstance(request, str) else request.full_url)
    return io.BytesIO(json.dumps({'ok': True, 'spans': []}).encode())
server.urllib.request.urlopen = urlopen
print(json.dumps({'status': server.probe(), 'requests': requests}))
`);
    expect(JSON.parse(output)).toEqual({
      status: 1,
      requests: ['http://127.0.0.1:8000/v1/spans'],
    });
  });

  it('passes only when the Chinese probe is answered too', () => {
    const output = withServer(`
import io, json
def run(chinese_reply):
    texts = []
    def urlopen(request, **kwargs):
        text = json.loads(request.data.decode('utf-8'))['text']
        texts.append(text)
        if text.isascii():
            return io.BytesIO(json.dumps({'spans': [{'label': 'password', 'start': 16, 'end': 23}]}).encode())
        return io.BytesIO(json.dumps(chinese_reply).encode())
    server.urllib.request.urlopen = urlopen
    return {'status': server.probe(), 'chinese': any(not text.isascii() for text in texts)}
print(json.dumps([run({'spans': []}), run({'error': 'prediction failed'})]))
`);
    expect(JSON.parse(output)).toEqual([
      { status: 0, chinese: true },
      { status: 1, chinese: true },
    ]);
  });
});

describe.skipIf(!HAS_PYTHON)('verified loading (needs python3)', () => {
  it('loads only listed files through an isolated local cache', () => {
    const output = withServer(`
import json, sys, tempfile, types
from pathlib import Path
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    snapshot = root / ('a' * 40)
    snapshot.mkdir()
    (snapshot / 'gliner_config.json').write_text('{}')
    (snapshot / 'unverified.bin').write_text('not approved')
    server.MODELS_DIR = root
    server.read_manifest = lambda: {server.MODEL_ID: {'gliner_config.json': 'digest'}}
    server.fetch_and_verify = lambda repo, files: snapshot
    calls = []
    class Detector:
        @classmethod
        def from_pretrained(cls, location, **kwargs):
            calls.append({'local': kwargs.get('local_files_only'), 'path': Path(location).is_dir(),
                'files': sorted(p.name for p in Path(location).iterdir()) if Path(location).is_dir() else []})
            return cls()
        def eval(self): pass
    sys.modules['gliner'] = types.SimpleNamespace(GLiNER=Detector)
    server.load_model()
    print(json.dumps(calls))
`);
    expect(JSON.parse(output)).toEqual([
      { local: true, path: true, files: ['gliner_config.json'] },
    ]);
  });
});

describe.skipIf(!HAS_PYTHON)('prediction windows (needs python3)', () => {
  it('bounds word count and overlaps windows instead of silently truncating a dense line', () => {
    const output = withServer(`
import json
text = 'x ' * 700 + 'password: hunter2'
windows = server.chunks(text)
print(json.dumps({'largest': max(len(chunk.split()) for _, chunk in windows),
    'covered': windows[-1][0] + len(windows[-1][1]) == len(text),
    'overlap': all(start < previous + len(chunk) for (previous, chunk), (start, _) in zip(windows, windows[1:]))}))
`);
    const result = JSON.parse(output);
    expect(result.largest).toBeLessThanOrEqual(256);
    expect(result.covered).toBe(true);
    expect(result.overlap).toBe(true);
  });

  it('windows an unbroken Chinese run longer than the window, under either splitter', () => {
    const output = withServer(`
import json
${GLINER_SPLITTER}
text = '运维团队每天刷新看板并核对数据' * 200
report = {}
for name, splitter in (('whitespace', None), ('gliner', gliner_splitter)):
    windows = server.chunks(text, splitter)
    report[name] = {
        'largest': max(len(chunk) for _, chunk in windows),
        'first': windows[0][0],
        'covered': windows[-1][0] + len(windows[-1][1]) == len(text),
        'offsets': all(text[start:start + len(chunk)] == chunk for start, chunk in windows),
    }
print(json.dumps({'length': len(text), 'report': report}))
`);
    const { length, report } = JSON.parse(output) as {
      length: number;
      report: Record<
        string,
        { largest: number; first: number; covered: boolean; offsets: boolean }
      >;
    };
    expect(length).toBeGreaterThan(1_400);
    for (const name of ['whitespace', 'gliner']) {
      expect(report[name]).toEqual({
        largest: expect.any(Number),
        first: 0,
        covered: true,
        offsets: true,
      });
      expect(report[name]!.largest).toBeLessThanOrEqual(1_400);
    }
  });

  it('keeps a value that straddles a cut whole inside one window', () => {
    const output = withServer(`
import json
${GLINER_SPLITTER}
secret = 'hunter2secretvalue'
cut = server.PIECE_CHARS
text = '测' * (cut - 9) + secret + '试' * 2000
start = text.index(secret)
windows = server.chunks(text, gliner_splitter)
print(json.dumps({'straddles': start < cut < start + len(secret),
    'whole': any(offset <= start and start + len(secret) <= offset + len(chunk) for offset, chunk in windows)}))
`);
    expect(JSON.parse(output)).toEqual({ straddles: true, whole: true });
  });

  it('cuts after a Chinese sentence ender when there is one in reach', () => {
    const output = withServer(`
import json
sentence = '请在周五前刷新看板。'
text = sentence * 60
cuts = [end for _, _, end in server.pieces(text, 0, len(text))][:-1]
print(json.dumps({'cuts': len(cuts), 'afterEnder': all(text[end - 1] == '。' for end in cuts)}))
`);
    expect(JSON.parse(output)).toEqual({ cuts: expect.any(Number), afterEnder: true });
    expect((JSON.parse(output) as { cuts: number }).cuts).toBeGreaterThan(1);
  });
});

describe.skipIf(!HAS_PYTHON)('the server under a bad page and a flood (needs python3)', () => {
  it('answers a prediction failure instead of closing the socket, and keeps serving', () => {
    const output = withServer(`
import json, threading, urllib.error, urllib.request
class Detector:
    def predict_entities(self, text, labels, **kwargs):
        if 'boom' in text:
            raise RuntimeError('model fell over')
        if 'odd' in text:
            raise ValueError('no window fits')
        return []
redactor = server.Redactor.__new__(server.Redactor)
redactor.lock = threading.Lock()
redactor.model = Detector()
server.Handler.redactor = redactor
httpd = server.BoundedServer(('127.0.0.1', 0), server.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
def post(text):
    request = urllib.request.Request(f'http://127.0.0.1:{httpd.server_address[1]}/v1/spans',
        data=json.dumps({'text': text, 'labels': ['password']}).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return [response.status, json.loads(response.read())]
    except urllib.error.HTTPError as error:
        return [error.code, json.loads(error.read())]
print(json.dumps([post('boom'), post('odd'), post('运维' * 1000)[0]]))
httpd.shutdown()
`);
    expect(JSON.parse(output)).toEqual([
      [500, { error: 'prediction failed' }],
      [422, { error: 'the text could not be scored: no window fits' }],
      200,
    ]);
  });

  it('refuses a connection past the bound with 503 and Retry-After', () => {
    const output = withServer(`
import json, socket, threading, time, urllib.error, urllib.request
server.Handler.redactor = type('Loaded', (), {'device': 'cpu'})()
httpd = server.BoundedServer(('127.0.0.1', 0), server.Handler, limit=1)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
port = httpd.server_address[1]
held = socket.create_connection(('127.0.0.1', port))
held.sendall(b'GET /healthz HTTP/1.1\\r\\nHost: x\\r\\n')
# Wait until the server has given the held connection the one slot, however
# long a loaded machine takes to schedule its accepting thread.
deadline = time.monotonic() + 5
while httpd.slots.acquire(blocking=False):
    httpd.slots.release()
    if time.monotonic() > deadline:
        raise SystemExit('the server never took the held connection')
    time.sleep(0.01)
try:
    urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=5)
    result = None
except urllib.error.HTTPError as error:
    result = [error.code, error.headers.get('Retry-After'), json.loads(error.read())]
held.close()
# The held connection's handler thread is a daemon: it must have answered the
# close and given its slot back before the interpreter exits, or its line on
# stderr races the interpreter's shutdown, which aborts the process.
deadline = time.monotonic() + 5
while not httpd.slots.acquire(blocking=False):
    if time.monotonic() > deadline:
        raise SystemExit('the held connection never gave its slot back')
    time.sleep(0.01)
httpd.slots.release()
httpd.shutdown()
print(json.dumps(result))
`);
    expect(JSON.parse(output)).toEqual([503, '1', { error: 'busy: too many connections' }]);
  });
});
