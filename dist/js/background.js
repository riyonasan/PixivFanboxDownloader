/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/ts/TotalDownload.ts"
/*!*********************************!*\
  !*** ./src/ts/TotalDownload.ts ***!
  \*********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   totalDownload: () => (/* binding */ totalDownload)
/* harmony export */ });
class TotalDownload {
    /** 记录每天的下载总体积。key 是当天的 date，value 是当天的下载总量（字节数） */
    data = {};
    constructor() {
        this.init();
    }
    init() {
        // 初始化存储
        chrome.runtime.onInstalled.addListener((details) => {
            if (details.reason === 'install') {
                chrome.storage.local.set({ totalDownload: {} }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('初始化存储失败:', chrome.runtime.lastError.message);
                    }
                    else {
                        console.log('totalDownload 初始化成功');
                    }
                });
            }
        });
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.msg === 'getTotalDownload') {
                // 返回今天的数据
                sendResponse({ total: this.data[this.getDate()] });
            }
            else if (request.msg === 'getTotalDownloadHistory30') {
                // 返回最近 30 天的数据（虽然可以返回所有数据，但是天数太多的话，前台不好展示）
                this.getLast30DaysData().then((history) => {
                    sendResponse({ history });
                });
                // 由于这个 sendResponse 是异步，所以需要返回 true 让消息端口不要关闭
                // Return true to keep the message port open for async response
                return true;
            }
            else {
                // Return false for unhandled messages
                return false;
            }
        });
        // 加载 totalDownload
        setTimeout(() => {
            this.restore();
        }, 0);
    }
    async restore() {
        const result = await chrome.storage.local.get(['totalDownload']);
        this.data = result.totalDownload || {};
    }
    /** 生成 YYYY-MM-DD 格式的当前日期 */
    getDate() {
        const date = new Date();
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    // 添加下载量
    addDownload(bytes) {
        const date = this.getDate();
        this.data[date] = (this.data[date] || 0) + bytes;
        chrome.storage.local.set({ totalDownload: this.data }, () => {
            // console.log(`更新 ${date} 的下载量: ${this.data[date]} 字节`)
        });
    }
    /**
     * 获取最近 30 天的数据（包括今天），以数组形式返回
     */
    async getLast30DaysData() {
        // 如果是空对象，可能尚未从 local storage 里加载数据，尝试重新加载一次
        // 例如后台脚本被回收了，前台却要查看数据, 于是后台脚本被再次执行，此时可能还是默认值
        if (Object.keys(this.data).length === 0) {
            await this.restore();
        }
        const today = new Date();
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 29);
        const result = Object.entries(this.data)
            .filter(([dateStr]) => {
            // 添加 T00:00:00 使日期初始化为本地时间 0 点
            // 如果不带 T 部分，JavaScript 会假设时间为 UTC 时间的 00:00:00
            // 然后，Date 对象会将这个 UTC 时间转换为本地时区（如香港标准时间为 GMT+0800）
            // 如果带 T，且不带时区标识符（如 Z 或 +08:00）时，JavaScript 会假定它是本地时间
            // 也就是 GMT+0000
            // 由于下载器在储存记录时，是使用 new Date() 来获取年月日的，这是本地时间
            // 所以这里对比时间时，也要初始化为本地时间，即指明 T00:00:00
            const date = new Date(dateStr + 'T00:00:00');
            return !isNaN(date.getTime()) && date >= thirtyDaysAgo && date <= today;
        })
            .map(([date, bytes]) => ({ date, bytes }));
        return result;
    }
}
const totalDownload = new TotalDownload();



/***/ },

/***/ "./src/ts/auto/AutoScheduler.ts"
/*!**************************************!*\
  !*** ./src/ts/auto/AutoScheduler.ts ***!
  \**************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _AutoTypes__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./AutoTypes */ "./src/ts/auto/AutoTypes.ts");
/* harmony import */ var _Ntfy__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./Ntfy */ "./src/ts/auto/Ntfy.ts");


const alarmName = 'fanboxAutoCheck';
let checking = false;
let starting = false;
let startAgain = false;
async function request(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
        throw new Error(`FANBOX request failed (HTTP ${response.status})`);
    }
    const result = await response.json();
    if (result.error || result.status === 'error') {
        throw new Error(result.error?.message || result.message || 'Request failed');
    }
    return result;
}
async function openScanTab() {
    const tab = await chrome.tabs.create({
        url: `https://www.fanbox.cc/?pfdAutoScan=${Date.now()}`,
        active: false,
    });
    if (tab.id === undefined)
        throw new Error('Automatic scan tab has no ID');
    return tab.id;
}
async function findNewPosts(tabId, profile, until, delayMs) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
            if (!tab.url?.startsWith('https://www.fanbox.cc/')) {
                throw new Error('FANBOX is not open in the automatic scan tab');
            }
            try {
                const response = await chrome.tabs.sendMessage(tabId, {
                    msg: 'auto_scan',
                    profile,
                    until,
                    delayMs,
                });
                if (response?.error)
                    throw new Error(response.error);
                if (!Array.isArray(response?.posts)) {
                    throw new Error('Automatic scan returned an unexpected result');
                }
                return response.posts;
            }
            catch (error) {
                if (attempt === 19 ||
                    (error instanceof Error &&
                        !error.message.includes('Receiving end does not exist')))
                    throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Automatic scan tab did not finish loading');
}
async function scanProfiles() {
    const stored = await chrome.storage.local.get([
        _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
        'fanboxSetting',
    ]);
    const interval = stored.fanboxSetting?.crawlInterval;
    const delayMs = Math.max(1000, Number(interval || 1) * 1000);
    const profiles = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] || []);
    if (profiles.length === 0)
        return;
    let tabId;
    let scanError = '';
    try {
        tabId = await openScanTab();
        for (const profile of profiles) {
            const until = Date.now();
            try {
                const found = await findNewPosts(tabId, profile, until, delayMs);
                const latest = await chrome.storage.local.get([
                    _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
                    _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
                ]);
                const currentProfiles = (latest[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] ||
                    []);
                const current = currentProfiles.find((item) => item.creatorId === profile.creatorId);
                if (!current)
                    continue;
                current.since = until;
                const pending = (latest[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []);
                for (const post of found.reverse()) {
                    if (!pending.some((item) => item.postId === post.postId))
                        pending.push(post);
                }
                await chrome.storage.local.set({
                    [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey]: currentProfiles,
                    [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: pending,
                });
                const previousStatus = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey);
                await chrome.storage.local.set({
                    [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey]: {
                        ...previousStatus[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey],
                        lastCheckedAt: Date.now(),
                    },
                });
            }
            catch (error) {
                scanError = `${profile.name}: ${error instanceof Error ? error.message : String(error)}`;
                console.error(`Automatic FANBOX check failed for ${profile.creatorId}`, error);
            }
        }
    }
    catch (error) {
        scanError = error instanceof Error ? error.message : String(error);
        console.error('Automatic FANBOX scan tab failed', error);
    }
    finally {
        if (tabId !== undefined) {
            await chrome.tabs.remove(tabId).catch(() => { });
        }
        const previousStatus = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey);
        await chrome.storage.local.set({
            [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey]: {
                ...previousStatus[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey],
                lastError: scanError,
            },
        });
    }
}
async function getActive() {
    const stored = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey);
    return (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey] || null);
}
async function clearStaleActive() {
    const active = await getActive();
    if (!active)
        return false;
    let tab;
    try {
        tab = await chrome.tabs.get(active.tabId);
    }
    catch {
        // Browser restart or user closed the tab.
    }
    if (tab && Date.now() - active.startedAt < 60 * 60 * 1000) {
        return true;
    }
    if (tab)
        await chrome.tabs.remove(active.tabId);
    await chrome.storage.local.remove(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey);
    return false;
}
async function sendStart(active, profile) {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const tab = await chrome.tabs.get(active.tabId);
            if (tab.status === 'complete') {
                const response = await chrome.tabs.sendMessage(active.tabId, {
                    msg: 'auto_start',
                    profile,
                    postId: active.task.postId,
                    startedAt: active.startedAt,
                });
                if (response?.accepted)
                    return;
                throw new Error(response?.error || 'Automatic post start was rejected');
            }
        }
        catch (error) {
            if (attempt === 19)
                throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Automatic post tab did not finish loading');
}
async function startNextPostInternal() {
    if (await clearStaleActive())
        return;
    const stored = await chrome.storage.local.get([
        _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
        _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
        'fanboxSetting',
    ]);
    const profiles = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] || []);
    const pending = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []);
    const remaining = pending.filter((item) => {
        const profile = profiles.find((value) => value.creatorId === item.creatorId);
        return profile && (0,_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.matchesAutoFee)(profile, item.fee);
    });
    if (remaining.length !== pending.length) {
        await chrome.storage.local.set({ [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: remaining });
    }
    const task = remaining.find((item) => !item.retryAfter || item.retryAfter <= Date.now());
    if (!task)
        return;
    const profile = profiles.find((item) => item.creatorId === task.creatorId);
    const tab = await chrome.tabs.create({
        url: `https://www.fanbox.cc/@${encodeURIComponent(task.creatorId)}/posts/${encodeURIComponent(task.postId)}`,
        active: false,
    });
    if (tab.id === undefined)
        throw new Error('Automatic post tab has no ID');
    const active = { tabId: tab.id, task, startedAt: Date.now() };
    await chrome.storage.local.set({ [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey]: active });
    try {
        await sendStart(active, profile);
    }
    catch (error) {
        await chrome.tabs.remove(active.tabId).catch(() => { });
        await chrome.storage.local.remove(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey);
        const previousStatus = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey);
        await chrome.storage.local.set({
            [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey]: {
                ...previousStatus[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey],
                lastError: `${profile.name}: ${error instanceof Error ? error.message : String(error)}`,
            },
        });
        console.error('Automatic FANBOX post could not start', error);
        await (0,_Ntfy__WEBPACK_IMPORTED_MODULE_1__.notifyAutoPost)(task, false).catch((notificationError) => console.warn('Automatic FANBOX notification failed', notificationError));
    }
}
async function startNextPost() {
    if (starting) {
        startAgain = true;
        return;
    }
    starting = true;
    try {
        await startNextPostInternal();
    }
    finally {
        starting = false;
        if (startAgain) {
            startAgain = false;
            void startNextPost().catch((error) => console.error('Automatic FANBOX import failed', error));
        }
    }
}
async function runAutoCheck() {
    if (checking)
        return;
    checking = true;
    try {
        await scanProfiles();
        await startNextPost();
    }
    catch (error) {
        console.error('Automatic FANBOX check failed', error);
    }
    finally {
        checking = false;
    }
}
async function finishPost(message) {
    const active = await getActive();
    if (!active ||
        active.task.creatorId !== message.creatorId ||
        active.task.postId !== message.postId ||
        active.startedAt !== message.startedAt)
        return;
    const stored = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey);
    const pending = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []);
    await chrome.storage.local.set({
        [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: message.success || message.skipped
            ? pending.filter((item) => item.postId !== message.postId)
            : pending.map((item) => item.postId === message.postId
                ? { ...item, retryAfter: Date.now() + 60 * 60 * 1000 }
                : item),
    });
    const previousStatus = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey);
    const status = (previousStatus[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey] || {});
    await chrome.storage.local.set({
        [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey]: {
            ...status,
            ...(message.skipped
                ? {
                    lastError: status.lastError?.startsWith(`${message.creatorId}:`)
                        ? ''
                        : status.lastError,
                }
                : message.success
                    ? {
                        ...(message.accepted
                            ? { lastAcceptedAt: Date.now() }
                            : { lastCompletedAt: Date.now() }),
                        lastError: '',
                    }
                    : {
                        lastError: `${message.creatorId}: 取り込みに失敗しました。次回再試行します。`,
                    }),
        },
    });
    await chrome.storage.local.remove(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await chrome.tabs.remove(active.tabId).catch(() => { });
    if (!message.skipped) {
        await (0,_Ntfy__WEBPACK_IMPORTED_MODULE_1__.notifyAutoPost)(active.task, message.success, message).catch((error) => console.warn('Automatic FANBOX notification failed', error));
    }
    void startNextPost().catch((error) => console.error('Automatic FANBOX import failed', error));
}
chrome.runtime.onMessage.addListener((message) => {
    if (message.msg === 'auto_result') {
        void finishPost(message).catch((error) => console.error('Automatic FANBOX result could not be saved', error));
    }
    else if (message.msg === 'auto_check_now') {
        void runAutoCheck();
    }
});
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === alarmName)
        void runAutoCheck();
});
async function ensureAlarm() {
    if (!(await chrome.alarms.get(alarmName))) {
        chrome.alarms.create(alarmName, { periodInMinutes: 60 });
    }
}
chrome.runtime.onInstalled.addListener(() => {
    void ensureAlarm().then(runAutoCheck);
});
chrome.runtime.onStartup.addListener(() => {
    void ensureAlarm().then(runAutoCheck);
});
void ensureAlarm();


/***/ },

/***/ "./src/ts/auto/AutoTypes.ts"
/*!**********************************!*\
  !*** ./src/ts/auto/AutoTypes.ts ***!
  \**********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   autoActiveKey: () => (/* binding */ autoActiveKey),
/* harmony export */   autoPendingKey: () => (/* binding */ autoPendingKey),
/* harmony export */   autoProfilesKey: () => (/* binding */ autoProfilesKey),
/* harmony export */   autoStatusKey: () => (/* binding */ autoStatusKey),
/* harmony export */   matchesAutoFee: () => (/* binding */ matchesAutoFee)
/* harmony export */ });
const autoProfilesKey = 'autoCreatorProfiles';
const autoPendingKey = 'autoPendingPosts';
const autoActiveKey = 'autoActivePost';
const autoStatusKey = 'autoDownloadStatus';
function matchesAutoFee(profile, fee) {
    if (fee === 0) {
        return profile.free;
    }
    return (profile.pay &&
        (profile.minFee === null || fee >= profile.minFee) &&
        (profile.maxFee === null || fee <= profile.maxFee));
}


/***/ },

/***/ "./src/ts/auto/Ntfy.ts"
/*!*****************************!*\
  !*** ./src/ts/auto/Ntfy.ts ***!
  \*****************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   notifyAutoPost: () => (/* binding */ notifyAutoPost)
/* harmony export */ });
let configuredURL;
function getNtfyURL() {
    configuredURL ??= fetch(chrome.runtime.getURL('ntfy-config.json')).then(async (response) => {
        if (!response.ok)
            throw new Error(`Notification config: HTTP ${response.status}`);
        const config = (await response.json());
        return typeof config.url === 'string' && config.url ? config.url : null;
    });
    return configuredURL;
}
async function notifyAutoPost(task, success, details) {
    const url = await getNtfyURL();
    if (!url)
        return;
    const postURL = `https://www.fanbox.cc/@${encodeURIComponent(task.creatorId)}/posts/${encodeURIComponent(task.postId)}`;
    if (success && (!details?.creatorName || !details.postTitle)) {
        throw new Error('FANBOX post notification is missing its name or title');
    }
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Click: postURL,
    };
    if (!success)
        headers.Title = 'FANBOX auto task failed';
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: success
            ? `${details.creatorName}\n${details.postTitle}\n${details?.accepted ? 'Files accepted; Eagle registration pending verification\n' : ''}${postURL}`
            : `${task.creatorId}: 自動取得に失敗しました。次回再試行します。\n${postURL}`,
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
        throw new Error(`ntfy request failed (HTTP ${response.status})`);
}


/***/ },

/***/ "./src/ts/eagle/Eagle.ts"
/*!*******************************!*\
  !*** ./src/ts/eagle/Eagle.ts ***!
  \*******************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   eagle: () => (/* binding */ eagle)
/* harmony export */ });
// Eagle のローカル API との接続だけを担当する。
class Eagle {
    apiURL = 'http://localhost:41595/api';
    folderListPromise = null;
    folderIdCache = new Map();
    folderItemsCache = new Map();
    cacheScope = '';
    async addFromURL(url, fileName, website, scope, annotation) {
        this.resetCache(scope);
        if (url.startsWith('blob:')) {
            throw new Error('Eagle cannot register a blob URL');
        }
        // Eagle cannot download paid FANBOX files with the extension's request
        // headers. Fetch them in the service worker with the browser's cookies and
        // pass the response to Eagle as a data URL instead.
        const eagleURL = await this.getEagleURL(url);
        const folderId = await this.getFolderId(this.getFolderPath(fileName));
        const item = {
            url: eagleURL,
            name: this.getItemName(fileName),
            website,
            folderId,
            annotation,
            headers: eagleURL.startsWith('data:')
                ? undefined
                : this.getHeaders(website),
        };
        await this.request('item/addFromURL', item);
    }
    async hasExisting(fileName, scope) {
        this.resetCache(scope);
        const folders = await this.listFolders();
        let parent;
        for (const name of this.getFolderPath(fileName)) {
            const folder = this.findDirectFolder(folders, name, parent);
            if (!folder) {
                return false;
            }
            parent = folder.id;
        }
        if (!parent) {
            return false;
        }
        const folderId = parent;
        const finalName = fileName.split('/').pop() || fileName;
        const extensionIndex = finalName.lastIndexOf('.');
        const extension = extensionIndex > 0 ? finalName.substring(extensionIndex + 1) : '';
        const name = this.getItemName(fileName);
        const items = await this.listFolderItems(folderId);
        return items.some((item) => !item.isDeleted &&
            item.folders.includes(folderId) &&
            this.sameItemName(item.name, name) &&
            item.ext.toLowerCase() === extension.toLowerCase());
    }
    sameItemName(actual, expected) {
        if (actual === expected) {
            return true;
        }
        const actualIndex = /^(.*-)(\d+)$/.exec(actual);
        const expectedIndex = /^(.*-)(\d+)$/.exec(expected);
        return !!(actualIndex &&
            expectedIndex &&
            actualIndex[1] === expectedIndex[1] &&
            actualIndex[2].replace(/^0+(?=\d)/, '') ===
                expectedIndex[2].replace(/^0+(?=\d)/, ''));
    }
    listFolderItems(folderId) {
        let itemsPromise = this.folderItemsCache.get(folderId);
        if (!itemsPromise) {
            itemsPromise = this.fetchFolderItems(folderId).catch((error) => {
                this.folderItemsCache.delete(folderId);
                throw error;
            });
            this.folderItemsCache.set(folderId, itemsPromise);
        }
        return itemsPromise;
    }
    async fetchFolderItems(folderId) {
        const items = [];
        const limit = 1000;
        while (true) {
            const page = await this.request(`item/list?folders=${encodeURIComponent(folderId)}&limit=${limit}&offset=${items.length}`);
            if (!Array.isArray(page)) {
                throw new Error('Eagle returned an invalid item list');
            }
            items.push(...page);
            if (page.length < limit) {
                return items;
            }
        }
    }
    async getEagleURL(url) {
        let parsedURL;
        try {
            parsedURL = new URL(url);
        }
        catch {
            return url;
        }
        const hostname = parsedURL.hostname;
        if (parsedURL.protocol !== 'https:' ||
            (hostname !== 'fanbox.cc' && !hostname.endsWith('.fanbox.cc'))) {
            return url;
        }
        let response;
        try {
            response = await fetch(url, { credentials: 'include' });
        }
        catch {
            throw new Error('Unable to download FANBOX file (network error)');
        }
        if (!response.ok) {
            throw new Error(`Unable to download FANBOX file (HTTP ${response.status})`);
        }
        let buffer;
        try {
            buffer = await response.arrayBuffer();
        }
        catch {
            throw new Error('Unable to read FANBOX file response');
        }
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        const mimeType = response.headers.get('content-type') || 'application/octet-stream';
        return `data:${mimeType};base64,${btoa(binary)}`;
    }
    getHeaders(website) {
        return { referer: website };
    }
    getFolderPath(fileName) {
        const parts = fileName.split('/').filter((part) => part.length > 0);
        parts.pop();
        // 通常の命名規則には fanbox が含まれるため、Eagle では大文字の
        // FANBOX フォルダをルートとして使う。
        if (parts[0]?.toLowerCase() === 'fanbox') {
            parts.shift();
        }
        return ['FANBOX', ...parts];
    }
    getItemName(fileName) {
        const name = fileName.split('/').pop() || fileName;
        const extensionIndex = name.lastIndexOf('.');
        return extensionIndex > 0 ? name.substring(0, extensionIndex) : name;
    }
    async getFolderId(path) {
        let parent;
        for (const name of path) {
            const cacheKey = `${parent || ''}/${name}`;
            let folderPromise = this.folderIdCache.get(cacheKey);
            if (!folderPromise) {
                folderPromise = this.findOrCreateFolder(name, parent).catch((error) => {
                    this.folderIdCache.delete(cacheKey);
                    throw error;
                });
                this.folderIdCache.set(cacheKey, folderPromise);
            }
            parent = await folderPromise;
        }
        if (!parent) {
            throw new Error('Eagle folder path is empty');
        }
        return parent;
    }
    async findOrCreateFolder(name, parent) {
        const folders = await this.listFolders();
        const existing = this.findDirectFolder(folders, name, parent);
        if (existing) {
            return existing.id;
        }
        const created = await this.request('folder/create', {
            folderName: name,
            ...(parent ? { parent } : {}),
        });
        if (!created || !created.id) {
            throw new Error(`Eagle did not return a folder ID for "${name}"`);
        }
        // 同じ処理中に別の記事から参照された場合も、作成直後のフォルダを
        // 再利用できるように一覧へ反映する。
        if (parent) {
            const parentFolder = this.findFolderById(folders, parent);
            if (parentFolder) {
                parentFolder.children ||= [];
                parentFolder.children.push(created);
            }
        }
        else {
            folders.push(created);
        }
        return created.id;
    }
    listFolders() {
        if (!this.folderListPromise) {
            this.folderListPromise = this.request('folder/list')
                .then((folders) => folders || [])
                .catch((error) => {
                this.folderListPromise = null;
                throw error;
            });
        }
        return this.folderListPromise;
    }
    findDirectFolder(folders, name, parent) {
        const parentFolder = parent ? this.findFolderById(folders, parent) : null;
        const siblings = parent ? parentFolder?.children || [] : folders;
        const matches = siblings.filter((folder) => folder.name === name);
        if (matches.length > 1) {
            throw new Error(`Multiple Eagle folders named "${name}" exist`);
        }
        return matches[0];
    }
    findFolderById(folders, id) {
        for (const folder of folders) {
            if (folder.id === id) {
                return folder;
            }
            const child = folder.children && this.findFolderById(folder.children, id);
            if (child) {
                return child;
            }
        }
        return undefined;
    }
    resetCache(scope) {
        if (scope === this.cacheScope) {
            return;
        }
        this.cacheScope = scope;
        this.folderListPromise = null;
        this.folderIdCache.clear();
        this.folderItemsCache.clear();
    }
    async request(path, body) {
        const response = await fetch(`${this.apiURL}/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let result;
        try {
            result = (await response.json());
        }
        catch {
            throw new Error(`Eagle API returned an invalid response (${response.status})`);
        }
        if (!response.ok || result.status !== 'success') {
            throw new Error(result.message || `Eagle API request failed (${response.status})`);
        }
        return result.data;
    }
}
const eagle = new Eagle();



/***/ },

/***/ "./src/ts/queue/DurableQueue.ts"
/*!**************************************!*\
  !*** ./src/ts/queue/DurableQueue.ts ***!
  \**************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Delivery: () => (/* binding */ Delivery),
/* harmony export */   DurableQueue: () => (/* binding */ DurableQueue),
/* harmony export */   hex: () => (/* binding */ hex),
/* harmony export */   marker: () => (/* binding */ marker)
/* harmony export */ });
/* harmony import */ var _noble_hashes_sha256__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! @noble/hashes/sha256 */ "./node_modules/@noble/hashes/esm/sha256.js");

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const marker = (job) => `PFD:${job.id}:${job.hash}`;
const request = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});
const committed = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Queue transaction aborted'));
    tx.onerror = () => { }; // onabort is the definitive failure
});
// Extension-origin storage. No authentication material is stored here.
class DurableQueue {
    db;
    capacity;
    constructor(db, capacity = 1024 ** 3) {
        this.db = db;
        this.capacity = capacity;
    }
    static async open(name = 'PFD-durable-queue', capacity = 1024 ** 3) {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => {
            r.result.createObjectStore('jobs', { keyPath: 'id' });
            r.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
            r.result.createObjectStore('meta');
        };
        return new DurableQueue(await request(r), capacity);
    }
    close() {
        this.db.close();
    }
    async get(id) {
        return request(this.db.transaction('jobs').objectStore('jobs').get(id));
    }
    async list() {
        const jobs = await request(this.db.transaction('jobs').objectStore('jobs').getAll());
        return jobs.sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) -
            (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
            a.created - b.created ||
            a.id.localeCompare(b.id));
    }
    async begin(meta) {
        const id = hex((0,_noble_hashes_sha256__WEBPACK_IMPORTED_MODULE_0__.sha256)(new TextEncoder().encode(meta.recordKey)));
        const tx = this.db.transaction('jobs', 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const store = tx.objectStore('jobs');
        const existing = await request(store.get(id));
        const job = existing || {
            ...meta,
            id,
            state: 'staging',
            created: Date.now(),
            size: 0,
            chunks: 0,
        };
        if (!existing)
            store.add(job);
        await done;
        return job;
    }
    async append(id, index, bytes) {
        if (bytes.length > 256 * 1024)
            throw new Error('Queue chunk exceeds 256 KiB memory budget');
        const tx = this.db.transaction(['jobs', 'chunks', 'meta'], 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const jobs = tx.objectStore('jobs'), chunks = tx.objectStore('chunks'), meta = tx.objectStore('meta');
        try {
            const job = await request(jobs.get(id));
            if (!job || job.state !== 'staging' || index !== job.chunks)
                throw new Error('Invalid staging sequence');
            const used = (await request(meta.get('used'))) || 0;
            if (used + bytes.length > this.capacity)
                throw new Error('Queue full: accepted files retained; acquisition paused');
            chunks.add({ id, index, blob: new Blob([new Uint8Array(bytes)]) });
            job.size += bytes.length;
            job.chunks++;
            jobs.put(job);
            meta.put(used + bytes.length, 'used');
        }
        catch (e) {
            tx.abort();
            await done.catch(() => { });
            throw e;
        }
        await done; // never acknowledge a request before the transaction commits
    }
    async *bytes(job) {
        for (let index = 0; index < job.chunks; index++) {
            const row = await request(this.db
                .transaction('chunks')
                .objectStore('chunks')
                .get([job.id, index]));
            if (!row)
                throw new Error('Durable queue bytes missing; retain metadata for recovery');
            yield new Uint8Array(await row.blob.arrayBuffer());
        }
    }
    async accept(id, expectedSize, expectedHash) {
        const job = await this.get(id);
        if (!job)
            throw new Error('Missing staging job');
        if (job.state !== 'staging')
            return job;
        if (job.size !== expectedSize)
            throw new Error('Incomplete acquisition');
        const hash = _noble_hashes_sha256__WEBPACK_IMPORTED_MODULE_0__.sha256.create();
        for await (const bytes of this.bytes(job))
            hash.update(bytes);
        const digest = hex(hash.digest());
        if (expectedHash && digest !== expectedHash)
            throw new Error('Source changed during resumed acquisition; staging bytes retained');
        const tx = this.db.transaction(['jobs', 'meta'], 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const store = tx.objectStore('jobs'), meta = tx.objectStore('meta');
        const current = await request(store.get(id));
        if (current.state !== 'staging') {
            await done;
            return current;
        }
        if (current.size !== job.size || current.chunks !== job.chunks) {
            tx.abort();
            await done.catch(() => { });
            throw new Error('Staging changed while hashing');
        }
        const sequence = ((await request(meta.get('sequence'))) || 0) + 1;
        Object.assign(current, { state: 'ready', hash: digest, sequence });
        store.put(current);
        meta.put(sequence, 'sequence');
        await done;
        return current;
    }
    async update(id, patch) {
        const tx = this.db.transaction('jobs', 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const store = tx.objectStore('jobs'), job = await request(store.get(id));
        if (!job) {
            tx.abort();
            await done.catch(() => { });
            throw new Error('Unknown job');
        }
        Object.assign(job, patch);
        store.put(job);
        await done;
        return job;
    }
    async recover() {
        for (const job of await this.list())
            if (job.state === 'sending')
                await this.update(job.id, {
                    state: 'unknown',
                    error: 'Worker stopped during request; reconciliation required',
                });
    }
    async take(id) {
        const tx = this.db.transaction('jobs', 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const store = tx.objectStore('jobs'), jobs = await request(store.getAll());
        const unfinished = jobs
            .filter((j) => ['ready', 'unknown', 'sending'].includes(j.state))
            .sort((a, b) => a.sequence - b.sequence);
        const first = unfinished[0];
        if (!first || first.id !== id || first.state !== 'ready') {
            await done;
            return false;
        }
        first.state = 'sending';
        store.put(first);
        await done;
        return true;
    }
    async verify(proof, cleanup = false) {
        const job = await this.get(proof.jobId);
        if (!job ||
            !['pending-verification', 'unknown'].includes(job.state) ||
            !proof.originalFile ||
            !proof.itemId ||
            proof.marker !== marker(job) ||
            proof.size !== job.size ||
            proof.sha256 !== job.hash ||
            (job.itemId && job.itemId !== proof.itemId))
            throw new Error('Exact original-file proof required');
        const tx = this.db.transaction(['jobs', 'chunks', 'meta'], 'readwrite', {
            durability: 'strict',
        }), done = committed(tx);
        const current = await request(tx.objectStore('jobs').get(job.id));
        if (!['pending-verification', 'unknown'].includes(current.state) ||
            current.hash !== proof.sha256 ||
            (current.itemId && current.itemId !== proof.itemId)) {
            tx.abort();
            await done.catch(() => { });
            throw new Error('Proof was superseded');
        }
        // This API is for a trusted verifier adapter, never an untrusted tab message.
        job.state = 'registered';
        job.itemId = proof.itemId;
        job.error = undefined;
        if (cleanup) {
            const meta = tx.objectStore('meta'), used = (await request(meta.get('used'))) || 0;
            for (let index = 0; index < job.chunks; index++)
                tx.objectStore('chunks').delete([job.id, index]);
            meta.put(used - job.size, 'used');
        }
        tx.objectStore('jobs').put(job);
        await done;
    }
}
class Delivery {
    queue;
    adapter;
    running = false;
    constructor(queue, adapter) {
        this.queue = queue;
        this.adapter = adapter;
    }
    async run() {
        if (this.running)
            return;
        this.running = true;
        try {
            for (const job of await this.queue.list()) {
                if (job.state === 'unknown') {
                    const found = await this.adapter.reconcile(job);
                    if (!found)
                        return; // absence does not prove the prior request was rejected
                    await this.queue.update(job.id, {
                        state: 'pending-verification',
                        itemId: found.itemId,
                    });
                }
                else if (job.state === 'ready') {
                    const found = await this.adapter.reconcile(job); // before every first submission
                    if (found) {
                        await this.queue.update(job.id, {
                            state: 'pending-verification',
                            itemId: found.itemId,
                        });
                        continue;
                    }
                    await this.adapter.prepare?.(job);
                    if (!(await this.queue.take(job.id)))
                        return;
                    try {
                        await this.adapter.submit(job, this.queue.bytes(job));
                        await this.queue.update(job.id, { state: 'pending-verification' });
                    }
                    catch (e) {
                        await this.queue.update(job.id, {
                            state: 'unknown',
                            error: String(e),
                        });
                        return;
                    }
                }
                else if (job.state === 'sending')
                    return;
                // Retained, acknowledged jobs do not prevent delivery of later accepted jobs.
            }
        }
        finally {
            this.running = false;
        }
    }
}


/***/ },

/***/ "./src/ts/queue/LocalEagle.ts"
/*!************************************!*\
  !*** ./src/ts/queue/LocalEagle.ts ***!
  \************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   LocalEagle: () => (/* binding */ LocalEagle)
/* harmony export */ });
/* harmony import */ var _eagle_Eagle__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../eagle/Eagle */ "./src/ts/eagle/Eagle.ts");
/* harmony import */ var _DurableQueue__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./DurableQueue */ "./src/ts/queue/DurableQueue.ts");


// V1 localhost only. No listener, remote credential, or plugin is installed.
class LocalEagle {
    async reconcile(job) {
        // Never use Eagle's legacy name/folder cache for reconciliation.
        const matches = [];
        for (let offset = 0;; offset += 1000) {
            const response = await fetch(`http://localhost:41595/api/item/list?limit=1000&offset=${offset}`, { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok ||
                body.status !== 'success' ||
                !Array.isArray(body.data))
                throw new Error('Eagle fresh lookup unavailable');
            for (const item of body.data) {
                if (!item.isDeleted &&
                    item.annotation === (0,_DurableQueue__WEBPACK_IMPORTED_MODULE_1__.marker)(job) &&
                    item.url === job.website) {
                    const detailResponse = await fetch(`http://localhost:41595/api/item/info?id=${encodeURIComponent(item.id)}`, { cache: 'no-store' });
                    const detail = await detailResponse.json();
                    if (!detailResponse.ok || detail.status !== 'success')
                        throw new Error('Eagle detail lookup unavailable');
                    if (!detail.data.isDeleted &&
                        detail.data.annotation === (0,_DurableQueue__WEBPACK_IMPORTED_MODULE_1__.marker)(job) &&
                        detail.data.url === job.website)
                        matches.push(item.id);
                }
            }
            if (body.data.length < 1000)
                break;
        }
        if (matches.length > 1)
            throw new Error('Multiple Eagle items have this job marker; manual reconciliation required');
        // This only resolves whether a request created a candidate. It is never byte proof.
        return matches.length ? { itemId: matches[0] } : undefined;
    }
    async submit(job, bytes) {
        // V1 JSON/data-URL requires whole-body strings. Keep a separate explicit
        // transport memory budget; larger MOVs remain durably accepted and retained.
        let binary = '';
        for await (const chunk of bytes) {
            for (let i = 0; i < chunk.length; i += 0x8000)
                binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
        }
        await _eagle_Eagle__WEBPACK_IMPORTED_MODULE_0__.eagle.addFromURL(`data:${job.mime};base64,${btoa(binary)}`, job.filename, job.website, job.id, (0,_DurableQueue__WEBPACK_IMPORTED_MODULE_1__.marker)(job));
    }
    async prepare(job) {
        if (job.size > 128 * 1024 ** 2)
            throw new Error('V1 delivery needs whole-body base64; file exceeds 128 MiB transport budget and is retained');
    }
}


/***/ },

/***/ "./src/ts/queue/Ownership.ts"
/*!***********************************!*\
  !*** ./src/ts/queue/Ownership.ts ***!
  \***********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   canonical: () => (/* binding */ canonical),
/* harmony export */   claim: () => (/* binding */ claim),
/* harmony export */   ownTask: () => (/* binding */ ownTask)
/* harmony export */ });
// Session storage survives worker suspension but expires with the browser.
// Claims are serialized through this one extension worker; no time-based lease
// can steal work from a live, slow tab.
let serial = Promise.resolve();
function canonical(url) {
    const u = new URL(url);
    const post = /\/posts\/(\d+)/.exec(u.pathname);
    return post ? `post:${post[1]}` : `${u.origin}${u.pathname}`;
}
function claim(sender) {
    const operation = serial
        .catch(() => { })
        .then(async () => {
        if (sender.tab?.id === undefined || !sender.url || !sender.documentId)
            throw new Error('Tab document identity required');
        if ((sender.frameId !== undefined && sender.frameId !== 0) ||
            (sender.documentLifecycle && sender.documentLifecycle !== 'active'))
            return false;
        const key = canonical(sender.url);
        const data = await chrome.storage.session.get('pfdOwners');
        const owners = (data.pfdOwners || {});
        const existing = owners[key];
        if (existing &&
            (existing.tab !== sender.tab.id ||
                existing.document !== sender.documentId)) {
            const tab = await chrome.tabs.get(existing.tab).catch(() => undefined);
            if (tab?.url &&
                canonical(tab.url) === key &&
                existing.tab !== sender.tab.id)
                return false;
            // Navigation creates a new document in the same tab; old requests cannot
            // claim ownership again because their document is no longer current.
        }
        owners[key] = { tab: sender.tab.id, document: sender.documentId };
        await chrome.storage.session.set({ pfdOwners: owners });
        return true;
    });
    serial = operation;
    return operation;
}
async function ownTask() {
    const response = await chrome.runtime.sendMessage({ msg: 'pfd_claim' });
    if (!response?.owned)
        return false;
    return true;
}


/***/ },

/***/ "./src/ts/queue/Runtime.ts"
/*!*********************************!*\
  !*** ./src/ts/queue/Runtime.ts ***!
  \*********************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _DurableQueue__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./DurableQueue */ "./src/ts/queue/DurableQueue.ts");
/* harmony import */ var _Ownership__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./Ownership */ "./src/ts/queue/Ownership.ts");
/* harmony import */ var _LocalEagle__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./LocalEagle */ "./src/ts/queue/LocalEagle.ts");



const ready = _DurableQueue__WEBPACK_IMPORTED_MODULE_0__.DurableQueue.open().then(async (queue) => {
    await queue.recover();
    return { queue, delivery: new _DurableQueue__WEBPACK_IMPORTED_MODULE_0__.Delivery(queue, new _LocalEagle__WEBPACK_IMPORTED_MODULE_2__.LocalEagle()) };
});
function pump() {
    void ready
        .then(({ delivery }) => delivery.run())
        .catch((e) => console.warn('Eagle delivery waiting:', String(e)));
}
// Existing scheduler alarm provides a wake-up without another scheduler.
chrome.alarms.onAlarm.addListener(pump);
chrome.runtime.onStartup.addListener(pump);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (![
        'pfd_claim',
        'queue_begin',
        'queue_chunk',
        'queue_accept',
        'queue_status',
    ].includes(message.msg))
        return false;
    void (async () => {
        if (message.msg === 'queue_status') {
            // Only extension pages may inspect metadata; no bytes or auth material exposed.
            if (!sender.url?.startsWith(chrome.runtime.getURL('')))
                throw new Error('Queue status requires an extension page');
            return { jobs: await (await ready).queue.list() };
        }
        if (!(await (0,_Ownership__WEBPACK_IMPORTED_MODULE_1__.claim)(sender)))
            throw new Error('This post is owned by another live tab');
        if (message.msg === 'pfd_claim')
            return { owned: true };
        const { queue } = await ready;
        if (message.msg === 'queue_begin') {
            if (!message.metadata?.website ||
                (0,_Ownership__WEBPACK_IMPORTED_MODULE_1__.canonical)(message.metadata.website) !== (0,_Ownership__WEBPACK_IMPORTED_MODULE_1__.canonical)(sender.url) ||
                new URL(message.metadata.website).origin !== 'https://www.fanbox.cc')
                throw new Error('Queue post identity mismatch');
            return { job: await queue.begin(message.metadata) };
        }
        const job = await queue.get(message.jobId);
        if (!job || (0,_Ownership__WEBPACK_IMPORTED_MODULE_1__.canonical)(job.website) !== (0,_Ownership__WEBPACK_IMPORTED_MODULE_1__.canonical)(sender.url))
            throw new Error('Queue job belongs to another post');
        if (message.msg === 'queue_chunk') {
            if (typeof message.base64 !== 'string' || message.base64.length > 349528)
                throw new Error('Queue message exceeds chunk memory budget');
            const raw = atob(message.base64);
            await queue.append(job.id, message.index, Uint8Array.from(raw, (c) => c.charCodeAt(0)));
            return { committed: true };
        }
        if (!/^[a-f0-9]{64}$/.test(message.hash || ''))
            throw new Error('Original stream hash required');
        const accepted = await queue.accept(job.id, message.size, message.hash);
        pump();
        return { accepted: true, job: accepted };
    })().then(respond, (e) => respond({ error: String(e) }));
    return true;
});


/***/ },

/***/ "./node_modules/@noble/hashes/esm/_md.js"
/*!***********************************************!*\
  !*** ./node_modules/@noble/hashes/esm/_md.js ***!
  \***********************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Chi: () => (/* binding */ Chi),
/* harmony export */   HashMD: () => (/* binding */ HashMD),
/* harmony export */   Maj: () => (/* binding */ Maj),
/* harmony export */   SHA224_IV: () => (/* binding */ SHA224_IV),
/* harmony export */   SHA256_IV: () => (/* binding */ SHA256_IV),
/* harmony export */   SHA384_IV: () => (/* binding */ SHA384_IV),
/* harmony export */   SHA512_IV: () => (/* binding */ SHA512_IV),
/* harmony export */   setBigUint64: () => (/* binding */ setBigUint64)
/* harmony export */ });
/* harmony import */ var _utils_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./utils.js */ "./node_modules/@noble/hashes/esm/utils.js");
/**
 * Internal Merkle-Damgard hash utils.
 * @module
 */

/** Polyfill for Safari 14. https://caniuse.com/mdn-javascript_builtins_dataview_setbiguint64 */
function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === 'function')
        return view.setBigUint64(byteOffset, value, isLE);
    const _32n = BigInt(32);
    const _u32_max = BigInt(0xffffffff);
    const wh = Number((value >> _32n) & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
}
/** Choice: a ? b : c */
function Chi(a, b, c) {
    return (a & b) ^ (~a & c);
}
/** Majority function, true if any two inputs is true. */
function Maj(a, b, c) {
    return (a & b) ^ (a & c) ^ (b & c);
}
/**
 * Merkle-Damgard hash construction base class.
 * Could be used to create MD5, RIPEMD, SHA1, SHA2.
 */
class HashMD extends _utils_js__WEBPACK_IMPORTED_MODULE_0__.Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.createView)(this.buffer);
    }
    update(data) {
        ;(0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.aexists)(this);
        data = (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.toBytes)(data);
        (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.abytes)(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len;) {
            const take = Math.min(blockLen - this.pos, len - pos);
            // Fast path: we have at least one block in input, cast it to view and process
            if (take === blockLen) {
                const dataView = (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.createView)(data);
                for (; blockLen <= len - pos; pos += blockLen)
                    this.process(dataView, pos);
                continue;
            }
            buffer.set(data.subarray(pos, pos + take), this.pos);
            this.pos += take;
            pos += take;
            if (this.pos === blockLen) {
                this.process(view, 0);
                this.pos = 0;
            }
        }
        this.length += data.length;
        this.roundClean();
        return this;
    }
    digestInto(out) {
        ;(0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.aexists)(this);
        (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.aoutput)(out, this);
        this.finished = true;
        // Padding
        // We can avoid allocation of buffer for padding completely if it
        // was previously not allocated here. But it won't change performance.
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        // append the bit '1' to the message
        buffer[pos++] = 0b10000000;
        (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.clean)(this.buffer.subarray(pos));
        // we have less than padOffset left in buffer, so we cannot put length in
        // current block, need process it and pad again
        if (this.padOffset > blockLen - pos) {
            this.process(view, 0);
            pos = 0;
        }
        // Pad until full block byte with zeros
        for (let i = pos; i < blockLen; i++)
            buffer[i] = 0;
        // Note: sha512 requires length to be 128bit integer, but length in JS will overflow before that
        // You need to write around 2 exabytes (u64_max / 8 / (1024**6)) for this to happen.
        // So we just write lowest 64 bits of that value.
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = (0,_utils_js__WEBPACK_IMPORTED_MODULE_0__.createView)(out);
        const len = this.outputLen;
        // NOTE: we do division by 4 later, which should be fused in single op with modulo by JIT
        if (len % 4)
            throw new Error('_sha2: outputLen should be aligned to 32bit');
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
            throw new Error('_sha2: outputLen bigger than state');
        for (let i = 0; i < outLen; i++)
            oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
    }
    _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
            to.buffer.set(buffer);
        return to;
    }
    clone() {
        return this._cloneInto();
    }
}
/**
 * Initial SHA-2 state: fractional parts of square roots of first 16 primes 2..53.
 * Check out `test/misc/sha2-gen-iv.js` for recomputation guide.
 */
/** Initial SHA256 state. Bits 0..32 of frac part of sqrt of primes 2..19 */
const SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
/** Initial SHA224 state. Bits 32..64 of frac part of sqrt of primes 23..53 */
const SHA224_IV = /* @__PURE__ */ Uint32Array.from([
    0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4,
]);
/** Initial SHA384 state. Bits 0..64 of frac part of sqrt of primes 23..53 */
const SHA384_IV = /* @__PURE__ */ Uint32Array.from([
    0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
    0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
]);
/** Initial SHA512 state. Bits 0..64 of frac part of sqrt of primes 2..19 */
const SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
]);
//# sourceMappingURL=_md.js.map

/***/ },

/***/ "./node_modules/@noble/hashes/esm/_u64.js"
/*!************************************************!*\
  !*** ./node_modules/@noble/hashes/esm/_u64.js ***!
  \************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   add: () => (/* binding */ add),
/* harmony export */   add3H: () => (/* binding */ add3H),
/* harmony export */   add3L: () => (/* binding */ add3L),
/* harmony export */   add4H: () => (/* binding */ add4H),
/* harmony export */   add4L: () => (/* binding */ add4L),
/* harmony export */   add5H: () => (/* binding */ add5H),
/* harmony export */   add5L: () => (/* binding */ add5L),
/* harmony export */   "default": () => (__WEBPACK_DEFAULT_EXPORT__),
/* harmony export */   fromBig: () => (/* binding */ fromBig),
/* harmony export */   rotlBH: () => (/* binding */ rotlBH),
/* harmony export */   rotlBL: () => (/* binding */ rotlBL),
/* harmony export */   rotlSH: () => (/* binding */ rotlSH),
/* harmony export */   rotlSL: () => (/* binding */ rotlSL),
/* harmony export */   rotr32H: () => (/* binding */ rotr32H),
/* harmony export */   rotr32L: () => (/* binding */ rotr32L),
/* harmony export */   rotrBH: () => (/* binding */ rotrBH),
/* harmony export */   rotrBL: () => (/* binding */ rotrBL),
/* harmony export */   rotrSH: () => (/* binding */ rotrSH),
/* harmony export */   rotrSL: () => (/* binding */ rotrSL),
/* harmony export */   shrSH: () => (/* binding */ shrSH),
/* harmony export */   shrSL: () => (/* binding */ shrSL),
/* harmony export */   split: () => (/* binding */ split),
/* harmony export */   toBig: () => (/* binding */ toBig)
/* harmony export */ });
/**
 * Internal helpers for u64. BigUint64Array is too slow as per 2025, so we implement it using Uint32Array.
 * @todo re-check https://issues.chromium.org/issues/42212588
 * @module
 */
const U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
const _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
    if (le)
        return { h: Number(n & U32_MASK64), l: Number((n >> _32n) & U32_MASK64) };
    return { h: Number((n >> _32n) & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
    const len = lst.length;
    let Ah = new Uint32Array(len);
    let Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
        const { h, l } = fromBig(lst[i], le);
        [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
}
const toBig = (h, l) => (BigInt(h >>> 0) << _32n) | BigInt(l >>> 0);
// for Shift in [0, 32)
const shrSH = (h, _l, s) => h >>> s;
const shrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
// Right rotate for Shift in [1, 32)
const rotrSH = (h, l, s) => (h >>> s) | (l << (32 - s));
const rotrSL = (h, l, s) => (h << (32 - s)) | (l >>> s);
// Right rotate for Shift in (32, 64), NOTE: 32 is special case.
const rotrBH = (h, l, s) => (h << (64 - s)) | (l >>> (s - 32));
const rotrBL = (h, l, s) => (h >>> (s - 32)) | (l << (64 - s));
// Right rotate for shift===32 (just swaps l&h)
const rotr32H = (_h, l) => l;
const rotr32L = (h, _l) => h;
// Left rotate for Shift in [1, 32)
const rotlSH = (h, l, s) => (h << s) | (l >>> (32 - s));
const rotlSL = (h, l, s) => (l << s) | (h >>> (32 - s));
// Left rotate for Shift in (32, 64), NOTE: 32 is special case.
const rotlBH = (h, l, s) => (l << (s - 32)) | (h >>> (64 - s));
const rotlBL = (h, l, s) => (h << (s - 32)) | (l >>> (64 - s));
// JS uses 32-bit signed integers for bitwise operations which means we cannot
// simple take carry out of low bit sum by shift, we need to use division.
function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: (Ah + Bh + ((l / 2 ** 32) | 0)) | 0, l: l | 0 };
}
// Addition with more than 2 elements
const add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
const add3H = (low, Ah, Bh, Ch) => (Ah + Bh + Ch + ((low / 2 ** 32) | 0)) | 0;
const add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
const add4H = (low, Ah, Bh, Ch, Dh) => (Ah + Bh + Ch + Dh + ((low / 2 ** 32) | 0)) | 0;
const add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
const add5H = (low, Ah, Bh, Ch, Dh, Eh) => (Ah + Bh + Ch + Dh + Eh + ((low / 2 ** 32) | 0)) | 0;
// prettier-ignore

// prettier-ignore
const u64 = {
    fromBig, split, toBig,
    shrSH, shrSL,
    rotrSH, rotrSL, rotrBH, rotrBL,
    rotr32H, rotr32L,
    rotlSH, rotlSL, rotlBH, rotlBL,
    add, add3L, add3H, add4L, add4H, add5H, add5L,
};
/* harmony default export */ const __WEBPACK_DEFAULT_EXPORT__ = (u64);
//# sourceMappingURL=_u64.js.map

/***/ },

/***/ "./node_modules/@noble/hashes/esm/crypto.js"
/*!**************************************************!*\
  !*** ./node_modules/@noble/hashes/esm/crypto.js ***!
  \**************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   crypto: () => (/* binding */ crypto)
/* harmony export */ });
const crypto = typeof globalThis === 'object' && 'crypto' in globalThis ? globalThis.crypto : undefined;
//# sourceMappingURL=crypto.js.map

/***/ },

/***/ "./node_modules/@noble/hashes/esm/sha2.js"
/*!************************************************!*\
  !*** ./node_modules/@noble/hashes/esm/sha2.js ***!
  \************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SHA224: () => (/* binding */ SHA224),
/* harmony export */   SHA256: () => (/* binding */ SHA256),
/* harmony export */   SHA384: () => (/* binding */ SHA384),
/* harmony export */   SHA512: () => (/* binding */ SHA512),
/* harmony export */   SHA512_224: () => (/* binding */ SHA512_224),
/* harmony export */   SHA512_256: () => (/* binding */ SHA512_256),
/* harmony export */   sha224: () => (/* binding */ sha224),
/* harmony export */   sha256: () => (/* binding */ sha256),
/* harmony export */   sha384: () => (/* binding */ sha384),
/* harmony export */   sha512: () => (/* binding */ sha512),
/* harmony export */   sha512_224: () => (/* binding */ sha512_224),
/* harmony export */   sha512_256: () => (/* binding */ sha512_256)
/* harmony export */ });
/* harmony import */ var _md_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./_md.js */ "./node_modules/@noble/hashes/esm/_md.js");
/* harmony import */ var _u64_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./_u64.js */ "./node_modules/@noble/hashes/esm/_u64.js");
/* harmony import */ var _utils_js__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./utils.js */ "./node_modules/@noble/hashes/esm/utils.js");
/**
 * SHA2 hash function. A.k.a. sha256, sha384, sha512, sha512_224, sha512_256.
 * SHA256 is the fastest hash implementable in JS, even faster than Blake3.
 * Check out [RFC 4634](https://datatracker.ietf.org/doc/html/rfc4634) and
 * [FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf).
 * @module
 */



/**
 * Round constants:
 * First 32 bits of fractional parts of the cube roots of the first 64 primes 2..311)
 */
// prettier-ignore
const SHA256_K = /* @__PURE__ */ Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
/** Reusable temporary buffer. "W" comes straight from spec. */
const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
class SHA256 extends _md_js__WEBPACK_IMPORTED_MODULE_0__.HashMD {
    constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        this.A = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[0] | 0;
        this.B = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[1] | 0;
        this.C = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[2] | 0;
        this.D = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[3] | 0;
        this.E = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[4] | 0;
        this.F = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[5] | 0;
        this.G = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[6] | 0;
        this.H = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA256_IV[7] | 0;
    }
    get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 48 words w[16..63] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4)
            SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
            const W15 = SHA256_W[i - 15];
            const W2 = SHA256_W[i - 2];
            const s0 = (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(W15, 7) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(W15, 18) ^ (W15 >>> 3);
            const s1 = (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(W2, 17) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(W2, 19) ^ (W2 >>> 10);
            SHA256_W[i] = (s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16]) | 0;
        }
        // Compression function main loop, 64 rounds
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
            const sigma1 = (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(E, 6) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(E, 11) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(E, 25);
            const T1 = (H + sigma1 + (0,_md_js__WEBPACK_IMPORTED_MODULE_0__.Chi)(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const sigma0 = (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(A, 2) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(A, 13) ^ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.rotr)(A, 22);
            const T2 = (sigma0 + (0,_md_js__WEBPACK_IMPORTED_MODULE_0__.Maj)(A, B, C)) | 0;
            H = G;
            G = F;
            F = E;
            E = (D + T1) | 0;
            D = C;
            C = B;
            B = A;
            A = (T1 + T2) | 0;
        }
        // Add the compressed chunk to the current hash value
        A = (A + this.A) | 0;
        B = (B + this.B) | 0;
        C = (C + this.C) | 0;
        D = (D + this.D) | 0;
        E = (E + this.E) | 0;
        F = (F + this.F) | 0;
        G = (G + this.G) | 0;
        H = (H + this.H) | 0;
        this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
        ;(0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.clean)(SHA256_W);
    }
    destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.clean)(this.buffer);
    }
}
class SHA224 extends SHA256 {
    constructor() {
        super(28);
        this.A = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[0] | 0;
        this.B = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[1] | 0;
        this.C = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[2] | 0;
        this.D = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[3] | 0;
        this.E = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[4] | 0;
        this.F = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[5] | 0;
        this.G = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[6] | 0;
        this.H = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA224_IV[7] | 0;
    }
}
// SHA2-512 is slower than sha256 in js because u64 operations are slow.
// Round contants
// First 32 bits of the fractional parts of the cube roots of the first 80 primes 2..409
// prettier-ignore
const K512 = /* @__PURE__ */ (() => _u64_js__WEBPACK_IMPORTED_MODULE_1__.split([
    '0x428a2f98d728ae22', '0x7137449123ef65cd', '0xb5c0fbcfec4d3b2f', '0xe9b5dba58189dbbc',
    '0x3956c25bf348b538', '0x59f111f1b605d019', '0x923f82a4af194f9b', '0xab1c5ed5da6d8118',
    '0xd807aa98a3030242', '0x12835b0145706fbe', '0x243185be4ee4b28c', '0x550c7dc3d5ffb4e2',
    '0x72be5d74f27b896f', '0x80deb1fe3b1696b1', '0x9bdc06a725c71235', '0xc19bf174cf692694',
    '0xe49b69c19ef14ad2', '0xefbe4786384f25e3', '0x0fc19dc68b8cd5b5', '0x240ca1cc77ac9c65',
    '0x2de92c6f592b0275', '0x4a7484aa6ea6e483', '0x5cb0a9dcbd41fbd4', '0x76f988da831153b5',
    '0x983e5152ee66dfab', '0xa831c66d2db43210', '0xb00327c898fb213f', '0xbf597fc7beef0ee4',
    '0xc6e00bf33da88fc2', '0xd5a79147930aa725', '0x06ca6351e003826f', '0x142929670a0e6e70',
    '0x27b70a8546d22ffc', '0x2e1b21385c26c926', '0x4d2c6dfc5ac42aed', '0x53380d139d95b3df',
    '0x650a73548baf63de', '0x766a0abb3c77b2a8', '0x81c2c92e47edaee6', '0x92722c851482353b',
    '0xa2bfe8a14cf10364', '0xa81a664bbc423001', '0xc24b8b70d0f89791', '0xc76c51a30654be30',
    '0xd192e819d6ef5218', '0xd69906245565a910', '0xf40e35855771202a', '0x106aa07032bbd1b8',
    '0x19a4c116b8d2d0c8', '0x1e376c085141ab53', '0x2748774cdf8eeb99', '0x34b0bcb5e19b48a8',
    '0x391c0cb3c5c95a63', '0x4ed8aa4ae3418acb', '0x5b9cca4f7763e373', '0x682e6ff3d6b2b8a3',
    '0x748f82ee5defb2fc', '0x78a5636f43172f60', '0x84c87814a1f0ab72', '0x8cc702081a6439ec',
    '0x90befffa23631e28', '0xa4506cebde82bde9', '0xbef9a3f7b2c67915', '0xc67178f2e372532b',
    '0xca273eceea26619c', '0xd186b8c721c0c207', '0xeada7dd6cde0eb1e', '0xf57d4f7fee6ed178',
    '0x06f067aa72176fba', '0x0a637dc5a2c898a6', '0x113f9804bef90dae', '0x1b710b35131c471b',
    '0x28db77f523047d84', '0x32caab7b40c72493', '0x3c9ebe0a15c9bebc', '0x431d67c49c100d4c',
    '0x4cc5d4becb3e42b6', '0x597f299cfc657e2a', '0x5fcb6fab3ad6faec', '0x6c44198c4a475817'
].map(n => BigInt(n))))();
const SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
const SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
// Reusable temporary buffers
const SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
const SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
class SHA512 extends _md_js__WEBPACK_IMPORTED_MODULE_0__.HashMD {
    constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        // We cannot use array here since array allows indexing by variable
        // which means optimizer/compiler cannot use registers.
        // h -- high 32 bits, l -- low 32 bits
        this.Ah = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[0] | 0;
        this.Al = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[1] | 0;
        this.Bh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[2] | 0;
        this.Bl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[3] | 0;
        this.Ch = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[4] | 0;
        this.Cl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[5] | 0;
        this.Dh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[6] | 0;
        this.Dl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[7] | 0;
        this.Eh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[8] | 0;
        this.El = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[9] | 0;
        this.Fh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[10] | 0;
        this.Fl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[11] | 0;
        this.Gh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[12] | 0;
        this.Gl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[13] | 0;
        this.Hh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[14] | 0;
        this.Hl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA512_IV[15] | 0;
    }
    // prettier-ignore
    get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
    }
    process(view, offset) {
        // Extend the first 16 words into the remaining 64 words w[16..79] of the message schedule array
        for (let i = 0; i < 16; i++, offset += 4) {
            SHA512_W_H[i] = view.getUint32(offset);
            SHA512_W_L[i] = view.getUint32((offset += 4));
        }
        for (let i = 16; i < 80; i++) {
            // s0 := (w[i-15] rightrotate 1) xor (w[i-15] rightrotate 8) xor (w[i-15] rightshift 7)
            const W15h = SHA512_W_H[i - 15] | 0;
            const W15l = SHA512_W_L[i - 15] | 0;
            const s0h = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(W15h, W15l, 1) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(W15h, W15l, 8) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.shrSH(W15h, W15l, 7);
            const s0l = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(W15h, W15l, 1) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(W15h, W15l, 8) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.shrSL(W15h, W15l, 7);
            // s1 := (w[i-2] rightrotate 19) xor (w[i-2] rightrotate 61) xor (w[i-2] rightshift 6)
            const W2h = SHA512_W_H[i - 2] | 0;
            const W2l = SHA512_W_L[i - 2] | 0;
            const s1h = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(W2h, W2l, 19) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBH(W2h, W2l, 61) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.shrSH(W2h, W2l, 6);
            const s1l = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(W2h, W2l, 19) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBL(W2h, W2l, 61) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.shrSL(W2h, W2l, 6);
            // SHA256_W[i] = s0 + s1 + SHA256_W[i - 7] + SHA256_W[i - 16];
            const SUMl = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
            const SUMh = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
            SHA512_W_H[i] = SUMh | 0;
            SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        // Compression function main loop, 80 rounds
        for (let i = 0; i < 80; i++) {
            // S1 := (e rightrotate 14) xor (e rightrotate 18) xor (e rightrotate 41)
            const sigma1h = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(Eh, El, 14) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(Eh, El, 18) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBH(Eh, El, 41);
            const sigma1l = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(Eh, El, 14) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(Eh, El, 18) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBL(Eh, El, 41);
            //const T1 = (H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i]) | 0;
            const CHIh = (Eh & Fh) ^ (~Eh & Gh);
            const CHIl = (El & Fl) ^ (~El & Gl);
            // T1 = H + sigma1 + Chi(E, F, G) + SHA512_K[i] + SHA512_W[i]
            // prettier-ignore
            const T1ll = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
            const T1h = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
            const T1l = T1ll | 0;
            // S0 := (a rightrotate 28) xor (a rightrotate 34) xor (a rightrotate 39)
            const sigma0h = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSH(Ah, Al, 28) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBH(Ah, Al, 34) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBH(Ah, Al, 39);
            const sigma0l = _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrSL(Ah, Al, 28) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBL(Ah, Al, 34) ^ _u64_js__WEBPACK_IMPORTED_MODULE_1__.rotrBL(Ah, Al, 39);
            const MAJh = (Ah & Bh) ^ (Ah & Ch) ^ (Bh & Ch);
            const MAJl = (Al & Bl) ^ (Al & Cl) ^ (Bl & Cl);
            Hh = Gh | 0;
            Hl = Gl | 0;
            Gh = Fh | 0;
            Gl = Fl | 0;
            Fh = Eh | 0;
            Fl = El | 0;
            ({ h: Eh, l: El } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
            Dh = Ch | 0;
            Dl = Cl | 0;
            Ch = Bh | 0;
            Cl = Bl | 0;
            Bh = Ah | 0;
            Bl = Al | 0;
            const All = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add3L(T1l, sigma0l, MAJl);
            Ah = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add3H(All, T1h, sigma0h, MAJh);
            Al = All | 0;
        }
        // Add the compressed chunk to the current hash value
        ({ h: Ah, l: Al } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = _u64_js__WEBPACK_IMPORTED_MODULE_1__.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
        ;(0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.clean)(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
        ;(0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.clean)(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}
class SHA384 extends SHA512 {
    constructor() {
        super(48);
        this.Ah = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[0] | 0;
        this.Al = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[1] | 0;
        this.Bh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[2] | 0;
        this.Bl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[3] | 0;
        this.Ch = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[4] | 0;
        this.Cl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[5] | 0;
        this.Dh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[6] | 0;
        this.Dl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[7] | 0;
        this.Eh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[8] | 0;
        this.El = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[9] | 0;
        this.Fh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[10] | 0;
        this.Fl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[11] | 0;
        this.Gh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[12] | 0;
        this.Gl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[13] | 0;
        this.Hh = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[14] | 0;
        this.Hl = _md_js__WEBPACK_IMPORTED_MODULE_0__.SHA384_IV[15] | 0;
    }
}
/**
 * Truncated SHA512/256 and SHA512/224.
 * SHA512_IV is XORed with 0xa5a5a5a5a5a5a5a5, then used as "intermediary" IV of SHA512/t.
 * Then t hashes string to produce result IV.
 * See `test/misc/sha2-gen-iv.js`.
 */
/** SHA512/224 IV */
const T224_IV = /* @__PURE__ */ Uint32Array.from([
    0x8c3d37c8, 0x19544da2, 0x73e19966, 0x89dcd4d6, 0x1dfab7ae, 0x32ff9c82, 0x679dd514, 0x582f9fcf,
    0x0f6d2b69, 0x7bd44da8, 0x77e36f73, 0x04c48942, 0x3f9d85a8, 0x6a1d36c8, 0x1112e6ad, 0x91d692a1,
]);
/** SHA512/256 IV */
const T256_IV = /* @__PURE__ */ Uint32Array.from([
    0x22312194, 0xfc2bf72c, 0x9f555fa3, 0xc84c64c2, 0x2393b86b, 0x6f53b151, 0x96387719, 0x5940eabd,
    0x96283ee2, 0xa88effe3, 0xbe5e1e25, 0x53863992, 0x2b0199fc, 0x2c85b8aa, 0x0eb72ddc, 0x81c52ca2,
]);
class SHA512_224 extends SHA512 {
    constructor() {
        super(28);
        this.Ah = T224_IV[0] | 0;
        this.Al = T224_IV[1] | 0;
        this.Bh = T224_IV[2] | 0;
        this.Bl = T224_IV[3] | 0;
        this.Ch = T224_IV[4] | 0;
        this.Cl = T224_IV[5] | 0;
        this.Dh = T224_IV[6] | 0;
        this.Dl = T224_IV[7] | 0;
        this.Eh = T224_IV[8] | 0;
        this.El = T224_IV[9] | 0;
        this.Fh = T224_IV[10] | 0;
        this.Fl = T224_IV[11] | 0;
        this.Gh = T224_IV[12] | 0;
        this.Gl = T224_IV[13] | 0;
        this.Hh = T224_IV[14] | 0;
        this.Hl = T224_IV[15] | 0;
    }
}
class SHA512_256 extends SHA512 {
    constructor() {
        super(32);
        this.Ah = T256_IV[0] | 0;
        this.Al = T256_IV[1] | 0;
        this.Bh = T256_IV[2] | 0;
        this.Bl = T256_IV[3] | 0;
        this.Ch = T256_IV[4] | 0;
        this.Cl = T256_IV[5] | 0;
        this.Dh = T256_IV[6] | 0;
        this.Dl = T256_IV[7] | 0;
        this.Eh = T256_IV[8] | 0;
        this.El = T256_IV[9] | 0;
        this.Fh = T256_IV[10] | 0;
        this.Fl = T256_IV[11] | 0;
        this.Gh = T256_IV[12] | 0;
        this.Gl = T256_IV[13] | 0;
        this.Hh = T256_IV[14] | 0;
        this.Hl = T256_IV[15] | 0;
    }
}
/**
 * SHA2-256 hash function from RFC 4634.
 *
 * It is the fastest JS hash, even faster than Blake3.
 * To break sha256 using birthday attack, attackers need to try 2^128 hashes.
 * BTC network is doing 2^70 hashes/sec (2^95 hashes/year) as per 2025.
 */
const sha256 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA256());
/** SHA2-224 hash function from RFC 4634 */
const sha224 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA224());
/** SHA2-512 hash function from RFC 4634. */
const sha512 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA512());
/** SHA2-384 hash function from RFC 4634. */
const sha384 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA384());
/**
 * SHA2-512/256 "truncated" hash function, with improved resistance to length extension attacks.
 * See the paper on [truncated SHA512](https://eprint.iacr.org/2010/548.pdf).
 */
const sha512_256 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA512_256());
/**
 * SHA2-512/224 "truncated" hash function, with improved resistance to length extension attacks.
 * See the paper on [truncated SHA512](https://eprint.iacr.org/2010/548.pdf).
 */
const sha512_224 = /* @__PURE__ */ (0,_utils_js__WEBPACK_IMPORTED_MODULE_2__.createHasher)(() => new SHA512_224());
//# sourceMappingURL=sha2.js.map

/***/ },

/***/ "./node_modules/@noble/hashes/esm/sha256.js"
/*!**************************************************!*\
  !*** ./node_modules/@noble/hashes/esm/sha256.js ***!
  \**************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   SHA224: () => (/* binding */ SHA224),
/* harmony export */   SHA256: () => (/* binding */ SHA256),
/* harmony export */   sha224: () => (/* binding */ sha224),
/* harmony export */   sha256: () => (/* binding */ sha256)
/* harmony export */ });
/* harmony import */ var _sha2_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./sha2.js */ "./node_modules/@noble/hashes/esm/sha2.js");
/**
 * SHA2-256 a.k.a. sha256. In JS, it is the fastest hash, even faster than Blake3.
 *
 * To break sha256 using birthday attack, attackers need to try 2^128 hashes.
 * BTC network is doing 2^70 hashes/sec (2^95 hashes/year) as per 2025.
 *
 * Check out [FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf).
 * @module
 * @deprecated
 */

/** @deprecated Use import from `noble/hashes/sha2` module */
const SHA256 = _sha2_js__WEBPACK_IMPORTED_MODULE_0__.SHA256;
/** @deprecated Use import from `noble/hashes/sha2` module */
const sha256 = _sha2_js__WEBPACK_IMPORTED_MODULE_0__.sha256;
/** @deprecated Use import from `noble/hashes/sha2` module */
const SHA224 = _sha2_js__WEBPACK_IMPORTED_MODULE_0__.SHA224;
/** @deprecated Use import from `noble/hashes/sha2` module */
const sha224 = _sha2_js__WEBPACK_IMPORTED_MODULE_0__.sha224;
//# sourceMappingURL=sha256.js.map

/***/ },

/***/ "./node_modules/@noble/hashes/esm/utils.js"
/*!*************************************************!*\
  !*** ./node_modules/@noble/hashes/esm/utils.js ***!
  \*************************************************/
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Hash: () => (/* binding */ Hash),
/* harmony export */   abytes: () => (/* binding */ abytes),
/* harmony export */   aexists: () => (/* binding */ aexists),
/* harmony export */   ahash: () => (/* binding */ ahash),
/* harmony export */   anumber: () => (/* binding */ anumber),
/* harmony export */   aoutput: () => (/* binding */ aoutput),
/* harmony export */   asyncLoop: () => (/* binding */ asyncLoop),
/* harmony export */   byteSwap: () => (/* binding */ byteSwap),
/* harmony export */   byteSwap32: () => (/* binding */ byteSwap32),
/* harmony export */   byteSwapIfBE: () => (/* binding */ byteSwapIfBE),
/* harmony export */   bytesToHex: () => (/* binding */ bytesToHex),
/* harmony export */   bytesToUtf8: () => (/* binding */ bytesToUtf8),
/* harmony export */   checkOpts: () => (/* binding */ checkOpts),
/* harmony export */   clean: () => (/* binding */ clean),
/* harmony export */   concatBytes: () => (/* binding */ concatBytes),
/* harmony export */   createHasher: () => (/* binding */ createHasher),
/* harmony export */   createOptHasher: () => (/* binding */ createOptHasher),
/* harmony export */   createView: () => (/* binding */ createView),
/* harmony export */   createXOFer: () => (/* binding */ createXOFer),
/* harmony export */   hexToBytes: () => (/* binding */ hexToBytes),
/* harmony export */   isBytes: () => (/* binding */ isBytes),
/* harmony export */   isLE: () => (/* binding */ isLE),
/* harmony export */   kdfInputToBytes: () => (/* binding */ kdfInputToBytes),
/* harmony export */   nextTick: () => (/* binding */ nextTick),
/* harmony export */   randomBytes: () => (/* binding */ randomBytes),
/* harmony export */   rotl: () => (/* binding */ rotl),
/* harmony export */   rotr: () => (/* binding */ rotr),
/* harmony export */   swap32IfBE: () => (/* binding */ swap32IfBE),
/* harmony export */   swap8IfBE: () => (/* binding */ swap8IfBE),
/* harmony export */   toBytes: () => (/* binding */ toBytes),
/* harmony export */   u32: () => (/* binding */ u32),
/* harmony export */   u8: () => (/* binding */ u8),
/* harmony export */   utf8ToBytes: () => (/* binding */ utf8ToBytes),
/* harmony export */   wrapConstructor: () => (/* binding */ wrapConstructor),
/* harmony export */   wrapConstructorWithOpts: () => (/* binding */ wrapConstructorWithOpts),
/* harmony export */   wrapXOFConstructorWithOpts: () => (/* binding */ wrapXOFConstructorWithOpts)
/* harmony export */ });
/* harmony import */ var _noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! @noble/hashes/crypto */ "./node_modules/@noble/hashes/esm/crypto.js");
/**
 * Utilities for hex, bytes, CSPRNG.
 * @module
 */
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// We use WebCrypto aka globalThis.crypto, which exists in browsers and node.js 16+.
// node.js versions earlier than v19 don't declare it in global scope.
// For node.js, package.json#exports field mapping rewrites import
// from `crypto` to `cryptoNode`, which imports native module.
// Makes the utils un-importable in browsers without a bundler.
// Once node.js 18 is deprecated (2025-04-30), we can just drop the import.

/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes(a) {
    return a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
}
/** Asserts something is positive integer. */
function anumber(n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('positive integer expected, got ' + n);
}
/** Asserts something is Uint8Array. */
function abytes(b, ...lengths) {
    if (!isBytes(b))
        throw new Error('Uint8Array expected');
    if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error('Uint8Array expected of length ' + lengths + ', got length=' + b.length);
}
/** Asserts something is hash */
function ahash(h) {
    if (typeof h !== 'function' || typeof h.create !== 'function')
        throw new Error('Hash should be wrapped by utils.createHasher');
    anumber(h.outputLen);
    anumber(h.blockLen);
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
        throw new Error('Hash instance has been destroyed');
    if (checkFinished && instance.finished)
        throw new Error('Hash#digest() has already been called');
}
/** Asserts output is properly-sized byte array */
function aoutput(out, instance) {
    abytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
        throw new Error('digestInto() expects output buffer of length at least ' + min);
    }
}
/** Cast u8 / u16 / u32 to u8. */
function u8(arr) {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** Cast u8 / u16 / u32 to u32. */
function u32(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
        arrays[i].fill(0);
    }
}
/** Create DataView of an array for easy byte-level manipulation. */
function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** The rotate right (circular right shift) operation for uint32 */
function rotr(word, shift) {
    return (word << (32 - shift)) | (word >>> shift);
}
/** The rotate left (circular left shift) operation for uint32 */
function rotl(word, shift) {
    return (word << shift) | ((word >>> (32 - shift)) >>> 0);
}
/** Is current platform little-endian? Most are. Big-Endian platform: IBM */
const isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44)();
/** The byte swap operation for uint32 */
function byteSwap(word) {
    return (((word << 24) & 0xff000000) |
        ((word << 8) & 0xff0000) |
        ((word >>> 8) & 0xff00) |
        ((word >>> 24) & 0xff));
}
/** Conditionally byte swap if on a big-endian platform */
const swap8IfBE = isLE
    ? (n) => n
    : (n) => byteSwap(n);
/** @deprecated */
const byteSwapIfBE = swap8IfBE;
/** In place byte swap for Uint32Array */
function byteSwap32(arr) {
    for (let i = 0; i < arr.length; i++) {
        arr[i] = byteSwap(arr[i]);
    }
    return arr;
}
const swap32IfBE = isLE
    ? (u) => u
    : byteSwap32;
// Built-in hex conversion https://caniuse.com/mdn-javascript_builtins_uint8array_fromhex
const hasHexBuiltin = /* @__PURE__ */ (() => 
// @ts-ignore
typeof Uint8Array.from([]).toHex === 'function' && typeof Uint8Array.fromHex === 'function')();
// Array where index 0xf0 (240) is mapped to string 'f0'
const hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/**
 * Convert byte array to hex string. Uses built-in function, when available.
 * @example bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])) // 'cafe0123'
 */
function bytesToHex(bytes) {
    abytes(bytes);
    // @ts-ignore
    if (hasHexBuiltin)
        return bytes.toHex();
    // pre-caching improves the speed 6x
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += hexes[bytes[i]];
    }
    return hex;
}
// We use optimized technique to convert hex string to byte array
const asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
        return ch - asciis._0; // '2' => 50-48
    if (ch >= asciis.A && ch <= asciis.F)
        return ch - (asciis.A - 10); // 'B' => 66-(65-10)
    if (ch >= asciis.a && ch <= asciis.f)
        return ch - (asciis.a - 10); // 'b' => 98-(97-10)
    return;
}
/**
 * Convert hex string to byte array. Uses built-in function, when available.
 * @example hexToBytes('cafe0123') // Uint8Array.from([0xca, 0xfe, 0x01, 0x23])
 */
function hexToBytes(hex) {
    if (typeof hex !== 'string')
        throw new Error('hex string expected, got ' + typeof hex);
    // @ts-ignore
    if (hasHexBuiltin)
        return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
        throw new Error('hex string expected, got unpadded hex of length ' + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
        const n1 = asciiToBase16(hex.charCodeAt(hi));
        const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
        if (n1 === undefined || n2 === undefined) {
            const char = hex[hi] + hex[hi + 1];
            throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
        }
        array[ai] = n1 * 16 + n2; // multiply first octet, e.g. 'a3' => 10*16+3 => 160 + 3 => 163
    }
    return array;
}
/**
 * There is no setImmediate in browser and setTimeout is slow.
 * Call of async fn will return Promise, which will be fullfiled only on
 * next scheduler queue processing step and this is exactly what we need.
 */
const nextTick = async () => { };
/** Returns control to thread each 'tick' ms to avoid blocking. */
async function asyncLoop(iters, tick, cb) {
    let ts = Date.now();
    for (let i = 0; i < iters; i++) {
        cb(i);
        // Date.now() is not monotonic, so in case if clock goes backwards we return return control too
        const diff = Date.now() - ts;
        if (diff >= 0 && diff < tick)
            continue;
        await nextTick();
        ts += diff;
    }
}
/**
 * Converts string to bytes using UTF8 encoding.
 * @example utf8ToBytes('abc') // Uint8Array.from([97, 98, 99])
 */
function utf8ToBytes(str) {
    if (typeof str !== 'string')
        throw new Error('string expected');
    return new Uint8Array(new TextEncoder().encode(str)); // https://bugzil.la/1681809
}
/**
 * Converts bytes to string using UTF8 encoding.
 * @example bytesToUtf8(Uint8Array.from([97, 98, 99])) // 'abc'
 */
function bytesToUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}
/**
 * Normalizes (non-hex) string or Uint8Array to Uint8Array.
 * Warning: when Uint8Array is passed, it would NOT get copied.
 * Keep in mind for future mutable operations.
 */
function toBytes(data) {
    if (typeof data === 'string')
        data = utf8ToBytes(data);
    abytes(data);
    return data;
}
/**
 * Helper for KDFs: consumes uint8array or string.
 * When string is passed, does utf8 decoding, using TextDecoder.
 */
function kdfInputToBytes(data) {
    if (typeof data === 'string')
        data = utf8ToBytes(data);
    abytes(data);
    return data;
}
/** Copies several Uint8Arrays into one. */
function concatBytes(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        abytes(a);
        sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
        const a = arrays[i];
        res.set(a, pad);
        pad += a.length;
    }
    return res;
}
function checkOpts(defaults, opts) {
    if (opts !== undefined && {}.toString.call(opts) !== '[object Object]')
        throw new Error('options should be object or undefined');
    const merged = Object.assign(defaults, opts);
    return merged;
}
/** For runtime check if class implements interface */
class Hash {
}
/** Wraps hash function, creating an interface on top of it */
function createHasher(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
}
function createOptHasher(hashCons) {
    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    const tmp = hashCons({});
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (opts) => hashCons(opts);
    return hashC;
}
function createXOFer(hashCons) {
    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    const tmp = hashCons({});
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (opts) => hashCons(opts);
    return hashC;
}
const wrapConstructor = createHasher;
const wrapConstructorWithOpts = createOptHasher;
const wrapXOFConstructorWithOpts = createXOFer;
/** Cryptographically secure PRNG. Uses internal OS-level `crypto.getRandomValues`. */
function randomBytes(bytesLength = 32) {
    if (_noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto && typeof _noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto.getRandomValues === 'function') {
        return _noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto.getRandomValues(new Uint8Array(bytesLength));
    }
    // Legacy Node.js compatibility
    if (_noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto && typeof _noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto.randomBytes === 'function') {
        return Uint8Array.from(_noble_hashes_crypto__WEBPACK_IMPORTED_MODULE_0__.crypto.randomBytes(bytesLength));
    }
    throw new Error('crypto.getRandomValues must be defined');
}
//# sourceMappingURL=utils.js.map

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	// define getter/value functions for harmony exports
/******/ 	__webpack_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop));
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = (exports) => {
/******/ 		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ 	
/************************************************************************/
let __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*!******************************!*\
  !*** ./src/ts/background.ts ***!
  \******************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _TotalDownload__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./TotalDownload */ "./src/ts/TotalDownload.ts");
/* harmony import */ var _eagle_Eagle__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./eagle/Eagle */ "./src/ts/eagle/Eagle.ts");
/* harmony import */ var _auto_AutoScheduler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./auto/AutoScheduler */ "./src/ts/auto/AutoScheduler.ts");
/* harmony import */ var _queue_Runtime__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./queue/Runtime */ "./src/ts/queue/Runtime.ts");




// 当点击扩展图标时，显示/隐藏下载面板
chrome.action.onClicked.addListener(function (tab) {
    // 在本程序没有权限的页面上点击扩展图标时，url 始终是 undefined，此时不发送消息
    if (!tab.url) {
        return;
    }
    chrome.tabs.sendMessage(tab.id, {
        msg: 'click_icon',
    });
});
// 当扩展被安装、被更新、或者浏览器升级时，初始化数据
chrome.runtime.onInstalled.addListener((details) => {
    chrome.storage.local.set({ dlData: {}, batchNo: {} });
});
/**存储每个下载任务的数据。
 *
 * 因为下载完成的顺序和前台发送的顺序可能不一致，所以需要把数据保存起来以供查询 */
let dlData = {};
/**使用每个页面的 tabId 作为索引，储存当前下载任务的批次编号（在该页面里）。用来判断不同批次的下载 */
let batchNo = {};
const fileNameList = new Map();
// 接收下载请求
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.msg === 'check_eagle') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            sendResponse({ error: 'Eagle check requires a browser tab' });
            return false;
        }
        _eagle_Eagle__WEBPACK_IMPORTED_MODULE_1__.eagle
            .hasExisting(msg.fileName, `${tabId}:${msg.taskBatch}`)
            .then((exists) => sendResponse({ exists }))
            .catch((error) => sendResponse({
            error: error instanceof Error ? error.message : String(error),
        }));
        return true;
    }
    if (msg.msg === 'queue_downloaded') {
        if (sender.tab?.id !== undefined)
            chrome.tabs.sendMessage(sender.tab.id, {
                msg: 'downloaded',
                data: { ...msg.data, tabId: sender.tab.id },
            });
        return false;
    }
    void handleDownloadMessage(msg, sender);
    return false;
});
async function handleDownloadMessage(msg, sender) {
    if (msg.msg === 'add_to_eagle' || msg.msg === 'eagle_error') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return false;
        }
        const data = {
            url: msg.fileUrl,
            id: msg.id,
            tabId,
            uuid: false,
            size: -1,
            source: 'eagle',
            recordKey: msg.recordKey,
        };
        if (msg.msg === 'eagle_error') {
            chrome.tabs.sendMessage(tabId, {
                msg: 'eagle_error',
                data,
                err: msg.error || 'Unable to prepare the file for Eagle',
            });
            return false;
        }
        try {
            if (!msg.website) {
                throw new Error('The FANBOX post URL is missing');
            }
            throw new Error('Legacy immediate Eagle import disabled; reload this tab to use the durable queue');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            chrome.tabs.sendMessage(tabId, {
                msg: 'eagle_error',
                data,
                err: message,
            });
        }
        return false;
    }
    // 接收下载任务
    if (msg.msg === 'send_download') {
        // 当处于初始状态时，或者变量被回收了，就从存储中读取数据储存在变量中
        // 之后每当要使用这两个数据时，从变量读取，而不是从存储中获得。这样就解决了数据不同步的问题，而且性能更高
        if (Object.keys(batchNo).length === 0) {
            const data = await chrome.storage.local.get(['batchNo', 'dlData']);
            batchNo = data.batchNo || {};
            dlData = data.dlData || {};
        }
        const tabId = sender.tab.id;
        // 如果开始了新一批的下载，重设批次编号，清空下载索引
        if (batchNo[tabId] !== msg.taskBatch) {
            batchNo[tabId] = msg.taskBatch;
            chrome.storage.local.set({ batchNo });
        }
        fileNameList.set(msg.fileUrl, msg.fileName);
        // 开始下载
        chrome.downloads.download({
            url: msg.fileUrl,
            filename: msg.fileName,
            conflictAction: msg.conflictAction || 'uniquify',
            saveAs: false,
        }, (id) => {
            // id 是 Chrome 新建立的下载任务的 id
            dlData[id] = {
                url: msg.fileUrl,
                id: msg.id,
                tabId: tabId,
                uuid: false,
                size: -1,
            };
            chrome.storage.local.set({ dlData });
        });
        return false;
    }
    else if (msg.msg === 'save_file_no_replay') {
        // 保存不需要返回下载状态的文件
        chrome.downloads.download({
            url: msg.fileUrl,
            filename: msg.fileName,
            conflictAction: 'overwrite',
            saveAs: false,
        });
    }
}
// 判断文件名是否变成了 UUID 格式。因为文件名处于整个绝对路径的中间，所以没加首尾标记 ^ $
const UUIDRegexp = /[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/;
// 监听下载事件
// 每个下载会触发两次 onChanged 事件
chrome.downloads.onChanged.addListener(async function (detail) {
    // 根据 detail.id 取出保存的数据
    // 如果有数据，就是本扩展建立的下载，所以不会监听到非本扩展建立的下载
    let data = dlData[detail.id];
    if (!data) {
        const getData = await chrome.storage.local.get(['dlData']);
        dlData = getData.dlData || {};
        data = dlData[detail.id];
    }
    if (data) {
        let msg = '';
        let err = '';
        // 判断当前文件名是否正常。下载时必定会有一次 detail.filename.current 有值
        if (detail.filename && detail.filename.current) {
            const changedName = detail.filename.current;
            // 文件名是 UUID
            if (changedName.match(UUIDRegexp) !== null) {
                data.uuid = true;
            }
            // 检查文件名是 URL 里最后一段的情况
            // Fanbox 下载器的多数文件是直接把原 URL 发送给浏览器下载的，因此很多时候即使受到其他扩展程序的影响，也不会是 UUID，而是原文件名，例如：
            // https://pixiv.pximg.net/c/1200x630_90_a2_g5/fanbox/public/images/post/10264356/cover/cvfFotXy5Cbc2I0uakDXHG0s.jpeg
            // 受到影响时，上面的图片保存后是原文件名：
            // cvfFotXy5Cbc2I0uakDXHG0s.jpeg
            // 此时的 detail 示例：
            // const detailExample = {
            //   "filename": {
            //      current 在 windows 上可能是这样的：
            //     "current": "C:\\download\\cvfFotXy5Cbc2I0uakDXHG0s (6).jpeg",
            //      current 在 Linux 上可能是这样的：
            //     "current": "/home/username/Downloads/cvfFotXy5Cbc2I0uakDXHG0s (6).jpeg",
            //     "previous": ""
            //   },
            //   "id": 1347
            // }
            // fileNameList 里储存的预期的文件名示例：
            // fanbox/omutatsu／おむたつ/2025-07-22-🔞7月22日🔞/0.jpeg
            const expectedName = fileNameList.get(data.url);
            if (expectedName) {
                // 取出预期的文件名的最后一部分，上面的文件名的结果是 "0"
                const name = expectedName.split('/').pop()?.split('.')[0] || '';
                // 取出实际的文件名的最后一部分（注意，即使是与预期一致的文件名，实际上也可能有序号）
                let name2 = '';
                if (changedName.includes('\\')) {
                    name2 = changedName.split('\\').pop()?.split('.')[0] || '';
                }
                else {
                    name2 = changedName.split('/').pop()?.split('.')[0] || '';
                }
                // 如果实际文件名不是以预期的文件名开头，则说明文件名异常
                if (name2 && name2.startsWith(name) === false) {
                    data.uuid = true;
                }
            }
        }
        if (detail.state && detail.state.current === 'complete') {
            msg = 'downloaded';
            // 下载完成后，查询下载项的体积
            // 查询花费的时间：在下载记录不是很多的情况下，查询耗时多为 2 - 5 ms
            chrome.downloads.search({ id: detail.id }, (results) => {
                if (results && results.length > 0) {
                    const downloadItem = results[0];
                    const fileSize = downloadItem.fileSize; // 文件大小（字节）
                    if (fileSize !== -1) {
                        data.size = fileSize;
                        _TotalDownload__WEBPACK_IMPORTED_MODULE_0__.totalDownload.addDownload(fileSize);
                        // console.log(`文件下载完成，大小: ${fileSize} 字节`)
                    }
                    else {
                        // console.log("文件下载完成，但大小未知")
                    }
                }
                else {
                    // console.error("未找到下载项")
                }
            });
        }
        if (detail.error && detail.error.current) {
            // 下载被取消或者失败时，这里是能捕获到错误的，detail.error.current 包含错误类型：
            // 取消 USER_CANCELED
            // 失败 NETWORK_FAILED
            msg = 'download_err';
            err = detail.error.current;
        }
        // 返回信息
        if (msg) {
            chrome.tabs.sendMessage(data.tabId, { msg, data, err });
            // 清除这个任务的数据
            dlData[detail.id] = null;
            chrome.storage.local.set({ dlData });
        }
    }
});

})();

/******/ })()
;
//# sourceMappingURL=background.js.map