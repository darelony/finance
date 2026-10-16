# Finansije

Lokalna aplikacija za vođenje mesečnih finansija. Radi bez interneta, bez naloga
i bez ijedne instalirane biblioteke — svi podaci ostaju na ovom računaru.

## Pokretanje

Dupli klik na **Finansije** ikonicu na desktopu.

Prečica pokreće `pokreni.vbs`, koji bez konzole startuje lokalni server i otvori
aplikaciju u sopstvenom prozoru (Chrome u „app“ režimu — bez tabova i adresne
linije). Ako aplikacija već radi, ikonica samo otvori novi prozor.

Kad se prozor zatvori, server se sam ugasi posle ~90 sekundi, pa ništa ne visi
u memoriji.

## Šifra

Pri svakom pokretanju aplikacija traži šifru — **0106**. Bez nje se ne vidi
ništa: server ne izdaje nijedan podatak dok se šifra ne unese, pa ni „Izvezi
u JSON“ ni direktan poziv API-ja ne prolaze.

Prijava važi samo dok je prozor otvoren. Kad se prozor zatvori, sledeće
pokretanje ponovo traži šifru.

Šifra se menja u `server.js`, u liniji `const PIN = '0106';`.

## Šta gde stoji

```
Finansije\
  server.js                lokalni server + SQLite (nema zavisnosti)
  pokreni.vbs              pokretač koji koristi prečica sa desktopa
  Finansije-konzola.cmd     isto, ali sa vidljivom konzolom — za proveru grešaka
  icon.ico                 ikonica prečice
  data\
    finansije.db           >>> SVI PODACI SU OVDE <<<
  public\                  izgled aplikacije (HTML/CSS/JS)
  tools\make-icon.js       generator ikonice
```

## Kako se koristi

**Dodaj mesec.** U nav baru gore klikni „Dodaj mesec“, izaberi mesec i godinu.
Dobijaš svoj dashboard za taj mesec, a mesec ostaje kao dugme u nav baru.

**Unosi.** Na dashboardu klikni „Novi unos“ (ili `Ctrl+N`) i izaberi tip:

| Tip | Značenje |
|---|---|
| **Primio** | novac koji je ušao (plata, honorar…) |
| **Potrošio** | novac koji je otišao — uz kategoriju na šta |
| **U štek** | ostavljeno na stranu (ušteđevina, investicije) |

Kategorija se bira iz predloga ili se upiše svoja; nove kategorije se pamte i
sledeći put su u predlozima. Datum je ograničen na taj mesec.

**Šta pokazuje dashboard.**

- četiri broja gore: primljeno, potrošeno, u šteku i **slobodno**
  (primljeno − potrošeno − štek)
- prstenasti graf „Na šta je otišlo“ — struktura troškova po kategorijama
- „Koliko ti ostaje kroz mesec“ — stanje dan po dan, sa nultom linijom
  kad mesec ode u minus
- „Dnevna potrošnja“ — kolona po danu
- tabela svih unosa, sa filterom po tipu i pretragom; svaki unos se može
  izmeniti ili obrisati

**Pregled** (prvo dugme u nav baru) sabira sve mesece: ukupni brojevi, poređenje
mesec-po-mesec i tabela sa stopom štednje po mesecu.

**Podešavanja** (zubčanik gore desno) menjaju valutu i izvoze sve u JSON.
Dugme pored menja svetlu/tamnu temu.

## Rezervna kopija

Cela baza je jedan fajl. Kopiraj `data\finansije.db` gde želiš — to je ceo bekap.
Vraćanje je vraćanje tog fajla na isto mesto (aplikacija ne sme da radi u tom
trenutku).

Dodatno, „Izvezi sve u JSON“ u podešavanjima pravi čitljiv snimak svih meseci
i unosa.

## Tehnički detalji

- **Node.js 22+** je jedini uslov. Baza ide preko ugrađenog modula `node:sqlite`,
  pa nema `npm install` i nema `node_modules`.
- Server sluša samo na `127.0.0.1:4318` i odbija svaki zahtev koji ne dolazi sa
  ovog računara. Ništa ne izlazi na mrežu.
- Grafovi su ručno napisan SVG (`public/charts.js`) — bez CDN-a, pa rade i bez
  interneta.
- Port se menja preko `FIN_PORT` promenljive okruženja.

Ako nešto ne radi, pokreni `Finansije-konzola.cmd` — greška će se ispisati
u konzoli.
