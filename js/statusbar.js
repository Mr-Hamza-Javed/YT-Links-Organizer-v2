/* =========================================================
   statusbar.js — VS Code style stat chips + config
   ========================================================= */

const StatusBar = {
  ALL_CHIPS: [
    { key: "mode",     ico: "◆", label: "List Mode" },
    { key: "total",    ico: "▦", label: "Total Videos" },
    { key: "notes",    ico: "✎", label: "Total Notes" },
    { key: "channels", ico: "📺", label: "Total Channels" },
    { key: "lastAdded",ico: "+", label: "Last Video Added" },
    { key: "lastNote", ico: "✐", label: "Last Note Updated" },
    { key: "duration", ico: "⏱", label: "Total Duration" },
  ],

  config: null,

  init() {
    const saved = localStorage.getItem("ylo_statusbar");
    if (saved) {
      try { this.config = JSON.parse(saved); } catch (e) { this.config = null; }
    }
    if (!this.config) {
      this.config = this.ALL_CHIPS.map((c) => ({ key: c.key, enabled: true }));
    }
    // ensure all known chips are represented (for forward-compat)
    this.ALL_CHIPS.forEach((c) => {
      if (!this.config.find((x) => x.key === c.key)) this.config.push({ key: c.key, enabled: true });
    });
    document.getElementById("statusGear").addEventListener("click", () => this.openConfig());
    this.render();
  },

  saveConfig() { localStorage.setItem("ylo_statusbar", JSON.stringify(this.config)); },

  meta(key) { return this.ALL_CHIPS.find((c) => c.key === key); },

  computeValue(key) {
    try {
      return this._compute(key);
    } catch (e) {
      console.warn("statusbar compute failed", key, e);
      return "—";
    }
  },

  _compute(key) {
    const l = State.lists[State.activeListId];
    const vids = Object.values(State.videos).filter((v) => v && v.type !== "note" && v.type !== "channel");
    const allItems = Object.values(State.videos);
    switch (key) {
      case "mode": {
        if (!l) return "—";
        return l.syncMode === "sync" ? "Sync" : l.syncMode === "pull" ? "Pull" : "Manual";
      }
      case "total": return String(vids.length);
      case "notes": return String(allItems.filter((v) => (v.note && v.note.trim() && v.type !== "channel") || v.type === "note").length);
      case "channels": return String(allItems.filter((v) => v.type === "channel").length);
      case "lastAdded": {
        const times = allItems.map((v) => v.timestamp || v.createdAt).filter(Boolean);
        return times.length ? Utils.timeAgo(Math.max(...times)) : "—";
      }
      case "lastNote": {
        const times = allItems.filter((v) => (v.note && v.note.trim()) || v.type === "note").map((v) => v.noteTimestamp || v.createdAt).filter(Boolean);
        return times.length ? Utils.timeAgo(Math.max(...times)) : "—";
      }
      case "duration": {
        const total = vids.reduce((s, v) => s + (v.durationSeconds || Utils.durationToSeconds(v.rawApiData?.contentDetails?.duration) || 0), 0);
        return total ? Utils.formatTotalSeconds(total) : "0:00";
      }
      default: return "—";
    }
  },

  render() {
    const host = document.getElementById("statusChips");
    if (!host) return;
    let enabled = this.config.filter((c) => c.enabled);
    // never let the bar go completely empty — fall back to defaults
    if (!enabled.length) enabled = this.ALL_CHIPS.map((c) => ({ key: c.key, enabled: true }));
    try {
      host.innerHTML = enabled.map((c) => {
        const m = this.meta(c.key);
        if (!m) return "";
        return `<div class="status-chip" title="${m.label}">
          <span class="status-chip__ico">${m.ico}</span>
          <span class="status-chip__lbl">${m.label}:</span>
          <span class="status-chip__val">${Utils.escapeHtml(this.computeValue(c.key))}</span>
        </div>`;
      }).join("");
    } catch (e) {
      console.warn("statusbar render failed", e);
    }
  },

  openConfig() {
    const self = this;
    UI.openModal({
      title: "Status Bar",
      bodyHtml: `
        <p class="hint" style="margin-bottom:14px;">Toggle which stats appear and drag to reorder them.</p>
        <div class="sb-config" id="sbConfig"></div>
        <style>
          .sb-config{display:flex;flex-direction:column;gap:6px;}
          .sb-row{display:flex;align-items:center;gap:11px;padding:10px 12px;background:var(--bg-elevated);border:1px solid var(--border-soft);border-radius:var(--radius-sm);}
          .sb-row__handle{cursor:grab;color:var(--text-3);}
          .sb-row__ico{width:18px;text-align:center;color:var(--accent);}
          .sb-row__label{flex:1;font-size:13px;font-weight:500;}
          .sb-row input{width:38px;height:22px;}
          .sb-switch{position:relative;width:38px;height:22px;flex-shrink:0;}
          .sb-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;}
          .sb-switch__track{position:absolute;inset:0;background:var(--border);border-radius:20px;transition:background .15s;}
          .sb-switch__track::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;}
          .sb-switch input:checked + .sb-switch__track{background:var(--accent);}
          .sb-switch input:checked + .sb-switch__track::after{transform:translateX(16px);}
        </style>`,
      footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                 <button class="btn btn--primary" data-act="save">Save</button>`,
      onMount: (modal, close) => {
        const cont = modal.querySelector("#sbConfig");
        const render = () => {
          cont.innerHTML = self.config.map((c) => {
            const m = self.meta(c.key); if (!m) return "";
            return `<div class="sb-row" data-key="${c.key}">
              <span class="sb-row__handle">⋮⋮</span>
              <span class="sb-row__ico">${m.ico}</span>
              <span class="sb-row__label">${m.label}</span>
              <label class="sb-switch"><input type="checkbox" ${c.enabled ? "checked" : ""} data-key="${c.key}" /><span class="sb-switch__track"></span></label>
            </div>`;
          }).join("");
          cont.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener("change", () => {
              const item = self.config.find((x) => x.key === cb.dataset.key);
              if (item) item.enabled = cb.checked;
            });
          });
        };
        render();
        if (window.Sortable) {
          Sortable.create(cont, {
            handle: ".sb-row__handle", animation: 150,
            onEnd: () => {
              const order = [...cont.querySelectorAll(".sb-row")].map((r) => r.dataset.key);
              self.config.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
            },
          });
        }
        modal.querySelector('[data-act="cancel"]').addEventListener("click", () => close());
        modal.querySelector('[data-act="save"]').addEventListener("click", () => {
          self.saveConfig(); self.render(); close();
          UI.toast("Status bar updated", "success", 1500);
        });
      },
    });
  },
};

// Expose globally — `const` declarations do NOT become properties of `window`,
// so the `if (window.StatusBar)` guards in videos.js / notes.js / transfer.js
// would otherwise never fire and the bar would never refresh on list change.
window.StatusBar = StatusBar;
