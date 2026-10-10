/**
 * RFQ comparison and scoring. Pure: no database, no clock.
 * Formula (docs/SOURCING-PLAN.md §8.1):
 *   price   = 100 × lowest_complete_total / bid_total
 *   lead    = 100 × (min_lead + 1) / (bid_lead + 1)   (bid lead = max line lead time)
 *   quality = 10 × average evaluator score (0–10)
 *   total   = (w_price × price + w_lead × lead + w_quality × quality) / 100
 * Only complete bids (every line quoted, not withdrawn) get a total and a rank.
 * Ranks use full precision; `round1` is for display only.
 */

export function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function bidLeadDays(bid) {
  let lead = 0;
  for (const line of bid.lines) {
    if (!line.quoted) continue;
    const days = line.lead_time_days ?? bid.default_lead_time_days ?? 0;
    if (days > lead) lead = days;
  }
  return lead;
}

/**
 * @param {object} input
 * @param {{weight_price:number, weight_lead_time:number, weight_quality:number}} input.event
 * @param {{id:number, quantity:number}[]} input.lines event lines
 * @param {object[]} input.bids current revisions: { bid_id, status, total_cents, default_lead_time_days,
 *   first_submitted_at, lines:[{event_line_id, quoted, unit_price_cents, lead_time_days}] }
 * @param {Map<number, number>|Record<number, number>} [input.quality] bid_id -> average evaluator score (0–10)
 */
export function scoreBids({ event, lines, bids, quality = new Map() }) {
  const qualityOf = (bidId) => (quality instanceof Map ? quality.get(Number(bidId)) : quality[bidId]);
  const active = bids.filter((bid) => bid.status === 'submitted');

  const lowestPerLine = {};
  for (const line of lines) {
    let min = null;
    for (const bid of active) {
      const quoted = bid.lines.find((item) => Number(item.event_line_id) === Number(line.id) && item.quoted);
      if (quoted && (min === null || quoted.unit_price_cents < min)) min = quoted.unit_price_cents;
    }
    lowestPerLine[line.id] = min;
  }

  const rows = active.map((bid) => {
    const quotedIds = new Set(bid.lines.filter((item) => item.quoted).map((item) => Number(item.event_line_id)));
    const complete = lines.every((line) => quotedIds.has(Number(line.id)));
    return {
      bid_id: bid.bid_id,
      status: bid.status,
      total_cents: bid.total_cents,
      first_submitted_at: bid.first_submitted_at,
      complete,
      lead_time_days: bidLeadDays(bid),
      quality_average: qualityOf(bid.bid_id) ?? null,
      line_lowest: bid.lines
        .filter((item) => item.quoted)
        .map((item) => Number(item.event_line_id))
        .filter((id) => lowestPerLine[id] === bid.lines.find((item) => Number(item.event_line_id) === id).unit_price_cents)
    };
  });

  const complete = rows.filter((row) => row.complete);
  const lowestCompleteTotal = complete.length ? Math.min(...complete.map((row) => row.total_cents)) : null;
  const minLead = complete.length ? Math.min(...complete.map((row) => row.lead_time_days)) : null;
  const wp = Number(event.weight_price);
  const wl = Number(event.weight_lead_time);
  const wq = Number(event.weight_quality);

  for (const row of rows) {
    row.is_lowest_complete_total = row.complete && row.total_cents === lowestCompleteTotal;
    if (!row.complete) {
      row.price_score = null;
      row.lead_score = null;
      row.quality_score = row.quality_average == null ? null : 10 * row.quality_average;
      row.total_score = null;
      row.rank = null;
      continue;
    }
    row.price_score = row.total_cents === 0 ? 100 : (100 * lowestCompleteTotal) / row.total_cents;
    row.lead_score = (100 * (minLead + 1)) / (row.lead_time_days + 1);
    row.quality_score = 10 * (row.quality_average ?? 0);
    row.total_score = (wp * row.price_score + wl * row.lead_score + wq * row.quality_score) / 100;
  }

  const ranked = complete.slice().sort((a, b) => (
    b.total_score - a.total_score
    || a.total_cents - b.total_cents
    || String(a.first_submitted_at).localeCompare(String(b.first_submitted_at))
    || Number(a.bid_id) - Number(b.bid_id)
  ));
  ranked.forEach((row, index) => { row.rank = index + 1; });

  return {
    lowest_per_line: lowestPerLine,
    lowest_complete_total_cents: lowestCompleteTotal,
    min_lead_time_days: minLead,
    bids: rows
  };
}
