from itertools import groupby
import re


DEFAULT = {'logs': True, 'stacktraces': True, 'marked': True, 'heuristics': True, 'tool_output': False}
LOGCAT = re.compile(r'^\s*\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]+:\s?')
LOG_LINE = re.compile(r'^\s*(?:(?:\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.+Z-]+\s*)?'
                      r'(?:\[?(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|VERBOSE)\]?)(?:\s|[:|]))')
JAVA_HEADER = re.compile(r'^(?:(?:Exception in thread "[^"]+"|Caused by:|Suppressed:)\s*)?'
                         r'(?:[\w$]+\.)*[\w$]*(?:Exception|Error|Throwable)(?::|\s|$)|^FATAL EXCEPTION:')
FRAME = re.compile(r'^\s+at\s+\S+(?:\([^\n]*\)|:\d+(?::\d+)?)\s*$|^\s*\.\.\. \d+ more\s*$')
PYTHON_HEADER = re.compile(r'^Traceback \(most recent call last\):\s*$')
PYTHON_FILE = re.compile(r'^\s+File "[^"]+", line \d+')
FENCE = re.compile(r'^([ \t]*)(`{3,}|~{3,})[ \t]*(log(?:s|cat)?|console|stderr|stdout|stacktrace|traceback|stack|trace)'
                   r'[^\n]*\n', re.IGNORECASE | re.MULTILINE)
TAG = re.compile(r'<(logs?|logcat|console|stderr|stdout|stacktrace|traceback)>\s*', re.IGNORECASE)


def find(text, settings=None, tool_output=False):
    settings = {**DEFAULT, **(settings or {})}
    spans = []
    if settings['tool_output'] and tool_output and text:
        spans.append((0, len(text), 'log', 'source'))
    if settings['marked']:
        for match in FENCE.finditer(text):
            closing = re.search(r'^' + re.escape(match[1]) + re.escape(match[2][0]) +
                                '{' + str(len(match[2])) + r',}[ \t]*\r?$', text[match.end():], re.MULTILINE)
            end = match.end() + closing.start() if closing else len(text)
            kind = 'stacktrace' if match[3].lower() in ('stacktrace', 'traceback', 'stack', 'trace') else 'log'
            spans.append((match.end(), end, kind, 'marked'))
        for match in TAG.finditer(text):
            closing = re.search(r'</' + re.escape(match[1]) + r'\s*>', text[match.end():], re.IGNORECASE)
            if closing:
                kind = 'stacktrace' if match[1].lower() in ('stacktrace', 'traceback') else 'log'
                spans.append((match.end(), match.end() + closing.start(), kind, 'marked'))
    if settings['heuristics']:
        offset, python_trace = 0, False
        for line in text.splitlines(keepends=True):
            raw = line.rstrip('\r\n')
            prefix = LOGCAT.match(raw)
            body = raw[prefix.end():] if prefix else raw
            python_start = bool(PYTHON_HEADER.match(body))
            trace = (python_start or JAVA_HEADER.match(body) or FRAME.match(body) or PYTHON_FILE.match(body) or
                     (python_trace and bool(body[:1].isspace())))
            if trace:
                spans.append((offset, offset + len(line), 'stacktrace', 'heuristics'))
            elif prefix or LOG_LINE.match(raw):
                spans.append((offset, offset + len(line), 'log', 'heuristics'))
            if python_start:
                python_trace = True
            elif python_trace and body and not body[:1].isspace() and not PYTHON_FILE.match(body):
                python_trace = False
            offset += len(line)
    events = [(start, 1, index) for index, (start, end, _, _) in enumerate(spans) if end > start]
    events += [(end, -1, index) for index, (start, end, _, _) in enumerate(spans) if end > start]
    result, active, previous = [], {}, 0
    for position, group in groupby(sorted(events), key=lambda event: event[0]):
        if active and position > previous:
            selected = max(active.values(), key=lambda span: (span[2] == 'stacktrace', span[3] == 'marked'))
            fragment = {'start': previous, 'end': position, 'kind': selected[2], 'detector': selected[3]}
            if result and result[-1]['end'] == previous and all(result[-1][key] == fragment[key] for key in ('kind', 'detector')):
                result[-1]['end'] = position
            else:
                result.append(fragment)
        for _, direction, index in group:
            if direction == 1:
                active[index] = spans[index]
            else:
                active.pop(index, None)
        previous = position
    return result
