import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, shell } from "electron";

import { registerMemoryIpc } from "./ipc/memory";
import { decideNavigation, originOf } from "./services/navigation";
import { stopWatchAll } from "./services/watcher";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: "memlens",
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.mjs"),
      sandbox: false,
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

  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(moduleDir, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
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
