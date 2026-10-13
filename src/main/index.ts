import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, shell } from "electron";

import { registerMemoryIpc } from "./ipc/memory";
import { decideNavigation, originOf } from "./services/navigation";
import { stopWatchAll } from "./services/watcher";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

/**
 * 未保存の編集があるときに window を閉じようとした場合の確認文言。 main process は
 * renderer の言語切替を知らないので OS のロケールで出し分ける。
 */
function unsavedEditsDialogText(): {
  message: string;
  detail: string;
  leave: string;
  stay: string;
} {
  if (app.getLocale().toLowerCase().startsWith("ja")) {
    return {
      message: "保存していない編集があります",
      detail: "このまま閉じると、 memory への変更は失われます。",
      leave: "破棄して閉じる",
      stay: "編集に戻る",
    };
  }
  return {
    message: "You have unsaved edits",
    detail: "If you close now, your changes to this memory are lost.",
    leave: "Discard and close",
    stay: "Keep editing",
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: "memlens",
    // renderer の --housing (styles.css) と揃える。 起動時のフラッシュ防止。
    backgroundColor: "#12161c",
    webPreferences: {
      // renderer は preload の型付き API 経由でしか fs に触れないので、 Chromium の
      // sandbox を有効にする (preload は CommonJS でビルドしている)。
      preload: join(moduleDir, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on("ready-to-show", () => {
    win.show();
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  // dev では Vite dev server の origin だけを in-window 遷移として許可する
  // (HMR の full-reload が will-navigate を踏むため)。 判定は decideNavigation
  // に集約 (startsWith の prefix 比較は userinfo 付き URL ですり抜けるので
  // origin 比較を使う)。
  const devOrigin = isDev ? originOf(rendererUrl) : null;

  // 新規 window は開かせない。 http/https/mailto だけ default browser へ逃がす
  // (file: や独自スキームを shell に渡すと任意アプリ起動の踏み台になるため)。
  win.webContents.setWindowOpenHandler((details) => {
    if (decideNavigation(details.url, devOrigin) === "external") {
      void shell.openExternal(details.url);
    }
    return { action: "deny" };
  });

  // renderer はローカル bundle だけを表示する。 markdown 中の通常リンクは
  // same-window の anchor になり will-navigate に来る (setWindowOpenHandler は
  // 通らない) ので、 ここでも external URL を default browser へ逃がす。 それ
  // 以外の in-window 遷移 (ドラッグ&ドロップ等) はすべて block する。
  win.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url, devOrigin);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") {
      void shell.openExternal(url);
    }
  });

  // renderer は未保存の編集があると beforeunload で close を止める。 Electron は
  // そのとき何も表示せずに close を取り消すだけなので、 ここで確認ダイアログを出し、
  // 「破棄して閉じる」なら preventDefault で beforeunload を無視して閉じる。
  win.webContents.on("will-prevent-unload", (event) => {
    const text = unsavedEditsDialogText();
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: [text.leave, text.stay],
      defaultId: 1,
      cancelId: 1,
      message: text.message,
      detail: text.detail,
    });
    if (choice === 0) event.preventDefault();
  });

  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(moduleDir, "../renderer/index.html"));
  }
  return win;
}

async function bootstrap(): Promise<void> {
  // 二重起動すると同じ memory ディレクトリを 2 つの window が別々に編集することに
  // なるので、 2 つ目の起動は既存の window を前面に出して終わる。
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) {
      // macOS は最後の window を閉じても process が残る。 そこへ実行ファイルから
      // 2 つ目を起動すると、 2 つ目は lock で終わるのでこちらで window を出す。
      if (app.isReady()) createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  await app.whenReady();
  registerMemoryIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

void bootstrap();

app.on("window-all-closed", () => {
  stopWatchAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopWatchAll();
});
