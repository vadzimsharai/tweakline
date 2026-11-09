// The server refuses larger files; checking here gives the person a reason instead of a failed upload.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;

export const dataUrlParts = (dataUrl) => {
  const [head, base64] = String(dataUrl).split(',');
  return { type: head.match(/data:([^;]+)/)?.[1] || 'application/octet-stream', base64: base64 ?? '' };
};

export const base64Bytes = (base64) => Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

// An aborted transaction (a full disk) fires abort, not complete: without it the caller would wait forever.
export function createMediaStore(openDb) {
  return async (mode, run) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const fail = (error) => { db.close(); reject(error || new Error('The gallery could not be saved')); };
      let tx;
      let request;
      try {
        tx = db.transaction('media', mode);
        request = run(tx.objectStore('media'));
      } catch (error) {
        tx?.abort?.();
        fail(error);
        return;
      }
      tx.oncomplete = () => { db.close(); resolve(request?.result); };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
    });
  };
}

// Every attachment is checked before the first upload, so a message never leaves with part of its files.
export async function prepareUploads(ids, read) {
  const uploads = [];
  for (const id of ids) {
    const stored = await read(id);
    if (!stored) throw new Error('An attachment is no longer in the gallery, remove it and try again');
    const { type, base64 } = dataUrlParts(stored.dataUrl);
    const name = stored.name || (stored.kind === 'video' ? 'screen.webm' : 'page.png');
    const bytes = base64Bytes(base64);
    if (bytes > MAX_UPLOAD_BYTES) {
      throw new Error(`${name} is ${(bytes / BYTES_PER_MB).toFixed(1)} MB, the server takes files up to ${MAX_UPLOAD_BYTES / BYTES_PER_MB} MB`);
    }
    uploads.push({ name, type, base64, kind: stored.kind, ownName: stored.name });
  }
  return uploads;
}
