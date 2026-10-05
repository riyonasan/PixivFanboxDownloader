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
const restrictedRetryMs = 24 * 60 * 60 * 1000;
let checking = false;
let starting = false;
let startAgain = false;
// Serialize storage read/modify/write operations from scans, results and the UI.
let stateUpdate = Promise.resolve();
function updateAutoState(update) {
    const result = stateUpdate.then(update);
    stateUpdate = result.catch(() => { });
    return result;
}
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
                await updateAutoState(async () => {
                    const latest = await chrome.storage.local.get([
                        _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
                        _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
                    ]);
                    const currentProfiles = (latest[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] ||
                        []);
                    const current = currentProfiles.find((item) => item.creatorId === profile.creatorId);
                    // Settings may have changed while the request was in flight. Scan
                    // again with those settings without advancing the old cursor.
                    if (!current ||
                        current.since !== profile.since ||
                        current.free !== profile.free ||
                        current.pay !== profile.pay ||
                        current.minFee !== profile.minFee ||
                        current.maxFee !== profile.maxFee)
                        return;
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
        await updateAutoState(async () => {
            const previousStatus = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey);
            await chrome.storage.local.set({
                [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey]: {
                    ...previousStatus[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoStatusKey],
                    lastError: scanError,
                },
            });
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
    const { remaining, settings } = await updateAutoState(async () => {
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
        return { remaining, settings: stored.fanboxSetting };
    });
    const task = remaining.find((item) => !item.retryAfter || item.retryAfter <= Date.now());
    if (!task)
        return;
    const currentSettings = settings;
    if (currentSettings?.saveToEagle) {
        try {
            await request('http://localhost:41595/api/application/info');
        }
        catch {
            console.warn('Automatic FANBOX import is waiting for Eagle');
            return;
        }
    }
    // Eagle can take time to respond. Recheck saved settings before opening
    // a post, so disabling paid posts while waiting takes effect immediately.
    const next = await updateAutoState(async () => {
        const latest = await chrome.storage.local.get([
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
        ]);
        const profile = (latest[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] || []).find((item) => item.creatorId === task.creatorId);
        const current = (latest[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []).find((item) => item.postId === task.postId);
        if (!profile ||
            !current ||
            !(0,_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.matchesAutoFee)(profile, current.fee) ||
            (current.retryAfter && current.retryAfter > Date.now())) {
            startAgain = true;
            return;
        }
        const tab = await chrome.tabs.create({
            url: `https://www.fanbox.cc/@${encodeURIComponent(current.creatorId)}/posts/${encodeURIComponent(current.postId)}`,
            active: false,
        });
        if (tab.id === undefined)
            throw new Error('Automatic post tab has no ID');
        const active = {
            tabId: tab.id,
            task: current,
            startedAt: Date.now(),
        };
        await chrome.storage.local.set({ [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey]: active });
        return { active, profile };
    });
    if (!next)
        return;
    const { active, profile } = next;
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
    const active = await updateAutoState(async () => {
        const active = await getActive();
        if (!active ||
            active.task.creatorId !== message.creatorId ||
            active.task.postId !== message.postId ||
            active.startedAt !== message.startedAt)
            return;
        const stored = await chrome.storage.local.get(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey);
        const pending = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []);
        await chrome.storage.local.set({
            [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: message.success && !message.skipped
                ? pending.filter((item) => item.postId !== message.postId)
                : pending.map((item) => item.postId === message.postId
                    ? {
                        ...item,
                        restricted: !!message.skipped,
                        retryAfter: Date.now() +
                            (message.skipped ? restrictedRetryMs : 60 * 60 * 1000),
                    }
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
                        ? { lastCompletedAt: Date.now(), lastError: '' }
                        : {
                            lastError: `${message.creatorId}: 取り込みに失敗しました。次回再試行します。`,
                        }),
            },
        });
        await chrome.storage.local.remove(_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey);
        return active;
    });
    if (!active)
        return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await chrome.tabs.remove(active.tabId).catch(() => { });
    if (!message.skipped) {
        await (0,_Ntfy__WEBPACK_IMPORTED_MODULE_1__.notifyAutoPost)(active.task, message.success, message).catch((error) => console.warn('Automatic FANBOX notification failed', error));
    }
    void startNextPost().catch((error) => console.error('Automatic FANBOX import failed', error));
}
async function retryRestrictedPosts(creatorId) {
    const count = await updateAutoState(async () => {
        const stored = await chrome.storage.local.get([
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey,
        ]);
        const profiles = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] || []);
        const profile = profiles.find((item) => item.creatorId === creatorId);
        const active = stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoActiveKey];
        let count = 0;
        const pending = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []).map((item) => {
            if (item.creatorId === creatorId &&
                item.restricted &&
                profile &&
                (0,_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.matchesAutoFee)(profile, item.fee) &&
                active?.task.postId !== item.postId) {
                count++;
                return { ...item, retryAfter: 0 };
            }
            return item;
        });
        await chrome.storage.local.set({ [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: pending });
        return count;
    });
    void startNextPost().catch((error) => console.error('Automatic FANBOX retry failed', error));
    return count;
}
async function saveProfiles(profiles) {
    return updateAutoState(async () => {
        const stored = await chrome.storage.local.get([
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey,
            _AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey,
        ]);
        const previous = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey] || []);
        const next = profiles.map((profile) => ({
            ...profile,
            since: previous.find((item) => item.creatorId === profile.creatorId)?.since ??
                Date.now(),
        }));
        const pending = (stored[_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey] || []).filter((item) => {
            const profile = next.find((value) => value.creatorId === item.creatorId);
            return profile && (0,_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.matchesAutoFee)(profile, item.fee);
        });
        await chrome.storage.local.set({
            [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoProfilesKey]: next,
            [_AutoTypes__WEBPACK_IMPORTED_MODULE_0__.autoPendingKey]: pending,
        });
        return next;
    });
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.msg === 'auto_result') {
        void finishPost(message).catch((error) => console.error('Automatic FANBOX result could not be saved', error));
    }
    else if (message.msg === 'auto_check_now') {
        void runAutoCheck();
    }
    else if (message.msg === 'auto_retry_restricted' &&
        typeof message.creatorId === 'string') {
        void retryRestrictedPosts(message.creatorId)
            .then((count) => sendResponse({ count }))
            .catch((error) => sendResponse({ error: String(error) }));
        return true;
    }
    else if (message.msg === 'auto_save_profiles' &&
        Array.isArray(message.profiles)) {
        void saveProfiles(message.profiles)
            .then((profiles) => sendResponse({ profiles }))
            .catch((error) => sendResponse({ error: String(error) }));
        return true;
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
    configuredURL ??= fetch(chrome.runtime.getURL('ntfy-config.json'))
        .then(async (response) => {
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
            ? `${details.creatorName}\n${details.postTitle}\n${postURL}`
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
    async addFromURL(url, fileName, website, scope) {
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
            await _eagle_Eagle__WEBPACK_IMPORTED_MODULE_1__.eagle.addFromURL(msg.fileUrl, msg.fileName, msg.website, `${tabId}:${msg.taskBatch}`);
            chrome.tabs.sendMessage(tabId, { msg: 'downloaded', data });
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