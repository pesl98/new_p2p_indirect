/**
 * Vendor-managed bulk: gases and fluids in a real container or silo.
 *
 * The vessel stores capacity, unit of measure, and current measured level
 * in milli-units. Stock stays supplier-owned until drawn. A draw opens a
 * payable the same way a discrete consignment issue does (quantity_consumed,
 * no GRN) but does not use consignment_balances or location_label.
 */

import { isServiceLine } from './lineType.js';
import { requireIntegerCents } from './money.js';
import { nextDocumentNumber } from './docNumbers.js';
import {
  MeasuredFlowError,
  assertBulkUnit,
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
  requireUserId,
  todayIso
} from './measuredPayable.js';

export { MeasuredFlowError };

const VESSEL_TYPES = ['container', 'silo'];

export async function getBulkOverview(db) {
  const containers = await db.prepare(`
    SELECT
      c.*,
      s.name as supplier_name,
      s.code as supplier_code,
      i.sku,
      i.name as item_name,
      i.unit as catalog_unit
    FROM bulk_containers c
    JOIN suppliers s ON c.supplier_id = s.id
    JOIN catalog_items i ON c.catalog_item_id = i.id
    ORDER BY s.name, c.name
  `).all();

  const fills = await db.prepare(`
    SELECT
      f.*,
      c.name as container_name,
      c.vessel_type,
      s.name as supplier_name,
      i.sku,
      i.name as item_name,
      u.name as filled_by_name
    FROM bulk_fills f
    JOIN bulk_containers c ON f.container_id = c.id
    JOIN suppliers s ON f.supplier_id = s.id
    JOIN catalog_items i ON f.catalog_item_id = i.id
    JOIN users u ON f.filled_by = u.id
    ORDER BY f.id DESC
  `).all();

  const draws = await db.prepare(`
    SELECT
      d.*,
      c.name as container_name,
      c.vessel_type,
      s.name as supplier_name,
      i.sku,
      i.name as item_name,
      u.name as drawn_by_name,
      po.po_number,
      po.status as po_status
    FROM bulk_draws d
    JOIN bulk_containers c ON d.container_id = c.id
    JOIN suppliers s ON d.supplier_id = s.id
    JOIN catalog_items i ON d.catalog_item_id = i.id
    JOIN users u ON d.drawn_by = u.id
    JOIN purchase_orders po ON d.po_id = po.id
    ORDER BY d.id DESC
  `).all();

  return { containers, fills, draws };
}

async function loadGoodsCatalogItem(db, catalogItemId) {
  const id = requireUserId(catalogItemId, 'catalog_item_id');
  const item = await db.prepare(`SELECT * FROM catalog_items WHERE id = ?`).get(id);
  if (!item) throw new MeasuredFlowError('Catalog item not found.', 404);
  if (item.status !== 'active') {
    throw new MeasuredFlowError(`Catalog item ${item.sku} is not active.`);
  }
  if (isServiceLine(item)) {
    throw new MeasuredFlowError(
      `${item.name} is a service. Vendor-managed bulk is for measured goods in a container or silo.`
    );
  }
  return item;
}

function requireVesselType(value) {
  const text = String(value || '').trim();
  if (!VESSEL_TYPES.includes(text)) {
    throw new MeasuredFlowError('vessel_type must be container or silo.');
  }
  return text;
}

export async function registerBulkContainer(db, payload) {
  const supplier = await loadActiveSupplier(db, payload.supplier_id);
  const item = await loadGoodsCatalogItem(db, payload.catalog_item_id);
  const name = requireText(payload.name, 'name');
  const vesselType = requireVesselType(payload.vessel_type);
  const unitOfMeasure = assertBulkUnit(payload.unit_of_measure);
  const capacityMilli = parseMeasuredMilli(payload.capacity, 'capacity');
  const notes = optionalNotes(payload.notes);
  const registeredBy = requireUserId(payload.registered_by, 'registered_by');
  const user = await loadUser(db, registeredBy, 'registered_by');
  const unitPrice = requireIntegerCents(payload.unit_price, 'unit_price');
  if (unitPrice <= 0) {
    throw new MeasuredFlowError('unit_price must be a positive number of cents per unit of measure.');
  }

  return db.transaction(async () => {
    const duplicate = await db.prepare(`
      SELECT id FROM bulk_containers WHERE supplier_id = ? AND name = ?
    `).get(supplier.id, name);
    if (duplicate) {
      throw new MeasuredFlowError(`${supplier.name} already has a vessel named ${name}.`);
    }

    const year = new Date().getFullYear();
    const containerNumber = await nextDocumentNumber(db, 'bvl', year);
    const inserted = await db.prepare(`
      INSERT INTO bulk_containers (
        container_number, supplier_id, catalog_item_id, name, vessel_type,
        unit_of_measure, capacity_milli, level_milli, unit_price, notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active')
    `).run(
      containerNumber,
      supplier.id,
      item.id,
      name,
      vesselType,
      unitOfMeasure,
      capacityMilli,
      unitPrice,
      notes
    );

    const actor = optionalNotes(payload.actor_name) || user.name;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('bulk_container', ?, 'REGISTERED', ?, ?)
    `).run(
      inserted.lastInsertRowid,
      actor,
      `Registered ${containerNumber}: ${vesselType} ${name} for ${item.sku}, capacity ${formatMeasured(capacityMilli, unitOfMeasure)}. Supplier-owned; not consignment stock.`
    );

    return {
      containerId: inserted.lastInsertRowid,
      containerNumber,
      levelMilli: 0,
      capacityMilli,
      message: `${vesselType === 'silo' ? 'Silo' : 'Container'} ${containerNumber} is empty and supplier-owned. Fill it before drawing. That does not post a goods receipt.`
    };
  });
}

async function loadActiveContainer(db, containerId) {
  const container = await db.prepare(`
    SELECT
      c.*,
      s.name as supplier_name,
      s.payment_terms,
      s.status as supplier_status,
      i.sku,
      i.name as item_name,
      i.category,
      i.line_type,
      i.status as item_status
    FROM bulk_containers c
    JOIN suppliers s ON c.supplier_id = s.id
    JOIN catalog_items i ON c.catalog_item_id = i.id
    WHERE c.id = ?
  `).get(containerId);
  if (!container) throw new MeasuredFlowError('Vessel not found.', 404);
  if (container.status !== 'active') {
    throw new MeasuredFlowError('This vessel is inactive.');
  }
  if (container.supplier_status !== 'active') {
    throw new MeasuredFlowError(`Supplier ${container.supplier_name} is not active.`);
  }
  if (container.item_status !== 'active') {
    throw new MeasuredFlowError(`Catalog item ${container.sku} is not active.`);
  }
  return container;
}

/**
 * Supplier delivery into the vessel. Increases measured level only.
 * Does not create a PO, GRN, or consignment balance.
 */
export async function fillBulkContainer(db, payload) {
  const containerId = requireUserId(payload.container_id, 'container_id');
  const quantityMilli = parseMeasuredMilli(payload.quantity, 'quantity');
  const filledBy = requireUserId(payload.filled_by, 'filled_by');
  const user = await loadUser(db, filledBy, 'filled_by');
  const notes = optionalNotes(payload.notes);
  const fillDate = payload.fill_date ? requireIsoDate(payload.fill_date, 'fill_date') : todayIso();
  let unitPrice = null;
  if (payload.unit_price !== undefined && payload.unit_price !== null && payload.unit_price !== '') {
    unitPrice = requireIntegerCents(payload.unit_price, 'unit_price');
    if (unitPrice <= 0) {
      throw new MeasuredFlowError('unit_price must be a positive number of cents per unit of measure.');
    }
  }

  return db.transaction(async () => {
    const container = await loadActiveContainer(db, containerId);
    const price = unitPrice == null ? container.unit_price : unitPrice;
    const updated = await db.prepare(`
      UPDATE bulk_containers
      SET level_milli = level_milli + ?,
          unit_price = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active' AND level_milli + ? <= capacity_milli
    `).run(quantityMilli, price, container.id, quantityMilli);
    if (!updated.changes) {
      const room = container.capacity_milli - container.level_milli;
      throw new MeasuredFlowError(
        `Not enough free capacity in ${container.name}: ${formatMeasured(room, container.unit_of_measure)} free, ${formatMeasured(quantityMilli, container.unit_of_measure)} requested.`
      );
    }

    const year = Number(fillDate.slice(0, 4));
    const fillNumber = await nextDocumentNumber(db, 'bfl', year);
    const level = await db.prepare(`SELECT level_milli FROM bulk_containers WHERE id = ?`).get(container.id);
    const fill = await db.prepare(`
      INSERT INTO bulk_fills (
        fill_number, container_id, supplier_id, catalog_item_id, quantity_milli,
        unit_of_measure, unit_price, level_after_milli, filled_by, fill_date, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fillNumber,
      container.id,
      container.supplier_id,
      container.catalog_item_id,
      quantityMilli,
      container.unit_of_measure,
      price,
      level.level_milli,
      user.id,
      fillDate,
      notes
    );

    const actor = optionalNotes(payload.actor_name) || user.name;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('bulk_fill', ?, 'FILLED', ?, ?)
    `).run(
      fill.lastInsertRowid,
      actor,
      `Filled ${fillNumber}: ${formatMeasured(quantityMilli, container.unit_of_measure)} into ${container.name}. Level is ${formatMeasured(level.level_milli, container.unit_of_measure)}. Supplier-owned; no GRN.`
    );

    return {
      fillId: fill.lastInsertRowid,
      fillNumber,
      containerId: container.id,
      levelMilli: level.level_milli,
      unitPrice: price,
      message: `Fill ${fillNumber} recorded. Level is now ${formatMeasured(level.level_milli, container.unit_of_measure)}. This is supplier-owned bulk, not a goods receipt.`
    };
  });
}

/**
 * Draw measured quantity into company use.
 * Decrements the vessel level and opens a bulk payable. Does not post a GRN.
 */
export async function drawBulkContainer(db, payload) {
  const containerId = requireUserId(payload.container_id, 'container_id');
  const quantityMilli = parseMeasuredMilli(payload.quantity, 'quantity');
  const drawnBy = requireUserId(payload.drawn_by, 'drawn_by');
  const user = await loadUser(db, drawnBy, 'drawn_by');
  const notes = optionalNotes(payload.notes);
  const drawDate = payload.draw_date ? requireIsoDate(payload.draw_date, 'draw_date') : todayIso();

  return db.transaction(async () => {
    const container = await loadActiveContainer(db, containerId);
    const decremented = await db.prepare(`
      UPDATE bulk_containers
      SET level_milli = level_milli - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active' AND level_milli >= ?
    `).run(quantityMilli, container.id, quantityMilli);
    if (!decremented.changes) {
      throw new MeasuredFlowError(
        `Not enough measured product in ${container.name}: ${formatMeasured(container.level_milli, container.unit_of_measure)} on hand, ${formatMeasured(quantityMilli, container.unit_of_measure)} requested.`
      );
    }

    const year = Number(drawDate.slice(0, 4));
    const drawNumber = await nextDocumentNumber(db, 'bdr', year);
    const quantityLabel = formatMeasured(quantityMilli, container.unit_of_measure);
    const amountCents = measuredAmountCents(quantityMilli, container.unit_price);
    const level = await db.prepare(`SELECT level_milli FROM bulk_containers WHERE id = ?`).get(container.id);
    const actor = optionalNotes(payload.actor_name) || user.name;
    const supplier = { id: container.supplier_id, payment_terms: container.payment_terms };

    const payable = await insertMeasuredPayable(db, {
      settlementKind: 'bulk',
      supplier,
      user,
      issueDate: drawDate,
      locationLabel: container.name,
      notes: [
        `Bulk draw ${drawNumber} from ${container.container_number} (${container.vessel_type} ${container.name}).`,
        'Supplier-owned measured product drawn into company use. Not discrete consignment.',
        notes
      ].filter(Boolean).join(' '),
      description: `${container.item_name} drawn from ${container.name}`,
      category: container.category,
      quantityMilli,
      unitPrice: container.unit_price,
      unitOfMeasure: container.unit_of_measure,
      amountCents,
      actor,
      poAuditDetail: (poNumber) => (
        `${poNumber} opened for bulk draw ${drawNumber} (${quantityLabel} from ${container.name}). No GRN.`
      )
    });

    const draw = await db.prepare(`
      INSERT INTO bulk_draws (
        draw_number, container_id, supplier_id, catalog_item_id, quantity_milli,
        unit_of_measure, unit_price, amount_cents, level_after_milli,
        po_id, po_item_id, drawn_by, draw_date, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      drawNumber,
      container.id,
      container.supplier_id,
      container.catalog_item_id,
      quantityMilli,
      container.unit_of_measure,
      container.unit_price,
      amountCents,
      level.level_milli,
      payable.poId,
      payable.poItemId,
      user.id,
      drawDate,
      notes
    );

    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('bulk_draw', ?, 'DRAWN', ?, ?)
    `).run(
      draw.lastInsertRowid,
      actor,
      `Drew ${drawNumber}: ${quantityLabel} from ${container.name} onto ${payable.poNumber}. Level is ${formatMeasured(level.level_milli, container.unit_of_measure)}. No GRN.`
    );

    return {
      drawId: draw.lastInsertRowid,
      drawNumber,
      containerId: container.id,
      poId: payable.poId,
      poNumber: payable.poNumber,
      poItemId: payable.poItemId,
      poStatus: payable.poStatus,
      quantityMilli,
      levelMilli: level.level_milli,
      amountCents,
      unitPrice: container.unit_price,
      message: `Drew ${quantityLabel} (${drawNumber}). Payable ${payable.poNumber} is ready for the supplier invoice. No goods receipt was posted.`
    };
  });
}
