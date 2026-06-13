/* =========================================================
   templates.js — custom copy-format engine + manager
   ========================================================= */

const Templates = {
  _ref: null,
  unsubscribe() { if (this._ref) { this._ref.off(); this._ref = null; } },
  subscribe() {
    this.unsubscribe();
    this._ref = DB.templates();
    this._ref.on("value", (snap) => {
      State.templates = snap.val() || {};
      Object.entries(State.templates).forEach(([id, t]) => { t.id = id; });
    });
  },

  ordered() {
    return Object.values(State.templates).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },
  activeOrdered() {
    return this.ordered().filter((t) => t.isActive);
  },

  // ---------- build variable map from a video ----------
  buildVars(video) {
    if (!video) return {};
    return {
      title: video.title || "",
      url: `https://www.youtube.com/watch?v=${video.youtubeId}`,
      channel: video.channelName || "",
      duration: video.duration || "",
      views: video.views || "0",
      viewsRaw: video.viewCountRaw ?? 0,
      published: Utils.timeAgo(video.publishedAt),
      publishedDate: Utils.formatDate(video.publishedAt),
      subscribers: video.subscribers || "0",
      subscribersRaw: video.subscriberCountRaw ?? 0,
      thumbnail: video.thumbnail || "",
      note: video.note || "",
    };
  },

  // ---------- compile a template string against a video ----------
  // Syntax:
  //   !%{variableName}%!         → variable substitution
  //   !%{ ...js... }%!           → JS block (expression or function body w/ return)
  //   *!%{ ...js... }%!          → error fallback (immediately follows a JS block)
  compile(text, video) {
    if (!text) return "";
    const vars = this.buildVars(video);

    // Tokenise into ordered chunks so a fallback can attach to the preceding JS block.
    const tokenRe = /(\*?)!%\{([\s\S]*?)\}%!/g;
    const chunks = [];
    let last = 0, m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) chunks.push({ type: "text", value: text.slice(last, m.index) });
      const isFallback = m[1] === "*";
      const inner = m[2];
      // a bare variable name?
      const trimmed = inner.trim();
      const isVar = !isFallback && /^[a-zA-Z_$][\w$]*$/.test(trimmed) && Object.prototype.hasOwnProperty.call(vars, trimmed);
      chunks.push({ type: isFallback ? "fallback" : (isVar ? "var" : "js"), value: inner, raw: trimmed });
      last = tokenRe.lastIndex;
    }
    if (last < text.length) chunks.push({ type: "text", value: text.slice(last) });

    // First pass: resolve variables in JS chunks BEFORE running JS.
    const resolveVarsInside = (code) =>
      code.replace(/!%\{\s*([a-zA-Z_$][\w$]*)\s*\}%!/g, (mm, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? JSON.stringify(vars[name]) : mm);

    let out = "";
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.type === "text") { out += c.value; continue; }
      if (c.type === "var") { out += String(vars[c.raw] ?? ""); continue; }
      if (c.type === "js") {
        let result, threw = false, errVal = null;
        try {
          result = this._runJs(resolveVarsInside(c.value), vars);
        } catch (err) { threw = true; errVal = err; }
        if (threw) {
          // look for an immediately-following fallback chunk
          const next = chunks[i + 1];
          if (next && next.type === "fallback") {
            try { result = this._runJs(resolveVarsInside(next.value), { ...vars, _error: String(errVal && errVal.message || errVal) }); }
            catch (e2) { result = `[error: ${e2.message}]`; }
            i++; // consume fallback
          } else {
            result = `[error: ${errVal && errVal.message || errVal}]`;
          }
        } else {
          // skip an orphan fallback that follows a successful block
          const next = chunks[i + 1];
          if (next && next.type === "fallback") i++;
        }
        out += (result == null ? "" : String(result));
        continue;
      }
      if (c.type === "fallback") { /* orphan fallback w/o preceding js → ignore */ continue; }
    }
    return out;
  },

  _runJs(code, scope) {
    const hasReturn = /\breturn\b/.test(code);
    const keys = Object.keys(scope);
    const vals = keys.map((k) => scope[k]);
    const body = hasReturn ? code : `return (${code});`;
    // eslint-disable-next-line no-new-func
    const fn = new Function(...keys, body);
    return fn(...vals);
  },

  // ---------- copy a template result for a video ----------
  async copyForVideo(templateId, video) {
    const t = State.templates[templateId];
    if (!t) return;
    try {
      const result = this.compile(t.text, video);
      const ok = await Utils.copyToClipboard(result);
      UI.toast(ok ? `Copied “${t.name}” to clipboard` : "Couldn't access clipboard", ok ? "success" : "error");
    } catch (e) {
      UI.toast("Template error: " + e.message, "error");
    }
  },

  // ---------- MANAGE TEMPLATES (fullscreen) ----------
  openManager() {
    if (!State.uid) { UI.toast("Please sign in", "info"); return; }
    const self = this;
    UI.openModal({
      title: "Manage Templates",
      full: true,
      bodyHtml: `
        <div class="tpl-mgr">
          <div class="tpl-mgr__editor">
            <div class="tpl-row">
              <div class="field" style="flex:1;margin:0;"><label>Template name</label><input class="input" id="tplName" placeholder="e.g. Markdown link" /></div>
              <div class="checkbox-row" style="margin-top:22px;"><input type="checkbox" id="tplActive" checked /><label for="tplActive">Active</label></div>
            </div>
            <div class="field"><label>Template code <button class="tpl-info-btn" id="tplInfoBtn" title="Syntax guide">ⓘ Guide</button></label>
              <textarea class="textarea mono" id="tplCode" style="min-height:200px;" placeholder="[!%{title}%!](!%{url}%!)"></textarea>
            </div>
            <div class="field">
              <label>Live preview <select class="select tpl-preview-select" id="tplPreviewVid"></select></label>
              <pre class="tpl-preview mono" id="tplPreview"></pre>
            </div>
            <div class="tpl-editor-actions">
              <button class="btn btn--ghost" id="tplNew">New</button>
              <button class="btn btn--primary" id="tplSave">Save Template</button>
            </div>
          </div>
          <div class="tpl-mgr__list">
            <div class="tpl-list-head">Saved Templates <span class="hint" style="margin-left:auto;">drag to reorder</span></div>
            <div id="tplList" class="tpl-list"></div>
          </div>
        </div>
        ${this._managerStyles()}`,
      onMount: (modal, close) => {
        const els = {
          name: modal.querySelector("#tplName"),
          active: modal.querySelector("#tplActive"),
          code: modal.querySelector("#tplCode"),
          preview: modal.querySelector("#tplPreview"),
          previewVid: modal.querySelector("#tplPreviewVid"),
          list: modal.querySelector("#tplList"),
        };
        let editingId = null;

        // preview video dropdown — videos from active list
        const vids = Videos.orderedVideos();
        els.previewVid.innerHTML = vids.length
          ? vids.map((v) => `<option value="${v._key||v.youtubeId}">${Utils.escapeHtml((v.title||"").slice(0,50))}</option>`).join("")
          : `<option value="">(no videos in this list)</option>`;

        const getPreviewVideo = () => State.videos[els.previewVid.value] || vids[0] || null;
        const renderPreview = () => {
          try { els.preview.textContent = self.compile(els.code.value, getPreviewVideo()); els.preview.classList.remove("is-err"); }
          catch (e) { els.preview.textContent = "Error: " + e.message; els.preview.classList.add("is-err"); }
        };
        els.code.addEventListener("input", Utils.debounce(renderPreview, 200));
        els.previewVid.addEventListener("change", renderPreview);

        const renderList = () => {
          const tpls = self.ordered();
          els.list.innerHTML = tpls.length ? tpls.map((t) => `
            <div class="tpl-item" data-id="${t.id}">
              <span class="tpl-item__handle">⋮⋮</span>
              <span class="tpl-item__name">${Utils.escapeHtml(t.name)}</span>
              ${t.isActive ? '<span class="tpl-item__badge">active</span>' : ''}
              <button class="icon-btn tpl-item__edit" data-act="edit" title="Edit">✏️</button>
              <button class="icon-btn tpl-item__del" data-act="del" title="Delete">🗑️</button>
            </div>`).join("") : `<p class="hint" style="padding:12px;text-align:center;">No templates yet. Create one!</p>`;
          els.list.querySelectorAll(".tpl-item").forEach((row) => {
            const id = row.dataset.id;
            row.querySelector('[data-act="edit"]').addEventListener("click", () => loadIntoEditor(id));
            row.querySelector('[data-act="del"]').addEventListener("click", async () => {
              const ok = await UI.confirm({ title: "Delete template?", message: "This copy format will be removed.", confirmText: "Delete" });
              if (!ok) return;
              await DB.template(id).remove();
              if (editingId === id) clearEditor();
              setTimeout(renderList, 50);
            });
          });
          if (window.Sortable) {
            Sortable.create(els.list, {
              handle: ".tpl-item__handle", animation: 150,
              onEnd: async () => {
                const ids = [...els.list.querySelectorAll(".tpl-item")].map((r) => r.dataset.id);
                const updates = {}; ids.forEach((id, i) => updates[`${id}/order`] = i);
                await DB.templates().update(updates);
              },
            });
          }
        };

        const loadIntoEditor = (id) => {
          const t = State.templates[id]; if (!t) return;
          editingId = id;
          els.name.value = t.name; els.code.value = t.text; els.active.checked = !!t.isActive;
          renderPreview();
        };
        const clearEditor = () => { editingId = null; els.name.value = ""; els.code.value = ""; els.active.checked = true; renderPreview(); };

        modal.querySelector("#tplNew").addEventListener("click", clearEditor);
        modal.querySelector("#tplSave").addEventListener("click", async () => {
          const name = els.name.value.trim();
          if (!name) { UI.toast("Template needs a name", "error"); els.name.focus(); return; }
          const payload = { name, text: els.code.value, isActive: els.active.checked, timestamp: Date.now() };
          if (editingId) {
            await DB.template(editingId).update(payload);
          } else {
            const ref = DB.templates().push();
            payload.order = self.ordered().length;
            await ref.set(payload);
            editingId = ref.key;
          }
          UI.toast("Template saved", "success");
          setTimeout(renderList, 60);
        });
        modal.querySelector("#tplInfoBtn").addEventListener("click", () => self.openInfo());

        // subscribe to live changes while open
        const ref = DB.templates();
        const cb = ref.on("value", () => setTimeout(renderList, 30));
        const obs = new MutationObserver(() => { if (!document.body.contains(modal)) { ref.off("value", cb); obs.disconnect(); } });
        obs.observe(document.body, { childList: true, subtree: true });

        renderList(); renderPreview();
      },
    });
  },

  openInfo() {
    UI.openModal({
      title: "Template Syntax Guide",
      bodyHtml: `
        <div class="tpl-guide">
          <h3>Variables</h3>
          <p>Insert a value with <code>!%{variableName}%!</code></p>
          <table class="tpl-var-table">
            <tr><td><code>title</code></td><td>Video title</td></tr>
            <tr><td><code>url</code></td><td>Full watch URL</td></tr>
            <tr><td><code>channel</code></td><td>Channel name</td></tr>
            <tr><td><code>duration</code></td><td>Formatted length (e.g. 12:04)</td></tr>
            <tr><td><code>views</code></td><td>Formatted views (e.g. 1.2M)</td></tr>
            <tr><td><code>viewsRaw</code></td><td>Exact view count (number)</td></tr>
            <tr><td><code>published</code></td><td>Relative date (e.g. 3 days ago)</td></tr>
            <tr><td><code>publishedDate</code></td><td>Exact date</td></tr>
            <tr><td><code>subscribers</code></td><td>Formatted subscribers</td></tr>
            <tr><td><code>subscribersRaw</code></td><td>Exact subscriber count</td></tr>
            <tr><td><code>thumbnail</code></td><td>Thumbnail image URL</td></tr>
            <tr><td><code>note</code></td><td>Your saved note</td></tr>
          </table>

          <h3>JavaScript blocks</h3>
          <p>Run JS with <code>!%{ ...code... }%!</code>. With no <code>return</code> the expression is evaluated; otherwise it runs as a function body. Variables are resolved <em>before</em> the JS runs.</p>
          <pre class="tpl-code-eg mono">!%{ viewsRaw > 1000000 ? "🔥 viral" : "normal" }%!</pre>
          <pre class="tpl-code-eg mono">!%{
  const mins = Math.round(!%{viewsRaw}%! / 0); 
  return "approx " + mins;
}%!</pre>

          <h3>Error fallback</h3>
          <p>Put <code>*!%{ ...code... }%!</code> right after a JS block to handle errors. It receives an <code>_error</code> variable.</p>
          <pre class="tpl-code-eg mono">!%{ JSON.parse(note).rating }%!*!%{ "no rating: " + _error }%!</pre>

          <h3>Example: Markdown link</h3>
          <pre class="tpl-code-eg mono">[!%{title}%!](!%{url}%!) — !%{channel}%!, !%{views}%! views</pre>
        </div>
        ${this._guideStyles()}`,
    });
  },

  _managerStyles() {
    return `<style>
      .tpl-mgr{display:grid;grid-template-columns:1fr 340px;gap:24px;height:100%;}
      .tpl-mgr__editor{display:flex;flex-direction:column;min-width:0;}
      .tpl-row{display:flex;gap:16px;align-items:flex-start;}
      .tpl-info-btn{float:right;border:1px solid var(--border);background:var(--bg-elevated);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--text-2);}
      .tpl-info-btn:hover{background:var(--bg-hover);}
      .tpl-preview-select{display:inline-block;width:auto;max-width:55%;float:right;padding:3px 8px;font-size:11.5px;margin-top:-3px;}
      .tpl-preview{background:var(--bg-sunken);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;min-height:90px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--text);overflow:auto;max-height:220px;}
      .tpl-preview.is-err{color:var(--accent);}
      .tpl-editor-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:auto;padding-top:8px;}
      .tpl-mgr__list{border-left:1px solid var(--border-soft);padding-left:24px;display:flex;flex-direction:column;min-width:0;}
      .tpl-list-head{display:flex;align-items:center;font-weight:650;font-size:13px;margin-bottom:12px;}
      .tpl-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;}
      .tpl-item{display:flex;align-items:center;gap:9px;padding:9px 10px;background:var(--bg-elevated);border:1px solid var(--border-soft);border-radius:var(--radius-sm);}
      .tpl-item__handle{cursor:grab;color:var(--text-3);font-size:12px;}
      .tpl-item__name{flex:1;font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .tpl-item__badge{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;background:var(--accent-soft);color:var(--accent);padding:2px 6px;border-radius:10px;font-weight:600;}
      .tpl-item .icon-btn{width:26px;height:26px;font-size:12px;}
      @media(max-width:760px){.tpl-mgr{grid-template-columns:1fr;}.tpl-mgr__list{border-left:none;padding-left:0;border-top:1px solid var(--border-soft);padding-top:16px;}}
    </style>`;
  },

  _guideStyles() {
    return `<style>
      .tpl-guide h3{font-size:14px;margin:20px 0 8px;}
      .tpl-guide h3:first-child{margin-top:0;}
      .tpl-guide p{color:var(--text-2);font-size:13px;margin-bottom:8px;line-height:1.55;}
      .tpl-guide code{background:var(--bg-sunken);border:1px solid var(--border-soft);padding:1px 5px;border-radius:4px;font-family:var(--font-mono);font-size:12px;color:var(--accent);}
      .tpl-var-table{width:100%;border-collapse:collapse;margin:4px 0 8px;}
      .tpl-var-table td{padding:5px 8px;border-bottom:1px solid var(--border-soft);font-size:12.5px;vertical-align:top;}
      .tpl-var-table td:first-child{width:140px;}
      .tpl-code-eg{background:var(--bg-sunken);border:1px solid var(--border);border-radius:var(--radius-sm);padding:11px;font-size:12px;white-space:pre-wrap;margin:6px 0;color:var(--text);}
    </style>`;
  },
};
