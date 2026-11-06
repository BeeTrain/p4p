import { render } from 'solid-js/web';
import { Editor, type P4pApi } from '../../src/ui';
import '../../src/ui.css';
async function call(method: string, body = {}) {
  const response = await fetch('/__p4p/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw { message: value.error };
  return value;
}
const api: P4pApi = { get: () => call('get'), save: (settings, revision) => call('save', { settings, revision }), preview: (settings, text, host) => call('preview', { settings, text, host }) };
render(() => <Editor api={api} />, document.getElementById('app')!);
