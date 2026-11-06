import { mkdir, writeFile, rename, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeConfigExport(path: string, content: string, overwrite = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    if (overwrite) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Файл экспорта уже существует. Укажите другое имя или --force для замены.');
        throw error;
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
