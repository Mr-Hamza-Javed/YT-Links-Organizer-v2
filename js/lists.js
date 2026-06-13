/* =========================================================
   lists.js — sidebar lists: render, CRUD, reorder, archive, sync
   ========================================================= */

const Lists = {
  reorderMode: false,
  sortable: null,

  _listsRef: null,

  unsubscribe() {
    if (this._listsRef) { this._listsRef.off(); this._listsRef = null; }
  },

  // ---------- subscribe to lists ----------
  subscribe() {
    this.unsubscribe();
    this._listsRef = DB.lists();
    this._listsRef.on("value", (snap) => {
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
      this.render();
      // select a list if none active
      if (!State.activeListId || !State.lists[State.activeListId]) {
        const first = this.ordered()[0];
        if (first) Videos.selectList(first.id);
      } else {
        // refresh active highlighting + title
        Videos.refreshActiveHeader();
      }
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
        Videos.selectList(id);
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
    const count = l.videos ? Object.keys(l.videos).length : (l._count || 0);
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
    ids.forEach((id, i) => { updates[`${id}/order`] = i; });
    try { await DB.lists().update(updates); UI.toast("List order saved", "success", 1500); }
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
      await ref.set(data);
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
    await DB.list(id).update({ name: name.trim(), emoji });
    UI.toast("List renamed", "success", 1500);
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
    await DB.list(id).update({ emoji });
    UI.toast("Emoji updated", "success", 1500);
  },

  async deleteList(id) {
    const nonArchived = Object.values(State.lists).filter((l) => !l.isArchived);
    const totalAll = Object.keys(State.lists).length;
    if (nonArchived.length <= 1 && !State.lists[id]?.isArchived && totalAll <= 1) {
      UI.toast("Can't delete your last list", "error"); return;
    }
    const l = State.lists[id];
    const ok = await UI.confirm({
      title: "Delete list?",
      message: `“${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}” and all its videos & notes will be permanently deleted.`,
      confirmText: "Delete",
    });
    if (!ok) return;
    State.archivedOpen.delete(id);
    await DB.list(id).remove();
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
    await DB.list(id).update({ isArchived: true, archivedAt: Date.now() });
    State.archivedOpen.delete(id);
    if (State.activeListId === id) {
      const next = this.ordered().find((x) => x.id !== id);
      if (next) Videos.selectList(next.id);
    }
    UI.toast("List archived", "success");
  },

  async unarchive(id) {
    const maxOrder = Math.max(-1, ...Object.values(State.lists).filter((l) => !l.isArchived).map((l) => l.order ?? 0));
    await DB.list(id).update({ isArchived: false, archivedAt: null, order: maxOrder + 1 });
    State.archivedOpen.delete(id);
    UI.toast("List restored", "success");
  },

  // ---------- ARCHIVED LISTS modal ----------
  async openArchivedModal() {
    if (!State.uid) { UI.toast("Please sign in", "info"); return; }
    UI.showLoading("Loading archived lists…");
    let archived = [];
    try {
      const snap = await DB.lists().once("value");
      const all = snap.val() || {};
      archived = Object.entries(all).filter(([, l]) => l.isArchived).map(([id, l]) => ({ id, ...l }));
    } catch (e) {} finally { UI.hideLoading(); }

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
            this.forceReload().then(() => Videos.selectList(id));
          });
          row.querySelector('[data-act="unarchive"]').addEventListener("click", async () => {
            await this.unarchive(id); row.remove();
          });
          row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
            const ok = await UI.confirm({ title: "Delete archived list?", message: "This permanently removes the list and its videos.", confirmText: "Delete" });
            if (!ok) return;
            await DB.list(id).remove(); row.remove();
            UI.toast("List deleted", "success");
          });
        });
      },
    });
  },

  forceReload() {
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
