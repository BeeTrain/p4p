export interface Diagnostics {
  logs: boolean;
  stacktraces: boolean;
  marked: boolean;
  heuristics: boolean;
  tool_output: boolean;
}
export interface Settings {
  version: 1;
  enabled: boolean;
  hosts: string[];
  patterns: string[];
  diagnostics: Diagnostics;
}
export interface SettingsView {
  settings: Settings;
  revision: string;
  path: string;
}
export interface Statistics {
  enabled: boolean;
  replacements: number;
  word_matches: number;
  regex_matches: number;
  fragments: { log: number; stacktrace: number };
}
export interface TransformResult {
  value: unknown;
  mapping: Record<string, string>;
  statistics: Statistics;
  restored?: string;
  fragments?: Array<{ start: number; end: number; kind: string; detector: string }>;
}
