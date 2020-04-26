import "reflect-metadata";
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import * as url from "url";

import { BlueBubbleServer } from "@server/index";

let win: BrowserWindow | null;
const api = new BlueBubbleServer(win);

const installExtensions = async () => {
    const installer = require("electron-devtools-installer");
    const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
    const extensions = ["REACT_DEVELOPER_TOOLS", "REDUX_DEVTOOLS"];

    return Promise.all(
        extensions.map((name) =>
            installer.default(installer[name], forceDownload)
        )
    ).catch(console.log); // eslint-disable-line no-console
};


// Start the API
api.start();

const createWindow = async () => {
    if (process.env.NODE_ENV !== "production") {
        await installExtensions();
    }

    win = new BrowserWindow({
        width: 1080,
        height: 920,
        webPreferences: {
            nodeIntegration: true // Required in new electron version
        }
    });

    if (process.env.NODE_ENV !== "production") {
        process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1"; // eslint-disable-line require-atomic-updates
        win.loadURL(`http://localhost:2003`);
    } else {
        win.loadURL(
            url.format({
                pathname: path.join(__dirname, "index.html"),
                protocol: "file:",
                slashes: true
            })
        );
    }

    if (process.env.NODE_ENV !== "production") {
        // Open DevTools, see https://github.com/electron/electron/issues/12438 for why we wait for dom-ready
        win.webContents.once("dom-ready", () => {
            win!.webContents.openDevTools();
        });
    }

    win.on("closed", () => {
        win = null;
    });

    // Hook onto when we load the UI
    win.webContents.send("config-update", api.config);
    win.webContents.on("dom-ready", async () => {
        win.webContents.send("config-update", api.config);
    });

    // Set the new window in the API
    api.window = win;
};

app.on("ready", createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (win === null) {
        createWindow();
    }
});
