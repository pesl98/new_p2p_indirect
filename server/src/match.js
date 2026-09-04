import { asCents, formatCents, toQty } from './money.js';

/**
 * Price tolerance for 3-way match: 1% of the PO unit price in cents,
 * rounded to the nearest cent (`Math.round(poUnitPriceCents / 100)`).
 * Exact cent equality is a perfect match; a non-zero difference within
 * this band is a tolerated (warning) match. Comparisons are integer-only.
 */
export function priceToleranceCents(poUnitPriceCents) {
  const price = asCents(poUnitPriceCents);
  if (price === 0) return 0;
  return Math.round(price / 100);
}

/**
 * Run 3-way match (PO vs GRN vs this invoice) using integer cents and integer qty.
 *
 * Quantity: fail if prior `po_items.quantity_invoiced` + this claim exceeds
 * `quantity_received` (physical GRN) or ordered qty. This function must be
 * called BEFORE incrementing `quantity_invoiced` so prior cumulative is intact.
 *
 * `quantity_invoiced` is still persisted for the claimed amount after match
 * (audit of what the vendor billed) regardless of pass/fail.
 */
export function run3WayMatch(db, invoiceId, poId, invoiceItems) {
  const matchEntries = [];
  let hasPriceVariance = false;
  let hasQuantityVariance = false;
  let hasToleratedPrice = false;

  for (const item of invoiceItems) {
    const poItem = db.prepare(`SELECT * FROM po_items WHERE id = ?`).get(item.po_item_id);
    if (!poItem) continue;

    const claimedQty = toQty(item.quantity_invoiced);
    const invoicedPrice = asCents(item.unit_price);
    const poPrice = asCents(poItem.unit_price);
    const poReceivedQty = toQty(poItem.quantity_received);
    const poOrderedQty = toQty(poItem.quantity);
    const priorInvoicedQty = toQty(poItem.quantity_invoiced);
    const cumulativeInvoicedQty = priorInvoicedQty + claimedQty;

    const priceDiff = invoicedPrice - poPrice;
    const absPriceDiff = Math.abs(priceDiff);
    const qtyOverageVsReceived = Math.max(0, cumulativeInvoicedQty - poReceivedQty);

    let status = 'pass';
    const messages = [];

    if (cumulativeInvoicedQty > poReceivedQty) {
      status = 'fail';
      hasQuantityVariance = true;
      messages.push(
        `Quantity variance: Cumulative invoiced ${cumulativeInvoicedQty} (prior ${priorInvoicedQty} + this claim ${claimedQty}) exceeds ${poReceivedQty} physically received on GRN.`
      );
    }
    if (cumulativeInvoicedQty > poOrderedQty) {
      status = 'fail';
      hasQuantityVariance = true;
      messages.push(
        `Quantity variance: Cumulative invoiced ${cumulativeInvoicedQty} exceeds ordered quantity ${poOrderedQty}.`
      );
    }
    if (status !== 'fail' && claimedQty < poOrderedQty && cumulativeInvoicedQty < poOrderedQty) {
      messages.push(`Partial billing: ${cumulativeInvoicedQty} of ${poOrderedQty} units billed.`);
    }

    if (absPriceDiff === 0) {
      // Exact unit-price match in cents.
    } else {
      const tolerance = priceToleranceCents(poPrice);
      // Integer percent for the human-readable message only — never used in comparisons.
      const pctBasisPoints = poPrice === 0 ? 0 : Math.round((priceDiff * 10000) / poPrice);
      const pctLabel = `${pctBasisPoints > 0 ? '+' : ''}${(pctBasisPoints / 100).toFixed(2)}`;

      if (absPriceDiff <= tolerance) {
        if (status !== 'fail') status = 'warning';
        hasToleratedPrice = true;
        messages.push(
          `Minor price deviation within 1% tolerance: $${formatCents(invoicedPrice)} vs PO $${formatCents(poPrice)} (${pctLabel}%; ${absPriceDiff}¢ of ${tolerance}¢ allowed).`
        );
      } else {
        status = 'fail';
        hasPriceVariance = true;
        messages.push(
          `Price discrepancy: Billed at $${formatCents(invoicedPrice)} vs authorized PO price $${formatCents(poPrice)} (${pctLabel}%).`
        );
      }
    }

    if (messages.length === 0) {
      messages.push(
        `Exact match: ${claimedQty} units at $${formatCents(invoicedPrice)} matches PO & physical receipts.`
      );
    }

    matchEntries.push({
      po_item_id: poItem.id,
      ordered_qty: poOrderedQty,
      received_qty: poReceivedQty,
      invoiced_qty: claimedQty,
      po_unit_price: poPrice,
      invoice_unit_price: invoicedPrice,
      qty_variance: qtyOverageVsReceived,
      price_variance: priceDiff,
      status,
      message: messages.join(' ')
    });
  }

  let overallMatchStatus = 'perfect_match';
  let invoiceStatus = 'matched';

  if (hasQuantityVariance && hasPriceVariance) {
    overallMatchStatus = 'total_variance';
    invoiceStatus = 'variance_flagged';
  } else if (hasQuantityVariance) {
    overallMatchStatus = 'quantity_variance';
    invoiceStatus = 'variance_flagged';
  } else if (hasPriceVariance) {
    overallMatchStatus = 'price_variance';
    invoiceStatus = 'variance_flagged';
  } else if (hasToleratedPrice) {
    overallMatchStatus = 'tolerated_match';
    invoiceStatus = 'matched';
  }

  const insertMatch = db.prepare(`
    INSERT INTO match_results (invoice_id, po_id, po_item_id, ordered_qty, received_qty, invoiced_qty, po_unit_price, invoice_unit_price, qty_variance, price_variance, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const m of matchEntries) {
    insertMatch.run(
      invoiceId,
      poId,
      m.po_item_id,
      m.ordered_qty,
      m.received_qty,
      m.invoiced_qty,
      m.po_unit_price,
      m.invoice_unit_price,
      m.qty_variance,
      m.price_variance,
      m.status,
      m.message
    );
  }

  db.prepare(`
    UPDATE invoices
    SET status = ?, match_status = ?
    WHERE id = ?
  `).run(invoiceStatus, overallMatchStatus, invoiceId);

  return { overallMatchStatus, invoiceStatus, matchEntries };
}
