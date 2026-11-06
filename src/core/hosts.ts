export function normalizeHost(input: string): string {
  let text = input.trim().toLowerCase();
  if (!text || /[\s\u0000-\u001f]/.test(text)) throw new Error('Укажите имя хоста или URL без пробелов.');
  const wildcard = text.replace(/^\w+:\/\//, '').startsWith('*.');
  if (wildcard) text = text.replace('*.', '');
  const explicitUrl = /^[a-z]+:\/\//.test(text);
  let url: URL;
  try { url = new URL(explicitUrl ? text : `https://${text}`); }
  catch { throw new Error(`Неверный хост: ${input}`); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Для хоста допустим HTTP(S)/WS(S) URL без учётных данных.');
  if (!explicitUrl && (url.pathname !== '/' || url.search || url.hash)) throw new Error('Укажите хост без пути или полный URL.');
  const hostname = url.hostname.replace(/\.$/, '');
  if (!hostname || hostname.includes('*')) throw new Error('Допустим точный хост или *.example.com.');
  if (wildcard && (hostname.startsWith('[') || /^\d+(\.\d+){3}$/.test(hostname))) throw new Error('Маска поддоменов неприменима к IP-адресу.');
  const authority = text.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  const port = explicitPort ?? url.port;
  if (port && (+port < 1 || +port > 65535)) throw new Error('Порт должен быть от 1 до 65535.');
  return `${wildcard ? '*.' : ''}${hostname}${port ? ':' + Number(port) : ''}`;
}
export function matchesHost(address: string, hosts: string[]): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
  return hosts.some(entry => {
    const match = entry.match(/^(.*?)(?::(\d+))?$/);
    if (!match) return false;
    const host = match[1], expectedPort = match[2];
    if (expectedPort && expectedPort !== port) return false;
    return host.startsWith('*.') ? hostname.endsWith(host.slice(1)) && hostname !== host.slice(2) : hostname === host;
  });
}
