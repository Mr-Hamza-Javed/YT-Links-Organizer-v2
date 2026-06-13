/* =========================================================
   config.js — Firebase + YouTube credentials, global state
   ========================================================= */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAU-lbB1xDIds2tqo8tjnqDdUDq6rbDVm8",
  authDomain: "alamza-a77a9.firebaseapp.com",
  databaseURL: "https://alamza-a77a9-default-rtdb.firebaseio.com",
  projectId: "alamza-a77a9",
  storageBucket: "alamza-a77a9.firebasestorage.app",
  messagingSenderId: "815562116019",
  appId: "1:815562116019:web:09b325349a2d336b2f19c6"
};

const YT_API_KEY = "AIzaSyAi9TmRbAeBiTxzxtUGoDiyVHOhW63GYNc";
const YT_BASE = "https://www.googleapis.com/youtube/v3";

// Initialise Firebase (compat SDK)
firebase.initializeApp(FIREBASE_CONFIG);
const fbAuth = firebase.auth();
const fbDb = firebase.database();

// ---------- Global app state ----------
const State = {
  uid: null,
  user: null,
  lists: {},            // listId -> list object (non-archived + temporarily-opened archived)
  archivedOpen: new Set(), // archived listIds temporarily shown in sidebar
  activeListId: null,
  videos: {},           // videoId -> video object (for active list)
  templates: {},        // templateId -> template
  channelCache: {},     // channelId -> {url, fetchedAt}
  listOrder: [],        // ordered list ids
  searchTerm: "",
  collapsed: false,
  theme: localStorage.getItem("ylo_theme") || "system",
  cardSize: parseInt(localStorage.getItem("ylo_cardsize") || "320", 10),
  statusConfig: null,   // loaded from localStorage
};

// DB path helpers
const DB = {
  lists: () => fbDb.ref(`users/${State.uid}/lists`),
  list: (id) => fbDb.ref(`users/${State.uid}/lists/${id}`),
  videos: (listId) => fbDb.ref(`users/${State.uid}/lists/${listId}/videos`),
  video: (listId, vId) => fbDb.ref(`users/${State.uid}/lists/${listId}/videos/${vId}`),
  templates: () => fbDb.ref(`users/${State.uid}/templates`),
  template: (id) => fbDb.ref(`users/${State.uid}/templates/${id}`),
  channelThumb: (cId) => fbDb.ref(`channelThumbnails/${cId}`),
};
