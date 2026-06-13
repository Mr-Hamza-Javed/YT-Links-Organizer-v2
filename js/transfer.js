/* =========================================================
   transfer.js — comprehensive Export / Import of all data
   ========================================================= */

const Transfer = {
  FORMAT: "ylo-export",
  VERSION: 1,

  // ---------- helpers ----------
  _key() { return fbDb.ref().push().key; },

  _sanitizeVideo(v) {
    // strip transient/local-only fields
    const out = { ...v };
    delete out._key; delete out.id; delete out._count;
    return out;
  },

  _isNote(v) { return v && v.type === "note"; },
  _hasNote(v) { return !!(v && ((v.note && String(v.note).trim()) || v.type === "note")); },
  _videoLabel(v) { return this._isNote(v) ? (v.name || "Untitled note") : (v.title || "Untitled"); },

  /* =======================================================
     EXPORT
     ======================================================= */
  async openExport() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    UI.showLoading("Gathering your data…");
    let listsRaw = {}, templatesRaw = {};
    try {
      const [lSnap, tSnap] = await Promise.all([DB.lists().once("value"), DB.templates().once("value")]);
      listsRaw = lSnap.val() || {};
      templatesRaw = tSnap.val() || {};
    } catch (e) {
      UI.hideLoading();
      UI.toast("Couldn't read your data: " + e.message, "error");
      return;
    }
    UI.hideLoading();

    // normalise into an array of lists with arrays of items
    const lists = Object.entries(listsRaw).map(([id, l]) => {
      const items = Object.entries(l.videos || {}).map(([vk, v]) => ({ ...v, _key: vk }))
        .filter((v) => v && (this._isNote(v) || v.title || v.thumbnail || v.youtubeId))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return { id, ...l, _items: items };
    }).sort((a, b) => (a.isArchived ? 1 : 0) - (b.isArchived ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0));

    const templates = Object.entries(templatesRaw).map(([id, t]) => ({ id, ...t }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    this._renderExportModal(lists, templates);
  },

  _renderExportModal(lists, templates) {
    const self = this;
    const totalVideos = lists.reduce((s, l) => s + l._items.filter((v) => !self._isNote(v)).length, 0);
    const totalNotes = lists.reduce((s, l) => s + l._items.filter((v) => self._isNote(v)).length, 0);

    const listRows = lists.map((l) => {
      const vids = l._items.filter((v) => !self._isNote(v)).length;
      const notes = l._items.filter((v) => self._isNote(v)).length;
      const name = Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name);
      const meta = [`${vids} video${vids !== 1 ? "s" : ""}`, notes ? `${notes} note${notes !== 1 ? "s" : ""}` : null,
        l.syncMode && l.syncMode !== "none" ? l.syncMode : null, l.isArchived ? "archived" : null].filter(Boolean).join(" · ");
      // surface the playlist link for sync/pull lists (informational only)
      const plUrl = (l.syncMode && l.syncMode !== "none" && l.playlistId)
        ? `https://www.youtube.com/playlist?list=${Utils.escapeHtml(l.playlistId)}` : null;
      const plLine = plUrl
        ? `<div class="xfer-list__playlist mono"><span class="xfer-list__playlist-ico">↪</span><a href="${plUrl}" target="_blank" rel="noopener" title="${plUrl}">${plUrl}</a></div>`
        : "";
      return `
        <div class="xfer-list" data-id="${l.id}">
          <div class="xfer-list__head">
            <label class="xfer-check">
              <input type="checkbox" class="xfer-list__cb" data-id="${l.id}" checked />
              <span class="xfer-list__emoji">${l.emoji || Utils.autoEmoji(l.name)}</span>
              <span class="xfer-list__name">${name}</span>
            </label>
            <span class="xfer-list__meta">${meta}</span>
            <button class="xfer-list__toggle" data-id="${l.id}" title="Choose specific items">Choose…</button>
          </div>
          ${plLine}
          <div class="xfer-list__items" data-id="${l.id}" hidden></div>
        </div>`;
    }).join("");

    UI.openModal({
      title: "Export Data",
      wide: true,
      bodyHtml: `
        <div class="xfer">
          <p class="xfer-intro">Choose what to include. Everything is exported to a single <b>.json</b> file you can re-import anytime.</p>

          <div class="xfer-section">
            <div class="xfer-section__title">Settings & Templates</div>
            <label class="xfer-opt"><input type="checkbox" id="xExpSettings" checked /> <span>App settings <span class="xfer-dim">(theme, card size, status bar)</span></span></label>
            <label class="xfer-opt"><input type="checkbox" id="xExpTemplates" ${templates.length ? "checked" : "disabled"} /> <span>Copy templates <span class="xfer-dim">(${templates.length})</span></span></label>
          </div>

          <div class="xfer-section">
            <div class="xfer-section__title">
              Lists <span class="xfer-dim">(${lists.length} lists · ${totalVideos} videos · ${totalNotes} note${totalNotes !== 1 ? "s" : ""})</span>
              <div class="xfer-bulk">
                <button class="xfer-mini" id="xSelAll">All</button>
                <button class="xfer-mini" id="xSelNone">None</button>
              </div>
            </div>
            <div id="xListRows" class="xfer-lists">${listRows || '<p class="xfer-dim" style="padding:14px;">No lists to export.</p>'}</div>
          </div>
        </div>
        ${this._exportStyles()}`,
      footHtml: `
        <span id="xExpSummary" class="xfer-summary"></span>
        <div style="flex:1"></div>
        <button class="btn btn--ghost" data-act="cancel">Cancel</button>
        <button class="btn btn--primary" id="xExpBtn">Export .json</button>`,
      onMount: (modal, close) => {
        // per-list selected item sets; null = "all items"
        const itemSel = {}; // listId -> Set of _key (explicit selection) | undefined => all

        // Reflect a list's partial/all/none item-selection state onto its
        // checkbox: ticked = all, indeterminate = some, unticked = none.
        const syncListIndicator = (listId) => {
          const l = lists.find((x) => x.id === listId);
          const lcb = modal.querySelector(`.xfer-list__cb[data-id="${listId}"]`);
          if (!l || !lcb) return;
          const sel = itemSel[listId];
          if (!sel) { lcb.indeterminate = false; lcb.checked = true; return; } // all
          const total = l._items.length;
          if (sel.size === 0) { lcb.indeterminate = false; lcb.checked = false; }
          else if (sel.size >= total) { delete itemSel[listId]; lcb.indeterminate = false; lcb.checked = true; }
          else { lcb.indeterminate = true; lcb.checked = true; } // partial
        };

        const renderItems = (listId) => {
          const cont = modal.querySelector(`.xfer-list__items[data-id="${listId}"]`);
          const l = lists.find((x) => x.id === listId);
          if (!cont || !l) return;
          const sel = itemSel[listId];
          cont.innerHTML = l._items.length ? l._items.map((v) => {
            const checked = !sel || sel.has(v._key) ? "checked" : "";
            const isNote = self._isNote(v);
            const ico = isNote ? "✎" : "▶";
            const sub = isNote ? "note" : (v.channelName || "");
            const noteDot = self._hasNote(v) && !isNote ? '<span class="xfer-item__note" title="has a note">✎</span>' : "";
            return `<label class="xfer-item">
                <input type="checkbox" class="xfer-item__cb" data-id="${listId}" data-key="${v._key}" ${checked} />
                <span class="xfer-item__ico ${isNote ? "is-note" : ""}">${ico}</span>
                <span class="xfer-item__txt"><span class="xfer-item__title">${Utils.escapeHtml(self._videoLabel(v))}</span><span class="xfer-item__sub">${Utils.escapeHtml(sub)}</span></span>
                ${noteDot}
              </label>`;
          }).join("") : '<p class="xfer-dim" style="padding:8px 10px;">This list is empty.</p>';
          cont.querySelectorAll(".xfer-item__cb").forEach((cb) => {
            cb.addEventListener("change", () => {
              if (!itemSel[listId]) itemSel[listId] = new Set(l._items.map((v) => v._key));
              if (cb.checked) itemSel[listId].add(cb.dataset.key); else itemSel[listId].delete(cb.dataset.key);
              syncListIndicator(listId);
              updateSummary();
            });
          });
        };

        modal.querySelectorAll(".xfer-list__toggle").forEach((btn) => {
          btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const cont = modal.querySelector(`.xfer-list__items[data-id="${id}"]`);
            const show = cont.hidden;
            if (show) renderItems(id);
            cont.hidden = !show;
            btn.textContent = show ? "Hide items" : "Choose…";
            btn.classList.toggle("is-open", show);
          });
        });

        const setAll = (val) => {
          lists.forEach((l) => {
            const lcb = modal.querySelector(`.xfer-list__cb[data-id="${l.id}"]`);
            if (lcb) { lcb.checked = val; lcb.indeterminate = false; }
            // "All" => every item (undefined); "None" => no items (empty set),
            // so checked-but-still-exporting-videos can't happen.
            if (val) delete itemSel[l.id]; else itemSel[l.id] = new Set();
            const cont = modal.querySelector(`.xfer-list__items[data-id="${l.id}"]`);
            if (cont && !cont.hidden) renderItems(l.id);
          });
          updateSummary();
        };
        modal.querySelector("#xSelAll").addEventListener("click", () => setAll(true));
        modal.querySelector("#xSelNone").addEventListener("click", () => setAll(false));

        const computeSelection = () => {
          const out = [];
          lists.forEach((l) => {
            const lcb = modal.querySelector(`.xfer-list__cb[data-id="${l.id}"]`);
            if (!lcb || !lcb.checked) return;
            const sel = itemSel[l.id];
            const items = sel ? l._items.filter((v) => sel.has(v._key)) : l._items;
            out.push({ list: l, items });
          });
          return out;
        };

        const updateSummary = () => {
          const sel = computeSelection();
          const nLists = sel.length;
          const nItems = sel.reduce((s, x) => s + x.items.length, 0);
          modal.querySelector("#xExpSummary").textContent = nLists ? `${nLists} list${nLists !== 1 ? "s" : ""}, ${nItems} item${nItems !== 1 ? "s" : ""} selected` : "Nothing selected";
        };

        modal.querySelectorAll(".xfer-list__cb").forEach((cb) => cb.addEventListener("change", () => {
          const id = cb.dataset.id;
          cb.indeterminate = false;
          if (cb.checked) delete itemSel[id];   // ticking the list = export everything in it
          else itemSel[id] = new Set();         // unticking = export nothing from it
          const cont = modal.querySelector(`.xfer-list__items[data-id="${id}"]`);
          if (cont && !cont.hidden) renderItems(id);
          updateSummary();
        }));
        updateSummary();

        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        modal.querySelector("#xExpBtn").addEventListener("click", () => {
          const sel = computeSelection();
          const inclSettings = modal.querySelector("#xExpSettings").checked;
          const inclTemplates = modal.querySelector("#xExpTemplates").checked && templates.length;
          if (!sel.length && !inclSettings && !inclTemplates) { UI.toast("Select something to export", "info"); return; }
          const data = self._buildExport(sel, inclSettings, inclTemplates ? templates : []);
          self._download(data);
          close();
          UI.toast(`Exported ${sel.length} list${sel.length !== 1 ? "s" : ""}`, "success");
        });
      },
    });
  },

  _buildExport(selection, inclSettings, templates) {
    const data = {
      format: this.FORMAT, version: this.VERSION,
      app: "YouTube Link Organizer",
      exportedAt: Date.now(),
    };
    if (inclSettings) {
      let statusbar = null;
      try { statusbar = JSON.parse(localStorage.getItem("ylo_statusbar") || "null"); } catch (e) {}
      data.settings = {
        theme: State.theme,
        cardSize: State.cardSize,
        statusbar: statusbar || (window.StatusBar ? StatusBar.config : null),
      };
    }
    if (templates && templates.length) {
      data.templates = templates.map((t) => ({ name: t.name, text: t.text || "", isActive: !!t.isActive, order: t.order ?? 0 }));
    }
    data.lists = selection.map(({ list, items }) => ({
      name: list.name,
      emoji: list.emoji || Utils.autoEmoji(list.name),
      syncMode: list.syncMode || "none",
      playlistId: list.playlistId || null,
      isArchived: !!list.isArchived,
      order: list.order ?? 0,
      createdAt: list.createdAt || Date.now(),
      videos: items.map((v) => this._sanitizeVideo(v)),
    }));
    return data;
  },

  _download(data) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `link-organizer-export-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  /* =======================================================
     IMPORT
     ======================================================= */
  openImport() {
    if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
    const self = this;
    UI.openModal({
      title: "Import Data",
      wide: true,
      bodyHtml: `
        <div class="xfer">
          <div id="xImpDrop" class="xfer-drop">
            <div class="xfer-drop__ico">⬆</div>
            <div class="xfer-drop__title">Choose an export file</div>
            <div class="xfer-drop__hint">Drag & drop a <b>.json</b> export here, or click to browse.</div>
            <input type="file" id="xImpFile" accept="application/json,.json" hidden />
          </div>
          <div id="xImpReview"></div>
        </div>
        ${this._importStyles()}`,
      footHtml: `
        <span id="xImpSummary" class="xfer-summary"></span>
        <div style="flex:1"></div>
        <button class="btn btn--ghost" data-act="cancel">Cancel</button>
        <button class="btn btn--primary" id="xImpBtn" disabled>Import</button>`,
      onMount: (modal, close) => {
        const drop = modal.querySelector("#xImpDrop");
        const file = modal.querySelector("#xImpFile");
        const importBtn = modal.querySelector("#xImpBtn");

        const onFile = (f) => {
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            let parsed;
            try { parsed = JSON.parse(reader.result); }
            catch (e) { UI.toast("That file isn't valid JSON", "error"); return; }
            self._beginReview(modal, parsed, close);
          };
          reader.onerror = () => UI.toast("Couldn't read that file", "error");
          reader.readAsText(f);
        };

        drop.addEventListener("click", () => file.click());
        file.addEventListener("change", () => onFile(file.files[0]));
        ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-drag"); }));
        ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-drag"); }));
        drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; onFile(f); });

        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
      },
    });
  },

  // validate + normalise an imported payload into a review model
  _normalizeImport(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== "object") { errors.push("File is empty or not an object."); return { errors, lists: [], templates: [], settings: null }; }
    if (parsed.format && parsed.format !== this.FORMAT) errors.push(`Unexpected format “${parsed.format}” — importing anyway.`);

    const rawLists = Array.isArray(parsed.lists) ? parsed.lists
      : (parsed.lists && typeof parsed.lists === "object") ? Object.values(parsed.lists) : [];

    const lists = rawLists.map((l, li) => {
      const rawItems = Array.isArray(l.videos) ? l.videos
        : (l.videos && typeof l.videos === "object") ? Object.values(l.videos) : [];
      const items = rawItems.filter((v) => v && typeof v === "object").map((v, i) => ({ ...v, _idx: i }));

      // duplicate detection within this list (videos by youtubeId)
      const seen = new Map(); // ytId -> first idx
      const dupGroups = {};   // ytId -> [items]
      items.forEach((v) => {
        if (this._isNote(v) || !v.youtubeId) return;
        if (!dupGroups[v.youtubeId]) dupGroups[v.youtubeId] = [];
        dupGroups[v.youtubeId].push(v);
      });
      const duplicates = Object.entries(dupGroups).filter(([, arr]) => arr.length > 1)
        .map(([yt, arr]) => ({ youtubeId: yt, items: arr }));

      return {
        name: l.name || "Untitled list",
        emoji: l.emoji || Utils.autoEmoji(l.name || ""),
        syncMode: l.syncMode || "none",
        playlistId: l.playlistId || null,
        isArchived: !!l.isArchived,
        order: l.order ?? li,
        createdAt: l.createdAt || Date.now(),
        items,
        duplicates,
      };
    });

    const rawTemplates = Array.isArray(parsed.templates) ? parsed.templates
      : (parsed.templates && typeof parsed.templates === "object") ? Object.values(parsed.templates) : [];
    const templates = rawTemplates.filter((t) => t && t.name).map((t) => ({
      name: t.name, text: t.text || "", isActive: !!t.isActive, order: t.order ?? 0,
    }));

    const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : null;
    return { errors, lists, templates, settings, meta: { exportedAt: parsed.exportedAt, app: parsed.app } };
  },

  async _beginReview(modal, parsed, close) {
    const self = this;
    const model = this._normalizeImport(parsed);

    // Build a name index from a FRESH snapshot of *all* lists — including
    // archived ones, which State.lists deliberately omits. Without this, a list
    // whose name matches an archived list slipped through conflict detection and
    // got silently re-created (often vanishing into the archive). nameMap keeps
    // the archived flag so we can flag and word the conflict correctly.
    const nameMap = new Map(); // nameLower -> { id, name, isArchived }
    try {
      const snap = await DB.lists().once("value");
      const all = snap.val() || {};
      Object.entries(all).forEach(([id, l]) => {
        const key = (l.name || "").trim().toLowerCase();
        if (key && !nameMap.has(key)) nameMap.set(key, { id, name: l.name, isArchived: !!l.isArchived });
      });
    } catch (e) {
      // Fall back to the in-memory (non-archived) lists if the read fails.
      Object.values(State.lists || {}).forEach((l) => {
        const key = (l.name || "").trim().toLowerCase();
        if (key && !nameMap.has(key)) nameMap.set(key, { id: l.id, name: l.name, isArchived: !!l.isArchived });
      });
    }
    const existingTplNames = new Set(Object.values(State.templates || {}).map((t) => (t.name || "").trim().toLowerCase()));

    const review = modal.querySelector("#xImpReview");
    const drop = modal.querySelector("#xImpDrop");
    drop.classList.add("is-loaded");
    drop.querySelector(".xfer-drop__title").textContent = "File loaded";
    drop.querySelector(".xfer-drop__hint").innerHTML = `${model.lists.length} list(s) · ${model.templates.length} template(s)${model.settings ? " · settings" : ""}${model.meta && model.meta.exportedAt ? ` · exported ${Utils.timeAgo(model.meta.exportedAt)}` : ""} <button class="xfer-mini" id="xImpReplace">Change file</button>`;

    if (!model.lists.length && !model.templates.length && !model.settings) {
      review.innerHTML = `<div class="xfer-banner is-error">Nothing importable was found in this file.</div>`;
      modal.querySelector("#xImpBtn").disabled = true;
      return;
    }

    // per-list import config: { include, mode: 'new'|'merge', conflict, items:Set(idx selected), dupKeep: {ytId: idx} }
    const cfg = { lists: {}, templates: {}, settings: !!model.settings, _nameMap: nameMap };
    model.lists.forEach((l, i) => {
      const existing = nameMap.get((l.name || "").trim().toLowerCase()) || null;
      const conflict = !!existing;
      const conflictArchived = !!(existing && existing.isArchived);
      cfg.lists[i] = {
        include: true,
        conflict,
        conflictArchived,
        existingId: existing ? existing.id : null,
        // A clash with an *archived* list defaults to a rename so the import
        // doesn't disappear into the archive; an active-list clash still
        // defaults to merge.
        mode: conflict ? (conflictArchived ? "rename" : "merge") : "new",
        newName: self._suggestName(l.name, nameMap),
        items: new Set(l.items.map((v) => v._idx)),
        dupKeep: {}, // ytId -> chosen _idx (default: first)
      };
      l.duplicates.forEach((d) => { cfg.lists[i].dupKeep[d.youtubeId] = d.items[0]._idx; });
    });
    model.templates.forEach((t, i) => {
      cfg.templates[i] = { include: !existingTplNames.has((t.name || "").trim().toLowerCase()), conflict: existingTplNames.has((t.name || "").trim().toLowerCase()) };
    });

    const renderReview = () => {
      review.innerHTML = self._reviewHtml(model, cfg);
      self._wireReview(modal, review, model, cfg, renderReview, updateSummary);
      updateSummary();
    };

    const updateSummary = () => {
      let nLists = 0, nItems = 0, invalid = false;
      model.lists.forEach((l, i) => {
        const c = cfg.lists[i];
        if (!c.include) return;
        nLists++;
        nItems += self._effectiveItems(l, c).length;
        if (self._renameMsg(i, model, cfg)) invalid = true;
      });
      const nTpl = Object.values(cfg.templates).filter((c) => c.include).length;
      const parts = [];
      if (nLists) parts.push(`${nLists} list${nLists !== 1 ? "s" : ""} · ${nItems} item${nItems !== 1 ? "s" : ""}`);
      if (nTpl) parts.push(`${nTpl} template${nTpl !== 1 ? "s" : ""}`);
      if (cfg.settings && model.settings) parts.push("settings");
      modal.querySelector("#xImpSummary").textContent = parts.length ? "Will import: " + parts.join(", ") : "Nothing selected";
      modal.querySelector("#xImpBtn").disabled = !parts.length || invalid;
    };

    // change-file button
    const replace = drop.querySelector("#xImpReplace");
    if (replace) replace.addEventListener("click", () => modal.querySelector("#xImpFile").click());

    renderReview();

    modal.querySelector("#xImpBtn").onclick = () => self._performImport(modal, model, cfg, close);
  },

  // items actually imported for a list given its config (applies item selection + dedupe)
  _effectiveItems(list, c) {
    const dupSecondary = new Set(); // _idx values that are dup-losers
    list.duplicates.forEach((d) => {
      const keep = c.dupKeep[d.youtubeId];
      d.items.forEach((v) => { if (v._idx !== keep) dupSecondary.add(v._idx); });
    });
    return list.items.filter((v) => c.items.has(v._idx) && !dupSecondary.has(v._idx));
  },

  _reviewHtml(model, cfg) {
    const self = this;
    let html = "";

    if (model.errors && model.errors.length) {
      html += `<div class="xfer-banner is-warn">${model.errors.map(Utils.escapeHtml).join("<br>")}</div>`;
    }

    // settings + templates
    if (model.settings || model.templates.length) {
      html += `<div class="xfer-section"><div class="xfer-section__title">Settings & Templates</div>`;
      if (model.settings) {
        html += `<label class="xfer-opt"><input type="checkbox" id="xImpSettingsCb" ${cfg.settings ? "checked" : ""} /> <span>Import app settings <span class="xfer-warn-inline">overwrites your current theme / card size / status bar</span></span></label>`;
      }
      model.templates.forEach((t, i) => {
        const c = cfg.templates[i];
        html += `<label class="xfer-opt"><input type="checkbox" class="xImpTplCb" data-i="${i}" ${c.include ? "checked" : ""} /> <span>Template: <b>${Utils.escapeHtml(t.name)}</b> ${c.conflict ? '<span class="xfer-badge is-conflict">name exists</span>' : ""}</span></label>`;
      });
      html += `</div>`;
    }

    // lists
    html += `<div class="xfer-section"><div class="xfer-section__title">Lists <div class="xfer-bulk"><button class="xfer-mini" id="xImpAll">All</button><button class="xfer-mini" id="xImpNone">None</button></div></div><div class="xfer-lists">`;
    model.lists.forEach((l, i) => {
      const c = cfg.lists[i];
      const vids = l.items.filter((v) => !self._isNote(v)).length;
      const notes = l.items.filter((v) => self._isNote(v)).length;
      const meta = [`${vids} video${vids !== 1 ? "s" : ""}`, notes ? `${notes} note${notes !== 1 ? "s" : ""}` : null,
        l.syncMode !== "none" ? l.syncMode : null, l.isArchived ? "archived" : null].filter(Boolean).join(" · ");
      const dupCount = l.duplicates.reduce((s, d) => s + (d.items.length - 1), 0);
      html += `
        <div class="xfer-list ${c.include ? "" : "is-off"}" data-i="${i}">
          <div class="xfer-list__head">
            <label class="xfer-check">
              <input type="checkbox" class="xImpListCb" data-i="${i}" ${c.include ? "checked" : ""} />
              <span class="xfer-list__emoji">${l.emoji}</span>
              <span class="xfer-list__name">${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}</span>
            </label>
            ${c.conflict ? `<span class="xfer-badge is-conflict">${c.conflictArchived ? "archived list exists" : "conflicts with existing"}</span>` : ""}
            ${dupCount ? `<span class="xfer-badge is-dup">${dupCount} duplicate${dupCount !== 1 ? "s" : ""}</span>` : ""}
            <span class="xfer-list__meta">${meta}</span>
            <button class="xfer-list__toggle" data-i="${i}">Review items</button>
          </div>
          <div class="xImpListConflict" data-i="${i}" ${c.conflict ? "" : "hidden"}>
            <span class="xfer-dim">${c.conflictArchived
              ? `An <b>archived</b> list named “${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}” already exists. Import under a new name to keep them apart:`
              : `A list named “${Utils.escapeHtml(Utils.stripLeadingEmoji(l.name) || l.name)}” already exists:`}</span>
            <label class="xfer-radio"><input type="radio" name="xmode${i}" value="rename" data-i="${i}" ${c.mode === "rename" ? "checked" : ""} /> Import with a different name</label>
            <div class="xImpRename" data-i="${i}" ${c.mode === "rename" ? "" : "hidden"}>
              <input type="text" class="xImpRenameInput" data-i="${i}" value="${Utils.escapeHtml(c.newName || "")}" placeholder="New list name" />
              <span class="xImpRenameWarn" data-i="${i}" hidden></span>
            </div>
            <label class="xfer-radio"><input type="radio" name="xmode${i}" value="merge" data-i="${i}" ${c.mode === "merge" ? "checked" : ""} /> Merge into ${c.conflictArchived ? "the archived list" : "it"} <span class="xfer-dim">(skip videos already there)</span></label>
            <label class="xfer-radio"><input type="radio" name="xmode${i}" value="new" data-i="${i}" ${c.mode === "new" ? "checked" : ""} /> Create a separate copy <span class="xfer-dim">(keeps the same name)</span></label>
          </div>
          <div class="xImpItems" data-i="${i}" hidden></div>
        </div>`;
    });
    html += `</div></div>`;
    return html;
  },

  _wireReview(modal, review, model, cfg, rerender, updateSummary) {
    const self = this;

    const sCb = review.querySelector("#xImpSettingsCb");
    if (sCb) sCb.addEventListener("change", () => { cfg.settings = sCb.checked; updateSummary(); });

    review.querySelectorAll(".xImpTplCb").forEach((cb) => {
      cb.addEventListener("change", () => { cfg.templates[+cb.dataset.i].include = cb.checked; updateSummary(); });
    });

    review.querySelectorAll(".xImpListCb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const i = +cb.dataset.i;
        cfg.lists[i].include = cb.checked;
        cb.closest(".xfer-list").classList.toggle("is-off", !cb.checked);
        updateSummary();
      });
    });

    const showRenameWarn = (i) => {
      const warn = review.querySelector(`.xImpRenameWarn[data-i="${i}"]`);
      if (!warn) return;
      const msg = self._renameMsg(i, model, cfg);
      warn.textContent = msg;
      warn.hidden = !msg;
    };

    review.querySelectorAll('input[type="radio"][name^="xmode"]').forEach((r) => {
      r.addEventListener("change", () => {
        const i = +r.dataset.i;
        cfg.lists[i].mode = r.value;
        const ren = review.querySelector(`.xImpRename[data-i="${i}"]`);
        if (ren) ren.hidden = r.value !== "rename";
        showRenameWarn(i);
        updateSummary();
      });
    });

    review.querySelectorAll(".xImpRenameInput").forEach((inp) => {
      inp.addEventListener("input", () => {
        const i = +inp.dataset.i;
        cfg.lists[i].newName = inp.value;
        showRenameWarn(i);
        updateSummary();
      });
    });

    const bulkAll = review.querySelector("#xImpAll");
    const bulkNone = review.querySelector("#xImpNone");
    if (bulkAll) bulkAll.addEventListener("click", () => { model.lists.forEach((l, i) => cfg.lists[i].include = true); rerender(); });
    if (bulkNone) bulkNone.addEventListener("click", () => { model.lists.forEach((l, i) => cfg.lists[i].include = false); rerender(); });

    review.querySelectorAll(".xfer-list__toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = +btn.dataset.i;
        const cont = review.querySelector(`.xImpItems[data-i="${i}"]`);
        const show = cont.hidden;
        if (show) self._renderImportItems(cont, model.lists[i], cfg.lists[i], updateSummary);
        cont.hidden = !show;
        btn.textContent = show ? "Hide items" : "Review items";
        btn.classList.toggle("is-open", show);
      });
    });
  },

  _renderImportItems(cont, list, c, updateSummary) {
    const self = this;
    // map _idx -> dup group losers for styling
    const dupOf = {}; // _idx -> youtubeId (if part of a duplicate group)
    list.duplicates.forEach((d) => d.items.forEach((v) => { dupOf[v._idx] = d.youtubeId; }));

    cont.innerHTML = list.items.length ? list.items.map((v) => {
      const isNote = self._isNote(v);
      const checked = c.items.has(v._idx) ? "checked" : "";
      const ico = isNote ? "✎" : "▶";
      const sub = isNote ? "note" : (v.channelName || "");
      const yt = dupOf[v._idx];
      const isKept = yt ? (c.dupKeep[yt] === v._idx) : true;
      const dupTag = yt ? `<span class="xfer-badge ${isKept ? "is-keep" : "is-dup"}" data-dupchoose="${v._idx}" data-yt="${yt}" title="Click to keep this one">${isKept ? "keep" : "duplicate"}</span>` : "";
      const noteText = (v.note && String(v.note).trim()) || (isNote ? String(v.note || "") : "");
      const hasNote = !!(noteText && noteText.trim());
      const noteBtn = (hasNote || isNote) ? `<button class="xfer-item__view" data-view="${v._idx}">view</button>` : "";
      return `<div class="xfer-item-wrap ${yt && !isKept ? "is-duploser" : ""}" data-idx="${v._idx}">
          <label class="xfer-item">
            <input type="checkbox" class="xfer-iitem__cb" data-key="${v._idx}" ${checked} />
            <span class="xfer-item__ico ${isNote ? "is-note" : ""}">${ico}</span>
            <span class="xfer-item__txt"><span class="xfer-item__title">${Utils.escapeHtml(self._videoLabel(v))}</span><span class="xfer-item__sub">${Utils.escapeHtml(sub)}</span></span>
            ${dupTag}
            ${noteBtn}
          </label>
          <div class="xfer-item__detail" data-detail="${v._idx}" hidden></div>
        </div>`;
    }).join("") : '<p class="xfer-dim" style="padding:8px 10px;">This list is empty.</p>';

    cont.querySelectorAll(".xfer-iitem__cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = +cb.dataset.key;
        if (cb.checked) c.items.add(idx); else c.items.delete(idx);
        updateSummary();
      });
    });
    // choose which duplicate to keep
    cont.querySelectorAll("[data-dupchoose]").forEach((tag) => {
      tag.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const idx = +tag.dataset.dupchoose;
        const yt = tag.dataset.yt;
        c.dupKeep[yt] = idx;
        // ensure the kept one is selected
        c.items.add(idx);
        self._renderImportItems(cont, list, c, updateSummary);
        updateSummary();
      });
    });
    // view note / properties
    cont.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const idx = +btn.dataset.view;
        const v = list.items.find((x) => x._idx === idx);
        const detail = cont.querySelector(`.xfer-item__detail[data-detail="${idx}"]`);
        if (!detail) return;
        if (!detail.hidden) { detail.hidden = true; return; }
        detail.innerHTML = self._itemDetailHtml(v);
        detail.hidden = false;
      });
    });
  },

  _itemDetailHtml(v) {
    const isNote = this._isNote(v);
    const rows = [];
    if (!isNote) {
      if (v.youtubeId) rows.push(["URL", `https://youtu.be/${v.youtubeId}`]);
      if (v.channelName) rows.push(["Channel", v.channelName]);
      if (v.duration) rows.push(["Duration", v.duration]);
      if (v.views) rows.push(["Views", v.views]);
      if (v.publishedAt) rows.push(["Published", Utils.formatDate(v.publishedAt)]);
    } else {
      if (v.createdAt) rows.push(["Created", Utils.formatDate(v.createdAt)]);
    }
    const note = (v.note && String(v.note)) || "";
    return `
      <div class="xfer-detail">
        ${rows.map(([k, val]) => `<div class="xfer-detail__row"><span class="xfer-detail__k">${Utils.escapeHtml(k)}</span><span class="xfer-detail__v">${Utils.escapeHtml(val)}</span></div>`).join("")}
        ${note.trim() ? `<div class="xfer-detail__notelabel">Note</div><pre class="xfer-detail__note">${Utils.escapeHtml(note)}</pre>` : '<div class="xfer-dim" style="padding:4px 0;">No note.</div>'}
      </div>`;
  },

  /* =======================================================
     PERFORM IMPORT
     ======================================================= */
  async _performImport(modal, model, cfg, close) {
    const self = this;
    // Build a job plan
    const jobs = [];
    model.lists.forEach((l, i) => {
      const c = cfg.lists[i];
      if (!c.include) return;
      jobs.push({ type: "list", list: l, c });
    });
    const tplJobs = model.templates.map((t, i) => ({ t, c: cfg.templates[i] })).filter((x) => x.c.include);
    const totalSteps = jobs.length + tplJobs.length + (cfg.settings && model.settings ? 1 : 0);

    // Switch the modal body into a progress view
    const body = modal.querySelector(".modal__body");
    body.innerHTML = `
      <div class="xfer-progress">
        <div class="xfer-progress__bar"><div class="xfer-progress__fill" id="xpFill"></div></div>
        <div class="xfer-progress__count" id="xpCount">Starting…</div>
        <div class="xfer-progress__log" id="xpLog"></div>
      </div>
      ${self._importStyles()}`;
    const fill = body.querySelector("#xpFill");
    const count = body.querySelector("#xpCount");
    const logEl = body.querySelector("#xpLog");
    const foot = modal.querySelector(".modal__foot");
    if (foot) foot.innerHTML = `<div style="flex:1"></div><button class="btn btn--primary" id="xpDone" disabled>Working…</button>`;

    let done = 0, added = 0, skipped = 0, errCount = 0;
    const log = (msg, kind = "") => {
      const row = document.createElement("div");
      row.className = "xfer-log__row " + (kind ? "is-" + kind : "");
      row.innerHTML = `<span class="xfer-log__ico">${kind === "error" ? "✕" : kind === "warn" ? "!" : "✓"}</span><span>${Utils.escapeHtml(msg)}</span>`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
    };
    const step = (label) => {
      done++;
      fill.style.width = `${Math.round((done / Math.max(1, totalSteps)) * 100)}%`;
      count.textContent = `${done} / ${totalSteps} — ${label}`;
    };

    // Settings
    if (cfg.settings && model.settings) {
      try {
        const s = model.settings;
        if (s.theme) App.applyTheme(s.theme);
        if (s.cardSize) App.applyCardSize(parseInt(s.cardSize, 10) || State.cardSize);
        if (s.statusbar && window.StatusBar) {
          StatusBar.config = s.statusbar; StatusBar.saveConfig(); StatusBar.render();
        }
        log("Imported app settings");
      } catch (e) { errCount++; log("Settings failed: " + e.message, "error"); }
      step("settings");
      await this._tick();
    }

    // Templates
    for (const { t } of tplJobs) {
      try {
        const ref = DB.templates().push();
        await ref.set({ name: t.name, text: t.text || "", isActive: !!t.isActive, order: t.order ?? self._nextTplOrder(), timestamp: Date.now() });
        added++;
        log(`Template “${t.name}” imported`);
      } catch (e) { errCount++; log(`Template “${t.name}” failed: ${e.message}`, "error"); }
      step(`template ${t.name}`);
      await this._tick();
    }

    // Lists
    for (const job of jobs) {
      const { list, c } = job;
      const name = Utils.stripLeadingEmoji(list.name) || list.name;
      try {
        const items = self._effectiveItems(list, c);
        if (c.conflict && c.mode === "merge") {
          const targetId = c.existingId || (self._findExistingListByName(list.name) || {}).id;
          if (!targetId) { // fallback to creating new
            await self._createListWithItems(list, items);
            added += items.length;
            log(`“${name}” created (no existing list found to merge) — ${items.length} item(s)`);
          } else {
            const res = await self._mergeIntoList(targetId, items);
            added += res.added; skipped += res.skipped;
            log(`Merged ${res.added} item(s) into “${name}”${res.skipped ? `, ${res.skipped} already there` : ""}`, res.added ? "" : "warn");
          }
        } else if (c.conflict && c.mode === "rename") {
          const newName = (c.newName || "").trim() || list.name;
          // Renaming to dodge a clash means the user wants to USE this list now,
          // so bring it in active (not archived) regardless of the source flag.
          await self._createListWithItems({ ...list, name: newName, isArchived: false }, items);
          added += items.length;
          log(`“${newName}” imported (renamed from “${name}”) — ${items.length} item(s)`);
        } else {
          await self._createListWithItems(list, items);
          added += items.length;
          log(`“${name}” created — ${items.length} item(s)`);
        }
      } catch (e) { errCount++; log(`“${name}” failed: ${e.message}`, "error"); }
      step(`list ${name}`);
      await this._tick();
    }

    fill.style.width = "100%";
    count.textContent = `Done — ${added} added${skipped ? `, ${skipped} skipped` : ""}${errCount ? `, ${errCount} error(s)` : ""}`;
    log(`Import complete: ${added} item(s) imported${skipped ? `, ${skipped} skipped` : ""}${errCount ? `, ${errCount} error(s)` : ""}`, errCount ? "warn" : "");

    const doneBtn = modal.querySelector("#xpDone");
    if (doneBtn) { doneBtn.disabled = false; doneBtn.textContent = "Close"; doneBtn.onclick = () => close(); }
    UI.toast(errCount ? `Imported with ${errCount} error(s)` : `Imported ${added} item(s)`, errCount ? "info" : "success");
  },

  _tick() { return new Promise((r) => setTimeout(r, 16)); },

  _nextTplOrder() {
    const orders = Object.values(State.templates || {}).map((t) => t.order ?? 0);
    return (orders.length ? Math.max(...orders) : -1) + 1;
  },

  _findExistingListByName(name) {
    const key = (name || "").trim().toLowerCase();
    const found = Object.values(State.lists || {}).find((l) => (l.name || "").trim().toLowerCase() === key);
    return found || null;
  },

  // Propose a non-colliding name for a conflicting import: "Name", "Name (2)", …
  _suggestName(base, nameMap) {
    const clean = (base || "Untitled list").trim();
    const taken = (n) => nameMap && nameMap.has(n.trim().toLowerCase());
    if (!taken(clean)) return clean;
    for (let i = 2; i < 999; i++) {
      const cand = `${clean} (${i})`;
      if (!taken(cand)) return cand;
    }
    return `${clean} (${Date.now()})`;
  },

  // Validation message for a list's rename ("" === valid). Guards against an
  // empty name, an existing list name, and clashing with another import.
  _renameMsg(i, model, cfg) {
    const c = cfg.lists[i];
    if (!c || !c.include || c.mode !== "rename") return "";
    const name = (c.newName || "").trim();
    if (!name) return "Enter a name";
    if (cfg._nameMap && cfg._nameMap.has(name.toLowerCase())) return "That name is already taken";
    for (let j = 0; j < model.lists.length; j++) {
      if (j === i) continue;
      const oc = cfg.lists[j];
      if (!oc || !oc.include) continue;
      let oname = null;
      if (oc.mode === "rename") oname = (oc.newName || "").trim();
      else if (oc.mode === "new") oname = (model.lists[j].name || "").trim();
      if (oname && oname.toLowerCase() === name.toLowerCase()) return "Another list in this import uses that name";
    }
    return "";
  },

  _prepItemRecord(v, order) {
    const rec = this._sanitizeVideo(v);
    delete rec._idx;
    rec.order = order;
    if (rec.type === "note") {
      rec.name = rec.name || "Untitled note";
      rec.note = rec.note || "";
      rec.createdAt = rec.createdAt || Date.now();
      rec.timestamp = rec.timestamp || rec.createdAt;
      rec.noteTimestamp = rec.noteTimestamp || rec.createdAt;
    } else {
      rec.note = rec.note || "";
      rec.timestamp = rec.timestamp || Date.now();
      if (rec.noteTimestamp === undefined) rec.noteTimestamp = null;
    }
    return rec;
  },

  async _createListWithItems(list, items) {
    const ref = DB.lists().push();
    const maxOrder = Math.max(-1, ...Object.values(State.lists || {}).filter((l) => !l.isArchived).map((l) => l.order ?? 0));
    const videos = {};
    // `items` is already in display order (export sorts ascending by `order`).
    // Assign ascending orders so index 0 stays on top — using -(i+1) here was
    // what flipped imported lists upside-down.
    items.forEach((v, i) => { videos[this._key()] = this._prepItemRecord(v, i); });
    const data = {
      name: list.name,
      emoji: list.emoji || Utils.autoEmoji(list.name),
      playlistId: list.playlistId || null,
      syncMode: list.syncMode || "none",
      order: list.isArchived ? (list.order ?? 0) : maxOrder + 1,
      createdAt: list.createdAt || Date.now(),
      isArchived: !!list.isArchived,
      archivedAt: list.isArchived ? (Date.now()) : null,
    };
    if (Object.keys(videos).length) data.videos = videos;
    await ref.set(data);
  },

  async _mergeIntoList(listId, items) {
    const snap = await DB.videos(listId).once("value");
    const existing = snap.val() || {};
    const existingYt = new Set();
    Object.values(existing).forEach((v) => { if (v && v.youtubeId && v.type !== "note") existingYt.add(v.youtubeId); });
    const base = Math.min(0, ...Object.values(existing).map((v) => v.order ?? 0));
    // Collect the items we'll actually add (after dedupe) first, so we can
    // assign orders that preserve the imported order instead of reversing it.
    const toAdd = [];
    let skipped = 0;
    items.forEach((v) => {
      if (v.type !== "note" && v.youtubeId && existingYt.has(v.youtubeId)) { skipped++; return; }
      if (v.type !== "note" && v.youtubeId) existingYt.add(v.youtubeId);
      toAdd.push(v);
    });
    const updates = {};
    const n = toAdd.length;
    // Place merged items above existing ones, keeping their relative order
    // (first imported item ends up topmost).
    toAdd.forEach((v, idx) => { updates[this._key()] = this._prepItemRecord(v, base - (n - idx)); });
    if (Object.keys(updates).length) await DB.videos(listId).update(updates);
    return { added: toAdd.length, skipped };
  },

  /* =======================================================
     STYLES
     ======================================================= */
  _sharedStyles() {
    return `
      .xfer{display:flex;flex-direction:column;gap:18px;}
      .xfer-intro{font-size:13px;color:var(--text-2);line-height:1.55;}
      .xfer-section{border:1px solid var(--border-soft);border-radius:var(--radius);overflow:hidden;}
      .xfer-section__title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);padding:11px 14px;background:var(--bg-elevated);border-bottom:1px solid var(--border-soft);}
      .xfer-dim{color:var(--text-3);font-weight:400;text-transform:none;letter-spacing:0;}
      .xfer-bulk{margin-left:auto;display:flex;gap:6px;}
      .xfer-mini{border:1px solid var(--border);background:var(--bg-elevated);border-radius:6px;padding:3px 9px;font-size:11px;color:var(--text-2);font-weight:600;}
      .xfer-mini:hover{background:var(--bg-hover);color:var(--text);}
      .xfer-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;font-size:13px;border-bottom:1px solid var(--border-soft);cursor:pointer;}
      .xfer-opt:last-child{border-bottom:none;}
      .xfer-opt input{width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;}
      .xfer-warn-inline{color:var(--warn);font-size:11.5px;margin-left:4px;}
      .xfer-lists{display:flex;flex-direction:column;}
      .xfer-list{border-bottom:1px solid var(--border-soft);}
      .xfer-list:last-child{border-bottom:none;}
      .xfer-list.is-off{opacity:.5;}
      .xfer-list__head{display:flex;align-items:center;gap:10px;padding:10px 14px;flex-wrap:wrap;}
      .xfer-check{display:flex;align-items:center;gap:9px;cursor:pointer;min-width:0;flex:1;}
      .xfer-check input{width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;}
      .xfer-list__emoji{font-size:15px;flex-shrink:0;}
      .xfer-list__name{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .xfer-list__meta{font-size:11.5px;color:var(--text-3);margin-left:auto;white-space:nowrap;}
      .xfer-list__playlist{display:flex;align-items:center;gap:7px;padding:0 14px 9px 39px;font-size:11px;color:var(--text-3);min-width:0;}
      .xfer-list__playlist-ico{color:var(--accent);flex-shrink:0;}
      .xfer-list__playlist a{color:var(--text-2);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .xfer-list__playlist a:hover{color:var(--accent);text-decoration:underline;}
      .xfer-list__toggle{border:1px solid var(--border);background:var(--bg-elevated);border-radius:6px;padding:4px 10px;font-size:11.5px;color:var(--text-2);font-weight:600;flex-shrink:0;}
      .xfer-list__toggle:hover,.xfer-list__toggle.is-open{background:var(--bg-hover);color:var(--text);}
      .xfer-list__items,.xImpItems{padding:4px 14px 12px 38px;display:flex;flex-direction:column;gap:1px;max-height:340px;overflow-y:auto;}
      .xfer-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:7px;cursor:pointer;}
      .xfer-item:hover{background:var(--bg-hover);}
      .xfer-item input{width:15px;height:15px;accent-color:var(--accent);flex-shrink:0;}
      .xfer-item__ico{width:20px;height:20px;border-radius:5px;display:grid;place-items:center;font-size:10px;background:var(--bg-sunken);color:var(--text-3);flex-shrink:0;}
      .xfer-item__ico.is-note{background:var(--accent-soft);color:var(--accent);}
      .xfer-item__txt{min-width:0;display:flex;flex-direction:column;flex:1;}
      .xfer-item__title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .xfer-item__sub{font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .xfer-item__note{color:var(--accent);font-size:12px;flex-shrink:0;}
      .xfer-summary{font-size:12px;color:var(--text-2);}
      .xfer-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:20px;flex-shrink:0;}
      .xfer-badge.is-conflict{background:var(--warn);color:#000;}
      .xfer-badge.is-dup{background:var(--bg-active);color:var(--text-2);cursor:pointer;}
      .xfer-badge.is-keep{background:var(--ok);color:#000;cursor:pointer;}
      .xfer-banner{padding:11px 14px;border-radius:var(--radius-sm);font-size:12.5px;line-height:1.5;}
      .xfer-banner.is-error{background:var(--accent-soft);color:var(--accent);}
      .xfer-banner.is-warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn);}
    `;
  },

  _exportStyles() { return `<style>${this._sharedStyles()}</style>`; },

  _importStyles() {
    return `<style>${this._sharedStyles()}
      .xfer-drop{border:2px dashed var(--border);border-radius:var(--radius);padding:30px 20px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;}
      .xfer-drop:hover,.xfer-drop.is-drag{border-color:var(--accent);background:var(--accent-soft);}
      .xfer-drop.is-loaded{padding:14px 18px;text-align:left;cursor:default;border-style:solid;}
      .xfer-drop.is-loaded:hover{background:none;border-color:var(--border);}
      .xfer-drop__ico{font-size:26px;color:var(--accent);margin-bottom:8px;}
      .xfer-drop.is-loaded .xfer-drop__ico{display:none;}
      .xfer-drop__title{font-weight:650;font-size:14px;margin-bottom:4px;}
      .xfer-drop__hint{font-size:12px;color:var(--text-3);display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;}
      .xfer-drop.is-loaded .xfer-drop__hint{justify-content:flex-start;}
      .xImpListConflict{padding:2px 14px 12px 38px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;}
      .xImpRename{padding:2px 0 4px 23px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
      .xImpRenameInput{flex:1;min-width:180px;background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:7px 10px;font-size:12.5px;color:var(--text);font-family:inherit;}
      .xImpRenameInput:focus{outline:none;border-color:var(--accent);}
      .xImpRenameWarn{font-size:11.5px;color:var(--warn);font-weight:600;}
      .xfer-radio{display:flex;align-items:center;gap:8px;cursor:pointer;}
      .xfer-radio input{width:15px;height:15px;accent-color:var(--accent);}
      .xfer-item-wrap.is-duploser{opacity:.55;}
      .xfer-item__view{margin-left:auto;border:1px solid var(--border);background:var(--bg-elevated);border-radius:6px;padding:2px 9px;font-size:10.5px;color:var(--text-2);font-weight:600;flex-shrink:0;}
      .xfer-item__view:hover{background:var(--bg-hover);color:var(--text);}
      .xfer-item__detail{margin:2px 0 8px 30px;padding:10px 12px;background:var(--bg-sunken);border:1px solid var(--border-soft);border-radius:var(--radius-sm);}
      .xfer-detail__row{display:flex;gap:10px;font-size:12px;padding:2px 0;}
      .xfer-detail__k{color:var(--text-3);width:84px;flex-shrink:0;}
      .xfer-detail__v{color:var(--text-2);word-break:break-word;}
      .xfer-detail__notelabel{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin:8px 0 4px;font-weight:600;}
      .xfer-detail__note{background:var(--bg);border:1px solid var(--border-soft);border-radius:6px;padding:9px 11px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow-y:auto;font-family:var(--font-mono);color:var(--text-2);}
      .xfer-progress{display:flex;flex-direction:column;gap:14px;}
      .xfer-progress__bar{height:8px;background:var(--bg-sunken);border-radius:20px;overflow:hidden;}
      .xfer-progress__fill{height:100%;width:0;background:var(--accent);border-radius:20px;transition:width .25s ease;}
      .xfer-progress__count{font-size:13px;font-weight:600;color:var(--text);}
      .xfer-progress__log{display:flex;flex-direction:column;gap:3px;max-height:46vh;overflow-y:auto;overflow-x:hidden;border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:10px;background:var(--bg-sunken);}
      .xfer-log__row{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--text-2);line-height:1.5;min-width:0;}
      .xfer-log__row span:last-child{min-width:0;word-break:break-word;}
      .xfer-log__ico{width:16px;text-align:center;color:var(--ok);flex-shrink:0;}
      .xfer-log__row.is-error{color:var(--accent);}
      .xfer-log__row.is-error .xfer-log__ico{color:var(--accent);}
      .xfer-log__row.is-warn{color:var(--warn);}
      .xfer-log__row.is-warn .xfer-log__ico{color:var(--warn);}
    </style>`;
  },
};
