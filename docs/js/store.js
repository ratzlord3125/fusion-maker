// Everything is kept on the phone itself:
//   - fusion settings (which songs, trims, joins)      -> localStorage
//   - copies of the song files and own join sounds     -> IndexedDB
// Nothing is ever uploaded anywhere.

const DB_NAME = 'fusion-maker';
const INDEX_KEY = 'fm.projects';
const CURRENT_KEY = 'fm.current';
const projectKey = (id) => `fm.project.${id}`;

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy in another tab'));
  });
  return dbPromise;
}

async function run(storeName, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    const req = work(tx.objectStore(storeName));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage was interrupted'));
  });
}

// ------------------------------------------------------------------ song files

/** id -> { id, name, size, type, lastModified, meta, thumb, blob } (blob may be null) */
const records = new Map();
/** Files picked in this visit, usable even when the phone had no room to keep a copy. */
const live = new Map();

export async function loadFileRecords() {
  try {
    for (const rec of (await run('files', 'readonly', (s) => s.getAll())) || []) records.set(rec.id, rec);
  } catch (err) {
    console.warn('Could not read stored songs', err);
  }
  return records;
}

export const fileRecord = (id) => records.get(id) || null;
export const hasFile = (id) => live.has(id) || !!records.get(id)?.blob;

export async function getFile(id) {
  const file = live.get(id) || records.get(id)?.blob;
  if (!file) throw new Error(`Song file ${id} is not on this phone`);
  return file;
}

/** Looks for a file that was already added before (same name, size and date). */
export function findSameFile(file) {
  for (const rec of records.values()) {
    if (rec.name === file.name && rec.size === file.size && rec.lastModified === file.lastModified) return rec;
  }
  return null;
}

/**
 * Remembers a song file. A copy is kept on the phone so the fusion can be reopened later;
 * when there is no room for a copy the file still works until the page is closed.
 */
export async function saveFile(rec, file) {
  live.set(rec.id, file);
  const full = { ...rec, blob: file };
  try {
    await run('files', 'readwrite', (s) => s.put(full));
    records.set(rec.id, full);
    return true;
  } catch (err) {
    console.warn('No room to keep a copy of', rec.name, err);
    dbPromise = null;
    const light = { ...rec, blob: null };
    records.set(rec.id, light);
    try { await run('files', 'readwrite', (s) => s.put(light)); } catch { /* remember it for this visit only */ }
    return false;
  }
}

/** Keeps the description of a file that is not on this phone (after loading a backup). */
export async function saveFileStub(rec) {
  if (records.has(rec.id)) return;
  const light = { ...rec, blob: null };
  records.set(rec.id, light);
  try { await run('files', 'readwrite', (s) => s.put(light)); } catch { /* fine for this visit */ }
}

export async function deleteFiles(ids) {
  for (const id of ids) {
    records.delete(id);
    live.delete(id);
  }
  if (!ids.length) return;
  try {
    await run('files', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
  } catch (err) {
    console.warn('Could not delete stored songs', err);
  }
}

/** Removes stored song files that no saved fusion uses any more. */
export async function tidyFiles() {
  const used = new Set();
  for (const { id } of listProjects()) for (const t of loadProject(id)?.tracks || []) used.add(t.fileId);
  await deleteFiles([...records.keys()].filter((id) => !used.has(id)));
}

export function askToKeepStorage() {
  try { navigator.storage?.persist?.(); } catch { /* optional */ }
}

// ------------------------------------------------------------------ own join sounds

export async function listSounds() {
  try {
    return ((await run('sounds', 'readonly', (s) => s.getAll())) || []).map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}

export async function saveSound(sound) {
  await run('sounds', 'readwrite', (s) => s.put(sound));
}

export async function getSoundBlob(id) {
  try {
    return (await run('sounds', 'readonly', (s) => s.get(id)))?.blob || null;
  } catch {
    return null;
  }
}

export async function deleteSound(id) {
  try { await run('sounds', 'readwrite', (s) => s.delete(id)); } catch { /* already gone */ }
}

// ------------------------------------------------------------------ fusions (projects)

const read = (key) => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};

export function listProjects() {
  const list = read(INDEX_KEY);
  return Array.isArray(list) ? list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
}

export const loadProject = (id) => read(projectKey(id));

/** Returns false when the phone refused to store it (storage full or private browsing). */
export function saveProject(project) {
  try {
    project.updatedAt = Date.now();
    localStorage.setItem(projectKey(project.id), JSON.stringify(project));
    const list = listProjects().filter((p) => p.id !== project.id);
    list.unshift({ id: project.id, name: project.name, updatedAt: project.updatedAt, songs: project.tracks.length });
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    console.warn('Could not save', err);
    return false;
  }
}

export function deleteProject(id) {
  try {
    localStorage.removeItem(projectKey(id));
    localStorage.setItem(INDEX_KEY, JSON.stringify(listProjects().filter((p) => p.id !== id)));
  } catch { /* nothing to do */ }
}

export const currentProjectId = () => {
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
};
export const setCurrentProjectId = (id) => {
  try { localStorage.setItem(CURRENT_KEY, id); } catch { /* optional */ }
};
