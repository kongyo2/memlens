import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, shell } from "electron";

import { registerMemoryIpc } from "./ipc/memory";
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

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });

  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];

  // renderer はローカル bundle だけを表示する。 リンクのドラッグ&ドロップ等で
  // window ごと外部ページへ遷移してしまう事故を防ぐ (外部 URL は上の
  // setWindowOpenHandler が default browser へ逃がす)。 dev では Vite の
  // full-reload (location.reload) が will-navigate を踏むので dev server の
  // URL だけ通す。
  win.webContents.on("will-navigate", (event, url) => {
    if (isDev && rendererUrl && url.startsWith(rendererUrl)) return;
    event.preventDefault();
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
