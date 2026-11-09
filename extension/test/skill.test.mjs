import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skill/tweakline/bin/tweakline');

function layout({ withRelay }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-skill-'));
  const bin = path.join(root, 'skill/tweakline/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(bin, 'tweakline'));
  fs.chmodSync(path.join(bin, 'tweakline'), 0o755);
  if (withRelay) {
    fs.mkdirSync(path.join(root, 'relay'));
    fs.writeFileSync(path.join(root, 'relay/cli.mjs'), '');
  }
  const fakes = path.join(root, 'fakes');
  fs.mkdirSync(fakes);
  const fake = (name, body) => { fs.writeFileSync(path.join(fakes, name), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(fakes, name), 0o755); };
  fake('npm', 'echo "added 120 packages in 3s"');
  fake('node', 'echo "{\\"jsonrpc\\":\\"2.0\\"}"');
  fake('curl', 'out=""; while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && out=$2; shift; done; [[ -n ${FAIL_CURL:-} ]] && { echo partial > "$out"; exit 22; }; echo "server v${VERSION:-1}" > "$out"; echo "  % Total progress" >&2');
  const run = (args, env = {}) => execFileSync(path.join(bin, 'tweakline'), args, {
    env: { ...process.env, PATH: `${fakes}:/usr/bin:/bin`, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { root, bin, run };
}

test('tweakline mcp from a checkout: npm ci output never reaches stdout', () => {
  const { run } = layout({ withRelay: true });
  assert.equal(run(['mcp']), '{"jsonrpc":"2.0"}\n');
});

test('released install: the server is downloaded whole, stdout carries only the command output', () => {
  const { bin, run } = layout({ withRelay: false });
  assert.equal(run(['mcp']), '{"jsonrpc":"2.0"}\n');
  assert.equal(fs.readFileSync(path.join(bin, 'tweakline-server.js'), 'utf8'), 'server v1\n');
  assert.deepEqual(fs.readdirSync(bin).sort(), ['tweakline', 'tweakline-server.js'], 'no temporary file left');
});

test('tweakline update replaces the server in place and a failed download keeps the old one', () => {
  const { bin, run } = layout({ withRelay: false });
  run(['status']);
  assert.equal(run(['update'], { VERSION: '2' }), '');
  assert.equal(fs.readFileSync(path.join(bin, 'tweakline-server.js'), 'utf8'), 'server v2\n');
  assert.throws(() => run(['update'], { FAIL_CURL: '1', VERSION: '3' }));
  assert.equal(fs.readFileSync(path.join(bin, 'tweakline-server.js'), 'utf8'), 'server v2\n');
  assert.deepEqual(fs.readdirSync(bin).sort(), ['tweakline', 'tweakline-server.js']);
});

test('SKILL.md updates through tweakline update and never mentions pack --update', () => {
  const skill = fs.readFileSync(path.join(path.dirname(SCRIPT), '../SKILL.md'), 'utf8');
  assert.match(skill, /tweakline update/);
  assert.doesNotMatch(skill, /pack \[?--update/);
});

test('SKILL.md updates the released server with its own update command, says where bin/tweakline is, and puts tab next to op', () => {
  const skill = fs.readFileSync(path.join(path.dirname(SCRIPT), '../SKILL.md'), 'utf8');
  assert.match(skill, /node tweakline-server\.js update/);
  assert.match(skill, /skill\/tweakline\/bin\/tweakline/);
  assert.match(skill, /\{"op":"read","args":\{\},"tab":123\}/);
  for (const example of skill.match(/\{"op":[^`]*\}/g)) assert.doesNotMatch(example, /"args":\{[^}]*"tab"/, example);
});
