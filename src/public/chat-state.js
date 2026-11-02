export class UsageMeter {
  constructor() { this.reset(); }
  reset() { this.total = 0; this.input = 0; this.output = 0; this.responses = 0; this.unreported = 0; this.latest = null; }
  record(report) {
    this.responses++;
    this.latest = report || null;
    if (Number.isFinite(report?.tokens?.total) && report.tokens.total >= 0) this.total += report.tokens.total;
    else this.unreported++;
    if (Number.isFinite(report?.tokens?.input)) this.input += report.tokens.input;
    if (Number.isFinite(report?.tokens?.output)) this.output += report.tokens.output;
  }
  view() {
    const rate = this.latest?.limits?.filter(x => Number.isFinite(x.usedPercent)).sort((a, b) => b.usedPercent - a.usedPercent)[0];
    return { total: this.total, responses: this.responses, unreported: this.unreported, rate: rate || null };
  }
}

// Send recent complete turns. The scrollable UI retains the full in-memory history.
export function recentHistory(turns, maxCharacters = 60_000) {
  const result = [];
  let size = 0;
  for (let i = turns.length - 2; i >= 0 && result.length < 20; i -= 2) {
    const pair = turns.slice(i, i + 2);
    if (pair.length !== 2 || pair[0].role !== 'user' || pair[1].role !== 'assistant') break;
    const length = pair[0].content.length + pair[1].content.length;
    if (size + length > maxCharacters) break;
    size += length; result.unshift(...pair);
  }
  return result.map(({ role, content }) => ({ role, content }));
}
