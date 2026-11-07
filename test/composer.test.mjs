import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerControls } from '../dist/composer.js';
import { defaultSettings } from '../dist/core/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('a late status read cannot undo a confirmed toggle and repeated clicks cannot submit twice', async () => {
  const initial = { settings: { ...defaultSettings(), hosts: ['api.example.test'], patterns: ['private'] }, revision: 'first', path: '/temporary/config.json' };
  let resolveRead, resolveToggle, calls = 0, reads = 0;
  const controls = createComposerControls({
    get: () => ++reads === 1 ? Promise.resolve(initial) : new Promise(resolve => { resolveRead = resolve; }),
    setEnabled: enabled => { calls++; assert.equal(enabled, false); return new Promise(resolve => { resolveToggle = resolve; }); }
  }, () => assert.fail('Unexpected error'));
  await controls.refresh();
  assert.equal(controls.view().label, 'p4p'); assert.equal(controls.view().tone, 'success');
  const lateRead = controls.refresh();
  const button = controls.view(); button.run(); button.run();
  assert.equal(calls, 1); assert.equal(controls.view().run, undefined);
  resolveToggle({ ...initial, revision: 'second', settings: { ...initial.settings, enabled: false } }); await tick();
  assert.equal(controls.view().label, 'p4p'); assert.equal(controls.view().tone, 'danger'); assert.equal(controls.view().icon, 'shield');
  resolveRead(initial); await lateRead;
  assert.equal(controls.view().label, 'p4p'); assert.equal(controls.view().tone, 'danger'); assert.equal(controls.view().icon, 'shield');
  controls.dispose();
});
