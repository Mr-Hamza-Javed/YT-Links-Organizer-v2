/* =========================================================
   editor.js — Notion-style full-page note editor (TipTap)

   - Loads TipTap lazily from window.TT (set by the ESM loader in index.html).
   - Rich content is stored ADDITIVELY so the old app keeps working and no
     data is ever lost:
       • note      : markdown serialization (old app + status bar read this)
       • docJson   : JSON.stringify(TipTap doc) — source of truth for this editor
       • noteHash  : hash of the markdown we wrote (detects edits made elsewhere)
   - On load: if note matches noteHash we trust docJson; otherwise we re-parse
     the markdown (so a note edited by the old app still opens correctly here).
   ========================================================= */
(function () {
  "use strict";

  const esc = (s) => Utils.escapeHtml(s);

  // FNV-1a 32-bit — tiny, stable, good enough to detect external edits.
  function hashStr(s) {
    s = s == null ? "" : String(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(36);
  }

  /* =======================================================
     MARKDOWN SERIALIZER  (TipTap JSON -> markdown)
     Colours become inline <span> (portable + re-parseable),
     video cards become a marker + a clean titled link.
     ======================================================= */
  function applyMarks(text, marks) {
    let s = text;
    const get = (n) => marks && marks.find((m) => m.type === n);
    const has = (n) => !!get(n);
    const wrap = (str) => {
      const ts = get("textStyle");
      const hl = get("highlight");
      const lk = get("link");
      if (ts && ts.attrs && ts.attrs.color) str = `<span style="color:${ts.attrs.color}">${str}</span>`;
      if (hl && hl.attrs && hl.attrs.color) str = `<span style="background-color:${hl.attrs.color}">${str}</span>`;
      else if (hl) str = `<mark>${str}</mark>`;
      if (lk && lk.attrs && lk.attrs.href) str = `[${str}](${lk.attrs.href})`;
      return str;
    };
    if (has("code")) return wrap("`" + s + "`");
    if (has("bold")) s = "**" + s + "**";
    if (has("italic")) s = "*" + s + "*";
    if (has("strike")) s = "~~" + s + "~~";
    if (has("underline")) s = "<u>" + s + "</u>";
    return wrap(s);
  }

  function serializeInline(content) {
    if (!content) return "";
    let out = "";
    for (const n of content) {
      if (n.type === "text") out += applyMarks(n.text || "", n.marks);
      else if (n.type === "hardBreak") out += "\n";
      else if (n.type === "videoCard") out += videoCardMd(n.attrs || {});
    }
    return out;
  }

  function videoCardMd(a) {
    const id = a.youtubeId || "";
    const title = a.title || "YouTube video";
    const ch = a.channelName || "";
    const url = `https://www.youtube.com/watch?v=${id}`;
    const label = ch ? `▶ ${title} — ${ch}` : `▶ ${title}`;
    return `<!--ytcard ${id}-->[${label}](${url})`;
  }

  function serializeList(node, ordered, indent) {
    const lines = [];
    let idx = 1;
    for (const li of node.content || []) {
      const marker = ordered ? (idx + ". ") : "- ";
      idx++;
      const childIndent = indent + " ".repeat(marker.length);
      let first = true;
      for (const child of li.content || []) {
        if (child.type === "bulletList" || child.type === "orderedList") {
          lines.push(serializeList(child, child.type === "orderedList", childIndent));
        } else if (child.type === "paragraph") {
          const t = serializeInline(child.content);
          if (first) { lines.push(indent + marker + t); first = false; }
          else lines.push(childIndent + t);
        } else {
          const s = serializeNode(child, childIndent);
          if (first) { lines.push(indent + marker + s); first = false; }
          else lines.push(s.split("\n").map((l) => childIndent + l).join("\n"));
        }
      }
      if (first) lines.push(indent + marker);
    }
    return lines.join("\n");
  }

  function serializeTaskList(node, indent) {
    const lines = [];
    for (const li of node.content || []) {
      const box = (li.attrs && li.attrs.checked) ? "[x]" : "[ ]";
      const childIndent = indent + "      ";
      let first = true;
      for (const child of li.content || []) {
        if (child.type === "bulletList" || child.type === "orderedList") lines.push(serializeList(child, child.type === "orderedList", childIndent));
        else if (child.type === "taskList") lines.push(serializeTaskList(child, childIndent));
        else if (child.type === "paragraph") {
          const t = serializeInline(child.content);
          if (first) { lines.push(indent + "- " + box + " " + t); first = false; }
          else lines.push(childIndent + t);
        } else {
          const s = serializeNode(child, childIndent);
          if (first) { lines.push(indent + "- " + box + " " + s); first = false; }
          else lines.push(s);
        }
      }
      if (first) lines.push(indent + "- " + box + " ");
    }
    return lines.join("\n");
  }

  function serializeTable(node) {
    const rows = node.content || [];
    const out = [];
    const cellText = (cell) => (cell.content || [])
      .map((b) => (b.type === "paragraph" ? serializeInline(b.content) : serializeNode(b, "")))
      .join(" ").replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || " ";
    rows.forEach((row, ri) => {
      const cells = (row.content || []).map(cellText);
      out.push("| " + cells.join(" | ") + " |");
      if (ri === 0) out.push("| " + cells.map(() => "---").join(" | ") + " |");
    });
    return out.join("\n");
  }

  function serializeNode(node, indent) {
    indent = indent || "";
    if (!node) return "";
    switch (node.type) {
      case "text": return applyMarks(node.text || "", node.marks);
      case "hardBreak": return "\n";
      case "paragraph": return serializeInline(node.content);
      case "heading": return "#".repeat((node.attrs && node.attrs.level) || 1) + " " + serializeInline(node.content);
      case "codeBlock": {
        const lang = (node.attrs && node.attrs.language) || "";
        const code = (node.content || []).map((c) => c.text || "").join("");
        return "```" + lang + "\n" + code + "\n```";
      }
      case "horizontalRule": return "---";
      case "blockquote": {
        const inner = serializeBlocks(node.content || []).join("\n\n");
        return inner.split("\n").map((l) => "> " + l).join("\n");
      }
      case "bulletList": return serializeList(node, false, indent);
      case "orderedList": return serializeList(node, true, indent);
      case "taskList": return serializeTaskList(node, indent);
      case "table": return serializeTable(node);
      case "videoCard": return videoCardMd(node.attrs || {});
      case "listItem": return serializeBlocks(node.content || []).join("\n");
      default: return node.content ? serializeBlocks(node.content).join("\n\n") : "";
    }
  }

  function serializeBlocks(content) { return (content || []).map((n) => serializeNode(n, "")); }

  function docToMarkdown(json) {
    if (!json || !json.content) return "";
    return serializeBlocks(json.content).join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function fragmentToMarkdown(arr) { return docToMarkdown({ type: "doc", content: arr || [] }); }

  /* =======================================================
     MARKDOWN PARSER  (markdown -> TipTap JSON)
     Mainly used for notes created/edited by the OLD app.
     ======================================================= */
  function addMark(nodes, mark) {
    return nodes.map((n) => {
      if (n.type !== "text") return n;
      const marks = (n.marks || []).slice();
      if (!marks.some((x) => x.type === mark.type)) marks.push(mark);
      return Object.assign({}, n, { marks });
    });
  }

  function parseInline(text) {
    const out = [];
    let buf = "", i = 0;
    const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
    while (i < text.length) {
      const rest = text.slice(i);
      let m;
      if ((m = rest.match(/^`([^`]+)`/))) { flush(); out.push({ type: "text", text: m[1], marks: [{ type: "code" }] }); i += m[0].length; continue; }
      if ((m = rest.match(/^\*\*\*([\s\S]+?)\*\*\*/)) || (m = rest.match(/^___([\s\S]+?)___/))) { flush(); out.push(...addMark(addMark(parseInline(m[1]), { type: "bold" }), { type: "italic" })); i += m[0].length; continue; }
      if ((m = rest.match(/^\*\*([\s\S]+?)\*\*/)) || (m = rest.match(/^__([\s\S]+?)__/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "bold" })); i += m[0].length; continue; }
      if ((m = rest.match(/^~~([\s\S]+?)~~/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "strike" })); i += m[0].length; continue; }
      if ((m = rest.match(/^\*([\s\S]+?)\*/)) || (m = rest.match(/^_([\s\S]+?)_/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "italic" })); i += m[0].length; continue; }
      if ((m = rest.match(/^<span style="color:([^"]+)">([\s\S]*?)<\/span>/))) { flush(); out.push(...addMark(parseInline(m[2]), { type: "textStyle", attrs: { color: m[1] } })); i += m[0].length; continue; }
      if ((m = rest.match(/^<span style="background-color:([^"]+)">([\s\S]*?)<\/span>/))) { flush(); out.push(...addMark(parseInline(m[2]), { type: "highlight", attrs: { color: m[1] } })); i += m[0].length; continue; }
      if ((m = rest.match(/^<mark>([\s\S]*?)<\/mark>/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "highlight" })); i += m[0].length; continue; }
      if ((m = rest.match(/^<u>([\s\S]*?)<\/u>/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "underline" })); i += m[0].length; continue; }
      if ((m = rest.match(/^\[([^\]]*)\]\(([^)]+)\)/))) { flush(); out.push(...addMark(parseInline(m[1]), { type: "link", attrs: { href: m[2] } })); i += m[0].length; continue; }
      buf += text[i]; i++;
    }
    flush();
    return out;
  }

  function isSpecialStart(l) {
    return /^<!--ytcard\s/.test(l) || /^```/.test(l) || /^#{1,6}\s/.test(l)
      || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^>\s?/.test(l)
      || /^[-*+]\s+\[[ xX]\]\s+/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l);
  }

  function parseTable(lines, start) {
    const parseRow = (l) => l.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
    const rows = [parseRow(lines[start])];
    let i = start + 2;
    while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(parseRow(lines[i])); i++; }
    const toCell = (txt, isHeader) => ({ type: isHeader ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: parseInline(txt) }] });
    const content = rows.map((r, ri) => ({ type: "tableRow", content: r.map((c) => toCell(c, ri === 0)) }));
    return { node: { type: "table", content }, next: i };
  }

  function parseList(lines, start) {
    const base = lines[start].match(/^(\s*)([-*+]|\d+\.)\s+/);
    const baseIndent = base[1].length;
    const ordered = /\d+\./.test(base[2]);
    const node = { type: ordered ? "orderedList" : "bulletList", content: [] };
    let i = start;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") break;
      const mm = l.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (!mm || /^[-*+]\s+\[[ xX]\]/.test(l.trim())) break;
      const indent = mm[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        const sub = parseList(lines, i);
        const last = node.content[node.content.length - 1];
        if (last) last.content.push(sub.node);
        i = sub.next; continue;
      }
      node.content.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(mm[3]) }] });
      i++;
    }
    return { node, next: i };
  }

  function parseMarkdown(md) {
    const text = (md == null ? "" : String(md)).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const content = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") { i++; continue; }
      let m;
      if ((m = line.match(/^<!--ytcard\s+([a-zA-Z0-9_-]{6,})-->/))) {
        const lm = line.match(/\[(.*?)\]\((https?:\/\/[^)]+)\)/);
        let title = "", ch = "";
        if (lm) { const parts = lm[1].replace(/^▶\s*/, "").split(" — "); title = parts[0] || ""; ch = parts[1] || ""; }
        content.push({ type: "videoCard", attrs: { youtubeId: m[1], title, channelName: ch, thumbnail: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` } });
        i++; continue;
      }
      if ((m = line.match(/^```(.*)$/))) {
        const lang = (m[1] || "").trim();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        content.push({ type: "codeBlock", attrs: { language: lang || null }, content: buf.length ? [{ type: "text", text: buf.join("\n") }] : [] });
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { content.push({ type: "heading", attrs: { level: m[1].length }, content: parseInline(m[2]) }); i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { content.push({ type: "horizontalRule" }); i++; continue; }
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        const t = parseTable(lines, i); content.push(t.node); i = t.next; continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
        const inner = parseMarkdown(buf.join("\n"));
        content.push({ type: "blockquote", content: inner.content.length ? inner.content : [{ type: "paragraph" }] });
        continue;
      }
      if (/^[-*+]\s+\[[ xX]\]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
          const mm = lines[i].match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
          items.push({ type: "taskItem", attrs: { checked: /[xX]/.test(mm[1]) }, content: [{ type: "paragraph", content: parseInline(mm[2]) }] });
          i++;
        }
        content.push({ type: "taskList", content: items });
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) { const r = parseList(lines, i); content.push(r.node); i = r.next; continue; }
      // paragraph
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() !== "" && !isSpecialStart(lines[i])) { buf.push(lines[i]); i++; }
      const inline = [];
      buf.forEach((l, idx) => { if (idx > 0) inline.push({ type: "hardBreak" }); inline.push(...parseInline(l)); });
      content.push({ type: "paragraph", content: inline });
    }
    if (!content.length) content.push({ type: "paragraph" });
    return { type: "doc", content };
  }

  /* =======================================================
     VIDEO-CARD embed node + read-only card markup
     ======================================================= */
  function vcardInnerHtml(a) {
    const stats = [a.views ? `${a.views} views` : null, a.publishedAt ? Utils.timeAgo(a.publishedAt) : null].filter(Boolean).join(" • ");
    const avatar = a.channelThumbnailUrl
      ? `<img class="ed-vcard__avatar" src="${esc(a.channelThumbnailUrl)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="ed-vcard__avatar is-ph">${esc((a.channelName || "?").charAt(0).toUpperCase())}</div>`;
    const thumb = a.thumbnail || (a.youtubeId ? `https://i.ytimg.com/vi/${a.youtubeId}/hqdefault.jpg` : "");
    return `
      <a class="ed-vcard__thumb" href="https://www.youtube.com/watch?v=${esc(a.youtubeId || "")}" target="_blank" rel="noopener" contenteditable="false">
        <img src="${esc(thumb)}" alt="" referrerpolicy="no-referrer" />
        ${a.duration ? `<span class="ed-vcard__dur">${esc(a.duration)}</span>` : ""}
        <span class="ed-vcard__play">▶</span>
      </a>
      <div class="ed-vcard__body">
        ${avatar}
        <div class="ed-vcard__meta">
          <div class="ed-vcard__title">${esc(a.title || "YouTube video")}</div>
          <div class="ed-vcard__channel">${esc(a.channelName || "")}</div>
          <div class="ed-vcard__stats">${esc(stats)}</div>
        </div>
      </div>`;
  }

  function buildVideoCardNode() {
    const { Node, mergeAttributes } = window.TT;
    return Node.create({
      name: "videoCard",
      group: "block",
      atom: true,
      draggable: true,
      selectable: true,
      addAttributes() {
        return {
          youtubeId: { default: null }, title: { default: "" }, thumbnail: { default: "" },
          channelName: { default: "" }, channelThumbnailUrl: { default: "" }, views: { default: "" },
          duration: { default: "" }, publishedAt: { default: "" },
        };
      },
      parseHTML() { return [{ tag: "div[data-video-card]" }]; },
      renderHTML({ HTMLAttributes }) {
        return ["div", mergeAttributes(HTMLAttributes, { "data-video-card": "", class: "ed-vcard" })];
      },
      addNodeView() {
        return ({ node, editor, getPos }) => {
          const dom = document.createElement("div");
          dom.className = "ed-vcard";
          dom.setAttribute("data-video-card", "");
          dom.contentEditable = "false";
          const draw = (a) => { dom.innerHTML = vcardInnerHtml(a); };
          draw(node.attrs);
          // Hydrate a card that only has an id (e.g. re-parsed from old markdown).
          if (node.attrs.youtubeId && (!node.attrs.title || !node.attrs.thumbnail)) {
            YT.fetchVideoData(node.attrs.youtubeId).then((d) => {
              if (!d) return;
              const merged = Object.assign({}, node.attrs, {
                title: d.title || "", thumbnail: d.thumbnail || "", channelName: d.channelName || "",
                channelThumbnailUrl: d.channelThumbnailUrl || "", views: d.views || "",
                duration: d.duration || "", publishedAt: d.publishedAt || "",
              });
              draw(merged);
              try {
                if (typeof getPos === "function") {
                  editor.view.dispatch(editor.state.tr.setNodeMarkup(getPos(), undefined, merged));
                }
              } catch (_) { /* visual update already applied */ }
            }).catch(() => {});
          }
          return { dom };
        };
      },
    });
  }

  /* =======================================================
     Colour palettes (Notion-ish, readable on dark + light)
     ======================================================= */
  const TEXT_COLORS = [
    { n: "Default", c: null }, { n: "Gray", c: "#9b9a97" }, { n: "Brown", c: "#b07b54" },
    { n: "Orange", c: "#d9730d" }, { n: "Yellow", c: "#cb912f" }, { n: "Green", c: "#4f9768" },
    { n: "Blue", c: "#4a90d9" }, { n: "Purple", c: "#9065b0" }, { n: "Pink", c: "#d15b9c" }, { n: "Red", c: "#e03e3e" },
  ];
  const BG_COLORS = [
    { n: "None", c: null }, { n: "Gray", c: "#ebeced" }, { n: "Brown", c: "#e9e5e3" },
    { n: "Orange", c: "#faebdd" }, { n: "Yellow", c: "#fbf3db" }, { n: "Green", c: "#ddedea" },
    { n: "Blue", c: "#ddebf1" }, { n: "Purple", c: "#eae4f2" }, { n: "Pink", c: "#f4dfeb" }, { n: "Red", c: "#fbe4e4" },
  ];

  /* =======================================================
     SLASH COMMANDS
     ======================================================= */
  const SLASH_COMMANDS = [
    { key: "text", ico: "¶", title: "Text", hint: "Plain paragraph", run: (e) => e.chain().focus().setParagraph().run() },
    { key: "h1", ico: "H₁", title: "Heading 1", hint: "Big section heading", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
    { key: "h2", ico: "H₂", title: "Heading 2", hint: "Medium heading", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: "h3", ico: "H₃", title: "Heading 3", hint: "Small heading", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: "bullet", ico: "•", title: "Bulleted list", hint: "Simple bullets", run: (e) => e.chain().focus().toggleBulletList().run() },
    { key: "ordered", ico: "1.", title: "Numbered list", hint: "Ordered list", run: (e) => e.chain().focus().toggleOrderedList().run() },
    { key: "todo", ico: "☑", title: "To-do list", hint: "Checkboxes", run: (e) => e.chain().focus().toggleTaskList().run() },
    { key: "quote", ico: "❝", title: "Quote", hint: "Capture a quote", run: (e) => e.chain().focus().toggleBlockquote().run() },
    { key: "code", ico: "‹›", title: "Code block", hint: "Monospaced code", run: (e) => e.chain().focus().toggleCodeBlock().run() },
    { key: "divider", ico: "—", title: "Divider", hint: "Horizontal line", run: (e) => e.chain().focus().setHorizontalRule().run() },
    { key: "table", ico: "▦", title: "Table", hint: "3×3 with header", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { key: "video", ico: "▶", title: "Video embed", hint: "Embed a YouTube card", run: () => NoteEditor._promptVideo() },
  ];

  /* =======================================================
     NoteEditor — the public API
     ======================================================= */
  const NoteEditor = {
    _editor: null, _itemId: null, _listId: null, _item: null,
    _saveTimer: null, _titleVal: "", _dirty: false,
    _slashEl: null, _slashItems: [], _slashIndex: 0, _slashFrom: null, _slashKeyHandler: null,
    _bubbleEl: null, _onScroll: null, _onKeyDown: null,

    open(itemId) {
      if (!State.uid) { UI.toast("Please sign in first", "info"); return; }
      const listId = State.activeListId;
      const item = State.videos[itemId];
      if (!listId || !item) return;
      this._ensureTT(() => this._openNow(itemId, listId, item));
    },

    _ensureTT(cb) {
      if (window.TT) return cb();
      if (window.__ttError) { UI.toast("Editor failed to load — check your connection.", "error"); return; }
      UI.showLoading("Loading editor…");
      const ready = () => { cleanup(); UI.hideLoading(); cb(); };
      const fail = () => { cleanup(); UI.hideLoading(); UI.toast("Editor failed to load — check your connection.", "error"); };
      const cleanup = () => { window.removeEventListener("tiptap-ready", ready); window.removeEventListener("tiptap-error", fail); };
      window.addEventListener("tiptap-ready", ready);
      window.addEventListener("tiptap-error", fail);
    },

    _openNow(itemId, listId, item) {
      const self = this;
      this._itemId = itemId; this._listId = listId; this._item = item;
      this._dirty = false;
      const isNote = item.type === "note";
      this._titleVal = isNote ? (item.name || "") : (item.title || "");

      const list = State.lists[listId] || {};
      const crumb = `${esc(list.emoji || Utils.autoEmoji(list.name || ""))} ${esc(Utils.stripLeadingEmoji(list.name || "") || list.name || "List")}`;

      const page = document.getElementById("editorPage");
      page.innerHTML = `
        <div class="ed-topbar">
          <button class="ed-icbtn ed-back" title="Back to list">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="ed-crumb">${crumb}</div>
          <div class="ed-spacer"></div>
          <span class="ed-status" id="edStatus"></span>
          <button class="ed-btn" id="edCopyMd" title="Copy entire note as Markdown">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 9h10v10H9zM5 15V5h10"/></svg>
            <span>Copy MD</span>
          </button>
          <button class="ed-btn ed-btn--primary" id="edDone">Done</button>
        </div>
        <div class="ed-scroll">
          <div class="ed-doc">
            ${isNote ? "" : `<div class="ed-vcard ed-vcard--context">${vcardInnerHtml(item)}</div>`}
            ${isNote
              ? `<textarea class="ed-title" id="edTitle" rows="1" placeholder="Untitled" spellcheck="false">${esc(this._titleVal)}</textarea>`
              : `<h1 class="ed-title is-static">${esc(item.title || "Untitled")}</h1>`}
            <div class="ed-body" id="edBody"></div>
          </div>
        </div>`;
      page.hidden = false;
      document.body.classList.add("editor-open");

      page.querySelector(".ed-back").addEventListener("click", () => self.close());
      page.querySelector("#edDone").addEventListener("click", () => self.close());
      page.querySelector("#edCopyMd").addEventListener("click", () => self._copyAll());

      if (isNote) {
        const titleEl = page.querySelector("#edTitle");
        const grow = () => { titleEl.style.height = "auto"; titleEl.style.height = titleEl.scrollHeight + "px"; };
        grow();
        titleEl.addEventListener("input", () => { self._titleVal = titleEl.value; self._dirty = true; grow(); self._scheduleSave(); });
        titleEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); self._editor && self._editor.commands.focus("start"); }
        });
      }

      // Esc closes the editor (unless a dialog or a menu is open).
      this._onKeyDown = (e) => {
        if (e.key !== "Escape") return;
        if (self._slashEl) return;            // slash menu handles its own Esc
        if (document.querySelector("#modalHost .modal-overlay, #confirmHost .modal-overlay")) return;
        self.close();
      };
      document.addEventListener("keydown", this._onKeyDown);

      this._buildEditor(page.querySelector("#edBody"), this._loadDoc(item));

      // focus: empty new note -> title; otherwise the body
      if (isNote && !this._titleVal) page.querySelector("#edTitle").focus();
      else if (this._editor) this._editor.commands.focus("end");
    },

    _loadDoc(item) {
      let doc = null;
      if (item.docJson) {
        try {
          const saved = JSON.parse(item.docJson);
          if (!item.noteHash || item.noteHash === hashStr(item.note || "")) doc = saved;
        } catch (_) { /* fall through to markdown */ }
      }
      if (!doc) doc = parseMarkdown(item.note || "");
      return doc;
    },

    _buildEditor(el, doc) {
      const self = this;
      const T = window.TT;
      const VideoCard = buildVideoCardNode();
      this._editor = new T.Editor({
        element: el,
        extensions: [
          T.StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
          T.Placeholder.configure({
            includeChildren: true,
            placeholder: ({ node }) => node.type.name === "heading" ? "Heading" : "Type '/' for commands…",
          }),
          T.Underline,
          T.Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener", target: "_blank" } }),
          T.TextStyle, T.Color,
          T.Highlight.configure({ multicolor: true }),
          T.TaskList, T.TaskItem.configure({ nested: true }),
          T.Table.configure({ resizable: true, allowTableNodeSelection: true }),
          T.TableRow, T.TableHeader, T.TableCell,
          T.TextAlign.configure({ types: ["heading", "paragraph"] }),
          VideoCard,
        ],
        content: doc,
        autofocus: false,
        editorProps: {
          attributes: { class: "ed-prose" },
          clipboardTextSerializer: (slice) => {
            try { return fragmentToMarkdown(slice.content.toJSON()); }
            catch (_) { return slice.content.textBetween(0, slice.content.size, "\n"); }
          },
          handlePaste: (view, event) => {
            const text = (event.clipboardData || window.clipboardData).getData("text");
            if (text && Utils.isYouTubeUrl(text)) {
              const id = Utils.parseVideoId(text);
              if (id) { event.preventDefault(); self.insertVideoCard(id); return true; }
            }
            return false;
          },
        },
        onUpdate: () => { self._dirty = true; self._scheduleSave(); self._handleSlash(); },
        onSelectionUpdate: () => { self._handleSlash(); self._updateBubble(); },
        onBlur: () => { setTimeout(() => self._maybeHideBubble(), 120); },
      });

      this._onScroll = () => { self._hideSlash(); self._updateBubble(); };
      const scroller = document.querySelector("#editorPage .ed-scroll");
      if (scroller) scroller.addEventListener("scroll", this._onScroll, true);
    },

    /* ---------------- saving ---------------- */
    _scheduleSave() {
      this._setStatus("Editing…");
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._persist(true), 650);
    },
    _setStatus(t) { const el = document.getElementById("edStatus"); if (el) el.textContent = t; },

    async _persist() {
      if (!this._editor || !this._itemId) return;
      clearTimeout(this._saveTimer);
      // never rewrite the record (and never bump noteTimestamp) unless the user
      // actually changed something — keeps existing data untouched on a mere view.
      if (!this._dirty) { this._setStatus(""); return; }
      this._dirty = false;
      const json = this._editor.getJSON();
      const md = docToMarkdown(json);
      const update = { note: md, docJson: JSON.stringify(json), noteHash: hashStr(md), noteTimestamp: Date.now() };
      const item = this._item;
      if (item && item.type === "note") {
        const nm = (this._titleVal || item.name || "").trim() || "Untitled note";
        update.name = nm; item.name = nm;
      }
      if (item) { item.note = md; item.docJson = update.docJson; item.noteHash = update.noteHash; item.noteTimestamp = update.noteTimestamp; }
      this._setStatus("Saving…");
      try {
        await DB.video(this._listId, this._itemId).update(update);
        this._setStatus("Saved");
      } catch (e) { this._dirty = true; this._setStatus("Save failed"); UI.toast("Save failed: " + e.message, "error"); }
      try { Videos.updateCardNoteState && Videos.updateCardNoteState(this._itemId); } catch (_) {}
      try { window.StatusBar && StatusBar.render(); } catch (_) {}
    },

    async close() {
      try { await this._persist(); } catch (_) {}
      this._hideSlash(); this._hideBubble();
      const scroller = document.querySelector("#editorPage .ed-scroll");
      if (scroller && this._onScroll) scroller.removeEventListener("scroll", this._onScroll, true);
      if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
      if (this._editor) { try { this._editor.destroy(); } catch (_) {} this._editor = null; }
      const page = document.getElementById("editorPage");
      page.hidden = true; page.innerHTML = "";   // detaches slash/bubble menus too
      document.body.classList.remove("editor-open");
      this._itemId = this._listId = this._item = null;
      this._onKeyDown = this._onScroll = null;
      this._bubbleEl = null;   // was a child of #editorPage; rebuild on next open
    },

    async _copyAll() {
      if (!this._editor) return;
      const md = docToMarkdown(this._editor.getJSON());
      const ok = await Utils.copyToClipboard(md);
      UI.toast(ok ? "Copied as Markdown" : "Couldn't copy", ok ? "success" : "error", 1500);
    },

    /* ---------------- video embed ---------------- */
    async _promptVideo() {
      const url = await UI.prompt({ title: "Embed video", label: "YouTube URL", placeholder: "https://www.youtube.com/watch?v=…", confirmText: "Embed" });
      if (url == null) { this._editor && this._editor.commands.focus(); return; }
      const id = Utils.parseVideoId(url);
      if (!id) { UI.toast("Couldn't find a video ID in that link", "error"); return; }
      this.insertVideoCard(id);
    },

    async insertVideoCard(id) {
      if (!this._editor) return;
      UI.showLoading("Fetching video…");
      try {
        let data = null;
        const ex = Object.values(State.videos).find((v) => v.youtubeId === id && v.type !== "note");
        if (ex) data = ex;
        else data = await YT.fetchVideoData(id);
        if (!data) { UI.toast("Video not found, private, or deleted", "error"); return; }
        const attrs = {
          youtubeId: id, title: data.title || "", thumbnail: data.thumbnail || "",
          channelName: data.channelName || "", channelThumbnailUrl: data.channelThumbnailUrl || "",
          views: data.views || "", duration: data.duration || "", publishedAt: data.publishedAt || "",
        };
        // single atomic insert (a trailing paragraph keeps the caret usable)
        this._editor.chain().focus().insertContent([{ type: "videoCard", attrs }, { type: "paragraph" }]).run();
      } catch (e) { UI.toast("Couldn't embed video: " + e.message, "error"); }
      finally { UI.hideLoading(); }
    },

    /* ---------------- slash menu ---------------- */
    _handleSlash() {
      const ed = this._editor;
      if (!ed) return;
      const { state } = ed;
      const sel = state.selection;
      if (!sel.empty) return this._hideSlash();
      const start = sel.$from.start();
      const before = state.doc.textBetween(start, sel.from, "\n", "\n");
      const m = before.match(/(?:^|\s)\/([a-zA-Z]*)$/);
      if (!m) return this._hideSlash();
      this._slashFrom = sel.from - (m[1].length + 1);
      const q = (m[1] || "").toLowerCase();
      const items = SLASH_COMMANDS.filter((c) => !q || c.title.toLowerCase().includes(q) || c.key.includes(q));
      if (!items.length) return this._hideSlash();
      this._slashItems = items;
      this._slashIndex = 0;
      this._showSlash();
    },

    _showSlash() {
      const ed = this._editor;
      let el = this._slashEl;
      if (!el) {
        el = document.createElement("div");
        el.className = "ed-slash";
        document.getElementById("editorPage").appendChild(el);
        this._slashEl = el;
        this._slashKeyHandler = (e) => this._slashKeys(e);
        ed.view.dom.addEventListener("keydown", this._slashKeyHandler, true);
      }
      el.innerHTML = this._slashItems.map((c, i) => `
        <button class="ed-slash__item ${i === this._slashIndex ? "is-sel" : ""}" data-i="${i}">
          <span class="ed-slash__ico">${esc(c.ico)}</span>
          <span class="ed-slash__txt"><b>${esc(c.title)}</b><small>${esc(c.hint)}</small></span>
        </button>`).join("");
      el.querySelectorAll(".ed-slash__item").forEach((b) => {
        b.addEventListener("mousedown", (e) => { e.preventDefault(); this._chooseSlash(parseInt(b.dataset.i, 10)); });
        b.addEventListener("mousemove", () => { this._slashIndex = parseInt(b.dataset.i, 10); this._highlightSlash(); });
      });
      try {
        const c = ed.view.coordsAtPos(ed.state.selection.from);
        const pageRect = document.getElementById("editorPage").getBoundingClientRect();
        let left = c.left - pageRect.left;
        let top = c.bottom - pageRect.top + 6;
        left = Math.min(left, pageRect.width - el.offsetWidth - 12);
        if (top + el.offsetHeight > pageRect.height - 8) top = c.top - pageRect.top - el.offsetHeight - 6;
        el.style.left = Math.max(12, left) + "px";
        el.style.top = Math.max(8, top) + "px";
      } catch (_) {}
    },

    _highlightSlash() {
      if (!this._slashEl) return;
      this._slashEl.querySelectorAll(".ed-slash__item").forEach((b, i) => b.classList.toggle("is-sel", i === this._slashIndex));
    },

    _slashKeys(e) {
      if (!this._slashEl) return;
      if (e.key === "ArrowDown") { e.preventDefault(); this._slashIndex = (this._slashIndex + 1) % this._slashItems.length; this._highlightSlash(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this._slashIndex = (this._slashIndex - 1 + this._slashItems.length) % this._slashItems.length; this._highlightSlash(); }
      else if (e.key === "Enter") { e.preventDefault(); this._chooseSlash(this._slashIndex); }
      else if (e.key === "Tab") { e.preventDefault(); this._chooseSlash(this._slashIndex); }
      else if (e.key === "Escape") { e.preventDefault(); this._hideSlash(); }
    },

    _chooseSlash(i) {
      const cmd = this._slashItems[i];
      const ed = this._editor;
      if (!cmd || !ed) return;
      const from = this._slashFrom;
      const to = ed.state.selection.from;
      ed.chain().focus().deleteRange({ from, to }).run();
      this._hideSlash();
      cmd.run(ed);
    },

    _hideSlash() {
      if (!this._slashEl) return;
      if (this._slashKeyHandler && this._editor) this._editor.view.dom.removeEventListener("keydown", this._slashKeyHandler, true);
      this._slashEl.remove();
      this._slashEl = null; this._slashKeyHandler = null; this._slashItems = [];
    },

    /* ---------------- bubble (selection) menu ---------------- */
    _updateBubble() {
      const ed = this._editor;
      if (!ed) return;
      const sel = ed.state.selection;
      if (sel.empty || !ed.isFocused) return this._hideBubble();
      // don't show inside code blocks
      if (ed.isActive("codeBlock")) return this._hideBubble();
      let el = this._bubbleEl;
      if (!el) { el = this._buildBubble(); }
      this._refreshBubbleState();
      // position above selection
      try {
        const dsel = window.getSelection();
        if (!dsel || !dsel.rangeCount) return;
        const rect = dsel.getRangeAt(0).getBoundingClientRect();
        const pageRect = document.getElementById("editorPage").getBoundingClientRect();
        let left = rect.left - pageRect.left + rect.width / 2 - el.offsetWidth / 2;
        let top = rect.top - pageRect.top - el.offsetHeight - 8;
        left = Math.max(12, Math.min(left, pageRect.width - el.offsetWidth - 12));
        if (top < 8) top = rect.bottom - pageRect.top + 8;
        el.style.left = left + "px";
        el.style.top = top + "px";
        el.hidden = false;
      } catch (_) {}
    },
    _maybeHideBubble() {
      // keep open if the pointer is interacting with the bubble
      if (this._bubbleEl && this._bubbleEl.matches(":hover")) return;
      const ed = this._editor;
      if (ed && !ed.state.selection.empty && ed.isFocused) return;
      this._hideBubble();
    },
    _hideBubble() { if (this._bubbleEl) this._bubbleEl.hidden = true; },

    _buildBubble() {
      const ed = this._editor;
      const el = document.createElement("div");
      el.className = "ed-bubble";
      el.hidden = true;
      const swatches = (arr, kind) => arr.map((x) =>
        `<button class="ed-sw ${kind}" data-kind="${kind}" data-c="${x.c || ""}" title="${esc(x.n)}" style="${kind === "bg" ? `background:${x.c || "transparent"}` : `color:${x.c || "var(--text)"}`}">${x.c ? (kind === "bg" ? "" : "A") : "⦸"}</button>`
      ).join("");
      el.innerHTML = `
        <div class="ed-bubble__row">
          <button class="ed-bb" data-mark="bold" title="Bold"><b>B</b></button>
          <button class="ed-bb" data-mark="italic" title="Italic"><i>I</i></button>
          <button class="ed-bb" data-mark="underline" title="Underline"><u>U</u></button>
          <button class="ed-bb" data-mark="strike" title="Strikethrough"><s>S</s></button>
          <button class="ed-bb" data-mark="code" title="Inline code">‹›</button>
          <button class="ed-bb" data-act="link" title="Link">🔗</button>
          <span class="ed-bb__sep"></span>
          <span class="ed-bb__label">A</span>${swatches(TEXT_COLORS, "fg")}
          <span class="ed-bb__sep"></span>
          <span class="ed-bb__label">▮</span>${swatches(BG_COLORS, "bg")}
        </div>`;
      document.getElementById("editorPage").appendChild(el);
      this._bubbleEl = el;

      el.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
      el.querySelectorAll(".ed-bb[data-mark]").forEach((b) => b.addEventListener("click", () => {
        ed.chain().focus().toggleMark(b.dataset.mark).run(); this._refreshBubbleState();
      }));
      const linkBtn = el.querySelector('[data-act="link"]');
      if (linkBtn) linkBtn.addEventListener("click", async () => {
        const prev = ed.getAttributes("link").href || "";
        const href = await UI.prompt({ title: "Link", label: "URL", value: prev, placeholder: "https://…", confirmText: "Apply" });
        if (href == null) { ed.commands.focus(); return; }
        if (href === "") ed.chain().focus().unsetLink().run();
        else ed.chain().focus().setLink({ href }).run();
        this._refreshBubbleState();
      });
      el.querySelectorAll(".ed-sw").forEach((b) => b.addEventListener("click", () => {
        const c = b.dataset.c || null;
        if (b.dataset.kind === "fg") { c ? ed.chain().focus().setColor(c).run() : ed.chain().focus().unsetColor().run(); }
        else { c ? ed.chain().focus().setHighlight({ color: c }).run() : ed.chain().focus().unsetHighlight().run(); }
        this._refreshBubbleState();
      }));
      return el;
    },

    _refreshBubbleState() {
      const ed = this._editor, el = this._bubbleEl;
      if (!ed || !el) return;
      el.querySelectorAll(".ed-bb[data-mark]").forEach((b) => b.classList.toggle("is-on", ed.isActive(b.dataset.mark)));
      const lk = el.querySelector('[data-act="link"]');
      if (lk) lk.classList.toggle("is-on", ed.isActive("link"));
    },
  };

  // Expose the pure markdown engine (handy for export/import + testing).
  NoteEditor.md = { toMarkdown: docToMarkdown, parse: parseMarkdown, fragmentToMarkdown };

  window.NoteEditor = NoteEditor;
})();
