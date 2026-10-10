# Baccarat Predict

A desktop app for live online baccarat. It reads the table, tracks the shoe, predicts the next hand, and learns from every result. It never places bets.

There are two ways to connect it to the game:

- **Watch my browser (recommended).** Log in to the casino in Chrome as normal, so the login and captcha work. Open the baccarat table, then press **Watch a window** in the app and pick the Chrome window. The app becomes a narrow panel on the right of the screen, with the casino visible on the left. Keep the casino window visible, because a minimised or fully covered browser stops updating.
- **Open the link inside the app.** Paste the game link and press Start. Some casinos' logins or captchas fail inside an embedded browser. If that happens, use Watch my browser.

**Roadmap box.** Click the yellow **Roadmap** label (or **Adjust box** next to the Roadmap step) to drag the box over one road and pull its corners to resize it. The app then reads only inside the box, and shows a live preview of what it reads while you adjust. The box is saved for each site. On tables like CasinoPlus Speed Baccarat, put it over the **Big Road**, which shows the whole shoe. The Bead Plate there shows only the latest hands. On a CasinoPlus screenshot, the Big Road read exactly at every window size down to half size.

Then it works the same way:

1. The game runs as normal, and you place your own bets.
2. It finds the roadmap on the page by itself and reads every result.
3. The first time cards are on screen after a hand, it asks you once to confirm the cards it read. This teaches it that site's card style.
4. From then on it is view-only. It tracks every dealt card, works out the odds from the cards left in the shoe, predicts the next hand, and logs every result to keep learning.

> Baccarat is dealt from a shuffled shoe. The card math is exact, but the house edge remains on almost every hand.
> A "sure" pick is the model's best estimate, never a guarantee. Bet only what you can afford to lose.

## Run it

Install [Node.js](https://nodejs.org) first. Then double-click `start.bat`, or run:

```
npm install
npm start
```

## What you see

- **Setup steps.** Game link, roadmap, and cards, each with a status light.
- **Next hand.** The system compares exact shoe math, a learned model, and the roadmap pattern/history. It shows each source's position and why it votes or abstains. The overall choice requires two independent sources to agree on a positive-return side; otherwise it says “No reliable edge.” The learned model only gets a vote after at least 500 prospective live forecasts and a clear improvement over the math baseline; the roadmap only gets a vote after at least 100 settled picks at 55% accuracy. This is an experimental filter, not a guarantee or betting advice.
- **Roadmap read.** Shows the current streak and ping-pong plus the roadmap pattern hypothesis and its historical hit rate. These patterns are evidence to inspect, not proof that the next hand is predictable.
- **Statistics.** Tracks forecasts made before live hands, with win rate, recent results, and a chart. Joined mid-shoe hands, replayed/corrected hands, and ties are not scored. The system decision stays “No reliable edge” until the required data is available.
- **Shoe.** Shoe number, cards seen, and cards left. It also shows the Bead Plate, Big Road, Big Eye Boy, Small Road, and Cockroach Pig, with the Banker ask and Player ask.
- **Learning.** Shows forecast accuracy and model-vs-math comparison. The experimental model contributes to the system choice only after prospective live results show a clear improvement over the shoe-odds baseline.
- **Hand log.** Results, the model forecast made before each live hand, and any cards read. Hands already present when joining are shown without a pick. Show the last 20 hands, this shoe, or everything.

## How it works

- **Roadmap.** The app looks for a grid of same-size red and blue marks and prefers the Bead Plate. It reads new results as they appear, follows the roadmap when it scrolls, and treats an emptied roadmap as a shuffle.
- **New shoe.** After a shuffle the card count restarts. If you join mid-shoe, the count uses only the cards seen since you joined, which is still correct, and becomes complete from the next shuffle.
- **Cards.** The app finds the white card faces and reads the rank in each corner. Every hand is checked against the official drawing rules. If a reading breaks the rules, the app tries the next-closest ranks to find the legal hand that matches the roadmap winner.
- **Odds.** The app enumerates the legal next-hand draws without replacement from the tracked card-value counts and calculates Banker, Player, and Tie probabilities exactly. Before any cards are tracked it uses standard 8-deck odds. After joining mid-shoe, cards dealt before joining are unknown, so the calculation is exact for the tracked counts but the shoe composition is partial until the next shuffle.
- **Learning.** A logistic model updates after each eligible live non-tie result using card odds, the last winner, streak, ping-pong, recent side frequency, Big Road columns, and derived roads. It is experimental: roadmap patterns may have no predictive signal, and results do not promise improved accuracy or profit.

**Using it on another computer.** Cloning the repo gives the code only. To bring what the app has learned, press **Export learning data** (Settings and tools). This writes `learning-data/baccarat-learning.json` into the project folder. Commit and push it, pull on the other computer, and press **Import learning data** there. Hands are merged without duplicates, and the model that has learned from more live hands is kept.

Everything is saved in the app's data folder: the hand log, the learned model, settings, and each site's card setup.

## Settings and tools

Open **Settings and tools** at the bottom of the panel to change the strong-lean level or the reading speed. It also has buttons to find the roadmap again, draw the roadmap box by hand, redo the card setup, export the log as CSV, reset learning, and run the pattern simulation.

## Tests

| Command | What it checks |
| --- | --- |
| `npm test` | Shoe dealing and odds against the known 8-deck values |
| `npm run bench` | Card reading across fonts, sizes, and sideways cards |
| `npm run selftest` | End to end on a fake live table: joining mid-shoe, card setup, shuffle, card tracking, logging |
| `BP_SELFTEST_MODE=window npm run selftest` | The same, with the table in a separate window read through Watch my browser |

## Limits

- **Tested against a fake table.** The reading is tuned on a realistic simulated table, not yet on a real Pragmatic Play or Evolution screen. The first real session may need the card setup or the roadmap box adjusted.
- **Colours.** The roadmap reader expects red for Banker, blue for Player, and green for Tie.
- **Watched window must stay visible.** A minimised or fully covered browser stops redrawing, so the app warns you when the picture stops updating.
- **Casino terms.** Some casinos block embedded browsers or forbid helper tools. This app only reads the screen and never places bets. Check your casino's terms.

## Files

| File | Purpose |
| --- | --- |
| `main.js`, `preload.js` | Electron window, casino session, screen capture, and data storage |
| `index.html`, `style.css`, `app.js` | Interface, live loop, shoe tracking, prediction, and logging |
| `engine.js` | Dealing, drawing rules, odds from remaining cards, and derived roads |
| `vision.js` | Roadmap finding and reading, card finding and rank reading |
| `learner.js` | Online learning model and accuracy statistics |
| `selftest.js`, `test/` | Fake live table, card-reading benchmark, and end-to-end test |
