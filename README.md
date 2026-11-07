# Pianoövning

En övningsapp för piano som körs i webbläsaren, gjord för iPad på notstället.

- Fallande toner ovanför en klaviatur, med fingersättning (1 = tumme … 5 = lillfinger) för varje ton.
- **Vänta på mig**: musiken stannar tills appen har hört att du spelat rätt toner via mikrofonen.
- **Spela i takt**: musiken går vidare och träffar räknas.
- **Stäm av**: appen mäter hur ditt piano är stämt, så ett lite ostämt piano fungerar.
- Öppna valfri MIDI-fil (.mid). Den sparas bara på din egen enhet. Ingen låt följer med sidan.

Öppna sidan i Safari på iPaden, tryck **Öppna låt** och sedan **Starta mikrofonen**.

## Filer

| Fil | Innehåll |
| --- | --- |
| `index.html` | Sidan och dess utseende |
| `app.js` | Uppspelning, lärlägen, ritning |
| `midi.js` | Läser MIDI-filer och delar upp höger/vänster hand |
| `fingering.js` | Räknar ut fingersättning (dynamisk programmering, avståndsregler enligt Parncutt m.fl. 1997) |
| `detector.js` | Hör vilka tangenter som slås an, ur mikrofonljud |
