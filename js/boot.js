/* =========================================================
   app.js — orchestration: theme, layout, search, paste, boot
   v1
   ========================================================= */

const App = {
  _mql: null,

  // Theme families — each has a light AND dark variant defined in styles.css
  // as [data-theme="<family>-light"] / [data-theme="<family>-dark"].
  // The final theme = chosen family × chosen mode (light / dark / system).
  FAMILIES: [
    { id: "classic",  name: "Classic",  accent: "oklch(.62 .20 18)",  dark: "oklch(.18 .006 260)", light: "oklch(.99 .002 260)" },
    { id: "redplus",  name: "Red Plus", accent: "oklch(.64 .245 24)", dark: "oklch(.185 .022 20)",  light: "oklch(.99 .01 25)" },
    { id: "indigo",   name: "Indigo",   accent: "oklch(.64 .21 274)", dark: "oklch(.185 .04 272)",  light: "oklch(.985 .012 275)" },
    { id: "graphite", name: "Graphite", accent: "oklch(.74 .16 195)", dark: "oklch(.195 .012 210)", light: "oklch(.98 .004 200)" },
    { id: "forest",   name: "Forest",   accent: "oklch(.73 .18 152)", dark: "oklch(.185 .03 158)",  light: "oklch(.985 .014 150)" },
    { id: "amber",    name: "Amber",    accent: "oklch(.77 .17 62)",  dark: "oklch(.195 .022 45)",  light: "oklch(.99 .016 75)" },
    { id: "ocean",    name: "Ocean",    accent: "oklch(.68 .18 242)", dark: "oklch(.185 .035 240)", light: "oklch(.99 .006 250)" },
    { id: "violet",   name: "Violet",   accent: "oklch(.66 .24 310)", dark: "oklch(.185 .035 305)", light: "oklch(.985 .012 310)" },
  ],
  MODES: ["light", "dark", "system"],
  family: "classic",
  mode: "system",
  tint: false,

  init() {
    this.initTheme();
    this.applyCardSize(State.cardSize);
    this.wireChrome();
    this.wireSettings();
    this.wireSearch();
    this.wireGlobalPaste();
    StatusBar.init();
    Auth.init();
  },

  // ---------- THEME (family × mode) ----------
  initTheme() {
    let family = localStorage.getItem("ylo_theme_family");
    let mode = localStorage.getItem("ylo_theme_mode");
    // migrate the old single-value setting, if present
    if (!family || !mode) {
      const old = localStorage.getItem("ylo_theme");
      const map = { midnight: "indigo", graphite: "graphite", forest: "forest", dusk: "amber", dawn: "amber", mist: "ocean" };
      if (old === "light" || old === "dark" || old === "system") { mode = mode || old; family = family || "classic"; }
      else if (old && map[old]) { family = family || map[old]; mode = mode || (old === "dawn" || old === "mist" ? "light" : "dark"); }
    }
    this.family = this.FAMILIES.some((f) => f.id === family) ? family : "classic";
    this.mode = this.MODES.includes(mode) ? mode : "system";
    this.tint = localStorage.getItem("ylo_theme_tint") === "on";
    this.applyAppearance();
  },

  applyAppearance() {
    let eff = this.mode;
    if (this.mode === "system") {
      eff = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      if (!this._mql) {
        this._mql = matchMedia("(prefers-color-scheme: dark)");
        this._mql.addEventListener("change", () => { if (this.mode === "system") this.applyAppearance(); });
      }
    }
    document.documentElement.setAttribute("data-theme", `${this.family}-${eff}`);
    document.documentElement.setAttribute("data-tint", this.tint ? "on" : "off");
    localStorage.setItem("ylo_theme_family", this.family);
    localStorage.setItem("ylo_theme_mode", this.mode);
    localStorage.setItem("ylo_theme_tint", this.tint ? "on" : "off");
    State.theme = this.mode; // kept for backward compatibility
    this.renderThemeControls();
  },

  setMode(mode) { if (!this.MODES.includes(mode)) return; this.mode = mode; this.applyAppearance(); },
  setFamily(family) { if (!this.FAMILIES.some((f) => f.id === family)) return; this.family = family; this.applyAppearance(); },
  setTint(on) { this.tint = !!on; this.applyAppearance(); },

  renderThemeControls() {
    const host = document.getElementById("themePicker");
    if (host) {
      host.innerHTML = this.FAMILIES.map((f) => `
        <button class="theme-sw ${f.id === this.family ? "is-active" : ""}" data-family="${f.id}" title="${f.name}" aria-label="${f.name}">
          <span class="theme-sw__split" style="background:linear-gradient(125deg, ${f.dark} 0 52%, ${f.light} 52% 100%)"></span>
          <span class="theme-sw__accent" style="background:${f.accent}"></span>
          <span class="theme-sw__check">✓</span>
        </button>`).join("");
    }
    const seg = document.getElementById("modeSeg");
    if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === this.mode));
    const tgl = document.getElementById("tintToggle");
    if (tgl) { tgl.classList.toggle("is-on", this.tint); tgl.setAttribute("aria-checked", this.tint ? "true" : "false"); }
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
    // caret reveals the secondary "add" actions (note / channel) in a dropdown
    const addMoreBtn = document.getElementById("addMoreBtn");
    addMoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      UI.floatingMenu(addMoreBtn, [
        { key: "note", ico: "📝", text: "Add Note", onClick: () => Videos.createNoteAndOpen() },
        { key: "channel", ico: "📺", text: "Add Channel", onClick: () => Videos.openAddChannelModal() },
      ], { align: "right" });
      addMoreBtn.setAttribute("aria-expanded", "true");
      // reset the caret once the menu is dismissed (item click or outside click)
      setTimeout(() => {
        const reset = () => { addMoreBtn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", reset); };
        document.addEventListener("mousedown", reset);
      }, 0);
    });
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
      menu.hidden = true;
      if (act === "archived") Lists.openArchivedModal();
      else if (act === "templates") Templates.openManager();
      else if (act === "export") Transfer.openExport();
      else if (act === "import") Transfer.openImport();
    });
    const slider = document.getElementById("cardSizeSlider");
    slider.addEventListener("input", () => this.applyCardSize(parseInt(slider.value, 10)));
    slider.addEventListener("mousedown", (e) => e.stopPropagation());

    // theme picker (family) + appearance mode — keep the menu open on change
    const picker = document.getElementById("themePicker");
    if (picker) {
      picker.addEventListener("click", (e) => {
        const sw = e.target.closest(".theme-sw");
        if (!sw) return;
        this.setFamily(sw.dataset.family);
        const t = this.FAMILIES.find((x) => x.id === sw.dataset.family);
        UI.toast(`Theme: ${t ? t.name : sw.dataset.family}`, "info", 1400);
      });
    }
    const modeSeg = document.getElementById("modeSeg");
    if (modeSeg) {
      modeSeg.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-mode]");
        if (!b) return;
        this.setMode(b.dataset.mode);
      });
    }
    const tint = document.getElementById("tintToggle");
    if (tint) {
      tint.addEventListener("click", (e) => { e.stopPropagation(); this.setTint(!this.tint); });
    }
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
