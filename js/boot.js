/* =========================================================
   app.js — orchestration: theme, layout, search, paste, boot
   v1
   ========================================================= */

const App = {
  _mql: null,

  init() {
    this.applyTheme(State.theme);
    this.applyCardSize(State.cardSize);
    this.wireChrome();
    this.wireSettings();
    this.wireSearch();
    this.wireGlobalPaste();
    StatusBar.init();
    Auth.init();
  },

  // ---------- THEME ----------
  applyTheme(theme) {
    State.theme = theme;
    localStorage.setItem("ylo_theme", theme);
    let effective = theme;
    if (theme === "system") {
      effective = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      if (!this._mql) {
        this._mql = matchMedia("(prefers-color-scheme: dark)");
        this._mql.addEventListener("change", () => { if (State.theme === "system") this.applyTheme("system"); });
      }
    }
    document.documentElement.setAttribute("data-theme", effective);
    const labels = { light: "Light", dark: "Dark", system: "System" };
    const icos = { light: "☀️", dark: "🌙", system: "🖥️" };
    const lbl = document.getElementById("themeLabel"); if (lbl) lbl.textContent = labels[theme];
    const ico = document.getElementById("themeIco"); if (ico) ico.textContent = icos[theme];
  },
  cycleTheme() {
    const order = ["light", "dark", "system"];
    const next = order[(order.indexOf(State.theme) + 1) % order.length];
    this.applyTheme(next);
    UI.toast(`Theme: ${next.charAt(0).toUpperCase() + next.slice(1)}`, "info", 1400);
  },

  // ---------- CARD SIZE ----------
  applyCardSize(px) {
    State.cardSize = px;
    localStorage.setItem("ylo_cardsize", String(px));
    document.documentElement.style.setProperty("--card-w", px + "px");
    const slider = document.getElementById("cardSizeSlider");
    const val = document.getElementById("cardSizeVal");
    if (slider) slider.value = px;
    if (val) val.textContent = px;
  },

  // ---------- CHROME: collapse, drawer, hamburger ----------
  wireChrome() {
    const app = document.getElementById("app");
    document.getElementById("collapseBtn").addEventListener("click", () => {
      State.collapsed = !State.collapsed;
      app.classList.toggle("is-collapsed", State.collapsed);
      const cb = document.getElementById("collapseBtn");
      cb.title = State.collapsed ? "Expand sidebar" : "Collapse sidebar";
    });
    document.getElementById("expandSidebarBtn").addEventListener("click", () => {
      State.collapsed = false; app.classList.remove("is-collapsed");
    });
    document.getElementById("hamburgerBtn").addEventListener("click", () => app.classList.add("drawer-open"));
    document.getElementById("mobileBackdrop").addEventListener("click", () => this.closeDrawer());
    document.getElementById("createListBtn").addEventListener("click", () => Lists.openCreateModal());
    document.getElementById("addVideoBtn").addEventListener("click", () => Videos.openAddModal());
    document.getElementById("addNoteBtn").addEventListener("click", () => Videos.createNoteAndOpen());
  },
  closeDrawer() { document.getElementById("app").classList.remove("drawer-open"); },

  // ---------- SETTINGS dropdown ----------
  wireSettings() {
    const btn = document.getElementById("settingsBtn");
    const menu = document.getElementById("settingsMenu");
    btn.setAttribute("data-popover-trigger", "");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const showing = !menu.hidden;
      UI.closeAllPopovers();
      menu.hidden = showing;
    });
    menu.addEventListener("click", (e) => {
      const item = e.target.closest(".popover__item");
      if (!item) return;
      const act = item.dataset.action;
      if (act === "theme") { this.cycleTheme(); return; } // keep menu open
      menu.hidden = true;
      if (act === "archived") Lists.openArchivedModal();
      else if (act === "templates") Templates.openManager();
      else if (act === "export") Transfer.openExport();
      else if (act === "import") Transfer.openImport();
    });
    const slider = document.getElementById("cardSizeSlider");
    slider.addEventListener("input", () => this.applyCardSize(parseInt(slider.value, 10)));
    slider.addEventListener("mousedown", (e) => e.stopPropagation());
  },

  // ---------- SEARCH ----------
  wireSearch() {
    const input = document.getElementById("searchInput");
    const clear = document.getElementById("searchClear");
    const run = Utils.debounce(() => {
      State.searchTerm = input.value;
      clear.hidden = !input.value;
      Videos.applySearchFilter();
    }, 180);
    input.addEventListener("input", run);
    clear.addEventListener("click", () => {
      input.value = ""; State.searchTerm = ""; clear.hidden = true;
      Videos.applySearchFilter(); input.focus();
    });
  },

  // ---------- GLOBAL PASTE ----------
  wireGlobalPaste() {
    document.addEventListener("paste", (e) => {
      const t = e.target;
      // ignore if focused in an input/textarea/contenteditable
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // ignore if a modal is already open
      if (document.querySelector("#modalHost .modal-overlay")) return;
      if (!State.uid || !State.activeListId) return;
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!text) return;
      if (Utils.isYouTubeUrl(text)) {
        e.preventDefault();
        const l = State.lists[State.activeListId];
        if (l && l.syncMode === "sync") { UI.toast("This list mirrors a playlist — adding is blocked", "error"); return; }
        Videos.openAddModal(text.trim());
      }
    });
  },

  // ---------- AUTH lifecycle ----------
  async onSignedIn() {
    document.getElementById("listEmptyMsg").hidden = true;
    UI.showLoading("Loading your library…");
    try {
      await YT.loadChannelCache();
    } catch (e) { /* non-fatal */ }
    Lists.subscribe();
    Templates.subscribe();
    UI.hideLoading();
  },

  onSignedOut() {
    // detach listeners
    if (Videos._videoRef) { Videos._videoRef.off(); Videos._videoRef = null; }
    Lists.unsubscribe();
    Templates.unsubscribe();
    State.lists = {}; State.videos = {}; State.templates = {}; State.activeListId = null; State.archivedOpen = new Set();
    document.getElementById("listContainer").innerHTML = "";
    document.getElementById("listEmptyMsg").hidden = false;
    Videos.refreshActiveHeader();
    Videos.render();
    StatusBar.render();
  },
};

window.addEventListener("DOMContentLoaded", () => App.init());
