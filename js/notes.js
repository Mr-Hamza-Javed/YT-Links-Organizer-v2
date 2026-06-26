/* =========================================================
   notes.js — compatibility shim

   The two old editors (inline popup + fullscreen block editor) have been
   replaced by a single Notion-style full-page editor in js/editor.js
   (window.NoteEditor). These thin wrappers keep every existing call site
   working — every "open a note" path now routes to the new editor.

   The save helpers are retained (unchanged behaviour) so any external/legacy
   caller keeps working and nothing in the database is ever lost.
   ========================================================= */

const Notes = {
  // ---- all "open" entry points now lead to the one editor ----
  openInline(videoId) { if (window.NoteEditor) NoteEditor.open(videoId); },
  openNoteItem(videoId) { if (window.NoteEditor) NoteEditor.open(videoId); },
  openFullscreen(videoId) { if (window.NoteEditor) NoteEditor.open(videoId); },

  // ---- shared save helpers (kept for backward compatibility) ----
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
};
