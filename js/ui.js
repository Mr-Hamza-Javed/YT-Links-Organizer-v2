/* =========================================================
   ui.js — toasts, loading overlay, modals, confirm dialogs
   ========================================================= */

const UI = {
  // ---------- TOASTS ----------
  toast(message, type = "info", ms = 3200) {
    const host = document.getElementById("toastHost");
    const el = document.createElement("div");
    el.className = `toast is-${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    }, ms);
  },

  // ---------- LOADING ----------
  _loadingCount: 0,
  showLoading(msg = "Loading…") {
    this._loadingCount++;
    const ov = document.getElementById("loadingOverlay");
    document.getElementById("loadingMsg").textContent = msg;
    ov.hidden = false;
  },
  hideLoading(force = false) {
    this._loadingCount = force ? 0 : Math.max(0, this._loadingCount - 1);
    if (this._loadingCount === 0) document.getElementById("loadingOverlay").hidden = true;
  },

  // ---------- MODALS (right-drawer) ----------
  // opts: { title, bodyHtml, footHtml, wide, full, onMount, onClose }
  openModal(opts) {
    const host = document.getElementById("modalHost");
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const sizeClass = opts.full ? "modal--full" : (opts.wide ? "modal--wide" : "");
    overlay.innerHTML = `
      <div class="modal ${sizeClass}" role="dialog" aria-modal="true"${opts.widthPx ? ` style="width:${opts.widthPx}px;max-width:96vw;"` : ""}>
        <div class="modal__head">
          <div class="modal__title">${Utils.escapeHtml(opts.title || "")}</div>
          <button class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal__body">${opts.bodyHtml || ""}</div>
        ${opts.footHtml ? `<div class="modal__foot">${opts.footHtml}</div>` : ""}
      </div>`;
    host.appendChild(overlay);

    const close = (result) => {
      if (overlay._closed) return;
      overlay._closed = true;
      if (opts.onClose) { try { opts.onClose(result); } catch (e) { console.error(e); } }
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    overlay.__close = close;

    const onKey = (e) => {
      // Esc closes topmost modal only
      if (e.key === "Escape") {
        const modals = host.querySelectorAll(".modal-overlay");
        if (modals[modals.length - 1] === overlay) { e.preventDefault(); close(); }
      }
    };
    document.addEventListener("keydown", onKey);

    overlay.querySelector(".modal-close").addEventListener("click", () => close());
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) { overlay._downOnBackdrop = true; }
      else { overlay._downOnBackdrop = false; }
    });
    overlay.addEventListener("mouseup", (e) => {
      if (e.target === overlay && overlay._downOnBackdrop) close();
    });

    if (opts.onMount) opts.onMount(overlay.querySelector(".modal"), close);
    return overlay;
  },

  // ---------- CONFIRM (always on top) ----------
  // returns a Promise<boolean>
  confirm({ title, message, confirmText = "Confirm", danger = true, cancelText = "Cancel" }) {
    return new Promise((resolve) => {
      const host = document.getElementById("confirmHost");
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay confirm-layer";
      overlay.innerHTML = `
        <div class="confirm" role="dialog" aria-modal="true">
          <div class="confirm__title">${Utils.escapeHtml(title || "Are you sure?")}</div>
          <div class="confirm__msg">${message || ""}</div>
          <div class="confirm__actions">
            <button class="btn btn--ghost" data-act="cancel">${Utils.escapeHtml(cancelText)}</button>
            <button class="btn ${danger ? "btn--danger" : "btn--primary"}" data-act="ok">${Utils.escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      host.appendChild(overlay);
      const done = (val) => {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        if (e.key === "Enter") { e.preventDefault(); done(true); }
      };
      document.addEventListener("keydown", onKey);
      overlay.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
      overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => done(false));
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(false); });
      overlay.querySelector('[data-act="ok"]').focus();
    });
  },

  // ---------- PROMPT (simple text input) ----------
  prompt({ title, label, value = "", placeholder = "", confirmText = "Save" }) {
    return new Promise((resolve) => {
      // Guard so we resolve exactly once. The submit path must win over the
      // modal's onClose (which fires during close() and would otherwise
      // resolve null and discard the typed value).
      let settled = false;
      const finish = (val) => { if (settled) return; settled = true; resolve(val); };
      const ov = this.openModal({
        title,
        bodyHtml: `<div class="field"><label>${Utils.escapeHtml(label || "")}</label>
          <input class="input" id="promptInput" value="${Utils.escapeHtml(value)}" placeholder="${Utils.escapeHtml(placeholder)}" /></div>`,
        footHtml: `<button class="btn btn--ghost" data-act="cancel">Cancel</button>
                   <button class="btn btn--primary" data-act="ok">${Utils.escapeHtml(confirmText)}</button>`,
        onMount: (modal, close) => {
          const input = modal.querySelector("#promptInput");
          input.focus(); input.select();
          // Resolve with the trimmed string (may be "") so callers can decide
          // how to treat a blank value; only cancel/close resolves null.
          const submit = () => { finish(input.value.trim()); close(); };
          modal.querySelector('[data-act="ok"]').addEventListener("click", submit);
          modal.querySelector('[data-act="cancel"]').addEventListener("click", () => { finish(null); close(); });
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
        },
        onClose: () => finish(null),
      });
    });
  },

  // ---------- popover helpers ----------
  closeAllPopovers(except) {
    document.querySelectorAll(".popover").forEach((p) => {
      if (p !== except && !p.hidden) p.hidden = true;
    });
    document.querySelectorAll(".floating-popover").forEach((p) => { if (p !== except) p.remove(); });
  },

  // floating popover anchored to a button (for list/card menus)
  floatingMenu(anchorEl, items, { align = "right" } = {}) {
    this.closeAllPopovers();
    const pop = document.createElement("div");
    pop.className = "popover floating-popover";
    pop.style.position = "fixed";
    pop.innerHTML = items.map((it) => {
      if (it.divider) return `<div class="popover__divider"></div>`;
      if (it.label) return `<div class="popover__submenu-label">${Utils.escapeHtml(it.label)}</div>`;
      return `<button class="popover__item ${it.danger ? "is-danger" : ""}" data-key="${it.key}">
        <span class="popover__ico">${it.ico || ""}</span><span>${Utils.escapeHtml(it.text)}</span></button>`;
    }).join("");
    document.body.appendChild(pop);

    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = align === "right" ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    pop.querySelectorAll(".popover__item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const item = items.find((i) => i.key === key);
        pop.remove();
        if (item && item.onClick) item.onClick();
      });
    });
    setTimeout(() => {
      const onDoc = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("mousedown", onDoc); } };
      document.addEventListener("mousedown", onDoc);
    }, 0);
    return pop;
  },
};

// global popover dismissal
document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".popover") || e.target.closest("[data-popover-trigger]")) return;
  UI.closeAllPopovers();
});
