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

## Tonigenkänning i korthet

- Nya toner: det nya ljudet (jämfört med de senaste 90–180 ms) letas igenom en ton i taget; en ton godkänns bara om den
  blivit tydligt starkare i grundtonen och i de flesta av sina deltoner samtidigt (en svävning i ett ostämt piano rör
  deltonerna i otakt och räknas inte).
- Omslag av en ton som redan klingar: ett kort fönster hör själva anslaget (bredbandig "smäll"), och tonens deltoner
  jämförs före och efter. Övertoner, grannhalvtoner och appens eget ackompanjemang räknas bort.
- `dev/test_wait.js` simulerar vänta-läget mot ett syntetiskt piano och mäter hur ofta händelser godkänns utan spel,
  fastnar eller godkänns på fel ton: `MIDI=låt.mid HAND=L node dev/test_wait.js`.
