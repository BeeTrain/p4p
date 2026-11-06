import { render } from 'solid-js/web';
import { Editor, type BatyaApi } from '../../src/ui';
import '../../src/ui.css';
async function call(method: string, body = {}) {
  const response = await fetch('/__batya/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw { message: value.error };
  return value;
}
const api: BatyaApi = { get: () => call('get'), save: (settings, revision) => call('save', { settings, revision }), preview: (settings, text, host) => call('preview', { settings, text, host }) };
render(() => <Editor api={api} />, document.getElementById('app')!);
