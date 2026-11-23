# Pianoövning

En övningsapp för piano som körs i webbläsaren, gjord för iPad på notstället.

- Fallande toner ovanför en klaviatur, med fingersättning (1 = tumme … 5 = lillfinger) för varje ton.
- **Vänta på mig**: musiken stannar tills appen har hört att du spelat rätt toner via mikrofonen.
- **Spela i takt**: musiken går vidare och träffar räknas.
- **Stäm av**: appen mäter hur ditt piano är stämt, så ett lite ostämt piano fungerar.
- Öppna valfri MIDI-fil (.mid). Den sparas bara på din egen enhet. Ingen låt följer med sidan.
- **USB-klaviatur** (Chrome/Edge på dator, Web MIDI): tangenttrycken läses direkt från ett digitalpiano, utan mikrofon.
  Har klaviaturen tangenter som lyser (Casio LK-serien) tänds den tangent som ska spelas på själva klaviaturen.
- **Säg finger**: en röst säger vilket finger (och vilken hand, när båda övas) när musiken väntar på dig.
- **Pianots röst**: med en Casio LK säger pianot självt fingret, med rösten från sina inbyggda lektioner.

Öppna sidan i Safari på iPaden, tryck **Öppna låt** och sedan **Starta mikrofonen**.

### Tangentljus på Casio LK

En Casio LK tänder tangenten för varje ton den får på sin lektionskanal (kanal 4). Appen skickar tonerna dit med
anslagsstyrka 1 och kanalens uttryck (CC 11) på 0: tangenten lyser men pianot låter inte. När sidan lämnas släcks allt
och uttrycket sätts tillbaka till 127. Portar som inte är klaviaturer (Windows inbyggda synt, loopMIDI och liknande)
hoppas över. Datorns röst är tyst när mikrofonen lyssnar, eftersom den annars skulle kunna tas för en ton.

### Pianots egen röst

Rösten som räknar fingrarna i Casios inbyggda lektioner ("one" … "five") ligger som fem ljud i pianots trumset:
tangent 92–96 på MIDI-kanal 10, program 0. Appen skickar dem dit, så att pianot självt säger fingret. Det står inte i
Casios dokument; det är hittat på en LK-280 genom att lyssna igenom pianots ljud. Pianots display kan däremot inte
fås att visa fingrarna för egna låtar – fingrarna visas på skärmen i appen.

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
  deltonerna i otakt och räknas inte). Deltoner där appens eget ljud ligger just då räknas inte, och en tangent som
  klingat nyss räknas som ny ton bara om något anslagsliknande hörts den senaste halvsekunden.
- Omslag av en ton som redan klingar: ett kort fönster hör själva anslaget (bredbandig "smäll"). Varje smäll bedöms
  för sig. Beviset är en *ny svängning* i tonens deltoner, mätt med fas: varje delton i en kort ruta (43 ms) förutsägs
  ur de två rutorna före, och felet mot det som hördes mäts mot deltonens styrka. Det syns även när den nya
  svängningen råkar komma i motfas och ljudstyrkan inte ändras – det som gjorde styrkejämförelser opålitliga.
  Svävning och utklingning förutsägs nästan exakt och ger inget utslag.
- Appens eget ljud: synten har bara deltonerna 1, 2, 3 och 5 (triangelvåg plus en sinus på dubbla frekvensen) och ingen
  kompressor, så det går att räkna bort delton för delton. Börjar appen en egen ton i samma ögonblick som smällen krävs
  både en skarp smäll (ett pianoanslag, inte syntens mjuka ansats) och ett starkare utslag.
- Fel tangent: en granntangent vars grundton knappt hördes före smällen men hörs tydligt efteråt har slagits an i
  stället; klingar en fel tangent måste den väntade tonen ha ändrats mer än den.
- Ackord: oktaver av toner som hörts krävs inte (de går inte att höra isär säkert); därutöver får en ton saknas i
  ackord med minst tre toner, två med minst fem.
- Stämning: appen lär sig varje tangents avvikelse medan man spelar (två mätningar innan det sparas, misstänkta
  mätningar flyttar inget) och låter hela stämningen följa medianen. Väntade tangenter som inte lärts in ännu söks med
  bredare band (±75 cent).
- Tid: en ton som spelats upp till 0,6 s innan musiken nått den räknas ändå, och när en händelse klaras hoppar
  musiken fram lika mycket som igenkänningen fördröjde – den som spelar i takt hamnar inte "för tidigt".
- `dev/test_wait.js` simulerar vänta-läget mot ett syntetiskt piano (ostämt, svävande, med appens synt som
  ackompanjemang) och mäter händelser som godkänns utan spel, som kräver ett andra anslag, som fastnar och som godkänns
  på fel ton: `MIDI=låt.mid HAND=L node dev/test_wait.js` (`HAND=R|L|B`). Varianter: `EARLY=0.3` (spelaren ligger 0,3 s
  före appen), `KEYDEV=20 GLOBAL=-40 TUNE=0` (ostämt piano utan "Stäm av"), `BEAT=8` (svävning), `WRONG=1` (fel ton
  först), `ACC_GAIN=2.5` (högt ackompanjemang), `START=40 NEV=40` (annan del av låten). Spårning: `DEBUG=4` kandidater,
  `5` omslagsbedömningar, `6` en rad per bedömning med facit (för att sätta trösklar ur data), `7` allt som rapporteras.
