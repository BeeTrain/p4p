import codecs
import copy
import json
import re
import sys
import secrets

import diagnostic_fragments


MARKER = re.compile(r'__BATYA_[0-9a-f]{24}_[0-9]+__')
INPUT_FIELDS = {'messages', 'input', 'instructions', 'system', 'tools', 'tool_choice',
                'prompt', 'response_format', 'text'}
METADATA = {'id', 'model', 'role', 'type', 'object', 'tool_call_id', 'call_id',
            'format', 'media_type', 'mime_type', 'response_id', 'previous_response_id',
            'item_id', 'event_id', 'stream_id', 'file_id', 'container_id', 'encrypted_content', 'signature'}
SCHEMA_MAPS = {'properties', '$defs', 'definitions', 'patternProperties',
               'dependentRequired', 'dependentSchemas'}



def validate(value):
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ValueError('Укажите, включено ли маскирование.')
    words = value.get('words')
    if not isinstance(words, list) or len(words) > 500:
        raise ValueError('Словарь должен содержать не более 500 слов или фраз.')
    result, seen = [], set()
    for word in words:
        if not isinstance(word, str) or not word.strip() or len(word) > 200 or any(ord(c) < 32 for c in word):
            raise ValueError('Каждая строка должна содержать слово или фразу длиной до 200 символов.')
        word = word.strip()
        if word.casefold() not in seen:
            result.append(word)
            seen.add(word.casefold())
    patterns = value.get('patterns', [])
    if not isinstance(patterns, list) or len(patterns) > 600:
        raise ValueError('Укажите не более 600 паттернов маскирования.')
    normalized = []
    for index, pattern in enumerate(patterns, 1):
        if not isinstance(pattern, str) or not pattern or len(pattern) > 2000 or '\n' in pattern or '\r' in pattern:
            raise ValueError('Регулярное выражение %d: нужна непустая строка до 2000 символов.' % index)
        try:
            compiled = re.compile(pattern)
        except re.error as error:
            raise ValueError('Регулярное выражение %d: %s' % (index, error)) from error
        if compiled.search('') is not None:
            raise ValueError('Регулярное выражение %d совпадает с пустой строкой.' % index)
        if pattern not in normalized:
            normalized.append(pattern)
    diagnostics = value.get('diagnostics', {})
    if not isinstance(diagnostics, dict) or set(diagnostics) - set(diagnostic_fragments.DEFAULT):
        raise ValueError('Неверные настройки логов и стектрейсов.')
    diagnostics = {**diagnostic_fragments.DEFAULT, **diagnostics}
    if any(type(item) is not bool for item in diagnostics.values()):
        raise ValueError('Настройки логов и стектрейсов должны быть переключателями.')
    return {'enabled': value['enabled'], 'words': result, 'patterns': normalized, 'diagnostics': diagnostics}



def restore(text, mapping):
    return MARKER.sub(lambda match: mapping.get(match.group(), match.group()), text)


def restore_tree(value, mapping):
    if isinstance(value, str):
        return restore(value, mapping)
    if isinstance(value, list):
        return [restore_tree(item, mapping) for item in value]
    if isinstance(value, dict):
        return {restore(key, mapping): restore_tree(item, mapping) if key not in METADATA else item
                for key, item in value.items()}
    return value


class Masker:
    def __init__(self, settings, mapping=None):
        settings = validate(settings)
        self.enabled = settings['enabled']
        self.settings = settings
        self.regex = [re.compile(pattern) for pattern in settings['patterns']]
        words = sorted(settings['words'], key=len, reverse=True)
        self.pattern = re.compile('|'.join(re.escape(word) for word in words), re.IGNORECASE) if words else re.compile(r'(?!)')
        self.prefix = '__BATYA_' + secrets.token_hex(12) + '_'
        self.mapping = dict(mapping or {})
        if len(self.mapping) > 10000 or any(not MARKER.fullmatch(key) or not isinstance(value, str)
                                            for key, value in self.mapping.items()):
            raise ValueError('Неверная таблица восстановления.')
        self.reverse = {value: key for key, value in self.mapping.items()}
        if self.mapping:
            self.prefix = re.sub(r'[0-9]+__$', '', next(iter(self.mapping)))
        self.next_index = max((int(re.search(r'_([0-9]+)__$', key).group(1))
                               for key in self.mapping if key.startswith(self.prefix)), default=-1) + 1
        self.count = 0
        self.matched_words = 0
        self.matched_patterns = 0
        self.fragments = {'log': 0, 'stacktrace': 0}

    def mask(self, text, tool_output=False):
        if not self.enabled:
            return text
        fragments = diagnostic_fragments.find(text, self.settings['diagnostics'], tool_output)
        excluded = [(match.start(), match.end()) for match in MARKER.finditer(text)
                    if match.group() in self.mapping]
        for fragment in fragments:
            self.fragments[fragment['kind']] += 1
            option = 'logs' if fragment['kind'] == 'log' else 'stacktraces'
            if not self.settings['diagnostics'][option]:
                excluded.append((fragment['start'], fragment['end']))
        matches = []
        for pattern, kind in [(self.pattern, 'word'), *((pattern, 'regex') for pattern in self.regex)]:
            for match in pattern.finditer(text):
                if match.start() == match.end():
                    continue
                portions = [(match.start(), match.end())]
                for start, end in excluded:
                    portions = [(a, b) for left, right in portions for a, b in
                                ((left, min(right, start)), (max(left, end), right)) if b > a]
                if portions:
                    if kind == 'regex':
                        self.matched_patterns += 1
                    else:
                        self.matched_words += 1
                    matches.extend(portions)
        merged = []
        for start, end in sorted(matches):
            if merged and start < merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        output, previous = [], 0
        for start, end in merged:
            original = text[start:end]
            marker = self.reverse.get(original)
            if marker is None:
                marker = self.prefix + str(self.next_index) + '__'
                self.next_index += 1
                self.mapping[marker] = original
                self.reverse[original] = marker
            output.extend((text[previous:start], marker))
            previous = end
        self.count += len(merged)
        return ''.join(output) + text[previous:]

    def statistics(self):
        return {'enabled': self.enabled, 'replacements': self.count, 'word_matches': self.matched_words,
                'regex_matches': self.matched_patterns, 'fragments': self.fragments}

    def tree(self, value, parent='', tool_output=False):
        if isinstance(value, str):
            return self.mask(value, tool_output)
        if isinstance(value, list):
            return [self.tree(item, parent, tool_output) for item in value]
        if isinstance(value, dict):
            tool_output = tool_output or value.get('role') == 'tool' or value.get('type') == 'function_call_output'
            return {(self.mask(key) if parent in SCHEMA_MAPS else key):
                    item if parent not in SCHEMA_MAPS and (key in METADATA or key in ('url', 'data')) else self.tree(item, key, tool_output)
                    for key, item in value.items()}
        return value

    def request(self, payload):
        if not self.enabled or not isinstance(payload, dict):
            return payload
        return {key: self.tree(value) if key in INPUT_FIELDS else value for key, value in payload.items()}



def process(settings, value, mode, mapping=None):
    masker = Masker(settings, mapping)
    output = masker.mask(value) if mode == 'preview' else masker.request(value)
    result = {'value': output, 'statistics': masker.statistics(), 'mapping': masker.mapping}
    if mode == 'preview':
        result['restored'] = restore(output, masker.mapping) if masker.enabled else output
        result['fragments'] = diagnostic_fragments.find(value, masker.settings['diagnostics'])
        result['statistics']['fragments'] = {kind: sum(fragment['kind'] == kind for fragment in result['fragments'])
                                             for kind in ('log', 'stacktrace')}
    return result


def split_tail(text):
    start = text.rfind('__BATYA_')
    if start >= 0 and MARKER.fullmatch(text[start:]):
        return text, ''
    if start >= 0 and len(text) - start <= 100 and re.fullmatch(r'__BATYA_[0-9a-f]*(?:_[0-9]*_?)?', text[start:]):
        return text[:start], text[start:]
    prefix = '__BATYA_'
    for size in range(len(prefix) - 1, 0, -1):
        if text.endswith(prefix[:size]):
            return text[:-size], prefix[:size]
    return text, ''


class EventDecoder:
    def __init__(self, mapping):
        self.mapping = mapping
        self.decoder = codecs.getincrementaldecoder('utf-8')()
        self.buffer = ''
        self.frames = []
        self.pending = {}

    def flush(self):
        for holder, key, tail in self.pending.values():
            holder[key] += tail
        self.pending.clear()

    def strings(self, value, path):
        if isinstance(value, list):
            for index, item in enumerate(value):
                identity = item.get('index', index) if isinstance(item, dict) else index
                self.strings(item, path + (identity,))
        elif isinstance(value, dict):
            for key in list(value):
                restored = restore(key, self.mapping)
                if restored != key:
                    value[restored] = value.pop(key)
            for key, item in value.items():
                if isinstance(item, str) and key not in METADATA:
                    channel = path + (key,)
                    previous = self.pending.pop(channel, None)
                    holder, field, tail = previous or (value, key, '')
                    complete, rest = split_tail(tail + item)
                    result = restore(complete, self.mapping)
                    if previous:
                        holder[field] += result
                        value[key] = ''
                    else:
                        value[key] = result
                    if rest:
                        self.pending[channel] = (holder, field, rest)
                elif key not in METADATA:
                    self.strings(item, path + (key,))

    def frame(self, raw):
        lines = raw.splitlines()
        data = '\n'.join(line[5:].lstrip(' ') for line in lines if line.startswith('data:'))
        try:
            value = json.loads(data)
        except ValueError:
            if data == '[DONE]':
                self.flush()
            self.frames.append((raw, None, None))
            return
        original = copy.deepcopy(value)
        if isinstance(value, dict):
            if value.get('type') in ('message_stop', 'response.completed', 'response.failed', 'response.incomplete') or any(
                    choice.get('finish_reason') for choice in value.get('choices') or []):
                self.flush()
            channel = tuple(value.get(key, '') for key in ('index', 'output_index', 'content_index', 'item_id'))
            self.strings(value, channel)
        self.frames.append((raw, value, original))

    def feed(self, data, final=False):
        self.buffer += self.decoder.decode(data, final=final)
        if len(self.buffer) + sum(len(frame[0]) for frame in self.frames) > 16 * 1024 * 1024:
            raise ValueError('Превышен лимит буфера потока.')
        output = []
        while True:
            boundary = re.search(r'\r?\n\r?\n', self.buffer)
            if not boundary:
                break
            raw, self.buffer = self.buffer[:boundary.end()], self.buffer[boundary.end():]
            self.frame(raw)
            if not self.pending:
                output.extend(self.drain())
        if final:
            if self.buffer:
                self.frame(self.buffer)
                self.buffer = ''
            self.flush()
            output.extend(self.drain())
        return b''.join(output)

    def drain(self):
        output = []
        for raw, value, original in self.frames:
            if value == original:
                output.append(raw.encode('utf-8'))
            else:
                lines = [line for line in raw.splitlines() if not line.startswith('data:')]
                while lines and not lines[-1]:
                    lines.pop()
                lines.append('data: ' + json.dumps(value, ensure_ascii=False))
                output.append(('\n'.join(lines) + '\n\n').encode('utf-8'))
        self.frames.clear()
        return output



def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode == 'stream':
        mapping = json.loads(sys.stdin.buffer.readline())
        decoder = EventDecoder(mapping)
        while True:
            chunk = sys.stdin.buffer.read1(65536)
            if not chunk:
                break
            sys.stdout.buffer.write(decoder.feed(chunk))
            sys.stdout.buffer.flush()
        sys.stdout.buffer.write(decoder.feed(b'', final=True))
        sys.stdout.buffer.flush()
        return
    request = json.load(sys.stdin)
    if mode == 'validate':
        value = validate(request['settings'])
    elif mode == 'restore':
        value = restore_tree(request['value'], request['mapping'])
    elif mode in ('request', 'preview'):
        value = process(request['settings'], request['value'], mode, request.get('mapping'))
    else:
        raise ValueError('Неизвестная операция движка')
    json.dump(value, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if len(sys.argv) > 1 and sys.argv[1] == 'stream':
            print('Ошибка восстановления потока.', file=sys.stderr)
        else:
            json.dump({'error': str(error)}, sys.stdout, ensure_ascii=False)
        sys.exit(1)
