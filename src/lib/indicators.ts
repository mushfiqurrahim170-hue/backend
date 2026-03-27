export function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  
  if (prices.length < period) {
    return [];
  }
  
  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
    sum += prices[i];
  }
  ema.push(sum / period);
  
  // Calculate remaining EMAs
  for (let i = period; i < prices.length; i++) {
    const newEma = (prices[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
    ema.push(newEma);
  }
  
  return ema;
}

export function calculateRSI(prices: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  
  if (prices.length < period + 1) {
    return [];
  }
  
  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }
  
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));
  }
  
  return rsi;
}

export function calculateMACD(
  prices: number[],
  fast: number,
  slow: number,
  signal: number
): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);
  
  if (emaFast.length === 0 || emaSlow.length === 0) {
    return { macd: [], signal: [], histogram: [] };
  }
  
  const macdLine: number[] = [];
  const offset = slow - fast;
  
  for (let i = 0; i < emaFast.length - offset; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }
  
  if (macdLine.length < signal) {
    return { macd: macdLine, signal: [], histogram: [] };
  }
  
  const signalLine = calculateEMA(macdLine, signal);
  const histogram: number[] = [];
  
  const signalOffset = signal - 1;
  for (let i = signalOffset; i < macdLine.length; i++) {
    histogram.push(macdLine[i] - signalLine[i - signalOffset]);
  }
  
  return { macd: macdLine, signal: signalLine, histogram };
}

export function calculateAverageVolume(volumes: number[], period: number = 20): number {
  if (volumes.length === 0) return 0;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

