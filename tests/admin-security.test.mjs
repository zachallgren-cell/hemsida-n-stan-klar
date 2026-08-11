import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('admin CSP permits the current inline module', async () => {
  const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
  const policy = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
  )?.[1];
  const modules = [...html.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/g)];

  assert.ok(policy, 'admin.html must declare a Content Security Policy');
  assert.equal(modules.length, 1, 'admin.html must contain exactly one inline module');

  const digest = createHash('sha256').update(modules[0][1]).digest('base64');
  assert.match(
    policy,
    new RegExp(`(?:^|\\s)'sha256-${digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'(?:;|\\s|$)`),
    'script-src must include the exact hash of the inline admin module'
  );
});
