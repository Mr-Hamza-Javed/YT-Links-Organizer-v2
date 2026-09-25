/* =========================================================
   lists.js — sidebar lists: render, CRUD, reorder, archive, sync
   ========================================================= */

const Lists = {
  reorderMode: false,
  sortable: null,

  _listsRef: null,

  /* ---------------------------------------------------------
     LIST INDEX (fast sidebar loading)

     Data layout — nothing existing is moved, renamed or deleted:
       users/{uid}/lists/{id}        full list record (metadata + videos),
                                     unchanged and still authoritative
       users/{uid}/listIndex/{id}    small copy of the metadata + item count
       users/{uid}/listIndexMeta     { version, builtAt } — index is built

     • Startup listens to listIndex only; a list's videos are downloaded
       when that list is opened (Videos.selectList).
     • Every metadata write updates lists/{id} AND listIndex/{id} in ONE
       atomic multi-path update (commit), so this app never leaves them
       out of step.
     • heal() re-syncs the index from the real lists (e.g. after an older
       app version or another tab edited lists directly). It only ever
       writes to listIndex.
     • If the index can't be read or written (e.g. database rules), the app
       falls back to "legacy" mode: the original full-lists subscription.
     --------------------------------------------------------- */
  INDEX_VERSION: 1,
  INDEX_FIELDS: ["name", "emoji", "order", "isArchived", "archivedAt", "syncMode", "playlistId", "createdAt"],
  HEAL_INTERVAL: 10 * 60 * 1000,        // min gap between background heals
  FULL_HEAL_INTERVAL: 24 * 3600 * 1000, // full-download heal fallback, per device
  indexMode: false,
  _indexRaw: null,     // latest listIndex snapshot value (all lists incl. archived)
  _detail: {},         // listId -> { view, props } loaded for opened lists
  _pending: {},        // listId -> writes by this session not yet confirmed by the server
  _ackedAt: {},        // listId -> when this session's last write to it was confirmed
  _session: 0,
  _lastHeal: 0,
  _healing: null,

  unsubscribe() {
    this._session++;
    if (this._listsRef) { this._listsRef.off(); this._listsRef = null; }
    this.indexMode = false;
    this._indexRaw = null;
    this._detail = {};
    this._pending = {};
    this._ackedAt = {};
    this._healing = null;
    this._lastHeal = 0;
    this._creatingDefault = false;
  },

  // Metadata copied into the index. Only plain values (string / number, and
  // boolean for isArchived) — the same rule for every source, so a heal
  // never sees a difference that isn't real.
  pickMeta(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    this.INDEX_FIELDS.forEach((f) => {
      const v = raw[f];
      if (typeof v === "string" || typeof v === "number" || (f === "isArchived" && typeof v === "boolean")) out[f] = v;
    });
    return out;
  },

  // Items a list shows — the same rule Videos.selectList uses when rendering.
  countItems(videos) {
    if (!videos || typeof videos !== "object") return 0;
    return Object.values(videos).filter((v) => v && typeof v === "object"
      && (v.type === "note" || v.type === "channel" || v.title || v.thumbnail || v.youtubeId)).length;
  },

  _indexEntryFor(list) {
    return Object.assign(this.pickMeta(list), { count: this.countItems(list && list.videos) });
  },

  // ---------- subscribe to lists ----------
  async subscribe() {
    this.unsubscribe();
    const session = this._session;
    let mode = "legacy";
    try { mode = await this._prepareIndex(session); }
    catch (e) { console.warn("List index unavailable — using full list loading", e); mode = "legacy"; }
    if (session !== this._session) return;   // signed out / switched account meanwhile
    if (mode === "index") this._subscribeIndex(session);
    else this._subscribeLegacy();
    this._wireAutoHeal();
  },

  // Decide the loading mode; build the index once if it doesn't exist yet.
  async _prepareIndex(session) {
    const metaSnap = await DB.listIndexMeta().once("value");
    const meta = metaSnap.val();
    if (meta && meta.version === this.INDEX_VERSION) return "index";
    if (session !== this._session) return "legacy";
    // One-time build: read the lists once (the same download the app used to
    // do on EVERY start) and write only the new listIndex/* paths.
    UI.showLoading("Preparing your library for faster loading (one-time)…");
    try {
      const all = (await DB.lists().once("value")).val() || {};
      if (session !== this._session) return "legacy";
      const upd = {};
      Object.entries(all).forEach(([id, l]) => {
        if (l && typeof l === "object") upd[`listIndex/${id}`] = this._indexEntryFor(l);
      });
      upd.listIndexMeta = { version: this.INDEX_VERSION, builtAt: Date.now() };
      await DB.user().update(upd);
      this._lastFullHealMark();   // the build was a full read — no full/deep heal needed today
      this._lastDeepHealMark();
      return "index";
    } finally { UI.hideLoading(); }
  },

  _subscribeIndex(session) {
    this.indexMode = true;
    this._listsRef = DB.listIndex();
    this._listsRef.on("value", (snap) => {
      if (session !== this._session) return;
      this._indexRaw = snap.val() || {};
      this._rebuildFromIndex();
      const nonArchived = Object.values(this._indexRaw).filter((l) => l && typeof l === "object" && !l.isArchived);
      if (!nonArchived.length) { this._ensureDefaultList(session); return; }
      this._afterListsChanged();
    }, (err) => {
      // e.g. read permission revoked — fall back to the original behaviour
      console.warn("List index listener cancelled", err);
      if (session === this._session) this.switchToLegacy();
    });
    // bring the index up to date with the real lists, in the background
    setTimeout(() => { if (session === this._session) this.heal(); }, 1500);
  },

  // State.lists = non-archived lists + temporarily-opened archived ones.
  _rebuildFromIndex() {
    State.lists = {};
    Object.entries(this._indexRaw || {}).forEach(([id, e]) => {
      if (!e || typeof e !== "object") return;
      const l = Object.assign({}, e, { id });
      const d = this._detail[id];
      if (d) { if ("view" in d) l.view = d.view; if ("props" in d) l.props = d.props; }
      if (!l.isArchived || State.archivedOpen.has(id)) State.lists[id] = l;
    });
  },

  // Shared tail of both listeners: render + keep a list selected.
  _afterListsChanged() {
    Videos.pruneSubs();   // release live listeners of lists that are gone
    this.render();
    // select a list if none active
    if (!State.activeListId || !State.lists[State.activeListId]) {
      const first = this.ordered()[0];
      if (first) Videos.selectList(first.id);
    } else {
      // refresh active highlighting + title
      Videos.refreshActiveHeader();
    }
  },

  // No active list in the index. Re-check against the real lists first so a
  // stale index can never cause a spurious "My Videos" list.
  async _ensureDefaultList(session) {
    if (this._creatingDefault) return;
    this._creatingDefault = true;
    try {
      try { await this.heal({ force: true }); } catch (e) { console.warn("heal before default list failed", e); }
      if (session !== this._session || !this.indexMode) return;
      const nonArchived = Object.values(this._indexRaw || {}).filter((l) => l && typeof l === "object" && !l.isArchived);
      if (!nonArchived.length) await this.createList("My Videos");
    } finally { if (session === this._session) this._creatingDefault = false; }
  },

  switchToLegacy() {
    if (!this.indexMode) return;
    console.warn("Switching to full list loading (legacy mode)");
    if (this._listsRef) { this._listsRef.off(); this._listsRef = null; }
    this.indexMode = false;
    this._indexRaw = null;
    this._subscribeLegacy();
  },

  // Detail (view / props) of an opened list — supplied by Videos.selectList.
  setDetail(listId, key, val) {
    if (!this._detail[listId]) this._detail[listId] = {};
    this._detail[listId][key] = val == null ? undefined : val;
    const l = State.lists[listId];
    if (l) { if (val == null) delete l[key]; else l[key] = val; }
  },

  // Are two view/props values the same once Firebase's storage quirks are
  // ignored (it drops empty arrays/objects and returns keys sorted)?
  sameDetail(key, a, b, list) {
    const stable = (v) => {
      if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
      if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
      return JSON.stringify(v === undefined ? null : v);
    };
    if (key === "view") {
      const fields = Grouping.resolveFields(list);
      return stable(Grouping.normalize(a, fields)) === stable(Grouping.normalize(b, fields));
    }
    const normProps = (p) => {
      const out = {};
      Object.entries(p && typeof p === "object" ? p : {}).forEach(([k, x]) => {
        out[k] = x && typeof x === "object" ? Object.assign({}, x, { options: Array.isArray(x.options) ? x.options : [] }) : x;
      });
      return out;
    };
    return stable(normProps(a)) === stable(normProps(b));
  },

  // ---------- writes ----------
  // Every list-metadata write goes through here. `paths` are relative to
  // users/{uid}; listIndex/* paths are dropped in legacy mode. In index mode
  // the whole set is ONE atomic update, so lists and listIndex stay in step.
  async commit(paths) {
    // track in-flight writes per list so heal() never "corrects" the index
    // from server data that doesn't include them yet
    const ids = new Set();
    Object.keys(paths).forEach((p) => {
      const m = p.match(/^(?:lists|listIndex)\/([^/]+)/);
      if (m) ids.add(m[1]);
    });
    const session = this._session;
    ids.forEach((id) => { this._pending[id] = (this._pending[id] || 0) + 1; });
    try { await this._commitNow(paths); }
    finally {
      if (session === this._session) {
        const now = Date.now();
        ids.forEach((id) => { this._pending[id] = Math.max(0, (this._pending[id] || 1) - 1); this._ackedAt[id] = now; });
      }
    }
  },

  async _commitNow(paths) {
    const listsOnly = {};
    Object.keys(paths).forEach((p) => { if (!p.startsWith("listIndex/")) listsOnly[p] = paths[p]; });
    if (!this.indexMode) {
      if (Object.keys(listsOnly).length) await DB.user().update(listsOnly);
      return;
    }
    try {
      await DB.user().update(paths);
    } catch (e) {
      const hadIndexPaths = Object.keys(listsOnly).length !== Object.keys(paths).length;
      if (!hadIndexPaths) throw e;
      // Maybe only the index write was refused: retry the real data alone
      // (if that fails too, the caller reports the error as before).
      if (Object.keys(listsOnly).length) await DB.user().update(listsOnly);
      this.switchToLegacy();
    }
  },

  // Metadata update for one list, mirrored into the index.
  async updateMeta(listId, fields) {
    const paths = {};
    Object.entries(fields).forEach(([k, v]) => {
      paths[`lists/${listId}/${k}`] = v === undefined ? null : v;
      if (this.INDEX_FIELDS.includes(k)) {
        const picked = this.pickMeta({ [k]: v });
        paths[`listIndex/${listId}/${k}`] = k in picked ? picked[k] : null;
      }
    });
    return this.commit(paths);
  },

  // Create a full list record (+ its index entry) under a new id.
  async createListRecord(listId, data) {
    return this.commit({ [`lists/${listId}`]: data, [`listIndex/${listId}`]: this._indexEntryFor(data) });
  },

  // Delete a list (+ its index entry).
  async removeList(listId) {
    return this.commit({ [`lists/${listId}`]: null, [`listIndex/${listId}`]: null });
  },

  // Keep the sidebar count right after this app changed a list's items.
  // Index-only write; never creates an entry for a list that isn't indexed.
  setCount(listId, n) {
    if (!this.indexMode) return;
    setTimeout(() => {   // let a same-tick delete land first
      if (!this.indexMode) return;
      const e = this._indexRaw && this._indexRaw[listId];
      if (!e || typeof e !== "object" || e.count === n) return;
      DB.listIndex().child(listId).child("count").set(n).catch(() => {});
    }, 0);
  },

  // Name / archived info for ALL lists (incl. archived) — from the index in
  // index mode, otherwise from a full read as before.
  async allListsMeta() {
    if (this.indexMode && this._indexRaw) {
      const out = {};
      Object.entries(this._indexRaw).forEach(([id, e]) => { if (e && typeof e === "object") out[id] = Object.assign({}, e); });
      return out;
    }
    const snap = await DB.lists().once("value");
    return snap.val() || {};
  },

  /* ---------- heal: re-sync listIndex from the real lists ----------
     Needed only when something other than this app version changed lists
     (an older version, another open tab, the console). Only listIndex/* is
     ever written; list data is only read.
       • every run: list KEYS via the REST API's `shallow` option (one tiny
         request) → adds lists the index lacks (read once, exactly) and drops
         entries whose list is gone.
       • once a day (per device) or when forced: plain fields of every list
         (small single-value reads) + item counts (shallow key lists).
       • REST unavailable → one full read instead, at most once a day.
     The open list is additionally kept exact live (healActiveMeta). */
  heal({ force = false, deep = false } = {}) {
    if (!this.indexMode || !State.uid) return Promise.resolve();
    if (this._healing) return this._healing;
    if (!force && Date.now() - this._lastHeal < this.HEAL_INTERVAL) return Promise.resolve();
    const session = this._session;
    this._healing = this._doHeal(session, force, deep)
      .catch((e) => console.warn("list index heal failed", e))
      .finally(() => { if (session === this._session) { this._healing = null; this._lastHeal = Date.now(); } });
    return this._healing;
  },

  async _doHeal(session, force, deep) {
    const uid = State.uid;
    const startedAt = Date.now();
    // snapshot BEFORE reading the source: an entry present now whose list is
    // missing from the source was really deleted (lists + index are always
    // written together by this app).
    const before = JSON.parse(JSON.stringify(this._indexRaw || {}));
    let source; // id -> { meta?, count? }  (missing meta/count = not checked this run)
    try {
      source = await this._readSource(uid, before, deep || Date.now() - this._lastDeepHealAt() >= this.FULL_HEAL_INTERVAL);
    } catch (e) {
      if (!force && Date.now() - this._lastFullHealAt() < this.FULL_HEAL_INTERVAL) return;
      const all = (await DB.lists().once("value")).val() || {};
      source = {};
      Object.entries(all).forEach(([id, l]) => {
        if (l && typeof l === "object") source[id] = { meta: this.pickMeta(l), count: this.countItems(l.videos) };
      });
      this._lastFullHealMark();
      this._lastDeepHealMark();
    }
    if (session !== this._session || !this.indexMode || State.uid !== uid) return;

    const cur = this._indexRaw || {};
    // lists this session wrote while the source was being read: the source
    // may predate that write, so leave them alone this round
    const busy = (id) => (this._pending[id] || 0) > 0 || (this._ackedAt[id] || 0) >= startedAt;
    const same = (a, b) => (a == null ? null : a) === (b == null ? null : b);
    const upd = {};
    Object.entries(source).forEach(([id, src]) => {
      if (busy(id)) return;
      const now = cur[id];
      if (!now || typeof now !== "object") {
        if (before[id] || !src.meta) return;      // removed locally meanwhile / nothing to add
        upd[`listIndex/${id}`] = Object.assign({}, src.meta, { count: src.count != null ? src.count : 0 });
        return;
      }
      const was = before[id] || {};
      if (src.meta) {
        this.INDEX_FIELDS.forEach((f) => {
          // skip a field that changed in the index during the heal (a newer write)
          if (!same(now[f], was[f])) return;
          if (!same(now[f], src.meta[f])) upd[`listIndex/${id}/${f}`] = f in src.meta ? src.meta[f] : null;
        });
      }
      // the open list's count is kept exact by its own listener
      if (src.count != null && id !== State.activeListId && same(now.count, was.count) && !same(now.count, src.count)) {
        upd[`listIndex/${id}/count`] = src.count;
      }
    });
    // index entries whose list no longer exists. Safety: an empty source
    // while the index has lists is never treated as "everything deleted"
    // (the app never lets the last list be deleted) — nothing is removed.
    const sourceEmpty = Object.keys(source).length === 0;
    Object.keys(before).forEach((id) => {
      if (sourceEmpty || source[id] || busy(id)) return;
      // skip if its metadata was rewritten meanwhile (the item count is
      // derived and may drop to 0 as the list disappears — ignore it)
      const metaOf = (e) => JSON.stringify(this.pickMeta(e || {}));
      if (!cur[id] || metaOf(cur[id]) !== metaOf(before[id])) return;
      upd[`listIndex/${id}`] = null;
    });
    if (!Object.keys(upd).length) return;
    try { await DB.user().update(upd); }
    catch (e) { console.warn("list index heal write refused", e); if (session === this._session) this.switchToLegacy(); }
  },

  // REST GET (shallow → keys only, every value is `true`)
  async _rest(path, shallow = true) {
    const user = fbAuth.currentUser;
    if (!user) throw new Error("not signed in");
    const token = await user.getIdToken();
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const url = `${FIREBASE_CONFIG.databaseURL}/${enc}.json?${shallow ? "shallow=true&" : ""}auth=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`REST ${res.status}`);
    return res.json();
  },

  async _readSource(uid, before, deep) {
    const keys = await this._rest(`users/${uid}/lists`);
    if (keys !== null && typeof keys !== "object") throw new Error("unexpected shallow response");
    const ids = Object.keys(keys || {});
    const source = {};
    ids.forEach((id) => { source[id] = {}; });
    const pool = async (arr, fn) => {
      let i = 0;
      const worker = async () => { while (i < arr.length) await fn(arr[i++]); };
      await Promise.all(Array.from({ length: Math.min(6, arr.length) }, worker));
    };
    // lists the index doesn't know yet: read each once, exactly
    await pool(ids.filter((id) => !before[id]), async (id) => {
      const l = (await DB.lists().child(id).once("value")).val();
      if (l && typeof l === "object") source[id] = { meta: this.pickMeta(l), count: this.countItems(l.videos) };
      else delete source[id];                    // vanished between the two reads
    });
    if (deep) {
      await pool(ids.filter((id) => before[id]), async (id) => {
        const base = DB.lists().child(id);
        const vals = await Promise.all(this.INDEX_FIELDS.map((f) => base.child(f).once("value").then((sn) => sn.val())));
        const raw = {};
        this.INDEX_FIELDS.forEach((f, k) => { raw[f] = vals[k]; });
        const vk = await this._rest(`users/${uid}/lists/${id}/videos`);
        source[id] = { meta: this.pickMeta(raw), count: vk && typeof vk === "object" ? Object.keys(vk).length : 0 };
      });
      this._lastDeepHealMark();
    }
    return source;
  },

  // Open list: its record is live anyway (Videos.selectList), so keep its
  // index entry exact. Only fields that changed at the source are written.
  healActiveMeta(listId, meta, lastMeta) {
    if (!this.indexMode) return;
    const e = this._indexRaw && this._indexRaw[listId];
    if (!e || typeof e !== "object" || (this._pending[listId] || 0) > 0) return;
    const same = (a, b) => (a == null ? null : a) === (b == null ? null : b);
    const upd = {};
    this.INDEX_FIELDS.forEach((f) => {
      const changedAtSource = !lastMeta || !same(lastMeta[f], meta[f]);
      if (changedAtSource && !same(e[f], meta[f])) upd[`listIndex/${listId}/${f}`] = f in meta ? meta[f] : null;
    });
    if (Object.keys(upd).length) DB.user().update(upd).catch(() => {});
  },

  // The open list's record disappeared. If this session didn't delete it
  // (its own deletes update the index in the same write), re-sync the index.
  onActiveListGone(listId) {
    if (!this.indexMode || (this._pending[listId] || 0) > 0) return;
    this.heal({ force: true });
  },

  _deepHealKey() { return `ylo_deepheal_${State.uid}`; },
  _lastDeepHealAt() { try { return parseInt(localStorage.getItem(this._deepHealKey()) || "0", 10) || 0; } catch (e) { return 0; } },
  _lastDeepHealMark() { try { localStorage.setItem(this._deepHealKey(), String(Date.now())); } catch (e) {} },
  _fullHealKey() { return `ylo_fullheal_${State.uid}`; },
  _lastFullHealAt() { try { return parseInt(localStorage.getItem(this._fullHealKey()) || "0", 10) || 0; } catch (e) { return 0; } },
  _lastFullHealMark() { try { localStorage.setItem(this._fullHealKey(), String(Date.now())); } catch (e) {} },

  // re-check when the tab comes back into view (throttled inside heal)
  _wireAutoHeal() {
    if (this._autoHealWired) return;
    this._autoHealWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && State.uid && this.indexMode) this.heal();
    });
  },

  // ---------- LEGACY: original full-lists subscription ----------
  _subscribeLegacy() {
    this.indexMode = false;
    const session = this._session;
    this._listsRef = DB.lists();
    this._listsRef.on("value", (snap) => {
      if (session !== this._session) return;
      const all = snap.val() || {};
      State.lists = {};
      Object.entries(all).forEach(([id, l]) => {
        l.id = id;
        if (!l.isArchived || State.archivedOpen.has(id)) State.lists[id] = l;
      });
      // ensure at least one list exists
      const nonArchived = Object.values(all).filter((l) => !l.isArchived);
      if (Object.keys(all).length === 0 || nonArchived.length === 0) {
        if (!this._creatingDefault) { this._creatingDefault = true; this.createList("My Videos").then(() => this._creatingDefault = false); }
        return;
      }
      this._afterListsChanged();
    });
  },

  ordered() {
    const arr = Object.values(State.lists);
    arr.sort((a, b) => {
      // archived-open ones go last
      const aa = a.isArchived ? 1 : 0, ba = b.isArchived ? 1 : 0;
      if (aa !== ba) return aa - ba;
      return (a.order ?? 0) - (b.order ?? 0);
    });
    return arr;
  },

  render() {
    const cont = document.getElementById("listContainer");
    document.getElementById("listEmptyMsg").hidden = true;
    const lists = this.ordered();
    cont.innerHTML = lists.map((l) => this.itemHtml(l)).join("");

    cont.querySelectorAll(".list-item").forEach((el) => {
      const id = el.dataset.id;
      el.addEventListener("click", (e) => {
        if (e.target.closest(".list-item__menu") || e.target.closest(".list-item__handle")) return;
        // already open → nothing to reload (just close the mobile drawer)
        if (id !== State.activeListId) Videos.selectList(id);
        if (window.innerWidth <= 820) App.closeDrawer();
      });
      const menuBtn = el.querySelector(".list-item__menu");
      if (menuBtn) menuBtn.addEventListener("click", (e) => { e.stopPropagation(); this.openListMenu(menuBtn, id); });
    });

    this.renderReorderBanner();
    this.setupSortable();
  },

  // Visible affordance to leave reorder mode (the only other toggle is buried
  // inside a list's ⋯ menu, which users couldn't find).
  renderReorderBanner() {
    const nav = document.querySelector(".sidebar__nav");
    if (!nav) return;
    let banner = document.getElementById("reorderBanner");
    if (this.reorderMode) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "reorderBanner";
        banner.className = "reorder-banner";
        nav.insertBefore(banner, nav.firstChild);
      }
      banner.innerHTML = `<span class="reorder-banner__txt">↕ Drag handles to reorder</span>
        <button class="reorder-banner__done" id="reorderDoneBtn">Done</button>`;
      banner.querySelector("#reorderDoneBtn").addEventListener("click", () => this.toggleReorder());
    } else if (banner) {
      banner.remove();
    }
  },

  itemHtml(l) {
    const emoji = l.emoji || Utils.autoEmoji(l.name);
    const name = Utils.stripLeadingEmoji(l.name) || l.name;
    // legacy mode has the full videos; index mode has the stored count
    const count = l.videos ? Object.keys(l.videos).length : (typeof l.count === "number" ? l.count : (l._count || 0));
    const active = l.id === State.activeListId ? "is-active" : "";
    const arch = l.isArchived ? "is-archived-open" : "";
    return `
      <li class="list-item ${active} ${arch}" data-id="${l.id}" data-name="${Utils.escapeHtml(name)}" title="${Utils.escapeHtml(name)}" data-archived="${l.isArchived ? 1 : 0}" data-sync="${l.syncMode || "none"}">
        <span class="list-item__handle" title="Drag to reorder">
          <svg viewBox="0 0 24 24" width="14" height="14"><circle cx="9" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </span>
        <span class="list-item__emoji">${emoji}</span>
        <span class="list-item__name">${Utils.escapeHtml(name)}</span>
        ${count ? `<span class="list-item__count">${count}</span>` : ""}
        <button class="list-item__menu" aria-label="List actions" data-popover-trigger>⋯</button>
      </li>`;
  },

  setupSortable() {
    if (this.sortable) { this.sortable.destroy(); this.sortable = null; }
    if (!this.reorderMode) return;
    const cont = document.getElementById("listContainer");
    this.sortable = Sortable.create(cont, {
      handle: ".list-item__handle",
      animation: 150,
      filter: '[data-archived="1"]',
      onMove: (evt) => evt.related.dataset.archived !== "1",
      onEnd: () => this.saveOrder(),
    });
  },

  async saveOrder() {
    const ids = [...document.querySelectorAll(".list-item")]
      .filter((el) => el.dataset.archived !== "1")
      .map((el) => el.dataset.id);
    const updates = {};
    ids.forEach((id, i) => { updates[`lists/${id}/order`] = i; updates[`listIndex/${id}/order`] = i; });
    try { await this.commit(updates); UI.toast("List order saved", "success", 1500); }
    catch (e) { UI.toast("Couldn't save order", "error"); }
  },

  toggleReorder() {
    this.reorderMode = !this.reorderMode;
    document.getElementById("app").classList.toggle("reorder-lists", this.reorderMode);
    this.renderReorderBanner();
    this.setupSortable();
    UI.toast(this.reorderMode ? "Reorder mode on — drag the handles" : "Reorder mode off", "info", 1800);
  },

  // ---------- list actions menu ----------
  openListMenu(btn, id) {
    const l = State.lists[id];
    if (!l) return;
    const items = [
      { key: "refresh", ico: "🔄", text: "Refresh Data", onClick: () => Videos.refreshList(id) },
      { key: "reorder", ico: "↕️", text: this.reorderMode ? "Done Reordering" : "Reorder Lists", onClick: () => this.toggleReorder() },
      { key: "rename", ico: "✏️", text: "Rename", onClick: () => this.renameList(id) },
      { key: "emoji", ico: "😀", text: "Change Emoji", onClick: () => this.changeEmoji(id) },
      { divider: true },
      { key: "archive", ico: "🗄️", text: l.isArchived ? "Unarchive" : "Archive", onClick: () => l.isArchived ? this.unarchive(id) : this.archive(id) },
      { key: "delete", ico: "🗑️", text: "Delete", danger: true, onClick: () => this.deleteList(id) },
    ];
    UI.floatingMenu(btn, items, { align: "right" });
  },

  // ---------- CREATE ----------
  openCreateModal() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    UI.openModal({
      title: "Create List",
      bodyHtml: `
        <div class="field">
          <label>List name <span style="color:var(--accent)">*</span></label>
          <input class="input" id="clName" placeholder="e.g. ⭐ Favorites" />
        </div>
        <div class="field">
          <label>YouTube playlist link <span style="color:var(--text-3)">(optional)</span></label>
          <input class="input" id="clPlaylist" placeholder="https://youtube.com/playlist?list=…" />
        </div>
        <div class="field">
          <label>Playlist mode</label>
          <select class="select" id="clMode">
            <option value="none">None — normal manual list</option>
            <option value="sync">Sync — mirror playlist exactly (no manual adds)</option>
            <option value="pull">Pull — add new playlist videos, keep deletions</option>
          </select>
          <p class="hint" id="clModeHint">A normal list you add videos to yourself.</p>
        </div>`,
      footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                 <button class="btn btn--primary" data-act="create">Create List</button>`,
      onMount: (modal, close) => {
        const nameEl = modal.querySelector("#clName");
        const plEl = modal.querySelector("#clPlaylist");
        const modeEl = modal.querySelector("#clMode");
        const hint = modal.querySelector("#clModeHint");
        nameEl.focus();
        const hints = {
          none: "A normal list you add videos to yourself.",
          sync: "Strictly mirrors the playlist — adds & removes to match. Manual adding is blocked.",
          pull: "Adds new playlist videos but keeps ones you delete. Manual adding still allowed.",
        };
        modeEl.addEventListener("change", () => { hint.textContent = hints[modeEl.value]; });
        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        modal.querySelector('[data-act="create"]').addEventListener("click", async () => {
          const name = nameEl.value.trim();
          if (!name) { nameEl.focus(); UI.toast("List name is required", "error"); return; }
          const mode = modeEl.value;
          let playlistId = null;
          if (plEl.value.trim()) {
            playlistId = Utils.parsePlaylistId(plEl.value.trim());
            if (!playlistId) { UI.toast("Couldn't read that playlist link", "error"); return; }
          }
          if (mode !== "none" && !playlistId) { UI.toast("Sync/Pull modes need a playlist link", "error"); return; }
          close();
          const newId = await this.createList(name, { playlistId, syncMode: mode });
          if (newId) {
            Videos.selectList(newId);
            if (playlistId && mode !== "none") Videos.reconcilePlaylist(newId);
          }
        });
        nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") modal.querySelector('[data-act="create"]').click(); });
      },
    });
  },

  async createList(name, opts = {}) {
    if (!State.uid) return null;
    const ref = DB.lists().push();
    const id = ref.key;
    const maxOrder = Math.max(-1, ...Object.values(State.lists).filter((l) => !l.isArchived).map((l) => l.order ?? 0));
    const emoji = Utils.autoEmoji(name);
    const data = {
      name,
      emoji,
      playlistId: opts.playlistId || null,
      syncMode: opts.syncMode || "none",
      order: maxOrder + 1,
      createdAt: Date.now(),
      isArchived: false,
      archivedAt: null,
    };
    try {
      await this.createListRecord(id, data);
      UI.toast(`Created “${Utils.stripLeadingEmoji(name) || name}”`, "success");
      return id;
    } catch (e) { UI.toast("Couldn't create list: " + e.message, "error"); return null; }
  },

  async renameList(id) {
    const l = State.lists[id];
    if (!l) return;
    const name = await UI.prompt({ title: "Rename List", label: "List name", value: l.name, confirmText: "Rename" });
    if (name == null || !name.trim()) return;
    const emoji = Utils.leadingEmoji(name) || l.emoji || Utils.autoEmoji(name);
    try {
      await this.updateMeta(id, { name: name.trim(), emoji });
      UI.toast("List renamed", "success", 1500);
    } catch (e) { UI.toast("Couldn't rename list: " + e.message, "error"); }
  },

  async changeEmoji(id) {
    const l = State.lists[id];
    if (!l) return;
    const input = await UI.prompt({ title: "Change Emoji", label: "Type an emoji (leave blank to auto-pick)", value: l.emoji || "", placeholder: "📂", confirmText: "Set" });
    if (input == null) return;
    let emoji;
    if (!input.trim()) emoji = Utils.autoEmoji(l.name);
    else if (Utils.isEmoji(input.trim())) emoji = Utils.leadingEmoji(input.trim()) || input.trim();
    else { UI.toast("That doesn't look like an emoji — auto-picking", "info"); emoji = Utils.autoEmoji(l.name); }
    try {
      await this.updateMeta(id, { emoji });
      UI.toast("Emoji updated", "success", 1500);
    } catch (e) { UI.toast("Couldn't update emoji: " + e.message, "error"); }
  },

  async deleteList(id) {
    const l = State.lists[id];
    if (!l) return;
    // Only active (non-archived) lists count here: a temporarily-opened
    // archived list must not let the last active list be deleted.
    const activeCount = Object.values(State.lists).filter((x) => !x.isArchived).length;
    if (!l.isArchived && activeCount <= 1) {
      UI.toast("Can't delete your last list", "error"); return;
    }
    const ok = await UI.confirm({
      title: "Delete list?",
      message: `“${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}” and all its videos & notes will be permanently deleted.`,
      confirmText: "Delete",
    });
    if (!ok) return;
    try {
      await this.removeList(id);
    } catch (e) { UI.toast("Couldn't delete list: " + e.message, "error"); return; }
    State.archivedOpen.delete(id);
    if (State.activeListId === id) {
      State.activeListId = null;
      const next = this.ordered()[0];
      if (next) Videos.selectList(next.id);
      else Videos.clearGrid();
    }
    UI.toast("List deleted", "success");
  },

  async archive(id) {
    const nonArchived = Object.values(State.lists).filter((l) => !l.isArchived);
    if (nonArchived.length <= 1) { UI.toast("Can't archive your only active list", "error"); return; }
    const l = State.lists[id];
    const ok = await UI.confirm({
      title: "Archive list?",
      message: `“${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}” will be hidden from the sidebar. You can restore it anytime from Archived Lists.`,
      confirmText: "Archive", danger: false,
    });
    if (!ok) return;
    try {
      await this.updateMeta(id, { isArchived: true, archivedAt: Date.now() });
    } catch (e) { UI.toast("Couldn't archive list: " + e.message, "error"); return; }
    State.archivedOpen.delete(id);
    if (State.activeListId === id) {
      const next = this.ordered().find((x) => x.id !== id);
      if (next) Videos.selectList(next.id);
    }
    UI.toast("List archived", "success");
  },

  async unarchive(id) {
    const maxOrder = Math.max(-1, ...Object.values(State.lists).filter((l) => !l.isArchived).map((l) => l.order ?? 0));
    try {
      await this.updateMeta(id, { isArchived: false, archivedAt: null, order: maxOrder + 1 });
    } catch (e) { UI.toast("Couldn't restore list: " + e.message, "error"); return false; }
    State.archivedOpen.delete(id);
    UI.toast("List restored", "success");
    return true;
  },

  // ---------- ARCHIVED LISTS modal ----------
  async openArchivedModal() {
    if (!State.uid) { UI.toast("Please sign in", "info"); return; }
    UI.showLoading("Loading archived lists…");
    let archived = [];
    try {
      const all = await this.allListsMeta();
      archived = Object.entries(all).filter(([, l]) => l && l.isArchived).map(([id, l]) => ({ id, ...l }));
    } catch (e) {
      UI.toast("Couldn't load archived lists: " + e.message, "error");
      return;
    } finally { UI.hideLoading(); }

    const body = archived.length ? `<div class="archived-list">${archived.map((l) => `
      <div class="archived-row" data-id="${l.id}">
        <span class="list-item__emoji">${l.emoji || Utils.autoEmoji(l.name)}</span>
        <span class="archived-row__name">${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}</span>
        <span class="archived-row__date mono">${Utils.timeAgo(l.archivedAt)}</span>
        <div class="archived-row__actions">
          <button class="btn btn--ghost btn--sm" data-act="open">Open</button>
          <button class="btn btn--ghost btn--sm" data-act="unarchive">Restore</button>
          <button class="btn btn--danger btn--sm" data-act="delete">Delete</button>
        </div>
      </div>`).join("")}</div>`
      : `<p style="color:var(--text-3);text-align:center;padding:40px 0;">No archived lists.</p>`;

    UI.openModal({
      title: "Archived Lists",
      bodyHtml: body + `<style>
        .archived-list{display:flex;flex-direction:column;gap:8px;}
        .archived-row{display:flex;align-items:center;gap:11px;padding:11px 12px;background:var(--bg-elevated);border:1px solid var(--border-soft);border-radius:var(--radius-sm);}
        .archived-row__name{flex:1;font-weight:550;}
        .archived-row__date{font-size:11px;color:var(--text-3);}
        .archived-row__actions{display:flex;gap:6px;}
        .btn--sm{padding:5px 9px;font-size:12px;}
        @media(max-width:560px){.archived-row{flex-wrap:wrap;}.archived-row__actions{width:100%;}}
      </style>`,
      onMount: (modal, close) => {
        modal.querySelectorAll(".archived-row").forEach((row) => {
          const id = row.dataset.id;
          row.querySelector('[data-act="open"]').addEventListener("click", () => {
            State.archivedOpen.add(id);
            close();
            // Reload lists (so the archived one is in State.lists) THEN open it.
            // Running selectList before forceReload's async data landed was why
            // it appeared in the sidebar but never opened on its own.
            this.forceReload().then(() => Videos.selectList(id))
              .catch((e) => UI.toast("Couldn't open list: " + e.message, "error"));
          });
          row.querySelector('[data-act="unarchive"]').addEventListener("click", async () => {
            if (await this.unarchive(id)) row.remove();
          });
          row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
            const ok = await UI.confirm({ title: "Delete archived list?", message: "This permanently removes the list and its videos.", confirmText: "Delete" });
            if (!ok) return;
            try {
              await this.removeList(id); row.remove();
              UI.toast("List deleted", "success");
            } catch (e) { UI.toast("Couldn't delete list: " + e.message, "error"); }
          });
        });
      },
    });
  },

  forceReload() {
    if (this.indexMode && this._indexRaw) {   // index already holds every list
      this._rebuildFromIndex();
      this.render();
      return Promise.resolve();
    }
    return DB.lists().once("value").then((snap) => {
      const all = snap.val() || {};
      State.lists = {};
      Object.entries(all).forEach(([id, l]) => {
        l.id = id;
        if (!l.isArchived || State.archivedOpen.has(id)) State.lists[id] = l;
      });
      this.render();
    });
  },
};
