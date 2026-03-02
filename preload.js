const {contextBridge, ipcRenderer} = require("electron");
const Store = require('electron-store');
const {getVideoSource, sanitizeExtraVideo} = require('./shared/video-utils');
const textUtils = require('./shared/text-utils');
const store = new Store();
const bundledVideos = require("./videos.json");

// Expose protected methods from node modules
contextBridge.exposeInMainWorld("electron", {
    ipcRenderer: {
        send: (channel, data) => {
            const validChannels = ["quitApp", "keyPress", "updateCache", "deleteCache", "openCache", "selectCustomLocation", "selectCacheLocation", "refreshCache", "openPreview", "refreshConfig", "resetConfig", "updateLocation", "openConfigFolder", "openPlaybackLog", "selectFile", "openInfoEditor", "newGlobalShortcut", "consoleLog"];
            if (validChannels.includes(channel)) {
                ipcRenderer.send(channel, data);
            }
        },
        on: (channel, func) => {
            const validChannels = ["displaySettings", "newCustomVideos", "newVideo", "blankTheScreen", "showWelcome", "updateAttribute", "screenNumber"];
            if (validChannels.includes(channel)) {
                ipcRenderer.on(channel, (event, ...args) => func(...args));
            }
        },
        invoke: (channel, args) => {
            const validChannels = ["newVideoId"];
            if (validChannels.includes(channel)) {
                return ipcRenderer.invoke(channel, args);
            }
        }
    },
    store: {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value)
    },
    videos: store.get("videoCatalog") ?? bundledVideos,
    bundledVideos,
    videoUtils: {
        getVideoSource,
        sanitizeExtraVideo
    },
    textUtils,
    fontListUniversal: require('font-list-universal')
});
