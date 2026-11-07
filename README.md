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
- Omslag av en ton som redan klingar: ett kort fönster hör själva anslaget (bredbandig "smäll"), tonens deltoner
  jämförs före och efter, och de måste ha ändrats plötsligt (ett "ryck" på 43 ms) – svävning och utklingning är
  långsamma. Varje smäll bedöms för sig, så appens eget anslag strax före spelarens hindrar inte bedömningen.
  Övertoner, grannhalvtoner och appens eget ljud (vars deltoner är kända) räknas bort.
- Stämning: appen lär sig varje tangents avvikelse medan man spelar och låter hela stämningen följa medianen.
  Väntade tangenter som inte lärts in ännu söks med bredare band (±75 cent). Det inlärda sparas på enheten.
- Tid: en ton som spelats upp till 0,6 s innan musiken nått den räknas ändå, och när en händelse klaras hoppar
  musiken fram lika mycket som igenkänningen fördröjde – den som spelar i takt hamnar inte "för tidigt".
- `dev/test_wait.js` simulerar vänta-läget mot ett syntetiskt piano (ostämt, svävande, med appens synt som
  ackompanjemang) och mäter händelser som godkänns utan spel, som kräver ett andra anslag, som fastnar och som godkänns
  på fel ton: `MIDI=låt.mid HAND=L node dev/test_wait.js`. Varianter: `EARLY=0.3` (spelaren ligger 0,3 s före appen),
  `KEYDEV=20 GLOBAL=-40 TUNE=0` (ostämt piano utan "Stäm av"), `BEAT=8` (svävning), `WRONG=1` (fel ton först),
  `ACC_GAIN=2.5` (högt ackompanjemang), `DEBUG=4|5` (spårning av kandidater respektive omslagsbedömningar).
