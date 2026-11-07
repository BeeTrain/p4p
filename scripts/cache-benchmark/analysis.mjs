import { random } from './scenario.mjs';

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const valid = row => row.status === 200 && Number.isFinite(row.inputTokens) && row.inputTokens > 0 && Number.isFinite(row.cachedTokens) && row.cachedTokens >= 0 && row.cachedTokens <= row.inputTokens;
const share = (numerator, denominator) => denominator ? numerator / denominator : null;

export function metrics(rows) {
  const measured = rows.filter(valid);
  const warm = measured.filter(row => row.turn > 1);
  const first = measured.filter(row => row.turn === 1);
  const hits = rows => rows.filter(row => row.cachedTokens > 0).length;
  return {
    attempted: rows.length, succeeded: rows.filter(row => row.status === 200).length, measured: measured.length,
    hits: hits(measured), hitRate: share(hits(measured), measured.length),
    coldMeasured: first.length, coldHits: hits(first), coldHitRate: share(hits(first), first.length),
    warmMeasured: warm.length, warmHits: hits(warm), warmHitRate: share(hits(warm), warm.length),
    inputTokens: sum(measured, 'inputTokens'), cachedTokens: sum(measured, 'cachedTokens'),
    cachedTokenShare: share(sum(measured, 'cachedTokens'), sum(measured, 'inputTokens')),
    warmCachedTokenShare: share(sum(warm, 'cachedTokens'), sum(warm, 'inputTokens')),
    meanInputTokens: mean(measured.map(row => row.inputTokens)),
    meanUpstreamMs: mean(measured.map(row => row.upstreamMs).filter(Number.isFinite)),
    meanMaskingMs: mean(measured.map(row => row.maskingMs).filter(Number.isFinite))
  };
}

export function bootstrapPairs(values, seed, samples = 20000) {
  if (values.length < 2) return null;
  const rng = random(seed);
  const estimates = Array.from({ length: samples }, () => mean(Array.from({ length: values.length }, () => values[Math.floor(rng() * values.length)]))).sort((a, b) => a - b);
  return { method: 'paired session bootstrap percentile', samples, confidence: 0.95, low: estimates[Math.floor(samples * 0.025)], high: estimates[Math.ceil(samples * 0.975) - 1] };
}

export function analyze(plan, rows, samples = 20000) {
  const pairs = plan.pairs.map(pair => {
    const maskedRows = rows.filter(row => row.pair === pair.id && row.mode === 'masked');
    const rawRows = rows.filter(row => row.pair === pair.id && row.mode === 'raw');
    const complete = [maskedRows, rawRows].every(items => items.length === plan.requests && new Set(items.map(row => row.turn)).size === plan.requests && items.every(valid));
    const masked = metrics(maskedRows), raw = metrics(rawRows);
    const integrity = [maskedRows, rawRows].every(items => items.length > 0
      && new Set(items.map(row => row.instructionsSha256)).size === 1
      && new Set(items.map(row => row.toolsSha256)).size === 1
      && items.every(row => row.integrityOK === true && typeof row.sourceSha256 === 'string' && typeof row.instructionsSha256 === 'string' && typeof row.toolsSha256 === 'string'))
      && maskedRows.every(row => rawRows.find(other => other.turn === row.turn)?.sourceSha256 === row.sourceSha256);
    return { pair: pair.id, complete, integrity, masked, raw, warmHitDifference: complete ? masked.warmHitRate - raw.warmHitRate : null, warmTokenShareDifference: complete ? masked.warmCachedTokenShare - raw.warmCachedTokenShare : null };
  });
  const usable = pairs.filter(pair => pair.complete && pair.integrity);
  const difference = mean(usable.map(pair => pair.warmHitDifference));
  const interval = bootstrapPairs(usable.map(pair => pair.warmHitDifference), plan.seed + ':hit-rate', samples);
  const tokenInterval = bootstrapPairs(usable.map(pair => pair.warmTokenShareDifference), plan.seed + ':token-share', samples);
  const masked = metrics(rows.filter(row => row.mode === 'masked')), raw = metrics(rows.filter(row => row.mode === 'raw'));
  const margin = plan.marginPP / 100;
  let verdict = 'inconclusive';
  if (usable.length !== plan.pairs.length) verdict = 'incomplete';
  else if (!raw.warmHits && !masked.warmHits) verdict = 'insufficient-cache-observations';
  else if (interval && interval.high < -margin) verdict = 'masked-worse-than-margin';
  else if (interval && interval.low > margin) verdict = 'masked-better-than-margin';
  else if (!raw.warmHits || !masked.warmHits) verdict = 'insufficient-cache-observations';
  else if (interval && interval.low >= -margin && interval.high <= margin) verdict = 'within-margin';
  return { masked, raw, pairs, usablePairs: usable.length, plannedPairs: plan.pairs.length, primaryMetric: 'mean paired difference of post-first-request hit rates', warmHitDifference: difference, warmHitDifferenceCI95: interval, warmTokenShareDifference: mean(usable.map(pair => pair.warmTokenShareDifference)), warmTokenShareDifferenceCI95: tokenInterval, inputTokenIncrease: raw.meanInputTokens ? masked.meanInputTokens / raw.meanInputTokens - 1 : null, marginPP: plan.marginPP, verdict };
}

const pct = value => value === null || value === undefined ? '—' : (100 * value).toFixed(2) + '%';
const pp = value => value === null || value === undefined ? '—' : (100 * value).toFixed(2) + ' п.п.';
const ci = value => value ? `[${pp(value.low)}; ${pp(value.high)}]` : '—';
const verdictText = {
  'within-margin': '95%-й доверительный интервал целиком внутри выбранных границ практической эквивалентности. В условиях этого сценария наблюдаемое отличие укладывается в допустимое.',
  'masked-worse-than-margin': '95%-й доверительный интервал указывает на ухудшение с плагином больше выбранного допустимого порога.',
  'masked-better-than-margin': '95%-й доверительный интервал указывает на улучшение с плагином больше выбранного допустимого порога.',
  'inconclusive': 'Доверительный интервал не позволяет установить практическую эквивалентность или отличие больше выбранного порога. Нужны дополнительные независимые пары сессий.',
  'incomplete': 'Не все запланированные пары завершены или прошли проверки целостности. Итоговый вывод по полному плану недоступен.',
  'insufficient-cache-observations': 'В одном или обоих режимах нет попаданий после первого запроса. Проверка недостаточно информативна для вывода об эквивалентности.'
};

export function renderReport(plan, result) {
  const a = result.masked, b = result.raw;
  const recoveryNote = plan.resumes?.length ? `Возобновлений после сбоев: ${plan.resumes.length}. Из основного набора исключены ${plan.resumes.reduce((total, entry) => total + entry.excludedRows, 0)} строки неполных пар; они сохранены вместе с предыдущими планами в attempts/. Полные пары сохранены, неполные заново начаты с новыми префиксами. Сетевые ошибки не считаются промахами кеша. Длительная пауза между временными блоками отмечена в plan.json и ограничивает переносимость результата.\n\n` : '';
  const snapshotNote = (plan.settingsFrozen ? `Настройки зафиксированы из ${plan.sourceSettingsPath}, ${plan.patternCount} правил, ревизия ${plan.sourceSettingsRevision}. Для измерения используется отдельная временная копия; изменения рабочего файла во время теста не меняют сценарий. Изменение исходного файла во время прогона: ${plan.sourceSettingsChangedDuringRun ?? 'ещё не проверено'}.\n\n` : '') + recoveryNote;
  return `# Парный тест влияния p4p на кеш\n\nМодель: ${plan.provider}/${plan.model}. API: Chat Completions. План: ${plan.pairs.length} пар × ${plan.requests} запросов × 2 режима = ${plan.pairs.length * plan.requests * 2} вызовов. Завершено пригодных пар: ${result.usablePairs}/${result.plannedPairs}.\n\n${snapshotNote}Использован HTTP-обработчик плагина напрямую. Это проверка установленной реализации маскирования с выбранным конфигом и реального провайдера; Desktop в маршрут не входит.\n\n| Метрика | С p4p | Без p4p |\n| --- | ---: | ---: |\n| Успешных запросов | ${a.succeeded}/${a.attempted} | ${b.succeeded}/${b.attempted} |\n| Запросов с метриками кеша | ${a.measured} | ${b.measured} |\n| Попаданий, включая первые запросы | ${a.hits} (${pct(a.hitRate)}) | ${b.hits} (${pct(b.hitRate)}) |\n| Попаданий после первых запросов | ${a.warmHits}/${a.warmMeasured} (${pct(a.warmHitRate)}) | ${b.warmHits}/${b.warmMeasured} (${pct(b.warmHitRate)}) |\n| Попаданий на первых запросах | ${a.coldHits}/${a.coldMeasured} | ${b.coldHits}/${b.coldMeasured} |\n| Доля входных токенов из кеша | ${pct(a.cachedTokenShare)} | ${pct(b.cachedTokenShare)} |\n| Доля токенов из кеша после первых запросов | ${pct(a.warmCachedTokenShare)} | ${pct(b.warmCachedTokenShare)} |\n| Среднее входных токенов | ${a.meanInputTokens?.toFixed(1) ?? '—'} | ${b.meanInputTokens?.toFixed(1) ?? '—'} |\n| Среднее время провайдера, мс | ${a.meanUpstreamMs?.toFixed(0) ?? '—'} | ${b.meanUpstreamMs?.toFixed(0) ?? '—'} |\n| Среднее время маскирования, мс | ${a.meanMaskingMs?.toFixed(0) ?? '—'} | ${b.meanMaskingMs?.toFixed(0) ?? '—'} |\n\n## Оценка\n\nОсновная метрика — средняя разница частоты попаданий после первого запроса по полным парам сессий (p4p минус контроль): **${pp(result.warmHitDifference)}**, 95%-й интервал **${ci(result.warmHitDifferenceCI95)}**. Допустимый порог задан до запуска: ±${plan.marginPP} п.п.\n\n${verdictText[result.verdict]}\n\nСредняя разница долей кешированных токенов после первых запросов по парам: ${pp(result.warmTokenShareDifference)}, интервал ${ci(result.warmTokenShareDifferenceCI95)}. Рост среднего числа входных токенов: ${pct(result.inputTokenIncrease)}.\n\n## По парам\n\n| Пара | С p4p, после первого | Без p4p, после первого | Разница | Целостность |\n| ---: | ---: | ---: | ---: | --- |\n${result.pairs.map(pair => `| ${pair.pair} | ${pair.masked.warmHits}/${pair.masked.warmMeasured} | ${pair.raw.warmHits}/${pair.raw.warmMeasured} | ${pp(pair.warmHitDifference)} | ${pair.complete && pair.integrity ? 'OK' : 'неполная/ошибка'} |`).join('\n')}\n\n## Методика и ограничения\n\nДля каждой пары подготовлены два независимых уникальных начальных префикса одинаковой длины. Сценарий до добавления этих префиксов одинаков в обоих режимах. Кеш одного режима не прогревает другой. Два отдельных рабочих процесса сохраняют разные таблицы состояния. Внутри пары запросы чередуются; очередность первой отправки на каждом шаге сбалансирована и перемешана с seed из плана. Интервал между началами запросов одной сессии — не менее ${plan.intervalMs} мс; глобальный интервал — не менее ${plan.globalIntervalMs} мс.\n\nСистемные инструкции и инструменты фиксированы. История растёт по заранее записанному сценарию и не зависит от реальных ответов модели. Проверяются хеши инструкций и инструментов, исходных сценариев, тестовой копии настроек и кода плагина, а также сохранение предыдущей истории в исходящем запросе. Все первые запросы сохранены и выделены отдельно; успешный кеш-запрос после них не гарантирован.\n\n95%-й интервал получен percentile bootstrap с повторной выборкой целых пар сессий, ${result.warmHitDifferenceCI95?.samples ?? 0} повторений. Запросы внутри сессии не считаются независимыми наблюдениями. Неполные или нарушившие целостность пары исключаются из парной оценки и отмечаются; общий вывод при этом считается неполным. При нулевом числе попаданий в одном из режимов вывод об эквивалентности не делается.\n\nВывод относится к этому сценарию, модели, прокси, конфигу и времени измерения. Бутстреп-интервал приблизительный; небольшое число пар и временные зависимости провайдера ограничивают точность. Отсутствие статистически заметной разницы не равно доказательству эквивалентности: для неё интервал должен целиком лежать в заранее выбранных границах.\n\nПлан и метаданные: plan.json. Каждая попытка: requests.jsonl. Сводные метрики: analysis.json. Секреты, таблицы замен и тела запросов не записываются.\n`;
}
