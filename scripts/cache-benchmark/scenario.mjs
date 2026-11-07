import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function random(seed) {
  let state = parseInt(hash(seed).slice(0, 8), 16);
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function schedule(count, seed) {
  const rng = random(seed);
  const orders = Array.from({ length: count }, (_, index) => index % 2 ? ['raw', 'masked'] : ['masked', 'raw']);
  for (let index = orders.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [orders[index], orders[other]] = [orders[other], orders[index]];
  }
  return orders;
}

export function validateScenario(value) {
  if (value?.version !== 1 || !Number.isInteger(value.records) || value.records < 1 || value.records > 1000) throw new Error('Неверный сценарий: версия 1 и от 1 до 1000 записей.');
  for (const key of ['instructions', 'recordTemplate', 'userTemplate', 'assistantReply']) if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error('Неверное поле сценария: ' + key);
  if (!Array.isArray(value.tools)) throw new Error('В сценарии нужен массив tools.');
  return value;
}

export function payloadFor(scenario, model, nonce, turn, maxOutputTokens = 96) {
  const records = Array.from({ length: scenario.records }, (_, index) => scenario.recordTemplate.replaceAll('{record}', String(index + 1).padStart(4, '0')));
  const instructions = ['Independent synthetic cache trial ' + nonce, scenario.instructions, ...records].join('\n');
  const messages = [{ role: 'system', content: instructions }];
  for (let index = 1; index <= turn; index++) {
    messages.push({ role: 'user', content: scenario.userTemplate.replaceAll('{turn}', String(index).padStart(2, '0')).replaceAll('{record}', String((index * 17) % scenario.records + 1).padStart(4, '0')) });
    if (index < turn) messages.push({ role: 'assistant', content: scenario.assistantReply });
  }
  return { model, messages, ...(scenario.tools.length ? { tools: structuredClone(scenario.tools), tool_choice: 'none' } : {}), max_completion_tokens: maxOutputTokens, stream: false };
}

export function sourceHash(scenario, model, turn, maxOutputTokens) {
  const payload = payloadFor(scenario, model, 'CANONICAL-INDEPENDENT-PREFIX', turn, maxOutputTokens);
  return hash(payload);
}
