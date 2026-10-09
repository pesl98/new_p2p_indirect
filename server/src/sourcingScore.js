/**
 * Scoring formula from the sourcing plan (§8.1). Pure: no database.
 * Display values are rounded to one decimal. Ranks use full precision.
 * Only a complete, non-withdrawn bid gets a total score and a rank.
 */

export function roundScore(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10) / 10;
}

function quotedLead(bid) {
  const leads = (bid.lines || [])
    .filter((line) => line.quoted)
    .map((line) => line.lead_time_days)
    .filter((value) => value != null && Number.isFinite(Number(value)))
    .map(Number);
  if (leads.length) return Math.max(...leads);
  if (bid.default_lead_time_days != null && Number.isFinite(Number(bid.default_lead_time_days))) {
    return Number(bid.default_lead_time_days);
  }
  return 0;
}

export function bidIsComplete(bid, lineCount) {
  if (!bid || bid.status === 'withdrawn') return false;
  const quoted = (bid.lines || []).filter((line) => line.quoted);
  if (quoted.length !== lineCount) return false;
  return quoted.every((line) => Number(line.unit_price_cents) > 0);
}

/**
 * @param {object} input
 * @param {Array<{id:number}>} input.lines event lines
 * @param {Array} input.bids current revisions, including withdrawn
 * @param {{price:number, lead:number, quality:number}} input.weights
 * @param {Map<number, number[]>|Record<string, number[]>} [input.qualityByBid] scores 0–10 from evaluators without a conflict
 */
export function scoreComparison({ lines = [], bids = [], weights, qualityByBid = new Map() } = {}) {
  const lineIds = lines.map((line) => Number(line.id));
  const lineCount = lineIds.length;
  const qualityMap = qualityByBid instanceof Map
    ? qualityByBid
    : new Map(Object.entries(qualityByBid || {}).map(([key, value]) => [Number(key), value]));

  const active = bids.filter((bid) => bid.status !== 'withdrawn');
  const lowestByLine = new Map();
  for (const lineId of lineIds) {
    let lowest = null;
    for (const bid of active) {
      const row = (bid.lines || []).find((line) => Number(line.event_line_id) === lineId && line.quoted);
      if (!row || row.unit_price_cents == null) continue;
      const price = Number(row.unit_price_cents);
      if (lowest == null || price < lowest) lowest = price;
    }
    if (lowest != null) lowestByLine.set(lineId, lowest);
  }

  const complete = active.filter((bid) => bidIsComplete(bid, lineCount));
  const lowestComplete = complete.length
    ? Math.min(...complete.map((bid) => Number(bid.total_cents)))
    : null;
  const minLead = complete.length ? Math.min(...complete.map(quotedLead)) : null;

  const scored = bids.map((bid) => {
    const completeBid = bidIsComplete(bid, lineCount);
    const lead = quotedLead(bid);
    const qualitySamples = qualityMap.get(Number(bid.bid_id)) || qualityMap.get(Number(bid.id)) || [];
    const qualityAverage = qualitySamples.length
      ? qualitySamples.reduce((sum, value) => sum + Number(value), 0) / qualitySamples.length
      : null;
    const quality = qualityAverage == null ? null : 10 * qualityAverage;
    let priceScore = null;
    let leadScore = null;
    let total = null;
    if (completeBid && lowestComplete != null && Number(bid.total_cents) > 0) {
      priceScore = 100 * lowestComplete / Number(bid.total_cents);
      leadScore = 100 * ((minLead ?? 0) + 1) / (lead + 1);
      if (weights.quality > 0 && quality == null) {
        total = null;
      } else {
        total = (
          weights.price * priceScore
          + weights.lead * leadScore
          + weights.quality * (quality ?? 0)
        ) / 100;
      }
    }
    const pricedLines = lineIds.map((lineId) => {
      const row = (bid.lines || []).find((line) => Number(line.event_line_id) === lineId) || null;
      const quoted = Boolean(row?.quoted);
      const unit = quoted ? Number(row.unit_price_cents) : null;
      const lowest = lowestByLine.get(lineId);
      return {
        event_line_id: lineId,
        quoted,
        unit_price_cents: quoted ? unit : null,
        line_total_cents: quoted ? Number(row.line_total_cents) : null,
        lead_time_days: row?.lead_time_days ?? null,
        comment: row?.comment || null,
        is_lowest: quoted && lowest != null && unit === lowest
      };
    });
    return {
      bid_id: Number(bid.bid_id ?? bid.id),
      invitation_id: bid.invitation_id == null ? null : Number(bid.invitation_id),
      supplier_id: Number(bid.supplier_id),
      status: bid.status,
      revision: Number(bid.revision),
      total_cents: Number(bid.total_cents),
      first_submitted_at: bid.first_submitted_at || bid.submitted_at || null,
      submitted_at: bid.submitted_at || null,
      validity_until: bid.validity_until || null,
      supplier_note: bid.supplier_note || null,
      complete: completeBid,
      withdrawn: bid.status === 'withdrawn',
      lead_time_days: lead,
      lines: pricedLines,
      scores: {
        price: priceScore,
        lead_time: leadScore,
        quality,
        total,
        price_display: roundScore(priceScore),
        lead_time_display: roundScore(leadScore),
        quality_display: roundScore(quality),
        total_display: roundScore(total)
      },
      rank: null
    };
  });

  const ranked = scored
    .filter((bid) => bid.complete && bid.scores.total != null)
    .slice()
    .sort((a, b) => {
      if (b.scores.total !== a.scores.total) return b.scores.total - a.scores.total;
      if (a.total_cents !== b.total_cents) return a.total_cents - b.total_cents;
      return String(a.first_submitted_at || '').localeCompare(String(b.first_submitted_at || ''));
    });
  ranked.forEach((bid, index) => {
    bid.rank = index + 1;
  });

  return {
    lowest_complete_total_cents: lowestComplete,
    bids: scored
  };
}
