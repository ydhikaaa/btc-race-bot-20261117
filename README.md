# btc-race-bot-20261117

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ydhikaaa/btc-race-bot-20261117/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ydhikaaa/btc-race-bot-20261117/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

DipSnap — a mean-reversion trading bot for Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars. It buys only a real dip (the close at least 45 bps below its 60-minute average) and sells on a real recovery (+100 bps from its fill) or a hard stop (-150 bps). Long only, no leverage, fully deterministic integer arithmetic, no clock, no network. Dev-window grade (local, kit harness): net PnL +13.20 USDC on $1,000, 5 trades, max drawdown 1.32%.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (NDJSON on stdin/stdout). To grade it on the dev window with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z3g1zh14&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
