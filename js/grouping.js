/* =========================================================
   grouping.js — Notion-style view engine (pure, testable)

   Turns a flat list of items + a per-list "view" config into a
   filtered / sorted / grouped structure the grid can render.

   Fields come in two flavours:
     • built-in   (Type, Channel, Views, Duration, Date added, …)
     • custom     (user-defined list properties, id "p:<propId>")
   resolveFields(list) merges both; every other function takes that
   resolved map so custom properties behave exactly like built-ins.

   View model (stored additively on each list as list.view):
     { group, sort:{field,dir}, filters:[{field,op,value}],
       collapsed:{[key]:true}, groupOrder:[key,…] }
   Custom property schema lives on list.props, values on item.pvals.

   "Manual" sort keeps each item's saved `order` and only the GROUPS
   get reordered.
   ========================================================= */

const Grouping = {
  FIELDS: {
    title:    { label: "Title",       kind: "text",   ico: "T",  get: (v) => (v.type === "note" ? (v.name || "") : (v.title || "")) },
    type:     { label: "Type",        kind: "select", ico: "▦",  get: (v) => v.type === "note" ? "Note" : (v.type === "channel" ? "Channel" : "Video") },
    channel:  { label: "Channel",     kind: "select", ico: "📺", get: (v) => v.type === "note" ? "" : (v.channelName || "") },
    views:    { label: "Views",       kind: "number", ico: "👁", get: (v) => Number(v.viewCountRaw || 0) },
    duration: { label: "Duration",    kind: "number", ico: "⏱", get: (v) => Number(v.durationSeconds || 0) },
    added:    { label: "Date added",  kind: "date",   ico: "📅", get: (v) => Number(v.timestamp || v.createdAt || 0) },
    subs:     { label: "Subscribers", kind: "number", ico: "🔔", get: (v) => Number(v.subscriberCountRaw || 0) },
    hasNote:  { label: "Has note",    kind: "bool",   ico: "✎",  get: (v) => !!((v.note && String(v.note).trim()) || v.type === "note") },
  },

  PROP_TYPES: [
    { type: "text",     label: "Text",         ico: "T" },
    { type: "number",   label: "Number",       ico: "#" },
    { type: "select",   label: "Select",       ico: "⊙" },
    { type: "multi",    label: "Multi-select", ico: "≣" },
    { type: "date",     label: "Date",         ico: "📅" },
    { type: "checkbox", label: "Checkbox",     ico: "☑" },
    { type: "url",      label: "URL",          ico: "🔗" },
  ],

  // built-in + custom (list.props) resolved into one field map
  resolveFields(list) {
    const out = Object.assign({}, this.FIELDS);
    const props = (list && list.props) || {};
    Object.values(props).forEach((p) => {
      if (!p || !p.id) return;
      const id = "p:" + p.id;
      out[id] = {
        label: p.name || "Property", kind: p.type || "text", ico: "◆", custom: true, prop: p,
        get: (v) => {
          const pv = (v.pvals || {})[p.id];
          if (pv == null) return p.type === "checkbox" ? false : (p.type === "multi" ? [] : "");
          return pv;
        },
      };
    });
    return out;
  },
  customIds(fields) { return Object.keys(fields).filter((k) => fields[k].custom); },

  groupableFields(fields) { fields = fields || this.FIELDS; return ["type", "channel", "added", "views", "duration", "hasNote"].filter((k) => fields[k]).concat(this.customIds(fields)); },
  sortableFields(fields) { fields = fields || this.FIELDS; return ["title", "added", "views", "duration", "channel", "subs"].filter((k) => fields[k]).concat(this.customIds(fields)); },
  filterableFields(fields) { fields = fields || this.FIELDS; return ["type", "channel", "hasNote", "title"].filter((k) => fields[k]).concat(this.customIds(fields)); },

  defaultView() { return { group: null, sort: { field: "manual", dir: "asc" }, filters: [], collapsed: {}, groupOrder: [] }; },

  normalize(view, fields) {
    fields = fields || this.FIELDS;
    const d = this.defaultView();
    if (!view || typeof view !== "object") return d;
    return {
      group: fields[view.group] ? view.group : null,
      sort: {
        field: (view.sort && (view.sort.field === "manual" || fields[view.sort.field])) ? view.sort.field : "manual",
        dir: (view.sort && view.sort.dir === "desc") ? "desc" : "asc",
      },
      filters: Array.isArray(view.filters) ? view.filters.filter((f) => f && fields[f.field]) : [],
      collapsed: (view.collapsed && typeof view.collapsed === "object") ? view.collapsed : {},
      groupOrder: Array.isArray(view.groupOrder) ? view.groupOrder : [],
    };
  },

  isDefault(view, fields) {
    const v = this.normalize(view, fields);
    return !v.group && v.sort.field === "manual" && v.filters.length === 0;
  },

  _viewsBucket(n) {
    if (n <= 0) return { key: "v0", label: "No views", rank: 0 };
    if (n < 1e3) return { key: "v1", label: "Under 1K", rank: 1 };
    if (n < 1e4) return { key: "v2", label: "1K – 10K", rank: 2 };
    if (n < 1e5) return { key: "v3", label: "10K – 100K", rank: 3 };
    if (n < 1e6) return { key: "v4", label: "100K – 1M", rank: 4 };
    if (n < 1e7) return { key: "v5", label: "1M – 10M", rank: 5 };
    return { key: "v6", label: "10M+", rank: 6 };
  },
  _durBucket(s) {
    if (s <= 0) return { key: "d0", label: "Unknown", rank: 9 };
    if (s < 60) return { key: "d1", label: "Under 1 min", rank: 0 };
    if (s < 300) return { key: "d2", label: "1 – 5 min", rank: 1 };
    if (s < 1200) return { key: "d3", label: "5 – 20 min", rank: 2 };
    if (s < 3600) return { key: "d4", label: "20 – 60 min", rank: 3 };
    return { key: "d5", label: "Over 1 hour", rank: 4 };
  },
  _dateBucket(ts, now) {
    if (!ts) return { key: "t9", label: "No date", rank: 9 };
    now = now || Date.now();
    const day = 86400000;
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const t0 = startToday.getTime();
    if (ts >= t0) return { key: "t0", label: "Today", rank: 0 };
    if (ts >= t0 - day) return { key: "t1", label: "Yesterday", rank: 1 };
    if (ts >= t0 - 7 * day) return { key: "t2", label: "Earlier this week", rank: 2 };
    if (ts >= t0 - 30 * day) return { key: "t3", label: "Earlier this month", rank: 3 };
    if (ts >= t0 - 365 * day) return { key: "t4", label: "Earlier this year", rank: 4 };
    return { key: "t5", label: "Older", rank: 5 };
  },
  _emptyGroup() { return { key: "∅", label: "(Empty)", rank: 9999 }; },

  groupOf(fieldId, item, now, fields) {
    fields = fields || this.FIELDS;
    const f = fields[fieldId];
    const raw = f ? f.get(item) : "";
    if (f && f.custom) {
      if (f.kind === "checkbox") return raw ? { key: "y", label: "Checked", rank: 0 } : { key: "n", label: "Unchecked", rank: 1 };
      if (f.kind === "multi") { const a = Array.isArray(raw) ? raw.slice().sort() : []; const s = a.join(", "); return s ? { key: s, label: s, rank: 0 } : this._emptyGroup(); }
      if (f.kind === "date" && raw) return this._dateBucket(Number(raw), now);
      const s = String(raw == null ? "" : raw).trim();
      return s ? { key: s, label: s, rank: 0 } : this._emptyGroup();
    }
    if (fieldId === "views") return this._viewsBucket(Number(raw || 0));
    if (fieldId === "duration") return this._durBucket(Number(raw || 0));
    if (fieldId === "added") return this._dateBucket(Number(raw || 0), now);
    if (fieldId === "hasNote") return raw ? { key: "y", label: "With note", rank: 0 } : { key: "n", label: "No note", rank: 1 };
    if (fieldId === "type") { const order = { Video: 0, Note: 1, Channel: 2 }; return { key: String(raw), label: String(raw), rank: order[raw] ?? 9 }; }
    const s = String(raw || "").trim();
    return s ? { key: s, label: s, rank: 0 } : this._emptyGroup();
  },

  matchFilter(item, filter, fields) {
    fields = fields || this.FIELDS;
    const f = fields[filter.field];
    if (!f) return true;
    const v = f.get(item);
    const op = filter.op || "is";
    const val = filter.value;
    if (f.kind === "multi") {
      const arr = (Array.isArray(v) ? v : []).map((x) => String(x).toLowerCase());
      const tv = String(val == null ? "" : val).toLowerCase();
      switch (op) { case "is": case "contains": return arr.includes(tv); case "isNot": case "notContains": return !arr.includes(tv); case "isEmpty": return arr.length === 0; case "isNotEmpty": return arr.length > 0; default: return true; }
    }
    const sv = String(v == null ? "" : v).toLowerCase();
    const tv = String(val == null ? "" : val).toLowerCase();
    switch (op) {
      case "is": return f.kind === "bool" || f.kind === "checkbox" ? (!!v === (val === true || val === "true")) : sv === tv;
      case "isNot": return sv !== tv;
      case "contains": return sv.includes(tv);
      case "notContains": return !sv.includes(tv);
      case "isEmpty": return sv === "";
      case "isNotEmpty": return sv !== "";
      default: return true;
    }
  },

  _cmp(a, b, fieldId, dir, fields) {
    const f = fields[fieldId];
    const x = f.get(a), y = f.get(b);
    let r;
    if (f.kind === "number" || f.kind === "date") r = Number(x || 0) - Number(y || 0);
    else if (f.kind === "checkbox" || f.kind === "bool") r = (x ? 1 : 0) - (y ? 1 : 0);
    else if (f.kind === "multi") r = String((Array.isArray(x) ? x : []).join(",")).localeCompare(String((Array.isArray(y) ? y : []).join(",")), undefined, { sensitivity: "base" });
    else r = String(x || "").localeCompare(String(y || ""), undefined, { sensitivity: "base", numeric: true });
    return dir === "desc" ? -r : r;
  },
  sortItems(items, sort, fields) {
    fields = fields || this.FIELDS;
    const arr = items.slice();
    if (!sort || sort.field === "manual" || !fields[sort.field]) arr.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    else arr.sort((a, b) => this._cmp(a, b, sort.field, sort.dir, fields) || ((a.order ?? 0) - (b.order ?? 0)));
    return arr;
  },

  groupRank(group, view) {
    const idx = (view.groupOrder || []).indexOf(group.key);
    if (idx >= 0) return idx;
    return 100000 + (group.rank ?? 0);
  },

  apply(items, view, now, list) {
    const fields = this.resolveFields(list);
    const v = this.normalize(view, fields);
    let arr = (items || []).slice();
    if (v.filters.length) arr = arr.filter((it) => v.filters.every((f) => this.matchFilter(it, f, fields)));

    if (!v.group) return { grouped: false, view: v, fields, items: this.sortItems(arr, v.sort, fields), total: arr.length };

    const map = new Map();
    for (const it of arr) {
      const g = this.groupOf(v.group, it, now, fields);
      if (!map.has(g.key)) map.set(g.key, { key: g.key, label: g.label, rank: g.rank, items: [] });
      map.get(g.key).items.push(it);
    }
    let groups = [...map.values()];
    groups.forEach((grp) => { grp.items = this.sortItems(grp.items, v.sort, fields); grp.collapsed = !!v.collapsed[grp.key]; });
    groups.sort((a, b) => (this.groupRank(a, v) - this.groupRank(b, v)) || String(a.label).localeCompare(String(b.label)));
    return { grouped: true, view: v, fields, groups, total: arr.length };
  },
};

if (typeof window !== "undefined") window.Grouping = Grouping;
if (typeof module !== "undefined" && module.exports) module.exports = Grouping;
