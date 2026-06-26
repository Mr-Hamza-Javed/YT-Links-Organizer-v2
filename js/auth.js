/* =========================================================
   auth.js — Google sign-in (popup → redirect fallback)
   ========================================================= */

const Auth = {
  init() {
    // file:// warning
    if (location.protocol === "file:") {
      UI.toast("Sign-in needs http/https — open this via a web server, not file://", "error", 7000);
    }

    // persistence: LOCAL
    fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((e) => console.warn(e));

    // handle redirect result on load
    fbAuth.getRedirectResult().then((result) => {
      if (result && result.user) UI.toast(`Welcome, ${result.user.displayName || "back"}!`, "success");
    }).catch((e) => {
      if (e && e.code && e.code !== "auth/no-auth-event") {
        console.warn("redirect result error", e);
      }
    });

    // wire buttons
    document.getElementById("signInBtn").addEventListener("click", () => this.signIn());
    document.getElementById("welcomeSignInBtn").addEventListener("click", () => this.signIn());
    document.getElementById("logoutBtn").addEventListener("click", () => this.signOut());
    document.getElementById("userChip").addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = document.getElementById("userPopover");
      const showing = !pop.hidden;
      UI.closeAllPopovers();
      pop.hidden = showing;
    });

    // auth state listener
    fbAuth.onAuthStateChanged((user) => this.onAuthChange(user));
  },

  _setBtnLoading(loading) {
    const btn = document.getElementById("welcomeSignInBtn");
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle("is-loading", loading);
  },

  async signIn() {
    this._setBtnLoading(true);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await fbAuth.signInWithPopup(provider);
      // success → onAuthChange hides the welcome screen; leave the button as-is
    } catch (e) {
      // fall back to redirect if popup blocked/unsupported
      const fallbackCodes = [
        "auth/popup-blocked",
        "auth/popup-closed-by-user",
        "auth/cancelled-popup-request",
        "auth/operation-not-supported-in-this-environment",
        "auth/web-storage-unsupported",
      ];
      if (fallbackCodes.includes(e.code)) {
        if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
          this._setBtnLoading(false);
          return;
        }
        UI.toast("Popup blocked — redirecting to sign in…", "info");
        try { await fbAuth.signInWithRedirect(provider); }
        catch (e2) { this._setBtnLoading(false); UI.toast("Sign-in failed: " + (e2.message || e2.code), "error"); }
      } else {
        this._setBtnLoading(false);
        UI.toast("Sign-in failed: " + (e.message || e.code), "error");
      }
    }
  },

  async signOut() {
    UI.closeAllPopovers();
    try { await fbAuth.signOut(); UI.toast("Signed out", "info"); }
    catch (e) { UI.toast("Sign-out failed", "error"); }
  },

  onAuthChange(user) {
    const signInBtn = document.getElementById("signInBtn");
    const userChip = document.getElementById("userChip");
    const createBtn = document.getElementById("createListBtn");
    const welcome = document.getElementById("welcomeScreen");

    if (user) {
      State.uid = user.uid;
      State.user = user;
      // reveal the app, dismiss the welcome / sign-in screen
      welcome.hidden = true;
      this._setBtnLoading(false);
      signInBtn.hidden = true;
      userChip.hidden = false;
      createBtn.style.display = "";
      // user chip
      const initial = (user.displayName || user.email || "U").trim().charAt(0).toUpperCase();
      document.getElementById("userInitial").textContent = initial;
      if (user.photoURL) {
        document.getElementById("userChip").innerHTML = `<img src="${user.photoURL}" alt="" referrerpolicy="no-referrer" />`;
      }
      document.getElementById("userName").textContent = user.displayName || user.email || "User";
      document.getElementById("userUid").textContent = user.uid;
      // boot the app data
      App.onSignedIn();
    } else {
      State.uid = null;
      State.user = null;
      // show the welcome / sign-in screen with its full content
      this._setBtnLoading(false);
      welcome.hidden = false;
      welcome.classList.add("is-ready");
      signInBtn.hidden = false;
      userChip.hidden = true;
      createBtn.style.display = "none";
      App.onSignedOut();
    }
  },
};
