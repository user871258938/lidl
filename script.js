import createLogger from "logging";
import * as playwright from "playwright";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
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
const sleepmode = process.env.SLEEP_MODE;
const sleepTime = parseInt(process.env.SLEEP_TIME, 10);
const infoLevel = process.env.INFO_LEVEL || "info";

// URLs
const telegramApiUrl = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const loginUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect/mein-tarif/uebersicht.html";
const uebersichtUrl = "https://kundenkonto.lidl-connect.de/mein-lidl-connect/mein-tarif/uebersicht.html";

const version = "1.1.1";
const updateUrl = "https://raw.githubusercontent.com/user871258938/lidl/main/package.json";
const scriptUrl = "https://raw.githubusercontent.com/user871258938/lidl/main/script.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/139.0";
const delay = ms => new Promise(res => setTimeout(res, ms));
const cookiefile = "cookies.json";
const sessionMetaFile = "session_meta.json";

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
}

const circuitBreaker = new CircuitBreaker(MAX_CONSECUTIVE_ERRORS, 5 * 60 * 1000);

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

function checkMemoryUsage() {
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
            restartBrowser();
        }
    }
}

// Session-Metadaten verwalten (verbessert)
function saveSessionMeta() {
    try {
        const sessionMeta = {
            lastActivity: lastActivityTime,
            loginTime: Date.now(),
            userAgent: USER_AGENT,
            browserRestartTime: lastBrowserRestart,
            memoryUsage: getMemoryUsage()
        };
        fs.writeFileSync(sessionMetaFile, JSON.stringify(sessionMeta, null, 2));
    } catch (error) {
        logger.warn(`Fehler beim Speichern der Session-Metadaten: ${error.message}`);
    }
}

function loadSessionMeta() {
    try {
        if (fs.existsSync(sessionMetaFile)) {
            return JSON.parse(fs.readFileSync(sessionMetaFile, 'utf-8'));
        }
    } catch (error) {
        logger.warn(`Fehler beim Laden der Session-Metadaten: ${error.message}`);
    }
    return null;
}

function isSessionExpired() {
    const sessionMeta = loadSessionMeta();
    if (!sessionMeta) return true;

    const timeSinceLastActivity = Date.now() - sessionMeta.lastActivity;
    const timeSinceBrowserRestart = Date.now() - (sessionMeta.browserRestartTime || 0);

    return timeSinceLastActivity > SESSION_TIMEOUT ||
        timeSinceBrowserRestart > BROWSER_RESTART_INTERVAL;
}

// Verbesserte Session-Validierung mit Timeout
async function validateSession() {
    if (isShuttingDown) return false;

    try {
        if (!page || page.isClosed()) {
            logger.warn("Seite ist geschlossen, Session ungültig");
            return false;
        }

        // Timeout für die gesamte Validierung
        const validationPromise = (async () => {
            const currentUrl = page.url();
            if (currentUrl.includes('login') || currentUrl.includes('anmelden')) {
                logger.warn("Auf Login-Seite weitergeleitet, Session ungültig");
                return false;
            }

            await page.goto(uebersichtUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000
            });
            await delay(2000);

            const loginFormExists = await page.$('#__BVID__27') !== null;
            if (loginFormExists) {
                logger.warn("Login-Formular gefunden, Session ungültig");
                return false;
            }

            await page.waitForSelector(".consumption-info", { timeout: 10000 });
            logger.info("Session-Validierung erfolgreich");
            lastActivityTime = Date.now();
            saveSessionMeta();
            return true;
        })();

        return await Promise.race([
            validationPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Session validation timeout')), 30000)
            )
        ]);
    } catch (error) {
        logger.error(`Fehler bei Session-Validierung: ${error.message}`);
        return false;
    }
}

// Verbessertes Keep-Alive mit Fehlerbehandlung
async function keepSessionAlive() {
    if (!page || page.isClosed() || isShuttingDown) return;

    try {
        const keepAlivePromise = (async () => {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
            lastActivityTime = Date.now();
            saveSessionMeta();
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

        // Bereinige alte Browser-Daten bei wiederholten Fehlern
        if (consecutiveErrors >= 2) {
            logger.info("Bereinige Browser-Daten aufgrund von Fehlern...");
            try {
                if (fs.existsSync(userDataDir)) {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
                if (fs.existsSync(cookiefile)) {
                    fs.unlinkSync(cookiefile);
                }
            } catch (cleanupError) {
                logger.warn(`Bereinigung fehlgeschlagen: ${cleanupError.message}`);
            }
        }

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
            userAgent: USER_AGENT,
            storageState: fs.existsSync(cookiefile) ? cookiefile : undefined
        };

        context = await playwright[browserType].launchPersistentContext(
            userDataDir,
            browserOptions
        );

        logger.info("Browser erfolgreich gestartet");
        page = await context.newPage();

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

            await page.waitForSelector("#__BVID__27", { timeout: 15000 });
            await page.waitForSelector("#__BVID__31", { timeout: 15000 });

            // Felder leeren und ausfüllen
            await page.fill("#__BVID__27", "");
            await page.fill("#__BVID__31", "");
            await delay(1000);

            await page.fill("#__BVID__27", rufnummer);
            await page.fill("#__BVID__31", passwort);

            logger.info("Login-Daten eingegeben, sende Formular...");

            // Login-Button klicken und auf Navigation warten
            await Promise.all([
                page.click("#submit-16"),
                page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 })
            ]);

            await delay(3000);
            const currentUrl = page.url();
            if (!currentUrl.startsWith(uebersichtUrl)) {
                throw new Error(`Login fehlgeschlagen, unerwartete URL: ${currentUrl}`);
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
    if (isShuttingDown) return 0;

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

            // Session-Gültigkeit prüfen
            let sessionValid = false;

            if (fs.existsSync(cookiefile) && !isSessionExpired()) {
                logger.info("Prüfe bestehende Session...");
                sessionValid = await validateSession();
            }

            // Login falls Session ungültig
            if (!sessionValid) {
                logger.info("Session ungültig oder abgelaufen, führe Login durch...");

                // Lösche alte Session-Daten
                if (fs.existsSync(cookiefile)) {
                    fs.unlinkSync(cookiefile);
                }
                if (fs.existsSync(sessionMetaFile)) {
                    fs.unlinkSync(sessionMetaFile);
                }

                const loginSuccess = await performLogin();
                if (!loginSuccess) {
                    throw new Error("Login nach mehreren Versuchen fehlgeschlagen");
                }
            } else {
                logger.info("Bestehende Session ist gültig");
            }

            // Stelle sicher, dass wir auf der Übersichtsseite sind
            if (!page.url().startsWith(uebersichtUrl)) {
                await page.goto(uebersichtUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
                await delay(2000);
            }

            // Datenvolumen auslesen
            const usage = await page.$eval('.consumption-info', el => {
                const unitEl = el.querySelector('span.unit');
                const unit = unitEl ? unitEl.textContent.trim() : '';
                const nums = (el.textContent.match(/(\d+(?:[.,]\d+)?)/g) || []).map(n => parseFloat(n.replace(',', '.')));
                const used = nums[0] ?? NaN;
                const total = nums[1] ?? NaN;
                return { used, total, unit };
            });

            const used = usage.used;
            let total = usage.total;
            let datenVerfuegbar = (isNaN(total) || isNaN(used)) ? NaN : +(total - used).toFixed(3);

            // Refill-Daten prüfen
            let refill = null;
            try {
                refill = await page.$eval('.refill-wrapper > .consumption-info', el => {
                    const unitEl = el.querySelector('span.unit');
                    const unit = unitEl ? unitEl.textContent.trim() : '';
                    const nums = (el.textContent.match(/(\d+(?:[.,]\d+)?)/g) || []).map(n => parseFloat(n.replace(',', '.')));
                    const used = nums[0] ?? NaN;
                    const total = nums[1] ?? NaN;
                    return { used, total, unit };
                });
            } catch (e) {
                logger.warn("Refill-Block nicht gefunden");
            }

            if (refill && !isNaN(refill.used) && !isNaN(refill.total)) {
                const refillUsed = refill.used;
                const refillTotal = refill.total;
                const refillVerfuegbar = +(refillTotal - refillUsed).toFixed(3);
                datenVerfuegbar = isNaN(datenVerfuegbar)
                    ? refillVerfuegbar
                    : +(datenVerfuegbar + refillVerfuegbar).toFixed(3);
            }

            // Nachbuchung falls nötig
            let nachbuchungsErfolg = false;
            if (!isNaN(datenVerfuegbar) && datenVerfuegbar < 1) {
                try {
                    logger.info("Wenig Datenvolumen, versuche Nachbuchung...");
                    await page.click(".tariff-btn-176", { timeout: 10000 });
                    await delay(7000);
                    const successSelector = ".alert";
                    if (await page.$(successSelector)) {
                        nachbuchungsErfolg = true;
                        logger.info("Nachbuchung erfolgreich bestätigt.");
                    } else {
                        logger.warn("Kein Erfolgs-Alert gefunden");
                    }
                } catch (e) {
                    logger.error(`Fehler beim Nachbuchungsversuch: ${e.message}`);
                }
            }

            // Status-Nachrichten
            if (datenVerfuegbar < 1 && !nachbuchungsErfolg) {
                sendMessage("❌ Nachbuchung fehlgeschlagen, bitte manuell nachbuchen.", "error");
            } else if (datenVerfuegbar < 1 && nachbuchungsErfolg) {
                sendMessage(`✅ Nachbuchung erfolgreich! Verfügbares Datenvolumen: ${datenVerfuegbar + 1} GB`, "info");
                datenVerfuegbar += 1;
            }

            datenVolumen = datenVerfuegbar;
            lastActivityTime = Date.now();
            saveSessionMeta();

            return datenVolumen;
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

        return 0;
    }
}

// Update-Funktion (unverändert)
async function checkForUpdates() {
    try {
        const response = await axios.get(updateUrl);
        const latestVersion = response.data.version;
        if (latestVersion > version) {
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

// Verbesserte Nachrichtenfunktion
function sendMessage(message, level) {
    if (isShuttingDown) return;

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
    if (Datenvolumen >= 10) {
        return getRandomInteger(3600, 5400);
    } else if (Datenvolumen >= 5) {
        return getRandomInteger(900, 1800);
    } else if (Datenvolumen >= 3) {
        return getRandomInteger(600, 900);
    } else if (Datenvolumen >= 2) {
        return getRandomInteger(300, 450);
    } else if (Datenvolumen >= 1.2) {
        return getRandomInteger(150, 240);
    } else if (Datenvolumen >= 1.0) {
        return getRandomInteger(60, 90);
    } else {
        return 60;
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
}

// Verbesserte Hauptschleife mit besserer Fehlerbehandlung
function start() {
    logger.info("🚀 Starting lidl-extender script v" + version);

    // Starte alle Timer
    startTimers();

    let mainTimeout = null;

    const runMain = async () => {
        if (isShuttingDown) return;

        let datenVolumen = 0;
        let nextInterval = 300; // Default 5 Minuten

        try {
            // Update-Check
            if (autoUpdate) {
                await checkForUpdates();
            }

            // Hauptfunktion ausführen
            datenVolumen = await main();

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
                sendMessage(`📊 ${datenVolumen} GB verfügbar. Nächste Prüfung in ${nextInterval} Sekunden.`, "info");
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
    start();
} catch (error) {
    logger.error(`Fehler beim Starten: ${error.message}`);
    sendMessage(`🚨 Fehler beim Starten: ${error.message}`, "error");
    process.exit(1);
}
