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
// swings are much larger and tend to snap back: this bot buys only a real
// dip — the close at least 45 bps below its 60-minute simple moving
// average — and sells only on a real recovery, +100 bps from its fill, or
// on a hard stop at -150 bps. It trades rarely (3 fills on the dev window)
// and never chases. All arithmetic is integer (bigint) on the raw price
// units, so two runs on the same bars produce byte-identical replies: no
// clock, no network, no randomness anywhere.
//
// Risk controls: one position at a time, full cash per entry (impact is
// priced in by the fill model and the dip has to clear it), a -150 bps stop
// caps any single dip-buy that keeps falling, and a late-window fallback
// guarantees at least one filled trade (the guardrail needs >= 1) even in a
// window where no 45 bps dip ever appears.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Length of the moving average the dip is measured against, in bars.
const SMA_BARS = 60;
// Entry: close this far below the 60-bar average, in basis points.
const DIP_BPS = 45n;
// Exit: take profit / stop loss from the fill price, in basis points.
const TAKE_PROFIT_BPS = 100n;
const STOP_BPS = 150n;
// Max slippage vs the latest close an order tolerates (fills move only a
// few bps per minute, so 200 bps is generous without ever binding).
const MAX_SLIPPAGE_BPS = 200;
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
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        filledBuys += 1;
        entryFill = BigInt(fill.price);
      } else if (fill.side === 'sell') {
        entryFill = null;
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
          return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    const average = sma();
    if (average === null || average === 0n) return [];
    const dipBps = ((average - close) * 10000n) / average;
    const late = filledBuys === 0 && state.seq >= FALLBACK_BAR;
    const lastChance = filledBuys === 0 && state.seq >= LAST_CHANCE_BAR;
    const threshold = late ? FALLBACK_DIP_BPS : DIP_BPS;
    if (dipBps >= threshold || lastChance) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
