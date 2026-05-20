import createLogger from "logging";
import * as playwright from "playwright";
import axios from "axios";

import dotenv from "dotenv";
dotenv.config({ path: new URL('./.env', import.meta.url).pathname });
// .env geladen?
if (!process.env.RUFNUMMER || !process.env.PASSWORD) {
    throw new Error("ENV Fehler: RUFNUMMER oder PASSWORD fehlt oder ist leer");
}

import * as fs from "fs";
import { exec } from "child_process";

const logger = createLogger("lidl-extender");

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
const sleepmode = process.env.SLEEP_MODE;
const sleepTime = parseInt(process.env.SLEEP_TIME, 10);
const infoLevel = process.env.INFO_LEVEL || "info";

// URLs
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const loginUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect.html";
const uebersichtUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect/uebersicht.html";

const version = "1.2.5";
const updateUrl = "https://raw.githubusercontent.com/user871258938/lidl/main/package.json";
const scriptUrl = "https://raw.githubusercontent.com/user871258938/lidl/main/script.js";

const delay = ms => new Promise(res => setTimeout(res, ms));
const cookiefile = "cookies.json";
const sessionMetaFile = "session_meta.json";

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
const SESSION_KEEPALIVE_INTERVAL = 2 * 60 * 1000; // 2 Minuten (häufiger)
const SESSION_TIMEOUT = 25 * 60 * 1000; // 25 Minuten (kürzer)
const BROWSER_RESTART_INTERVAL = 2 * 60 * 60 * 1000; // 2 Stunden
const MEMORY_CHECK_INTERVAL = 10 * 60 * 1000; // 10 Minuten
const MAX_MEMORY_MB = 500; // Maximaler Speicherverbrauch in MB

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

// Zeitpunkt des letzten erfolgreichen main()-Laufs (für Keep-Alive-Throttling)
let lastMainRunTime = 0;

// Telegram: ID der letzten Status-Nachricht (für Edit statt neue Nachricht)
let lastTelegramStatusMessageId = null;

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
        if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
            logger.error(`🚨 WATCHDOG: Deadlock erkannt! Kein Heartbeat seit ${timeSinceLastHeartbeat}ms - Versuche Browser-Restart`);
            sendMessage(`🚨 WATCHDOG: Script scheint zu hängen (${timeSinceLastHeartbeat}ms kein Heartbeat) - Versuche Restart`, "warn");
            
            try {
                await restartBrowser();
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
                await restartBrowser();
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

        let processesKilled = 0;
        const { execSync } = await import('child_process');

        if (isWindows) {
            // Auf Windows: Finde alle node.exe mit script.js
            try {
                const output = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO LIST', { encoding: 'utf-8' });
                const lines = output.split('\n');
                const pidMatches = lines.filter(l => l.startsWith('PID')).map(l => parseInt(l.split(':')[1].trim()));
                
                for (const pid of pidMatches) {
                    if (pid !== currentPid) {
                        try {
                            execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: 'pipe' });
                            processesKilled++;
                            logger.info(`Node.js Prozess ${pid} beendet`);
                        } catch (err) {
                            // Prozess konnte nicht gekillt werden
                        }
                    }
                }
            } catch (err) {
                // tasklist fehlgeschlagen
            }
        } else if (isLinux || isMac) {
            // Auf Linux/macOS: pgrep nach script.js
            try {
                const output = execSync(`pgrep -f "node.*script\.js" 2>/dev/null || true`, { encoding: 'utf-8' });
                const pids = output.trim().split('\n').filter(line => line.length > 0).map(p => parseInt(p));
                
                for (const pid of pids) {
                    if (pid !== currentPid && !isNaN(pid)) {
                        try {
                            execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'pipe' });
                            processesKilled++;
                            logger.info(`Node.js Prozess ${pid} beendet`);
                        } catch (err) {
                            // Prozess konnte nicht gekillt werden
                        }
                    }
                }
            } catch (err) {
                // pgrep fehlgeschlagen
            }
        }

        if (processesKilled > 0) {
            logger.info(`✅ Insgesamt ${processesKilled} alte script.js-Instanz(en) gekillt`);
            await delay(1000); // Wartezeit
        } else {
            logger.info("✅ Keine alten script.js-Instanzen gefunden");
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
            // Auf Linux/macOS: pgrep zum Zählen, dann pkill zum Killen
            const browserProcesses = ['chrome', 'firefox', 'chromium', 'chromium-browser', 'google-chrome'];
            
            for (const processName of browserProcesses) {
                try {
                    // Zähle wie viele Prozesse gefunden wurden
                    const output = execSync(`pgrep -f ${processName} 2>/dev/null || true`, { encoding: 'utf-8' });
                    const count = output.trim().split('\n').filter(line => line.length > 0).length;
                    
                    if (count > 0) {
                        // Killen
                        execSync(`pkill -f ${processName} 2>/dev/null || true`, { stdio: 'pipe' });
                        processesKilled += count;
                        logger.info(`${count} ${processName}-Prozess(e) beendet`);
                    }
                } catch (err) {
                    // Prozess nicht gefunden ist ok
                }
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

async function checkMemoryUsage() {
    const memory = getMemoryUsage();
    logger.info(`Memory usage: RSS=${memory.rss}MB, Heap=${memory.heapUsed}/${memory.heapTotal}MB`);

    if (memory.rss > MAX_MEMORY_MB) {
        logger.warn(`Hoher Speicherverbrauch: ${memory.rss}MB > ${MAX_MEMORY_MB}MB`);
        sendMessage(`⚠️ Hoher Speicherverbrauch: ${memory.rss}MB`, "warn");

        // Force garbage collection wenn verfügbar
        if (global.gc) {
            global.gc();
            logger.info("Garbage collection ausgeführt");
        }

        // Browser restart bei kritischem Speicherverbrauch
        if (memory.rss > MAX_MEMORY_MB * 1.5) {
            logger.error("Kritischer Speicherverbrauch - Browser restart");
            await restartBrowser();
        }
    }
}

// Session-Metadaten verwalten (verbessert)
function saveSessionMeta() {
    try {
        const sessionMeta = {
            lastActivity: lastActivityTime,
            loginTime: Date.now(),
            // userAgent wird jetzt dynamisch generiert, nicht gespeichert
            browserRestartTime: lastBrowserRestart,
            memoryUsage: getMemoryUsage()
        };
        fs.writeFileSync(sessionMetaFile, JSON.stringify(sessionMeta, null, 2));
    } catch (error) {
        logger.warn(`Fehler beim Speichern der Session-Metadaten: ${error.message}`);
    }
}

// Verbessertes Keep-Alive mit Fehlerbehandlung
async function keepSessionAlive() {
    if (!page || page.isClosed() || isShuttingDown) return;

    // Skip wenn main() kürzlich gelaufen ist (verhindert Rate-Limit durch Doppel-Requests)
    const timeSinceLastMain = Date.now() - lastMainRunTime;
    if (timeSinceLastMain < SESSION_KEEPALIVE_INTERVAL) {
        logger.debug(`Keep-Alive übersprungen - main() lief vor ${Math.round(timeSinceLastMain / 1000)}s`);
        updateHeartbeat();
        return;
    }

    try {
        const keepAlivePromise = (async () => {
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
            await restartBrowser();
        }
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
async function restartBrowser() {
    logger.info("Browser wird neu gestartet...");

    try {
        await closeBrowserSafely();

        // Kurze Pause vor Neustart
        await delay(5000);

        const success = await initializeBrowser();
        if (success) {
            lastBrowserRestart = Date.now();
            consecutiveErrors = 0;
            loginAttempts = 0;
            circuitBreaker.reset();
            updateHeartbeat(); // Signalisiere Watchdog dass Browser aktiv ist
            logger.info("Browser erfolgreich neu gestartet");
            sendMessage("🔄 Browser wurde neu gestartet", "info");
        } else {
            throw new Error("Browser-Neustart fehlgeschlagen");
        }
    } catch (error) {
        logger.error(`Browser-Neustart fehlgeschlagen: ${error.message}`);
        consecutiveErrors++;
        throw error;
    }
}

// Verbesserte Browser-Initialisierung
async function initializeBrowser() {
    if (isShuttingDown) return false;

    try {
        await closeBrowserSafely();

        const userDataDir = './lidl-extender-data';

        // Lösche Browser-Daten immer beim Start für frischen Login
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

        // Generiere zufällige Fingerprint (außer locale/timezone)
        const fingerprint = generateFingerprint();
        logger.info(`🎭 Neue Browser-Fingerprint: UA=${fingerprint.userAgent.substring(0, 60)}..., Viewport=${fingerprint.viewport.width}x${fingerprint.viewport.height}, Memory=${fingerprint.deviceMemory}GB, Cores=${fingerprint.hardwareConcurrency}`);

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
            logger.debug(`Request: ${request.method()} ${request.url()}`);
        });

        page.on('response', response => {
            logger.debug(`Response: ${response.status()} ${response.url()}`);
        });

        page.on('pageerror', error => {
            logger.error(`Page error: ${error.message}`);
        });

        page.on('crash', () => {
            logger.error("Page crashed!");
            consecutiveErrors++;
        });

        return true;
    } catch (error) {
        logger.error(`Fehler bei Browser-Initialisierung: ${error.message}`);
        consecutiveErrors++;
        return false;
    }
}

// Verbesserte Login-Funktion mit Timeout und Retry-Logik
async function performLogin() {
    if (isShuttingDown) return false;

    try {
        if (page.url().startsWith(uebersichtUrl)) {
            logger.info("Bereits auf der Übersichtsseite, kein Login nötig");
            return true;
        }

        loginAttempts++;
        if (loginAttempts > MAX_LOGIN_ATTEMPTS) {
            throw new Error(`Maximale Anzahl Login-Versuche (${MAX_LOGIN_ATTEMPTS}) erreicht`);
        }

        logger.info(`Login-Versuch ${loginAttempts}/${MAX_LOGIN_ATTEMPTS}...`);

        const loginPromise = (async () => {
            await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
            await delay(2000);

			await page.waitForSelector('input[name="msisdn"]', { timeout: 15000 });
			await page.waitForSelector('input[name="password"]', { timeout: 15000 });
			
			// Felder leeren und ausfüllen
			await page.fill('input[name="msisdn"]', '');
			await page.fill('input[name="password"]', '');
            await delay(1000);

			await page.fill('input[name="msisdn"]', rufnummer);
            await page.fill('input[name="password"]', passwort);

            logger.info("Login-Daten eingegeben, sende Formular...");

            // Login-Button klicken und auf Navigation warten
            await Promise.all([
                page.click('button[type="submit"]:has-text("Einloggen")'),
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 })
            ]);

            // Warte bis Redirect abgeschlossen und Vue initialisiert ist
            await delay(3000);
            try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch (_) {}
            await delay(1000);

            const currentUrl = page.url();
            // Akzeptiere auch /mein-lidl-connect/ als valide post-login URL (falls Lidl Redirect geändert)
            if (!currentUrl.includes("mein-lidl-connect")) {
                throw new Error(`Login fehlgeschlagen, unerwartete URL: ${currentUrl}`);
            }

            // Falls auf Übersichtsseite umgeleitet, gut - sonst manuell navigieren
            if (!currentUrl.startsWith(uebersichtUrl)) {
                logger.info(`Post-login URL: ${currentUrl} - navigiere zu Übersicht`);
                await page.goto(uebersichtUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
                await delay(2000);
                const urlNachNav = page.url();
                if (!urlNachNav.includes("mein-lidl-connect")) {
                    throw new Error(`Navigation zur Übersicht fehlgeschlagen: ${urlNachNav}`);
                }
            }

            // Speichere Session-Daten
            await context.storageState({ path: cookiefile });
            lastActivityTime = Date.now();
            saveSessionMeta();
            loginAttempts = 0;
            consecutiveErrors = 0;

            logger.info("Login erfolgreich, Session-Daten gespeichert");
            return true;
        })();

        return await Promise.race([
            loginPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Login timeout nach 60 Sekunden')), 60000)
            )
        ]);

    } catch (error) {
        logger.error(`Login fehlgeschlagen: ${error.message}`);
        consecutiveErrors++;

        // Bei wiederholten Fehlern längere Pause
        if (loginAttempts >= 2) {
            logger.info("Warte 60 Sekunden vor erneutem Login-Versuch...");
            await delay(60000);
        }

        return false;
    }
}

// Verbesserte Hauptfunktion mit Circuit Breaker
async function main() {
    if (isShuttingDown) return { datenVolumen: 0, statusMessage: null };

    let datenVolumen = 0.0;

    try {
        return await circuitBreaker.execute(async () => {
            // Browser initialisieren falls nötig
            if (!context || !page || page.isClosed()) {
                const initSuccess = await initializeBrowser();
                if (!initSuccess) {
                    throw new Error("Browser-Initialisierung fehlgeschlagen");
                }
            }

            // Login durchführen (Browser-Daten wurden bereits gelöscht bei initializeBrowser)
            logger.info("Führe Login durch...");
            const loginSuccess = await performLogin();
            if (!loginSuccess) {
                throw new Error("Login nach mehreren Versuchen fehlgeschlagen");
            }

            // Seite immer neu laden für aktuelle Daten
            await page.goto(uebersichtUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

            // Auf vollständiges Rendern der Vue-Komponenten warten (Netzwerk + DOM)
            try {
                await page.waitForLoadState("networkidle", { timeout: 20000 });
            } catch (_) {
                logger.debug("networkidle Timeout - fahre trotzdem fort");
            }

            // Warte bis die app-consumptions-v2 Komponente im DOM ist
            try {
                await page.waitForSelector('app-consumptions-v2, app-consumptions', { timeout: 15000 });
                logger.debug("Consumption-Komponente im DOM gefunden");
            } catch (error) {
                logger.warn(`Consumption-Komponente nicht gefunden: ${error.message}`);
            }

            // Extra-Wartezeit damit Vue die Labels rendern kann
            await delay(3000);

			// Datenvolumen auslesen (Tarif + Refill)
			// Versuche mehrere Selector-Varianten für alte und neue Seitenstruktur
			const usage = await page.evaluate(() => {
				const result = {
					tarif: { available: NaN, total: NaN, unit: '' },
					refill: { available: NaN, total: NaN, unit: '' }
				};

				function parseLabel(el) {
					if (!el) return null;
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

				// Rate-Limit-Erkennung: Lidl zeigt Platzhaltertext statt echter Daten
				if (isNaN(result.tarif.available)) {
					const rateLimitText = 'Im aktuellen Tarif sind keine Inklusiv-Einheiten';
					const pageText = document.body.innerText || '';
					if (pageText.includes(rateLimitText)) {
						result._rateLimited = true;
						return result;
					}
				}

				// Debug: Alle unit-display Elemente loggen falls nichts gefunden
				if (isNaN(result.tarif.available)) {
					const allLabels = Array.from(document.querySelectorAll('.unit-display, [class*="consumption"], [class*="data-volume"]'));
					result._debugSelectors = allLabels.slice(0, 10).map(el => ({
						tag: el.tagName,
						classes: el.className,
						for: el.getAttribute('for'),
						text: el.textContent.trim().substring(0, 80)
					}));
				}

				return result;
			});

			// Debug-Ausgabe falls Tarif-Daten fehlen
			if (isNaN(usage.tarif.available) && usage._debugSelectors) {
				logger.warn(`Keine bekannten Selektoren gefunden. Gefundene DOM-Elemente: ${JSON.stringify(usage._debugSelectors)}`);
			}
			
			let datenVerfuegbar = usage.tarif.available;
			let refillVerfuegbar = usage.refill.available;

			// Rate-Limit-Erkennung: Lidl zeigt Platzhaltertext wenn zu viele Anfragen
			if (usage._rateLimited) {
				logger.warn("⏳ Rate-Limit erkannt - Lidl zeigt keine Verbrauchsdaten. Warte 3 Minuten...");
				sendMessage("⏳ Rate-Limit: Lidl-Server antwortet mit leerem Verbrauch - Pause 3 Minuten", "warn");
				await delay(3 * 60 * 1000);
				return { datenVolumen: 0, statusMessage: null };
			}

			// NaN-Fehlerbehandlung: Wenn Datenvolumen nicht lesbar ist
			if (isNaN(datenVerfuegbar)) {
				nanErrorCount++;
				logger.warn(`Datenvolumen ist NaN - Fehler ${nanErrorCount}/${MAX_NAN_ERRORS}`);
				sendMessage(`⚠️ Datenvolumen nicht lesbar (${nanErrorCount}/${MAX_NAN_ERRORS}) - Seite wird neu geladen`, "warn");

				if (nanErrorCount >= MAX_NAN_ERRORS) {
					logger.error("Zu viele NaN-Fehler - Browser wird neu gestartet");
					sendMessage("🚨 Zu viele NaN-Fehler - Versuche Neuanmeldung", "warn");

					await restartBrowser();
					nanErrorCount = 0;

					throw new Error("NaN-Fehlerbehandlung: Browser neugestartet");
				}

				return { datenVolumen: 0, statusMessage: null }; // Rückgabewert 0 triggt längere Pause in der Hauptschleife
			}

			// Bei erfolgreicher Extraktion: NaN-Fehler zurücksetzen
			resetNanErrors();

			// Log both volumes
			const tarifMessage = `📊 Tarif: ${usage.tarif.available} ${usage.tarif.unit} / ${usage.tarif.total} ${usage.tarif.unit}`;
			let refillMessage = '';
			
			// Only log refill if it's available (has valid numbers)
			if (!isNaN(refillVerfuegbar)) {
				refillMessage = `📊 Refill: ${usage.refill.available} ${usage.refill.unit} / ${usage.refill.total} ${usage.refill.unit}`;
				logger.info(refillMessage);
			}
			
			logger.info(tarifMessage);

            // Nachbuchung falls nötig (unter 0.8 GB vom Refill Volumen)
            let nachbuchungsErfolg = false;
            let refillSuccessMessage = null;
            if (!isNaN(datenVerfuegbar) && datenVerfuegbar < 1 && (!isNaN(refillVerfuegbar) && refillVerfuegbar < 0.8)) {
                try {
                    logger.info("Wenig Datenvolumen, versuche Refill zu aktivieren...");
                    const refillVorher = refillVerfuegbar;
                    
                    await page.click('button:has-text("Refill aktivieren")', { timeout: 10000 });
                    await delay(7000);
                    
                    // Seite neu laden und Refill-Volumen neu prüfen
                    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
                    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch (_) {}
                    await delay(3000);
                    
                    const usageNach = await page.evaluate(() => {
                        const result = { available: NaN, total: NaN, unit: '' };
                        const candidates = [
                            document.querySelector('label[for="REFILLABLE_DATA"].unit-display'),
                            document.querySelector('app-consumptions-refill-v2 label[for="REFILLABLE_DATA"]'),
                            document.querySelector('app-consumptions-refill-v2 .unit-display'),
                            document.querySelector('app-consumptions-refill .unit-display'),
                        ];
                        for (const el of candidates) {
                            if (!el) continue;
                            const text = el.textContent.trim();
                            const nums = text.match(/(\d+(?:[.,]\d+)?)/g) || [];
                            if (nums[0]) {
                                result.available = parseFloat(nums[0].replace(',', '.'));
                                result.total = nums[1] ? parseFloat(nums[1].replace(',', '.')) : NaN;
                                const unitEl = el.querySelector('span.unit');
                                result.unit = unitEl ? unitEl.textContent.trim() : '';
                                break;
                            }
                        }
                        return result;
                    });
                    
                    const refillNachher = usageNach.available;
                    
                    // Prüfe ob Refill sich erhöht hat
                    if (!isNaN(refillNachher) && refillNachher > refillVorher) {
                        nachbuchungsErfolg = true;
                        logger.info(`✅ Refill erfolgreich aktiviert: ${refillVorher}GB → ${refillNachher}GB`);
                        
                        // Aktualisiere refillVerfuegbar mit neuem Wert für korrekte Berechnung
                        refillVerfuegbar = refillNachher;
                        
                        // Erfolgs-Nachricht vorbereiten (Interval wird in runMain() angehängt)
                        refillSuccessMessage = `✅ Refill erfolgreich aktiviert!\n`;
                        refillSuccessMessage += `📊 Tarif: ${datenVerfuegbar} GB / ${usage.tarif.total} GB\n`;
                        refillSuccessMessage += `📊 Refill: ${refillVorher} GB → ${refillNachher} GB`;
                    } else {
                        logger.warn(`Refill-Aktivierung möglicherweise fehlgeschlagen: ${refillVorher}GB → ${refillNachher}GB`);
                    }
                } catch (e) {
                    logger.error(`Fehler beim Nachbuchungsversuch: ${e.message}`);
                    sendMessage(`❌ Refill-Aktivierung fehlgeschlagen: ${e.message}`, "error");
                }
            }

            // Gesamtes verfügbares Datenvolumen = Tarif + Refill
            datenVolumen = datenVerfuegbar + (!isNaN(refillVerfuegbar) ? refillVerfuegbar : 0);
            lastActivityTime = Date.now();
            lastMainRunTime = Date.now(); // Keep-Alive-Throttling
            saveSessionMeta();
            updateHeartbeat(); // Watchdog-Signal

            // Rückgabe: Refill-Nachricht oder normaler Status (Interval wird in runMain() angehängt)
            if (nachbuchungsErfolg) {
                return { datenVolumen, statusMessage: refillSuccessMessage, forceNewMessage: true };
            }

            let finalStatusMessage = `📊 Tarif: ${datenVerfuegbar} GB / ${usage.tarif.total} GB`;
            if (!isNaN(refillVerfuegbar)) {
                finalStatusMessage += `\n📊 Refill: ${refillVerfuegbar} GB / ${usage.refill.total} GB`;
            }
            return { datenVolumen, statusMessage: finalStatusMessage, forceNewMessage: false };
        });

    } catch (error) {
        sendMessage(`🚨 Fehler aufgetreten: ${error.message}`, "error");
        logger.error(`Fehler in main(): ${error.message}`);
        consecutiveErrors++;

        // Bei kritischen Fehlern Browser neu starten
        if (consecutiveErrors >= 3) {
            logger.error("Mehrere aufeinanderfolgende Fehler - Browser restart");
            await restartBrowser();
        }

        return { datenVolumen: 0, statusMessage: null };
    }
}

// Update-Funktion (unverändert)
async function checkForUpdates() {
    try {
        const response = await axios.get(updateUrl);
        const latestVersion = response.data.version;
        if (latestVersion.localeCompare(version, undefined, { numeric: true }) > 0) {
            logger.warn(`New version available: ${latestVersion}. Updating the script...`);
            if (autoUpdate) {
                const scriptPath = 'script.js';
                const updatedScript = await axios.get(scriptUrl);
                fs.writeFileSync(scriptPath, updatedScript.data, "utf-8");
                logger.info("Script updated successfully. Please restart the script.");
                exec(`node ${scriptPath}`, (error, _, stderr) => {
                    if (!error) {
                        sendMessage(`Script updated to version ${latestVersion}.`, "info");
                        logger.info(`Script updated to version ${latestVersion}.`);
                        process.exit(0);
                    } else {
                        logger.error(`Failed to restart the script: ${stderr}`);
                        sendMessage(`Failed to restart the script: ${stderr}`, "error");
                    }
                });
            } else {
                logger.warn("Auto-update is disabled. Please update the script manually.");
            }
        } else {
            logger.info("You are using the latest version of the script.");
        }
    } catch (error) {
        logger.error(`Failed to check for updates: ${error.message}`);
    }
}

// Telegram Status-Nachricht: alte löschen, neue senden (immer aktueller Zeitstempel sichtbar)
async function sendOrEditStatusMessage(message) {
    if (!telegramAllow || !telegramToken || !telegramChatId || isShuttingDown) return;
    if (infoLevel !== "info") return;

    // Alte Nachricht löschen
    if (lastTelegramStatusMessageId) {
        try {
            await axios.post(`https://api.telegram.org/bot${telegramToken}/deleteMessage`, {
                chat_id: telegramChatId,
                message_id: lastTelegramStatusMessageId
            });
        } catch (_) { /* Nachricht bereits gelöscht oder zu alt - ignorieren */ }
        lastTelegramStatusMessageId = null;
    }

    // Neue Nachricht senden
    try {
        const res = await axios.post(telegramApiUrl, {
            chat_id: telegramChatId,
            text: message,
            parse_mode: "HTML"
        });
        lastTelegramStatusMessageId = res.data?.result?.message_id ?? null;
        logger.info(`Telegram Statusnachricht gesendet`);
    } catch (err) {
        logger.error(`Failed to send Telegram message: ${err.message}`);
    }
}

// Verbesserte Nachrichtenfunktion
function sendMessage(message, level) {
    if (isShuttingDown) return;

    // Bei Fehler/Warnung: Status-ID zurücksetzen (nächste Status-Msg sendet als neue Nachricht)
    if (level === "error" || level === "warn") {
        lastTelegramStatusMessageId = null;
    }

    if (telegramAllow && telegramToken && telegramChatId) {
        const shouldSend = (level === "error") ||
            (level === "warn" && infoLevel !== "error") ||
            (level === "info" && infoLevel === "info");

        if (shouldSend) {
            axios.post(telegramApiUrl, {
                chat_id: telegramChatId,
                text: message,
                parse_mode: "HTML"
            }).then(() => {
                logger.info(`Telegram message sent: ${message}`);
            }).catch(err => {
                logger.error(`Failed to send Telegram message: ${err.message}`);
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
    if (daten === 0) {
        return 60; // Mindestens 1 Minute bei Fehlern
    }
    if (sleepmode === "random") {
        return getRandomInteger(300, 500);
    }
    if (sleepmode === 'fixed') {
        if (sleepTime < 60) {
            logger.warn("Sleep time is less than 60 seconds, setting to 60 seconds.");
            return 60;
        }
        return sleepTime || 300;
    }
    if (sleepmode === "smart") {
        return getSmartInterval(daten);
    }
    logger.warn("Invalid sleep mode, defaulting to random interval.");
    return getRandomInteger(300, 500);
}

function getSmartInterval(Datenvolumen) {
    // Intervals kalibriert für max. 50 Mbit/s (= 6,25 MB/s):
    // Max-Interval × 6,25 MB/s < verbleibendes Volumen → Daten laufen nie zwischen zwei Prüfungen aus
    if (Datenvolumen >= 10) {
        return getRandomInteger(600, 900);    // max 900s × 6,25 MB/s ≈ 5,6 GB < 10 GB ✓
    } else if (Datenvolumen >= 5) {
        return getRandomInteger(300, 480);    // max 480s × 6,25 MB/s ≈ 3,0 GB < 5 GB ✓
    } else if (Datenvolumen >= 3) {
        return getRandomInteger(180, 300);    // max 300s × 6,25 MB/s ≈ 1,9 GB < 3 GB ✓
    } else if (Datenvolumen >= 2) {
        return getRandomInteger(90, 150);     // max 150s × 6,25 MB/s ≈ 0,9 GB < 2 GB ✓
    } else if (Datenvolumen >= 1.2) {
        return getRandomInteger(60, 90);      // max 90s  × 6,25 MB/s ≈ 0,56 GB < 1,2 GB ✓
    } else if (Datenvolumen >= 1.0) {
        return getRandomInteger(45, 60);      // max 60s  × 6,25 MB/s ≈ 0,37 GB < 1,0 GB ✓
    } else {
        return 45;
    }
}

// Timer-Management
function startTimers() {
    // Keep-Alive Timer
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
    }
    keepAliveTimer = setInterval(async () => {
        if (!isShuttingDown && page && !page.isClosed()) {
            await keepSessionAlive();
        }
    }, SESSION_KEEPALIVE_INTERVAL);

    // Memory Check Timer
    if (memoryCheckTimer) {
        clearInterval(memoryCheckTimer);
    }
    memoryCheckTimer = setInterval(() => {
        if (!isShuttingDown) {
            checkMemoryUsage();
        }
    }, MEMORY_CHECK_INTERVAL);

    // Browser Restart Timer
    if (browserRestartTimer) {
        clearInterval(browserRestartTimer);
    }
    browserRestartTimer = setInterval(async () => {
        if (!isShuttingDown) {
            logger.info("Planmäßiger Browser-Neustart nach 2 Stunden");
            updateHeartbeat(); // Signalisiere Watchdog dass Restart beabsichtigt ist
            await restartBrowser();
        }
    }, BROWSER_RESTART_INTERVAL);
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

    // Killen von existierenden Playwright-Prozessen beim Start (nur wenn aktiviert)
    if (killExistingProcesses) {
        logger.info("Prüfe auf existierende Playwright-Prozesse (KILL_EXISTING_PROCESSES=true)...");
        await killExistingPlaywright();
    } else {
        logger.info("Überspringen: KILL_EXISTING_PROCESSES=false (keine Prozesse werden gekillt)");
    }

    // Killen von existierenden script.js-Instanzen beim Start (nur wenn aktiviert)
    if (killScriptInstances) {
        logger.info("Prüfe auf existierende script.js-Instanzen (KILL_SCRIPT_INSTANCES=true)...");
        await killExistingScriptInstances();
    } else {
        logger.info("Überspringen: KILL_SCRIPT_INSTANCES=false (alte Instanzen werden NICHT gekillt)");
    }

    // Starte alle Timer
    startTimers();
    startWatchdog(); // Watchdog für Deadlock/CPU-Überwachung

    let mainTimeout = null;

    const runMain = async () => {
        if (isShuttingDown) return;

        let datenVolumen = 0;
        let statusMessage = null;
        let forceNewMessage = false;
        let nextInterval = 300; // Default 5 Minuten

        try {
            // Update-Check
            if (autoUpdate) {
                await checkForUpdates();
            }

            // Hauptfunktion ausführen
            const result = await main();
            datenVolumen = result.datenVolumen;
            statusMessage = result.statusMessage;
            forceNewMessage = result.forceNewMessage ?? false;

            // Reset consecutive errors bei Erfolg
            if (datenVolumen > 0) {
                consecutiveErrors = 0;
            }

        } catch (err) {
            logger.error(`Error in main execution: ${err.message}`);
            sendMessage(`🚨 Fehler in Hauptausführung: ${err.message}`, "error");
            consecutiveErrors++;

            // Bei zu vielen Fehlern längere Pause
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                logger.error(`Zu viele aufeinanderfolgende Fehler (${consecutiveErrors}). Längere Pause...`);
                sendMessage(`⚠️ Zu viele Fehler - Pause für 10 Minuten`, "warn");
                nextInterval = 600; // 10 Minuten Pause

                // Browser komplett neu starten
                try {
                    await restartBrowser();
                } catch (restartError) {
                    logger.error(`Browser-Neustart fehlgeschlagen: ${restartError.message}`);
                }
            }
        }

        // Nächsten Lauf planen
        if (!isShuttingDown) {
            if (nextInterval === 300) { // Nur wenn kein Fehler-Interval gesetzt wurde
                nextInterval = getInterval(datenVolumen);
            }

            if (datenVolumen !== 0) {
                logger.info(`📊 Verfügbares Datenvolumen: ${datenVolumen} GB`);
                logger.info(`⏰ Nächste Prüfung in ${nextInterval} Sekunden`);

                // Sende oder aktualisiere Telegram-Nachricht mit korrektem Interval
                if (statusMessage) {
                    statusMessage += `\n⏰ Nächste Prüfung in ${nextInterval} Sekunden.`;
                    if (forceNewMessage) {
                        lastTelegramStatusMessageId = null;
                        sendMessage(statusMessage, "info");
                    } else {
                        sendOrEditStatusMessage(statusMessage);
                    }
                }
            } else {
                logger.warn("⚠️ Datenvolumen ist 0 oder Fehler aufgetreten");
            }

            // Timeout für nächsten Lauf setzen
            mainTimeout = setTimeout(runMain, nextInterval * 1000);
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
    sendMessage("🛑 Lidl-Extender wird beendet...", "info");

    isShuttingDown = true;

    try {
        // Stoppe alle Timer
        stopTimers();

        // Schließe Browser sicher
        await closeBrowserSafely();

        // Kurze Pause für finale Logs
        await delay(2000);

        logger.info("✅ Graceful shutdown completed");
        sendMessage("✅ Lidl-Extender sicher beendet", "info");

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
