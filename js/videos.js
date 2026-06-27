/* =========================================================
   videos.js — main grid: add, render, reorder, move, menu
   ========================================================= */

const Videos = {
  sortable: null,
  _videoRef: null,
  _dragVideoId: null,
  _dropListId: null,
  _lastAutoSync: {},   // listId -> timestamp of last automatic reconcile
  _autoSyncing: {},    // listId -> bool (in-flight guard)

  // ---------- select & load a list ----------
  selectList(listId) {
    if (!State.lists[listId]) return;
    // detach old listener
    if (this._videoRef) { this._videoRef.off(); this._videoRef = null; }
    State.activeListId = listId;
    State.videos = {};

    // A temporarily-opened archived list is only meant to be viewed once.
    // As soon as the user opens any OTHER list, remove it from the sidebar.
    if (State.archivedOpen.size) {
      [...State.archivedOpen].forEach((aid) => {
        if (aid === listId) return;
        State.archivedOpen.delete(aid);
        const al = State.lists[aid];
        if (al && al.isArchived) delete State.lists[aid];
      });
    }

    Lists.render();
    this.refreshActiveHeader();
    this.clearGrid();

    // keep sync/pull lists in step with their YouTube playlist
    this.autoReconcile(listId);

    this._videoRef = DB.videos(listId);
    this._videoRef.on("value", (snap) => {
      const all = snap.val() || {};
      State.videos = {};
      Object.entries(all).forEach(([vid, v]) => {
        if (!v || typeof v !== "object") return;
        if (v.type === "note") { v._key = vid; State.videos[vid] = v; return; }
        if (v.type === "channel") { v._key = vid; State.videos[vid] = v; return; }
        // skip orphan/corrupt nodes (e.g. {order:N} with no real video data)
        if (!v.title && !v.thumbnail && !v.youtubeId) return;
        v._key = vid; v.youtubeId = v.youtubeId || vid;
        State.videos[vid] = v;
      });
      // keep sidebar counts fresh
      if (State.lists[listId]) State.lists[listId]._count = Object.keys(State.videos).length;
      this.render();
      if (window.StatusBar) StatusBar.render();

      // one-time cleanup of orphan nodes left by an earlier bug (never touch notes)
      const orphans = Object.entries(all).filter(([k, v]) =>
        v && typeof v === "object" && v.type !== "note" && !v.title && !v.thumbnail && !v.youtubeId);
      if (orphans.length) {
        const upd = {}; orphans.forEach(([k]) => { upd[k] = null; });
        DB.videos(listId).update(upd).catch(() => {});
      }
    });
  },

  refreshActiveHeader() {
    const l = State.lists[State.activeListId];
    const emojiEl = document.getElementById("activeListEmoji");
    const nameEl = document.getElementById("activeListName");
    const badge = document.getElementById("activeListBadge");
    const addBtn = document.getElementById("addVideoBtn");
    if (!l) { nameEl.textContent = "—"; emojiEl.textContent = ""; badge.hidden = true; return; }
    emojiEl.textContent = l.emoji || Utils.autoEmoji(l.name);
    nameEl.textContent = Utils.stripLeadingEmoji(l.name) || l.name;
    // badge
    badge.hidden = false;
    badge.className = "badge";
    if (l.isArchived) { badge.textContent = "Archived"; badge.classList.add("is-archived"); }
    else if (l.syncMode === "sync") badge.textContent = "Sync";
    else if (l.syncMode === "pull") badge.textContent = "Pull";
    else badge.hidden = true;
    // add button disabled for sync lists
    addBtn.disabled = l.syncMode === "sync";
    addBtn.title = l.syncMode === "sync" ? "Sync lists mirror a playlist — manual adding is blocked" : "Add a video";

    // re-highlight active list item
    document.querySelectorAll(".list-item").forEach((el) => el.classList.toggle("is-active", el.dataset.id === State.activeListId));
  },

  clearGrid() {
    document.getElementById("videoGrid").innerHTML = "";
    document.getElementById("gridEmpty").hidden = true;
  },

  orderedVideos() {
    return Object.values(State.videos).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },

  // ---------- render grid ----------
  render() {
    const grid = document.getElementById("videoGrid");
    const empty = document.getElementById("gridEmpty");
    const viewBar = document.getElementById("viewBar");
    const vids = this.orderedVideos();

    if (!State.uid || vids.length === 0) { if (viewBar) viewBar.hidden = true; }

    if (!State.uid) {
      grid.innerHTML = "";
      empty.hidden = false;
      document.getElementById("gridEmptyMsg").textContent = "Please sign in to view your videos.";
      document.getElementById("gridEmptyHint").textContent = "Use the Sign in button in the sidebar.";
      return;
    }
    if (vids.length === 0) {
      grid.innerHTML = "";
      empty.hidden = false;
      const l = State.lists[State.activeListId];
      document.getElementById("gridEmptyMsg").textContent = "No videos in this list yet.";
      document.getElementById("gridEmptyHint").textContent = l && l.syncMode === "sync"
        ? "This list syncs from a playlist — refresh to pull videos."
        : "Add a YouTube link to get started — or just paste one anywhere.";
      return;
    }
    empty.hidden = true;

    // ---- Notion-style view: filter / sort / group ----
    const list = State.lists[State.activeListId] || {};
    const fields = Grouping.resolveFields(list);
    const view = Grouping.normalize(list.view, fields);
    this._view = view;
    this._fields = fields;
    this.renderViewBar(view, fields);
    const res = Grouping.apply(vids, view, undefined, list);

    if (!res.grouped) {
      grid.className = "video-grid";
      grid.innerHTML = res.items.map((v) => this.cardHtml(v)).join("");
      this.applySearchFilter();
      this.wireCards();
      // manual drag-reorder only in the default (manual, unfiltered) flat view
      if (view.sort.field === "manual") this.setupSortable();
      else this.teardownSortable();
    } else {
      grid.className = "video-grouped";
      grid.innerHTML = res.groups.map((g) => this.groupHtml(g, view)).join("");
      this.applySearchFilter();
      this.wireCards();
      this.wireGroups(view);
      this.teardownSortable();
      this.setupGroupSortable(view);
    }
  },

  // ---------- VIEW BAR (group / sort / filter controls) ----------
  renderViewBar(view, fields) {
    const bar = document.getElementById("viewBar");
    if (!bar) return;
    if (!State.uid || !State.activeListId) { bar.hidden = true; return; }
    bar.hidden = false;
    const F = fields || this._fields || Grouping.FIELDS;
    const chip = (id, label, active) =>
      `<button class="vb-chip ${active ? "is-active" : ""}" data-vb="${id}">${label}</button>`;
    const groupLabel = view.group ? `Group: ${F[view.group].label}` : "Group";
    const sortLabel = view.sort.field === "manual" ? "Sort" : `Sort: ${F[view.sort.field].label} ${view.sort.dir === "desc" ? "↓" : "↑"}`;
    const filterLabel = view.filters.length ? `Filter · ${view.filters.length}` : "Filter";
    bar.innerHTML =
      chip("group", groupLabel, !!view.group) +
      chip("sort", sortLabel, view.sort.field !== "manual") +
      chip("filter", filterLabel, view.filters.length > 0) +
      (Grouping.isDefault(view) ? "" : `<button class="vb-chip vb-reset" data-vb="reset">✕ Reset</button>`);
    bar.querySelector('[data-vb="group"]').addEventListener("click", (e) => this.openGroupMenu(e.currentTarget, view));
    bar.querySelector('[data-vb="sort"]').addEventListener("click", (e) => this.openSortMenu(e.currentTarget, view));
    bar.querySelector('[data-vb="filter"]').addEventListener("click", (e) => this.openFilterMenu(e.currentTarget, view));
    const reset = bar.querySelector('[data-vb="reset"]');
    if (reset) reset.addEventListener("click", () => this.saveView(Grouping.defaultView()));
  },

  openGroupMenu(btn, view) {
    const F = this._fields || Grouping.FIELDS;
    const items = [{ key: "_none", ico: "🚫", text: "No grouping", onClick: () => this.saveView({ ...view, group: null, groupOrder: [], collapsed: {} }) }];
    Grouping.groupableFields(F).forEach((id) => items.push({
      key: id, ico: F[id].ico, text: F[id].label,
      onClick: () => this.saveView({ ...view, group: id, groupOrder: [], collapsed: {} }),
    }));
    UI.floatingMenu(btn, items, { align: "left" });
  },

  openSortMenu(btn, view) {
    const F = this._fields || Grouping.FIELDS;
    const items = [{ key: "manual", ico: "↕️", text: "Manual" + (view.sort.field === "manual" ? " ✓" : ""), onClick: () => this.saveView({ ...view, sort: { field: "manual", dir: "asc" } }) }];
    Grouping.sortableFields(F).forEach((id) => {
      const isCur = view.sort.field === id;
      const nextDir = isCur && view.sort.dir === "asc" ? "desc" : "asc";
      const mark = isCur ? (view.sort.dir === "desc" ? " ↓" : " ↑") : "";
      items.push({ key: id, ico: F[id].ico, text: F[id].label + mark, onClick: () => this.saveView({ ...view, sort: { field: id, dir: nextDir } }) });
    });
    UI.floatingMenu(btn, items, { align: "left" });
  },

  openFilterMenu(btn, view) {
    const F = this._fields || Grouping.FIELDS;
    const items = [];
    if (view.filters.length) {
      view.filters.forEach((f, i) => items.push({ key: "rm" + i, ico: "✕", text: `${(F[f.field] || {}).label || f.field} ${f.op} “${f.value}”`, onClick: () => { const nf = view.filters.slice(); nf.splice(i, 1); this.saveView({ ...view, filters: nf }); } }));
      items.push({ divider: true });
    }
    items.push({ label: "Add filter" });
    Grouping.filterableFields(F).forEach((id) => items.push({ key: id, ico: F[id].ico, text: F[id].label, onClick: () => this.addFilter(view, id) }));
    UI.floatingMenu(btn, items, { align: "left" });
  },

  async addFilter(view, fieldId) {
    const f = (this._fields || Grouping.FIELDS)[fieldId];
    if (f.kind === "bool") { this.saveView({ ...view, filters: [...view.filters, { field: fieldId, op: "is", value: true }] }); return; }
    // suggest distinct values for select-like fields
    let val;
    if (f.kind === "select") {
      const vals = [...new Set(Object.values(State.videos).map((v) => String(f.get(v) || "").trim()).filter(Boolean))].sort();
      if (vals.length) {
        const items = vals.slice(0, 30).map((x) => ({ key: x, ico: "•", text: x, onClick: () => this.saveView({ ...view, filters: [...view.filters, { field: fieldId, op: "is", value: x }] }) }));
        UI.floatingMenu(document.querySelector('#viewBar [data-vb="filter"]'), items, { align: "left" });
        return;
      }
    }
    val = await UI.prompt({ title: `Filter by ${f.label}`, label: `${f.label} contains`, confirmText: "Apply" });
    if (val == null || !val.trim()) return;
    this.saveView({ ...view, filters: [...view.filters, { field: fieldId, op: "contains", value: val.trim() }] });
  },

  async saveView(view) {
    const id = State.activeListId;
    if (!id) return;
    const v = Grouping.normalize(view, this._fields);
    if (State.lists[id]) State.lists[id].view = v;
    this.render();
    try { await DB.list(id).update({ view: v }); } catch (e) { /* local already applied */ }
  },

  // ---------- GROUP rendering ----------
  groupHtml(group, view) {
    const cards = group.items.map((v) => this.cardHtml(v)).join("");
    return `
      <section class="vgroup ${group.collapsed ? "is-collapsed" : ""}" data-group="${Utils.escapeHtml(group.key)}">
        <header class="vgroup__head">
          <button class="vgroup__toggle" title="Collapse / expand"><span class="vgroup__chev">▾</span></button>
          ${view.sort.field === "manual" ? '<span class="vgroup__handle" title="Drag to reorder groups"><svg viewBox="0 0 24 24" width="13" height="13"><circle cx="9" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>' : ""}
          <span class="vgroup__label">${Utils.escapeHtml(group.label)}</span>
          <span class="vgroup__count">${group.items.length}</span>
        </header>
        <div class="vgroup__body video-grid">${cards}</div>
      </section>`;
  },

  wireGroups(view) {
    document.querySelectorAll("#videoGrid .vgroup").forEach((sec) => {
      const key = sec.dataset.group;
      sec.querySelector(".vgroup__toggle").addEventListener("click", () => {
        sec.classList.toggle("is-collapsed");
        const collapsed = { ...(view.collapsed || {}) };
        if (sec.classList.contains("is-collapsed")) collapsed[key] = true; else delete collapsed[key];
        // persist quietly without a full re-render (DOM already toggled)
        const v = Grouping.normalize({ ...view, collapsed }, this._fields);
        if (State.lists[State.activeListId]) State.lists[State.activeListId].view = v;
        this._view = v;
        DB.list(State.activeListId).update({ view: v }).catch(() => {});
      });
    });
  },

  setupGroupSortable(view) {
    if (this.groupSortable) { this.groupSortable.destroy(); this.groupSortable = null; }
    if (view.sort.field !== "manual") return;   // groups only reorder in manual sort
    const grid = document.getElementById("videoGrid");
    this.groupSortable = Sortable.create(grid, {
      handle: ".vgroup__handle",
      draggable: ".vgroup",
      animation: 160,
      onEnd: () => {
        const order = [...document.querySelectorAll("#videoGrid .vgroup")].map((s) => s.dataset.group);
        const v = Grouping.normalize({ ...this._view, groupOrder: order }, this._fields);
        if (State.lists[State.activeListId]) State.lists[State.activeListId].view = v;
        this._view = v;
        DB.list(State.activeListId).update({ view: v }).catch(() => {});
      },
    });
  },

  teardownSortable() {
    if (this.sortable) { this.sortable.destroy(); this.sortable = null; }
  },

  cardHtml(v) {
    if (v.type === "note") return this.noteCardHtml(v);
    if (v.type === "channel") return this.channelCardHtml(v);
    const hasNote = !!(v.note && v.note.trim());
    const avatar = v.channelThumbnailUrl
      ? `<img class="vcard__avatar" src="${Utils.escapeHtml(v.channelThumbnailUrl)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="vcard__avatar placeholder">${Utils.escapeHtml((v.channelName||"?").charAt(0).toUpperCase())}</div>`;
    const stats = [
      `${v.views || "0"} views`,
      v.subscribers && v.subscribers !== "0" ? `${v.subscribers} subs` : null,
      Utils.timeAgo(v.publishedAt),
    ].filter(Boolean).join(" • ");
    return `
      <div class="vcard ${hasNote ? "has-note" : ""}" data-id="${v._key || v.youtubeId}" data-yt="${Utils.escapeHtml(v.youtubeId||"")}" data-title="${Utils.escapeHtml((v.title||"").toLowerCase())}" data-channel="${Utils.escapeHtml((v.channelName||"").toLowerCase())}">
        <div class="vcard__thumb" data-act="open">
          <img src="${Utils.escapeHtml(v.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          ${v.duration ? `<span class="vcard__dur">${Utils.escapeHtml(v.duration)}</span>` : ""}
        </div>
        <div class="vcard__actions">
          <button class="vcard__abtn vcard__note-btn ${hasNote ? "has-note" : ""}" data-act="note" title="${hasNote ? "Open note" : "Add note"}">
            ${hasNote
              ? '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4 4h16v12H7l-3 3z"/></svg>'
              : '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v12H7l-3 3z"/></svg>'}
          </button>
          <button class="vcard__abtn" data-act="menu" title="More">
            <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="vcard__body">
          ${avatar}
          <div class="vcard__meta">
            <div class="vcard__title">${Utils.escapeHtml(v.title || "Untitled")}</div>
            <div class="vcard__channel">${Utils.escapeHtml(v.channelName || "")}</div>
            <div class="vcard__stats">${stats}</div>
          </div>
        </div>
      </div>`;
  },

  noteCardHtml(v) {
    const text = (v.note || "").trim();
    const preview = text
      ? `<div class="vcard__notebody">${Utils.escapeHtml(text)}</div>`
      : `<div class="vcard__notebody is-empty">Empty note — click to write…</div>`;
    const name = v.name || "Untitled note";
    return `
      <div class="vcard vcard--note" data-id="${v._key || v.id}" data-note="1" data-title="${Utils.escapeHtml(name.toLowerCase())}" data-channel="" data-body="${Utils.escapeHtml(text.toLowerCase())}">
        <div class="vcard__noteface" data-act="open">
          <span class="vcard__notetag">✎ Note</span>
          ${preview}
        </div>
        <div class="vcard__actions">
          <button class="vcard__abtn has-note" data-act="note" title="Open note">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4 4h16v12H7l-3 3z"/></svg>
          </button>
          <button class="vcard__abtn" data-act="menu" title="More">
            <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="vcard__body">
          <div class="vcard__icon">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 4h11l3 3v13H5z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8.5 10h7M8.5 14h5"/></svg>
          </div>
          <div class="vcard__meta">
            <div class="vcard__title">${Utils.escapeHtml(name)}</div>
            <div class="vcard__notedate">Created ${Utils.escapeHtml(Utils.formatDate(v.createdAt || v.timestamp))}</div>
          </div>
        </div>
      </div>`;
  },

  channelCardHtml(v) {
    const avatar = v.channelThumbnailUrl || v.thumbnail || "";
    const name = v.title || v.channelName || "Channel";
    const hasNote = !!(v.note && v.note.trim());
    const stats = [
      v.subscribers && v.subscribers !== "0" ? `${v.subscribers} subscribers` : null,
      v.videoCount && v.videoCount !== "0" ? `${v.videoCount} videos` : null,
    ].filter(Boolean).join(" • ");
    return `
      <div class="vcard vcard--channel ${hasNote ? "has-note" : ""}" data-id="${v._key || v.id}" data-channel-item="1"
           data-title="${Utils.escapeHtml(name.toLowerCase())}" data-channel="${Utils.escapeHtml((v.channelName || "").toLowerCase())}" data-body="${Utils.escapeHtml((v.note || "").toLowerCase())}">
        <div class="vchan__banner" data-act="open" ${v.banner ? `style="background-image:url('${Utils.escapeHtml(v.banner)}')"` : ""}>
          <span class="vchan__tag"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M3 7h18v11H3zM3 7l9 5 9-5"/></svg> Channel</span>
        </div>
        <div class="vcard__actions">
          <button class="vcard__abtn vcard__note-btn ${hasNote ? "has-note" : ""}" data-act="note" title="${hasNote ? "Open note" : "Add note"}">
            ${hasNote
              ? '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4 4h16v12H7l-3 3z"/></svg>'
              : '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v12H7l-3 3z"/></svg>'}
          </button>
          <button class="vcard__abtn" data-act="menu" title="More">
            <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="vchan__body" data-act="open">
          ${avatar
            ? `<img class="vchan__avatar" src="${Utils.escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer" />`
            : `<div class="vchan__avatar is-ph">${Utils.escapeHtml(name.charAt(0).toUpperCase())}</div>`}
          <div class="vchan__meta">
            <div class="vchan__name">${Utils.escapeHtml(name)}</div>
            <div class="vchan__stats">${Utils.escapeHtml(stats)}</div>
          </div>
        </div>
      </div>`;
  },

  wireCards() {
    const grid = document.getElementById("videoGrid");
    grid.querySelectorAll(".vcard").forEach((card) => {
      const vid = card.dataset.id;
      const isNote = card.dataset.note === "1";
      const isChannel = card.dataset.channelItem === "1";

      // channel cards: open the editor (notes allowed); "Open Channel" is in the menu
      if (isChannel) {
        const open = () => Notes.openInline(vid);
        card.querySelectorAll('[data-act="open"]').forEach((el) => {
          el.addEventListener("dblclick", open);
          let lastTap = 0;
          el.addEventListener("touchend", () => { const now = Date.now(); if (now - lastTap < 320) open(); lastTap = now; });
        });
        const noteBtn = card.querySelector('[data-act="note"]');
        if (noteBtn) noteBtn.addEventListener("click", (e) => { e.stopPropagation(); Notes.openInline(vid); });
        card.querySelector('[data-act="menu"]').addEventListener("click", (e) => { e.stopPropagation(); this.openCardMenu(e.currentTarget, vid); });
        return;
      }

      // double-click / double-tap face → open (note editor for notes, YouTube for videos)
      const face = card.querySelector(".vcard__thumb, .vcard__noteface");
      const openFace = () => { if (isNote) Notes.openInline(vid); else this.openOnYouTube(vid); };
      if (face) {
        face.addEventListener("dblclick", openFace);
        let lastTap = 0;
        face.addEventListener("touchend", () => {
          const now = Date.now();
          if (now - lastTap < 320) openFace();
          lastTap = now;
        });
      }
      card.querySelector('[data-act="note"]').addEventListener("click", (e) => { e.stopPropagation(); Notes.openInline(vid); });
      card.querySelector('[data-act="menu"]').addEventListener("click", (e) => { e.stopPropagation(); this.openCardMenu(e.currentTarget, vid); });
    });
  },

  openChannelOnYouTube(vid) {
    const v = State.videos[vid];
    if (!v) return;
    const url = v.channelId ? `https://www.youtube.com/channel/${v.channelId}`
      : v.customUrl ? `https://www.youtube.com/${v.customUrl}` : "https://www.youtube.com";
    window.open(url, "_blank", "noopener");
  },

  updateCardNoteState(vid) {
    const card = document.querySelector(`.vcard[data-id="${vid}"]`);
    if (!card) return;
    const v = State.videos[vid];
    const hasNote = !!(v && v.note && v.note.trim());
    card.classList.toggle("has-note", hasNote);
    const btn = card.querySelector(".vcard__note-btn");
    btn.classList.toggle("has-note", hasNote);
    btn.title = hasNote ? "Open note" : "Add note";
    btn.innerHTML = hasNote
      ? '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M4 4h16v12H7l-3 3z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16v12H7l-3 3z"/></svg>';
  },

  openOnYouTube(vid) {
    const v = State.videos[vid];
    const ytId = (v && v.youtubeId) || vid;
    window.open(`https://www.youtube.com/watch?v=${ytId}`, "_blank", "noopener");
  },

  // ---------- card 3-dot menu ----------
  openCardMenu(btn, vid) {
    const v = State.videos[vid];
    if (!v) return;
    if (v.type === "channel") {
      const items = [
        { key: "note", ico: "📝", text: "Open Note", onClick: () => Notes.openInline(vid) },
        { key: "open", ico: "📺", text: "Open Channel", onClick: () => this.openChannelOnYouTube(vid) },
        { key: "refresh", ico: "🔄", text: "Refresh", onClick: () => this.refreshChannel(vid) },
        { key: "move", ico: "📂", text: "Move to list…", onClick: () => this.openMoveMenu(btn, vid) },
        { divider: true },
        { key: "delete", ico: "🗑️", text: "Delete", danger: true, onClick: () => this.deleteVideo(vid) },
      ];
      UI.floatingMenu(btn, items, { align: "right" });
      return;
    }
    if (v.type === "note") {
      const items = [
        { key: "open", ico: "📖", text: "Open Note", onClick: () => Notes.openInline(vid) },
        { key: "rename", ico: "✏️", text: "Rename", onClick: () => this.renameNote(vid) },
        { key: "move", ico: "📂", text: "Move to list…", onClick: () => this.openMoveMenu(btn, vid) },
        { divider: true },
        { key: "delete", ico: "🗑️", text: "Delete", danger: true, onClick: () => this.deleteVideo(vid) },
      ];
      UI.floatingMenu(btn, items, { align: "right" });
      return;
    }
    const activeTpls = Templates.activeOrdered();
    const items = [
      { key: "refresh", ico: "🔄", text: "Refresh Data", onClick: () => this.refreshVideo(vid) },
      { key: "view", ico: "▶️", text: "View Video", onClick: () => this.openOnYouTube(vid) },
      { key: "move", ico: "📂", text: "Move to list…", onClick: () => this.openMoveMenu(btn, vid) },
    ];
    if (activeTpls.length) {
      items.push({ label: "Copy Template" });
      activeTpls.forEach((t) => items.push({ key: "tpl_" + t.id, ico: "📋", text: t.name, onClick: () => Templates.copyForVideo(t.id, v) }));
    }
    items.push({ divider: true });
    items.push({ key: "delete", ico: "🗑️", text: "Delete", danger: true, onClick: () => this.deleteVideo(vid) });
    UI.floatingMenu(btn, items, { align: "right" });
  },

  openMoveMenu(btn, vid) {
    const targets = Lists.ordered().filter((l) => l.id !== State.activeListId && l.syncMode !== "sync" && !l.isArchived);
    if (!targets.length) { UI.toast("No other lists to move to", "info"); return; }
    const items = targets.map((l) => ({
      key: l.id, ico: l.emoji || Utils.autoEmoji(l.name),
      text: Utils.stripLeadingEmoji(l.name) || l.name,
      onClick: () => this.moveVideo(vid, l.id),
    }));
    UI.floatingMenu(btn, items, { align: "right" });
  },

  // ---------- ADD VIDEO ----------
  openAddModal(prefillUrl = "") {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    const l = State.lists[State.activeListId];
    if (!l) { UI.toast("Select a list first", "info"); return; }
    if (l.syncMode === "sync") { UI.toast("This list mirrors a playlist — adding is blocked", "error"); return; }

    UI.openModal({
      title: "Add Video",
      bodyHtml: `
        <div class="field">
          <label>YouTube URL</label>
          <input class="input" id="avUrl" placeholder="https://www.youtube.com/watch?v=…" value="${Utils.escapeHtml(prefillUrl)}" />
          <p class="hint">Any YouTube link works — watch, share, shorts, embed, or live.</p>
        </div>`,
      footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                 <button class="btn btn--primary" data-act="add">Add Video</button>`,
      onMount: (modal, close) => {
        const input = modal.querySelector("#avUrl");
        input.focus(); input.select();
        const submit = async () => {
          const url = input.value.trim();
          const id = Utils.parseVideoId(url);
          if (!id) { UI.toast("Couldn't find a video ID in that link", "error"); input.focus(); return; }
          close();
          await this.addVideo(id);
        };
        modal.querySelector('[data-act="add"]').addEventListener("click", submit);
        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      },
    });
  },

  async addVideo(youtubeId) {
    const listId = State.activeListId;
    if (!listId) return;
    // dedupe by youtubeId (videos may be keyed by Firebase push id, not yt id)
    if (Object.values(State.videos).some((v) => v.youtubeId === youtubeId)) {
      UI.toast("That video is already in this list", "info"); return;
    }
    UI.showLoading("Fetching video data…");
    try {
      const data = await YT.fetchVideoData(youtubeId);
      if (!data) { UI.toast("Video not found, private, or deleted", "error"); return; }
      const minOrder = Math.min(0, ...Object.values(State.videos).map((v) => v.order ?? 0));
      const record = { ...data, order: minOrder - 1, timestamp: Date.now(), note: "", noteTimestamp: null };
      await DB.videos(listId).push().set(record);
      UI.toast("Video added", "success");
    } catch (e) {
      UI.toast("Couldn't add video: " + e.message, "error");
    } finally { UI.hideLoading(); }
  },

  // ---------- ADD NOTE-ONLY ITEM ----------
  openAddNoteModal() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    const l = State.lists[State.activeListId];
    if (!l) { UI.toast("Select a list first", "info"); return; }
    UI.openModal({
      title: "New Note",
      widthPx: 600,
      bodyHtml: `
        <div class="field">
          <label>Note title <span style="color:var(--accent)">*</span></label>
          <input class="input" id="anName" placeholder="e.g. Ideas for next video" />
        </div>
        <div class="field anNoteField">
          <label>Note <span class="hint" style="margin-left:6px;">Markdown supported</span></label>
          <textarea class="textarea anNoteText" id="anText" placeholder="Write your note…"></textarea>
        </div>
        <style>
          .modal__body.note-body-flex{display:flex;flex-direction:column;}
          .anNoteField{display:flex;flex-direction:column;flex:1;min-height:0;margin-bottom:0;}
          .anNoteText{flex:1;min-height:200px;resize:none;font-size:14px;line-height:1.65;}
        </style>`,
      footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                 <button class="btn btn--primary" data-act="create">Create Note</button>`,
      onMount: (modal, close) => {
        const body = modal.querySelector(".modal__body");
        if (body) body.classList.add("note-body-flex");
        const nameEl = modal.querySelector("#anName");
        const textEl = modal.querySelector("#anText");
        nameEl.focus();
        const submit = async () => {
          const name = nameEl.value.trim();
          if (!name) { nameEl.focus(); UI.toast("A note needs a title", "error"); return; }
          close();
          await this.addNoteItem(name, textEl.value);
        };
        modal.querySelector('[data-act="create"]').addEventListener("click", submit);
        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); textEl.focus(); } });
        textEl.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); } });
      },
    });
  },

  async addNoteItem(name, text) {
    const listId = State.activeListId;
    if (!listId) return;
    const now = Date.now();
    const minOrder = Math.min(0, ...Object.values(State.videos).map((v) => v.order ?? 0));
    const record = {
      type: "note",
      name: name,
      note: text || "",
      order: minOrder - 1,
      createdAt: now,
      timestamp: now,
      noteTimestamp: now,
    };
    try {
      await DB.videos(listId).push().set(record);
      UI.toast("Note created", "success", 1500);
    } catch (e) { UI.toast("Couldn't create note: " + e.message, "error"); }
  },

  // ---------- ADD CHANNEL ----------
  openAddChannelModal() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    const l = State.lists[State.activeListId];
    if (!l) { UI.toast("Select a list first", "info"); return; }
    UI.openModal({
      title: "Add Channel",
      bodyHtml: `
        <div class="field">
          <label>YouTube channel link or @handle</label>
          <input class="input" id="acUrl" placeholder="https://www.youtube.com/@channel" />
          <p class="hint">Paste a channel URL, an @handle, or a channel ID.</p>
        </div>`,
      footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                 <button class="btn btn--primary" data-act="add">Add Channel</button>`,
      onMount: (modal, close) => {
        const input = modal.querySelector("#acUrl");
        input.focus();
        const submit = async () => {
          const v = input.value.trim();
          if (!v) { input.focus(); return; }
          close();
          await this.addChannel(v);
        };
        modal.querySelector('[data-act="add"]').addEventListener("click", submit);
        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      },
    });
  },

  async addChannel(input) {
    const listId = State.activeListId;
    if (!listId) return;
    UI.showLoading("Fetching channel…");
    try {
      const data = await YT.fetchChannelData(input);
      if (!data) { UI.toast("Channel not found — check the link or handle", "error"); return; }
      if (Object.values(State.videos).some((v) => v.type === "channel" && v.channelId === data.channelId)) {
        UI.toast("That channel is already in this list", "info"); return;
      }
      const minOrder = Math.min(0, ...Object.values(State.videos).map((v) => v.order ?? 0));
      const record = Object.assign({ type: "channel", order: minOrder - 1, timestamp: Date.now(), createdAt: Date.now() }, data);
      await DB.videos(listId).push().set(record);
      UI.toast("Channel added", "success");
    } catch (e) { UI.toast("Couldn't add channel: " + e.message, "error"); }
    finally { UI.hideLoading(); }
  },

  async refreshChannel(vid) {
    const v = State.videos[vid];
    if (!v || v.type !== "channel") return;
    UI.showLoading("Refreshing channel…");
    try {
      const data = await YT.fetchChannelData(v.channelId || v.customUrl || v.title);
      if (!data) { UI.toast("Channel unavailable on YouTube — kept existing data", "info"); return; }
      delete data.order;
      await DB.video(State.activeListId, vid).update(data);
      UI.toast("Channel refreshed", "success", 1500);
    } catch (e) { UI.toast("Refresh failed: " + e.message, "error"); }
    finally { UI.hideLoading(); }
  },

  // ---------- CREATE A BLANK NOTE AND OPEN IT (Notion-style) ----------
  async createNoteAndOpen() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    const listId = State.activeListId;
    if (!listId) { UI.toast("Select a list first", "info"); return; }
    const now = Date.now();
    const minOrder = Math.min(0, ...Object.values(State.videos).map((v) => v.order ?? 0));
    const record = {
      type: "note", name: "", note: "", order: minOrder - 1,
      createdAt: now, timestamp: now, noteTimestamp: now,
    };
    try {
      const ref = DB.videos(listId).push();
      await ref.set(record);
      // make it available to the editor immediately (the live listener will
      // also pick it up); then open the blank page so the user starts typing.
      State.videos[ref.key] = { ...record, _key: ref.key };
      if (window.NoteEditor) NoteEditor.open(ref.key);
    } catch (e) { UI.toast("Couldn't create note: " + e.message, "error"); }
  },

  async renameNote(vid) {
    const v = State.videos[vid];
    if (!v) return;
    const name = await UI.prompt({ title: "Rename Note", label: "Note title", value: v.name || "", confirmText: "Rename" });
    if (name == null || !name.trim()) return;
    await DB.video(State.activeListId, vid).update({ name: name.trim() });
    UI.toast("Note renamed", "success", 1500);
  },

  // ---------- DELETE ----------
  async deleteVideo(vid) {
    const v = State.videos[vid];
    const kind = v && v.type === "note" ? "note" : (v && v.type === "channel" ? "channel" : "video");
    const label = kind === "note" ? (v.name || "this note") : (v?.title || ("this " + kind));
    const titleMap = { note: "Delete note?", channel: "Delete channel?", video: "Delete video?" };
    const ok = await UI.confirm({ title: titleMap[kind], message: `“${Utils.escapeHtml(String(label).slice(0,80))}” will be removed from this list.`, confirmText: "Delete" });
    if (!ok) return;
    await DB.video(State.activeListId, vid).remove();
    UI.toast("Video deleted", "success", 1500);
  },

  // ---------- MOVE ----------
  async moveVideo(vid, destListId) {
    const dest = State.lists[destListId];
    if (!dest) return;
    if (dest.syncMode === "sync") { UI.toast("Can't move into a Sync list", "error"); return; }
    const v = State.videos[vid];
    if (!v) return;
    const srcListId = State.activeListId;
    const srcList = State.lists[srcListId];
    // notes & channels skip video-only logic (dedupe by youtubeId, playlist re-pull)
    const isNote = v.type === "note" || v.type === "channel";
    UI.showLoading("Moving…");
    try {
      const destVidsSnap = await DB.videos(destListId).once("value");
      const destVids = destVidsSnap.val() || {};
      // duplicate check at destination (videos by youtubeId; notes never dedupe)
      if (!isNote && Object.values(destVids).some((x) => (x.youtubeId || "") === v.youtubeId)) {
        UI.toast("That video is already in the destination list", "info"); return;
      }
      const minOrder = Math.min(0, ...Object.values(destVids).map((x) => x.order ?? 0));
      const record = { ...v, order: minOrder - 1, timestamp: Date.now() };
      delete record.id; delete record._key;
      await DB.videos(destListId).push().set(record);
      await DB.video(srcListId, vid).remove();
      UI.toast(`Moved to “${Utils.stripLeadingEmoji(dest.name) || dest.name}”`, "success");
      // a sync/pull source mirrors its playlist — pull the video right back
      if (!isNote && srcList && srcList.playlistId && (srcList.syncMode === "sync" || srcList.syncMode === "pull")) {
        this.autoReconcile(srcListId, { force: true }).then((r) => {
          if (r && r.added) UI.toast(`“${Utils.stripLeadingEmoji(srcList.name) || srcList.name}” re-synced this video from its playlist`, "info", 2600);
        });
      }
    } catch (e) { UI.toast("Move failed: " + e.message, "error"); }
    finally { UI.hideLoading(); }
  },

  // ---------- REFRESH (per-video, 48h guard) ----------
  async refreshVideo(vid, opts = {}) {
    const listId = opts.listId || State.activeListId;
    const v = State.videos[vid] || opts.video;
    if (!v) return;
    if (v.type === "note") return; // notes have no YouTube data to refresh
    const FORTY_EIGHT = 48 * 3600 * 1000;
    if (!opts.force && v.lastUpdated && (Date.now() - v.lastUpdated) < FORTY_EIGHT) {
      if (!opts.silent) UI.toast("Already up to date (refreshed within 48h)", "info");
      return;
    }
    if (!opts.silent) UI.showLoading("Refreshing video…");
    try {
      const ytId = v.youtubeId || vid;
      const data = await YT.fetchVideoData(ytId);
      if (!data) {
        // deleted from YouTube — keep old data, just bump timestamp
        await DB.video(listId, vid).update({ lastUpdated: Date.now() });
        if (!opts.silent) UI.toast("Video unavailable on YouTube — kept existing data", "info");
        return;
      }
      // never overwrite note / order
      delete data.note; delete data.order; delete data._key;
      await DB.video(listId, vid).update(data);
      if (!opts.silent) UI.toast("Video refreshed", "success", 1500);
    } catch (e) { if (!opts.silent) UI.toast("Refresh failed: " + e.message, "error"); }
    finally { if (!opts.silent) UI.hideLoading(); }
  },

  // ---------- LIST REFRESH ----------
  async refreshList(listId) {
    const l = State.lists[listId];
    if (!l) return;
    // for sync/pull lists, reconcile against playlist first
    if (l.playlistId && (l.syncMode === "sync" || l.syncMode === "pull")) {
      await this.reconcilePlaylist(listId);
    }
    const snap = await DB.videos(listId).once("value");
    const vids = snap.val() || {};
    const ids = Object.keys(vids);
    if (!ids.length) { UI.toast("No videos to refresh", "info"); return; }
    UI.showLoading(`Refreshing ${ids.length} videos…`);
    let done = 0;
    try {
      for (const vid of ids) {
        await this.refreshVideo(vid, { listId, video: vids[vid], silent: true });
        done++;
      }
      UI.toast(`Refreshed ${done} video${done !== 1 ? "s" : ""}`, "success");
    } catch (e) { UI.toast("Some refreshes failed: " + e.message, "error"); }
    finally { UI.hideLoading(); }
  },

  // ---------- AUTO RECONCILE (background, throttled) ----------
  // Keeps sync & pull lists matching their YouTube playlist so a moved/deleted
  // video naturally returns. Runs silently; throttled per list.
  async autoReconcile(listId, opts = {}) {
    const l = State.lists[listId];
    if (!l || !l.playlistId) return;
    if (l.syncMode !== "sync" && l.syncMode !== "pull") return;
    if (this._autoSyncing[listId]) return;
    const THROTTLE = 90 * 1000; // 90s between automatic checks
    const last = this._lastAutoSync[listId] || 0;
    if (!opts.force && (Date.now() - last) < THROTTLE) return;
    this._autoSyncing[listId] = true;
    this._lastAutoSync[listId] = Date.now();
    try {
      const res = await this.reconcilePlaylist(listId, { silent: true });
      if (res && (res.added || res.removed) && !opts.force) {
        UI.toast(`“${Utils.stripLeadingEmoji(l.name) || l.name}” synced — ${res.added} added${res.removed ? `, ${res.removed} removed` : ""}`, "info", 2200);
      }
    } catch (e) { /* silent */ }
    finally { this._autoSyncing[listId] = false; }
  },

  // ---------- PLAYLIST RECONCILE ----------
  async reconcilePlaylist(listId, opts = {}) {
    const silent = !!opts.silent;
    const l = State.lists[listId];
    if (!l || !l.playlistId) return null;
    if (!silent) UI.showLoading("Syncing playlist…");
    try {
      const playlistIds = await YT.fetchPlaylistVideoIds(l.playlistId);
      const playlistSet = new Set(playlistIds);
      const snap = await DB.videos(listId).once("value");
      const existing = snap.val() || {};
      // map existing youtubeId -> node key (videos may be keyed by push id).
      // note-only items have no youtubeId and must never be touched by sync.
      const existingYt = new Map();
      Object.entries(existing).forEach(([key, v]) => {
        if (!v || v.type === "note") return;
        if (v.youtubeId) existingYt.set(v.youtubeId, key);
      });

      // new videos to add (by youtubeId)
      const toAdd = playlistIds.filter((id) => !existingYt.has(id));
      if (toAdd.length) {
        const fetched = await YT.fetchManyVideos(toAdd);
        let minOrder = Math.min(0, ...Object.values(existing).map((v) => v.order ?? 0));
        // push each new video under a fresh push key
        for (const data of fetched) {
          minOrder -= 1;
          await DB.videos(listId).push().set({ ...data, order: minOrder, timestamp: Date.now(), note: "", noteTimestamp: null });
        }
      }

      // sync mode: delete videos no longer in playlist (by youtubeId); never delete notes
      let removed = 0;
      if (l.syncMode === "sync") {
        const updates = {};
        existingYt.forEach((nodeKey, ytId) => {
          if (!playlistSet.has(ytId)) { updates[nodeKey] = null; removed++; }
        });
        if (Object.keys(updates).length) await DB.videos(listId).update(updates);
      }
      if (!silent) UI.toast(`Playlist synced — ${toAdd.length} added${removed ? `, ${removed} removed` : ""}`, "success");
      return { added: toAdd.length, removed };
    } catch (e) {
      if (!silent) UI.toast("Playlist sync failed: " + e.message, "error");
      return null;
    }
    finally { if (!silent) UI.hideLoading(); }
  },

  // ---------- SEARCH FILTER ----------
  applySearchFilter() {
    const term = State.searchTerm.toLowerCase().trim();
    document.querySelectorAll(".vcard").forEach((card) => {
      if (!term) { card.classList.remove("hidden"); return; }
      const hay = `${card.dataset.title} ${card.dataset.channel} ${card.dataset.yt || ""} ${card.dataset.body || ""}`.toLowerCase();
      card.classList.toggle("hidden", !hay.includes(term));
    });
    // hide group sections that have no visible cards after a search
    document.querySelectorAll("#videoGrid .vgroup").forEach((sec) => {
      const anyVisible = [...sec.querySelectorAll(".vcard")].some((c) => !c.classList.contains("hidden"));
      sec.classList.toggle("group-hidden", !anyVisible);
    });
  },

  // ---------- SORTABLE (grid reorder + drag-to-sidebar move) ----------
  setupSortable() {
    if (this.sortable) { this.sortable.destroy(); this.sortable = null; }
    const grid = document.getElementById("videoGrid");
    const isTouch = matchMedia("(pointer: coarse)").matches;
    this.sortable = Sortable.create(grid, {
      animation: 160,
      filter: ".vcard__actions, .vcard__abtn",
      preventOnFilter: false,
      delay: isTouch ? 250 : 0,
      delayOnTouchOnly: true,
      draggable: ".vcard",
      onStart: (evt) => {
        this._dragVideoId = evt.item.dataset.id;
        this._dropListId = null;
        document.body.classList.add("dragging-video");
        document.addEventListener("mousemove", this._onDragMove, true);
        document.addEventListener("touchmove", this._onDragMove, true);
      },
      onEnd: async (evt) => {
        document.removeEventListener("mousemove", this._onDragMove, true);
        document.removeEventListener("touchmove", this._onDragMove, true);
        document.body.classList.remove("dragging-video");
        document.querySelectorAll(".list-item.drop-target").forEach((el) => el.classList.remove("drop-target"));
        const dropList = this._dropListId;
        const vid = this._dragVideoId;
        this._dropListId = null; this._dragVideoId = null;
        if (dropList && dropList !== State.activeListId) {
          await this.moveVideo(vid, dropList); // re-render will fix DOM
          return;
        }
        // otherwise persist new order
        this.saveOrder();
      },
    });
  },

  _onDragMove(e) {
    const pt = e.touches ? e.touches[0] : e;
    const el = document.elementFromPoint(pt.clientX, pt.clientY);
    const li = el && el.closest(".list-item");
    document.querySelectorAll(".list-item.drop-target").forEach((x) => x.classList.remove("drop-target"));
    if (li && li.dataset.id !== State.activeListId && li.dataset.sync !== "sync" && li.dataset.archived !== "1") {
      li.classList.add("drop-target");
      Videos._dropListId = li.dataset.id;
    } else {
      Videos._dropListId = null;
    }
  },

  async saveOrder() {
    const ids = [...document.querySelectorAll("#videoGrid .vcard")].map((el) => el.dataset.id);
    const updates = {};
    ids.forEach((id, i) => { updates[`${id}/order`] = i; });
    try { await DB.videos(State.activeListId).update(updates); }
    catch (e) { UI.toast("Couldn't save order", "error"); }
  },
};
