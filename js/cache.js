/* =========================================================
   cache.js — per-device copy of each opened list (IndexedDB)

   Lets a list show instantly when it's opened, while its live data is
   downloading. The copy is only ever DISPLAYED (read-only preview); every
   write in the app still works on live Firebase data. Stored per signed-in
   user and removed on log out. Any IndexedDB problem (private mode, quota,
   old browser) simply means "no copy" — the app works the same without it.
   ========================================================= */

const ListCache = {
  DB_NAME: "ylo-list-cache",
  STORE: "lists",
  _dbp: null,

  _open() {
    if (this._dbp) return this._dbp;
    this._dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(this.STORE)) req.result.createObjectStore(this.STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    this._dbp.catch(() => { this._dbp = null; });
    return this._dbp;
  },

  _key(uid, listId) { return `${uid}/${listId}`; },

  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, mode);
      const out = fn(tx.objectStore(this.STORE));
      tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  // -> { videos, view, props, savedAt } | null
  async get(uid, listId) {
    if (!uid || !listId) return null;
    try { return (await this._tx("readonly", (st) => st.get(this._key(uid, listId)))) || null; }
    catch (e) { return null; }
  },

  async put(uid, listId, data) {
    if (!uid || !listId) return;
    try { await this._tx("readwrite", (st) => st.put(Object.assign({}, data, { savedAt: Date.now() }), this._key(uid, listId))); }
    catch (e) { /* no copy this time — harmless */ }
  },

  async remove(uid, listId) {
    if (!uid || !listId) return;
    try { await this._tx("readwrite", (st) => st.delete(this._key(uid, listId))); } catch (e) {}
  },

  // everything stored for one user (log out)
  async clearUser(uid) {
    if (!uid) return;
    try { await this._tx("readwrite", (st) => st.delete(IDBKeyRange.bound(`${uid}/`, `${uid}/￿`))); } catch (e) {}
  },
};
