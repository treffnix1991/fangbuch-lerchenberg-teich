# Fangbuch Lerchenberg-Teich.de – GitHub Pages + Supabase (kostenlos)

Die Seite besteht aus statischen Dateien (GitHub Pages). Login, Datenbank, Regeln und Festschreibung der Fänge
laufen bei Supabase (Free-Tarif). Der frühere Python-Server (`server.py`) wird nicht mehr gebraucht.

## Was sich gegenüber der alten Version ändert
- Alle Regeln (Pflichtfelder, Maße, Zukunftsdatum, Festschreibung) werden weiterhin **serverseitig** geprüft – jetzt in der Datenbank (`supabase/schema.sql`). Fänge lassen sich nicht ändern oder löschen (Datenbank-Trigger).
- Anmeldung, E-Mail-Bestätigung, „Passwort vergessen“: übernimmt Supabase Auth. Die Mails kommen über einen SMTP-Dienst deiner Wahl (Schritt 4).
- Der erste registrierte Benutzer wird weiterhin automatisch Admin.
- **Neu: Freischaltung durch einen Admin.** Neue Profile müssen (1) die E-Mail-Adresse bestätigen und (2) von einem Admin freigeschaltet werden. Bis dahin sehen sie nach der Anmeldung nur „Freischaltung ausstehend“ und können weder Fänge sehen noch eintragen. Das wird in der Datenbank erzwungen, nicht nur in der Oberfläche. Admins sehen offene Neuanmeldungen oben im Menü („Admin (2 neu)“) und unter *Admin → Mitglieder* (Button „Freischalten“; dort können Mitglieder auch wieder gesperrt werden). Eine automatische Mail an die Admins bei Neuanmeldungen gibt es nicht.
- **Notfallzugang** (statt `python3 server.py recover-admin`): steht in der Datei `NOTFALL-Adminzugang.md`, die nur lokal liegt und nicht ins Repository gehört.
- Die Sitzung liegt jetzt im Browser-Speicher statt in einem HttpOnly-Cookie (Standard bei Supabase). Die Seite setzt nie Nutzerdaten per innerHTML ein und hat eine Content-Security-Policy.
- Bereits vorhandene Daten aus der alten SQLite-Datei werden **nicht** automatisch übernommen. Falls schon echte Fänge existieren, sag Bescheid, dann schreibe ich ein Übernahme-Skript.

## Einrichtung (ca. 30–45 Minuten)

### 1. Supabase-Projekt anlegen
1. https://supabase.com → kostenlos registrieren → *New project*. Region: **Frankfurt (eu-central-1)**. Datenbank-Passwort sicher aufbewahren.
2. *SQL Editor* → *New query* → den kompletten Inhalt von `supabase/schema.sql` einfügen → *Run*. Es darf keine Fehlermeldung kommen.
3. *Project Settings → API*: **Project URL** und den **anon public**-Schlüssel kopieren und in `config.js` eintragen. (Der anon-Schlüssel ist öffentlich gedacht; der Schutz läuft über die Datenbankregeln. Den *service_role*-Schlüssel nie verwenden oder hochladen.)

### 2. Anmelde-Einstellungen
*Authentication → Sign In / Providers → Email*: **Confirm email** muss an sein. Mindestlänge des Passworts auf 8 stellen.
*Authentication → URL Configuration*: **Site URL** = `https://lerchenberg-teich.de`, unter *Redirect URLs* dieselbe Adresse (mit `/`) hinzufügen.

### 3. E-Mail-Vorlagen (wichtig, sonst funktionieren die Links nicht)
*Authentication → Emails → Templates*. In den beiden Vorlagen den Link so ersetzen:

**Confirm signup** – Betreff: `Lerchenberg-Teich.de: Bitte E-Mail-Adresse bestätigen`
```html
<p>Hallo,</p>
<p>bitte bestätige deine E-Mail-Adresse für die Fangstatistik Lerchenberg-Teich.de, indem du diesen Link öffnest:</p>
<p><a href="{{ .SiteURL }}/#/bestaetigen/{{ .TokenHash }}">E-Mail-Adresse bestätigen</a></p>
<p>Wenn du dich nicht registriert hast, kannst du diese Nachricht ignorieren.</p>
```
**Reset password** – Betreff: `Lerchenberg-Teich.de: Passwort zurücksetzen`
```html
<p>Hallo,</p>
<p>für dein Profil wurde ein neues Passwort angefordert. Mit diesem Link kannst du eins festlegen:</p>
<p><a href="{{ .SiteURL }}/#/passwort-zuruecksetzen/{{ .TokenHash }}">Neues Passwort festlegen</a></p>
<p>Wenn du das nicht angefordert hast, ignoriere diese Nachricht – dein Passwort bleibt unverändert.</p>
```
(Die Links funktionieren dadurch auch, wenn die Mail auf einem anderen Gerät geöffnet wird.)

### 4. Mailversand (kostenlos)
Der eingebaute Supabase-Mailversand liefert nur an Teammitglieder und sehr wenige Mails pro Stunde – für Mitglieder reicht er nicht.
Richte unter *Authentication → Emails → SMTP Settings* einen eigenen SMTP-Zugang ein, z. B. mit dem Gratis-Tarif von **Brevo** (Konto anlegen, Absender/Domain `lerchenberg-teich.de` bestätigen, SMTP-Zugangsdaten eintragen) oder dem Postfach deines Domain-Providers. Absender z. B. `noreply@lerchenberg-teich.de`. Für gute Zustellung SPF/DKIM beim Mailanbieter einrichten. Die genauen Limits der Gratis-Tarife vorher prüfen.

### 5. GitHub-Repository
1. https://github.com → *New repository* (z. B. `lerchenberg-teich`, public oder private).
2. Den **Inhalt** dieses Ordners hochladen (*Add file → Upload files*; die Ordner `fish` und `supabase` sowie die Dateien `CNAME` und `.nojekyll` nicht vergessen).
3. *Settings → Pages*: *Deploy from a branch* → Branch `main`, Ordner `/ (root)` → Speichern.
4. *Settings → Pages → Custom domain*: `lerchenberg-teich.de`, danach **Enforce HTTPS** anhaken (sobald verfügbar).
5. Für das Wachhalten: *Settings → Secrets and variables → Actions* → zwei Secrets `SUPABASE_URL` und `SUPABASE_ANON_KEY` anlegen (gleiche Werte wie in `config.js`).
6. Der Wachhalte-Workflow liegt bereits unter `.github/workflows/keepalive.yml`. Unter dem Tab *Actions* kann man ihn mit *Run workflow* einmal testen.

### 6. Domain (DNS beim Domain-Anbieter)
- `A`-Einträge für `lerchenberg-teich.de` auf `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- `CNAME` für `www` auf `DEIN-GITHUB-NAME.github.io`
- Alte Einträge, die auf den früheren Server zeigen, entfernen. Die Umstellung kann bis zu einigen Stunden dauern. (IP-Adressen bitte in der GitHub-Doku nochmals prüfen.)

### 7. Erster Test
1. https://lerchenberg-teich.de öffnen → *Neues Profil erstellen* → Mail bestätigen → anmelden. Dieses erste Profil ist Admin und automatisch freigeschaltet.
2. Mit einem zweiten Test-Profil prüfen, dass „Freischaltung ausstehend“ erscheint, und es dann als Admin unter *Admin → Mitglieder* freischalten.
3. Admin → Schonmaße: Mindestmaße mit der Gewässerordnung abgleichen (Voreinstellung: RLP, Stand Recherche 19.11.2026, nicht amtlich geprüft).
4. Einen Test-Fang eintragen. **Achtung: Fänge lassen sich nicht löschen.** Zum Testen daher ein Test-Profil verwenden und vor dem Echtbetrieb die Testfänge löschen (Befehl in der lokalen Datei `NOTFALL-Adminzugang.md`).

## Betrieb
- **Pausierung:** Kostenlose Supabase-Projekte werden nach längerer Inaktivität pausiert. Der Workflow `.github/workflows/keepalive.yml` pingt zweimal pro Woche. GitHub schaltet geplante Workflows ab, wenn das Repository 60 Tage keine Aktivität hat – dann im Tab *Actions* wieder aktivieren. Pausierte Projekte lassen sich im Dashboard mit einem Klick fortsetzen.
- **Datensicherung:** Der Free-Tarif bietet keine herunterladbaren Backups. Regelmäßig im Dashboard unter *Table Editor → catches → Export CSV* sichern (und `profiles`).
- **Fischart ergänzen:** Bild nach `fish/<name>.jpg` legen und im SQL-Editor einen Eintrag in `public.species` einfügen (Vorlage: letzter Block in `schema.sql`).
- **Admin setzt Passwort:** funktioniert über eine Datenbankfunktion; alternativ „Passwort vergessen“ nutzen.
