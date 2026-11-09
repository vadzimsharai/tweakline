import { createMediaStore } from '../lib/media.js';
import { webmDataUrlWithDuration } from '../lib/webm.js';

const MEDIA_DB = 'tweakline-media';
const MEDIA_DB_VERSION = 1;

function mediaDb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(MEDIA_DB, MEDIA_DB_VERSION);
    open.onupgradeneeded = () => open.result.createObjectStore('media', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
const mediaStore = createMediaStore(mediaDb);

export async function addMedia({ kind, dataUrl, poster, url, seconds, durationMs, name }) {
  const playable = kind === 'video' ? webmDataUrlWithDuration(dataUrl, durationMs || seconds * 1000) : dataUrl;
  const item = { id: crypto.randomUUID(), kind, dataUrl: playable, poster, url, seconds, name, at: Date.now() };
  await mediaStore('readwrite', (s) => s.put(item));
  return item.id;
}

export const readMedia = (id) => mediaStore('readonly', (s) => s.get(id));
export const listMedia = () => mediaStore('readonly', (s) => s.getAll());
export const deleteMedia = (ids) => mediaStore('readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
