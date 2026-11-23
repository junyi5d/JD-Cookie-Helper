// ==UserScript==
// @name         京东Cookie助手
// @namespace    http://tampermonkey.net/
// @version      1.3.3
// @description  京东Cookie助手 - 搭配篡改猴自动获取CK，一键同步到青龙面板，减少手工抓取pt_key、pt_pin的烦恼
// @author       JD Helper、junyi5d
// @match        https://jd.com/*
// @match        https://*.jd.com/*
// @match        https://jd.hk/*
// @match        https://*.jd.hk/*
// @icon         data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🍑</text></svg>
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_cookie
// @connect      jd.com
// @run-at       document-idle
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/junyi5d/JD-Cookie-Helper/main/JD-Cookie-Helper.user.js
// @downloadURL  https://raw.githubusercontent.com/junyi5d/JD-Cookie-Helper/main/JD-Cookie-Helper.user.js
// ==/UserScript==

// ============ 全局版本常量 ============
// 说明：此处为脚本唯一版本来源，@version 元数据需同步修改；
// 控制台日志与设置面板的版本号均引用该常量。
const CURRENT_VERSION = '1.3.3';

(function () {
    'use strict';

    // ============ 配置区域 ============
    const CONFIG = {
        // 青龙面板配置（首次使用时请在界面填写）
        QINGLONG_URL: '',       // 青龙面板地址，如 http://localhost:5700
        QINGLONG_USERNAME: '',  // 青龙用户名
        QINGLONG_PASSWORD: '',  // 青龙密码

        // 自动发送模式
        AUTO_SEND: false,       // true: 自动发送, false: 手动点击发送

        // 显示设置
        SHOW_NOTIFICATION: true, // 显示桌面通知
        LOG_DETAILS: false       // 控制台输出详细信息
    };

    // 京东 Cookie 可能存在的域名（pt_key / pt_pin 通常挂在 .jd.com 上）
    const COOKIE_QUERIES = [
        { domain: '.jd.com' },
        { domain: 'jd.com' },
        { url: 'https://m.jd.com/' },
        { url: 'https://www.jd.com/' },
        { url: 'https://home.m.jd.com/' },
        { url: 'https://my.m.jd.com/' },
        { url: 'https://passport.jd.com/' },
        { domain: '.jd.hk' }
    ];

    const ICON = {
        success: '✅',
        error: '❌',
        warning: '⚠️'
    };

    // 更新地址（版本号见文件顶部全局常量 CURRENT_VERSION）
    const UPDATE_URL = 'https://raw.githubusercontent.com/junyi5d/JD-Cookie-Helper/main/JD-Cookie-Helper.user.js';
    const PROJECT_URL = 'https://github.com/junyi5d/JD-Cookie-Helper';

    // ============ Cookie 读取工具 ============

    // 不同脚本管理器的 GM_cookie 形态不同：
    // - Tampermonkey: GM_cookie.list(details, callback)
    // - Violentmonkey: GM.cookie.list(details) => Promise / GM_cookie.list(details) => Promise
    // - ScriptCat: GM_cookie('list', details, callback)
    function hasCookieAPI() {
        try {
            if (typeof GM_cookie !== 'undefined' && GM_cookie) {
                if (typeof GM_cookie.list === 'function' || typeof GM_cookie === 'function') {
                    return true;
                }
            }
            if (typeof GM !== 'undefined' && GM && GM.cookie && typeof GM.cookie.list === 'function') {
                return true;
            }
        } catch (e) {
            // ignore
        }
        return false;
    }

    // 统一成 Promise，超时兜底，避免某个管理器不回调导致界面卡死
    function queryCookies(details) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (cookies, error) => {
                if (settled) return;
                settled = true;
                resolve({
                    cookies: Array.isArray(cookies) ? cookies : [],
                    error: error || null
                });
            };
            const timer = setTimeout(() => finish([], new Error('GM_cookie 调用超时')), 3000);

            try {
                if (typeof GM_cookie !== 'undefined' && GM_cookie) {
                    // Tampermonkey 标准写法
                    if (typeof GM_cookie.list === 'function') {
                        const ret = GM_cookie.list(details, (cookies, error) => {
                            clearTimeout(timer);
                            finish(cookies, error);
                        });
                        if (ret && typeof ret.then === 'function') {
                            ret.then((cookies) => { clearTimeout(timer); finish(cookies); })
                                .catch((e) => { clearTimeout(timer); finish([], e); });
                        }
                        return;
                    }
                    // ScriptCat 写法
                    if (typeof GM_cookie === 'function') {
                        const ret = GM_cookie('list', details, (cookies, error) => {
                            clearTimeout(timer);
                            finish(cookies, error);
                        });
                        if (ret && typeof ret.then === 'function') {
                            ret.then((cookies) => { clearTimeout(timer); finish(cookies); })
                                .catch((e) => { clearTimeout(timer); finish([], e); });
                        }
                        return;
                    }
                }
                // Violentmonkey / 新版 Tampermonkey
                if (typeof GM !== 'undefined' && GM && GM.cookie && typeof GM.cookie.list === 'function') {
                    GM.cookie.list(details)
                        .then((cookies) => { clearTimeout(timer); finish(cookies); })
                        .catch((e) => { clearTimeout(timer); finish([], e); });
                    return;
                }
                clearTimeout(timer);
                finish([], new Error('当前脚本管理器不支持 GM_cookie'));
            } catch (e) {
                clearTimeout(timer);
                finish([], e);
            }
        });
    }

    // 解析 document.cookie（无法读取 HttpOnly，仅作兜底）
    function parseCookieString(str) {
        const map = {};
        if (!str) return map;
        str.split(';').forEach((segment) => {
            const index = segment.indexOf('=');
            if (index > 0) {
                const key = segment.slice(0, index).trim();
                const value = segment.slice(index + 1).trim();
                if (key) map[key] = value;
            }
        });
        return map;
    }

    function safeDecode(value) {
        try {
            return decodeURIComponent(value);
        } catch (e) {
            return value;
        }
    }

    /**
     * 汇总京东所有相关域名下的 Cookie
     * @returns {Promise<{cookieMap: Object, storeSupported: boolean, storeReadable: boolean}>}
     */
    async function collectCookieMap() {
        const cookieMap = {};
        const storeSupported = hasCookieAPI();
        let storeReadable = false;

        if (storeSupported) {
            const results = await Promise.all(COOKIE_QUERIES.map((query) => queryCookies(query)));
            results.forEach(({ cookies }) => {
                if (cookies.length) storeReadable = true;
                cookies.forEach((cookie) => {
                    // 同名 Cookie 保留先取到的（域越具体越优先由查询顺序保证）
                    if (cookie && cookie.name && cookieMap[cookie.name] === undefined) {
                        cookieMap[cookie.name] = cookie.value;
                    }
                });
            });
        }

        // document.cookie 兜底：能读到 pt_key 时说明未被 HttpOnly 限制
        const docCookies = parseCookieString(document.cookie);
        Object.keys(docCookies).forEach((name) => {
            if (cookieMap[name] === undefined) {
                cookieMap[name] = docCookies[name];
            }
        });

        if (CONFIG.LOG_DETAILS) {
            console.log('【京东Cookie助手】读取到的 Cookie:', cookieMap);
        }

        return { cookieMap, storeSupported, storeReadable };
    }

    // ============ Cookie 处理工具 ============
    function normalizeQinglongUrl(url) {
        let result = (url || '').trim().replace(/\/+$/, '');
        if (!result) return '';
        if (!/^https?:\/\//i.test(result)) {
            result = 'http://' + result;
        }
        return result;
    }

    /**
     * 注入样式：优先用 GM_addStyle，同时再插入一个原生 <style> 兜底。
     * 只调用 GM_addStyle 会导致整段样式丢失，界面变成未美化的原始 DOM。
     */
    function addStyle(css) {
        try {
            if (typeof GM_addStyle === 'function') {
                GM_addStyle(css);
            }
        } catch (e) {
            // ignore
        }
        try {
            const style = document.createElement('style');
            style.type = 'text/css';
            style.appendChild(document.createTextNode(css));
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {
            // ignore
        }
    }

    // 存储读写：脚本管理器 API 不可用时退回 localStorage
    function getStored(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key, fallback);
                if (value !== undefined) return value;
            }
        } catch (e) {
            // ignore
        }
        try {
            const raw = window.localStorage.getItem('jdch_' + key);
            if (raw !== null) return raw;
        } catch (e) {
            // ignore
        }
        return fallback;
    }

    function setStored(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
                return;
            }
        } catch (e) {
            // ignore
        }
        try {
            window.localStorage.setItem('jdch_' + key, String(value));
        } catch (e) {
            // ignore
        }
    }

    // ============ 主程序 ============
    class JDCookieHelper {
        constructor() {
            this.cookieData = null;      // { pt_key, pt_pin, pt_pin_decoded }
            this.cookieString = '';      // pt_key=xxx; pt_pin=yyy;
            this.init();
        }

        init() {
            if (!document.body) {
                document.addEventListener('DOMContentLoaded', () => this.init());
                return;
            }
            this.createUI();
            this.bindEvents();

            // 先应用消息通知开关状态，避免未打开面板时仍按默认值发送通知
            const notifyEnabled = getStored('notify_enabled', CONFIG.SHOW_NOTIFICATION);
            this.setNotifyEnabled(notifyEnabled === true || notifyEnabled === 'true');

            this.autoExtractCookie();
        }

        // 创建浮动按钮
        createUI() {
            // 添加样式
            addStyle(`
                .jd-cookie-helper-btn {
                    position: fixed;
                    top: 100px;
                    right: 20px;
                    width: 50px;
                    height: 50px;
                    background: linear-gradient(135deg, #e2231a 0%, #ff6b6b 100%);
                    border: none;
                    border-radius: 50%;
                    color: white;
                    font-size: 24px;
                    cursor: pointer;
                    z-index: 999999;
                    box-shadow: 0 4px 15px rgba(226, 35, 26, 0.4);
                    transition: all 0.3s ease;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .jd-cookie-helper-btn:hover {
                    transform: scale(1.1);
                    box-shadow: 0 6px 20px rgba(226, 35, 26, 0.6);
                }
                .jd-cookie-helper-btn.sending {
                    animation: pulse 1s infinite;
                }
                @keyframes pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.1); }
                }
                .jd-cookie-panel {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 15px;
                    padding: 25px;
                    width: 450px;
                    max-width: 90vw;
                    max-height: 90vh;
                    overflow-y: auto;
                    box-sizing: border-box;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    z-index: 1000000;
                    display: none;
                }
                .jd-cookie-panel.show {
                    display: block;
                    animation: fadeIn 0.3s ease;
                }
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                .jd-cookie-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 999998;
                    display: none;
                }
                .jd-cookie-overlay.show {
                    display: block;
                }
                .jd-cookie-panel h3 {
                    margin: 0 0 15px 0;
                    color: #e2231a;
                    font-size: 18px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .jd-cookie-panel .cookie-preview {
                    background: #f5f5f5;
                    padding: 10px;
                    border-radius: 8px;
                    font-family: monospace;
                    font-size: 11px;
                    max-height: 150px;
                    overflow: auto;
                    word-break: break-all;
                    margin: 10px 0;
                    color: #666;
                }
                .jd-cookie-panel .status {
                    padding: 10px;
                    border-radius: 8px;
                    margin: 10px 0;
                    font-size: 13px;
                    line-height: 1.5;
                }
                .jd-cookie-panel .status.success {
                    background: #d4edda;
                    color: #155724;
                }
                .jd-cookie-panel .status.error {
                    background: #f8d7da;
                    color: #721c24;
                }
                .jd-cookie-panel .status.warning {
                    background: #fff3cd;
                    color: #856404;
                }
                .jd-cookie-panel .btn-group {
                    display: flex;
                    gap: 10px;
                    margin-top: 15px;
                }
                .jd-cookie-panel button {
                    flex: 1;
                    padding: 10px 15px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 500;
                    transition: all 0.3s ease;
                }
                .jd-cookie-panel .btn-primary {
                    background: linear-gradient(135deg, #e2231a 0%, #ff6b6b 100%);
                    color: white;
                }
                .jd-cookie-panel .btn-primary:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }
                .jd-cookie-panel .btn-secondary {
                    background: #6c757d;
                    color: white;
                }
                .jd-cookie-panel .btn-secondary:hover {
                    background: #5a6268;
                }
                .jd-cookie-panel .btn-copy {
                    background: #28a745;
                    color: white;
                    margin-left: 10px;
                }
                .jd-cookie-panel .close-btn {
                    position: absolute;
                    top: 15px;
                    right: 15px;
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #999;
                }
                .jd-cookie-panel .close-btn:hover {
                    color: #333;
                }
                .jd-cookie-panel .config-section {
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 1px solid #eee;
                }
                .jd-cookie-panel .config-section label {
                    display: block;
                    margin-bottom: 5px;
                    font-weight: 500;
                    color: #333;
                }
                .jd-cookie-panel .config-section input,
                .jd-cookie-panel .config-section textarea {
                    width: 100%;
                    padding: 8px 12px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    font-size: 13px;
                    box-sizing: border-box;
                }
                .jd-cookie-panel .config-section textarea {
                    min-height: 64px;
                    font-family: monospace;
                    font-size: 12px;
                    resize: vertical;
                }
                .jd-cookie-panel .config-section input:focus,
                .jd-cookie-panel .config-section textarea:focus {
                    outline: none;
                    border-color: #e2231a;
                }
                .jd-cookie-panel .cookie-info {
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid #eee;
                    font-size: 13px;
                }
                .jd-cookie-panel .cookie-info:last-child {
                    border-bottom: none;
                }
                .jd-cookie-panel .cookie-info span:first-child {
                    color: #666;
                }
                .jd-cookie-panel .cookie-info span:last-child {
                    color: #333;
                    font-weight: 500;
                    text-align: right;
                    word-break: break-all;
                }
                .jd-cookie-panel .btn-sponsor {
                    transition: all 0.3s ease;
                }
                .jd-cookie-panel .btn-sponsor:hover {
                    opacity: 0.85;
                    transform: scale(1.05);
                }
            `);

            // ===== v1.2 新界面样式（覆盖上方基础样式） =====
            addStyle(`
                .jd-cookie-overlay {
                    background: rgba(17, 24, 39, 0.45);
                    backdrop-filter: blur(2px);
                    -webkit-backdrop-filter: blur(2px);
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 16px;
                    box-sizing: border-box;
                }
                .jd-cookie-overlay.show {
                    display: flex;
                }
                .jd-cookie-helper-btn {
                    width: 54px;
                    height: 54px;
                    background: linear-gradient(135deg, #e2231a 0%, #ff5b4d 100%);
                    box-shadow: 0 10px 24px rgba(226, 35, 26, 0.35);
                    border: 2px solid rgba(255, 255, 255, 0.9);
                }
                .jd-cookie-helper-btn:hover {
                    transform: scale(1.08) rotate(-4deg);
                    box-shadow: 0 14px 30px rgba(226, 35, 26, 0.45);
                }
                .jd-cookie-panel {
                    position: relative;
                    top: auto;
                    left: auto;
                    transform: none;
                    margin: 0;
                    padding: 0;
                    width: 480px;
                    max-width: 100%;
                    max-height: 86vh;
                    border-radius: 20px;
                    overflow: hidden;
                    display: none;
                    flex-direction: column;
                    background: #ffffff;
                    color: #1f2329;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                    box-shadow: 0 24px 70px rgba(16, 24, 40, 0.28), 0 2px 8px rgba(16, 24, 40, 0.08);
                }
                .jd-cookie-panel.show {
                    display: flex;
                    animation: jdPanelIn 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
                }
                @keyframes jdPanelIn {
                    from { opacity: 0; transform: scale(0.94); }
                    to { opacity: 1; transform: scale(1); }
                }
                .jd-cookie-panel .panel-header {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 20px 56px 14px 22px;
                    background: linear-gradient(135deg, #fff5f4 0%, #ffffff 62%);
                }
                .jd-cookie-panel .panel-logo {
                    width: 44px;
                    height: 44px;
                    flex: 0 0 44px;
                    border-radius: 14px;
                    background: linear-gradient(135deg, #e2231a 0%, #ff6f61 100%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 22px;
                    box-shadow: 0 8px 18px rgba(226, 35, 26, 0.28);
                }
                .jd-cookie-panel .panel-title {
                    min-width: 0;
                }
                .jd-cookie-panel .panel-title h3 {
                    margin: 0;
                    color: #1f2329;
                    font-size: 17px;
                    font-weight: 700;
                    line-height: 1.3;
                    display: block;
                }
                .jd-cookie-panel .panel-title p {
                    margin: 3px 0 0;
                    color: #8a919c;
                    font-size: 12px;
                    line-height: 1.4;
                }
                .jd-cookie-panel .panel-badge-group {
                    margin-left: auto;
                    flex: 0 0 auto;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                .jd-cookie-panel .panel-badge {
                    padding: 3px 9px;
                    border-radius: 999px;
                    background: #fff0ef;
                    border: 1px solid #ffd9d6;
                    color: #e2231a;
                    font-size: 11px;
                    font-weight: 600;
                    text-decoration: none;
                    cursor: pointer;
                    transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease;
                }
                .jd-cookie-panel .panel-badge:hover {
                    background: #ffe4e1;
                    border-color: #ffc4bd;
                    transform: translateY(-1px);
                }
                .jd-cookie-panel .btn-check-update {
                    flex: none;
                    width: 22px;
                    height: 22px;
                    padding: 0;
                    border: 1px solid #ffd9d6;
                    border-radius: 50%;
                    background: #fff0ef;
                    color: #e2231a;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease;
                }
                .jd-cookie-panel .btn-check-update:hover {
                    background: #ffe4e1;
                    border-color: #ffc4bd;
                    transform: translateY(-1px);
                }
                .jd-cookie-panel .btn-check-update.checking svg {
                    animation: jdSpin 0.9s linear infinite;
                }
                @keyframes jdSpin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .jd-cookie-panel .close-btn {
                    position: absolute;
                    top: 14px;
                    right: 14px;
                    width: 30px;
                    height: 30px;
                    flex: 0 0 auto;
                    padding: 0;
                    border-radius: 50%;
                    background: #f2f3f5;
                    color: #8a919c;
                    font-size: 20px;
                    line-height: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 2;
                    transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
                }
                .jd-cookie-panel .close-btn:hover {
                    background: #e9eaec;
                    color: #1f2329;
                    transform: rotate(90deg);
                }
                .jd-cookie-panel .close-btn svg {
                    display: block;
                    pointer-events: none;
                }
                .jd-cookie-panel .tab-bar {
                    display: flex;
                    gap: 6px;
                    margin: 4px 22px 0;
                    padding: 5px;
                    background: #f5f6f7;
                    border-radius: 13px;
                }
                .jd-cookie-panel .tab-btn {
                    flex: 1;
                    padding: 9px 8px;
                    border: none;
                    border-radius: 9px;
                    background: transparent;
                    color: #6b7280;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
                }
                .jd-cookie-panel .tab-btn:hover {
                    color: #1f2329;
                }
                .jd-cookie-panel .tab-btn.active {
                    background: #ffffff;
                    color: #e2231a;
                    box-shadow: 0 2px 8px rgba(16, 24, 40, 0.10);
                }
                .jd-cookie-panel .panel-body {
                    flex: 1 1 auto;
                    min-height: 0;
                    padding: 14px 22px 20px;
                    overflow-y: auto;
                    scrollbar-width: thin;
                }
                .jd-cookie-panel .panel-body::-webkit-scrollbar {
                    width: 6px;
                }
                .jd-cookie-panel .panel-body::-webkit-scrollbar-thumb {
                    background: #dcdfe4;
                    border-radius: 3px;
                }
                .jd-cookie-panel .tab-panel {
                    display: none;
                }
                .jd-cookie-panel .tab-panel.active {
                    display: block;
                    animation: jdTabIn 0.22s ease;
                }
                @keyframes jdTabIn {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .jd-cookie-panel #status-box:empty {
                    display: none;
                }
                .jd-cookie-panel .status {
                    padding: 11px 13px;
                    border-radius: 12px;
                    margin: 0 0 12px;
                    font-size: 12.5px;
                    line-height: 1.6;
                    border: 1px solid transparent;
                    animation: jdTabIn 0.2s ease;
                }
                .jd-cookie-panel .status.success {
                    background: #f0fbf3;
                    color: #11693b;
                    border-color: #c9efd6;
                }
                .jd-cookie-panel .status.error {
                    background: #fff2f1;
                    color: #a61b14;
                    border-color: #ffd6d3;
                }
                .jd-cookie-panel .status.warning {
                    background: #fff9e8;
                    color: #8a6100;
                    border-color: #ffe9ad;
                }
                .jd-cookie-panel .account-card {
                    background: #fafbfc;
                    border: 1px solid #eef0f3;
                    border-radius: 14px;
                    padding: 2px 14px;
                    margin-bottom: 12px;
                }
                .jd-cookie-panel .cookie-info {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                    padding: 10px 0;
                    border-bottom: 1px solid #eef0f3;
                    font-size: 13px;
                }
                .jd-cookie-panel .cookie-info:last-child {
                    border-bottom: none;
                }
                .jd-cookie-panel .cookie-info span:first-child {
                    color: #8a919c;
                    flex: 0 0 auto;
                }
                .jd-cookie-panel .cookie-info span:last-child {
                    color: #1f2329;
                    font-weight: 600;
                    text-align: right;
                    word-break: break-all;
                }
                .jd-cookie-panel .cookie-preview {
                    background: #f7f8fa;
                    border: 1px dashed #e3e6ea;
                    border-radius: 12px;
                    padding: 12px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                    font-size: 11px;
                    line-height: 1.6;
                    max-height: 120px;
                    overflow: auto;
                    word-break: break-all;
                    margin: 0 0 2px;
                    color: #667085;
                }
                .jd-cookie-panel button {
                    flex: 1;
                    padding: 11px 14px;
                    border: none;
                    border-radius: 11px;
                    font-size: 13.5px;
                    font-weight: 600;
                    font-family: inherit;
                    cursor: pointer;
                    transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease, opacity 0.2s ease, border-color 0.2s ease, color 0.2s ease;
                }
                .jd-cookie-panel .btn-group {
                    display: flex;
                    gap: 10px;
                    margin-top: 12px;
                }
                .jd-cookie-panel .btn-primary {
                    background: linear-gradient(135deg, #e2231a 0%, #ff5b4d 100%);
                    color: #ffffff;
                    box-shadow: 0 6px 16px rgba(226, 35, 26, 0.25);
                }
                .jd-cookie-panel .btn-primary:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 9px 22px rgba(226, 35, 26, 0.32);
                    opacity: 1;
                }
                .jd-cookie-panel .btn-primary:active {
                    transform: translateY(0);
                }
                .jd-cookie-panel .btn-primary.sending {
                    opacity: 0.7;
                    pointer-events: none;
                }
                .jd-cookie-panel .btn-secondary {
                    background: #f2f3f5;
                    color: #3f4650;
                }
                .jd-cookie-panel .btn-secondary:hover {
                    background: #e9ebee;
                }
                .jd-cookie-panel .btn-ghost {
                    background: #ffffff;
                    color: #5a6270;
                    border: 1px solid #e3e6ea;
                }
                .jd-cookie-panel .btn-ghost:hover {
                    background: #fff7f6;
                    border-color: #ffc9c4;
                    color: #e2231a;
                }
                .jd-cookie-panel .btn-full {
                    width: 100%;
                    flex: none;
                }
                .jd-cookie-panel .manual-box {
                    margin-top: 14px;
                    border: 1px solid #eef0f3;
                    border-radius: 12px;
                    background: #fafbfc;
                    overflow: hidden;
                }
                .jd-cookie-panel .manual-box summary {
                    list-style: none;
                    cursor: pointer;
                    padding: 11px 14px;
                    font-size: 12.5px;
                    font-weight: 600;
                    color: #6b7280;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .jd-cookie-panel .manual-box summary::-webkit-details-marker {
                    display: none;
                }
                .jd-cookie-panel .manual-box summary::after {
                    content: "⌄";
                    color: #9aa1ab;
                    font-size: 14px;
                    transition: transform 0.2s ease;
                }
                .jd-cookie-panel .manual-box[open] summary::after {
                    transform: rotate(180deg);
                }
                .jd-cookie-panel .manual-inner {
                    padding: 0 14px 14px;
                }
                .jd-cookie-panel .manual-inner textarea {
                    width: 100%;
                    min-height: 64px;
                    padding: 10px 12px;
                    margin-bottom: 8px;
                    border: 1px solid #e3e6ea;
                    border-radius: 10px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                    font-size: 12px;
                    line-height: 1.5;
                    color: #1f2329;
                    background: #ffffff;
                    box-sizing: border-box;
                    resize: vertical;
                }
                .jd-cookie-panel .manual-inner textarea:focus {
                    outline: none;
                    border-color: #ff8a80;
                    box-shadow: 0 0 0 3px rgba(226, 35, 26, 0.10);
                }
                .jd-cookie-panel .field {
                    margin-bottom: 13px;
                }
                .jd-cookie-panel .field label {
                    display: block;
                    margin-bottom: 6px;
                    font-size: 12.5px;
                    font-weight: 600;
                    color: #5a6270;
                }
                .jd-cookie-panel .field input {
                    width: 100%;
                    height: 42px;
                    padding: 0 12px;
                    border: 1px solid #e3e6ea;
                    border-radius: 11px;
                    background: #ffffff;
                    color: #1f2329;
                    font-size: 13.5px;
                    box-sizing: border-box;
                    transition: border-color 0.2s ease, box-shadow 0.2s ease;
                }
                .jd-cookie-panel .field input:focus {
                    outline: none;
                    border-color: #ff8a80;
                    box-shadow: 0 0 0 3px rgba(226, 35, 26, 0.10);
                }
                .jd-cookie-panel .sponsor-box {
                    margin-top: 18px;
                    padding-top: 14px;
                    border-top: 1px dashed #e9ebee;
                    text-align: center;
                }
                .jd-cookie-panel .sponsor-box p {
                    margin: 0 0 8px;
                    font-size: 11.5px;
                    color: #9aa1ab;
                }
                .jd-cookie-panel .btn-sponsor {
                    flex: none;
                    padding: 8px 20px;
                    border-radius: 999px;
                    background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
                    color: #ffffff;
                    font-size: 12.5px;
                    box-shadow: 0 4px 12px rgba(238, 90, 90, 0.25);
                }
                .jd-cookie-panel .btn-sponsor:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 7px 16px rgba(238, 90, 90, 0.32);
                }
                .jd-cookie-panel .privacy-note {
                    margin: 0 0 12px;
                    font-size: 11.5px;
                    line-height: 1.6;
                    color: #8a919c;
                }
                .jd-cookie-panel .sponsor-qr {
                    display: none;
                    margin-top: 12px;
                }
                .jd-cookie-panel .sponsor-qr.open {
                    display: block;
                    animation: jdTabIn 0.2s ease;
                }
                .jd-cookie-panel .sponsor-qr img {
                    display: block;
                    width: 100%;
                    max-width: 200px;
                    height: auto;
                    margin: 0 auto;
                    border-radius: 10px;
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
                }
                .jd-cookie-panel .sponsor-qr-caption {
                    margin-top: 8px;
                    font-size: 12px;
                    color: #8a919c;
                }
                .jd-cookie-panel .switch-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-top: 14px;
                    padding: 12px 14px;
                    background: #f7f8fa;
                    border: 1px solid #eceef2;
                    border-radius: 12px;
                }
                .jd-cookie-panel .switch-info {
                    padding-right: 12px;
                }
                .jd-cookie-panel .switch-text {
                    font-size: 13px;
                    font-weight: 600;
                    color: #1f2329;
                }
                .jd-cookie-panel .switch-desc {
                    margin-top: 3px;
                    font-size: 11.5px;
                    line-height: 1.5;
                    color: #8a919c;
                }
                .jd-cookie-panel .switch {
                    position: relative;
                    flex: none;
                    width: 42px;
                    height: 24px;
                    padding: 0;
                    border: none;
                    border-radius: 999px;
                    background: #d6d9de;
                    cursor: pointer;
                    transition: background 0.2s ease;
                }
                .jd-cookie-panel .switch .switch-dot {
                    position: absolute;
                    top: 3px;
                    left: 3px;
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    background: #ffffff;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
                    transition: left 0.2s ease;
                }
                .jd-cookie-panel .switch.on {
                    background: #e2231a;
                }
                .jd-cookie-panel .switch.on .switch-dot {
                    left: 21px;
                }
            `);

            // 创建按钮
            // 挂到 <html> 上，避免 body 上的 transform/filter 造成 fixed 定位漂移
            const root = document.documentElement || document.body;

            const btn = document.createElement('button');
            btn.className = 'jd-cookie-helper-btn';
            btn.innerHTML = '🍑';
            btn.title = '京东Cookie助手';
            btn.style.setProperty('position', 'fixed', 'important');
            btn.style.setProperty('top', '100px', 'important');
            btn.style.setProperty('right', '20px', 'important');
            btn.style.setProperty('left', 'auto', 'important');
            btn.style.setProperty('bottom', 'auto', 'important');
            root.appendChild(btn);

            // 创建遮罩层
            const overlay = document.createElement('div');
            overlay.className = 'jd-cookie-overlay';
            overlay.style.setProperty('position', 'fixed', 'important');
            overlay.style.setProperty('top', '0', 'important');
            overlay.style.setProperty('left', '0', 'important');
            overlay.style.setProperty('right', '0', 'important');
            overlay.style.setProperty('bottom', '0', 'important');
            root.appendChild(overlay);

            // 创建面板
            const panel = document.createElement('div');
            panel.className = 'jd-cookie-panel';
            panel.innerHTML = `
                <button class="close-btn" aria-label="关闭">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
                </button>

                <div class="panel-header">
                    <div class="panel-logo">🍑</div>
                    <div class="panel-title">
                        <h3>京东 Cookie 助手</h3>
                        <p>一键同步登录态到青龙面板</p>
                    </div>
                    <div class="panel-badge-group">
                        <a class="panel-badge" id="link-version" href="https://github.com/junyi5d/JD-Cookie-Helper" target="_blank" rel="noopener" title="点击查看项目主页">v${CURRENT_VERSION}</a>
                        <button class="btn-check-update" id="btn-check-update" type="button" title="检查更新" aria-label="检查更新">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
                        </button>
                    </div>
                </div>

                <div class="tab-bar" role="tablist">
                    <button class="tab-btn active" data-tab="cookie" role="tab" aria-selected="true">🔐 获取 Cookie</button>
                    <button class="tab-btn" data-tab="config" role="tab" aria-selected="false">⚙️ 青龙配置</button>
                </div>

                <div class="panel-body">
                    <div id="status-box"></div>

                    <section class="tab-panel active" data-panel="cookie">
                        <div class="account-card">
                            <div class="cookie-info">
                                <span>账号</span>
                                <span id="jd-pin">未检测到登录</span>
                            </div>
                            <div class="cookie-info">
                                <span>Cookie 状态</span>
                                <span id="jd-cookie-status" style="color: #d48806;">⏳ 检测中...</span>
                            </div>
                            <div class="cookie-info">
                                <span>获取方式</span>
                                <span id="jd-cookie-source">-</span>
                            </div>
                        </div>

                        <div class="cookie-preview" id="cookie-preview">点击「提取 Cookie」获取登录凭证...</div>

                        <div class="btn-group">
                            <button class="btn-primary" id="btn-extract">🔍 提取 Cookie</button>
                            <button class="btn-secondary" id="btn-copy">📋 复制</button>
                        </div>

                        <div class="btn-group">
                            <button class="btn-primary" id="btn-send-qinglong" style="flex: 2;">🚀 发送到青龙</button>
                            <button class="btn-secondary" id="btn-refresh">🔄 刷新</button>
                        </div>

                        <div class="btn-group">
                            <button class="btn-ghost btn-full" id="btn-open-login">📱 打开移动端京东登录页</button>
                        </div>

                        <details class="manual-box">
                            <summary>自动获取失败？手动粘贴 Cookie</summary>
                            <div class="manual-inner">
                                <textarea id="manual-cookie" placeholder="pt_key=AAJ...; pt_pin=jd_xxx;"></textarea>
                                <button class="btn-secondary btn-full" id="btn-use-manual">✅ 使用此 Cookie</button>
                            </div>
                        </details>
                    </section>

                    <section class="tab-panel" data-panel="config">
                        <div class="field">
                            <label>青龙面板地址</label>
                            <input type="text" id="qinglong-url" placeholder="http://localhost:5700">
                        </div>
                        <div class="field">
                            <label>青龙用户名</label>
                            <input type="text" id="qinglong-username" placeholder="用户名">
                        </div>
                        <div class="field">
                            <label>青龙密码</label>
                            <input type="password" id="qinglong-password" placeholder="密码">
                        </div>

                        <p class="privacy-note">🔒 账号密码仅保存在浏览器本地，不会上传到第三方。</p>

                        <button class="btn-primary btn-full" id="btn-save-config">💾 保存配置</button>

                        <div class="switch-row">
                            <div class="switch-info">
                                <div class="switch-text">消息通知</div>
                                <div class="switch-desc">发送成功后弹出系统通知，关闭后不再提醒</div>
                            </div>
                            <button class="switch on" id="switch-notify" type="button" role="switch" aria-checked="true" title="消息通知">
                                <span class="switch-dot"></span>
                            </button>
                        </div>

                        <div class="sponsor-box">
                            <p>💖 免费应用 · 自愿赞助 · 感谢支持</p>
                            <button class="btn-sponsor" id="btn-sponsor" type="button" aria-expanded="false">🎁 赞赏支持</button>
                            <div class="sponsor-qr" id="sponsor-qr">
                                <img src="data:image/png;base64,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lVdOO+20RYsWLVu2bIg2rnJIjxs37sILL1TAEkrpnj17UqnUEIFfyuZpbW3dvHlzPB4fInjGjY8e8r0IIY7jbNu2TcUHCCG1tbVH1T/76quvcs4DgUA8Hv/www8PdxR27NhxySWXnHDCCffdd58S+mPGzMev19va2qqqqlwvhEr8GYquVYp2zZo1bsLEVVddNcTVXw3niy++WFNT4/P5TjjhBGVpfFy6TbWhubm5srJSuY8A4De/+c1R1e4qEKuO55577nCNw6uuusq9/P333/+saHrts6XaI5FIe3u70pfd3d3JZDIYDA7RRSOlnDFjxhNPPPHss8+WlJTceOONavs4FNULAI899lh9fT2l9J133nn77bevuuqqj1elKbPH/dPn8x1V7X799ddrmrZp06a5c+eeccYZ7msOZRSklK2trQqwYNu2Skn5TCj4z4y4q16urq6+4IIL/va3vyHiGWecUVBQcFi4PynlGWecccYZZ/QZ+0NehYhZWVkAoCRSzbGPyymh7t/W1haJRNQjELGwsHCITqfD8lO5Z/r9/q985StHMArqoYsXL37//ffT6fTUqVMVdcJnwoP5GRN3r9f7wAMPXHHFFYSQuXPnDkU99x8t9/NhyetXv/rV5ubmvXv3nn766aeccsrH7sFMpVIK/SulpJQWFBQc8hFKwo6sGZkY98OSVPW4m266adq0aeFwePr06eXl5Z8Vj+RnnkVMWZNqzI52j3POo9FoXl7ex3tbpS+fffbZCy64QE3IrKysN954Y8aMGQfLrVbi9fjjjz/++OM5OTnf/e53J0+efFRlzu3n/pvvz5D3XfuMyjdmHG5k9HCX9cMVSkppXl7ex/4UdcOuri7XgC4qKiovLz/YU9QcqK2t/drXvqYS9qLR6Isvvnj0zInMcG9mM1SDP0ORps+euPcJs9fV1T333HOU0gsvvFCtqkfpucpKdpMAlcx9LCOtbpKZwa1cpYNf1d3dHY1GlTnX0NBgWZbf7z8ailbdM5FIPP30062traeeeurMmTOHuLU95oj8mFM3Tj/9dPUic+bM2b9//2cR5KQafNtttxFCDMMghJx88sm2bR/sXVx6PbXn1jTtZz/72SFf3OXTO6z+Uf4i0zRdz2NVVVVtbe1nNAXksyruqq/37dtXWFhIKVXY1+uvv/7oxfnd5z711FM33njjb37zm+7u7o9ldinn+oMPPujqoC996UtDuXNXV9fzzz//zjvvqN44euiGP/zhD2p9UzGBpUuXHlUE9TFxH1jDJRIJ5QVTSUMej+fZZ589SopH3fOll15yzYyf/OQnH4uQuRG0L37xi6NHj160aNGmTZs+9reora29//77n3rqqWQyOfTYnJRy7dq1xcXFyoZExOzs7G3bth3T7h+/QLsEvO7RP/tBpW4oKlAAGDduXEtLy9FQdUqZ3X333QAQCAQIIVdcccXH/tbhcNhxnKEIotsng4ud6oeuri6XWPh73/ueHFruiBAilUqdeuqpSrUrY/0b3/hGJkRsKCN1TNwPLeiDjLS7dqvxWLx4sVLwSuLvueeew11qh0IVrX5asWJFbm6ukpvf//73HzuUIBPy8LGA1VTzVq9erdA4lNIZM2YMsjHoM71/+MMfZvbt5MmTOzo6ZEYu+VBG6hiIYDDftlo0U6nUpk2btm7dapqmEMIwjKqqqtmzZ6v4i+se8fl8v/rVr9atW9fa2moYBue8qanpcB2FQyGiUZ6ZefPmvfzyy++9996IESPOOuusQ8ZoMp05g5+ZCVY75Jn79+/fvn37qFGjhg8fPpQXLCgoyM3N7e7uBoDhw4crauJDel3feeedX//6127DsrOzlyxZUlhYqLxSbnJMMplct27drl27TNOUUno8npqampkzZyq98O9Fy/pvqNQbGxv/53/+Z/bs2f2JDkePHv3lL3951apVffTHX/7yFxX9KSkpeeONNw5X6Zqm+dRTT/3mN79RRvNRWog/+m3VS61bt2706NEAUFlZORSODbUMPv3005dccsnNN9+8ffv2wRujzu/o6JgzZ06mGfPf//3f7sqjLq+trb3zzjtnzJjRn9xvwoQJX/3qVzdu3Phxvft/mjGjxuyFF15QY9kngJcZ5sjJyfnJT36iznclfvPmzUuXLlWlMg5XgH71q1+pB40YMWLnzp2HtKaGbp46jvPqq6/++c9/rq+v/+ijri6/7rrrAMDj8QDAf/3Xf328u0b33W+44QY4UB8BAE455ZRYLMYPHFLKJ5980kWnulOiz6gVFhb+9re/PbIshf9kcVd98dBDD6lRdLWFpmm5ubn5+fkuQtDlgP7KV75iWVb/fjyCblW7MfXoW265ZSgC5J5wsMep7++66y5lGk2cOLGpqemjiKa6sL29ffjw4S4sfvDWKtl1s0zcfw+pdJ555hmPx+MKcVFRkessUs9asmSJGiN3pHRdz83NzcvL83q9fUbqG9/4htIOn7rE/1uIu+rBxx9/XNGiqx4cNmzYXXfd9cYbb2zatGnz5s0ffPDBH//4x4ULF2Zq+i996Uu2bbsDeQRlidQAXH311XCApyAvL2/Lli0fUWW6UbCJEye6A//4448PbngcMk4kpXz99dfVuytB/Nvf/vYxusBdY7KmpsbV2bquP/LII+op6oTf/e53hmG4eWFjxoz5xS9+8fbbb2/cuHHz5s0rVqz4/e9/P2vWrP7+nKMaEvlsiLtrjyrIq+rBSy65RLG39TkSicRPfvITpYbVqP/hD3/4KAulEpTly5d7vV53Fn39618/pNp++OGHFy5c+LnPfe75558/2AoTDocV8bSu64h41113HUw0XRNiEIFQJ3z/+993372srEzZSAebmZZlrVix4q233nIL4AzF83jJJZdkmjEXX3yxEnT1lLffflvhn9VIXX/99SqY3efo6en57ne/qxjuM2fmp+ur+ZTFXXUxY0x1serBq6++Op1OK8PX7WjOueuQvv/++5VPDRFHjBjxURztqgG2bStyRqXglRgNaMGrb/bu3Zufn69W6pkzZ0aj0QH9g0KIE044AQDUnvu666474vF2HX+f//znXazB6aeffjCXomr8f/3Xf/l8PsMwLrzwwlQqNXgvqYYtXbo0E3g3ZsyY3bt3u11hWdaZZ57pjtQtt9yivj/YSP3iF79wbzVlypRwOPzpGvHw76Dat2zZkp2drXTAtGnTenp6XC3Yh1hU/SkPEAllKvgjXtDVnV9++WW1QKtm3H333QOKpvpm06ZN7l5i7NixCsw4oDtc8TwqcVdhqT73VGfG4/Hvf//7J5544q233tre3n6w5UII8fnPf961ZH76058O0sg33njDtZ79fv/WrVsHn2yqA9VmwzAMBc1Qa5fb/ytWrPD5fOrpJ510ktJKA46UuxoovlWlmxTJ61DiaP+Z4q566je/+Y1rkb/00kuDrPjuct/c3FxdXa2uOvXUUz/KTkhdaFmW4np2dw5q0egvnUII0zSvv/56r9fr9/v/+7//e0ALJNO/ocRuwYIF/ZVxH4Y9F5vQvwfUVU8++WRRUZGu6wsXLhyQnEO1MJFIKDeiMify8/MPSe2rfvr73//utuTWW2/N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UsUZ8r//+7+33357MBh0O5ExFg6Hi4qKhth9/e0i9efixYsfffTRzZs3X3TRRSpnPGMisf2tjbv3bqUETpy8IMufgwgCexW34Fxwrux0lyhGqBRryWXvab1rCOOSAXAJTEiCaDNBKe2KJp578qnikncDgZBheEFIf8gYNrwwHku3NHZLwS3LMk2zqye2b3+rh8K8ebMXX3Relg9YtBmSnXYkTFBLhXsSiVReYUkwKz8csyQG7UjcSUXTkU5mJ3JzQ4Rqjmml4umenkh3Z3dLc0+0O40OejxQnOcJ+X0+gwgmkimnO5KOpsEj9ABFxrgQwIgUSEyL2aZFdB0kgkTHcYSUlBLICKt+61vf2r179/vvv19aWton9f7I9l0bN2587733li9fvnHjxo6ODtM0++wAlYi7NgIhZPTo0QsXLrztttuysrIGYSg4LPP4yHlmXGvETSE1DENpfZcYI3NTn5eXl5eX197eDgClpaVu6SlE3LVr16233rp9+/YTTjhhyZIlmSuXy87j8jgf7A2VnTN8+PAXX3xx3759M2fOdFNJhBQI2Nldu6tug21RXfNGYjGCWjAQAiBqj8qF4IJJlU8tOGKvBwakFEKilEKiEAAShQQppOCSCXS4RBAI6DBImbivqbW1vdPQKKWaEDK/MOQPzWhr6dywepvjcM4EY8yUIAXOOG7KuZd+IeDh9v4dkiV5nDsWQWnGw106AkEtFucNLVZ7d5JrHuoLgCVzvAXMlCwdpcz0IA36AzzH0YgOFdSg0msIv8YpWFQDkGhxUlgu27rshtakLRgX3GISQXJA2wErZSIhIAhjjAuuG17xTzo/BIAxY8a88sorL7zwwoQJEyZPnjy4T9lVse5anXkyY+z73//+b3/723Q6nel1cO3STBEfPnz47NmzJ02aNH369GnTpuXl5X28gaqPASLWp1JSn8XOFcRhw4bdc889Dz74YFZW1re//W3XoQkADz/8sHLkP/7442edddYll1yiwqiZN8+09Q8Wx1VTS025f7GLpASESDy8q35byFdRUlje2dm1bvO2nJzCqA2O4wghORe9GAEhheACuRBE0W4whV/vpbqQElAIBEFQCilAIHKCjKNiUQIhORMUQEhuoWYBtYGmBXG45FIIRMFlWUH+qeecG8jJTddvt2IimUKWln4AJ9Kd7ElQw9fW0hlH2N2lN8ep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" alt="微信赞赏码">
                                <div class="sponsor-qr-caption">微信赞赏码</div>
                            </div>
                        </div>
                    </section>
                </div>
            `;
            overlay.appendChild(panel);

            // 保存元素引用
            this.elements = {
                btn, overlay, panel,
                cookiePreview: panel.querySelector('#cookie-preview'),
                statusBox: panel.querySelector('#status-box'),
                jdPin: panel.querySelector('#jd-pin'),
                cookieStatus: panel.querySelector('#jd-cookie-status'),
                cookieSource: panel.querySelector('#jd-cookie-source'),
                qinglongUrl: panel.querySelector('#qinglong-url'),
                qinglongUsername: panel.querySelector('#qinglong-username'),
                qinglongPassword: panel.querySelector('#qinglong-password'),
                manualCookie: panel.querySelector('#manual-cookie'),
                btnExtract: panel.querySelector('#btn-extract'),
                btnCopy: panel.querySelector('#btn-copy'),
                btnSend: panel.querySelector('#btn-send-qinglong'),
                btnRefresh: panel.querySelector('#btn-refresh'),
                btnOpenLogin: panel.querySelector('#btn-open-login'),
                btnUseManual: panel.querySelector('#btn-use-manual'),
                btnSaveConfig: panel.querySelector('#btn-save-config'),
                switchNotify: panel.querySelector('#switch-notify'),
                btnSponsor: panel.querySelector('#btn-sponsor'),
                closeBtn: panel.querySelector('.close-btn'),
                sponsorQr: panel.querySelector('#sponsor-qr'),
                btnCheckUpdate: panel.querySelector('#btn-check-update')
            };
        }

        // 绑定事件
        bindEvents() {
            const el = this.elements;

            // 按钮点击显示面板
            el.btn.addEventListener('click', () => this.showPanel());

            // 页签切换
            el.panel.querySelectorAll('.tab-btn').forEach((tabBtn) => {
                tabBtn.addEventListener('click', () => this.switchTab(tabBtn.dataset.tab));
            });

            // 关闭面板（仅点击遮罩本身时关闭，避免点面板内容误关）
            el.closeBtn.addEventListener('click', () => this.hidePanel());
            el.overlay.addEventListener('click', (e) => {
                if (e.target === el.overlay) this.hidePanel();
            });

            // ESC键关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.hidePanel();
                }
            });

            // 提取Cookie
            el.btnExtract.addEventListener('click', () => this.extractCookie());

            // 复制Cookie
            el.btnCopy.addEventListener('click', () => this.copyCookie());

            // 发送到青龙
            el.btnSend.addEventListener('click', () => this.sendToQinglong());

            // 刷新
            el.btnRefresh.addEventListener('click', () => this.extractCookie());

            // 打开移动端登录页
            el.btnOpenLogin.addEventListener('click', () => {
                window.open('https://home.m.jd.com/myJd/newhome.action', '_blank');
            });

            // 使用手动粘贴的 Cookie
            el.btnUseManual.addEventListener('click', () => this.useManualCookie());

            // 保存配置
            el.btnSaveConfig.addEventListener('click', () => this.saveConfig());

            // 消息通知开关
            if (el.switchNotify) {
                el.switchNotify.addEventListener('click', () => {
                    const enabled = !el.switchNotify.classList.contains('on');
                    this.setNotifyEnabled(enabled);
                    if (enabled) this.requestNotifyPermission();
                });
            }

            // 赞赏二维码折叠展开
            el.btnSponsor.addEventListener('click', () => this.toggleSponsor());

            // 检查更新
            if (el.btnCheckUpdate) {
                el.btnCheckUpdate.addEventListener('click', () => this.checkUpdate());
            }
        }

        showPanel() {
            const overlay = this.elements.overlay;
            const panel = this.elements.panel;

            overlay.classList.add('show');
            panel.classList.add('show');

            // 关键定位写成内联样式，避免个别浏览器内核里样式表未生效时面板跑到左上角
            overlay.style.setProperty('display', 'flex', 'important');
            overlay.style.setProperty('align-items', 'center', 'important');
            overlay.style.setProperty('justify-content', 'center', 'important');
            overlay.style.setProperty('padding', '16px', 'important');
            overlay.style.setProperty('box-sizing', 'border-box', 'important');

            panel.style.setProperty('position', 'relative', 'important');
            panel.style.setProperty('top', 'auto', 'important');
            panel.style.setProperty('left', 'auto', 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
            panel.style.setProperty('margin', '0', 'important');
            panel.style.setProperty('transform', 'none', 'important');
            panel.style.setProperty('display', 'flex', 'important');
            panel.style.setProperty('flex-direction', 'column', 'important');
            panel.style.setProperty('width', '480px', 'important');
            panel.style.setProperty('max-width', '100%', 'important');
            panel.style.setProperty('max-height', '86vh', 'important');
            panel.style.setProperty('overflow', 'hidden', 'important');
            panel.style.setProperty('box-sizing', 'border-box', 'important');
            panel.style.setProperty('background', '#ffffff', 'important');
            panel.style.setProperty('border-radius', '20px', 'important');

            this.loadConfig();
            this.extractCookie();
        }

        hidePanel() {
            this.elements.overlay.classList.remove('show');
            this.elements.panel.classList.remove('show');
            this.elements.overlay.style.setProperty('display', 'none', 'important');
            this.elements.panel.style.setProperty('display', 'none', 'important');
        }

        // 赞赏二维码折叠展开
        toggleSponsor() {
            const qr = this.elements.sponsorQr;
            const btn = this.elements.btnSponsor;
            if (!qr) return;
            const open = !qr.classList.contains('open');
            qr.classList.toggle('open', open);
            if (btn) {
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
                btn.textContent = open ? '🎁 收起赞赏码' : '🎁 赞赏支持';
            }
        }

        // 消息通知开关
        setNotifyEnabled(enabled) {
            const btn = this.elements.switchNotify;
            CONFIG.SHOW_NOTIFICATION = !!enabled;
            setStored('notify_enabled', !!enabled);
            if (btn) {
                btn.classList.toggle('on', !!enabled);
                btn.setAttribute('aria-checked', enabled ? 'true' : 'false');
            }
        }

        requestNotifyPermission() {
            try {
                if (typeof Notification === 'undefined') return;
                if (Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            } catch (e) {
                // ignore
            }
        }

        // 切换页签：cookie | config
        switchTab(tab) {
            const panel = this.elements.panel;
            panel.querySelectorAll('.tab-btn').forEach((btn) => {
                const active = btn.dataset.tab === tab;
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            panel.querySelectorAll('.tab-panel').forEach((section) => {
                section.classList.toggle('active', section.dataset.panel === tab);
            });
        }

        // 自动提取Cookie
        autoExtractCookie() {
            if (CONFIG.AUTO_SEND) {
                setTimeout(() => {
                    this.extractCookie().then(() => {
                        if (this.cookieString) {
                            this.sendToQinglong();
                        }
                    });
                }, 2000);
            }
        }

        // 提取Cookie
        async extractCookie() {
            const el = this.elements;
            el.cookieStatus.textContent = '⏳ 检测中...';
            el.cookieStatus.style.color = '#ffc107';

            let result;
            try {
                result = await collectCookieMap();
            } catch (e) {
                this.showStatus('读取 Cookie 失败：' + (e && e.message ? e.message : e), 'error');
                el.cookieStatus.textContent = '❌ 读取失败';
                el.cookieStatus.style.color = '#dc3545';
                return;
            }

            const { cookieMap, storeSupported, storeReadable } = result;

            if (cookieMap.pt_key && cookieMap.pt_pin) {
                this.processCookie(cookieMap, 'GM_cookie');
                return;
            }

            // 失败诊断：区分「未登录」「HttpOnly 未授权」「管理器不支持」
            if (!cookieMap.pt_key) {
                const looksLoggedIn = ['pt_pin', 'pin', 'unick', 'thor', 'pt_token']
                    .some((name) => cookieMap[name]);

                if (!storeSupported) {
                    this.showStatus(
                        '无法读取 pt_key：当前脚本管理器没有可用的 GM_cookie。' +
                        '请升级到 Tampermonkey 5.3+ 并允许访问 HttpOnly Cookie，或改用 ScriptCat / Violentmonkey；' +
                        '也可以在下方手动粘贴 Cookie。',
                        'error'
                    );
                } else if (looksLoggedIn || storeReadable) {
                    this.showStatus(
                        '已读取到京东 Cookie，但缺少 HttpOnly 的 pt_key。' +
                        '请在脚本管理器设置中开启 HttpOnly Cookie 访问权限：' +
                        'Tampermonkey 需 5.3+，在设置中将配置模式切到「高级」后允许 GM_cookie 访问 HttpOnly Cookie（找不到时可直接安装 Tampermonkey Beta）；' +
                        'Violentmonkey 需开启 HTTP-only Cookie 权限。开启后刷新本页重试，或在下方手动粘贴 Cookie。',
                        'error'
                    );
                } else {
                    this.showStatus(
                        '未检测到京东登录态。请先点击下方「打开移动端京东登录页」并完成登录，' +
                        '登录成功后回到本页刷新重试。若已登录仍提示此项，请检查脚本管理器的 HttpOnly Cookie 权限。',
                        'warning'
                    );
                }
                el.cookieStatus.textContent = '❌ 未获取到 pt_key';
                el.cookieStatus.style.color = '#dc3545';
                el.cookieSource.textContent = '-';
                return;
            }

            // 有 pt_key 但没有 pt_pin
            this.showStatus('已获取 pt_key，但缺少 pt_pin，请重新登录京东后再试。', 'error');
            el.cookieStatus.textContent = '❌ Cookie 不完整';
            el.cookieStatus.style.color = '#dc3545';
            el.cookieSource.textContent = '-';
        }

        // 处理并保存 Cookie
        processCookie(cookieMap, source) {
            const el = this.elements;

            if (!cookieMap.pt_key || !cookieMap.pt_pin) {
                this.showStatus('Cookie 不完整，需要同时包含 pt_key 和 pt_pin。', 'error');
                el.cookieStatus.textContent = '❌ Cookie 不完整';
                el.cookieStatus.style.color = '#dc3545';
                return;
            }

            const rawPin = cookieMap.pt_pin;
            const decodedPin = safeDecode(rawPin);
            const cookieString = `pt_key=${cookieMap.pt_key}; pt_pin=${rawPin};`;

            this.cookieData = {
                pt_key: cookieMap.pt_key,
                pt_pin: rawPin,
                pt_pin_decoded: decodedPin
            };
            this.cookieString = cookieString;

            el.cookieStatus.textContent = '✅ 已获取';
            el.cookieStatus.style.color = '#28a745';
            el.jdPin.textContent = decodedPin;
            el.cookieSource.textContent = source;
            el.cookiePreview.textContent = cookieString;
            this.showStatus('Cookie 提取成功！可以复制或发送到青龙了。', 'success');

            if (CONFIG.LOG_DETAILS) {
                console.log('【京东Cookie助手】Cookie提取成功:', this.cookieData, '来源:', source);
            }
        }

        // 使用手动粘贴的 Cookie
        useManualCookie() {
            let text = (this.elements.manualCookie.value || '').trim();
            if (!text) {
                this.showStatus('请先粘贴 Cookie 内容。', 'warning');
                return;
            }

            // 兼容从开发者工具复制的格式："Cookie: pt_key=...; pt_pin=...;"
            text = text.replace(/^cookie\s*:\s*/i, '').replace(/^["']|["']$/g, '').trim();
            const cookieMap = parseCookieString(text);

            if (!cookieMap.pt_key || !cookieMap.pt_pin) {
                this.showStatus('粘贴的内容不完整，需要包含 pt_key 和 pt_pin。', 'error');
                return;
            }

            this.processCookie(cookieMap, '手动粘贴');
        }

        // 复制Cookie
        async copyCookie() {
            const el = this.elements;
            const cookieStr = this.cookieString;
            if (!cookieStr) {
                this.showStatus('请先提取 Cookie！', 'warning');
                return;
            }

            try {
                await navigator.clipboard.writeText(cookieStr);
                this.showStatus('Cookie 已复制到剪贴板！', 'success');
            } catch (error) {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = cookieStr;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    this.showStatus('Cookie 已复制到剪贴板！', 'success');
                } catch (e) {
                    this.showStatus('复制失败，请手动选中下方预览内容复制。', 'error');
                }
                document.body.removeChild(textarea);
            }
        }

        // 青龙请求封装
        requestQinglong(method, url, token, body) {
            return new Promise((resolve, reject) => {
                const headers = {};
                if (body !== undefined) headers['Content-Type'] = 'application/json';
                if (token) headers['Authorization'] = `Bearer ${token}`;

                GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    data: body !== undefined ? JSON.stringify(body) : undefined,
                    timeout: 15000,
                    onload: (response) => {
                        let data;
                        try {
                            data = JSON.parse(response.responseText);
                        } catch (e) {
                            reject(new Error(`青龙返回非 JSON 内容（HTTP ${response.status}）`));
                            return;
                        }
                        resolve({ status: response.status, data });
                    },
                    onerror: () => reject(new Error('无法连接青龙面板，请检查地址是否正确')),
                    ontimeout: () => reject(new Error('连接青龙面板超时'))
                });
            });
        }

        // 青龙登录，返回 token；优先复用本地缓存的 token
        // 青龙每次调用 /api/user/login 都会触发面板的「登录通知」，
        // 缓存 token 后正常提交不会再登录，也就不会重复推送登录通知
        async loginQinglong(url, username, password, force) {
            if (!force) {
                const cached = this.getCachedToken(url, username);
                if (cached) return cached;
            }

            const { data } = await this.requestQinglong(
                'POST',
                `${url}/api/user/login`,
                null,
                { username, password }
            );

            if (data.code !== 200) {
                throw new Error(data.message || '青龙登录失败，请检查用户名或密码');
            }
            const token = data.data && data.data.token;
            if (!token) {
                throw new Error('青龙登录成功但未返回 Token');
            }
            this.cacheToken(url, username, token);
            return token;
        }

        // 缓存的 token 仅在「同地址 + 同用户名」且未过期时复用
        getCachedToken(url, username) {
            const cached = getStored('qinglong_token', '');
            if (!cached) return '';
            if (getStored('qinglong_token_url', '') !== url) return '';
            if (getStored('qinglong_token_user', '') !== username) return '';
            const cachedAt = Number(getStored('qinglong_token_time', 0)) || 0;
            // 保守按 5 天复用，失败时再由调用方清缓存重新登录
            if (!cachedAt || Date.now() - cachedAt > 5 * 24 * 60 * 60 * 1000) return '';
            return cached;
        }

        cacheToken(url, username, token) {
            setStored('qinglong_token', token);
            setStored('qinglong_token_url', url);
            setStored('qinglong_token_user', username);
            setStored('qinglong_token_time', Date.now());
        }

        clearCachedToken() {
            setStored('qinglong_token', '');
            setStored('qinglong_token_url', '');
            setStored('qinglong_token_user', '');
            setStored('qinglong_token_time', 0);
        }

        // 判断是否为 token 失效类错误（jwt expired / 401 等）
        isAuthError(error) {
            const message = String(error && error.message ? error.message : error);
            return /jwt|token|登录|401|unauthorized/i.test(message);
        }

        // 启用环境变量（失败不影响主流程）
        async enableEnvs(url, token, ids) {
            const validIds = (ids || []).filter((id) => id !== undefined && id !== null);
            if (!validIds.length) return;
            try {
                const { data } = await this.requestQinglong(
                    'PUT',
                    `${url}/api/envs/enable`,
                    token,
                    validIds
                );
                if (data.code !== 200) {
                    console.warn('【京东Cookie助手】启用环境变量失败:', data.message);
                }
            } catch (e) {
                console.warn('【京东Cookie助手】启用环境变量异常:', e);
            }
        }

        // 新增或更新 JD_COOKIE（按 pt_pin 去重，支持多账号）
        async upsertJDCOOKIE(url, token, cookieStr, rawPin, decodedPin) {
            const envName = 'JD_COOKIE';
            const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // pt_pin 可能是 URL 编码后的值，两种形式都要能识别；
            // 用 ; / 空白 / 行尾 作为边界，避免 jd_abc 误匹配 jd_abcd
            const pinValues = [rawPin, decodedPin].filter((pin, index, arr) => pin && arr.indexOf(pin) === index);
            const containsPin = (value) => {
                if (typeof value !== 'string') return false;
                return pinValues.some((pin) =>
                    new RegExp(`pt_pin=${escapeRegExp(pin)}(?:;|\\s|$)`).test(value)
                );
            };

            // 1. 查询已有 JD_COOKIE
            const { data: listData } = await this.requestQinglong(
                'GET',
                `${url}/api/envs?searchValue=${encodeURIComponent(envName)}`,
                token
            );
            if (listData.code !== 200) {
                throw new Error(listData.message || '查询青龙环境变量失败');
            }
            const envs = (Array.isArray(listData.data) ? listData.data : [])
                .filter((env) => env && env.name === envName);

            // 2. 不存在则创建
            if (envs.length === 0) {
                const { data: createData } = await this.requestQinglong(
                    'POST',
                    `${url}/api/envs`,
                    token,
                    [{ name: envName, value: cookieStr, remarks: decodedPin }]
                );
                if (createData.code !== 200) {
                    throw new Error(createData.message || '创建 JD_COOKIE 失败');
                }
                const newIds = (createData.data || []).map((env) => env.id);
                await this.enableEnvs(url, token, newIds);
                return '已创建 JD_COOKIE';
            }

            // 3. 已存在同一账号则替换该行
            const owner = envs.find((env) => containsPin(env.value));
            if (owner) {
                const lines = String(owner.value || '')
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean);
                const newValue = lines.length
                    ? lines.map((line) => (containsPin(line) ? cookieStr : line)).join('\n')
                    : cookieStr;

                const { data: updateData } = await this.requestQinglong(
                    'PUT',
                    `${url}/api/envs`,
                    token,
                    {
                        id: owner.id,
                        name: envName,
                        value: newValue,
                        remarks: owner.remarks || decodedPin
                    }
                );
                if (updateData.code !== 200) {
                    throw new Error(updateData.message || '更新 JD_COOKIE 失败');
                }
                await this.enableEnvs(url, token, [owner.id]);
                return '已更新 JD_COOKIE（同一账号替换）';
            }

            // 4. 新账号则追加到第一条 JD_COOKIE 末尾（每行一个账号）
            const target = envs[0];
            const baseValue = String(target.value || '').trim();
            const newValue = baseValue ? `${baseValue}\n${cookieStr}` : cookieStr;

            const { data: appendData } = await this.requestQinglong(
                'PUT',
                `${url}/api/envs`,
                token,
                {
                    id: target.id,
                    name: envName,
                    value: newValue,
                    remarks: target.remarks || decodedPin
                }
            );
            if (appendData.code !== 200) {
                throw new Error(appendData.message || '追加 JD_COOKIE 失败');
            }
            await this.enableEnvs(url, token, [target.id]);
            return '已追加新账号到 JD_COOKIE';
        }

        // 发送到青龙
        async sendToQinglong() {
            const el = this.elements;
            const url = normalizeQinglongUrl(el.qinglongUrl.value);
            const username = el.qinglongUsername.value.trim();
            const password = el.qinglongPassword.value.trim();

            if (!url || !username || !password) {
                this.switchTab('config');
                this.showStatus('请先在「青龙配置」中填写面板地址、用户名和密码。', 'warning');
                return;
            }

            if (!this.cookieString || !this.cookieData) {
                await this.extractCookie();
            }
            if (!this.cookieString || !this.cookieData) {
                this.showStatus('请先成功获取 Cookie（或手动粘贴）再发送！', 'warning');
                return;
            }

            // 发送前自动保存配置，避免每次重复填写
            this.saveConfig(true);

            el.btnSend.classList.add('sending');
            this.showStatus('正在连接青龙...', 'warning');

            try {
                let token = await this.loginQinglong(url, username, password);
                this.showStatus('正在写入 JD_COOKIE...', 'warning');

                let resultMessage;
                try {
                    resultMessage = await this.upsertJDCOOKIE(
                        url,
                        token,
                        this.cookieString,
                        this.cookieData.pt_pin,
                        this.cookieData.pt_pin_decoded
                    );
                } catch (error) {
                    // 缓存的 token 失效时才重新登录（会触发一次青龙登录通知）
                    if (!this.isAuthError(error)) throw error;
                    this.clearCachedToken();
                    this.showStatus('登录状态已失效，正在重新登录...', 'warning');
                    token = await this.loginQinglong(url, username, password, true);
                    resultMessage = await this.upsertJDCOOKIE(
                        url,
                        token,
                        this.cookieString,
                        this.cookieData.pt_pin,
                        this.cookieData.pt_pin_decoded
                    );
                }

                this.showStatus(`${resultMessage}，青龙环境变量已生效。`, 'success');
                this.notifySuccess();
            } catch (error) {
                console.error('【京东Cookie助手】发送失败:', error);
                this.showStatus('发送失败：' + (error && error.message ? error.message : error), 'error');
            } finally {
                el.btnSend.classList.remove('sending');
            }
        }

        // 保存配置
        saveConfig(silent) {
            const url = normalizeQinglongUrl(this.elements.qinglongUrl.value);
            const username = this.elements.qinglongUsername.value.trim();
            const password = this.elements.qinglongPassword.value.trim();

            setStored('qinglong_url', url);
            setStored('qinglong_username', username);
            setStored('qinglong_password', password);

            if (!silent) {
                this.showStatus('配置已保存！', 'success');
            }
        }

        // 加载配置
        loadConfig() {
            const url = getStored('qinglong_url', CONFIG.QINGLONG_URL);
            const username = getStored('qinglong_username', CONFIG.QINGLONG_USERNAME);
            const password = getStored('qinglong_password', CONFIG.QINGLONG_PASSWORD);
            const notifyEnabled = getStored('notify_enabled', CONFIG.SHOW_NOTIFICATION);

            this.elements.qinglongUrl.value = url;
            this.elements.qinglongUsername.value = username;
            this.elements.qinglongPassword.value = password;
            this.setNotifyEnabled(notifyEnabled === true || notifyEnabled === 'true');
        }

        // 检查更新：拉取远程脚本解析 @version 并比对
        checkUpdate() {
            const btn = this.elements.btnCheckUpdate;
            if (btn && btn.classList.contains('checking')) return;

            if (btn) btn.classList.add('checking');
            this.showStatus('正在检查更新...', 'warning');

            const finish = () => { if (btn) btn.classList.remove('checking'); };

            const handleRemote = (text) => {
                const match = text && text.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-\w.]*))/);
                if (!match) {
                    finish();
                    this.showStatus('未在远程脚本中解析到版本号。', 'error');
                    return;
                }
                const remoteVersion = match[1];
                const cmp = this.compareVersion(remoteVersion, CURRENT_VERSION);
                finish();
                if (cmp > 0) {
                    this.setStatusHTML(
                        `✅ 发现新版本 <b>v${remoteVersion}</b>（当前 v${CURRENT_VERSION}）。<a href="${UPDATE_URL}" target="_blank" rel="noopener" style="color:#11693b;text-decoration:underline;margin-left:6px;">点击更新</a>`,
                        'success'
                    );
                } else if (cmp === 0) {
                    this.showStatus(`已是最新版本 v${CURRENT_VERSION}。`, 'success');
                } else {
                    this.showStatus(`当前版本 v${CURRENT_VERSION} 高于远程 v${remoteVersion}，可能是开发版。`, 'warning');
                }
            };

            const handleError = (err) => {
                finish();
                this.setStatusHTML(
                    '❌ 检查更新失败：' + (err || '网络异常') + '，可<a href="' + PROJECT_URL + '" target="_blank" rel="noopener" style="color:#a61b14;text-decoration:underline;margin-left:4px;">前往项目页</a>查看。',
                    'error'
                );
            };

            try {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: UPDATE_URL + '?_=' + Date.now(),
                        timeout: 10000,
                        onload: (res) => {
                            if (res && res.status === 200) {
                                handleRemote(res.responseText);
                            } else {
                                handleError('HTTP ' + (res && res.status));
                            }
                        },
                        onerror: () => handleError('网络错误'),
                        ontimeout: () => handleError('请求超时')
                    });
                    return;
                }
            } catch (e) {
                // 退回到 fetch
            }

            // 退回 fetch（部分管理器无 GM_xmlhttpRequest 时）
            fetch(UPDATE_URL + '?_=' + Date.now(), { cache: 'no-store' })
                .then((r) => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                })
                .then(handleRemote)
                .catch((e) => handleError(e && e.message));
        }

        // 版本号比对：a > b 返回 1，a === b 返回 0，a < b 返回 -1
        compareVersion(a, b) {
            const pa = String(a).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
            const pb = String(b).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
            const len = Math.max(pa.length, pb.length);
            for (let i = 0; i < len; i++) {
                const x = pa[i] || 0;
                const y = pb[i] || 0;
                if (x > y) return 1;
                if (x < y) return -1;
            }
            return 0;
        }

        // 显示状态（支持 HTML，谨慎使用）
        setStatusHTML(html, type) {
            const el = this.elements.statusBox;
            el.innerHTML = '';
            const box = document.createElement('div');
            box.className = `status ${type}`;
            box.innerHTML = html;
            el.appendChild(box);
            if (type !== 'error') {
                setTimeout(() => {
                    if (box.parentNode === el) {
                        el.innerHTML = '';
                    }
                }, 8000);
            }
        }

        // 显示状态
        showStatus(message, type) {
            const el = this.elements.statusBox;
            el.innerHTML = '';

            const box = document.createElement('div');
            box.className = `status ${type}`;
            box.textContent = `${ICON[type] || ''} ${message}`;
            el.appendChild(box);

            // 3秒后清除成功/警告消息
            if (type !== 'error') {
                setTimeout(() => {
                    if (box.parentNode === el) {
                        el.innerHTML = '';
                    }
                }, 3000);
            }
        }

        // 通知成功
        notifySuccess() {
            if (!CONFIG.SHOW_NOTIFICATION) return;
            try {
                if (typeof Notification === 'undefined') return;
                if (Notification.permission === 'granted') {
                    new Notification('京东Cookie助手', {
                        body: 'Cookie 已成功配置到青龙面板！'
                    });
                } else if (Notification.permission === 'default') {
                    Notification.requestPermission().then((permission) => {
                        if (permission === 'granted') {
                            new Notification('京东Cookie助手', {
                                body: 'Cookie 已成功配置到青龙面板！'
                            });
                        }
                    });
                }
            } catch (e) {
                // 通知失败不影响主流程
            }
        }
    }

    // 初始化
    console.log(`【京东Cookie助手】v${CURRENT_VERSION} 已加载`);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new JDCookieHelper());
    } else {
        new JDCookieHelper();
    }

})();
