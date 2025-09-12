# Lidl Connect Datenverbrauchs-Benachrichtigung 📱

Ein Skript, das sich automatisch in dein **Lidl-Connect-Konto** einloggt, deinen Datenverbrauch abruft und Benachrichtigungen über **Telegram** und/oder **Discord** sendet.  
So gehst du nie wieder unerwartet ohne Datenvolumen aus!  
Dieses Projekt löst das Problem, den Datenverbrauch manuell überprüfen zu müssen, indem es den gesamten Prozess automatisiert und dich proaktiv über dein verbleibendes Datenvolumen informiert.

---

## 🚀 Funktionen

- **Automatische Anmeldung:** Meldet sich mit Playwright bei deinem Lidl-Connect-Konto an.
- **Datenabruf:** Liest das verbleibende Datenvolumen und die Gültigkeitsdauer aus.
- **Benachrichtigungssystem:** Sendet personalisierte Benachrichtigungen über Telegram und/oder Discord.
- **Automatische Updates:** Prüft optional auf Updates und aktualisiert sich von GitHub.
- **Konfigurierbar:** Verwendung von `.env`-Dateien zur einfachen Einstellung von Zugangsdaten, Benachrichtigungen und Update-Optionen.
- **Periodische Überprüfung:** Führt in festgelegten Intervallen Prüfungen durch.
- **Fehlerbehandlung:** Robuste Erkennung und Protokollierung von Fehlern.

---

## 🛠️ Technischer Stack

- **Browser-Automatisierung:** `playwright`
- **HTTP-Anfragen:** `axios`
- **Umgebungsvariablen:** `dotenv`
- **Dateisystem-Operationen:** `fs`
- **Prozessverwaltung:** `child_process`
- **Protokollierung:** `logging`
- **JavaScript:** Kernsprache
- **Node.js:** Laufzeitumgebung

---

## 📦 Installation

### Voraussetzungen

- **Node.js** (Version 16 oder höher)
- **npm** (wird mit Node installiert)
- Ein **Lidl-Connect-Konto**
- (Optional) Ein **Telegram-Bot** und/oder ein **Discord-Webhook**

---

### Installation

1. Repository klonen:

    ```bash
    git clone https://github.com/user871258938/lidl
    cd lidl
    ```

2. Abhängigkeiten installieren:

    ```bash
    npm install
    ```

3. Playwright installieren:

    ```bash
    npx playwright install
    ```

4. Beispiel-Umgebungsdatei kopieren:

    ```bash
    cp .env.example .env
    ```

5. `.env` bearbeiten und deine Zugangsdaten eintragen:

---

## 💻 Nutzung

Skript starten:

```bash
node script.js
```
Das Skript meldet sich automatisch bei deinem Lidl-Connect-Konto an, ruft die aktuellen Verbrauchsdaten ab und sendet Benachrichtigungen entsprechend deiner Konfiguration.
Es pausiert danach für die eingestellte Zeit und wiederholt den Vorgang.

Für eine längere Nutzung empfiehlt sich ein Tool wie nohup oder Docker

```bash
nohup node script.js &
```

```bash
docker build -t lidl-extender . && docker run -d --name lidl-extender --hostname lidl-extender --restart unless-stopped lidl-extender
```

---

📂 Projektstruktur

├── .env.example          # Beispiel für die Umgebungsvariablen
├── .env                  # Persönliche Zugangsdaten (nicht hochladen!)
├── script.js             # Hauptskript
├── package.json          # Abhängigkeiten und Metadaten
├── package-lock.json     # Abhängigkeitsversionen
└── README.md             # Projektdokumentation


---

🤝 Mitwirken

Beiträge sind willkommen!
Pull-Requests mit Bugfixes, neuen Funktionen oder Verbesserungen der Dokumentation sind gern gesehen.

---

📝 Lizenz

Dieses Projekt steht unter der GNU General Public License v3.0.
Details siehe [License](LICENSE).

---

💖 Dankesnachricht

Danke, dass du dir dieses Projekt angesehen hast!
Ich hoffe, es hilft dir, deinen Datenverbrauch immer im Blick zu behalten.

Das README wurde mit [readme.ai](https://readme-generator-phi.vercel.app/) erstellt und mit ChatGPT übersetzt.
Vielen Dank auch an @Downwind_Lee von Telegram, für eine verbesserte Version des Scripts.
