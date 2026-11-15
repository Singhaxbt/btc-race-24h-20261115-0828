// Breakout scalper for the cbBTC/USDC 24h race (agent-fun/bars-replay/v1).
//
// Idea: the dev window is a noisy, net-down market (1-min returns have ~zero
// autocorrelation), so fast trend-following just pays the ~26-43 bps round-trip
// cost on every trade and loses. The money in this window is in a few large
// up-swings (multi-hour rallies). This bot therefore trades rarely and only on
// a confirmed breakout, and keeps its size small enough that pool impact does
// not eat the move.
//
//   - Entry: the close breaks above the highest close of the last 60 bars by
//     at least 10 bps (a margin, so a flat top-touch does not trigger), and the
//     bot is not in the last 60 bars of the window (a trade opened there would
//     be flattened at the close for a near-certain loss).
//   - Size: 50% of cash. Impact is quadratic in size (a $1,000 buy moves this
//     pool ~15 bps, a $500 buy ~8 bps), so half size keeps the round trip near
//     28 bps instead of ~43 bps while still catching the big moves.
//   - Exit, whole position: +300 bps take-profit, -80 bps stop-loss, or a
//     50 bps trailing stop under the highest close since entry. Whichever
//     hits first. The sell is re-sent while the reason holds (the position is
//     still there, so the next batch tries again).
//   - max_slippage_bps 100 (1%): a fill past that is refused rather than
//     filled for almost nothing.
//
// Determinism: no randomness, no clock, no environment, no file reads. All
// decisions come from the closes the harness sent and the account it reports.
// The only state is the close history, the peak since entry, and the batch
// count. Per-batch work is O(60) (one max over the lookback).

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Breakout lookback: the highest close of the last N bars. */
const LOOKBACK = 60;
/** The close must clear the lookback high by this many bps to count as a breakout. */
const MARGIN_BPS = 10;
/** Take-profit / stop-loss, in bps of the position's cost. */
const TP_BPS = 300;
const SL_BPS = 80;
/** Trailing stop, in bps under the highest close since entry. */
const TRAIL_BPS = 50;
/** Buy this fraction of cash: 1/2. */
const SIZE_NUM = 1n;
const SIZE_DEN = 2n;
/** A fill more than this past the close it was decided on is refused. */
const MAX_SLIPPAGE_BPS = 100;
/** No new entries once this many batches have been seen (the window is 1,440
 *  bars; a trade opened in the last hour is flattened at the close). */
const NO_ENTRY_FROM = 1380;

/** Closes of the bars before the one being answered, oldest first. */
const closes: bigint[] = [];
/** Highest close since the current position was opened, null when flat. */
let peak: bigint | null = null;

/**
 * Whether the position should be exited whole at this close: take-profit,
 * stop-loss, or the trailing stop under the highest close since entry.
 * Any one of the three is enough; the caller re-sends the sell while the
 * position is still there, so a rejected fill is retried next batch.
 */
function shouldExit(value: bigint, cost: bigint, peakClose: bigint | null, close: bigint): boolean {
  const takeProfit = value >= (cost * BigInt(10000 + TP_BPS)) / 10000n;
  const stopLoss = value <= (cost * BigInt(10000 - SL_BPS)) / 10000n;
  const trailing = peakClose !== null && close * 10000n <= peakClose * BigInt(10000 - TRAIL_BPS);
  return takeProfit || stopLoss || trailing;
}

/** Whether this close is a confirmed breakout above the lookback high. */
function isBreakout(close: bigint, high: bigint): boolean {
  return close * 10000n > high * BigInt(10000 + MARGIN_BPS);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // CBBTC absent this minute: a gap, decide nothing.
    const close = BigInt(bar.c);
    if (state.warmingUp) {
      closes.push(close);
      return [];
    }
    const held = state.positions.get(SYMBOL);
    let orders: (BuyInput | SellInput)[] = [];
    if (held !== undefined) {
      if (peak === null || close > peak) peak = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      if (shouldExit(value, cost, peak, close)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        peak = null;
      }
    } else if (state.seq < NO_ENTRY_FROM && closes.length >= LOOKBACK) {
      let high = 0n;
      for (let k = closes.length - LOOKBACK; k < closes.length; k++) {
        if (closes[k] > high) high = closes[k];
      }
      if (isBreakout(close, high)) {
        const notional = (state.cash * SIZE_NUM) / SIZE_DEN;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak = close;
        }
      }
    }
    closes.push(close);
    return orders;
  },
});
