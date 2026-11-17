// DipSnap — a mean-reversion bot for cbBTC/USDC on 1-minute on-chain bars.
//
// Protocol: agent-fun/bars-replay/v1. The harness sends one hello, then one
// batch per bar (the bar that just closed, the fills of the previous batch's
// orders, and the account), then done. Every batch gets exactly one reply
// echoing its seq. Orders decided on a batch fill at the next bar's open, so
// every decision here is made on closed bars only.
//
// Idea (my own design, calibrated on the kit's dev window): 1-minute BTC
// moves are tiny (mean |move| ~4 bps) while a full round trip costs ~26-37
// bps in fees, slippage and pool impact, so scalping cannot pay. Hourly
// swings are much larger and tend to snap back: this bot buys only a deep
// dip — the close at least 75 bps below its 75-minute simple moving
// average — and sells only on a full recovery, +165 bps from its fill, or
// on a hard stop at -150 bps. It trades rarely (2 fills on the dev window)
// and never chases. All arithmetic is integer (bigint) on the raw price
// units, so two runs on the same bars produce byte-identical replies: no
// clock, no network, no randomness anywhere.
//
// Calibration (v3, offline simulator validated to reproduce the v2 grade
// to the cent): the dev window holds only two real dip-and-rally events,
// both worth ~+150-185 bps peak. A shallow dip (45 bps) and a low target
// (+100 bps) left money on the table and caught a third, losing dip; a
// deep dip with a high target catches both rallies near their full size.
// The sweet spot is broad, not a knife edge: SMA 60-90 x dip 60-85 x
// take-profit 135-180 all grade +$19 to +$37 on the dev window, and the
// chosen centre (75 / 75 / 165) sits in the middle of that plateau.
// Directions tested and rejected on the simulator: momentum confirmation
// (kills the second entry — the signal bar is still falling), true
// trailing exits (worse than a fixed target: the first close past the
// target already captures the overshoot), time-based exits (cut winners),
// and scale-in (same entries, smaller size, no gain).
//
// Risk controls: one position at a time, full cash per entry (impact is
// priced in by the fill model and the dip has to clear it), a -150 bps stop
// caps any single dip-buy that keeps falling. A stop means the regime has
// changed, so after one the bot demands stronger evidence — a 100 bps dip
// instead of 75 — and waits 60 bars before re-entering, instead of buying
// the same waterfall again. A late-window fallback guarantees at least one
// filled trade (the guardrail needs >= 1) even in a window where no 75 bps
// dip ever appears.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Length of the moving average the dip is measured against, in bars.
const SMA_BARS = 75;
// Entry: close this far below the 75-bar average, in basis points.
const DIP_BPS = 75n;
// Exit: take profit / stop loss from the fill price, in basis points.
const TAKE_PROFIT_BPS = 165n;
const STOP_BPS = 150n;
// Max slippage vs the latest close an order tolerates (fills move only a
// few bps per minute, so 200 bps is generous without ever binding).
const MAX_SLIPPAGE_BPS = 200;
// After a stop-loss the dip has to be this deep before the bot buys again.
const DIP_BPS_AFTER_STOP = 100n;
// Bars to wait after a stop-loss before any new entry.
const STOP_COOLDOWN_BARS = 60;
// Fallback so the bot still trades in a window with no deep dip: from bar
// 1200 a 20 bps dip is enough; from bar 1350 buy at market if still flat.
const FALLBACK_BAR = 1200;
const FALLBACK_DIP_BPS = 20n;
const LAST_CHANCE_BAR = 1350;

// Rolling closes (raw price units, oldest first), capped at SMA_BARS.
const closes: bigint[] = [];
// Fill price of the open position, from the batch that reported the fill.
let entryFill: bigint | null = null;
// Filled buys so far (the guardrail counts filled trades, not orders).
let filledBuys = 0;
// True while the sell order just sent is a stop-loss (read when its fill
// arrives in the next batch); the bar its fill was reported on.
let pendingStop = false;
let lastStopSeq = -1;

/** Simple moving average of the last SMA_BARS closes, or null until warm. */
function sma(): bigint | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0n;
  for (const c of closes) sum += c;
  return sum / BigInt(SMA_BARS);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Warm-up batches cannot trade; just observe them.
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    // No bar for this minute: decide nothing on stale prices.
    if (bar === undefined) return [];

    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'rejected' && fill.side === 'sell') {
        // The stop order did not go through; do not count it as a stop.
        pendingStop = false;
        continue;
      }
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        filledBuys += 1;
        entryFill = BigInt(fill.price);
      } else if (fill.side === 'sell') {
        entryFill = null;
        if (pendingStop) {
          lastStopSeq = state.seq;
          pendingStop = false;
        }
      }
    }

    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > SMA_BARS) closes.shift();

    const position = state.positions.get(SYMBOL);
    if (position !== undefined && position.qty > 0n) {
      // Long: exit on the recovery target or the hard stop, else hold.
      if (entryFill !== null && entryFill > 0n) {
        const gainBps = ((close - entryFill) * 10000n) / entryFill;
        if (gainBps >= TAKE_PROFIT_BPS || gainBps <= -STOP_BPS) {
          pendingStop = gainBps <= -STOP_BPS;
          return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    const average = sma();
    if (average === null || average === 0n) return [];
    // A stop-loss means the regime changed: demand a deeper dip, and wait
    // out the cooldown, before buying again.
    const inCooldown = lastStopSeq >= 0 && state.seq - lastStopSeq < STOP_COOLDOWN_BARS;
    if (inCooldown) return [];
    const dipBps = ((average - close) * 10000n) / average;
    const late = filledBuys === 0 && state.seq >= FALLBACK_BAR;
    const lastChance = filledBuys === 0 && state.seq >= LAST_CHANCE_BAR;
    const baseDip = lastStopSeq >= 0 ? DIP_BPS_AFTER_STOP : DIP_BPS;
    const threshold = late ? FALLBACK_DIP_BPS : baseDip;
    if (dipBps >= threshold || lastChance) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
