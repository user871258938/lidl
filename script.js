import createLogger from "logging";
import * as playwright from "playwright";
import axios from "axios";

import dotenv from "dotenv";
import * as fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(scriptDirectory, ".env") });
// .env geladen?
if (!process.env.RUFNUMMER || !process.env.PASSWORD) {
    throw new Error("ENV Fehler: RUFNUMMER oder PASSWORD fehlt oder ist leer");
}

const logger = createLogger("lidl-extender");

function getPositiveNumberFromEnv(name, fallback) {
    const parsed = Number.parseFloat(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPositiveIntegerFromEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Konfiguration
const browserType = process.env.BROWSER || "firefox";
const rufnummer = process.env.RUFNUMMER;
const passwort = process.env.PASSWORD;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const telegramAllow = process.env.TELEGRAM_ALLOW === "true";
const discordAllow = process.env.DISCORD_ALLOW === "true";
const autoUpdate = process.env.AUTO_UPDATE === "true";
const killExistingProcesses = process.env.KILL_EXISTING_PROCESSES === "true";
const killScriptInstances = process.env.KILL_SCRIPT_INSTANCES === "true";
const sleepmode = process.env.SLEEP_MODE || "smart";
const sleepTime = parseInt(process.env.SLEEP_TIME, 10);
const infoLevel = process.env.INFO_LEVEL || process.env.INFOLEVEL || "info";

// Diese Werte werden auch für die automatische Refill-Schwelle verwendet.
// So kann eine abweichende Budget-Konfiguration nicht unbemerkt zu zu kurzen
// Datenchecks führen.
const RATE_LIMIT_10MIN_MAX_REQUESTS = getPositiveIntegerFromEnv("RATE_LIMIT_10MIN_MAX_REQUESTS", 7);
const RATE_LIMIT_60MIN_MAX_REQUESTS = getPositiveIntegerFromEnv("RATE_LIMIT_60MIN_MAX_REQUESTS", 35);

// Sicherheitsmodell für durchgehende Downloads.
// MAX_DOWNLOAD_MBIT muss mindestens der real möglichen Spitzengeschwindigkeit entsprechen.
const MAX_DOWNLOAD_MBIT = getPositiveNumberFromEnv("MAX_DOWNLOAD_MBIT", 55);
const REFILL_SAFETY_RESERVE_GB = getPositiveNumberFromEnv("REFILL_SAFETY_RESERVE_GB", 0.20);
const configuredRefillTriggerGb = getPositiveNumberFromEnv("REFILL_TRIGGER_GB", 0.35);
const REFILL_EXPECTED_GB = getPositiveNumberFromEnv("REFILL_EXPECTED_GB", 1);
const SMART_EARLY_CHECK_SECONDS = getPositiveIntegerFromEnv("SMART_EARLY_CHECK_SECONDS", 5);
const MAX_CHECK_INTERVAL_SECONDS = getPositiveIntegerFromEnv("MAX_CHECK_INTERVAL_SECONDS", 900);
const MIN_CHECK_INTERVAL_SECONDS = getPositiveIntegerFromEnv("MIN_CHECK_INTERVAL_SECONDS", 5);
const configuredDataRenderTimeoutSeconds = getPositiveIntegerFromEnv("DATA_RENDER_TIMEOUT_SECONDS", 25);
const DATA_RENDER_TIMEOUT_SECONDS = Math.max(15, configuredDataRenderTimeoutSeconds);
const keepAliveEnabled = process.env.KEEPALIVE_ENABLED === "true";
const RATE_LIMIT_BACKOFF_MINUTES = getPositiveIntegerFromEnv("RATE_LIMIT_BACKOFF_MINUTES", 20);
const RATE_LIMIT_REPEAT_BACKOFF_MINUTES = getPositiveIntegerFromEnv("RATE_LIMIT_REPEAT_BACKOFF_MINUTES", 30);
const MAINTENANCE_BACKOFF_MINUTES = getPositiveIntegerFromEnv("MAINTENANCE_BACKOFF_MINUTES", 15);
const MAINTENANCE_BACKOFF_MS = MAINTENANCE_BACKOFF_MINUTES * 60 * 1000;
const MAINTENANCE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;
const TOKEN_PREFLIGHT_SECONDS = getPositiveIntegerFromEnv("TOKEN_PREFLIGHT_SECONDS", 300);
const TOKEN_PREFLIGHT_COOLDOWN_MS = getPositiveIntegerFromEnv("TOKEN_PREFLIGHT_COOLDOWN_MINUTES", 15) * 60 * 1000;
const RATE_LIMIT_DETECTION_STATE_VERSION = 2;
const STARTUP_LOGIN_REQUEST_SLOTS = 2;
const VOLUME_READING_TICK_GB = 0.00001; // 10 kB bei dezimaler GB-Anzeige

// Im Idle-Fall muss die nächste Prüfung mindestens so weit auseinanderliegen,
// dass weder das 10-Minuten- noch das 60-Minuten-Fenster blockiert. Die
// Sicherheitsfrist wird auf volle Sekunden aufgerundet; die Refill-Schwelle
// wird mindestens auf den dafür nötigen Wert angehoben.
const RATE_LIMIT_SAFE_MIN_INTERVAL_SECONDS = Math.ceil(Math.max(
    10 * 60 / RATE_LIMIT_10MIN_MAX_REQUESTS,
    60 * 60 / RATE_LIMIT_60MIN_MAX_REQUESTS
));
const RATE_LIMIT_REFILL_MARGIN_GB = getPositiveNumberFromEnv("RATE_LIMIT_REFILL_MARGIN_GB", 0.005);
const RATE_LIMIT_SAFE_REFILL_TRIGGER_GB =
    REFILL_SAFETY_RESERVE_GB +
    VOLUME_READING_TICK_GB +
    (RATE_LIMIT_SAFE_MIN_INTERVAL_SECONDS + SMART_EARLY_CHECK_SECONDS) * MAX_DOWNLOAD_MBIT / 8000 +
    RATE_LIMIT_REFILL_MARGIN_GB;
const MAX_REFILL_TRIGGER_BEFORE_FULL_GB = Math.max(0.05, REFILL_EXPECTED_GB - 0.05);
const REFILL_TRIGGER_GB = Math.min(
    MAX_REFILL_TRIGGER_BEFORE_FULL_GB,
    Math.max(
        configuredRefillTriggerGb,
        REFILL_SAFETY_RESERVE_GB + 0.05,
        RATE_LIMIT_SAFE_REFILL_TRIGGER_GB
    )
);

// URLs
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const loginUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect.html";
const uebersichtUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect/uebersicht.html";

const version = "1.4.24";
const scriptUrl = "https://raw.githubusercontent.com/user871258938/lidl/main/script.js";

class MaintenanceModeError extends Error {
    constructor(url = "") {
        super("Lidl-Seite befindet sich im Wartungsmodus");
        this.name = "MaintenanceModeError";
        this.code = "LIDL_MAINTENANCE_MODE";
        this.url = url;
    }
}

const delay = ms => new Promise(res => setTimeout(res, ms));
const cookiefile = path.join(scriptDirectory, "cookies.json");
const sessionMetaFile = path.join(scriptDirectory, "session_meta.json");
const localScriptPath = path.join(scriptDirectory, "script.js");

// Browser-Fingerprint-Randomisierung (ohne locale/timezone)
function generateFingerprint() {
    // Firefox User-Agents mit verschiedenen Versionen
    const firefoxVersions = [
        { version: '139.0', geckoDate: '20100101' },
        { version: '138.0', geckoDate: '20100101' },
        { version: '137.0', geckoDate: '20100101' },
        { version: '136.0', geckoDate: '20100101' },
        { version: '135.0', geckoDate: '20100101' }
    ];

    // Windows-Versionen
    const windowsVersions = ['10.0', '11.0'];

    // Zufällige Bildschirmauflösungen
    const screenResolutions = [
        '1920x1080', '1366x768', '1440x900', '1600x900', '2560x1440',
        '1920x1200', '2880x1800', '1280x720', '3440x1440'
    ];

    const randomVersion = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
    const randomWindows = windowsVersions[Math.floor(Math.random() * windowsVersions.length)];

    const userAgent = `Mozilla/5.0 (Windows NT ${randomWindows}; Win64; x64; rv:${randomVersion.version}) Gecko/${randomVersion.geckoDate} Firefox/${randomVersion.version}`;

    const screenRes = screenResolutions[Math.floor(Math.random() * screenResolutions.length)];
    const [width, height] = screenRes.split('x').map(Number);

    // Device-spezifische Zufallswerte
    const deviceMemory = [2, 4, 8, 16][Math.floor(Math.random() * 4)];
    const hardwareConcurrency = [2, 4, 6, 8][Math.floor(Math.random() * 4)];

    return {
        userAgent,
        viewport: { width, height },
        deviceMemory,
        hardwareConcurrency,
        // WICHTIG: locale und timezone NICHT randomisiert
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin'
    };
}

// Verbesserte Konstanten für Stabilität
const MAX_LOGIN_ATTEMPTS = 3;
const MAX_CONSECUTIVE_ERRORS = 5;
const SESSION_KEEPALIVE_INTERVAL = 8 * 60 * 1000; // 8 Minuten (Keep-Alive nur bei langen Pausen nötig)
const configuredBrowserRestartHours = Number.parseFloat(process.env.BROWSER_RESTART_INTERVAL_HOURS ?? "0");
const BROWSER_RESTART_INTERVAL = Number.isFinite(configuredBrowserRestartHours) && configuredBrowserRestartHours > 0
    ? configuredBrowserRestartHours * 60 * 60 * 1000
    : 0; // 0 deaktiviert den planmäßigen Neustart; Session bleibt im laufenden Browser.
const MEMORY_CHECK_INTERVAL = 10 * 60 * 1000; // 10 Minuten
const MAX_MEMORY_MB = 500; // Maximaler Speicherverbrauch in MB
const MEMORY_RESTART_THRESHOLD_MB = Math.max(
    MAX_MEMORY_MB + 50,
    getPositiveIntegerFromEnv("MEMORY_RESTART_THRESHOLD_MB", 600)
);
const BROWSER_MEMORY_RESTART_THRESHOLD_MB = getPositiveIntegerFromEnv(
    "BROWSER_MEMORY_RESTART_THRESHOLD_MB",
    1400
);
const MEMORY_RESTART_CONSECUTIVE_SAMPLES = getPositiveIntegerFromEnv(
    "MEMORY_RESTART_CONSECUTIVE_SAMPLES",
    3
);
const MEMORY_RESTART_COOLDOWN_MS = getPositiveIntegerFromEnv(
    "MEMORY_RESTART_COOLDOWN_MINUTES",
    60
) * 60 * 1000;
const SESSION_PERSIST_INTERVAL_MS = 15 * 60 * 1000;


// Globale Variablen mit besserer Verwaltung
let context = null;
let page = null;
let lastActivityTime = Date.now();
let loginAttempts = 0;
let consecutiveErrors = 0;
let keepAliveTimer = null;
let memoryCheckTimer = null;
let browserRestartTimer = null;
let isShuttingDown = false;
let lastBrowserRestart = Date.now();
let lastMemoryRestartAt = 0;
let lastMemoryWarningAt = 0;
let highNodeMemorySamples = 0;
let highBrowserMemorySamples = 0;
let lastBrowserSessionPersistAt = 0;
let lastSessionStorageDiagnosticHash = null;
let lastAuthDiagnosticSignature = "";
let memorySamples = [];
let mainRunInProgress = false;
let keepAliveInProgress = false;
let pendingPlannedRestart = false;
let pendingRestartForceClean = false;
let pendingRestartMustRun = false;
let restartPromise = null;
let updateCheckInProgress = false;
let lastUpdateCheckAt = 0;
let lastDeadlineCollisionAlertAt = 0;
let lastLoginWaitNoticeAt = 0;
const LOGIN_WAIT_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;

// Watchdog-Variablen für Deadlock-Erkennung
let watchdogTimer = null;
let lastHeartbeat = Date.now();
let highCpuCounter = 0;
let lastCpuUsage = process.cpuUsage();
let lastCpuCheck = Date.now();
const WATCHDOG_INTERVAL = 5000; // 5 Sekunden Check
const HEARTBEAT_TIMEOUT = 180000; // 180 Sekunden ohne Heartbeat = Deadlock (3 Minuten) - 60s Buffer zur Keep-Alive
const HIGH_CPU_THRESHOLD = 80; // 80% CPU vom Script
const HIGH_CPU_DURATION = 30000; // 30 Sekunden

// NaN-Fehlertracking
let nanErrorCount = 0;
const MAX_NAN_ERRORS = 3;
let forceFreshOverviewNavigation = false;
let overviewFreshFromLogin = false;

// Zeitpunkt des letzten erfolgreichen main()-Laufs (für Keep-Alive-Throttling)
let lastMainRunTime = 0;

// Erwarteter Zeitpunkt des nächsten runMain()-Aufrufs (geplanter Sleep - verhindert Watchdog-Fehlalarme)
let nextScheduledRun = 0;

// Rate-Limit exponentieller Backoff
let rateLimitBackoffCount = 0;
let rateLimitBackoffUntil = 0;
let rateLimitRecoverySuccessCount = 0;
let rateLimitBackoffReason = "Rate-Limit";
let maintenanceActive = false;
let maintenanceBackoffUntil = 0;
let lastMaintenanceNoticeAt = 0;
let lastTokenPreflightAt = 0;

// Zentrales Rolling-Window-Budget für alle Top-Level-Seitenaufrufe.
// Die Log-Auswertung zeigte das praktische Limit nach ca. 38-40 Aufrufen in rund 60 Minuten.
const RATE_LIMIT_SAFETY_MS = 5000;
const RATE_LIMIT_WINDOWS = [
    {
        label: "10min",
        durationMs: 10 * 60 * 1000,
        maxRequests: RATE_LIMIT_10MIN_MAX_REQUESTS
    },
    {
        label: "60min",
        durationMs: 60 * 60 * 1000,
        maxRequests: RATE_LIMIT_60MIN_MAX_REQUESTS
    }
];
const RATE_LIMIT_HISTORY_MS = Math.max(...RATE_LIMIT_WINDOWS.map(window => window.durationMs)) + RATE_LIMIT_SAFETY_MS;

// Debug und Persistenz: Zeitstempel jeder Top-Level-Navigation.
const pageRequestLog = [];
const PAGE_REQUEST_LOG_MAX = 200; // Maximal 200 Einträge behalten
let pageRequestReservationQueue = Promise.resolve();

function prunePageRequestLog(now = Date.now()) {
    const cutoff = now - RATE_LIMIT_HISTORY_MS;
    while (pageRequestLog.length > 0 && pageRequestLog[0].time < cutoff) {
        pageRequestLog.shift();
    }
}

function trackPageRequest(label, time = Date.now()) {
    pageRequestLog.push({ time, label });
    pageRequestLog.sort((a, b) => a.time - b.time);
    prunePageRequestLog(time);
    if (pageRequestLog.length > PAGE_REQUEST_LOG_MAX) pageRequestLog.shift();
    saveSessionMeta();
    return time;
}

function getRequestBudgetState(now = Date.now(), requestedSlots = 1) {
    prunePageRequestLog(now);
    let waitUntil = now;
    const blockedWindows = [];

    for (const window of RATE_LIMIT_WINDOWS) {
        const recentRequests = pageRequestLog.filter(entry => entry.time >= now - window.durationMs);
        const allowedExistingRequests = Math.max(0, window.maxRequests - requestedSlots);
        if (recentRequests.length > allowedExistingRequests) {
            const requestsThatMustExpire = recentRequests.length - allowedExistingRequests;
            const firstBlockingIndex = requestsThatMustExpire - 1;
            const availableAt = recentRequests[firstBlockingIndex].time + window.durationMs + RATE_LIMIT_SAFETY_MS;
            if (availableAt > waitUntil) waitUntil = availableAt;
            blockedWindows.push(`${window.label}=${recentRequests.length}/${window.maxRequests} (+${requestedSlots})`);
        }
    }

    return {
        delayMs: Math.max(0, waitUntil - now),
        waitUntil,
        blockedWindows
    };
}

function getRequestWindowUsage(now = Date.now()) {
    prunePageRequestLog(now);
    return RATE_LIMIT_WINDOWS.map(window => ({
        label: window.label,
        count: pageRequestLog.filter(entry => entry.time >= now - window.durationMs).length,
        maxRequests: window.maxRequests
    }));
}

async function reservePageRequest(label, requestedSlots = 1) {
    let releaseReservation;
    const previousReservation = pageRequestReservationQueue;
    pageRequestReservationQueue = new Promise(resolve => {
        releaseReservation = resolve;
    });
    let budgetWaitLogAt = 0;

    await previousReservation;
    try {
        while (!isShuttingDown) {
            const budget = getRequestBudgetState(Date.now(), requestedSlots);
            if (budget.delayMs <= 0) break;

            const waitSeconds = Math.ceil(budget.delayMs / 1000);
            const now = Date.now();
            const isSessionCheckRequest = label === "login";
            const isLoginSubmitRequest = label === "login-submit";
            const isLoginRequest = isSessionCheckRequest || isLoginSubmitRequest;
            const authenticationWaitSubject = isSessionCheckRequest ? "Session-Prüfung" : "Login";
            // Lange Budget-Wartezeiten können mehrere Minuten dauern. Ein
            // Eintrag am Anfang, alle fünf Minuten und kurz vor dem Ende reicht
            // für die Diagnose und verhindert Log-Spam im Minutentakt.
            const shouldLogBudgetWait =
                budgetWaitLogAt === 0 ||
                now - budgetWaitLogAt >= 5 * 60 * 1000 ||
                waitSeconds <= 15;
            const safeDeadline = getSafeCheckDeadline(lastSchedulingVolume, lastSchedulingBaselineAt);
            const deadlineCollision = safeDeadline > 0 && budget.waitUntil > safeDeadline;
            let userNoticeSent = false;
            if (deadlineCollision && shouldLogBudgetWait) {
                const lateBySeconds = Math.ceil((budget.waitUntil - safeDeadline) / 1000);
                logger.error(`Request-Budget kollidiert mit Daten-Deadline (${budget.blockedWindows.join(", ")}; ${lateBySeconds}s zu spät). Ohne Download-Drosselung ist die Kontinuität nicht garantiert.`);
                if (Date.now() - lastDeadlineCollisionAlertAt >= 10 * 60 * 1000) {
                    lastDeadlineCollisionAlertAt = Date.now();
                    if (isLoginRequest) {
                        userNoticeSent = true;
                        lastLoginWaitNoticeAt = Date.now();
                        sendMessage(`⏳ ${authenticationWaitSubject} wartet wegen des Request-Budgets ca. ${waitSeconds}s.`, "info");
                    } else {
                        sendMessage(
                            `⚠️ Request-Budget blockiert einen rechtzeitigen Datencheck um ${lateBySeconds}s. Download bitte drosseln/pausieren.`,
                            "warn"
                        );
                    }
                }
            }

            if (
                isLoginRequest &&
                waitSeconds >= 30 &&
                !userNoticeSent &&
                Date.now() - lastLoginWaitNoticeAt >= LOGIN_WAIT_NOTICE_COOLDOWN_MS
            ) {
                lastLoginWaitNoticeAt = Date.now();
                sendMessage(`⏳ ${authenticationWaitSubject} wird wegen des Request-Budgets für ca. ${waitSeconds}s pausiert.`, "info");
            }

            if (shouldLogBudgetWait) {
                logger.info(`Preemptiv gedrosselt vor ${label}: ${waitSeconds}s (${budget.blockedWindows.join(", ")})`);
                budgetWaitLogAt = now;
            }
            nextScheduledRun = budget.waitUntil;
            updateHeartbeat();
            await delay(Math.min(budget.delayMs, 60000));
        }

        if (isShuttingDown) {
            throw new Error("Shutdown während Request-Budget-Wartezeit");
        }
        return trackPageRequest(label);
    } finally {
        nextScheduledRun = 0;
        releaseReservation();
    }
}

function logRateLimitStats() {
    const now = Date.now();
    const windows = [1, 2, 5, 10, 60];
    const parts = windows.map(min => {
        const since = now - min * 60 * 1000;
        const count = pageRequestLog.filter(e => e.time >= since).length;
        return `${min}min=${count}`;
    });
    logger.info(`📈 Rate-Limit Debug: Seitenaufrufe (${parts.join(', ')})`);
    // Letzte 10 Anfragen mit Label
    const last10 = pageRequestLog.slice(-10).map(e => {
        const sAgo = Math.round((now - e.time) / 1000);
        return `${e.label}(-${sAgo}s)`;
    }).join(', ');
    logger.info(`📈 Rate-Limit Debug letzte Aufrufe: ${last10}`);
}

// Letztes erfolgreich gelesenes Datenvolumen (für Rate-Limit-Bucket-Zuordnung)
let lastKnownDatenVolumen = 0;
let lastVolumeMeasurementAt = 0;
let lastSchedulingVolume = 0;
let lastSchedulingBaselineAt = 0;
let refillFollowupPending = false;
let lastRefillAt = 0;

// Letzter Page-Error (Vue-Abstürze etc.) – wird vor jeder Navigation zurückgesetzt
let lastPageErrors = [];
let navigationNetworkEvents = [];
let navigationRetryAfterUntil = 0;
let navigationDiagnosticsGeneration = 0;
const requestDiagnosticsGenerations = new WeakMap();
const NAVIGATION_NETWORK_EVENT_MAX = 60;

function resetPageErrors() {
    lastPageErrors = [];
}

function hasSessionRefreshError() {
    return lastPageErrors.some(error =>
        /not refresh token|currentCustomer.*undefined|currentCustomer.*not defined/i.test(error)
    );
}

// Sichere Diagnose der Auth-Daten: Es werden niemals Tokenwerte geloggt,
// sondern nur Hash, Größe, erkannte Felder und eine optionale Ablaufzeit.
function inspectSessionStorageData(data) {
    const entries = Object.entries(data || {}).sort(([a], [b]) => a.localeCompare(b));
    const canonical = entries.map(([key, value]) => `${key}=${String(value)}`).join("\n");
    const diagnostics = {
        hash: createHash("sha256").update(canonical).digest("hex").slice(0, 12),
        keys: entries.map(([key]) => key),
        entries: entries.length,
        bytes: Buffer.byteLength(canonical, "utf8"),
        hasAccessToken: false,
        hasRefreshToken: false,
        expiresAt: 0
    };

    const considerExpiry = value => {
        if (!Number.isFinite(value)) return;
        const milliseconds = value > 100000000000 ? value : value * 1000;
        if (milliseconds > Date.now() - 86400000 &&
            (diagnostics.expiresAt === 0 || milliseconds < diagnostics.expiresAt)) {
            diagnostics.expiresAt = milliseconds;
        }
    };
    const inspectValue = (value, propertyName = "") => {
        if (typeof value === "string") {
            if (/access.?token/i.test(propertyName)) diagnostics.hasAccessToken = true;
            if (/refresh.?token/i.test(propertyName)) diagnostics.hasRefreshToken = true;
            const jwtParts = value.split(".");
            if (jwtParts.length === 3) {
                try {
                    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8"));
                    considerExpiry(payload.exp);
                } catch (_) {}
            }
            return;
        }
        if (!value || typeof value !== "object") return;
        for (const [key, nestedValue] of Object.entries(value)) {
            if (/access.?token/i.test(key)) diagnostics.hasAccessToken = true;
            if (/refresh.?token/i.test(key)) diagnostics.hasRefreshToken = true;
            if (/^(exp|expires.?at|expiration)$/i.test(key)) considerExpiry(Number(nestedValue));
            inspectValue(nestedValue, key);
        }
    };

    for (const [, rawValue] of entries) {
        try {
            inspectValue(JSON.parse(String(rawValue)));
        } catch (_) {
            inspectValue(String(rawValue));
        }
    }
    return diagnostics;
}

function logSessionStorageDiagnostics(reason, data, level = "info") {
    const diagnostics = inspectSessionStorageData(data);
    const expiresIn = diagnostics.expiresAt > 0
        ? `${Math.round((diagnostics.expiresAt - Date.now()) / 1000)}s`
        : "unbekannt";
    const message =
        `SessionStorage-Diagnose${reason ? ` ${reason}` : ""}: ` +
        `hash=${diagnostics.hash}, keys=${diagnostics.keys.join(",") || "-"}, ` +
        `entries=${diagnostics.entries}, bytes=${diagnostics.bytes}, ` +
        `access=${diagnostics.hasAccessToken ? "ja" : "nein"}, ` +
        `refresh=${diagnostics.hasRefreshToken ? "ja" : "nein"}, expiresIn=${expiresIn}`;
    if (lastSessionStorageDiagnosticHash && lastSessionStorageDiagnosticHash !== diagnostics.hash) {
        logger.info(`SessionStorage-Hash geändert: ${lastSessionStorageDiagnosticHash}→${diagnostics.hash}`);
    }
    lastSessionStorageDiagnosticHash = diagnostics.hash;
    if (level === "debug") logger.debug(message);
    else logger.info(message);
}

async function getLiveSessionStorageSnapshot() {
    if (!page || page.isClosed() || !isTrustedLidlUrl(page.url())) return null;
    try {
        const data = await page.evaluate(() => {
            const result = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                result[key] = sessionStorage.getItem(key);
            }
            return result;
        });
        return {
            data,
            diagnostics: inspectSessionStorageData(data)
        };
    } catch (error) {
        logger.debug(`SessionStorage-Preflight nicht lesbar: ${error.message}`);
        return null;
    }
}

// Auth-Fehler sollen im Nachhinein nachvollziehbar sein, ohne Tokenwerte oder
// Zugangsdaten zu protokollieren. Die Signatur verhindert identischen Spam bei
// mehreren Recovery-Schritten desselben Navigationsversuchs.
async function logAuthFailureDiagnostics(reason) {
    const pageErrors = lastPageErrors
        .slice(-4)
        .map(error => String(error).replace(/\s+/g, " ").substring(0, 180))
        .join(" | ") || "keine";
    const network = getNavigationNetworkSummary();
    const safeUrl = getCurrentDiagnosticUrl();
    const budget = getRequestBudgetState(Date.now(), 1);
    const signature = `${reason}|${safeUrl}|${pageErrors}|${network}`;
    if (signature === lastAuthDiagnosticSignature) return;
    lastAuthDiagnosticSignature = signature;

    logger.warn(
        `Auth-Diagnose ${reason}: URL=${safeUrl}; ` +
        `Page-Errors=${pageErrors}; Netzwerk=${network}; ` +
        `Budget=${budget.blockedWindows.join(", ") || "frei"}, ` +
        `Wartezeit=${Math.ceil(budget.delayMs / 1000)}s`
    );

    if (page && !page.isClosed() && isTrustedLidlUrl(page.url())) {
        try {
            const ssData = await page.evaluate(() => {
                const result = {};
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    result[key] = sessionStorage.getItem(key);
                }
                return result;
            });
            logSessionStorageDiagnostics(`Auth-Fehler (${reason})`, ssData, "info");
        } catch (error) {
            logger.warn(`Auth-Diagnose SessionStorage nicht lesbar: ${error.message}`);
        }
    }
}

function logDataExtractionDiagnostics(usage, navigationState, startedAt, outcome = "unbekannt") {
    const budget = getRequestBudgetState(Date.now(), 1);
    const safeUrl = getCurrentDiagnosticUrl();
    const pageErrors = lastPageErrors
        .slice(-3)
        .map(error => String(error).replace(/\s+/g, " ").substring(0, 140))
        .join(" | ") || "keine";
    const selectors = Array.isArray(usage?._debugSelectors)
        ? JSON.stringify(usage._debugSelectors)
        : "nicht-erfasst";
    logger.debug(
        `Daten-Diagnose ${outcome}: URL=${safeUrl}; navigation=${navigationState}; ` +
        `render=${Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1)}s; ` +
        `tarif=${Number.isFinite(usage?.tarif?.available) ? usage.tarif.available : "NaN"}; ` +
        `refill=${Number.isFinite(usage?.refill?.available) ? usage.refill.available : "NaN"}; ` +
        `DOM=${selectors}; Page-Errors=${pageErrors}; Netzwerk=${getNavigationNetworkSummary()}; ` +
        `Budget=${budget.blockedWindows.join(", ") || "frei"}`
    );
}

function resetNavigationDiagnostics() {
    navigationDiagnosticsGeneration++;
    navigationNetworkEvents = [];
    navigationRetryAfterUntil = 0;
    lastAuthDiagnosticSignature = "";
}

function sanitizeDiagnosticUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const safePath = parsed.pathname
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
            .replace(/\d{6,}/g, "[id]");
        return `${parsed.hostname}${safePath}`;
    } catch (_) {
        return "unbekannte-url";
    }
}

function isTrustedLidlUrl(rawUrl) {
    try {
        const hostname = new URL(rawUrl).hostname.toLowerCase();
        return hostname === "lidl-connect.de" || hostname.endsWith(".lidl-connect.de");
    } catch (_) {
        return false;
    }
}

function isMaintenanceUrl(rawUrl) {
    try {
        const pathname = new URL(rawUrl).pathname.toLowerCase();
        return pathname.includes("/wartung") || pathname.includes("/maintenance");
    } catch (_) {
        return false;
    }
}

function getCurrentDiagnosticUrl() {
    try {
        return page && !page.isClosed() ? sanitizeDiagnosticUrl(page.url()) : "keine-seite";
    } catch (_) {
        return "keine-seite";
    }
}

function addNavigationNetworkEvent(event) {
    navigationNetworkEvents.push({ time: Date.now(), ...event });
    if (navigationNetworkEvents.length > NAVIGATION_NETWORK_EVENT_MAX) {
        navigationNetworkEvents.splice(
            0,
            navigationNetworkEvents.length - NAVIGATION_NETWORK_EVENT_MAX
        );
    }
}

function parseRetryAfterUntil(value, now = Date.now()) {
    if (typeof value !== "string" || value.trim() === "") return 0;
    const seconds = Number.parseFloat(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return now + seconds * 1000;
    }
    const absolute = Date.parse(value);
    return Number.isFinite(absolute) && absolute > now ? absolute : 0;
}

function getNavigationNetworkSummary() {
    if (navigationNetworkEvents.length === 0) {
        return "keine relevanten document/XHR/fetch-Antworten erfasst";
    }

    return navigationNetworkEvents.slice(-12).map(event => {
        if (event.failure) {
            return `${event.method} ${event.type} FEHLER ${event.url} (${event.failure})`;
        }
        return `${event.method} ${event.type} HTTP ${event.status} ${event.url}`;
    }).join(" | ");
}


// Aktueller Browser-Fingerprint (für konsistente Session-Wiederherstellung)
let currentFingerprint = null;

// Telegram: ID der jeweils ersetzbaren Status-Nachricht
let lastTelegramStatusMessageId = null;
let preserveCurrentTelegramStatusOnNextSend = false;
let telegramOperationQueue = Promise.resolve();
let authRecoveryNoticeActive = false;

// Circuit Breaker Pattern
class CircuitBreaker {
    constructor(threshold = 5, timeout = 60000) {
        this.threshold = threshold;
        this.timeout = timeout;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    }

    async execute(operation) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                this.state = 'HALF_OPEN';
                logger.info('Circuit breaker: Versuche HALF_OPEN');
            } else {
                throw new Error('Circuit breaker is OPEN');
            }
        }

        try {
            const result = await operation();
            this.onSuccess();
            return result;
        } catch (error) {
            if (error?.code === "LIDL_MAINTENANCE_MODE") {
                throw error;
            }
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        this.failureCount = 0;
        this.state = 'CLOSED';
    }

    onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.failureCount >= this.threshold) {
            this.state = 'OPEN';
            logger.error(`Circuit breaker OPEN nach ${this.failureCount} Fehlern`);
        }
    }

    reset() {
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
        logger.info('Circuit breaker zurückgesetzt');
    }
}

const circuitBreaker = new CircuitBreaker(MAX_CONSECUTIVE_ERRORS, 5 * 60 * 1000);

// Heartbeat-Signal für Watchdog
function updateHeartbeat() {
    lastHeartbeat = Date.now();
}

// Watchdog-Funktion zur Deadlock-Erkennung
function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    watchdogTimer = setInterval(async () => {
        if (isShuttingDown) return;

        const now = Date.now();
        const timeSinceLastHeartbeat = now - lastHeartbeat;
        
        // CPU-Auslastung vom Script selbst berechnen
        const currentCpuUsage = process.cpuUsage(lastCpuUsage);
        const elapseMs = now - lastCpuCheck;
        
        // CPU-Zeit in Millisekunden
        const cpuTimeMs = (currentCpuUsage.user + currentCpuUsage.system) / 1000;
        
        // CPU-Auslastung in Prozent (eines Cores)
        const cpuPercent = (cpuTimeMs / elapseMs) * 100;
        
        // Update für nächsten Check
        lastCpuUsage = process.cpuUsage();
        lastCpuCheck = now;

        // Deadlock-Erkennung: Kein Heartbeat für zu lange
        // Ausnahme: Geplanter Sleep (Rate-Limit-Backoff, normales Interval) → kein Fehlalarm
        if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
            if (nextScheduledRun > 0 && now < nextScheduledRun + 30000) {
                lastHeartbeat = now; // Heartbeat während geplantem Sleep auto-aktualisieren
                return;
            }
            logger.error(`🚨 WATCHDOG: Deadlock erkannt! Kein Heartbeat seit ${timeSinceLastHeartbeat}ms - Versuche Browser-Restart`);
            sendMessage(`🚨 WATCHDOG: Script scheint zu hängen (${timeSinceLastHeartbeat}ms kein Heartbeat) - Versuche Restart`, "warn");
            
            try {
                await restartBrowser(false);
                logger.info("Browser nach Deadlock erfolgreich neu gestartet");
                return; // Fortfahren mit nächstem Check
            } catch (restartError) {
                logger.error(`Browser-Restart nach Deadlock fehlgeschlagen: ${restartError.message} - Erzwinge Shutdown`);
                gracefulShutdown('WATCHDOG_DEADLOCK_RESTART_FAILED');
            }
            return;
        }

        // CPU-Überwachung (nur vom Script selbst)
        if (cpuPercent > HIGH_CPU_THRESHOLD) {
            highCpuCounter++;
            logger.warn(`⚠️ WATCHDOG: Hohe CPU-Auslastung erkannt (${Math.round(cpuPercent)}%) [${highCpuCounter}x]`);

            if (highCpuCounter * WATCHDOG_INTERVAL > HIGH_CPU_DURATION) {
                logger.error(`🚨 WATCHDOG: Script verbraucht ${Math.round(cpuPercent)}% CPU für ${(highCpuCounter * WATCHDOG_INTERVAL / 1000).toFixed(1)}s - Erzwinge Restart`);
                sendMessage(`🚨 WATCHDOG: Script verbraucht ${Math.round(cpuPercent)}% CPU - Browser wird neu gestartet`, "warn");
                highCpuCounter = 0;
                try {
                    await restartBrowserWhenIdle("Browser-Neustart wegen hoher CPU-Auslastung", false);
                } catch (restartError) {
                    logger.error(`Browser-Neustart nach hoher CPU-Auslastung fehlgeschlagen: ${restartError.message}`);
                }
            }
        } else {
            highCpuCounter = 0; // Reset bei normaler CPU
        }

        logger.debug(`WATCHDOG: Heartbeat ok, Script-CPU: ${Math.round(cpuPercent)}%, Speicher: ${getMemoryUsage().rss}MB`);
    }, WATCHDOG_INTERVAL);
}

function stopWatchdog() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

// Funktion zum Zurücksetzen der NaN-Fehler
function resetNanErrors() {
    nanErrorCount = 0;
}

// Funktion zum Killen von existierenden script.js-Instanzen
async function killExistingScriptInstances() {
    try {
        const isWindows = process.platform === 'win32';
        const isLinux = process.platform === 'linux';
        const isMac = process.platform === 'darwin';
        const currentPid = process.pid;
        const candidatePids = [];
        const normalizedLocalScriptPath = localScriptPath.replace(/\\/g, '/');
        const escapedLocalScriptPath = normalizedLocalScriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const localScriptArgumentPattern = new RegExp(
            `(?:^|\\s|["'])${escapedLocalScriptPath}(?=["']|\\s|$)`,
            isWindows ? 'i' : ''
        );
        const referencesThisScript = commandLine =>
            typeof commandLine === "string" &&
            localScriptArgumentPattern.test(commandLine.replace(/\\/g, '/'));

        if (isWindows) {
            // tasklist enthält keine Kommandozeile und der Altcode beendete dadurch
            // versehentlich jeden node.exe-Prozess. CIM liefert PID + CommandLine.
            const command = [
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
                "Select-Object ProcessId,CommandLine",
                "ConvertTo-Json -Compress"
            ].join(" | ");
            const output = execFileSync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", command],
                { encoding: "utf-8", timeout: 10000 }
            ).trim();
            if (output) {
                const parsed = JSON.parse(output);
                const processes = Array.isArray(parsed) ? parsed : [parsed];
                for (const processInfo of processes) {
                    if (
                        Number.isInteger(processInfo.ProcessId) &&
                        referencesThisScript(processInfo.CommandLine)
                    ) {
                        candidatePids.push(processInfo.ProcessId);
                    }
                }
            }
        } else if (isLinux || isMac) {
            const output = execFileSync("ps", ["-eo", "pid=,args="], {
                encoding: "utf-8",
                timeout: 10000
            });
            for (const line of output.split("\n")) {
                const match = line.match(/^\s*(\d+)\s+(.+)$/);
                if (!match) continue;
                const pid = Number.parseInt(match[1], 10);
                const commandLine = match[2];
                if (/\bnode(?:js)?\b/i.test(commandLine) && referencesThisScript(commandLine)) {
                    candidatePids.push(pid);
                }
            }
        }

        const signaledPids = [];
        for (const pid of [...new Set(candidatePids)]) {
            if (pid === currentPid || !Number.isInteger(pid)) continue;
            try {
                // Windows emuliert SIGTERM nicht: Node beendet den Zielprozess dort
                // sofort, ohne dessen Signal-Handler auszuführen. Auf POSIX dagegen
                // darf die alte Instanz Session und Browser sauber schließen.
                process.kill(pid, isWindows ? "SIGKILL" : "SIGTERM");
                signaledPids.push(pid);
                if (isWindows) {
                    logger.warn(`Lidl-Extender Prozess ${pid} unter Windows sofort beendet`);
                } else {
                    logger.info(`Lidl-Extender Prozess ${pid}: SIGTERM gesendet`);
                }
            } catch (_) {
                // Prozess ist bereits weg oder darf nicht beendet werden.
            }
        }

        if (signaledPids.length > 0 && !isWindows) {
            // gracefulShutdown benötigt im Altprozess mehrere Sekunden. Erst danach
            // Session-Metadaten laden und einen neuen Browser öffnen.
            const isProcessAlive = pid => {
                try {
                    process.kill(pid, 0);
                    return true;
                } catch (error) {
                    return error?.code === "EPERM";
                }
            };
            const shutdownDeadline = Date.now() + 10000;
            while (
                Date.now() < shutdownDeadline &&
                signaledPids.some(isProcessAlive)
            ) {
                await delay(250);
            }

            const stillRunning = signaledPids.filter(isProcessAlive);
            for (const pid of stillRunning) {
                try {
                    process.kill(pid, "SIGKILL");
                    logger.warn(`Lidl-script.js Prozess ${pid} nach 10s zwangsweise beendet`);
                } catch (_) {}
            }
            if (stillRunning.length > 0) await delay(500);

            logger.info(`✅ Insgesamt ${signaledPids.length} alte script.js-Instanz(en) beendet`);
        } else if (signaledPids.length > 0) {
            // Der Windows-Prozess ist bereits hart beendet. Verwaiste Browser werden
            // anschließend separat durch killExistingPlaywright() bereinigt.
            await delay(500);
            logger.info(`✅ Insgesamt ${signaledPids.length} alte Lidl-Extender-Instanz(en) beendet`);
        } else {
            logger.info("✅ Keine alten Lidl-Extender-Instanzen gefunden");
        }
    } catch (error) {
        logger.warn(`Fehler beim Killen von script.js-Instanzen: ${error.message}`);
    }
}
async function killExistingPlaywright() {
    try {
        const isWindows = process.platform === 'win32';
        const isLinux = process.platform === 'linux';
        const isMac = process.platform === 'darwin';

        let processesKilled = 0;
        const { execSync } = await import('child_process');

        if (isWindows) {
            // Auf Windows: taskkill für Playwright-Browser-Prozesse
            const browsers = [
                { name: 'chrome.exe', display: 'Chrome' },
                { name: 'chromium.exe', display: 'Chromium' },
                { name: 'firefox.exe', display: 'Firefox' },
                { name: 'msedgedriver.exe', display: 'Edge' }
            ];

            for (const browser of browsers) {
                try {
                    execSync(`taskkill /F /IM ${browser.name} 2>nul`, { stdio: 'pipe' });
                    processesKilled++;
                    logger.info(`${browser.display}-Prozess beendet`);
                } catch (err) {
                    // Prozess nicht gefunden ist ok
                }
            }
        } else if (isLinux || isMac) {
            // Schritt 1: Hauptprozesse via -no-remote Flag per SIGTERM beenden
            // (gibt Firefox Chance, eigene Child-Prozesse sauber zu beenden)
            try {
                const output = execSync(`pgrep -f '(firefox|chromium|chrome).*(-no-remote|ms-playwright)' 2>/dev/null || true`, { encoding: 'utf-8' });
                const pids = output.trim().split('\n').filter(l => l.length > 0 && /^\d+$/.test(l.trim())).map(l => l.trim());
                for (const pid of pids) {
                    try {
                        execSync(`kill ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
                        processesKilled++;
                        logger.info(`Playwright-Browserprozess ${pid} beendet`);
                    } catch (_) {}
                }
            } catch (err) {
                // keine Playwright-Prozesse gefunden
            }

            // Schritt 2: Verbleibende Child-Prozesse (contentproc, gpu, socket etc.) per SIGKILL bereinigen
            // Nötig wenn der Hauptprozess durch SIGKILL starb und die Kinder bereits orphaned sind
            if (processesKilled > 0) {
                await delay(300);
                try {
                    execSync(`pkill -9 -f 'ms-playwright' 2>/dev/null || true`, { stdio: 'pipe' });
                } catch (_) {}
            }
        }

        if (processesKilled > 0) {
            logger.info(`✅ Insgesamt ${processesKilled} Browser-Prozess(e) gekillt`);
            await delay(1000); // Wartezeit um sicherzustellen dass Prozesse gelöscht sind
        } else {
            logger.info("✅ Keine laufenden Browser-Prozesse gefunden");
        }
    } catch (error) {
        logger.warn(`Fehler beim Killen von Playwright-Prozessen: ${error.message}`);
    }
}

// Memory Monitoring
function getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024) // MB
    };
}

// Node-RSS allein enthält den Firefox-Prozess nicht. Für die Diagnose wird
// deshalb zusätzlich der RSS der zu dieser Session gehörenden Playwright-
// Browserprozesse ermittelt. Bei Fehlern wird bewusst nur "unbekannt" geliefert.
function getBrowserProcessMemoryUsage() {
    const result = { rss: 0, processes: 0 };
    try {
        if (process.platform === "linux" || process.platform === "darwin") {
            const output = execFileSync("ps", ["-eo", "pid=,rss=,args="], {
                encoding: "utf-8",
                timeout: 5000
            });
            for (const line of output.split("\n")) {
                const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
                if (!match) continue;
                const commandLine = match[3];
                if (!/(?:firefox|chrom(?:e|ium)|msedge)/i.test(commandLine)) continue;
                if (!/(?:lidl-extender-data|ms-playwright)/i.test(commandLine)) continue;
                result.rss += Number.parseInt(match[2], 10) / 1024;
                result.processes++;
            }
        } else if (process.platform === "win32") {
            const command = [
                "Get-CimInstance Win32_Process",
                "Where-Object { $_.Name -match 'firefox|chrome|chromium|msedge' -and $_.CommandLine -match 'lidl-extender-data|ms-playwright' }",
                "Select-Object ProcessId,WorkingSetSize",
                "ConvertTo-Json -Compress"
            ].join(" | ");
            const output = execFileSync(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", command],
                { encoding: "utf-8", timeout: 5000 }
            ).trim();
            if (output) {
                const parsed = JSON.parse(output);
                for (const processInfo of (Array.isArray(parsed) ? parsed : [parsed])) {
                    if (!Number.isFinite(processInfo.WorkingSetSize)) continue;
                    result.rss += processInfo.WorkingSetSize / 1024 / 1024;
                    result.processes++;
                }
            }
        }
    } catch (_) {
        return { rss: null, processes: null };
    }
    if (result.processes === 0) {
        return { rss: null, processes: 0 };
    }
    return {
        rss: Math.round(result.rss),
        processes: result.processes
    };
}

async function checkMemoryUsage() {
    const memory = getMemoryUsage();
    const browserMemory = getBrowserProcessMemoryUsage();
    const now = Date.now();
    const previous = memorySamples[memorySamples.length - 1];
    const first = memorySamples[0];
    const pageCount = context
        ? (() => {
            try { return context.pages().length; } catch (_) { return 0; }
        })()
        : 0;
    memorySamples.push({
        time: now,
        ...memory,
        browserRss: browserMemory.rss
    });
    if (memorySamples.length > 36) memorySamples.shift();
    const deltaSinceLast = previous
        ? `, Δ letzte Prüfung=${memory.rss - previous.rss >= 0 ? "+" : ""}${memory.rss - previous.rss}MB`
        : "";
    const deltaSinceFirst = first
        ? `, Δ Verlauf=${memory.rss - first.rss >= 0 ? "+" : ""}${memory.rss - first.rss}MB/${Math.round((now - first.time) / 60000)}min`
        : "";
    const deltaBrowserSinceLast = previous && browserMemory.rss !== null && previous.browserRss !== null
        ? `, Δ Browser-RSS letzte Prüfung=${browserMemory.rss - previous.browserRss >= 0 ? "+" : ""}${browserMemory.rss - previous.browserRss}MB`
        : "";
    logger.info(
        `Memory usage: RSS=${memory.rss}MB, Heap=${memory.heapUsed}/${memory.heapTotal}MB, ` +
        `External=${memory.external}MB, Seiten=${pageCount}, ` +
        `Browser-RSS=${browserMemory.rss === null ? "unbekannt" : `${browserMemory.rss}MB/${browserMemory.processes} Prozesse`}` +
        `${deltaSinceLast}${deltaSinceFirst}${deltaBrowserSinceLast}`
    );

    // Ein gleichmäßiger Anstieg ist für die Fehlersuche hilfreicher als nur
    // ein einzelner Grenzwert. Die Samples bleiben klein und werden begrenzt.
    const browserRssDelta = previous && browserMemory.rss !== null && previous.browserRss !== null
        ? browserMemory.rss - previous.browserRss
        : 0;
    if (previous && (memory.rss - previous.rss >= 25 || browserRssDelta >= 50)) {
        logger.warn(
            `Memory-Trend: RSS stieg seit der letzten Prüfung um ${memory.rss - previous.rss}MB ` +
            `(Heap ${memory.heapUsed - previous.heapUsed >= 0 ? "+" : ""}${memory.heapUsed - previous.heapUsed}MB, ` +
            `Browser-RSS ${browserRssDelta >= 0 ? "+" : ""}${browserRssDelta}MB, Seiten=${pageCount})`
        );
    }

    highNodeMemorySamples = memory.rss >= MEMORY_RESTART_THRESHOLD_MB
        ? highNodeMemorySamples + 1
        : 0;
    highBrowserMemorySamples = browserMemory.rss !== null &&
        browserMemory.rss >= BROWSER_MEMORY_RESTART_THRESHOLD_MB
        ? highBrowserMemorySamples + 1
        : 0;

    if (memory.rss > MAX_MEMORY_MB || highBrowserMemorySamples > 0) {
        let memoryRestartScheduled = false;
        if (memory.rss > MAX_MEMORY_MB && now - lastMemoryWarningAt >= MEMORY_RESTART_COOLDOWN_MS) {
            lastMemoryWarningAt = now;
            logger.warn(`Hoher Speicherverbrauch: ${memory.rss}MB > ${MAX_MEMORY_MB}MB`);
            sendMessage(`⚠️ Hoher Speicherverbrauch: ${memory.rss}MB`, "warn");
        }

        // Force garbage collection wenn verfügbar
        if (global.gc) {
            global.gc();
            logger.info("Garbage collection ausgeführt");
        }

        // Ein dauerhaft wachsender Playwright-/Node-Kontext wird im Leerlauf
        // mit bestehender Session neu aufgebaut. Dadurch bleibt der reguläre
        // Datencheck unberührt und ein anstehender Refill-Folgecheck hat Vorrang.
        if (
            (
                highNodeMemorySamples >= MEMORY_RESTART_CONSECUTIVE_SAMPLES ||
                highBrowserMemorySamples >= MEMORY_RESTART_CONSECUTIVE_SAMPLES
            ) &&
            now - lastMemoryRestartAt >= MEMORY_RESTART_COOLDOWN_MS &&
            !restartPromise &&
            !isShuttingDown
        ) {
            lastMemoryRestartAt = now;
            const memoryReason = highBrowserMemorySamples >= MEMORY_RESTART_CONSECUTIVE_SAMPLES
                ? `Browser-RSS ${browserMemory.rss}MB über ${BROWSER_MEMORY_RESTART_THRESHOLD_MB}MB`
                : `Node-RSS ${memory.rss}MB über ${MEMORY_RESTART_THRESHOLD_MB}MB`;
            logger.warn(
                `${memoryReason} seit ${MEMORY_RESTART_CONSECUTIVE_SAMPLES} Prüfungen - ` +
                "Browser-Neustart wird im Leerlauf eingeplant"
            );
            sendMessage(
                `🔄 Speicherbereinigung: Browser-Neustart eingeplant (${memoryReason})`,
                "warn"
            );
            try {
                await restartBrowserWhenIdle(
                    "Browser-Neustart wegen anhaltend hohem Speicherverbrauch",
                    false,
                    true
                );
                memoryRestartScheduled = true;
                highNodeMemorySamples = 0;
                highBrowserMemorySamples = 0;
            } catch (restartError) {
                lastMemoryRestartAt = 0;
                logger.error(`Speicherbedingter Browser-Neustart fehlgeschlagen: ${restartError.message}`);
            }
        }

        // Kritischer Speicherverbrauch bleibt ein sofortigerer Fallback.
        if (!memoryRestartScheduled && memory.rss > MAX_MEMORY_MB * 1.5) {
            logger.error("Kritischer Speicherverbrauch - Browser restart");
            await restartBrowserWhenIdle("Browser-Neustart wegen kritischem Speicherverbrauch", false);
        }
    }
}

// Session-Metadaten verwalten (verbessert)
function loadSessionMeta() {
    try {
        if (!fs.existsSync(sessionMetaFile)) return;

        const sessionMeta = JSON.parse(fs.readFileSync(sessionMetaFile, "utf-8"));
        const now = Date.now();
        const restoredRequests = Array.isArray(sessionMeta.pageRequestLog)
            ? sessionMeta.pageRequestLog
                .filter(entry =>
                    Number.isFinite(entry?.time) &&
                    typeof entry?.label === "string" &&
                    entry.time >= now - RATE_LIMIT_HISTORY_MS &&
                    entry.time <= now + RATE_LIMIT_SAFETY_MS
                )
                .sort((a, b) => a.time - b.time)
                .slice(-PAGE_REQUEST_LOG_MAX)
            : [];

        pageRequestLog.splice(0, pageRequestLog.length, ...restoredRequests);
        lastActivityTime = Number.isFinite(sessionMeta.lastActivity) ? sessionMeta.lastActivity : lastActivityTime;
        lastBrowserRestart = Number.isFinite(sessionMeta.browserRestartTime) ? sessionMeta.browserRestartTime : lastBrowserRestart;
        lastKnownDatenVolumen = Number.isFinite(sessionMeta.lastKnownDatenVolumen) ? sessionMeta.lastKnownDatenVolumen : 0;
        lastVolumeMeasurementAt = Number.isFinite(sessionMeta.lastVolumeMeasurementAt) ? sessionMeta.lastVolumeMeasurementAt : 0;
        lastSchedulingVolume = Number.isFinite(sessionMeta.lastSchedulingVolume) ? sessionMeta.lastSchedulingVolume : lastKnownDatenVolumen;
        lastSchedulingBaselineAt = Number.isFinite(sessionMeta.lastSchedulingBaselineAt)
            ? sessionMeta.lastSchedulingBaselineAt
            : lastVolumeMeasurementAt;
        refillFollowupPending = sessionMeta.refillFollowupPending === true ||
            sessionMeta.refillVerificationPending === true; // Migration von frühem 1.4.4-State
        lastRefillAt = Number.isFinite(sessionMeta.lastRefillAt) ? sessionMeta.lastRefillAt : 0;
        lastTelegramStatusMessageId = Number.isInteger(sessionMeta.lastTelegramStatusMessageId)
            ? sessionMeta.lastTelegramStatusMessageId
            : null;
        rateLimitBackoffCount = Number.isInteger(sessionMeta.rateLimitBackoffCount) ? sessionMeta.rateLimitBackoffCount : 0;
        const backoffStateCompatible =
            sessionMeta.rateLimitDetectionStateVersion === RATE_LIMIT_DETECTION_STATE_VERSION;
        rateLimitBackoffUntil = backoffStateCompatible &&
            Number.isFinite(sessionMeta.rateLimitBackoffUntil) &&
            sessionMeta.rateLimitBackoffUntil > now
            ? sessionMeta.rateLimitBackoffUntil
            : 0;
        if (!backoffStateCompatible) {
            const hadActiveLegacyBackoff =
                Number.isFinite(sessionMeta.rateLimitBackoffUntil) &&
                sessionMeta.rateLimitBackoffUntil > now;
            rateLimitBackoffCount = 0;
            if (hadActiveLegacyBackoff) {
                logger.info("Veralteten 1.4.4-Rate-Limit-Backoff wegen korrigierter Erkennung verworfen");
            }
        }
        rateLimitRecoverySuccessCount = backoffStateCompatible &&
            Number.isInteger(sessionMeta.rateLimitRecoverySuccessCount)
            ? Math.max(0, sessionMeta.rateLimitRecoverySuccessCount)
            : 0;
        rateLimitBackoffReason = typeof sessionMeta.rateLimitBackoffReason === "string"
            ? sessionMeta.rateLimitBackoffReason.substring(0, 80)
            : "Rate-Limit";
        maintenanceBackoffUntil = Number.isFinite(sessionMeta.maintenanceBackoffUntil) &&
            sessionMeta.maintenanceBackoffUntil > now
            ? sessionMeta.maintenanceBackoffUntil
            : 0;
        maintenanceActive = maintenanceBackoffUntil > 0 || sessionMeta.maintenanceActive === true;
        lastMaintenanceNoticeAt = Number.isFinite(sessionMeta.lastMaintenanceNoticeAt)
            ? sessionMeta.lastMaintenanceNoticeAt
            : 0;
        lastTokenPreflightAt = Number.isFinite(sessionMeta.lastTokenPreflightAt)
            ? sessionMeta.lastTokenPreflightAt
            : 0;

        logger.info(`Session-Metadaten geladen (${pageRequestLog.length} Seitenaufrufe im Rolling Window)`);
    } catch (error) {
        logger.warn(`Fehler beim Laden der Session-Metadaten: ${error.message}`);
    }
}

function saveSessionMeta() {
    try {
        prunePageRequestLog();
        const sessionMeta = {
            scriptVersion: version,
            rateLimitDetectionStateVersion: RATE_LIMIT_DETECTION_STATE_VERSION,
            lastActivity: lastActivityTime,
            loginTime: Date.now(),
            // userAgent wird jetzt dynamisch generiert, nicht gespeichert
            browserRestartTime: lastBrowserRestart,
            memoryUsage: getMemoryUsage(),
            pageRequestLog,
            lastKnownDatenVolumen,
            lastVolumeMeasurementAt,
            lastSchedulingVolume,
            lastSchedulingBaselineAt,
            refillFollowupPending,
            lastRefillAt,
            lastTelegramStatusMessageId,
            rateLimitBackoffCount,
            rateLimitBackoffUntil,
            rateLimitRecoverySuccessCount,
            rateLimitBackoffReason,
            maintenanceActive,
            maintenanceBackoffUntil,
            lastMaintenanceNoticeAt,
            lastTokenPreflightAt
        };
        fs.writeFileSync(sessionMetaFile, JSON.stringify(sessionMeta, null, 2));
    } catch (error) {
        logger.warn(`Fehler beim Speichern der Session-Metadaten: ${error.message}`);
    }
}

function enterMaintenanceBackoff(error) {
    const now = Date.now();
    const shouldNotify = !maintenanceActive ||
        now - lastMaintenanceNoticeAt >= MAINTENANCE_NOTICE_COOLDOWN_MS;
    maintenanceActive = true;
    maintenanceBackoffUntil = now + MAINTENANCE_BACKOFF_MS;

    logger.warn(
        `Lidl-Wartungsseite erkannt (${error?.url ? sanitizeDiagnosticUrl(error.url) : "unbekannte-url"}) - ` +
        `keine Login-/Browser-Recovery, nächster Versuch in ${MAINTENANCE_BACKOFF_MINUTES} Minuten`
    );
    if (shouldNotify) {
        lastMaintenanceNoticeAt = now;
        sendMessage(
            `🛠️ Lidl-Seite im Wartungsmodus – nächster Versuch in ${MAINTENANCE_BACKOFF_MINUTES} Minuten.`,
            "warn"
        );
    }
    saveSessionMeta();
    return {
        datenVolumen: 0,
        statusMessage: null,
        maintenanceBackoffSeconds: Math.ceil(MAINTENANCE_BACKOFF_MS / 1000)
    };
}

function markMaintenanceRecovered() {
    if (!maintenanceActive && maintenanceBackoffUntil === 0) return;
    maintenanceActive = false;
    maintenanceBackoffUntil = 0;
    lastMaintenanceNoticeAt = 0;
    logger.info("Lidl-Wartungsmodus beendet - regulärer Datencheck wieder möglich");
}

// Verbessertes Keep-Alive mit Fehlerbehandlung
async function keepSessionAlive() {
    if (!page || page.isClosed() || isShuttingDown) return;

    if (Date.now() < maintenanceBackoffUntil) {
        logger.debug("Keep-Alive übersprungen - Lidl-Wartungsmodus aktiv");
        updateHeartbeat();
        return;
    }

    if (mainRunInProgress || keepAliveInProgress || restartPromise) {
        logger.debug("Keep-Alive übersprungen - Browseroperation läuft bereits");
        updateHeartbeat();
        return;
    }

    if (
        nextScheduledRun > Date.now() &&
        nextScheduledRun - Date.now() <= SESSION_KEEPALIVE_INTERVAL
    ) {
        logger.debug("Keep-Alive übersprungen - regulärer Datencheck ist bereits zeitnah geplant");
        updateHeartbeat();
        return;
    }

    // Skip während aktivem Rate-Limit-Backoff
    if (Date.now() < rateLimitBackoffUntil) {
        const remainingSec = Math.round((rateLimitBackoffUntil - Date.now()) / 1000);
        logger.debug(`Keep-Alive übersprungen - Rate-Limit Backoff aktiv, noch ${remainingSec}s`);
        updateHeartbeat();
        return;
    }

    // Skip wenn main() kürzlich gelaufen ist (verhindert Rate-Limit durch Doppel-Requests)
    const timeSinceLastMain = Date.now() - lastMainRunTime;
    if (timeSinceLastMain < SESSION_KEEPALIVE_INTERVAL) {
        logger.debug(`Keep-Alive übersprungen - main() lief vor ${Math.round(timeSinceLastMain / 1000)}s`);
        updateHeartbeat();
        return;
    }

    const keepAliveBudget = getRequestBudgetState();
    if (keepAliveBudget.delayMs > 0) {
        logger.debug(`Keep-Alive übersprungen - Request-Budget knapp (${keepAliveBudget.blockedWindows.join(", ")})`);
        updateHeartbeat();
        return;
    }

    keepAliveInProgress = true;
    try {
        const keepAlivePromise = (async () => {
            await reservePageRequest('keepalive-reload');
            resetPageErrors();
            resetNavigationDiagnostics();
            await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
            lastActivityTime = Date.now();
            saveSessionMeta();
            updateHeartbeat(); // Watchdog-Signal
            logger.info("Session Keep-Alive erfolgreich");
        })();

        await Promise.race([
            keepAlivePromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Keep-alive timeout')), 20000)
            )
        ]);
    } catch (error) {
        logger.warn(`Keep-Alive fehlgeschlagen: ${error.message}`);
        consecutiveErrors++;

        if (consecutiveErrors >= 3) {
            logger.error("Mehrere Keep-Alive Fehler - Browser restart");
            await restartBrowserWhenIdle("Browser-Neustart nach mehreren Keep-Alive-Fehlern", false);
        }
    } finally {
        keepAliveInProgress = false;
    }
}

// Playwrights storageState() enthält kein sessionStorage. Deshalb wird der
// aktuelle Inhalt des Lidl-Tabs vor jedem Session-erhaltenden Schließen separat
// in dieselbe Datei geschrieben. So wird kein beim Betrieb rotierter Auth-Token
// durch einen älteren Snapshot ersetzt.
async function persistCurrentBrowserSession(reason = "") {
    if (!context) return false;

    try {
        let existing = {};
        if (fs.existsSync(cookiefile)) {
            try {
                existing = JSON.parse(fs.readFileSync(cookiefile, "utf-8"));
            } catch (_) {}
        }

        const updated = await context.storageState();
        let liveSessionStorageCaptured = false;
        let sessionStorageCount = 0;

        if (page && !page.isClosed() && isTrustedLidlUrl(page.url())) {
            const ssData = await page.evaluate(() => {
                const result = {};
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    result[key] = sessionStorage.getItem(key);
                }
                return result;
            });
            sessionStorageCount = Object.keys(ssData).length;
            logSessionStorageDiagnostics(
                reason || "live",
                ssData,
                reason === "nach Datencheck" ? "debug" : "info"
            );
            updated._sessionStorage = {
                origin: new URL(page.url()).origin,
                data: ssData
            };
            liveSessionStorageCaptured = true;
        } else if (existing._sessionStorage) {
            // Nur als Fallback, wenn gerade kein auslesbarer Lidl-Tab existiert.
            // Der normale Shutdown-/Restart-Pfad verwendet immer den Live-Stand.
            updated._sessionStorage = existing._sessionStorage;
            sessionStorageCount = Object.keys(existing._sessionStorage.data || {}).length;
            logSessionStorageDiagnostics(`${reason || "Fallback"} (Fallback)`, existing._sessionStorage.data, "debug");
        }

        if (currentFingerprint) {
            updated._fingerprint = {
                userAgent: currentFingerprint.userAgent,
                viewport: currentFingerprint.viewport,
                deviceMemory: currentFingerprint.deviceMemory,
                hardwareConcurrency: currentFingerprint.hardwareConcurrency
            };
        } else if (existing._fingerprint) {
            updated._fingerprint = existing._fingerprint;
        }

        fs.writeFileSync(cookiefile, JSON.stringify(updated, null, 2));
        const sessionLogMessage =
            `Session-Daten${reason ? ` ${reason}` : ""} aktualisiert ` +
            `(${sessionStorageCount} sessionStorage-Einträge${liveSessionStorageCaptured ? ", live" : ", Fallback"})`;
        if (reason === "nach Datencheck") {
            logger.debug(sessionLogMessage);
        } else {
            logger.info(sessionLogMessage);
        }
        return liveSessionStorageCaptured;
    } catch (error) {
        logger.warn(`Session-Daten${reason ? ` ${reason}` : ""} konnten nicht aktualisiert werden: ${error.message}`);
        return false;
    }
}

// Sicheres Browser-Schließen
async function closeBrowserSafely() {
    try {
        if (page && !page.isClosed()) {
            await page.close();
            page = null;
        }
    } catch (error) {
        logger.warn(`Fehler beim Schließen der Seite: ${error.message}`);
    }

    try {
        if (context) {
            await context.close();
            context = null;
        }
    } catch (error) {
        logger.warn(`Fehler beim Schließen des Contexts: ${error.message}`);
    }
}

// Browser-Neustart Funktion
// forceClean=false: Session-Daten behalten (geplanter Neustart)
// forceClean=true:  Session-Daten löschen (Fehler-Neustart)
async function restartBrowser(forceClean = true) {
    if (restartPromise) {
        logger.debug("Browser-Neustart läuft bereits - warte auf denselben Vorgang");
        return restartPromise;
    }

    restartPromise = (async () => {
        logger.info("Browser wird neu gestartet...");

        try {
            const memoryBeforeRestart = getMemoryUsage();
            const browserMemoryBeforeRestart = getBrowserProcessMemoryUsage();
            if (!forceClean) {
                const liveSessionSaved = await persistCurrentBrowserSession("vor Browser-Neustart");
                if (!liveSessionSaved) {
                    logger.warn("Browser-Neustart verwendet mangels auslesbarem Lidl-Tab den letzten Session-Snapshot");
                }
            }
            await closeBrowserSafely();

            // Kurze Pause vor Neustart
            await delay(5000);

            const success = await initializeBrowser(forceClean);
            if (success) {
                lastBrowserRestart = Date.now();
                consecutiveErrors = 0;
                loginAttempts = 0;
                resetPageErrors(); // Page-Errors nach Restart löschen (sonst Fehlalarm beim nächsten Login-Versuch)
                resetNavigationDiagnostics();
                circuitBreaker.reset();
                // Ein erfolgreicher (insbesondere forceClean-)Restart erfüllt auch
                // einen währenddessen vorgemerkten schwächeren Timer-/Recovery-Restart.
                pendingPlannedRestart = false;
                pendingRestartForceClean = false;
                pendingRestartMustRun = false;
                updateHeartbeat(); // Signalisiere Watchdog dass Browser aktiv ist
                if (global.gc) global.gc();
                await delay(1000);
                const memoryAfterRestart = getMemoryUsage();
                const browserMemoryAfterRestart = getBrowserProcessMemoryUsage();
                logger.info(
                    `Speicher vor/nach Browser-Neustart: RSS ${memoryBeforeRestart.rss}→${memoryAfterRestart.rss}MB, ` +
                    `Heap ${memoryBeforeRestart.heapUsed}→${memoryAfterRestart.heapUsed}MB`
                );
                logger.info(
                    `Browser-Speicher vor/nach Neustart: ` +
                    `${browserMemoryBeforeRestart.rss === null ? "unbekannt" : `${browserMemoryBeforeRestart.rss}MB`} -> ` +
                    `${browserMemoryAfterRestart.rss === null ? "unbekannt" : `${browserMemoryAfterRestart.rss}MB`}`
                );
                logger.info("Browser erfolgreich neu gestartet");
                sendMessage("🔄 Browser wurde neu gestartet", "info");
                return true;
            }
            throw new Error("Browser-Neustart fehlgeschlagen");
        } catch (error) {
            logger.error(`Browser-Neustart fehlgeschlagen: ${error.message}`);
            consecutiveErrors++;
            throw error;
        }
    })();

    try {
        return await restartPromise;
    } finally {
        restartPromise = null;
    }
}

async function restartBrowserWhenIdle(reason, forceClean = false, deferForPendingRefill = false) {
    if (
        mainRunInProgress ||
        keepAliveInProgress ||
        (deferForPendingRefill && refillFollowupPending)
    ) {
        pendingPlannedRestart = true;
        pendingRestartForceClean = pendingRestartForceClean || forceClean;
        pendingRestartMustRun = pendingRestartMustRun || !deferForPendingRefill;
        logger.info(
            deferForPendingRefill
                ? `${reason} wird bis nach einem geeigneten Refill-Folgecheck verschoben`
                : `${reason} wird bis nach dem laufenden Datencheck verschoben`
        );
        return false;
    }

    logger.info(reason);
    return restartBrowser(forceClean);
}

// Verbesserte Browser-Initialisierung
// forceClean=true:  Session-Daten löschen → frischer Login (bei Fehlern)
// forceClean=false: Session-Daten behalten → bestehende Session wiederverwenden
async function initializeBrowser(forceClean = true) {
    if (isShuttingDown) return false;

    try {
        await closeBrowserSafely();

        const userDataDir = path.join(scriptDirectory, "lidl-extender-data");

        if (forceClean) {
            // Lösche Browser-Daten für frischen Login (nur bei Fehler-Neustarts)
            logger.info("Lösche Browser-Daten für frischen Login...");
            try {
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                    logger.info("userDataDir gelöscht");
                }
                if (fs.existsSync(cookiefile)) {
                    fs.unlinkSync(cookiefile);
                    logger.info("cookies.json gelöscht");
                }
            } catch (cleanupError) {
                logger.warn(`Bereinigung fehlgeschlagen: ${cleanupError.message}`);
            }
        } else {
            logger.info("Browser-Neustart mit bestehender Session (keine Daten gelöscht)");
        }

        // Fingerprint: bei Session-Reuse gespeicherten Fingerprint verwenden (konsistente Session), sonst neu generieren
        let fingerprint = null;
        if (!forceClean && fs.existsSync(cookiefile)) {
            try {
                const savedData = JSON.parse(fs.readFileSync(cookiefile, 'utf-8'));
                if (savedData._fingerprint) {
                    fingerprint = { ...savedData._fingerprint, locale: 'de-DE', timezoneId: 'Europe/Berlin' };
                    logger.info(`🎭 Browser-Fingerprint aus Session wiederhergestellt: UA=${fingerprint.userAgent.substring(0, 60)}...`);
                }
            } catch (_) {}
        }
        if (!fingerprint) {
            fingerprint = generateFingerprint();
            logger.info(`🎭 Neue Browser-Fingerprint: UA=${fingerprint.userAgent.substring(0, 60)}..., Viewport=${fingerprint.viewport.width}x${fingerprint.viewport.height}, Memory=${fingerprint.deviceMemory}GB, Cores=${fingerprint.hardwareConcurrency}`);
            // Sofort in cookies.json sichern, damit der Fingerprint beim nächsten Neustart wiederverwendet wird
            // (nicht erst nach Login – Session könnte dauerhaft gültig bleiben ohne je neu einzuloggen)
            if (!forceClean && fs.existsSync(cookiefile)) {
                try {
                    const cookieData = JSON.parse(fs.readFileSync(cookiefile, 'utf-8'));
                    cookieData._fingerprint = {
                        userAgent: fingerprint.userAgent,
                        viewport: fingerprint.viewport,
                        deviceMemory: fingerprint.deviceMemory,
                        hardwareConcurrency: fingerprint.hardwareConcurrency
                    };
                    fs.writeFileSync(cookiefile, JSON.stringify(cookieData, null, 2));
                } catch (_) {}
            }
        }
        currentFingerprint = fingerprint;

        const browserOptions = {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--disable-extensions",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding"
            ],
            userAgent: fingerprint.userAgent,
            locale: fingerprint.locale,
            timezoneId: fingerprint.timezoneId
        };

        context = await playwright[browserType].launchPersistentContext(
            userDataDir,
            browserOptions
        );

        // Bei Session-Reuse: gespeicherte Cookies und localStorage in den Context laden
        if (!forceClean && fs.existsSync(cookiefile)) {
            try {
                const storageState = JSON.parse(fs.readFileSync(cookiefile, 'utf-8'));
                let cookieCount = 0;
                let lsCount = 0;

                if (storageState.cookies?.length > 0) {
                    await context.addCookies(storageState.cookies);
                    cookieCount = storageState.cookies.length;
                }

                // localStorage wiederherstellen via InitScript (läuft vor jedem Seiten-Script)
                if (storageState.origins?.length > 0) {
                    const lsData = {};
                    for (const origin of storageState.origins) {
                        if (origin.localStorage?.length > 0) {
                            lsData[origin.origin] = origin.localStorage;
                            lsCount += origin.localStorage.length;
                        }
                    }
                    if (lsCount > 0) {
                        await context.addInitScript((data) => {
                            const items = data[window.location.origin];
                            if (items) {
                                for (const { name, value } of items) {
                                    try { localStorage.setItem(name, value); } catch (_) {}
                                }
                            }
                        }, lsData);
                    }
                }

                // sessionStorage wiederherstellen via InitScript (Vue-App Auth-Tokens)
                // Playwright's storageState() erfasst kein sessionStorage → manuell gesichert
                let ssCount = 0;
                if (storageState._sessionStorage?.data) {
                    const ssOrigin = storageState._sessionStorage.origin;
                    const ssData = storageState._sessionStorage.data;
                    ssCount = Object.keys(ssData).length;
                    logSessionStorageDiagnostics("wiederhergestellt", ssData);
                    if (ssCount > 0) {
                        await context.addInitScript(({ origin, data }) => {
                            if (window.location.origin === origin) {
                                for (const [key, value] of Object.entries(data)) {
                                    try { sessionStorage.setItem(key, value); } catch (_) {}
                                }
                            }
                        }, { origin: ssOrigin, data: ssData });
                    }
                }

                logger.info(`Session geladen: ${cookieCount} Cookies, ${lsCount} localStorage, ${ssCount} sessionStorage Einträge`);
            } catch (cookieError) {
                logger.warn(`Session-Daten konnten nicht geladen werden: ${cookieError.message}`);
            }
        }

        logger.info("Browser erfolgreich gestartet");
        page = await context.newPage();

        // Setze Viewport und Device-Properties basierend auf generierter Fingerprint
        await page.setViewportSize(fingerprint.viewport);
        await page.addInitScript(`
            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => ${fingerprint.deviceMemory}
            });
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => ${fingerprint.hardwareConcurrency}
            });
        `);

        // Event Listeners für Debugging
        page.on('request', request => {
            requestDiagnosticsGenerations.set(request, navigationDiagnosticsGeneration);
            logger.debug(`Request: ${request.method()} ${sanitizeDiagnosticUrl(request.url())}`);
        });

        page.on('response', response => {
            logger.debug(`Response: ${response.status()} ${sanitizeDiagnosticUrl(response.url())}`);
            try {
                const request = response.request();
                if (requestDiagnosticsGenerations.get(request) !== navigationDiagnosticsGeneration) {
                    return;
                }
                const type = request.resourceType();
                const status = response.status();
                const relevantType = type === "document" || type === "xhr" || type === "fetch";
                if (relevantType) {
                    addNavigationNetworkEvent({
                        method: request.method(),
                        type,
                        status,
                        url: sanitizeDiagnosticUrl(response.url()),
                        trusted: isTrustedLidlUrl(response.url())
                    });

                    if (status === 429 && isTrustedLidlUrl(response.url())) {
                        const retryAfter = response.headers()["retry-after"];
                        navigationRetryAfterUntil = Math.max(
                            navigationRetryAfterUntil,
                            parseRetryAfterUntil(retryAfter)
                        );
                    }
                }
            } catch (_) {
                // Die Diagnose darf den eigentlichen Seitenablauf nie beeinflussen.
            }
        });

        page.on('requestfailed', request => {
            try {
                if (requestDiagnosticsGenerations.get(request) !== navigationDiagnosticsGeneration) {
                    return;
                }
                const type = request.resourceType();
                if (type === "document" || type === "xhr" || type === "fetch") {
                    addNavigationNetworkEvent({
                        method: request.method(),
                        type,
                        failure: request.failure()?.errorText || "unbekannt",
                        url: sanitizeDiagnosticUrl(request.url()),
                        trusted: isTrustedLidlUrl(request.url())
                    });
                }
            } catch (_) {
                // Nur Diagnose.
            }
        });

        page.on('pageerror', error => {
            const message = String(error.message || error).replace(/\s+/g, " ").substring(0, 500);
            logger.error(
                `Page error: ${message} ` +
                `(URL=${getCurrentDiagnosticUrl()}, Netzwerk=${getNavigationNetworkSummary()})`
            );
            lastPageErrors.push(message);
            if (lastPageErrors.length > 20) lastPageErrors.shift();
        });

        page.on('crash', () => {
            const memory = getMemoryUsage();
            logger.error(
                `Page crashed! (URL=${getCurrentDiagnosticUrl()}, ` +
                `RSS=${memory.rss}MB, Page-Errors=${lastPageErrors.length})`
            );
            consecutiveErrors++;
        });

        return true;
    } catch (error) {
        logger.error(`Fehler bei Browser-Initialisierung: ${error.message}`);
        consecutiveErrors++;
        return false;
    }
}

// Wartet auf vollständiges Rendern der Vue-Daten auf der Übersichtsseite
async function navigateAndWaitForData(navigationStartedAt = Date.now()) {
    if (page && isMaintenanceUrl(page.url())) {
        logger.warn(`Wartungsseite direkt erkannt: ${sanitizeDiagnosticUrl(page.url())}`);
        return "maintenance";
    }

    // Zuerst ausschließlich auf echte Zahlen (oder ein sichtbares Login-Formular)
    // warten. Der Lidl-Platzhalter ist während des Vue-Ladens kurz sichtbar und darf
    // deshalb nicht selbst das Wait vorzeitig beenden.
    const renderDeadline =
        navigationStartedAt + DATA_RENDER_TIMEOUT_SECONDS * 1000;
    try {
        const remainingRenderWaitMs = Math.max(
            1000,
            renderDeadline - Date.now()
        );
        const readyStateHandle = await page.waitForFunction(() => {
            const visible = el => !!el &&
                !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            const maintenance = /(?:wartung|maintenance)/i.test(location.pathname) ||
                /(?:wartung|maintenance)/i.test(document.title || '');
            if (maintenance) return 'maintenance';
            const loginForm = document.querySelector('app-login-v2, .login-wrapper');
            if (visible(loginForm)) {
                return 'login';
            }

            const candidates = [
                document.querySelector('label[for="DATA"].unit-display'),
                document.querySelector('app-consumptions-v2 label[for="DATA"]'),
                document.querySelector('app-consumptions label[for="DATA"]'),
                document.querySelector('app-consumptions-v2 .unit-display'),
                document.querySelector('app-consumptions .unit-display'),
                document.querySelector('[data-type="DATA"] .unit-display'),
                document.querySelector('[data-type="DATA"]'),
            ];
            return candidates.some(el => visible(el) && /\d/.test(el.textContent)) ? 'data' : false;
        }, null, { timeout: remainingRenderWaitMs, polling: 250 });
        try {
            return await readyStateHandle.jsonValue();
        } finally {
            await readyStateHandle.dispose();
        }
    } catch (error) {
        if (isShuttingDown || page?.isClosed()) throw error;

        // Auch ein vorzeitiger waitForFunction-Abbruch (z.B. beim SPA-Kontextwechsel)
        // darf die Platzhalterklassifizierung nicht wieder auf ~1s verkürzen.
        const remainingUntilClassification = renderDeadline - Date.now();
        if (remainingUntilClassification > 0) {
            await delay(remainingUntilClassification);
        }
        logger.debug(
            `Weder Tarifzahl noch Login-Formular innerhalb von ${DATA_RENDER_TIMEOUT_SECONDS}s sichtbar`
        );

        // Kein Reload: Der Platzhalter muss danach in drei DOM-Proben stabil
        // sichtbar bleiben. Er ist beim normalen Vue-Start kurz zu sehen und war
        // im Jul-29-Log nach rund einer Sekunde die Ursache der False Positives.
        let stablePlaceholderSamples = 0;
        for (let sample = 0; sample < 3; sample++) {
            const state = await page.evaluate(() => {
                const visible = el => !!el &&
                    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                const maintenance = /(?:wartung|maintenance)/i.test(location.pathname) ||
                    /(?:wartung|maintenance)/i.test(document.title || '');
                if (maintenance) return 'maintenance';
                const loginForm = document.querySelector('app-login-v2, .login-wrapper');
                if (visible(loginForm)) return 'login';

                const dataCandidates = [
                    document.querySelector('label[for="DATA"].unit-display'),
                    document.querySelector('app-consumptions-v2 label[for="DATA"]'),
                    document.querySelector('app-consumptions label[for="DATA"]'),
                    document.querySelector('app-consumptions-v2 .unit-display'),
                    document.querySelector('app-consumptions .unit-display'),
                    document.querySelector('[data-type="DATA"] .unit-display'),
                    document.querySelector('[data-type="DATA"]'),
                ];
                if (dataCandidates.some(el => visible(el) && /\d/.test(el.textContent))) {
                    return 'data';
                }

                const rateLimitText = 'Im aktuellen Tarif sind keine Inklusiv-Einheiten';
                const consumptionRoots = Array.from(document.querySelectorAll(
                    'app-consumptions-v2, app-consumptions, [data-type="DATA"]'
                ));
                return consumptionRoots.some(el =>
                    visible(el) &&
                    (el.innerText || el.textContent || '').includes(rateLimitText)
                ) ? 'placeholder' : 'timeout';
            });

            if (state === 'data' || state === 'login' || state === 'maintenance') return state;
            stablePlaceholderSamples = state === 'placeholder'
                ? stablePlaceholderSamples + 1
                : 0;
            if (sample < 2) await delay(500);
        }

        return stablePlaceholderSamples === 3
            ? 'rate-limit-placeholder'
            : 'timeout';
    }
}

async function isLoginFormVisible() {
    return page.evaluate(() => {
        const loginForm = document.querySelector('app-login-v2, .login-wrapper');
        return !!loginForm &&
            !!(loginForm.offsetWidth || loginForm.offsetHeight || loginForm.getClientRects().length);
    });
}

async function waitForLoginSuccess(timeoutMs = 30000, startedOnOverview = false) {
    const deadline = Date.now() + timeoutMs;
    let successStableSince = 0;

    while (Date.now() < deadline && !isShuttingDown) {
        try {
            const state = await page.evaluate(() => {
                const visible = el => !!el &&
                    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                const maintenance = /(?:wartung|maintenance)/i.test(location.pathname) ||
                    /(?:wartung|maintenance)/i.test(document.title || '');
                if (maintenance) return 'maintenance';
                const loginForm = document.querySelector('app-login-v2, .login-wrapper');
                const loginVisible = visible(loginForm);
                const dataCandidates = [
                    document.querySelector('label[for="DATA"].unit-display'),
                    document.querySelector('app-consumptions-v2 label[for="DATA"]'),
                    document.querySelector('app-consumptions label[for="DATA"]'),
                    document.querySelector('[data-type="DATA"] .unit-display'),
                    document.querySelector('[data-type="DATA"]'),
                ];
                const consumptionRoots = Array.from(document.querySelectorAll(
                    'app-consumptions-v2, app-consumptions, [data-type="DATA"]'
                ));
                return {
                    loginVisible,
                    onOverview: location.pathname.includes('/uebersicht'),
                    hasTariffNumber: dataCandidates.some(el =>
                        visible(el) && /\d/.test(el.textContent)
                    ),
                    hasVisibleConsumptionRoot: consumptionRoots.some(visible)
                };
            });

            if (state === 'maintenance') return state;

            const successTargetReached =
                state.hasTariffNumber ||
                (
                    state.onOverview &&
                    (!startedOnOverview || state.hasVisibleConsumptionRoot)
                );
            if (!state.loginVisible && successTargetReached) {
                if (successStableSince === 0) successStableSince = Date.now();
                // Ein verborgen gemountetes Login-Element ist normal. Der erfolgreiche
                // Zustand muss kurz stabil bleiben, damit ein SPA-Zwischenzustand nicht
                // voreilig als Login-Erfolg gilt.
                if (Date.now() - successStableSince >= 750) return state;
            } else {
                successStableSince = 0;
            }
        } catch (_) {
            // Während einer echten Navigation wird der JS-Kontext kurz zerstört.
            // Im nächsten Poll mit dem neuen Dokument weiterprüfen.
            successStableSince = 0;
        }
        await delay(250);
    }

    return null;
}

// Verbesserte Login-Funktion mit Timeout und Retry-Logik
async function performLogin(recoveryAttempt = 0, forceFreshLogin = false) {
    if (isShuttingDown) return false;

    try {
        let loginFormAlreadyVisible = false;
        try {
            loginFormAlreadyVisible = await isLoginFormVisible();
        } catch (_) {}

        if (page.url().startsWith(uebersichtUrl)) {
            if (!loginFormAlreadyVisible && !forceFreshLogin) {
                logger.info("Bereits auf der Übersichtsseite, kein Login nötig");
                loginAttempts = 0;
                authRecoveryNoticeActive = false;
                return true;
            }
            if (loginFormAlreadyVisible) {
                logger.info("Auf Übersichts-URL aber Login-Formular sichtbar - verwende vorhandenes Formular direkt");
            } else {
                logger.info("Token läuft bald ab - proaktive Neuanmeldung ersetzt diesen regulären Datenreload");
            }
        }

        const loginPromise = (async () => {
            let hatLoginFormularNachGoto = loginFormAlreadyVisible;
            if (!loginFormAlreadyVisible) {
                logger.info("Navigiere zur Login-Seite...");
                // Zwei Slots freihalten: Login-Seite plus möglicher Formular-Submit.
                const loginNavigationStartedAt = await reservePageRequest('login', 2);
                if (forceFreshLogin) {
                    // Erst nach der Request-Budget-Wartezeit löschen. So bleibt die
                    // laufende Sitzung während einer längeren Drosselung nutzbar.
                    await page.evaluate(() => {
                        sessionStorage.clear();
                        localStorage.clear();
                    });
                    await context.clearCookies();
                    logger.info("Lokale Browser-Anmeldung für proaktiven frischen Login entfernt");
                }
                resetPageErrors();
                resetNavigationDiagnostics();
                await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

                // Gültige Session? → DOM-Check: Login-Formular sichtbar?
                // URL-Check reicht nicht: Login-Form kann auf jeder URL erscheinen
                const loginPageState = await navigateAndWaitForData(loginNavigationStartedAt);
                if (loginPageState === 'maintenance') {
                    throw new MaintenanceModeError(page.url());
                }
                hatLoginFormularNachGoto = loginPageState === 'login';
                const authenticatedOverviewState =
                    page.url().startsWith(uebersichtUrl) &&
                    (
                        loginPageState === 'data' ||
                        loginPageState === 'rate-limit-placeholder'
                    );
                if (!hatLoginFormularNachGoto && !authenticatedOverviewState) {
                    throw new Error(
                        `Login-Seite lieferte keinen eindeutigen Session-Zustand ` +
                        `(${loginPageState}, URL: ${page.url()})`
                    );
                }
            }

            if (!hatLoginFormularNachGoto) {
                logger.info(`Session noch gültig (kein Login-Formular) - URL: ${page.url()}`);
                overviewFreshFromLogin = page.url().startsWith(uebersichtUrl);
                if (forceFreshLogin) {
                    await persistCurrentBrowserSession("nach proaktiver Neuanmeldung");
                }
                loginAttempts = 0;
                authRecoveryNoticeActive = false;
                return true;
            }

            // Login-Formular erkannt → tatsächlicher Login erforderlich. Auch
            // ohne Vue-Fehler wird der Kontext einmalig protokolliert; so lässt
            // sich später zwischen normaler Session-Ablaufzeit und Tokenfehler
            // unterscheiden.
            if (hatLoginFormularNachGoto) {
                await logAuthFailureDiagnostics(
                    hasSessionRefreshError() ? "Session-Erneuerung" : "Login-Formular erkannt"
                );
            }
            if (hasSessionRefreshError() && !authRecoveryNoticeActive) {
                authRecoveryNoticeActive = true;
                logger.warn("Gespeicherte Sitzung konnte nicht erneuert werden - automatische Neuanmeldung läuft");
                sendMessage(
                    "⚠️ Sitzung konnte nicht erneuert werden – automatische Neuanmeldung läuft.",
                    "warn"
                );
            }
            loginAttempts++;
            if (loginAttempts > MAX_LOGIN_ATTEMPTS) {
                throw new Error(`Maximale Anzahl Login-Versuche (${MAX_LOGIN_ATTEMPTS}) erreicht`);
            }
            logger.info(`Login-Versuch ${loginAttempts}/${MAX_LOGIN_ATTEMPTS}...`);

			await page.waitForSelector('input[name="msisdn"]', { timeout: 15000 });
			await page.waitForSelector('input[name="password"]', { timeout: 15000 });
			
			// Felder leeren und ausfüllen
			await page.fill('input[name="msisdn"]', '');
			await page.fill('input[name="password"]', '');
            await delay(1000);

			await page.fill('input[name="msisdn"]', rufnummer);
            await page.fill('input[name="password"]', passwort);

            logger.info("Login-Daten eingegeben, sende Formular...");

            // Login-Button klicken. Lidl wechselt teils per Vollnavigation und teils
            // als SPA; eine zwingende waitForNavigation()-Bedingung erzeugte deshalb
            // im Voll-Log viele falsche 30s-Timeouts.
            const loginStartedOnOverview = page.url().startsWith(uebersichtUrl);
            await reservePageRequest('login-submit');
            resetPageErrors();
            resetNavigationDiagnostics();
            await page.click(
                'button[type="submit"]:has-text("Einloggen")',
                { timeout: 15000, noWaitAfter: true }
            );

            const loginSuccessState = await waitForLoginSuccess(30000, loginStartedOnOverview);
            if (loginSuccessState === 'maintenance') {
                throw new MaintenanceModeError(page.url());
            }
            if (!loginSuccessState) {
                const loginStillVisible = await isLoginFormVisible().catch(() => false);
                throw new Error(
                    loginStillVisible
                        ? `Login fehlgeschlagen - sichtbares Login-Formular nach 30s (URL: ${page.url()})`
                        : `Login-Ergebnis nach 30s nicht eindeutig (URL: ${page.url()})`
                );
            }
            logger.info(`Login-Formular verschwunden - eingeloggt (URL: ${page.url()})`);
            overviewFreshFromLogin = page.url().startsWith(uebersichtUrl);

            // Falls noch nicht auf Übersichtsseite → manuell navigieren
            if (!page.url().startsWith(uebersichtUrl)) {
                logger.info(`Post-login URL: ${page.url()} - navigiere zu Übersicht`);
                const overviewNavigationStartedAt =
                    await reservePageRequest('post-login-goto-uebersicht');
                resetPageErrors();
                resetNavigationDiagnostics();
                await page.goto(uebersichtUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
                overviewFreshFromLogin = true;
                // Auch nach goto Übersicht: Ein sichtbares Login-Formular bedeutet
                // fehlgeschlagene Session; ein verborgen gemountetes Element nicht.
                const overviewState = await navigateAndWaitForData(overviewNavigationStartedAt);
                if (overviewState === 'maintenance') {
                    throw new MaintenanceModeError(page.url());
                }
                if (overviewState === 'login') {
                    throw new Error(`Navigation zur Übersicht fehlgeschlagen - Login-Formular erschienen (URL: ${page.url()})`);
                }
            }

            await persistCurrentBrowserSession("nach Login");

            lastActivityTime = Date.now();
            saveSessionMeta();
            loginAttempts = 0;
            consecutiveErrors = 0;
            authRecoveryNoticeActive = false;

            logger.info("Login erfolgreich, Session-Daten gespeichert");
            return true;
        })();

        // Die einzelnen Browseraktionen besitzen eigene Timeouts. Ein globaler
        // 60s-Timeout würde während einer bewussten Rate-Limit-Wartezeit auslösen,
        // obwohl der Login weiterhin im Hintergrund liefe.
        return await loginPromise;

    } catch (error) {
        if (error?.code === "LIDL_MAINTENANCE_MODE") {
            throw error;
        }
        if (loginAttempts < MAX_LOGIN_ATTEMPTS) {
            logger.warn(`Login-Versuch ${loginAttempts}/${MAX_LOGIN_ATTEMPTS} nicht erfolgreich: ${error.message}`);
        } else {
            logger.error(`Login endgültig fehlgeschlagen: ${error.message}`);
        }
        consecutiveErrors++;

        // Fehlerzustand der Login-App: mit frischer Sitzung neu aufbauen und direkt
        // erneut anmelden. Das ist kein Browser-Crash und wird auch nicht so gemeldet.
        if (lastPageErrors.length > 0) {
            await logAuthFailureDiagnostics("Login-Recovery");
            if (recoveryAttempt >= MAX_LOGIN_ATTEMPTS - 1) {
                logger.error(`Login-App nach ${recoveryAttempt + 1} Recovery-Versuchen weiterhin fehlerhaft - breche Login-Zyklus ab`);
                return false;
            }
            if (hasSessionRefreshError() && !authRecoveryNoticeActive) {
                authRecoveryNoticeActive = true;
                sendMessage(
                    "⚠️ Sitzung konnte nicht erneuert werden – automatische Neuanmeldung läuft.",
                    "warn"
                );
            }
            logger.error(`Login-App reagiert fehlerhaft (${lastPageErrors[lastPageErrors.length - 1].substring(0, 80)}) - starte mit frischer Sitzung`);
            sendMessage(
                authRecoveryNoticeActive
                    ? "🔄 Neuanmeldung blieb hängen – Browser wird mit frischer Sitzung neu gestartet."
                    : "🔄 Login-Seite reagiert nicht – Browser wird mit frischer Sitzung neu gestartet.",
                "warn"
            );
            try {
                await restartBrowser(true);
                // Restart erfolgreich → sofort frisch einloggen (Page-Errors wurden geleert)
                logger.info("Browser mit frischer Sitzung neu gestartet - versuche Login erneut...");
                return await performLogin(recoveryAttempt + 1);
            } catch (_) {}
            return false;
        }

        // Keine zusätzliche 60s-Pause: Nach dem Return plant die Hauptschleife
        // ohnehin den nächsten Versuch anhand von Daten-Deadline und Request-Budget.
        if (loginAttempts >= 2) {
            logger.info("Wiederholter Login-Fehler - Retry-Termin wird zentral geplant");
        }

        return false;
    }
}

// Verbesserte Hauptfunktion mit Circuit Breaker
async function main() {
    if (isShuttingDown) return { datenVolumen: 0, statusMessage: null };

    let datenVolumen = 0.0;
    let refillClickedThisCheck = false;

    try {
        return await circuitBreaker.execute(async () => {
            // Browser initialisieren falls nötig
            // forceClean=false: vorhandene Session wiederverwenden (kein frischer Login)
            if (!context || !page || page.isClosed()) {
                const initSuccess = await initializeBrowser(false);
                if (!initSuccess) {
                    throw new Error("Browser-Initialisierung fehlgeschlagen");
                }
            }

            // Login durchführen (bei forceClean=true neu, bei forceClean=false Session wiederverwenden)
            logger.info("Prüfe Session...");
            overviewFreshFromLogin = false;
            let forceFreshLogin = false;
            if (page.url().startsWith(uebersichtUrl)) {
                const liveSession = await getLiveSessionStorageSnapshot();
                const expiresAt = liveSession?.diagnostics?.expiresAt || 0;
                const expiresInSeconds = expiresAt > 0
                    ? Math.floor((expiresAt - Date.now()) / 1000)
                    : null;
                if (
                    expiresInSeconds !== null &&
                    expiresInSeconds <= TOKEN_PREFLIGHT_SECONDS &&
                    Date.now() - lastTokenPreflightAt >= TOKEN_PREFLIGHT_COOLDOWN_MS
                ) {
                    const budget = getRequestBudgetState(Date.now(), 2);
                    forceFreshLogin = true;
                    lastTokenPreflightAt = Date.now();
                    logger.info(
                        `Token-Preflight: Ablauf in ${expiresInSeconds}s, ` +
                        `Request-Budget-Wartezeit aktuell ${Math.ceil(budget.delayMs / 1000)}s`
                    );
                    saveSessionMeta();
                }
            }
            const loginSuccess = await performLogin(0, forceFreshLogin);
            if (!loginSuccess) {
                throw new Error("Login nach mehreren Versuchen fehlgeschlagen");
            }

            // Zur Übersichtsseite navigieren. Jede Navigation reserviert vorher
            // zentral Kapazität im 10- und 60-Minuten-Fenster.
            let dataReadFromFreshLogin = false;
            if (overviewFreshFromLogin && !forceFreshOverviewNavigation) {
                logger.info("Frisch geladene Übersichtsseite aus Login/Session-Prüfung wird direkt ausgewertet");
                dataReadFromFreshLogin = true;
                overviewFreshFromLogin = false;
            } else if (!page.url().startsWith(uebersichtUrl) || forceFreshOverviewNavigation) {
                await reservePageRequest(forceFreshOverviewNavigation ? 'vue-recovery-goto' : 'goto-uebersicht');
                resetPageErrors();
                resetNavigationDiagnostics();
                await page.goto(uebersichtUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
                forceFreshOverviewNavigation = false;
            } else {
                await reservePageRequest('reload-uebersicht');
                resetPageErrors();
                resetNavigationDiagnostics();
                await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
            }

            let dataNavigationStartedAt = pageRequestLog.length > 0
                ? pageRequestLog[pageRequestLog.length - 1].time
                : Date.now();
            let navigationState = await navigateAndWaitForData(dataNavigationStartedAt);
            if (navigationState === 'maintenance') {
                throw new MaintenanceModeError(page.url());
            }

            // Ein Session-Redirect kann erst nach dem Übersichts-Reload sichtbar
            // werden. Das bereits geladene Formular direkt im selben Lauf verwenden:
            // kein falscher NaN/Vue-Fehler und keine zusätzliche Login-Seiten-Navigation.
            if (navigationState === 'login') {
                logger.info("Session-Redirect nach Übersichtsaufruf erkannt - melde im selben Datencheck neu an");
                const reloginSuccess = await performLogin();
                if (!reloginSuccess) {
                    throw new Error("Neuanmeldung nach Session-Redirect fehlgeschlagen");
                }
                dataReadFromFreshLogin = true;
                dataNavigationStartedAt = pageRequestLog.length > 0
                    ? pageRequestLog[pageRequestLog.length - 1].time
                    : Date.now();
                navigationState = await navigateAndWaitForData(dataNavigationStartedAt);
                if (navigationState === 'maintenance') {
                    throw new MaintenanceModeError(page.url());
                }
                if (navigationState === 'login') {
                    throw new Error("Login-Formular nach erfolgreicher Neuanmeldung weiterhin sichtbar");
                }
            }

			// Datenvolumen auslesen (Tarif + Refill)
			// Versuche mehrere Selector-Varianten für alte und neue Seitenstruktur
			const usage = await page.evaluate((allowRateLimitClassification) => {
				const result = {
					tarif: { available: NaN, total: NaN, unit: '' },
					refill: { available: NaN, total: NaN, unit: '' }
				};
                const visible = el => !!el &&
                    !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

				function parseLabel(el) {
					if (!visible(el)) return null;
					const text = el.textContent.trim();
					const nums = text.match(/(\d+(?:[.,]\d+)?)/g) || [];
					const unitEl = el.querySelector('span.unit') || el.closest('[class*="unit"]');
					const unit = unitEl ? unitEl.textContent.replace(/\d+[.,]?\d*/g, '').trim()
						: (text.match(/[A-Za-z]+/) || [''])[0];
					return {
						available: nums[0] ? parseFloat(nums[0].replace(',', '.')) : NaN,
						total: nums[1] ? parseFloat(nums[1].replace(',', '.')) : NaN,
						unit
					};
				}

				// Versuche Tarif-Daten - alte und neue Selektor-Varianten
				const tarifCandidates = [
					document.querySelector('label[for="DATA"].unit-display'),
					document.querySelector('app-consumptions-v2 label[for="DATA"]'),
					document.querySelector('app-consumptions-v2 .unit-display'),
					document.querySelector('app-consumptions label[for="DATA"]'),
					document.querySelector('app-consumptions .unit-display'),
					document.querySelector('[data-type="DATA"] .unit-display'),
					document.querySelector('[data-type="DATA"]'),
				];
				for (const el of tarifCandidates) {
					const parsed = parseLabel(el);
					if (parsed && !isNaN(parsed.available)) {
						result.tarif = parsed;
						break;
					}
				}

				// Versuche Refill-Daten - alte und neue Selektor-Varianten
				const refillCandidates = [
					document.querySelector('label[for="REFILLABLE_DATA"].unit-display'),
					document.querySelector('app-consumptions-refill-v2 label[for="REFILLABLE_DATA"]'),
					document.querySelector('app-consumptions-refill-v2 .unit-display'),
					document.querySelector('app-consumptions-refill label[for="REFILLABLE_DATA"]'),
					document.querySelector('app-consumptions-refill .unit-display'),
					document.querySelector('[data-type="REFILLABLE_DATA"] .unit-display'),
					document.querySelector('[data-type="REFILLABLE_DATA"]'),
				];
				for (const el of refillCandidates) {
					const parsed = parseLabel(el);
					if (parsed && !isNaN(parsed.available)) {
						result.refill = parsed;
						break;
					}
				}

				// Rate-Limit-Erkennung erst nach dem Daten-Wait und nur innerhalb
				// einer sichtbaren Consumption-Komponente. Der Text kann während
				// des Vue-Ladens kurz global im DOM stehen.
				if (isNaN(result.tarif.available)) {
					const rateLimitText = 'Im aktuellen Tarif sind keine Inklusiv-Einheiten';
                    const loginForm = document.querySelector('app-login-v2, .login-wrapper');
                    const loginVisible = !!loginForm &&
                        !!(loginForm.offsetWidth || loginForm.offsetHeight || loginForm.getClientRects().length);
                    const consumptionRoots = Array.from(document.querySelectorAll(
                        'app-consumptions-v2, app-consumptions, [data-type="DATA"]'
                    ));
                    const visibleRateLimitPlaceholder = consumptionRoots.some(el => {
                        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
                        return visible && (el.innerText || el.textContent || '').includes(rateLimitText);
                    });
					if (
                        allowRateLimitClassification &&
                        !loginVisible &&
                        location.pathname.includes('/uebersicht') &&
                        visibleRateLimitPlaceholder
                    ) {
						result._rateLimited = true;
						return result;
					}
				}

				// Debug: Alle unit-display Elemente loggen falls nichts gefunden
				if (isNaN(result.tarif.available)) {
					const allLabels = Array.from(document.querySelectorAll('.unit-display, [class*="consumption"], [class*="data-volume"]'));
					result._debugSelectors = allLabels.filter(visible).slice(0, 10).map(el => ({
						tag: el.tagName,
						classes: el.className,
						for: el.getAttribute('for'),
						text: el.textContent.trim().substring(0, 80)
					}));
				}

				return result;
			}, navigationState === 'rate-limit-placeholder');
			const volumeMeasurementAt = Date.now();

			// Debug-Ausgabe falls Tarif-Daten fehlen
			if (isNaN(usage.tarif.available) && usage._debugSelectors) {
				logger.warn(`Keine bekannten Selektoren gefunden. Gefundene DOM-Elemente: ${JSON.stringify(usage._debugSelectors)}`);
			}
			
			let datenVerfuegbar = usage.tarif.available;
			let refillVerfuegbar = usage.refill.available;
            const hasHttp429 = navigationNetworkEvents.some(event => event.status === 429);
            const hasHttp5xx = navigationNetworkEvents.some(event => event.status >= 500 && event.status < 600);
			const requestWindowUsage = getRequestWindowUsage();
			const requestBudgetNearLimit = requestWindowUsage.some(window => {
				// Im kurzen Fenster erst den letzten freien Slot als kritisch werten.
				// Beim 60-Minuten-Fenster sind zwei Slots Reserve relevant, weil eine
				// abgelaufene Session Navigation plus möglichen Login-Submit benötigt.
				const reserveMargin = window.label === "60min" ? 2 : 1;
				return window.count >= Math.max(1, window.maxRequests - reserveMargin);
			});
			logDataExtractionDiagnostics(
				usage,
				navigationState,
				dataNavigationStartedAt,
				usage._rateLimited ? "rate-limit-placeholder" : (isNaN(datenVerfuegbar) ? "NaN" : "erfolgreich")
			);

			// Ein explizites HTTP 429 ist auch ohne fertig gerenderten Platzhalter
            // eindeutig. Ohne 429 gilt nur der über 25+s stabil bestätigte,
            // sichtbare Consumption-Platzhalter als Rate-Limit.
			if (usage._rateLimited || (isNaN(datenVerfuegbar) && hasHttp429)) {
				rateLimitBackoffCount++;
                rateLimitRecoverySuccessCount = 0;
                const placeholderDurationSeconds = ((Date.now() - dataNavigationStartedAt) / 1000).toFixed(1);
                const classification = hasHttp429
                    ? "Bestätigtes Rate-Limit"
                    : requestBudgetNearLimit
                        ? "Wahrscheinliches Rate-Limit"
                        : hasHttp5xx
                            ? "Lidl-API-Fehler mit Rate-Limit-Platzhalter"
                            : "Unbestätigter Rate-Limit-Platzhalter";
                rateLimitBackoffReason = classification;
                logger.warn(
                    hasHttp429
                        ? `HTTP 429 nach ${placeholderDurationSeconds}s bestätigt und keine Tarifzahl vorhanden`
                        : `${classification} nach ${placeholderDurationSeconds}s weiterhin sichtbar und keine Tarifzahl vorhanden`
                );
                logger.warn(
                    `Rate-Limit-Netzwerkdiagnose (${hasHttp429 ? "HTTP 429 bestätigt" : "kein HTTP 429 erfasst"}; ` +
                    `Budget ${requestWindowUsage.map(window => `${window.label}=${window.count}/${window.maxRequests}`).join(", ")}): ` +
                    getNavigationNetworkSummary()
                );
				logRateLimitStats();
				const configuredBackoffMinutes = rateLimitBackoffCount === 1
                    ? RATE_LIMIT_BACKOFF_MINUTES
                    : RATE_LIMIT_REPEAT_BACKOFF_MINUTES;
                const configuredBackoffMs = configuredBackoffMinutes * 60 * 1000;
                const retryAfterBackoffMs = Math.max(
                    0,
                    navigationRetryAfterUntil - Date.now() + RATE_LIMIT_SAFETY_MS
                );
                const effectiveBackoffMs = Math.max(configuredBackoffMs, retryAfterBackoffMs);
                const effectiveBackoffSeconds = Math.ceil(effectiveBackoffMs / 1000);
                const effectiveBackoffMinutes = Math.ceil(effectiveBackoffSeconds / 60);
				rateLimitBackoffUntil = Date.now() + effectiveBackoffMs;
				lastMainRunTime = Date.now();
                saveSessionMeta();
				logger.warn(`⏳ ${classification} (${rateLimitBackoffCount}x) - Schutzpause ${effectiveBackoffMinutes} Minuten...`);
                logger.error("Während dieses Schutz-Backoffs kann ein durchgehender Download ohne externe Drosselung nicht garantiert werden.");
				sendMessage(`⏳ ${classification} - Pause ${effectiveBackoffMinutes} Minuten`, "warn");
				return {
                    datenVolumen: 0,
                    statusMessage: null,
                    rateLimitBackoffSeconds: effectiveBackoffSeconds
                };
			}

			// NaN-Fehlerbehandlung: Der nächste Zyklus führt genau eine neue Navigation aus.
			// Die bisherige Sofort-Navigation wurde nicht ausgewertet und verursachte danach
			// noch einen zweiten Reload.
			if (isNaN(datenVerfuegbar)) {
				nanErrorCount++;

				// Diagnose: Page-Errors und DOM-Zustand loggen
				const domLeer = Array.isArray(usage._debugSelectors) && usage._debugSelectors.length === 0;
				const pageErrInfo = lastPageErrors.length > 0
					? ` | Page-Error: ${lastPageErrors[lastPageErrors.length - 1].substring(0, 80)}`
					: '';
				const domInfo = domLeer
					? (lastPageErrors.length > 0
                        ? ' | DOM leer mit Vue-Fehler'
                        : ' | DOM leer/Session-Redirect noch nicht gerendert')
					: (usage._debugSelectors ? ` | ${usage._debugSelectors.length} DOM-Elemente gefunden (falsche Selektoren?)` : '');
                const networkInfo = ` | Netzwerk: ${getNavigationNetworkSummary()}`;

				logger.warn(`Datenvolumen ist NaN - Fehler ${nanErrorCount}/${MAX_NAN_ERRORS}${pageErrInfo}${domInfo}${networkInfo} - neuer Versuch spätestens in 15s`);
				sendMessage(`⚠️ Datenvolumen nicht lesbar (${nanErrorCount}/${MAX_NAN_ERRORS}) - schneller neuer Versuch`, "warn");

				if (nanErrorCount >= MAX_NAN_ERRORS) {
					logger.error("Zu viele NaN-Fehler - Browser wird neu gestartet");
					sendMessage("🚨 Zu viele NaN-Fehler - Versuche Neuanmeldung", "warn");
					nanErrorCount = 0;
					await restartBrowser(true); // forceClean: Session löschen → frischer Login
					throw new Error("NaN-Fehlerbehandlung: Browser neugestartet");
				}

				// Vue-Absturz erkannt → beim nächsten Versuch goto statt reload.
				if (domLeer && lastPageErrors.length > 0) {
					logger.info('Vue-Crash erkannt - nächster Versuch nutzt frische Navigation zur Übersicht');
					forceFreshOverviewNavigation = true;
				}

				// Schnell-Retry ohne ungenutzten Zwischen-Reload. Falls die letzte
				// Daten-Deadline früher liegt, hat sie Vorrang vor den normalen 15s.
                const lastSafeDeadline = getSafeCheckDeadline(lastSchedulingVolume, lastSchedulingBaselineAt);
                const nanRetryIn = lastSafeDeadline > 0
                    ? Math.max(1, Math.min(15, Math.ceil((lastSafeDeadline - Date.now()) / 1000)))
                    : 15;
				return { datenVolumen: 0, statusMessage: null, nanRetryIn };
			}

			// Bei erfolgreicher Extraktion: NaN-Fehler zurücksetzen
			resetNanErrors();
            if (refillFollowupPending) {
                logger.info("Regulärer Folgecheck nach Refill-Klick gelesen - angezeigter Stand wird jetzt als neue Basis verwendet");
                refillFollowupPending = false;
            }

			// Log both volumes
			const tarifMessage = `📊 Tarif: ${usage.tarif.available} ${usage.tarif.unit} / ${usage.tarif.total} ${usage.tarif.unit}`;
			let refillMessage = '';
			
			// Only log refill if it's available (has valid numbers)
			if (!isNaN(refillVerfuegbar)) {
				refillMessage = `📊 Refill: ${usage.refill.available} ${usage.refill.unit} / ${usage.refill.total} ${usage.refill.unit}`;
				logger.info(refillMessage);
			}
			
			logger.info(tarifMessage);

            // Gesamtes tatsächlich angezeigtes Volumen. Da der DOM-Wert aus einer
            // früheren Antwort stammen kann, wird für die Planung zusätzlich der
            // maximale Verbrauch seit Navigationsbeginn abgezogen.
            const displayedDatenVolumen = datenVerfuegbar + (!isNaN(refillVerfuegbar) ? refillVerfuegbar : 0);
            const elapsedSinceNavigationSeconds = Math.max(0, volumeMeasurementAt - dataNavigationStartedAt) / 1000;
            const conservativeConsumptionGb = elapsedSinceNavigationSeconds * MAX_DOWNLOAD_MBIT / 8000;
            const conservativeDatenVolumen = Math.max(0, displayedDatenVolumen - conservativeConsumptionGb);

            // Der Refill wird erst nahe
            // der Reserve ausgelöst, damit jeder Klick möglichst viel Volumen ergänzt.
            datenVolumen = displayedDatenVolumen;
            let schedulingVolume = conservativeDatenVolumen;
            let schedulingBaselineAt = volumeMeasurementAt;

            if (!isNaN(refillVerfuegbar) && conservativeDatenVolumen <= REFILL_TRIGGER_GB) {
                try {
                    logger.info(
                        `Datenvolumen konservativ bei ${conservativeDatenVolumen.toFixed(3)} GB ` +
                        `(Anzeige ${datenVolumen.toFixed(3)} GB) - versuche Refill zu aktivieren...`
                    );
                    const refillVorher = refillVerfuegbar;

                    await page.click('button:has-text("Refill aktivieren")', { timeout: 10000 });
                    const refillClickedAt = Date.now();
                    refillFollowupPending = true;
                    lastRefillAt = refillClickedAt;
                    refillClickedThisCheck = true;

                    // Lidl aktualisiert die Anzeige nach dem Klick nicht zuverlässig live.
                    // Deshalb kein Reload: Nur die Terminplanung nimmt bis zum nächsten
                    // regulären Check vorläufig den vollen Refill-Bucket an.
                    const expectedRefillAvailable = Number.isFinite(usage.refill.total) && usage.refill.total > 0
                        ? usage.refill.total
                        : REFILL_EXPECTED_GB;
                    const elapsedSinceNavigationToClickSeconds = Math.max(0, refillClickedAt - dataNavigationStartedAt) / 1000;
                    const consumedTarifGb = elapsedSinceNavigationToClickSeconds * MAX_DOWNLOAD_MBIT / 8000;
                    const conservativeTarifAtClick = Math.max(0, datenVerfuegbar - consumedTarifGb);
                    schedulingVolume = conservativeTarifAtClick + expectedRefillAvailable;
                    schedulingBaselineAt = refillClickedAt;

                    logger.info(`Refill-Button gedrückt (vorheriger Wert: ${refillVorher} GB)`);
                    logger.info(`Kein Extra-Reload: Planungswert ${schedulingVolume.toFixed(3)} GB, Prüfung beim nächsten regulären Check`);
                    saveSessionMeta();
                } catch (e) {
                    logger.error(`Fehler beim Nachbuchungsversuch: ${e.message}`);
                    sendMessage(`❌ Refill-Aktivierung fehlgeschlagen: ${e.message}`, "error");
                }
            }

            const maintenanceWasActive = maintenanceActive;
            markMaintenanceRecovered();
            if (maintenanceWasActive) saveSessionMeta();
            lastKnownDatenVolumen = datenVolumen; // Für Rate-Limit-Bucket-Zuordnung
            lastVolumeMeasurementAt = volumeMeasurementAt;
            lastSchedulingVolume = schedulingVolume;
            lastSchedulingBaselineAt = schedulingBaselineAt;
            lastActivityTime = Date.now();
            lastMainRunTime = Date.now(); // Keep-Alive-Throttling
            rateLimitBackoffUntil = 0;
            if (rateLimitBackoffCount > 0) {
                if (!dataReadFromFreshLogin) {
                    rateLimitRecoverySuccessCount++;
                }

                if (rateLimitRecoverySuccessCount >= 2) {
                    logger.info(`${rateLimitBackoffReason}-Recovery bestätigt: zwei reguläre Datenchecks erfolgreich`);
                    rateLimitBackoffCount = 0;
                    rateLimitRecoverySuccessCount = 0;
                    rateLimitBackoffReason = "Rate-Limit";
                } else {
                    logger.info(
                        `Erster lesbarer Stand nach ${rateLimitBackoffReason}; Recovery bleibt bis zu ` +
                        `zwei regulären Datenchecks aktiv (${rateLimitRecoverySuccessCount}/2)`
                    );
                }
            } else {
                rateLimitRecoverySuccessCount = 0;
            }
            // Zusätzlich höchstens alle 15 Minuten sichern. Das erzeugt keinen
            // Seitenaufruf, erfasst aber Token-Rotationen auch vor einem harten
            // Prozessabbruch, bei dem kein Shutdown-Handler mehr laufen könnte.
            if (Date.now() - lastBrowserSessionPersistAt >= SESSION_PERSIST_INTERVAL_MS) {
                const liveSessionSaved = await persistCurrentBrowserSession("nach Datencheck");
                if (liveSessionSaved) lastBrowserSessionPersistAt = Date.now();
            }
            saveSessionMeta();
            updateHeartbeat(); // Watchdog-Signal

            let finalStatusMessage = `📊 Tarif: ${datenVerfuegbar} GB / ${usage.tarif.total} GB`;
            if (!isNaN(refillVerfuegbar)) {
                finalStatusMessage += `\n📊 Refill: ${refillVerfuegbar} GB / ${usage.refill.total} GB`;
            }
            if (lastRefillAt > 0) {
                const refillTime = new Date(lastRefillAt).toLocaleString("de-DE");
                finalStatusMessage += `\n🔄 Letzter Refill: ${refillTime}`;
                if (refillClickedThisCheck) {
                    finalStatusMessage += `\n🖱️ Refill-Button gedrückt`;
                }
            }

            const nextCheckAt = schedulingBaselineAt + getInterval(schedulingVolume) * 1000;
            return {
                datenVolumen,
                schedulingVolume,
                nextCheckAt,
                statusMessage: finalStatusMessage,
                forceNewMessage: false
            };
        });

    } catch (error) {
        if (error?.code === "LIDL_MAINTENANCE_MODE") {
            return enterMaintenanceBackoff(error);
        }
        sendMessage(`🚨 Fehler aufgetreten: ${error.message}`, "error");
        logger.error(`Fehler in main(): ${error.message}`);
        consecutiveErrors++;

        // Bei kritischen Fehlern Browser neu starten
        if (consecutiveErrors >= 3) {
            logger.error("Mehrere aufeinanderfolgende Fehler - Browser restart");
            await restartBrowser(true);
        }

        return { datenVolumen: 0, statusMessage: null };
    }
}

// Update-Funktion – außerhalb des zeitkritischen Datenchecks
async function checkForUpdates() {
    if (updateCheckInProgress || mainRunInProgress || isShuttingDown) return;
    updateCheckInProgress = true;
    lastUpdateCheckAt = Date.now();
    const stagedScriptPath = path.join(scriptDirectory, "script.update.js");

    try {
        // package.json ist im Repository historisch bei 1.1.1 stehengeblieben.
        // Das Script selbst ist die verlässliche Quelle und wird bei einem Update
        // direkt wiederverwendet, sodass genau ein GitHub-Abruf nötig ist.
        const response = await axios.get(scriptUrl, {
            timeout: 10000,
            responseType: "text"
        });
        const versionMatch = response.data.match(
            /\bconst\s+version\s*=\s*["'](\d+(?:\.\d+)+)["']/
        );
        if (!versionMatch) {
            throw new Error("Remote Script-Version konnte nicht gelesen werden");
        }
        const latestVersion = versionMatch[1];
        if (latestVersion.localeCompare(version, undefined, { numeric: true }) > 0) {
            logger.warn(`New version available: ${latestVersion}. Updating the script...`);
            if (autoUpdate) {
                fs.writeFileSync(stagedScriptPath, response.data, "utf-8");
                execFileSync(process.execPath, ["--check", stagedScriptPath], {
                    encoding: "utf-8",
                    timeout: 10000,
                    stdio: "pipe"
                });
                fs.copyFileSync(stagedScriptPath, localScriptPath);
                fs.unlinkSync(stagedScriptPath);
                logger.info("Script updated successfully. Starte genau einen Ersatzprozess.");

                saveSessionMeta();
                stopTimers();
                await persistCurrentBrowserSession("vor Script-Update");
                await closeBrowserSafely();
                const replacement = spawn(process.execPath, [localScriptPath], {
                    cwd: scriptDirectory,
                    detached: true,
                    stdio: "ignore"
                });
                replacement.unref();
                sendMessage(`Script updated to version ${latestVersion}.`, "info");
                logger.info(`Script updated to version ${latestVersion}.`);
                process.exit(0);
            } else {
                logger.warn("Auto-update is disabled. Please update the script manually.");
            }
        } else {
            logger.info("You are using the latest version of the script.");
        }
    } catch (error) {
        try {
            if (fs.existsSync(stagedScriptPath)) fs.unlinkSync(stagedScriptPath);
        } catch (_) {}
        logger.error(`Failed to check for updates: ${error.message}`);
    } finally {
        updateCheckInProgress = false;
    }
}

// Telegram-Status: zuerst den aktuellen Status neu senden und erst danach den
// vorherigen Status löschen. Nach einer Warnung/einem Fehler bleibt der alte
// Status einmalig als Momentaufnahme vor dem Vorfall im Chat stehen.
function enqueueTelegramOperation(operation) {
    const queuedOperation = telegramOperationQueue.then(operation, operation);
    telegramOperationQueue = queuedOperation.catch(() => {});
    return queuedOperation;
}

async function sendFreshStatusMessage(message) {
    if (!telegramAllow || !telegramToken || !telegramChatId || isShuttingDown) return;
    if (infoLevel !== "info") return;

    const previousStatusMessageId = lastTelegramStatusMessageId;
    const preservePreviousStatus = preserveCurrentTelegramStatusOnNextSend;
    return enqueueTelegramOperation(async () => {
        try {
            const res = await axios.post(telegramApiUrl, {
                chat_id: telegramChatId,
                text: message,
                parse_mode: "HTML"
            });
            if (res.data?.ok === false) {
                throw new Error(res.data.description || "Telegram rejected the status message");
            }
            lastTelegramStatusMessageId = res.data?.result?.message_id ?? null;
            preserveCurrentTelegramStatusOnNextSend = false;
            saveSessionMeta();

            if (previousStatusMessageId && !preservePreviousStatus) {
                try {
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/deleteMessage`, {
                        chat_id: telegramChatId,
                        message_id: previousStatusMessageId
                    });
                } catch (_) { /* Nachricht bereits gelöscht oder Telegram vorübergehend nicht erreichbar */ }
            }
            logger.info(`Telegram Statusnachricht gesendet`);
        } catch (err) {
            logger.error(`Failed to send Telegram message: ${err.message}`);
        }
    });
}

// Verbesserte Nachrichtenfunktion
function sendMessage(message, level) {
    if (isShuttingDown) return;

    if (telegramAllow && telegramToken && telegramChatId) {
        const shouldSend = (level === "error") ||
            (level === "warn" && infoLevel !== "error") ||
            (level === "info" && infoLevel === "info");

        if (shouldSend) {
            if (level === "warn" || level === "error") {
                preserveCurrentTelegramStatusOnNextSend = true;
            }
            enqueueTelegramOperation(async () => {
                try {
                    const res = await axios.post(telegramApiUrl, {
                        chat_id: telegramChatId,
                        text: message,
                        parse_mode: "HTML"
                    });
                    if (res.data?.ok === false) {
                        throw new Error(res.data.description || "Telegram rejected the message");
                    }
                    logger.info(`Telegram message sent: ${message.replace(/\n/g, ' | ')}`);
                } catch (err) {
                    logger.error(`Failed to send Telegram message: ${err.message}`);
                }
            });
        }
    }

    if (discordAllow && discordWebhookUrl) {
        const colors = {
            error: 0xFF0000,
            warn: 0xFFFF00,
            info: 0x00FF00
        };
        const color = colors[level] || 0xFFFFFF;
        const titles = {
            error: "Error Notification",
            warn: "Warning Notification",
            info: "Info Notification"
        };

        const shouldSend = (level === "error") ||
            (level === "warn" && infoLevel !== "error") ||
            (level === "info" && infoLevel === "info");

        if (shouldSend) {
            axios.post(discordWebhookUrl, {
                embeds: [{
                    title: titles[level],
                    description: message,
                    color: color,
                    timestamp: new Date().toISOString()
                }]
            }).then(() => {
                logger.info(`Discord message sent: ${message}`);
            }).catch(err => {
                logger.error(`Failed to send Discord message: ${err.message}`);
            });
        }
    }
}

// Hilfsfunktionen (unverändert)
const getRandomInteger = (min, max) => {
    return Math.floor(Math.random() * (max - min)) + min;
};

function getInterval(daten) {
    if (!Number.isFinite(daten) || daten <= 0) {
        return 1; // Emergency: lesbarer Nullstand oder fehlgeschlagener Refill darf nie 5 Minuten warten.
    }

    const safeUpperBound = Math.min(
        getPhysicalSafeIntervalSeconds(daten),
        MAX_CHECK_INTERVAL_SECONDS
    );
    let preferredInterval;

    if (sleepmode === "random") {
        preferredInterval = getRandomInteger(300, 501);
    } else if (sleepmode === 'fixed') {
        if (sleepTime < 60) {
            logger.warn("Sleep time is less than 60 seconds, setting to 60 seconds.");
            preferredInterval = 60;
        } else {
            preferredInterval = sleepTime || 300;
        }
    } else if (sleepmode === "smart") {
        preferredInterval = getSmartInterval(daten, safeUpperBound);
    } else {
        logger.warn("Invalid sleep mode, defaulting to smart interval.");
        preferredInterval = getSmartInterval(daten, safeUpperBound);
    }

    const interval = Math.max(1, Math.min(preferredInterval, safeUpperBound));
    if (preferredInterval > safeUpperBound) {
        logger.debug(`Intervall aus Sicherheitsgründen von ${preferredInterval}s auf ${interval}s begrenzt`);
    }
    return interval;
}

function getPhysicalSafeIntervalSeconds(datenVolumen) {
    if (!Number.isFinite(datenVolumen) || datenVolumen <= 0) {
        return 1;
    }

    const usableGb = datenVolumen - REFILL_SAFETY_RESERVE_GB - VOLUME_READING_TICK_GB;
    if (usableGb <= 0) {
        return 1;
    }

    const secondsUntilReserve = usableGb * 8000 / MAX_DOWNLOAD_MBIT;
    return Math.max(1, Math.floor(secondsUntilReserve - SMART_EARLY_CHECK_SECONDS));
}

function getSafeCheckDeadline(datenVolumen, baselineAt) {
    if (!Number.isFinite(datenVolumen) || datenVolumen <= 0 || !Number.isFinite(baselineAt) || baselineAt <= 0) {
        return 0;
    }
    return baselineAt + getPhysicalSafeIntervalSeconds(datenVolumen) * 1000;
}

function getSmartInterval(datenVolumen, safeUpperBound = Math.min(
    getPhysicalSafeIntervalSeconds(datenVolumen),
    MAX_CHECK_INTERVAL_SECONDS
)) {
    // Bei wenig Volumen wird der spätestmögliche sichere Termin genutzt, um
    // Refill-Zyklen und Reloads zu sparen. Bei viel Volumen bleibt eine kleine
    // Zufallsspanne; die Obergrenze beträgt standardmäßig 15 Minuten.
    let base;
    if (safeUpperBound <= 120) {
        base = safeUpperBound;
    } else {
        const lowerBound = Math.max(
            MIN_CHECK_INTERVAL_SECONDS,
            Math.floor(safeUpperBound * 0.85)
        );
        base = getRandomInteger(lowerBound, safeUpperBound + 1);
    }

    logger.debug(`⏱️ Smart Interval: ${base}s (${datenVolumen.toFixed(3)} GB, sichere Obergrenze ${safeUpperBound}s)`);
    return base;
}

// Timer-Management
function startTimers() {
    // Keep-Alive Timer
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    if (keepAliveEnabled) {
        keepAliveTimer = setInterval(() => {
            if (!isShuttingDown && page && !page.isClosed()) {
                void keepSessionAlive().catch(error =>
                    logger.error(`Keep-Alive-Timer fehlgeschlagen: ${error.message}`)
                );
            }
        }, SESSION_KEEPALIVE_INTERVAL);
    } else {
        logger.info("Separater Keep-Alive deaktiviert - keine zusätzlichen Reloads zwischen Datenchecks");
    }

    // Memory Check Timer
    if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
    }
    memoryCheckTimer = setInterval(() => {
        if (!isShuttingDown) {
            void checkMemoryUsage().catch(error =>
                logger.error(`Memory-Check-Timer fehlgeschlagen: ${error.message}`)
            );
        }
    }, MEMORY_CHECK_INTERVAL);

    // Browser Restart Timer
    if (browserRestartTimer) {
        clearInterval(browserRestartTimer);
        browserRestartTimer = null;
    }
    if (BROWSER_RESTART_INTERVAL > 0) {
        logger.info(
            `Planmäßiger Browser-Neustart alle ` +
            `${(BROWSER_RESTART_INTERVAL / 60 / 60 / 1000).toFixed(2)} Stunden aktiviert`
        );
        browserRestartTimer = setInterval(() => {
            if (!isShuttingDown) {
                updateHeartbeat(); // Signalisiere Watchdog dass Restart beabsichtigt ist
                void restartBrowserWhenIdle(
                    `Planmäßiger Browser-Neustart nach ${(BROWSER_RESTART_INTERVAL / 60 / 60 / 1000).toFixed(2)} Stunden`,
                    false,
                    true
                ).catch(error =>
                    logger.error(`Planmäßiger Browser-Neustart fehlgeschlagen: ${error.message}`)
                );
            }
        }, BROWSER_RESTART_INTERVAL);
    } else {
        logger.info("Planmäßiger Browser-Neustart deaktiviert (Recovery bei Fehler/Speicher bleibt aktiv)");
    }
}

function stopTimers() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
    if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
        memoryCheckTimer = null;
    }
    if (browserRestartTimer) {
        clearInterval(browserRestartTimer);
        browserRestartTimer = null;
    }
    stopWatchdog();
}

// Verbesserte Hauptschleife mit besserer Fehlerbehandlung
async function start() {
    logger.info("🚀 Starting lidl-extender script v" + version);
    logger.info(`Browser-Konfiguration: ${browserType}`);
    logger.info(
        `Sicherheitsplanung: max. ${MAX_DOWNLOAD_MBIT} Mbit/s, ` +
        `${REFILL_SAFETY_RESERVE_GB} GB Reserve, Refill ab ${REFILL_TRIGGER_GB.toFixed(3)} GB, ` +
        `budget-sicher ab ${RATE_LIMIT_SAFE_MIN_INTERVAL_SECONDS}s Abstand, ` +
        `max. Check-Intervall ${MAX_CHECK_INTERVAL_SECONDS}s`
    );
    if (REFILL_TRIGGER_GB < RATE_LIMIT_SAFE_REFILL_TRIGGER_GB) {
        logger.warn(
            `Refill-Schwelle auf ${REFILL_TRIGGER_GB.toFixed(3)} GB begrenzt, ` +
            `obwohl für das Request-Budget rechnerisch ${RATE_LIMIT_SAFE_REFILL_TRIGGER_GB.toFixed(3)} GB nötig wären; ` +
            `REFILL_EXPECTED_GB/Reserve prüfen.`
        );
    }
    logger.info(
        `Request-Budget: ${RATE_LIMIT_WINDOWS.map(window => `${window.maxRequests}/${window.label}`).join(", ")}`
    );
    logger.info(
        `Session-Schutz: Token-Preflight ${TOKEN_PREFLIGHT_SECONDS}s vor Ablauf, ` +
        `Cooldown ${Math.round(TOKEN_PREFLIGHT_COOLDOWN_MS / 60000)}min; ` +
        `Wartungs-Backoff ${MAINTENANCE_BACKOFF_MINUTES}min`
    );
    logger.info(
        `Speicher-Recovery: Node-RSS ab ${MEMORY_RESTART_THRESHOLD_MB}MB, ` +
        `Browser-RSS ab ${BROWSER_MEMORY_RESTART_THRESHOLD_MB}MB, ` +
        `jeweils nach ${MEMORY_RESTART_CONSECUTIVE_SAMPLES} aufeinanderfolgenden 10-Minuten-Messungen`
    );
    const oneRefillInterval = getPhysicalSafeIntervalSeconds(REFILL_EXPECTED_GB);
    const requiredChecksPerHour = 3600 / Math.max(1, oneRefillInterval);
    const strictestHourlyBudget = Math.min(
        ...RATE_LIMIT_WINDOWS.map(window => window.maxRequests * 60 * 60 * 1000 / window.durationMs)
    );
    if (requiredChecksPerHour > strictestHourlyBudget) {
        logger.error(
            `Konfiguration mathematisch nicht mit dem Request-Budget vereinbar: ` +
            `mindestens ${requiredChecksPerHour.toFixed(1)} Checks/h nötig, ` +
            `aber nur ${strictestHourlyBudget.toFixed(1)} erlaubt. Download muss gedrosselt werden.`
        );
    }

    // Erst alte Script-Instanzen sauber beenden. Deren Shutdown schließt den eigenen
    // Browser und persistiert den letzten Session-/Request-Stand. Würden wir zuerst
    // Browserprozesse killen, läuft die alte Instanz kurz mit einer zerstörten Seite
    // weiter und kann parallel zur neuen Instanz Recovery-Aktionen auslösen.
    if (killScriptInstances) {
        logger.info("Prüfe auf existierende script.js-Instanzen (KILL_SCRIPT_INSTANCES=true)...");
        await killExistingScriptInstances();
    } else {
        logger.info("Überspringen: KILL_SCRIPT_INSTANCES=false (alte Instanzen werden NICHT gekillt)");
    }

    // Danach nur noch verwaiste Playwright-Prozesse bereinigen (wenn aktiviert).
    if (killExistingProcesses) {
        logger.info("Prüfe auf verwaiste Playwright-Prozesse (KILL_EXISTING_PROCESSES=true)...");
        await killExistingPlaywright();
    } else {
        logger.info("Überspringen: KILL_EXISTING_PROCESSES=false (keine Prozesse werden gekillt)");
    }

    // Erst nach einer optionalen Altprozess-Bereinigung laden, damit deren letzter
    // persistierter Request-Stand nicht direkt wieder überschrieben wird.
    loadSessionMeta();

    // Jeder Neustart beginnt bewusst mit einem neuen Telegram-Statuszyklus.
    // Die alte Statusnachricht bleibt als Verlauf erhalten; der erste erfolgreiche
    // Datencheck legt eine neue Nachricht an, die danach wieder ersetzt wird.
    lastTelegramStatusMessageId = null;
    preserveCurrentTelegramStatusOnNextSend = false;
    saveSessionMeta();
    sendMessage(`🚀 Lidl-Extender v${version} gestartet`, "info");

    // Starte alle Timer
    startTimers();
    startWatchdog(); // Watchdog für Deadlock/CPU-Überwachung

    let mainTimeout = null;

    const runMain = async () => {
        if (isShuttingDown) return;
        if (mainRunInProgress) {
            logger.warn("Datencheck übersprungen - vorheriger Lauf ist noch aktiv");
            return;
        }

        if (restartPromise || keepAliveInProgress) {
            logger.debug("Datencheck wartet auf laufende Browseroperation");
            nextScheduledRun = Date.now() + 1000;
            mainTimeout = setTimeout(runMain, 1000);
            return;
        }

        if (maintenanceBackoffUntil > Date.now()) {
            const remainingSeconds = Math.ceil((maintenanceBackoffUntil - Date.now()) / 1000);
            logger.info(`Wartungsmodus-Backoff aktiv - nächster Versuch in ${remainingSeconds}s`);
            nextScheduledRun = maintenanceBackoffUntil;
            mainTimeout = setTimeout(runMain, remainingSeconds * 1000);
            return;
        }

        if (rateLimitBackoffUntil > Date.now()) {
            const remainingSeconds = Math.ceil((rateLimitBackoffUntil - Date.now()) / 1000);
            logger.info(`Persistierter Rate-Limit-Backoff aktiv - nächster Versuch in ${remainingSeconds}s`);
            nextScheduledRun = rateLimitBackoffUntil;
            mainTimeout = setTimeout(runMain, remainingSeconds * 1000);
            return;
        }

        mainRunInProgress = true;
        updateHeartbeat(); // Watchdog: geplanter Lauf gestartet
        nextScheduledRun = 0; // Sleep-Fenster beendet

        let datenVolumen = 0;
        let statusMessage = null;
        let forceNewMessage = false;
        let nextInterval = 300; // Default 5 Minuten
        let lastResult = null;
        let hasExplicitInterval = false;

        try {
            // Hauptfunktion ausführen
            lastMainRunTime = Date.now(); // Keep-Alive nach jedem Lauf drosseln (unabhängig vom Ergebnis)
            const mainStart = Date.now();
            lastResult = await main();
            logger.debug(`⏱️ main() Laufzeit: ${((Date.now() - mainStart) / 1000).toFixed(1)}s`);
            datenVolumen = lastResult.datenVolumen;
            statusMessage = lastResult.statusMessage;
            forceNewMessage = lastResult.forceNewMessage ?? false;

            // Rate-Limit Backoff als Interval verwenden
            if (lastResult.maintenanceBackoffSeconds) {
                nextInterval = lastResult.maintenanceBackoffSeconds;
                hasExplicitInterval = true;
            } else if (lastResult.rateLimitBackoffSeconds) {
                nextInterval = lastResult.rateLimitBackoffSeconds;
                hasExplicitInterval = true;
            } else if (lastResult.nanRetryIn) {
                nextInterval = lastResult.nanRetryIn;
                hasExplicitInterval = true;
                logger.info(`🔄 NaN-Retry in ${nextInterval}s`);
            }

            // Reset consecutive errors bei Erfolg
            if (Number.isFinite(lastResult.schedulingVolume) && lastResult.schedulingVolume > 0) {
                consecutiveErrors = 0;
            }

        } catch (err) {
            const retryableLoginFailure =
                loginAttempts > 0 &&
                loginAttempts < MAX_LOGIN_ATTEMPTS &&
                /Login .*fehlgeschlagen|Login .*nicht erfolgreich/i.test(err.message || "");
            if (retryableLoginFailure) {
                logger.warn(`Login-Versuch ${loginAttempts}/${MAX_LOGIN_ATTEMPTS} fehlgeschlagen - nächster Versuch wird geplant`);
                sendMessage(
                    `⏳ Login-Versuch ${loginAttempts}/${MAX_LOGIN_ATTEMPTS} nicht erfolgreich. Ein neuer Versuch wird geplant.`,
                    "info"
                );
            } else {
                logger.error(`Error in main execution: ${err.message}`);
                sendMessage(`🚨 Fehler in Hauptausführung: ${err.message}`, "error");
            }
            consecutiveErrors++;

            // Bei zu vielen Fehlern Browser neu aufbauen; der Folgetermin bleibt
            // trotzdem an die letzte bekannte Daten-Deadline gebunden.
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                logger.error(`Zu viele aufeinanderfolgende Fehler (${consecutiveErrors}) - Browser-Neustart`);
                sendMessage(`⚠️ Zu viele Fehler - Browser wird neu gestartet`, "warn");

                // Browser komplett neu starten
                try {
                    await restartBrowser();
                } catch (restartError) {
                    logger.error(`Browser-Neustart fehlgeschlagen: ${restartError.message}`);
                }
            }
        } finally {
            mainRunInProgress = false;
        }

        // Timer-Restarts dürfen keinen Datencheck oder Refill unterbrechen.
        if (
            !isShuttingDown &&
            !maintenanceActive &&
            pendingPlannedRestart &&
            (!refillFollowupPending || pendingRestartMustRun)
        ) {
            const forceClean = pendingRestartForceClean;
            pendingPlannedRestart = false;
            pendingRestartForceClean = false;
            pendingRestartMustRun = false;
            try {
                await restartBrowser(forceClean);
            } catch (restartError) {
                logger.error(`Verschobener Browser-Neustart fehlgeschlagen: ${restartError.message}`);
            }
        } else if (pendingPlannedRestart && refillFollowupPending) {
            logger.info("Verschobener Browser-Neustart bleibt bis zum Refill-Folgecheck ausstehend");
        }

        // Nächsten Lauf planen
        if (!isShuttingDown) {
            if (!hasExplicitInterval) {
                // Aktiven Rate-Limit-Backoff berücksichtigen
                if (rateLimitBackoffUntil > Date.now()) {
                    nextInterval = Math.ceil((rateLimitBackoffUntil - Date.now()) / 1000);
                } else if (Number.isFinite(lastResult?.nextCheckAt)) {
                    // Absoluter Termin: Laufzeit, Refill-Wartezeit und ein eventuell
                    // verschobener Browser-Neustart verlängern die Datenfrist nicht.
                    nextInterval = Math.max(
                        1,
                        Math.ceil((lastResult.nextCheckAt - Date.now()) / 1000)
                    );
                } else if (Number.isFinite(lastResult?.schedulingVolume) && lastResult.schedulingVolume > 0) {
                    nextInterval = getInterval(lastResult.schedulingVolume);
                } else {
                    // Bei einem Fehler nie blind fünf Minuten warten, wenn die letzte
                    // bekannte Daten-Deadline früher erreicht wird.
                    const fallbackDeadline = getSafeCheckDeadline(
                        lastSchedulingVolume,
                        lastSchedulingBaselineAt
                    );
                    if (fallbackDeadline > 0) {
                        nextInterval = Math.min(
                            300,
                            Math.max(
                                1,
                                Math.ceil((fallbackDeadline - Date.now()) / 1000)
                            )
                        );
                    } else {
                        nextInterval = 300;
                    }
                }
            }

            const hasVolumeResult =
                Number.isFinite(lastResult?.schedulingVolume) &&
                lastResult.schedulingVolume > 0;
            if (hasVolumeResult) {
                logger.info(`📊 Angezeigtes Datenvolumen: ${datenVolumen} GB`);
                if (Math.abs(lastResult.schedulingVolume - datenVolumen) > VOLUME_READING_TICK_GB) {
                    logger.info(`📐 Temporärer Planungswert nach Refill: ${lastResult.schedulingVolume.toFixed(3)} GB`);
                }
                logger.info(`⏰ Nächste Prüfung in ${nextInterval} Sekunden`);

                // Sende oder aktualisiere Telegram-Nachricht mit korrektem Interval
                if (statusMessage) {
                    statusMessage += `\n⏰ Nächste Prüfung in ${nextInterval} Sekunden.`;
                    await sendFreshStatusMessage(statusMessage);
                }
            } else if (lastResult?.maintenanceBackoffSeconds) {
                logger.info(`Wartungsmodus aktiv - nächster Versuch in ${nextInterval} Sekunden`);
            } else {
                logger.warn("⚠️ Datenvolumen ist 0 oder Fehler aufgetreten");
            }

            // Timeout für nächsten Lauf setzen
            nextScheduledRun = Date.now() + nextInterval * 1000; // Watchdog: geplanter Sleep-Start
            mainTimeout = setTimeout(runMain, nextInterval * 1000);

            // Update-Prüfung erst nach dem zeitkritischen Datencheck und höchstens
            // einmal in sechs Stunden. Sie blockiert den nächsten Check nicht.
            if (
                autoUpdate &&
                nextInterval >= 60 &&
                Date.now() - lastUpdateCheckAt >= 6 * 60 * 60 * 1000
            ) {
                setTimeout(() => {
                    void checkForUpdates();
                }, 0);
            }
        }
    };

    // Ersten Lauf starten
    runMain();

    // Cleanup-Funktion für Shutdown
    return () => {
        if (mainTimeout) {
            clearTimeout(mainTimeout);
            mainTimeout = null;
        }
    };
}

// Verbessertes Graceful Shutdown
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;

    logger.info(`🛑 Received ${signal}. Shutting down gracefully...`);
    sendMessage(`🛑 Lidl-Extender v${version} wird beendet...`, "info");

    isShuttingDown = true;

    try {
        // Stoppe alle Timer
        stopTimers();

        // Aktuelle Cookies, localStorage und insbesondere den live rotierten
        // sessionStorage-Token sichern, bevor der Tab geschlossen wird.
        await persistCurrentBrowserSession("vor Shutdown");

        // Schließe Browser sicher
        await closeBrowserSafely();

        // Kurze Pause für finale Logs
        await delay(2000);

        logger.info("✅ Graceful shutdown completed");

    } catch (error) {
        logger.error(`Fehler beim Shutdown: ${error.message}`);
    } finally {
        process.exit(0);
    }
}

// Signal Handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Unhandled Promise Rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    sendMessage(`🚨 Unhandled Promise Rejection: ${reason}`, "error");
    consecutiveErrors++;
});

// Uncaught Exceptions
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    sendMessage(`🚨 Uncaught Exception: ${error.message}`, "error");
    gracefulShutdown('uncaughtException');
});

// Starte das Script
try {
    await start();
} catch (error) {
    logger.error(`Fehler beim Starten: ${error.message}`);
    sendMessage(`🚨 Fehler beim Starten: ${error.message}`, "error");
    process.exit(1);
}
