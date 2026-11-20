// ==UserScript==
// @name         京东Cookie一键配置到青龙
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  一键获取京东Cookie并自动配置到青龙面板，支持电脑端和移动端
// @author       JD Helper
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
// @connect      *
// @run-at       document-idle
// @noframes
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/junyi5d/jd-cookie-helper/main/jd-cookie-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/junyi5d/jd-cookie-helper/main/jd-cookie-helper.user.js
// ==/UserScript==

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

    // 当前版本与更新地址（与 metadata 保持一致）
    const CURRENT_VERSION = '1.3.0';
    const UPDATE_URL = 'https://raw.githubusercontent.com/junyi5d/jd-cookie-helper/main/jd-cookie-helper.user.js';
    const PROJECT_URL = 'https://github.com/junyi5d/jd-cookie-helper';

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
     * 部分国产浏览器（如 360 极速）内置脚本管理器对 GM_addStyle 兼容不佳，
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
                .jd-sponsor-modal {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: white;
                    border-radius: 15px;
                    padding: 30px 26px;
                    width: 480px;
                    max-width: 92vw;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    z-index: 1000001;
                    display: none;
                    text-align: center;
                }
                .jd-sponsor-modal.show {
                    display: block;
                    animation: fadeIn 0.3s ease;
                }
                .jd-sponsor-modal h4 {
                    margin: 0 0 15px 0;
                    color: #e2231a;
                    font-size: 18px;
                }
                .jd-sponsor-modal p {
                    margin: 0 0 15px 0;
                    color: #666;
                    font-size: 13px;
                    line-height: 1.5;
                }
                .jd-sponsor-modal img {
                    display: block;
                    width: 100%;
                    height: auto;
                    max-width: 100%;
                    border-radius: 10px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                }
                .jd-sponsor-modal .close-sponsor {
                    margin-top: 15px;
                    background: #6c757d;
                    color: white;
                    border: none;
                    padding: 8px 25px;
                    border-radius: 20px;
                    cursor: pointer;
                    font-size: 13px;
                }
                .jd-sponsor-modal .close-sponsor:hover {
                    background: #5a6268;
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
                .jd-cookie-panel .hint {
                    margin-top: 13px;
                    padding: 11px 13px;
                    border: 1px solid #eef0f3;
                    border-radius: 12px;
                    background: #fafbfc;
                    color: #8a919c;
                    font-size: 12px;
                    line-height: 1.7;
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
                .jd-sponsor-modal {
                    border-radius: 20px;
                    padding: 28px 26px;
                    box-shadow: 0 24px 70px rgba(16, 24, 40, 0.30);
                    max-width: calc(100vw - 24px);
                    max-height: 90vh;
                    overflow-y: auto;
                    box-sizing: border-box;
                    transform: none;
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
                        <a class="panel-badge" id="link-version" href="https://github.com/junyi5d/jd-cookie-helper" target="_blank" rel="noopener" title="点击查看项目主页">v1.3.0</a>
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

                        <div class="hint">
                            青龙地址可只填 <b>localhost:5700</b>，脚本会自动补全 http://<br>
                            账号密码仅保存在浏览器本地，不会上传到第三方。
                        </div>

                        <div class="sponsor-box">
                            <p>💖 免费应用 · 自愿赞助 · 感谢支持</p>
                            <button class="btn-sponsor" id="btn-sponsor">🎁 赞赏支持</button>
                        </div>
                    </section>
                </div>
            `;
            overlay.appendChild(panel);

            // 创建赞助模态框
            const sponsorModal = document.createElement('div');
            sponsorModal.className = 'jd-sponsor-modal';
            sponsorModal.innerHTML = `
                <h4>🎁 赞赏支持</h4>
                <p>感谢您的支持！<br>您的赞助是我继续开发的动力~</p>
                <img src="data:image/png;base64,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OiREANPwVX7+n+p1/wXOUZIWEj8e5Bol/g/MQcaYZVnz589XxpPjOIiYl5d3yy23nH/++V4uvFKj2trazz77bMWKFUoDTNMsKSmZNGlS79690yM2EXHAgAH33XffY489lpWVdeONN3ZgDqpjWL169YYNG5Sy2rZ91FFHXXbZZa2lSz0dNmzY1KlT586da5rmFVdcMWTIkHS9VMWgZ86cyRj79NNPx40bd/LJJ7cQ1O3bt6tDFUJkZWWpXozevjIzM/Py8tQCrutmZmbuul3lHBH333//F1988e233+7du/dZZ50FrWYBW3TCsixLdTxu8yYAAJ566qnS0lJN05YuXXr55Ze/+eab3i1I+lWKV60sX/qExsHLn+jIygQAxn0ZRQAcwKle81btmjkNWz/tf1S3QN7gYOFw7s/BVBXjestNISLjGqZKP30oXDTcH+nVFKRKECSExC9G/LwECaVehmEMHDhQRT8CwDHHHHPrrbfus88+nnXFOV+zZs2TTz75+uuvr127tsUGi4qKDj744LPPPvvQQw9NV83TTz/9tNNO62J1t8zMTJVrKITIz8//05/+ZBhG6wwK9TQSiTz99NNLliyJRCJeM6kWixmGMWvWrFmzZrW5u2g0mm7/ZWVleSsq5+e0adM++ugj27YLCwsPPPDA9ONXD6ZOnaoCcNo7OyVdixYtuv3223fu3HnUUUdde+21gUCgxabU5crNzfVs0/nz5//pT3/685//7EXAIiADJkVq+ycPQ6qKmUHsisdS9VvUAwCA0pVOwvAFRXJnvGptIG+IEcozMgpTiQpd0xFbTQWi5IbfadhcsfyZPgdeD0hzhQQJIfHLMgE9T6Cnc3fccUfv3r1ramqmTJkyY8YMn8/niRBj7Mknn7zppps8Kyrda8c5r6iomD179pw5c37zm9/86U9/CofDrZtddBwjAwCDBw/+f//v/z311FOhUOjaa68dNWpUB0noiJiRkaF0twMdSq9Q02KBeDyefgotjgcRL7nkkv79++/YsWP8+PHqnqDFFjptyqh0/S9/+YuKfV22bNlee+11wgkntJkfef7557/44osNDQ1qa//85z8POeSQQw45RErJmouc1m6cnyxbohv+TlUwTbQYN3wAgCCkawECoCuSNQCgGUHDF0m1bLyRLoVS1826de/kDpwa6TYapACu0S+IICEkfvYwxrZu3Tp//vxgMDhlypScnBz1et++fe+66670UV65DVUW/G9/+1sAMAzDcRwpZSQSiUQijLFkMqmSEHRdT6VS99xzT21t7QMPPBAMBpXTryv9DtW7nPNLLrnk/PPPVx7aTrXT07kOkh3bVEe1vOrOoRbo27dvRkaG91T9GwgEZsyY0cFhq+2oicDWR+IV04lGo5qm6bpu2/aTTz45Y8aMFhGq6o5hzJgx11xzzXXXXadmJROJxAMPPHDQQQc1m4OA0qr++g1wk2AGAGWXzDMEYEwzQ8oiFE5CHZl0baWQXPM1ldtGZG1oITJuYLKqbNlzg47ap+ul1wjiu0DfM+KHtQUBoKam5pRTTjn33HNPOeWUG264wQvo8DL8vBR1lRLw6KOPXnnllcqIdBxn+PDh99xzz7vvvvt+M0899dQRRxyhwiZ1Xf/Pf/5zwQUXqFzyPa09rSYdvUz2TuWTc/7t6pa1CO3xpLfFMukxse1NcPI0WhyeOp399ttPCKGuz7x58+bNm6cEsvXCl1566RFHHKFuPlSEjsrZB5TAWP22z5IVXzabg503bgRgyJBxnfsyAACtuHTijDFABOkCAHANEVw7Kd0kStG6QyECIEjdDCTKPm8s/woYQ4ogJUgIiV+AEK5du3bx4sWGYei6/uGHH0aj0bSOgFxFhKqRmnO+ePHiq6++WmU+CCHOO++8+fPnX3755fvuu+/AgQMHDBiw1157nX766XPnzr3vvvsikYjrupqmPfvss/fdd1+7OQAd2lg/TluDWCy2detW75oUFxe3lrpdjeybp1TbvJ7vv//+qaeeesoppyxYsKBNvbzooot69Oih7iqEEPfdd1/rTBK18XA4/Le//W3YsGG2bSPiwQcfrDI4lT7Vb1qITgxUo8EO5K/pAWOMo2sb4WJ/VgkApBor3WQd4xqgdJO1gAJAyx5wWNbgaYFuY3ggT7gOwG46x1CVsNEwVRvd8RlAWgFSgvjBINco8YPTvXv3bt26lZeXA0CfPn2CwWCbksk5t237rrvuamhoUDnpl1122T333KNpmjJT0qMZNU279NJLc3JyzjvvPMuyOOf33nvvCSec0Lt37z0tNv1dWil1HSGEZVneUxUp01rDOjhydSQ1NTVXXnmlCjJasWLFhx9+mJeX5x2ksqr79Olz0kkn/f3vf1evf/zxxx9//PGBBx7YQlyVNA4dOnTu3Ln/+9//MjIyjjrqKLUnxrkdL4+XLtM0o+1SL8rO895CCYCukwIzu2jULF9mLwCIlS6VqXpumIzLxtIVTmy7EemTM/CInAGHSjuWqt9a/c2btWveZmgz1lyipvnoOINkxUoUFtN8VH6UIIuQ+Dl/vThHxN69ez/xxBOnn376hRdeeOedd7YZmenlM8yfP1+VKJswYcJdd92lbBpd19MNGpWrIIQ49dRTf//73yvl27Ztmypj3Z6KdKVmdzpeA1753XLa1B6TyWQsFvOetk5sUK+vX7/+2muv/c1vfvPuu++2UEr1uKGhobKyUqV8VFZWqnKmrTd1+umn5+bmKp9nPB5/9NFHoZ1q44hYUlJy0UUXnXrqqU05GwwAIFq11o6Vc81os5SodG0hUSJXf8hMMDKDPceXTLk5d+h0YNxp2Fy7/j3OARGZptkNW7Yvus+q3wToAjO4LztYuHevA68v2PsUBA4tPaTINaOh7Ot4/Wb1lH5KBFmExM+Y1nH/bfoh1Sj/zjvvKMeprus333yz3+9XQzm0qknmtaq45JJLnn322Y0bNzLGXnvttUsuuSS9e1G6yrYIGOmKikNzc6Xvfh1isZiK8VFn2qtXr9anj4jXXXedaiM8d+7cjz/+ON3AVaLVvXv3Qw89VLUmPuyww3r16tXCZlV3DCNHjjz66KP/85//qBf/97//rVu3buDAga3NZS8T30tuUarkNmxlIgWGr5UOoQQ9o99Bmb325bqvqRo3N/Vgjj+nn+7PBgCR3Ll98QN2/cYmHUXUNK1h0/upuq3BvEE8kB0pGpbRa3/Nl1mw14n1Wz6xa77herriIjDORaPTuANyB5M9SJAQEr8EvL5I7QWkpPcwQsRBgwapKi1eFGhZWdmzzz7b0NBw/PHH77PPPt5bBQUFkydP3rhxIyKuXLly+/btJSUl6cO9l7+vpifHjRvXo0ePTo+Wc7527dpbb721tLR01qxZ55xzTsc1SzvFsqx0y7K1Qcw537p168cff6zq5pSWli5fvrx3797p+RiI6PP5HnjgAZWtf9BBB6kU+NbHr2naqaeeOnv2bDWHWlVVdf/99997773t3azsdpOhDrihojlSdLeZRdcVuUOP7HXA1aC11eYN3XjlVzsWP5woXaIbusTmBoYAuq479Rtqq1ZzTd/5lb943PnFY8/V/fmhgiFW9dcMDGxx/yQcu7GCfjsECSHxCyG9IGcbg6fK4EZUKecA0KdPn3A4nB78cv311yv75sUXX1ywYEGPHj281O9+/fqpZVKpVCKRaL1xx3EuueSSxx57DAAmTJjw6quv5ufnd1B9TSVpXHzxxSoaZenSpfvss8+YMWO+XatbdQpbt25tbGxUVmwwGOzevXvrC+Lz+cLhcEVFhbpdWL16dYtsCi/CpWkyry1N9YzCQw45ZNq0aa+88oqaOJw7d+4111zTvXv3zmY9ERgDdFPRncBaZPsxlJKbkZxBh4MWlE5c2g0MQfXatZP1VuP2WOnyus0fymS1rhuIaZYcY9K1wYiEcrvZDTvAjsbLlknnFG6E/RndAFmrzEImUVrRcvrtECSExK8I13W9StPpU2jKnlu+fLmu65qmrV+/ft26dSoqUg3oPp/Ps4TSA1I82+7hhx9+7LHHlDwsXrx4/fr1HQihMqcWLFiwcOFCZSelUimvKVKbOpde3rMDK9Oz6kzT9MrKpItZXl5efn7+hg0b1GKqM2Kbe/T62neQVq9p2gUXXDBnzhzXdRGxoaFB3SV0JfwHUTipRgat9UlyI8j1CADGKldv/egfGtiIDKQjrKiwG0DYmqbruom7KscwABCOxUPdeow93W4orajdwpkm7bh0ktwIa74M5HqL8FHVmkKkGtJsVIL4we7U6RIQPxFUfoV6rOpWe+O+z+ebOHGi67qWZe29997Dhg1Ln2j0xI9z7omip4KrV6++8847VaqGJzYdqJrqgvTII48ooZVS9uzZc8iQIe2t4iWBdKwuquO8OobMzMwWhUa9TaWH1FZVVUFbcaRd6VGsVH/SpElnnHEG51zX9eOOO65Pnz7QtT6FAMAYb6eyqHqdSTvu1G1wate6deuchs1g12kMdMPPuI5NpiUAcEQhhBvpfdCgo/4shdi5+k2NITCG0pbCBgBu+IC1lVsPDCihniCLkPiV4E0fenbSxo0bo9Goqr2iuO2220aOHFlfXz99+vTCwsJ0s8arRBoMBj2BUQs4jnPDDTeUlZUp9yAinnDCCX379m0vcVC9/sknn/z3v//1SslMmzatX79+7a3iOM6KFStM0xw2bFgHYTUqvFPXdSllQUFBCzH2bLi+ffu+//77uq4LIZQZ2mnJm/YuKQAEAoH777//nHPOYYyNGTNGda7v8qZYe013obkaDtNMpmrJqOa9AFIKKQUD5JrBORPCBj2jcNTJRfucVL3m7dJPHuBgA2+Ki/GKn6oEwjZ2RBBkERK/HpSv7+CDD1Yj7Pr16z/88EOv4AsA5OTkXHDBBX/4wx8GDRqUntVQWlr6/vvvq7VGjRrlBcKoFRcsWPD6668rc01KOWDAgGuuuUZlX7Spgmqxe+65x7ZtlbmRk5Pzm9/8BtrqWa8s14suumjChAnjx4+/7bbbvODP1pp02GGHIWIqlZJSjhs3rkUTJY9JkyZJKVWfDXU1hBDfJUgnHA4fcMABkyZNUqW394QOOi419xEECShVXChjDKVjZHTvsf+loZ4TBXLHsf35e/WdelvxvufvXPn6jo//xcFhTPWdQMYNxg0AkI4F2OY5kkeUIIuQ+JUZhQBw6KGHZmdn19fXSylvuummAw44IDMzU5lK3sSYcjB603J/+9vftm3bphLwjz32WK9aqdrsN998o5rZuq6r6/rf/va39G66bZqDS5cufe+99zw9O/fcc4cOHdpe4uO6detmz57tOI5t2y+88MKll16qWintdrPJOQCMHz/+b3/721tvvTVo0KDrrruutWWmFjvuuOM2b978/vvv77PPPueddx50odF8J2qWNqGYrtAdb5Zxw59RYJd1oJGAu5uMyhEqHTtcvHfeiFPqNsy3E9W5Aw83wt3KljxY+cWTBhcIqj09RwTNn8HNIAAIqxFQtByLEIExM1JEPw2CLELiVySEiDhw4MAjjzxSSdeXX3556aWXJpNJVVkmPfVCGUmc8/vvv1/1lxdCDBgwYPr06bB7GetJkyYVFBSofodXXHHFtGnT2rTDvGOQUj700EPxeFyZg1lZWWeccYYnuq1XiUQiqiM8AGRkZLTZ/09hmuZVV1313nvvPfjgg22GbqqnoVDopptueu+99/7+978rTf2OdW3SJxTTi5S2X1hARepyM5jXXjPH9iSXcd2Nl29897ZE1ZqcwccUjTrbCOeXffavis+f4CCwaXIRVE0aI1TI9QCAtKKVbc4Qcs7NcEGTKBIEWYTEr0EIpZS6rl9zzTXvvfdeZWWlruvPPPNMPB6/++67S0pKWiyfTCbvvPPOO+64Q1UolVJeffXVRUVFnrWnxvpRo0a99dZbixcv7tGjx5FHHgntx3YqgVyxYsVrr73mLTNjxoyhQ4dC+ykKffv2veeeex5++OFAIHDllVcqUWxPutSxdSCr0ByDqmlaV4qA75FdyBibP3/+U089ZRjGxRdfPGrUqPYPFQGYP6cntA7m7Gw/XDfdxi2b3721z0HXhHuMKV380M4Vs3UuVYhNc2o8Atf9uQOAacKOphrKWOs5QkTU/GZmd/ppECSExK/JO8G5lHLEiBH33nvvWWedlUwmdV1/9dVXv/rqq5NOOunAAw8sKipijMViscWLF7/++usfffSRsnKEEBdffPF5553XwtpTVuaYMWPGjBnTwvBqT4wfe+yxuro6ZQ4Gg8Fzzz03vcdh6+UBYNasWSeddJIqAtfx9r3iAB3fECiTt9Oj3VMVrK2tvfzyy1etWgUAS5Ysee+99zrIIQEAX04/bkbQjQHT2rEC2wxwQU3zuY1bt37w12Be//rNizRwgWngVfIGJqWrBYsye4wCQKex1K7fwrgGAKoVcJNVKm0js8Sf3ef7uggEQUJI/Gy0UAhx0kknpVKp888/37ZtwzA2btx4xx133H333aofYSqVUkU7VatCIcRll1129913p3tEWxiaXuu+jm21DRs2vPjii8oOQ8Tp06fvv//+HUuXMuBUx4aupNt3ZUxv0cT4u8uA2kh1dXVFRYUqW7Ny5co5c+ZcdNFFbTqKm9L2s/v7cvqmyr/QDH2XHzVN+9rrC4FSaobfadxWV7dZN3wAGiKqzwYAOAPbcgsGHOrPGQDAEju/duM7OdcAm1QQAThjrpDZ3fbyBYuakxGpzhrxQ448dAmInxTKK3jGGWe89NJLw4cPdxxHaZjjODU1NdXV1bFYTOmN4zg5OTm333773Xff3UFigGrz1HHWnXrrkUceqaqqUpkMPp/vzDPP7NiGU80UO+3Wu0eKpTb78ccfP/fccytXruxKYynV0LGDyuDq+AsLC3v16qXKjjPGnnjiiWg02vZkITJEyYxQsMc4IYUngc3J8QxQSRO2kEP1JuOAKDVNN3x+lRnhWXkoHCtlhXvuXzRyJjAuncaaDe8B2sC8MNQm3ymCZuYNA2AIsv1EDoIgISR+uXahlHLatGnz5s27++6799tvvxZ6IKXs16/flVde+c4771x//fWGYXwXy0lJyMaNG2fPnu2FpB588MEHH3xwB30K1VuexH5fPkwAeOGFF6ZOnXrqqacefvjhn332WaftL9RhdCDDaguZmZmnnnoqNPtdP//881dffRXaaf+rTiZ/4KF6uLuUzu6pfuhN9AnJXIlC/Ql0BbouOq50hXRc6TjCdYVw0RVSSCaYz8ge2H2/i0oOuUEPFwNA1devRnd8znVzdycrR9c2snrl9ZsE5BclfhTINUr8dLWwe/fuV1555cUXX7x8+fJvvvkmlUoJIUzT7Nmz57hx43Jzc6E5yOW7DJdK0l588cUdO3ao2UHTNC+66KI220Wlq8snn3zywQcfDBgw4Oijj/b7/d/djakU67XXXovH46ZplpWVzZkzZ9999+14rYULF37yySdDhw498sgjTdPsYMnTTz/9gQce2Lx5s67rjuPMnj171qxZbVi9DAA4IASyB2T2PaBu5Yu6aSBralKP0kXpAmIwf2C/w24E6aAqw9bUnhARJSAwZQkq0eSMMcMI5vhz+ujBpoyI+s3zK5c/ozEJoEGa2ccY2kIUDJxihrqpJAr6ORAkhMSvVwuV19Hv948fP378+PFtWnLfPc2Oc15VVaUaG3nxNVOnTu2gGCnn/L333jvppJNUvZj77rvv0ksv/Y5CqFYXQtTX13vVZLziMu0dxrvvvnvCCSc0NjYCwKOPPnruuee2OVWpbiwKCgrOP//86667Tm2wtrZWxdy2d0QALH/YjIaNC6VdA8xgAMA0aTUkKleECof7wkW+/t8mz8+Nl9es/V/lV8/LZA3n+q5gUgBkHF3Llzu4cMTxux0H/R4IEkLi14kXt+LNw6WP7N99Ts4TwqeffnrNmjVKLRhjF1xwgc/na68ToVKRl156qa6uzu/3p1KpJUuWwPeR8KcSKFUFOHVsVVVVXj2BNrf/6aefNjY2BoPBVCq1ePHic889t+PQnnPPPfeVV175/PPPOedHHHGEsnrbvpKMAWAof3jmoCNrlz9hmCaiBGAM3Mplz2i6P9JzLGMGMGjuL+/N5LG08BZUUoZSCjfhxHbGypbVbfooVbOec8m53iL0lAM6yAv3Ot4MFnnmIKkgQUJIkBx24vn0+jHtqRQpFayoqHj88cfV7KDruuPGjTv++OM7KEaqIjDV7J1K7U+vlP0dVblFa8BOrczhw4cDgGoroVIe21tFnU5+fv7LL7/8wQcfZGdnH3LIIV3R757jzkmUf2VXLtcMP6JgTHMTFds+/KsvUsR1PwIyxndTq+ZK2U0yiMgAEaVwkk6iVtoxxlDTDcCWKsi45qZi4b6HFgydDrv1cCIIEkKC6Ew81Gi+p85J1XHp3XffXb16tadqF110UTgc7qAMG2Ns48aN69atUykTiNi/f39va9/9jAoKCqA5hqW8vLy+vj4nJ6dNYUPEY4455rnnnluwYMFee+111llndXoFELF3795nnHFGCwO3vZsQQNTMrB4TL9v41u/RrmOaiagsOWE3bE3LDmzevvfPrk2o54wxxrimG4ZSx5ZpiIwLJ6XlDOg16XdcCyAiIyUkSAgJoosq2NjYuH379t69e4fD4W+xkR07diCiYRi2bQ8fPnzGjBkdyInSp6+//jqZTKqsx1AotP/++3esKF3sWaiWKS4u9h7HYjHbtjuwlXVdnzlz5syZM7tuXiv99tzO3r9ttylmDBAzuo3uMfGy7Qvu0KULXAeUAMC40TqXkHn/pL+IzTGn2E6QKuNS2NLI7HPAlf7MEvg+sicJoutQ+gTxc0WN5l9++eXUqVMnTZp01FFHbd68GZqDaLrOXnvtpeu60pvLLrssOzu7AyFU84hvvvkmACj7r3///iNHjoTOatZ4PQtxTypnuq6bSqWgnSQH7zp4dGXjyvuqDib933ZMQjVXiPmDj+1x4NUu6iBsYBxVHiG2+Sdb/kFThwrPCky3BxnjUlhSzyg59KasXpMAJUWKEmQREkRXbcGqqqpzzz132bJljLEPP/zwjTfe+N3vfteVCi+eqgHA1KlTX3rppaVLl+61114nnHBCx+YgY6yysvKzzz7zXhw7dmwoFGpvLfV6NBqdP39+XV3dpEmTlB+1PYkCgD59+qgsDgAoLy/ftm2baqjb8Vl4Z93F00dEIcRzzz334Ycfjhw58uyzzw4Gg+2cOAOGgFgw7CREKP/0QUjVaYZfomxuQ6Fsvj37BFnTGTPXTvJw994HXpXd9xBApGa8BAkhQXRVCDnnd91117Jly1Rfe9d1lYnWda+aWlLX9RkzZsyYMaOL6rt06dKKigo1p8g5nzp1KnQ2QXj77bf/5S9/AYAhQ4bMmzevV69eHchtei5g161bznljY6Npmh10wEjfLOf8jTfe8CYLU6nU1Vdf3YaIolcwBgCxcPhJgayeW97/m1u3Vjf9wFRnR9xzFWTAGEjXcRxf0eg+k38fyh8KKEkFif8T6GtH/PxQ4/XChQsfeugh5asUQhQUFHh9fb/FBrvuWly0aJGSPSllfn7+6NGj29upZw6+8847AKBp2po1az799NOOFS4UCvl8PmiuvFpWVgYdukYR0XXdv/71r/vvv//kyZNfe+21jpf33l25ciUA+P1+xtijjz6qysu1XDHttJAxRMzoMX7wcfdljZjp8oDrJEFFjbIuVkFjwBhjHEAKJyn0zLzR5wyefg+pIEFCSBB7ZgsyxpLJ5K233hqLxbygj9/+9reqg+63yC/0uvR1HMmitrx582Zv+WHDhnXv3r0DIQSAbdu2lZaWqoPknCeTyY4PpqioKDMzE5rjQlXOfgcSzhj75ptvbrvttq+//vqzzz77y1/+Eo/HuzIZOXjwYACwLItzvnbt2scee6zjtZoKZ6M0Q8UlB93Q/+h7fD0muRKEk5CuzQAZ58A4NGVTpP0xzhhX+oeu5doJF4zwgKMGTr+31/6Xa2YWqSDxfwu5RomfnxByzrdv375kyRJd1xljjuNMnDjxsssuwx8y2tCLrlRJ6K7rSikPOOAA0zQ7Vt+6urq6ujqv0WCvXr3aE07vxfSteS2ZOsCyLNd11eNkMuk97kD4AeDoo48eP3784sWL1X6feOKJs846K72nYztayFWn3EjxmCHT96rf9ln1mrecmnVWY6lMxjUOjHHgGmNMuVUREaUAlAKZ7s/QM0r8BcMLhk+LFI0E4M2NKUgFCRJCgtgTQQKAzMzM/Pz8rVu3AkBBQcF9992XkZHx7czBPTVGZ82atWTJku3bt++///5nnXVWx8sDQCqV8swsVSC7473k5ub27t1bGZEAsHHjxo4lDRGHDh06a9as2bNnB4PBc845JzMzs+N7AlXUNBQKXXjhhZ9++qlKoFy/fv277757+umnd+UzAACUgnEzu/ek7N4T3cTO+tIVscqvRGOpHa+2YjVSuiqFkOumP5xnhnKN7JLM4lHBvAF6IL/5+khGEkiQEBLEt7PMCgsLH3rooXvvvVfX9csuu2zvvffuugp2pUNhB4bUEUcc8fHHH5eXlw8cODAQCEBn9U63b9/uuq6u61LKrKws5UrtAJ/Pp0rVqGNT5l3Hfs5AIPDwww//9re/DQQC/fr1gy5MlKoFpkyZMmDAgHXr1um67rruI488cvLJJ6ueVp1/EFxTGZKMcT1YmDdgSt6AKQCIMiGtepVrCACM6cyfxZg/fRJRSSCpIEFCSBDfSQsPP/zwqVOnejVluqiCXV+ygy0UFBR49V86bXPYt29fxpjSs5KSEpUv33HCflZWlve4tLS042P2OhKrcmtd9A+ra9itW7ezzz77uuuuU3ONH3/88auvvnryySd3+a6iOQ0fEQGby8eEtECo5XkBAEoGAMiAq3gZqqZN/FSgOzLi56qFXo+kDpoltbnixo0bH3jggccff7yysrJTY6uFSqkWuF6Iacf7Ve+OGzfunHPOyc/P79u37+9///tAINDeAXsnNWDAAO/F0tJSJUtd79DbcZ/eFmd03nnnlZSUSCmVzfrwww+7rrunif8qFpTt6q/b8o8BMBVHw3dv5EsQJIQE8e2/u819mrpuCyLijh07jj/++EsuueTcc8+98sorHcfpohZ6FbFVWZauuFWVnAQCgQcffPCjjz766KOPTjjhBOhC66gWXYjVQXZFjLRmuiKc6vDy8vJmzZoFAGqm8JNPPpk3b94eC+HuG27rjyBICAnih7ELu24LKiV76aWXVqxYYRgG5/zTTz9tO3munX3V19e/9NJLs2fPVqZkF48QAAzDGDRoUHFxcRcNNeVNVUe1ZcuWbdu2QRdSAxljiUTi9ddff/LJJ7du3drF80LEWbNmqWBRTdMsy3ryySe9GqT0HSNICAniF4LyLjY0NDz99NNej8Pu3burjL1OOzYAgGVZl1566UknnXTaaaedccYZsVgMuuxW9dyVXTRee/To4fWWCgaD6iC7YkFed911M2bMOPvss0844YTy8nLla+3YqgaAgQMHKlNVMX/+/BUrVpAQEiSEBPEL5Nlnn12+fLmSB0Q8+eSTQ6GQcgl2KjM7d+784IMPdF3XdX3JkiVbtmzpuhCqrImuqKBaZuzYsWPHjhVCIOKMGTMKCws7FVFVZOCDDz7QNM0wjBUrVqxbt66LIg0AJ598ciAQUE2A6+vr77nnHjIKCRJCgvjloOYRo9Howw8/rJotIOLee+992mmnQZczDbKzs0tKSlzXdV23uLhYRY12RUEBYOPGjaozRqfaqTaYl5f3zDPP/Otf//rPf/5z6623duUgEdHn85WUlAghHMfJzc3t1q1bVy6OqhU3ceLEk046yevH9Nprr61atYqEkPiVQOkTxK9CCFVb+dLSUq8X0sUXX5yVldUVd6VaPhwO33vvvQ8//LBlWWeffXZBQUFXEhWklDfffPOjjz6qadrll19+9dVXd/GABw4c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QgjLy8sTiYQSCcMw6uvr58+fn52dvXLlyiuuuMK27Rb6oTyEWVlZt912mzeac86FEIcddpjyeT700ENjx46dNm2a0tG8vLzq6uq///3v06dPj0QiahVN06SUI0aMuOWWW5Sk+f3+l19++Z577mktEmpODgC81TMzM1sotJTSdd1IJLLvvvumv56Xl6fmR9u7gEqA6+vri4uLMzIyIpFIMBgMNWOaZl5enuu6zzzzjOM4d9999+jRo0OhUGZmZiAQMAyj4w9IHeQrr7yiZJJz/sEHH9TU1IwcORK+bXQuQZAQEkRLhBD19fWu6zY2NgJANBqNxWIqnMQbiw855JCJEyd6g68SAMdxjjzyyG3bthUUFKiFP/roo61bt5qm+cUXX3zyySet92UYhqZp+fn5N998s8/n83yAygK75pprli5d+v7771999dU9evQYNWqUijoRQuy3336RSMRxHEQ0TVOF4WRmZk6YMMHb+Jdffqkia1oI1VdffbVx48ZQKPTNN98wxmzbfvXVVwsLC5PJ5Pjx4wsKChDRsyyVvaiElnOeSCS8TaWn8XmmHgD8+c9/vvHGGyORiHJvmqZpmmb6/GVtbe3TTz8tpdx///1LSkpaCLC6t/DiaNIP3rKsRx555L777nv88ccNw3j99dcvvvjiiy++uKCgoE3fL0GQEBLEnqHG8ZycHGUGFRcX+3y+sWPH2rY9ePDgFgLW2nxRM166rvfr10+9MmfOnGQyOWTIkCOPPFLTNKUonnbqur5u3boXXnihpKTENM0WiqIU7q677jr88MMdx0kmk+n7SiQSypOZbpJ6MZnKf5vujUwXwgceeODhhx82TZNznp2dDQDnn38+IjqO89Zbbx1xxBGMsU2bNnHOe/TooaZF1TF7piQiGobRXlBMC21LFzklzHV1dd5ZeNUGWlirbR65bduvv/76nXfeedxxx6nLO3PmzOuvv15KSQmFBAkhQXwPKGtv6tSpU6dO9V5csGBBC6VUJJPJ2tra7t27e0P5tm3bYrFY9+7de/TogYirV6+eP3++3++/5ZZbDjvssDb3eM011zQ0NEyfPt0wDCWT3lvpk4XdunUbN24cpHn/VBJ9iyARZUJ5qejtaUPv3r2HDx+emZkZi8V27tyJiCNGjPD5fLFYLBQKMcbWr1+/cOFCv98/atSo1qv7fL66urq33377uOOOU1oYCASUkHuC57lPWxyD0rP0pIgOkjFUQmH6lc/IyHj77bdN01TbeeSRR9L3SxAkhATxY6CG7O3bt19yySVCiDlz5pimqSyw9evX19TUjBo1SiXOP//882VlZZMnT544caIQ4n//+9/7779/2GGHHXLIIUrz1q5d+8wzz5SUlBx77LGwe+CoNwknhJg+fTo0R7R+x4NXW7jqqqsuu+wy0zSXLl163HHHmab5wgsv9OjRw3GccDicTCavv/768vLyvn37HnLIId5a6vAKCgpCoVB1dfUNN9zwr3/9y+/3x+PxBx54YMKECd4Rqn87CAtScUPK+G6d8tEx6mqrXShFhJ9ViTiChJAgfglCqKI3V6xYsXPnzvvuu+/3v/+9ysP76quvbNseOHCgz+fbunXrnDlzdF0//vjjVejjRx999Le//c3v90+ZMkUJ53PPPVdWVnbxxRf36dMnXedUvEmL/X6PY72atAMAlV+oEg3VfN66deuuu+66BQsW6Lp+3XXXFRcXewemLLmCgoIbbrjhtttuUyG1jLF4PO73+1vYfHV1dU8++WQikWjhQFYO4ZqaGnUZ//GPfxQWFrqu2+LsVKjOqaee2rdv3xZ3AOl+1DazGAmChJAgfliUx3LEiBG33XbbZZdddu+99x5wwAH77ruv67pr1qwxTVPNLz744IObNm0aOnToiSeeqMbrcDis67oXUFpeXv7qq69mZWWdeOKJkFawhjG2efPmuXPnKnNHRYgcc8wx/fv3/x7PQgihYlM9A1Tta9OmTe+8845hGLfddtupp56qEidaxIiecsophx9+eHl5uUqoQEQ1J5oeN1RTU/OXv/ylurq6vfjSbt26aZqmSha0RqVRjhs3rm/fvq3dvz/EzQFBkBASxB5r4ZlnnrlgwYJnn332hhtueOutt6qrq7/44ousrKwxY8Y0NjbOnTs3lUqdffbZeXl5juMYhmHbtpRy8+bNaiOPPvro119/PXXq1P3339+zcpSluGLFit/97ndqsUAgkEwm+/Tp8/0KYYvqayrYhDF2+OGHP//886FQaPLkyUqw21w9OztbRdm0+2vX9fz8fM752LFjCwoKHMfx3lJp/p988omU8rjjjmtRF0bTtGg0+vnnnycSCcoOJEgICeKnzi233PL5559/8MEHjzzyyMCBA1WF0l69enHOH3744SeffPKUU07x3HeJREKlWKh1DzrooBNOOGH69Onpk15qyeLi4iOOOCIYDLqu+/XXX9fU1KT7Hr8XvCgV9TQrKwsAtm/f3qNHj6Kioi1btjz//PNtxuN4wqk0e9q0aT6fr3X4qLIyk8nkNddcs//++7dYvaysbNy4cUKIu+66y4uw9di6dethhx1m2zbViyFICAniJ20UCiFKSkquvvrqSy+99J///Gd2djbnfNy4cSr+c+LEiSrR0JO3yspKzrnq9gAAagElRemxoAAwbty4t99+W+nNPvvsk157uk1N2qMjVyGaKpIlEomoBMR77rln8eLFjLG33nrrr3/96wsvvBCJRGKxWHsb8fl8nHO/33/QQQcFAoEODs+yLJXUofaoJN9LUrQsS2mqZxBzzlskihAECSFB/KS18PTTT583b96bb74ZjUazs7NVmKVqGeGV51YpDeXl5bquV1ZWquG+hQS2liuVNtepVafCXrpuPKk91tfXr1y5cvbs2UqH7rzzzkQiMXLkSNd1MzMzI5FIUVHRmDFjvNqq6TvVNG3Dhg0bN27MysrqtBaMV528ReKH9256oCm0n0dIECSEBPGTQ/kDNU27+eabv/rqq5qamszMzL333ht2b7+ghKS6urq+vt7n8zU2NlZUVBQXF0OHJcE66KCkUJnpuq6vX7++W7durQXJK/uSLq6c8+XLlz/66KPLli375ptvVBE113VHjx592GGHHXzwwbquH3PMMS+88ILrujfccEN7HTOOPfbYzz77bNq0aVlZWRS6SRB7cANNl4D45RmFUsqhQ4cOGDBANRXasGFDC/tMuSLXrl27devWSCRSUVGxePFiZcx9iz16waUZGRmJROLOO+886qijtm/fnh5XoiTQ01HvYNQev/rqqwceeOCrr77KyMjo16+fymd4+umn//jHP06YMAERjzrqqKOPPnrLli033XSTbduu63pdCVWWyJw5cxYuXJifn3/OOee0N4lIEAQJIfGrQCUhfPrpp0uWLPH7/dFo9JZbbkmPkPTMuw8++CAej3PObdt+5513WlTR7DpK8EzTnD179vTp02+55RaVxZ++Nc65ytVbtGiRYRgqJdELTB0xYsQJJ5xwxx13vPvuuw8++KAQwjRNv9+vqpgqBf3jH//Yr1+///73v//61790XVd+WpUssXPnzjvuuCMejx933HHjx49Pz+ojCIKEkPiV8thjjzU0NPTq1Ss/P3/+/PmPP/54eoqeCpCZO3cu5/ycc84ZPHjwG2+8sW7dutat57vC6tWrU6mU3++/6667Fi5c2LNnz2uvvXafffZRtbCDweCSJUtGjRp10EEHTZkyZdGiRYyxQYMGeQIJACNHjnzppZd++9vfDhw4UBVUUxGeqkG8OvJBgwbdcMMNnPO//vWv8+bN03Xdtm1N0xzHueqqq77++uvBgwdfd911rb2vBEGQEBK/LnNQ07TPPvvsrbfeCgQC995775lnnmnb9j333LNp0yZVDlvZUi+//PKKFSv69Onzu9/9btKkSRUVFY888khXnIrpXXbVg5deeqm2tjYajebk5Fx55ZXz5s274447QqGQclqqyi9r1qz54IMPVq1a1djYuN9++5155pnp03gqdEUlNXqN6dMn+VRx8LPOOus3v/lNTU3Nb3/7248++sg0Tcdxrrzyytdeey0cDt911109e/b8gcxBElfiFwwFyxC/KBhjruveeeedVVVVxx577H777de/f//XX3991apVt99++2OPPaYCLMvLy//xj38IIU455ZTMzMxTTjnlueeee/bZZ4899tj999+/RaHtFiro9/uV0ngdmg4++OCXXnrplFNOueiii5SpZ1mWasOkHvfq1eu5556LRqOGYeTm5u67774ZGRktFEvNC3ZQlVsFi952220VFRWzZ88+//zzb7/99gULFjz++OO6rt92222HH354B0e+p3gZjSqch+YdCRJCgvjZmINPP/30ggULcnNzr7jiCgDIy8v7wx/+cOGFF77++uuHHnrozJkzpZTXX3/9mjVr9t577wsvvFBKOW7cuGOPPfaxxx77wx/+8Nprr+Xl5bWpKCrxbunSpXV1dT6fb8mSJYceeqgQ4pBDDnnvvfeGDx8OzYGj6S0alJDMmDGjhYHVQvA6VRrltjUM48EHH/T7/S+99NKFF16ozM3rr7/+wgsvdF33+1JBAGhRWHXr1q21tbXeTQBBkBASxE8OZept37797rvvtm371FNPHT9+vLJpjj/++FdeeeXFF19cuXLlKaecctNNN82ZMyccDt988825ubmu66pi1h9++OGyZcsuu+yyxx9/PBAItNBCpYIbNmw477zzotEoY+z+++/fa6+9jj766EgkMnz4cE8Coa2E+vQa1h2YfR2cnZf/7vP5SkpKDMNQxT+7d+9+xBFHKOlSgUIdbLzj9A/vTAHgv//979dff+33+1Uz5HfffZdzbhiG6m9MuRkECSFB/ORUEAAcx7niiis2btzYv3//G2+80TOwNE37wx/+MG3atNNOO+3//b//d9999wkhrrrqqiOPPFJFXUope/fufcstt/zmN795++23L7zwwn/961+RSMTTQuXGLC8vP/300zdu3Ni9e/dhw4a9++67l156qWVZxx9/PDTP83nuRK+fn9KwFlmM6akUnvyoKtutez6ojavtz50799577/3ss88YY4WFhdFo9KuvvjrssMMuuOCCs846Kzc3F5qTQ9pURCFEexW3W1zMpUuX3nzzzd6Lqtr4EUcc0b9/f0pSJH6BI0inRGPxnVU1Xt4SQfzUUOP7H//4x8zMzKysrNmzZ6d3b/C+uldffXVWVlY4HL7wwgvVKt5bauE77rgjEolkZmYec8wxW7Zs8Yp/SikrKysPP/zwjIyM3Nzcp556Ss0vKgvpggsuWLhwYV1dXYujcl23rKysoaFhj85l0aJFubm5JSUlZWVl3oupVOr111+fNm1adna2YRjFxcU33nhjdXX1Rx99dOCBB/p8vkAgMHbs2HvuuWfbtm1tXh/VxWLUqFHdunVbuHChOrz0dzdv3ty9e/f8/PxVq1Yh4qeffjpz5syzzjrrzDPPPPvss88777z7778/FoulX0+C+MkipdxZVRONxbuycJcmwGPxRDKZysvNpttA4idrDiplevnlly+55JL7778/3ZhTTZSuuOKK999/X0p50kknPfDAA16oS7rtxRi76aab7rvvPsZY7969b7zxxuOOO045Xf/2t7/98Y9/9Pl811577bXXXouIyWTy6quvfu655xoaGrKysvr16xeJRLKzs71i3MqXKKVskcWoInrC4fDtt99eWFioJhHffvvt0tJSzvmcOXMWL17cs2fPDz74ICsra+vWrW+99dacOXOWLVsWjUYzMzMPPvjgq666SjWWAoBEIvHggw/++9//3rJli6Zpffv2nTp16vTp00eNGhUKhdLdmI7j7Ny503XdgoICVYxUvaUOYMuWLRMnTrRt+4MPPhgyZAh9r4if+7BQXVMXCPjDoSBZhMSvxSJExK+//vr4449Xlpn6uqp/N2/ePGzYsGAwmJGR8bvf/c6yrDbNGs+f+ec//1m1sz/vvPNU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" alt="微信 / 支付宝赞赏码" id="sponsor-qrcode">
                <button class="close-sponsor">关闭</button>
            `;
            root.appendChild(sponsorModal);

            // 保存元素引用
            this.elements = {
                btn, overlay, panel, sponsorModal,
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
                closeSponsorBtn: sponsorModal.querySelector('.close-sponsor'),
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
                    if (el.sponsorModal.classList.contains('show')) {
                        this.closeSponsor();
                    } else {
                        this.hidePanel();
                    }
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

            // 赞助按钮
            el.btnSponsor.addEventListener('click', () => this.openSponsor());

            // 检查更新
            if (el.btnCheckUpdate) {
                el.btnCheckUpdate.addEventListener('click', () => this.checkUpdate());
            }

            // 关闭赞助模态框
            el.closeSponsorBtn.addEventListener('click', () => this.closeSponsor());

            // 点击模态框外部关闭
            el.sponsorModal.addEventListener('click', (e) => {
                if (e.target === el.sponsorModal) {
                    this.closeSponsor();
                }
            });

            // 窗口尺寸变化时重新居中赞助弹窗
            window.addEventListener('resize', () => this.centerSponsorModal());
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
            this.closeSponsor();
        }

        // 打开赞赏弹窗（用 JS 计算坐标居中，兼容不支持 translate 居中的内核）
        openSponsor() {
            const modal = this.elements.sponsorModal;
            modal.classList.add('show');
            modal.style.setProperty('display', 'block', 'important');
            modal.style.setProperty('position', 'fixed', 'important');
            modal.style.setProperty('transform', 'none', 'important');
            modal.style.setProperty('margin', '0', 'important');
            modal.style.setProperty('box-sizing', 'border-box', 'important');
            modal.style.setProperty('background', '#ffffff', 'important');
            modal.style.setProperty('border-radius', '20px', 'important');
            modal.style.setProperty('padding', '28px 26px', 'important');
            modal.style.setProperty('text-align', 'center', 'important');
            modal.style.setProperty('z-index', '1000001', 'important');
            modal.style.setProperty('overflow-y', 'auto', 'important');
            this.centerSponsorModal();
            // 图片解码后高度会变化，延迟再校正一次
            setTimeout(() => this.centerSponsorModal(), 120);
        }

        closeSponsor() {
            const modal = this.elements.sponsorModal;
            modal.classList.remove('show');
            modal.style.setProperty('display', 'none', 'important');
        }

        centerSponsorModal() {
            const modal = this.elements && this.elements.sponsorModal;
            if (!modal || !modal.classList.contains('show')) return;

            const vw = window.innerWidth || document.documentElement.clientWidth || 0;
            const vh = window.innerHeight || document.documentElement.clientHeight || 0;
            const width = Math.min(480, Math.max(vw - 24, 240));

            modal.style.setProperty('width', width + 'px', 'important');
            modal.style.setProperty('max-width', 'calc(100vw - 24px)', 'important');
            modal.style.setProperty('max-height', 'calc(100vh - 24px)', 'important');

            const rect = modal.getBoundingClientRect();
            const height = Math.min(rect.height || 0, vh - 24);
            const left = Math.max((vw - width) / 2, 12);
            const top = Math.max((vh - height) / 2, 12);

            modal.style.setProperty('left', left + 'px', 'important');
            modal.style.setProperty('top', top + 'px', 'important');
            modal.style.setProperty('right', 'auto', 'important');
            modal.style.setProperty('bottom', 'auto', 'important');
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new JDCookieHelper());
    } else {
        new JDCookieHelper();
    }

})();
