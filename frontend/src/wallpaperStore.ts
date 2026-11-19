interface SavedWallpaper { image: Blob; name: string }
const STORE = "wallpapers";
const KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("stridemix.appearance", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("壁纸存储暂时被其他页面占用，请关闭旧页面后重试。"));
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    try {
      const tx = database.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => { database.close(); resolve(request.result); };
      tx.onabort = tx.onerror = () => { database.close(); reject(tx.error ?? request.error); };
    } catch (error) { database.close(); reject(error); }
  });
}

export async function loadWallpaper(): Promise<SavedWallpaper | null> {
  const value: unknown = await transaction("readonly", store => store.get(KEY));
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<SavedWallpaper>;
  return saved.image instanceof Blob && typeof saved.name === "string"
    ? { image: saved.image, name: saved.name } : null;
}

export async function saveWallpaper(image: Blob, name: string) {
  await transaction("readwrite", store => store.put({ image, name }, KEY));
}

export async function deleteWallpaper() {
  await transaction("readwrite", store => store.delete(KEY));
}
