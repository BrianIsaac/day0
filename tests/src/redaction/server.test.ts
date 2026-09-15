import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { redactText } from '../../../src/redaction/redact';
import type { ModelSpan } from '../../../src/redaction/client';

describe('sidecar wire offsets', () => {
  it('uses UTF-16 offsets after non-BMP characters', async () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('redactor_server', 'redactor/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
class Detector:
    def predict_entities(self, text, labels, **kwargs):
        start = text.index('hunter2')
        return [{'start': start, 'end': start + 7, 'label': 'password', 'score': 0.9}]
redactor = server.Redactor.__new__(server.Redactor)
redactor.model = Detector()
text = chr(0x1f9ea) + ' Password: hunter2'
print(json.dumps({'text': text, 'spans': redactor.predict(text, ['password'], 0.3)}))
`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const { text, spans } = JSON.parse(output) as { text: string; spans: ModelSpan[] };
    const result = await redactText(text, 'documentation', {
      model: { name: 'wire', spans: async () => spans }, onUnavailable: 'throw',
    });
    expect(result.text).toBe('\u{1f9ea} Password: <redacted>');
  });
});

describe('sidecar health', () => {
  it('fails when HTTP is responsive but prediction finds no password', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util, io, json
spec = importlib.util.spec_from_file_location('redactor_server', 'redactor/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
requests = []
def urlopen(request, **kwargs):
    requests.append(request if isinstance(request, str) else request.full_url)
    return io.BytesIO(json.dumps({'ok': True, 'spans': []}).encode())
server.urllib.request.urlopen = urlopen
print(json.dumps({'status': server.probe(), 'requests': requests}))
`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(JSON.parse(output)).toEqual({ status: 1, requests: ['http://127.0.0.1:8000/v1/spans'] });
  });
});
