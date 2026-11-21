"use strict";
// Glazok Studio — окно с пультом Glazok и виртуальные камеры для OBS и vMix.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const MONITOR_URL = process.env.GLAZOK_URL || "https://git-p31.github.io/Glazok/monitor.html";
const VIDEO_INPUT_CATEGORY = "{860BB310-5D01-11d0-BD3B-00A0C911CE86}";
const CAMERAS = ["Glazok Program", "Glazok Cam 1", "Glazok Cam 2", "Glazok Cam 3", "Glazok Cam 4"];
const clsid = i => `{6B3D3F10-9C1E-4D7A-8A54-2F1B0C7E4A0${i}}`;

/* Камеры регистрируются только для текущего пользователя (HKCU) — права администратора не нужны.
   DLL копируется в %LOCALAPPDATA%\GlazokStudio: путь не меняется при обновлениях,
   а если OBS/vMix держат старую DLL открытой, работаем со старой до перезапуска. */
function sourceDll() {
  const packaged = path.join(process.resourcesPath || "", "vcam", "GlazokVCam.dll");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "vcam", "build", "Release", "GlazokVCam.dll");
}

function installVcam() {
  const src = sourceDll();
  const dir = path.join(process.env.LOCALAPPDATA, "GlazokStudio");
  const dst = path.join(dir, "GlazokVCam.dll");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(src)) {
    const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size &&
      fs.readFileSync(dst).equals(fs.readFileSync(src));
    if (!same) {
      try { fs.copyFileSync(src, dst); }
      catch (error) { console.warn("DLL занята (OBS/vMix открыты?) — останется старая до перезапуска:", error.message); }
    }
  }
  if (!fs.existsSync(dst)) throw new Error("Не найден драйвер камеры: " + src);

  const reg = args => execFileSync("reg.exe", args, { windowsHide: true, stdio: "ignore" });
  CAMERAS.forEach((name, i) => {
    const key = `HKCU\\Software\\Classes\\CLSID\\${clsid(i)}`;
    reg(["add", key, "/ve", "/d", name, "/f"]);
    reg(["add", key + "\\InprocServer32", "/ve", "/d", dst, "/f"]);
    reg(["add", key + "\\InprocServer32", "/v", "ThreadingModel", "/d", "Both", "/f"]);
    const inst = `HKCU\\Software\\Classes\\CLSID\\${VIDEO_INPUT_CATEGORY}\\Instance\\${clsid(i)}`;
    reg(["add", inst, "/v", "FriendlyName", "/d", name, "/f"]);
    reg(["add", inst, "/v", "CLSID", "/d", clsid(i), "/f"]);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Glazok Studio",
    backgroundColor: "#0d0f14",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,               // preload пишет кадры в общую память через koffi
      backgroundThrottling: false,  // камера должна работать и при свёрнутом окне
    },
  });
  win.on("page-title-updated", e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/\/view\.html/.test(url)) return { action: "allow" };   // Clean Output — окно внутри приложения
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(MONITOR_URL);
  return win;
}

// Только одно окно: две копии писали бы в одни и те же камеры
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  try {
    installVcam();
  } catch (error) {
    dialog.showErrorBox("Glazok Studio", "Не удалось установить виртуальные камеры:\n" + error.message);
  }
  createWindow();
});

app.on("window-all-closed", () => app.quit());
