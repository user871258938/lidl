# Lidl Connect Extender

Diese Version erweitert die bestehende Lidl-Connect-Implementierung um eine frühere und zuverlässigere Nachbuchung, adaptive Prüfintervalle und eine robustere Verarbeitung der Daten aus dem Lidl-Dashboard.

Der Schwerpunkt liegt auf Problemen und Verbesserungsmöglichkeiten, die bei der praktischen Nutzung aufgefallen sind.

## 🔧 Wichtigste Änderungen

### 🔄 Verbesserte Nachbuchungslogik

Die Nachbuchung wurde von der bisherigen **1-GB-Grenze** auf eine **80-%-Verbrauchsschwelle** umgestellt.

Statt erst zu reagieren, wenn weniger als 1 GB verfügbar sind, wird jetzt bei 80 % Verbrauch nachgebucht. Dadurch bleiben im Normalbetrieb etwa **20 % des ursprünglichen Tarifvolumens als Datenpuffer** erhalten.

Der Fortschritt bis zur 80-%-Schwelle wird zusätzlich angezeigt, sodass jederzeit erkennbar ist, wie weit der Verbrauch fortgeschritten ist.

### 📊 Adaptive Prüfintervalle

Die Prüfintervalle werden dynamisch anhand des verfügbaren Datenvolumens, des aktuellen Verbrauchs und der konfigurierten Internetgeschwindigkeit berechnet.

Die Internetgeschwindigkeit wird über `.env` konfiguriert:

```env
INTERNET_SPEED_MBPS=500
```

`500` entspricht **500 Mbps** und dient als Standardwert.

Mit zunehmendem Verbrauch werden die Prüfungen automatisch häufiger. Kurz vor Erreichen der 80-%-Schwelle kann das Intervall bis auf **30 Sekunden** reduziert werden, damit die Nachbuchung zeitnah erkannt und ausgelöst werden kann.

Zusätzlich wird auf jedes berechnete Prüfintervall ein **Jitter von 0–50 %** angewendet. Die tatsächliche Wartezeit liegt dadurch zufällig zwischen dem berechneten Intervall und bis zu 50 % darüber. Ein berechnetes Intervall von 30 Sekunden führt beispielsweise zu einer zufälligen Wartezeit von 30 bis 45 Sekunden.

Dadurch entstehen keine starren, exakt wiederkehrenden Prüfzeitpunkte, während die berechnete Mindestwartezeit erhalten bleibt.

### 🔔 Benachrichtigungen

Status- und Erfolgsmeldungen wurden erweitert und zeigen den aktuellen Verbrauch sowie den Fortschritt bis zur Nachbuchung direkt an.

Beispiel:

```text
📡 Lidl-Extender

⏳ WAITING FOR 80%

used 18.2/26.0 GB (70%)
[██████████████████░░]
88% of 80% used · to 80%: 2.6 GB
```

Bei erreichter Schwelle:

```text
📡 Lidl-Extender

🔄 RECHARGING NOW

used 20.8/26.0 GB (80%)
[████████████████████]
100% of 80% used
```

### 🔎 Verbesserte Datenerkennung

Die Auswertung der Verbrauchs- und Refill-Daten wurde von einzelnen festen HTML-Elementen entkoppelt.

Das Skript erkennt nun mehrere mögliche Strukturen des Lidl-Dashboards, darunter sowohl die bisherigen Datenfelder als auch neuere Elemente wie `progress-DATA-*` und `progress-REFILL`. Falls sich die Positionen oder IDs der Elemente ändern, steht zusätzlich eine positionsbasierte Erkennung innerhalb der Verbrauchsanzeige zur Verfügung.

Dadurch können Änderungen an der Darstellung des Lidl-Dashboards verarbeitet werden, ohne dass die Datenauswertung vollständig von einem bestimmten Selector abhängt.

### 🐛 Fehlerbehebungen und Stabilitätsverbesserungen

Unter anderem wurden folgende Punkte angepasst:

* zuverlässigere Verarbeitung des Refill-Volumens
* korrigierte Verarbeitung der Datenwerte nach einer Nachbuchung
* funktionierender Cool-down nach fehlgeschlagenen Nachbuchungsversuchen
* zuverlässigeres Login- und Navigationsverhalten
* bessere Verarbeitung veränderter Dashboard-Strukturen
* zusätzliche Fehler- und Randfallbehandlung

## 🎯 Ziel

Ziel der Änderungen ist es, die bestehende Implementierung stärker an den tatsächlichen Laufzeitdaten auszurichten und die Abhängigkeit von festen Zeitintervallen und einzelnen DOM-Strukturen zu reduzieren.

Die Änderungen können vollständig übernommen oder je nach Bedarf auch einzeln betrachtet und übernommen werden.

## Version

**1.2.5**
