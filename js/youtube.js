/* =========================================================
   youtube.js — YouTube Data API v3 integration
   ========================================================= */

const YT = {
  async _get(endpoint, params) {
    const qs = new URLSearchParams({ ...params, key: YT_API_KEY }).toString();
    const res = await fetch(`${YT_BASE}/${endpoint}?${qs}`);
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.error?.message || ""; } catch (_) {}
      throw new Error(`YouTube API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json();
  },

  // best thumbnail url available
  bestThumb(thumbs) {
    if (!thumbs) return "";
    return (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url || "";
  },

  // ---------- fetch full video data (video + channel) ----------
  async fetchVideoData(youtubeId) {
    const vres = await this._get("videos", {
      part: "snippet,contentDetails,statistics",
      id: youtubeId,
    });
    const item = vres.items && vres.items[0];
    if (!item) return null; // video deleted / private

    const sn = item.snippet || {};
    const stats = item.statistics || {};
    const channelId = sn.channelId;

    // channel: subscribers + avatar
    let subRaw = 0, subFmt = "0", chThumb = "";
    if (channelId) {
      const cinfo = await this.fetchChannelInfo(channelId);
      subRaw = cinfo.subscriberCountRaw;
      subFmt = cinfo.subscribers;
      chThumb = cinfo.channelThumbnailUrl;
    }

    return {
      youtubeId,
      title: sn.title || "Untitled",
      thumbnail: this.bestThumb(sn.thumbnails),
      views: Utils.formatCount(stats.viewCount || 0),
      viewCountRaw: Number(stats.viewCount || 0),
      channelName: sn.channelTitle || "Unknown channel",
      channelId: channelId || "",
      channelThumbnailUrl: chThumb,
      duration: Utils.formatDuration(item.contentDetails?.duration),
      durationSeconds: Utils.durationToSeconds(item.contentDetails?.duration),
      publishedAt: sn.publishedAt || "",
      subscribers: subFmt,
      subscriberCountRaw: subRaw,
      rawApiData: item,
      lastUpdated: Date.now(),
    };
  },

  // ---------- channel info (with shared avatar cache) ----------
  async fetchChannelInfo(channelId) {
    const out = { subscribers: "0", subscriberCountRaw: 0, channelThumbnailUrl: "" };

    // try cached avatar first
    if (State.channelCache[channelId]) {
      out.channelThumbnailUrl = State.channelCache[channelId].url || "";
    }

    try {
      const res = await this._get("channels", { part: "snippet,statistics", id: channelId });
      const ch = res.items && res.items[0];
      if (ch) {
        const subs = ch.statistics?.subscriberCount;
        out.subscriberCountRaw = Number(subs || 0);
        out.subscribers = ch.statistics?.hiddenSubscriberCount ? "—" : Utils.formatCount(subs || 0);
        const url = this.bestThumb(ch.snippet?.thumbnails);
        out.channelThumbnailUrl = url;
        // cache avatar in shared node
        if (url && (!State.channelCache[channelId] || State.channelCache[channelId].url !== url)) {
          State.channelCache[channelId] = { url, fetchedAt: Date.now() };
          DB.channelThumb(channelId).set({ url, fetchedAt: Date.now() }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("channel fetch failed", e);
    }
    return out;
  },

  // ---------- load shared channel-thumbnail cache once ----------
  async loadChannelCache() {
    try {
      const root = await fbDb.ref("channelThumbnails").once("value");
      State.channelCache = root.val() || {};
    } catch (e) { /* ignore */ }
  },

  // ---------- fetch ALL playlist items (paginated, 50/page) ----------
  async fetchPlaylistVideoIds(playlistId) {
    const ids = [];
    let pageToken = "";
    do {
      const res = await this._get("playlistItems", {
        part: "contentDetails",
        playlistId,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      });
      (res.items || []).forEach((it) => {
        const vid = it.contentDetails?.videoId;
        if (vid) ids.push(vid);
      });
      pageToken = res.nextPageToken || "";
    } while (pageToken);
    return ids;
  },

  // ---------- batch fetch video data for many ids (chunks of 50) ----------
  async fetchManyVideos(youtubeIds) {
    const out = [];
    for (let i = 0; i < youtubeIds.length; i += 50) {
      const chunk = youtubeIds.slice(i, i + 50);
      const res = await this._get("videos", {
        part: "snippet,contentDetails,statistics",
        id: chunk.join(","),
      });
      // collect channel ids to batch
      const channelIds = [...new Set((res.items || []).map((it) => it.snippet?.channelId).filter(Boolean))];
      const channelMap = await this.fetchManyChannels(channelIds);
      (res.items || []).forEach((item) => {
        const sn = item.snippet || {};
        const stats = item.statistics || {};
        const ci = channelMap[sn.channelId] || {};
        out.push({
          youtubeId: item.id,
          title: sn.title || "Untitled",
          thumbnail: this.bestThumb(sn.thumbnails),
          views: Utils.formatCount(stats.viewCount || 0),
          viewCountRaw: Number(stats.viewCount || 0),
          channelName: sn.channelTitle || "Unknown channel",
          channelId: sn.channelId || "",
          channelThumbnailUrl: ci.channelThumbnailUrl || "",
          duration: Utils.formatDuration(item.contentDetails?.duration),
          durationSeconds: Utils.durationToSeconds(item.contentDetails?.duration),
          publishedAt: sn.publishedAt || "",
          subscribers: ci.subscribers || "0",
          subscriberCountRaw: ci.subscriberCountRaw || 0,
          rawApiData: item,
          lastUpdated: Date.now(),
        });
      });
    }
    return out;
  },

  async fetchManyChannels(channelIds) {
    const map = {};
    for (let i = 0; i < channelIds.length; i += 50) {
      const chunk = channelIds.slice(i, i + 50);
      if (!chunk.length) break;
      try {
        const res = await this._get("channels", { part: "snippet,statistics", id: chunk.join(",") });
        (res.items || []).forEach((ch) => {
          const url = this.bestThumb(ch.snippet?.thumbnails);
          const subs = ch.statistics?.subscriberCount;
          map[ch.id] = {
            channelThumbnailUrl: url,
            subscribers: ch.statistics?.hiddenSubscriberCount ? "—" : Utils.formatCount(subs || 0),
            subscriberCountRaw: Number(subs || 0),
          };
          if (url) {
            State.channelCache[ch.id] = { url, fetchedAt: Date.now() };
            DB.channelThumb(ch.id).set({ url, fetchedAt: Date.now() }).catch(() => {});
          }
        });
      } catch (e) { console.warn("batch channel fetch failed", e); }
    }
    return map;
  },
};
