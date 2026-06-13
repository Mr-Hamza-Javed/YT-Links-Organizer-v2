/* =========================================================
   notes.js — inline note modal + fullscreen block editor
   ========================================================= */

const Notes = {
  // ---------- INLINE NOTE MODAL ----------
  openInline(videoId) {
    const v = State.videos[videoId];
    if (!v) return;
    if (v.type === "note") return this.openNoteItem(videoId);
    const hasNote = !!(v.note && v.note.trim());
    UI.openModal({
      title: "Note",
      widthPx: 600,
      bodyHtml: `
        <div class="note-preview">
          <img src="${Utils.escapeHtml(v.thumbnail)}" alt="" class="note-preview__thumb" referrerpolicy="no-referrer" />
          <div class="note-preview__title">${Utils.escapeHtml(v.title)}</div>
        </div>
        <div class="field note-field">
          <label>Your note <span class="hint" style="margin-left:6px;">Markdown supported · Ctrl+Enter to save</span></label>
          <textarea class="textarea note-textarea" id="noteText" placeholder="Write a note about this video…&#10;&#10;# Heading&#10;- a point&#10;**bold**, *italic*, &#96;code&#96;">${Utils.escapeHtml(v.note || "")}</textarea>
        </div>
        <style>
          .modal__body.note-body-flex{display:flex;flex-direction:column;}
          .note-preview{display:flex;gap:14px;align-items:center;flex-shrink:0;}
          .note-preview__thumb{width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:var(--radius-sm);background:var(--bg-sunken);flex-shrink:0;}
          .note-preview__title{font-weight:600;font-size:14.5px;line-height:1.4;}
          .note-field{margin-top:16px;margin-bottom:0;display:flex;flex-direction:column;flex:1;min-height:0;}
          .note-textarea{flex:1;min-height:180px;font-size:14px;line-height:1.65;resize:none;}
        </style>`,
      footHtml: `
        <button class="btn btn--ghost" id="noteExpand" title="Open fullscreen editor">⛶ Expand</button>
        <div style="flex:1;"></div>
        ${hasNote ? '<button class="btn btn--danger" id="noteDelete">Delete</button>' : ''}
        <button class="btn btn--primary" id="noteSave">Save Note</button>`,
      onMount: (modal, close) => {
        const ta = modal.querySelector("#noteText");
        const body = modal.querySelector(".modal__body");
        if (body) body.classList.add("note-body-flex");
        ta.focus();
        const save = async () => { await this.save(videoId, ta.value); close(); };
        modal.querySelector("#noteSave").addEventListener("click", save);
        ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } });
        modal.querySelector("#noteExpand").addEventListener("click", async () => {
          await this.save(videoId, ta.value, true); close();
          this.openFullscreen(videoId);
        });
        const del = modal.querySelector("#noteDelete");
        if (del) del.addEventListener("click", async () => {
          const ok = await UI.confirm({ title: "Delete note?", message: "This note will be removed.", confirmText: "Delete" });
          if (!ok) return;
          await this.save(videoId, "", true); close();
        });
      },
    });
  },

  // ---------- NOTE-ONLY ITEM EDITOR (inline) ----------
  openNoteItem(videoId) {
    const v = State.videos[videoId];
    if (!v) return;
    UI.openModal({
      title: "Note",
      widthPx: 640,
      bodyHtml: `
        <div class="field niName">
          <label>Title</label>
          <input class="input" id="niName" value="${Utils.escapeHtml(v.name || "")}" placeholder="Note title" />
        </div>
        <div class="field niField">
          <label>Note <span class="hint" style="margin-left:6px;">Markdown supported · Ctrl+Enter to save</span></label>
          <textarea class="textarea niText" id="niText" placeholder="Write your note…">${Utils.escapeHtml(v.note || "")}</textarea>
        </div>
        <div class="niMeta mono">Created ${Utils.escapeHtml(Utils.formatDate(v.createdAt || v.timestamp))}</div>
        <style>
          .modal__body.note-body-flex{display:flex;flex-direction:column;}
          .niName{flex-shrink:0;}
          .niField{display:flex;flex-direction:column;flex:1;min-height:0;margin-bottom:8px;}
          .niText{flex:1;min-height:200px;resize:none;font-size:14px;line-height:1.7;}
          .niMeta{flex-shrink:0;font-size:11px;color:var(--text-3);}
        </style>`,
      footHtml: `
        <button class="btn btn--ghost" id="niExpand" title="Open fullscreen editor">⛶ Expand</button>
        <div style="flex:1;"></div>
        <button class="btn btn--danger" id="niDelete">Delete</button>
        <button class="btn btn--primary" id="niSave">Save</button>`,
      onMount: (modal, close) => {
        const body = modal.querySelector(".modal__body");
        if (body) body.classList.add("note-body-flex");
        const nameEl = modal.querySelector("#niName");
        const textEl = modal.querySelector("#niText");
        textEl.focus();
        const persist = async (silent = false) => {
          const name = nameEl.value.trim() || "Untitled note";
          await this.saveNoteItem(videoId, name, textEl.value, silent);
        };
        const save = async () => { await persist(false); close(); };
        modal.querySelector("#niSave").addEventListener("click", save);
        textEl.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } });
        modal.querySelector("#niExpand").addEventListener("click", async () => { await persist(true); close(); this.openFullscreen(videoId); });
        modal.querySelector("#niDelete").addEventListener("click", async () => {
          const ok = await UI.confirm({ title: "Delete note?", message: `“${Utils.escapeHtml((v.name||"this note").slice(0,80))}” will be removed.`, confirmText: "Delete" });
          if (!ok) return;
          await DB.video(State.activeListId, videoId).remove();
          close();
          UI.toast("Note deleted", "success", 1500);
        });
      },
    });
  },

  async saveNoteItem(videoId, name, text, silent = false) {
    const listId = State.activeListId;
    if (!listId) return;
    const v = State.videos[videoId];
    if (v) { v.name = name; v.note = text; v.noteTimestamp = Date.now(); }
    await DB.video(listId, videoId).update({ name, note: text || "", noteTimestamp: Date.now() });
    if (window.StatusBar) StatusBar.render();
    if (!silent) UI.toast("Note saved", "success", 1500);
  },

  async save(videoId, text, silent = false) {
    const listId = State.activeListId;
    if (!listId) return;
    const v = State.videos[videoId];
    if (v) { v.note = text; v.noteTimestamp = Date.now(); }
    await DB.video(listId, videoId).update({ note: text || "", noteTimestamp: Date.now() });
    if (Videos.updateCardNoteState) Videos.updateCardNoteState(videoId);
    if (window.StatusBar) StatusBar.render();
    if (!silent) UI.toast(text && text.trim() ? "Note saved" : "Note deleted", "success", 1500);
  },

  // ============ FULLSCREEN BLOCK EDITOR ============
  openFullscreen(startVideoId) {
    const self = this;
    let currentVid = startVideoId;
    let blocks = [];
    let activeIndex = 0;
    let caretAfter = null;     // {index, offset} to restore caret after re-render
    let sourceMode = false;

    const splitToBlocks = (txt) => (txt == null ? "" : txt).split("\n");
    const loadVideo = (vid) => {
      currentVid = vid;
      const v = State.videos[vid];
      blocks = splitToBlocks(v?.note || "");
      if (blocks.length === 0) blocks = [""];
      activeIndex = 0; caretAfter = null; sourceMode = false;
    };
    loadVideo(currentVid);

    UI.openModal({
      title: "Note Editor",
      full: true,
      bodyHtml: `
        <div class="nfe">
          <aside class="nfe__sidebar">
            <div class="nfe__sidebar-head">Videos in this list</div>
            <div class="nfe__vidlist" id="nfeVidList"></div>
          </aside>
          <div class="nfe__main">
            <div class="nfe__toolbar">
              <div class="nfe__vidtitle" id="nfeVidTitle"></div>
              <div class="nfe__tools">
                <span class="hint nfe__hint">Ctrl+A: source mode</span>
                <button class="btn btn--primary btn--sm" id="nfeSave">Save</button>
              </div>
            </div>
            <div class="nfe__editor" id="nfeEditor" tabindex="0"></div>
          </div>
        </div>
        ${this._styles()}`,
      onMount: (modal, close) => {
        const editor = modal.querySelector("#nfeEditor");
        const vidListEl = modal.querySelector("#nfeVidList");
        const vidTitleEl = modal.querySelector("#nfeVidTitle");

        const persist = async (silent = true) => {
          await self.save(currentVid, blocks.join("\n"), silent);
        };

        const renderVidList = () => {
          const vids = Videos.orderedVideos();
          vidListEl.innerHTML = vids.map((v) => `
            <button class="nfe__vid ${(v._key||v.youtubeId) === currentVid ? "is-active" : ""}" data-id="${v._key||v.youtubeId}">
              ${v.type === "note"
                ? '<span class="nfe__vid-noteico">✎</span>'
                : `<img src="${Utils.escapeHtml(v.thumbnail)}" alt="" referrerpolicy="no-referrer" />`}
              <span class="nfe__vid-title">${Utils.escapeHtml(((v.title||v.name)||"").slice(0,60))}</span>
              ${(v.note && v.note.trim()) ? '<span class="nfe__vid-dot"></span>' : ''}
            </button>`).join("");
          vidListEl.querySelectorAll(".nfe__vid").forEach((b) => {
            b.addEventListener("click", async () => {
              await persist();
              loadVideo(b.dataset.id);
              renderVidList(); renderTitle(); renderBlocks();
            });
          });
        };
        const renderTitle = () => { const cv = State.videos[currentVid]; vidTitleEl.textContent = (cv && (cv.title || cv.name)) || ""; };

        // ---------- block rendering ----------
        const renderBlocks = () => {
          if (sourceMode) { renderSource(); return; }
          editor.innerHTML = "";
          editor.classList.remove("is-source");
          blocks.forEach((line, i) => {
            const row = document.createElement("div");
            row.className = "nfe-block";
            row.dataset.index = i;
            if (i === activeIndex) {
              const ed = document.createElement("div");
              ed.className = "nfe-block__edit " + self.lineClass(line);
              ed.contentEditable = "true";
              ed.spellcheck = false;
              ed.textContent = line;
              if (!line) ed.dataset.empty = "1";
              row.appendChild(ed);
            } else {
              const disp = document.createElement("div");
              disp.className = "nfe-block__render";
              disp.innerHTML = self.renderLine(line);
              row.appendChild(disp);
            }
            editor.appendChild(row);
          });
          // focus active edit + restore caret
          const activeEd = editor.querySelector(`.nfe-block[data-index="${activeIndex}"] .nfe-block__edit`);
          if (activeEd) {
            activeEd.focus();
            const off = caretAfter != null ? caretAfter : line_len(blocks[activeIndex]);
            setCaret(activeEd, off);
            caretAfter = null;
          }
          wireBlockEvents();
        };

        function line_len(s) { return (s || "").length; }

        const wireBlockEvents = () => {
          // click a rendered block → activate
          editor.querySelectorAll(".nfe-block").forEach((row) => {
            const i = parseInt(row.dataset.index, 10);
            const disp = row.querySelector(".nfe-block__render");
            if (disp) {
              row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                activeIndex = i; caretAfter = line_len(blocks[i]);
                renderBlocks();
              });
            }
          });
          const ed = editor.querySelector(".nfe-block__edit");
          if (!ed) return;
          ed.addEventListener("input", () => {
            blocks[activeIndex] = ed.textContent;
            // live restyle of the editing line (Obsidian-style)
            const cls = self.lineClass(ed.textContent);
            ed.className = "nfe-block__edit " + cls;
            if (!ed.textContent) ed.dataset.empty = "1"; else delete ed.dataset.empty;
          });
          ed.addEventListener("keydown", onEditKeydown);
        };

        const onEditKeydown = (e) => {
          const ed = e.target;
          const off = getCaret(ed);
          const text = ed.textContent;

          // source mode toggle
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault(); blocks[activeIndex] = text; enterSource(); return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); persist(false); return; }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); persist(false); return; }

          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            blocks[activeIndex] = text;
            const before = text.slice(0, off), after = text.slice(off);
            blocks[activeIndex] = before;
            blocks.splice(activeIndex + 1, 0, after);
            activeIndex += 1; caretAfter = 0;
            renderBlocks();
            return;
          }
          if (e.key === "Backspace" && off === 0 && getSelLen(ed) === 0 && activeIndex > 0) {
            e.preventDefault();
            blocks[activeIndex] = text;
            const prevLen = blocks[activeIndex - 1].length;
            blocks[activeIndex - 1] += blocks[activeIndex];
            blocks.splice(activeIndex, 1);
            activeIndex -= 1; caretAfter = prevLen;
            renderBlocks();
            return;
          }
          if (e.key === "ArrowUp" && activeIndex > 0) {
            e.preventDefault(); blocks[activeIndex] = text;
            activeIndex -= 1; caretAfter = Math.min(off, blocks[activeIndex].length);
            renderBlocks(); return;
          }
          if (e.key === "ArrowDown" && activeIndex < blocks.length - 1) {
            e.preventDefault(); blocks[activeIndex] = text;
            activeIndex += 1; caretAfter = Math.min(off, blocks[activeIndex].length);
            renderBlocks(); return;
          }
        };

        // ---------- source mode ----------
        const enterSource = () => {
          sourceMode = true;
          editor.classList.add("is-source");
          editor.innerHTML = `<textarea class="nfe-source mono" id="nfeSource" spellcheck="false"></textarea>`;
          const ta = editor.querySelector("#nfeSource");
          ta.value = blocks.join("\n");
          ta.focus();
          const exitToLine = () => {
            const pos = ta.selectionStart;
            const val = ta.value;
            const lineIdx = val.slice(0, pos).split("\n").length - 1;
            blocks = val.split("\n"); if (blocks.length === 0) blocks = [""];
            activeIndex = Math.min(lineIdx, blocks.length - 1);
            caretAfter = null;
            sourceMode = false;
            renderBlocks();
          };
          ta.addEventListener("input", () => { blocks = ta.value.split("\n"); });
          ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); exitToLine(); }
            else if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) { e.preventDefault(); exitToLine(); }
          });
          ta.addEventListener("click", () => exitToLine());
        };

        const renderSource = () => {
          editor.classList.add("is-source");
          if (!editor.querySelector("#nfeSource")) enterSource();
        };

        // ---------- caret helpers ----------
        function getCaret(el) {
          const sel = window.getSelection();
          if (!sel.rangeCount) return 0;
          const range = sel.getRangeAt(0).cloneRange();
          range.selectNodeContents(el);
          range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
          return range.toString().length;
        }
        function getSelLen(el) {
          const sel = window.getSelection();
          if (!sel.rangeCount) return 0;
          return sel.getRangeAt(0).toString().length;
        }
        function setCaret(el, offset) {
          const sel = window.getSelection();
          const range = document.createRange();
          let node = el.firstChild;
          if (!node) { node = document.createTextNode(""); el.appendChild(node); }
          const len = node.textContent.length;
          range.setStart(node, Math.min(offset, len));
          range.collapse(true);
          sel.removeAllRanges(); sel.addRange(range);
        }

        // save button + auto-save on close
        modal.querySelector("#nfeSave").addEventListener("click", () => persist(false));
        // hook close to auto-save
        const overlay = modal.closest(".modal-overlay");
        const origClose = overlay.__close;
        overlay.__close = (r) => { persist(true); origClose(r); };

        renderVidList(); renderTitle(); renderBlocks();
      },
      onClose: () => {},
    });
  },

  // ---------- markdown line renderer ----------
  lineClass(text) {
    if (!text || !text.trim()) return "is-empty";
    if (/^###\s/.test(text)) return "is-h3";
    if (/^##\s/.test(text)) return "is-h2";
    if (/^#\s/.test(text)) return "is-h1";
    if (/^>\s/.test(text)) return "is-quote";
    if (/^[-*]\s/.test(text)) return "is-li";
    return "";
  },
  renderLine(text) {
    if (!text || text.trim() === "") return '<div class="md-empty">&nbsp;</div>';
    let m;
    if ((m = text.match(/^###\s+(.*)$/))) return `<h3 class="md-h3">${this.inline(m[1])}</h3>`;
    if ((m = text.match(/^##\s+(.*)$/)))  return `<h2 class="md-h2">${this.inline(m[1])}</h2>`;
    if ((m = text.match(/^#\s+(.*)$/)))   return `<h1 class="md-h1">${this.inline(m[1])}</h1>`;
    if ((m = text.match(/^>\s+(.*)$/)))   return `<blockquote class="md-quote">${this.inline(m[1])}</blockquote>`;
    if ((m = text.match(/^[-*]\s+(.*)$/)))return `<div class="md-li"><span class="md-bullet">•</span>${this.inline(m[1])}</div>`;
    return `<div class="md-p">${this.inline(text)}</div>`;
  },
  inline(s) {
    s = Utils.escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
    return s;
  },

  _styles() {
    return `<style>
      .nfe{display:grid;grid-template-columns:288px 1fr;height:100%;}
      .nfe__sidebar{border-right:1px solid var(--border-soft);display:flex;flex-direction:column;min-height:0;padding-right:14px;}
      .nfe__sidebar-head{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);padding:2px 6px 12px;font-weight:600;}
      .nfe__vidlist{overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-right:6px;}
      .nfe__vid{display:flex;align-items:center;gap:11px;padding:8px;border:none;background:transparent;border-radius:9px;text-align:left;position:relative;transition:background .12s;}
      .nfe__vid:hover{background:var(--bg-hover);}
      .nfe__vid.is-active{background:var(--bg-active);}
      .nfe__vid img{width:62px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;flex-shrink:0;background:var(--bg-sunken);}
      .nfe__vid-noteico{width:62px;aspect-ratio:16/9;border-radius:6px;flex-shrink:0;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:18px;}
      .nfe__vid-title{font-size:12.5px;color:var(--text);line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
      .nfe__vid-dot{position:absolute;top:9px;right:9px;width:7px;height:7px;border-radius:50%;background:var(--accent);}
      .nfe__main{display:flex;flex-direction:column;min-width:0;min-height:0;padding-left:0;}
      .nfe__toolbar{display:flex;align-items:center;gap:14px;padding:0 0 16px;margin:0 auto 8px;max-width:760px;width:100%;border-bottom:1px solid var(--border-soft);}
      .nfe__vidtitle{font-weight:680;font-size:16px;letter-spacing:-.01em;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .nfe__tools{display:flex;align-items:center;gap:12px;}
      .nfe__hint{font-size:11px;opacity:.8;}
      .btn--sm{padding:6px 14px;font-size:12.5px;}

      /* ---- editor: clean reading column ---- */
      .nfe__editor{flex:1;overflow-y:auto;outline:none;min-height:0;padding:10px 0 40vh;font-size:16.5px;line-height:1.78;}
      .nfe-block{max-width:760px;margin:0 auto;}
      .nfe-block__render,.nfe-block__edit{
        padding:3px 10px;border-radius:7px;font-size:16.5px;line-height:1.78;color:var(--text);
        white-space:pre-wrap;word-break:break-word;letter-spacing:-.003em;
      }
      .nfe-block__render{cursor:text;min-height:1.78em;}
      .nfe-block__edit{outline:none;background:transparent;caret-color:var(--accent);min-height:1.78em;
        box-shadow:inset 0 0 0 1px transparent;transition:background .1s;font-family:var(--font-ui);}
      .nfe-block__edit:focus{background:color-mix(in srgb, var(--accent) 8%, transparent);}
      .nfe-block__edit[data-empty]::before{content:"Start writing\\2026  (#\\00a0heading, -\\00a0list, >\\00a0quote)";color:var(--text-3);pointer-events:none;}
      /* keep editing line the same scale as its rendered form */
      .nfe-block__edit.is-h1{font-size:1.92em;font-weight:760;line-height:1.32;letter-spacing:-.02em;}
      .nfe-block__edit.is-h2{font-size:1.5em;font-weight:700;line-height:1.32;letter-spacing:-.015em;}
      .nfe-block__edit.is-h3{font-size:1.22em;font-weight:660;line-height:1.34;}
      .nfe-block__edit.is-quote{border-left:3px solid var(--accent);border-radius:0 7px 7px 0;color:var(--text-2);font-style:italic;}
      .nfe-block__edit.is-li{padding-left:14px;}

      /* ---- rendered markdown ---- */
      .md-empty{height:1.4em;}
      .md-h1{font-size:1.92em;font-weight:760;line-height:1.32;letter-spacing:-.02em;margin:.55em 0 .15em;}
      .md-h2{font-size:1.5em;font-weight:700;line-height:1.32;letter-spacing:-.015em;margin:.5em 0 .12em;padding-bottom:.18em;border-bottom:1px solid var(--border-soft);}
      .md-h3{font-size:1.22em;font-weight:660;line-height:1.34;margin:.4em 0 .1em;}
      .md-p{margin:.06em 0;}
      .md-quote{border-left:3px solid var(--accent);padding-left:14px;color:var(--text-2);font-style:italic;margin:.15em 0;}
      .md-li{display:flex;gap:10px;margin:.04em 0;align-items:baseline;}
      .md-bullet{color:var(--accent);font-weight:700;flex-shrink:0;}
      .md-code{background:var(--bg-sunken);border:1px solid var(--border-soft);padding:1px 6px;border-radius:5px;font-family:var(--font-mono);font-size:.82em;color:var(--accent);}
      .nfe-block__render strong{font-weight:700;}
      .nfe-block__render em{font-style:italic;}

      .nfe__editor.is-source{padding:0;}
      .nfe-source{display:block;width:100%;max-width:760px;margin:0 auto;height:100%;min-height:62vh;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-sunken);color:var(--text);padding:18px;font-size:14px;line-height:1.7;resize:none;outline:none;}
      @media(max-width:760px){.nfe{grid-template-columns:1fr;}.nfe__sidebar{display:none;}.nfe__main{padding-left:0;}.nfe-block,.nfe__toolbar,.nfe-source{max-width:none;}}
    </style>`;
  },
};
