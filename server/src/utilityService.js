/**
 * Metered utility supply (water, electricity, gas).
 *
 * An arrangement is an ongoing supply, not a one-off goods PO.
 * Recording a reading or billed quantity opens a payable
 * (settlement_kind = utility, quantity_consumed in milli-units). No GRN.
 */

import { requireIntegerCents } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';
import {
  MeasuredFlowError,
  assertUtilityUnit,
  formatMeasured,
  measuredAmountCents,
  parseMeasuredMilli
} from './measuredQty.js';
import {
  insertMeasuredPayable,
  loadActiveSupplier,
  loadUser,
  optionalNotes,
  requireIsoDate,
  requireText,
  requireUserId
} from './measuredPayable.js';

export { MeasuredFlowError };

export async function getUtilityOverview(db) {
  const arrangements = await db.prepare(`
    SELECT
      a.*,
      s.name as supplier_name,
      s.code as supplier_code
    FROM utility_arrangements a
    JOIN suppliers s ON a.supplier_id = s.id
    ORDER BY s.name, a.name
  `).all();

  const consumptions = await db.prepare(`
    SELECT
      c.*,
      a.name as arrangement_name,
      a.utility_type,
      a.meter_label,
      s.name as supplier_name,
      s.code as supplier_code,
      u.name as recorded_by_name,
      po.po_number,
      po.status as po_status
    FROM utility_consumptions c
    JOIN utility_arrangements a ON c.arrangement_id = a.id
    JOIN suppliers s ON c.supplier_id = s.id
    JOIN users u ON c.recorded_by = u.id
    JOIN purchase_orders po ON c.po_id = po.id
    ORDER BY c.id DESC
  `).all();

  return { arrangements, consumptions };
}

export async function openUtilityArrangement(db, payload) {
  const supplier = await loadActiveSupplier(db, payload.supplier_id);
  const { utilityType, unitOfMeasure } = assertUtilityUnit(payload.utility_type, payload.unit_of_measure);
  const name = requireText(payload.name, 'name');
  const meterLabel = requireText(payload.meter_label, 'meter_label', 80);
  const notes = optionalNotes(payload.notes);
  const openedBy = requireUserId(payload.opened_by, 'opened_by');
  const user = await loadUser(db, openedBy, 'opened_by');
  const unitPrice = requireIntegerCents(payload.unit_price, 'unit_price');
  if (unitPrice <= 0) {
    throw new MeasuredFlowError('unit_price must be a positive number of cents per unit of measure.');
  }

  return db.transaction(async () => {
    const year = new Date().getFullYear();
    const arrangementNumber = await nextDocumentNumber(db, 'uta', year);
    const inserted = await db.prepare(`
      INSERT INTO utility_arrangements (
        arrangement_number, supplier_id, utility_type, name, meter_label,
        unit_of_measure, unit_price, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      arrangementNumber,
      supplier.id,
      utilityType,
      name,
      meterLabel,
      unitOfMeasure,
      unitPrice,
      notes
    );

    const actor = optionalNotes(payload.actor_name) || user.name;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('utility_arrangement', ?, 'OPENED', ?, ?)
    `).run(
      inserted.lastInsertRowid,
      actor,
      `Opened ${arrangementNumber}: ${utilityType} ${name} (${meterLabel}) at ${unitPrice}¢ per ${unitOfMeasure}.`
    );

    return {
      arrangementId: inserted.lastInsertRowid,
      arrangementNumber,
      message: `Utility arrangement ${arrangementNumber} is open. Record consumption against it. That does not post a goods receipt.`
    };
  });
}

function resolveConsumptionQuantity(payload) {
  const hasPrevious = payload.reading_previous !== undefined
    && payload.reading_previous !== null
    && payload.reading_previous !== '';
  const hasCurrent = payload.reading_current !== undefined
    && payload.reading_current !== null
    && payload.reading_current !== '';
  const hasQuantity = payload.quantity !== undefined
    && payload.quantity !== null
    && payload.quantity !== '';

  if (hasPrevious !== hasCurrent) {
    throw new MeasuredFlowError('Provide both reading_previous and reading_current, or a billed quantity.');
  }

  let readingPrevious = null;
  let readingCurrent = null;
  let fromReadings = null;
  if (hasPrevious) {
    readingPrevious = parseMeasuredMilli(payload.reading_previous, 'reading_previous', { allowZero: true });
    readingCurrent = parseMeasuredMilli(payload.reading_current, 'reading_current', { allowZero: true });
    if (readingCurrent <= readingPrevious) {
      throw new MeasuredFlowError('Current reading must be greater than the previous reading.');
    }
    fromReadings = readingCurrent - readingPrevious;
  }

  let billed = null;
  if (hasQuantity) {
    billed = parseMeasuredMilli(payload.quantity, 'quantity');
  }

  if (fromReadings == null && billed == null) {
    throw new MeasuredFlowError('Record meter readings or a billed quantity.');
  }
  if (fromReadings != null && billed != null && fromReadings !== billed) {
    throw new MeasuredFlowError('Billed quantity does not match the meter reading difference.');
  }

  return {
    readingPrevious,
    readingCurrent,
    quantityMilli: fromReadings ?? billed
  };
}

/**
 * Record measured usage and open a utility payable. Does not post a GRN.
 */
export async function recordUtilityConsumption(db, payload) {
  const arrangementId = requireUserId(payload.arrangement_id, 'arrangement_id');
  const recordedBy = requireUserId(payload.recorded_by, 'recorded_by');
  const user = await loadUser(db, recordedBy, 'recorded_by');
  const periodStart = requireIsoDate(payload.period_start, 'period_start');
  const periodEnd = requireIsoDate(payload.period_end, 'period_end');
  if (periodEnd < periodStart) {
    throw new MeasuredFlowError('period_end must be on or after period_start.');
  }
  const notes = optionalNotes(payload.notes);
  const measured = resolveConsumptionQuantity(payload);

  return db.transaction(async () => {
    const arrangement = await db.prepare(`
      SELECT a.*, s.name as supplier_name, s.payment_terms, s.status as supplier_status, s.id as supplier_id
      FROM utility_arrangements a
      JOIN suppliers s ON a.supplier_id = s.id
      WHERE a.id = ?
    `).get(arrangementId);
    if (!arrangement) throw new MeasuredFlowError('Utility arrangement not found.', 404);
    if (arrangement.status !== 'active') {
      throw new MeasuredFlowError('This utility arrangement is inactive.');
    }
    if (arrangement.supplier_status !== 'active') {
      throw new MeasuredFlowError(`Supplier ${arrangement.supplier_name} is not active.`);
    }

    const amountCents = measuredAmountCents(measured.quantityMilli, arrangement.unit_price);
    const quantityLabel = formatMeasured(measured.quantityMilli, arrangement.unit_of_measure);
    const description = `${arrangement.name} (${arrangement.meter_label}) ${periodStart} to ${periodEnd}`;
    const year = Number(periodEnd.slice(0, 4));
    const consumptionNumber = await nextDocumentNumber(db, 'ucn', year);
    const actor = optionalNotes(payload.actor_name) || user.name;
    const supplier = {
      id: arrangement.supplier_id,
      payment_terms: arrangement.payment_terms
    };

    const payable = await insertMeasuredPayable(db, {
      settlementKind: 'utility',
      supplier,
      user,
      issueDate: periodEnd,
      locationLabel: arrangement.meter_label,
      notes: [
        `Utility consumption ${consumptionNumber} on ${arrangement.arrangement_number}.`,
        `${arrangement.utility_type} billed by measured usage, not a goods receipt.`,
        notes
      ].filter(Boolean).join(' '),
      description,
      quantityMilli: measured.quantityMilli,
      unitPrice: arrangement.unit_price,
      unitOfMeasure: arrangement.unit_of_measure,
      amountCents,
      actor,
      poAuditDetail: (poNumber) => (
        `${poNumber} opened for utility consumption ${consumptionNumber} (${quantityLabel}). No GRN.`
      )
    });

    const consumption = await db.prepare(`
      INSERT INTO utility_consumptions (
        consumption_number, arrangement_id, supplier_id, period_start, period_end,
        reading_previous_milli, reading_current_milli, quantity_milli, unit_of_measure,
        unit_price, amount_cents, po_id, po_item_id, recorded_by, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      consumptionNumber,
      arrangement.id,
      arrangement.supplier_id,
      periodStart,
      periodEnd,
      measured.readingPrevious,
      measured.readingCurrent,
      measured.quantityMilli,
      arrangement.unit_of_measure,
      arrangement.unit_price,
      amountCents,
      payable.poId,
      payable.poItemId,
      user.id,
      notes
    );

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('utility_consumption', ?, 'RECORDED', ?, ?)
    `).run(
      consumption.lastInsertRowid,
      actor,
      `Recorded ${consumptionNumber}: ${quantityLabel} on ${arrangement.arrangement_number} onto ${payable.poNumber}. No GRN.`
    );

    return {
      consumptionId: consumption.lastInsertRowid,
      consumptionNumber,
      arrangementId: arrangement.id,
      poId: payable.poId,
      poNumber: payable.poNumber,
      poItemId: payable.poItemId,
      poStatus: payable.poStatus,
      quantityMilli: measured.quantityMilli,
      amountCents,
      unitPrice: arrangement.unit_price,
      message: `Recorded ${quantityLabel} (${consumptionNumber}). Payable ${payable.poNumber} is ready for the supplier invoice. No goods receipt was posted.`
    };
  });
}
