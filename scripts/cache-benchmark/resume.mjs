import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyze } from './analysis.mjs';

export function prepareResume(previous, rows, metadata, uuid = randomUUID) {
  for (const key of ['provider', 'model', 'endpoint', 'configSha256', 'settingsSha256', 'settingsRevision', 'pluginCodeHash', 'scenarioHash']) {
    assert.equal(metadata[key], previous[key], 'Нельзя продолжить тест: изменилось поле ' + key);
  }
  const result = analyze(previous, rows, 1000);
  const keptPairs = result.pairs.filter(pair => pair.complete && pair.integrity).map(pair => pair.pair);
  const pendingPairs = previous.pairs.filter(pair => !keptPairs.includes(pair.id)).map(pair => pair.id);
  const keptRows = rows.filter(row => keptPairs.includes(row.pair));
  const plan = structuredClone(previous);
  plan.pairs = plan.pairs.map(pair => keptPairs.includes(pair.id) ? pair : { ...pair, prefixes: { raw: uuid(), masked: uuid() } });
  plan.settingsPath = metadata.settingsPath;
  plan.completed = false;
  delete plan.error;
  delete plan.finishedAt;
  return { plan, keptRows, keptPairs, pendingPairs, archivedRows: rows.length - keptRows.length };
}
