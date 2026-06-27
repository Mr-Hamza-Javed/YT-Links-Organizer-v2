/* =========================================================
   utils.js — formatting & parsing helpers
   ========================================================= */

const Utils = {
  // ---------- YouTube URL → video id ----------
  parseVideoId(url) {
    if (!url) return null;
    url = url.trim();
    // bare 11-char id
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
    const patterns = [
      /(?:youtube\.com\/watch\?[^#]*[?&]?v=)([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  },

  // ---------- playlist link → playlist id ----------
  parsePlaylistId(url) {
    if (!url) return null;
    url = url.trim();
    if (/^PL[a-zA-Z0-9_-]+$/.test(url) || /^(UU|FL|LL|OL|RD)[a-zA-Z0-9_-]+$/.test(url)) return url;
    const m = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  },

  isYouTubeUrl(text) {
    if (!text) return false;
    return /(?:youtube\.com|youtu\.be)/.test(text) && !!this.parseVideoId(text);
  },

  // ---------- channel link / @handle / id → resolver hint ----------
  parseChannelInput(input) {
    if (!input) return null;
    input = input.trim();
    let m;
    if ((m = input.match(/youtube\.com\/channel\/(UC[\w-]{22})/))) return { kind: "id", value: m[1] };
    if (/^UC[\w-]{22}$/.test(input)) return { kind: "id", value: input };
    if ((m = input.match(/youtube\.com\/(@[\w.\-]+)/))) return { kind: "handle", value: m[1] };
    if (/^@[\w.\-]+$/.test(input)) return { kind: "handle", value: input };
    if ((m = input.match(/youtube\.com\/user\/([\w-]+)/))) return { kind: "user", value: m[1] };
    if ((m = input.match(/youtube\.com\/c\/([\w%\-]+)/))) return { kind: "search", value: decodeURIComponent(m[1]) };
    return { kind: "search", value: input };
  },

  // ---------- ISO 8601 duration → H:MM:SS / M:SS ----------
  formatDuration(iso) {
    if (!iso) return "0:00";
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return "0:00";
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseInt(m[3] || 0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(min)}:${pad(s)}`;
    return `${min}:${pad(s)}`;
  },

  // ---------- ISO 8601 duration → total seconds ----------
  durationToSeconds(iso) {
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  },

  // ---------- seconds → human total duration ----------
  formatTotalSeconds(total) {
    total = Math.round(total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
  },

  // ---------- big numbers → 1.5K / 2.3M / 1.1B ----------
  formatCount(n) {
    n = Number(n);
    if (isNaN(n)) return "0";
    const abs = Math.abs(n);
    const fmt = (val, suffix) => {
      const r = val < 10 ? Math.round(val * 10) / 10 : Math.round(val);
      return `${r}${suffix}`;
    };
    if (abs >= 1e9) return fmt(n / 1e9, "B");
    if (abs >= 1e6) return fmt(n / 1e6, "M");
    if (abs >= 1e3) return fmt(n / 1e3, "K");
    return String(n);
  },

  // ---------- date → "3 days ago" ----------
  timeAgo(input) {
    if (!input) return "—";
    const then = typeof input === "number" ? input : new Date(input).getTime();
    if (isNaN(then)) return "—";
    const sec = Math.floor((Date.now() - then) / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec} seconds ago`;
    const units = [
      [31536000, "year"], [2592000, "month"], [604800, "week"],
      [86400, "day"], [3600, "hour"], [60, "minute"],
    ];
    for (const [s, label] of units) {
      const v = Math.floor(sec / s);
      if (v >= 1) return `${v} ${label}${v > 1 ? "s" : ""} ago`;
    }
    return "just now";
  },

  // ---------- exact date string ----------
  formatDate(input) {
    if (!input) return "—";
    const d = new Date(input);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  },

  // ---------- emoji detection / stripping ----------
  // Returns the leading emoji of a string if it starts with one
  leadingEmoji(str) {
    if (!str) return null;
    const re = /^(\p{Extended_Pictographic}(\u200D\p{Extended_Pictographic})*[\uFE0F\u20E3]?)/u;
    const m = str.match(re);
    return m ? m[1] : null;
  },
  stripLeadingEmoji(str) {
    if (!str) return str;
    const em = this.leadingEmoji(str);
    if (em) return str.slice(em.length).trim();
    return str;
  },
  isEmoji(str) {
    if (!str) return false;
    return /^(\p{Extended_Pictographic}(\u200D\p{Extended_Pictographic})*[\uFE0F\u20E3]?)+$/u.test(str.trim());
  },

  // ---------- auto-pick emoji for list name ----------
  autoEmoji(name) {
    const em = this.leadingEmoji(name);
    if (em) return em;
    const n = (name || "").toLowerCase();
    if (/\bfav(ou?rite)?s?\b/.test(n)) return "⭐";
    if (/tutorial|learn|course|how.?to|guide/.test(n)) return "📘";
    if (/music|song|playlist|beats|album/.test(n)) return "🎵";
    if (/watch.?later|to.?watch|queue|later/.test(n)) return "⏱️";
    return "📂";
  },

  escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },

  uid(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  },

  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      return ok;
    }
  },
};
