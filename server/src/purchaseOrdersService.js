import { actorFromSession, appendComplianceEvent } from './complianceAudit.js';
import { withBusyRetry } from './busyRetry.js';
import { nextDocumentNumber } from './docNumbers.js';
import { findOpenSourcingEvent } from './sourcingService.js';
import { formatMoney, asCents } from './money.js';
import { withDeploymentCurrency } from './currencyConfig.js';
import { normalizeLineType, resolveServiceBasis } from './lineType.js';
import {
  WEBHOOK_EVENTS,
  enqueueWebhook,
  externalIdFor,
  kickWebhookDispatch
} from './webhookOutbox.js';

export class PurchaseOrderError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = 'PurchaseOrderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toPositiveInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function mappingForItem(mappings, itemId) {
  if (!mappings) return null;
  if (Array.isArray(mappings)) {
    const row = mappings.find((m) => Number(m.requisition_item_id) === Number(itemId));
    return row?.supplier_id;
  }
  return mappings[itemId] ?? mappings[String(itemId)];
}

/**
 * Resolve a PR line's supplier.
 * Order: convert-time mapping → estimated_supplier_id → catalog preferred_supplier_id.
 * Returns null when none are set — callers must fail closed rather than invent a vendor.
 */
export function resolveRequisitionItemSupplier(item, options = {}) {
  const mapped = toPositiveInt(
    options.mappingSupplierId ?? mappingForItem(options.supplier_mappings, item.id)
  );
  if (mapped) return mapped;

  const estimated = toPositiveInt(item.estimated_supplier_id);
  if (estimated) return estimated;

  const catalogPreferred = toPositiveInt(
    options.catalogPreferredId
      ?? item.catalog_preferred_supplier_id
      ?? item.preferred_supplier_id
  );
  if (catalogPreferred) return catalogPreferred;

  return null;
}

export function groupItemsBySupplier(items, options = {}) {
  const groups = new Map();
  const unresolved = [];

  for (const item of items) {
    const supplierId = resolveRequisitionItemSupplier(item, {
      supplier_mappings: options.supplier_mappings,
      catalogPreferredId: item.catalog_preferred_supplier_id
    });
    if (!supplierId) {
      unresolved.push(item);
      continue;
    }
    if (!groups.has(supplierId)) {
      groups.set(supplierId, []);
    }
    groups.get(supplierId).push(item);
  }

  return { groups, unresolved };
}

/**
 * Attach the default (pre-mapping) resolved supplier so the convert UI
 * and PR detail share the same fail-closed resolution as convert.
 */
export function annotateResolvedSupplier(item) {
  const resolvedId = resolveRequisitionItemSupplier(item);
  let resolvedName = null;
  if (resolvedId) {
    if (toPositiveInt(item.estimated_supplier_id) === resolvedId) {
      resolvedName = item.estimated_supplier_name || null;
    }
    if (!resolvedName && toPositiveInt(item.catalog_preferred_supplier_id) === resolvedId) {
      resolvedName = item.catalog_preferred_supplier_name || null;
    }
    if (!resolvedName) {
      resolvedName = item.resolved_supplier_name || null;
    }
  }
  return {
    ...item,
    resolved_supplier_id: resolvedId,
    resolved_supplier_name: resolvedName
  };
}

export function annotateResolvedSuppliers(items) {
  return (items || []).map(annotateResolvedSupplier);
}

function mappingSupplierIdForItem(mappings, itemId) {
  return toPositiveInt(mappingForItem(mappings, itemId));
}

/**
 * Lines whose convert-time mapping differs from the default resolved supplier.
 * Used so CONVERTED_TO_PO / SPLIT_CONVERTED_TO_PO audit rows record remaps.
 */
export function listSupplierRemaps(items, supplierMappings) {
  if (!supplierMappings) return [];
  const remaps = [];
  for (const item of items) {
    const mapped = mappingSupplierIdForItem(supplierMappings, item.id);
    if (!mapped) continue;
    const fallback = resolveRequisitionItemSupplier(item);
    if (fallback === mapped) continue;
    remaps.push({
      requisition_item_id: item.id,
      item_description: item.item_description || `line ${item.id}`,
      from_supplier_id: fallback,
      to_supplier_id: mapped
    });
  }
  return remaps;
}

async function loadRequisitionItems(db, requisitionId) {
  return await db.prepare(`
    SELECT
      ri.*,
      ci.preferred_supplier_id AS catalog_preferred_supplier_id
    FROM requisition_items ri
    LEFT JOIN catalog_items ci ON ri.catalog_item_id = ci.id
    WHERE ri.requisition_id = ?
    ORDER BY ri.id ASC
  `).all(requisitionId);
}

async function loadSupplier(db, supplierId) {
  return await db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(supplierId);
}

async function actorNameFor(db, createdBy) {
  if (!createdBy) return 'Procurement Officer';
  const user = await db.prepare(`SELECT name FROM users WHERE id = ?`).get(createdBy);
  return user?.name || 'Procurement Officer';
}

/**
 * Convert an approved requisition into one issued PO per resolved supplier.
 * Single-supplier PRs still create exactly one PO. Missing suppliers fail closed (400).
 * PR is marked converted_to_po only after every split PO is written, in one transaction.
 */
export async function convertRequisitionToPurchaseOrders(db, payload) {
  const {
    requisition_id,
    created_by,
    shipping_address,
    notes,
    payment_terms,
    supplier_mappings
  } = payload;

  const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(requisition_id);
  if (!pr) {
    throw new PurchaseOrderError('Requisition not found', 404);
  }
  // An award requisition becomes POs only through "Bestelling(en) aanmaken", which keys
  // every PO to the award. This path (and its supplier_mappings) would bypass that.
  const awardSourced = await db.prepare(`
    SELECT id FROM sourcing_awards WHERE award_requisition_id = ? LIMIT 1
  `).get(pr.id);
  if (awardSourced) {
    throw new PurchaseOrderError(
      'This requisition comes from an RFQ award. Create its purchase orders from the RFQ.',
      409,
      'award_requisition_via_sourcing'
    );
  }
  if (pr.status !== 'approved') {
    throw new PurchaseOrderError('Requisition must be in "approved" state to generate a Purchase Order.');
  }
  const sourcingEvent = await findOpenSourcingEvent(db, requisition_id);
  if (sourcingEvent) {
    throw new PurchaseOrderError(
      'This requisition is in an open sourcing event and cannot be converted.',
      409,
      'requisition_in_sourcing'
    );
  }

  const prItems = await loadRequisitionItems(db, requisition_id);
  if (prItems.length === 0) {
    throw new PurchaseOrderError('Requisition has no items.');
  }

  const { groups, unresolved } = groupItemsBySupplier(prItems, { supplier_mappings });
  if (unresolved.length > 0) {
    const labels = unresolved.map((item) => item.item_description || `line ${item.id}`).join(', ');
    throw new PurchaseOrderError(
      `Cannot convert requisition: ${unresolved.length} line(s) have no resolvable supplier (${labels}). Set estimated_supplier_id, a catalog preferred supplier, or an explicit convert-time mapping.`
    );
  }

  const supplierIds = [...groups.keys()];
  for (const supplierId of supplierIds) {
    const supplier = await loadSupplier(db, supplierId);
    if (!supplier) {
      throw new PurchaseOrderError(`Supplier ${supplierId} was resolved on a line but does not exist.`);
    }
    if (supplier.status && supplier.status !== 'active') {
      throw new PurchaseOrderError(
        `Cannot convert requisition: supplier ${supplier.name} (${supplier.code}) is ${supplier.status} and cannot be issued a new PO. Remap the line to an active supplier.`
      );
    }
  }

  const createdBy = created_by || 3;
  const actorName = await actorNameFor(db, createdBy);
  const issueDate = new Date().toISOString().split('T')[0];
  const deliveryDate = pr.needed_by_date || new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
  const shipTo = shipping_address || 'Acme HQ - Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701';
  const split = supplierIds.length > 1;
  const remaps = listSupplierRemaps(prItems, supplier_mappings);
  const remapLabels = [];
  for (const remap of remaps) {
    const from = remap.from_supplier_id ? await loadSupplier(db, remap.from_supplier_id) : null;
    const to = await loadSupplier(db, remap.to_supplier_id);
    remapLabels.push(
      remap.from_supplier_id
        ? `${remap.item_description}: ${from?.name || remap.from_supplier_id} → ${to?.name || remap.to_supplier_id}`
        : `${remap.item_description}: assigned ${to?.name || remap.to_supplier_id}`
    );
  }

  const issued = await db.transaction(async () => {
    const currentYear = new Date().getFullYear();
    const created = [];

    const insertPO = db.prepare(`
      INSERT INTO purchase_orders (
        po_number, requisition_id, supplier_id, created_by, status, total_amount,
        issue_date, expected_delivery_date, payment_terms, shipping_address, notes
      )
      VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?)
    `);

    const insertPOItem = db.prepare(`
      INSERT INTO po_items (
        po_id, requisition_item_id, item_description, category, quantity,
        unit_price, total_price, quantity_received, quantity_accepted, quantity_invoiced, line_type, service_basis
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    `);

    for (const supplierId of supplierIds) {
      const items = groups.get(supplierId);
      const supplier = await loadSupplier(db, supplierId);
      const poTotal = items.reduce((sum, item) => sum + asCents(item.total_price), 0);
      const poNumber = await nextDocumentNumber(db, 'po', currentYear);
      const defaultNote = split
        ? `Generated from approved requisition ${pr.pr_number} (split ${created.length + 1} of ${supplierIds.length} — ${supplier.name})`
        : `Generated automatically from approved requisition ${pr.pr_number}`;
      const poNotes = notes
        ? (split ? `${notes} [split ${created.length + 1} of ${supplierIds.length} — ${supplier.name}]` : notes)
        : defaultNote;

      const poResult = await insertPO.run(
        poNumber,
        requisition_id,
        supplierId,
        createdBy,
        poTotal,
        issueDate,
        deliveryDate,
        payment_terms || supplier.payment_terms || 'Net 30',
        shipTo,
        poNotes
      );

      const poId = Number(poResult.lastInsertRowid);

      for (const item of items) {
        const lineType = normalizeLineType(item.line_type, item.category);
        await insertPOItem.run(
          poId,
          item.id,
          item.item_description,
          item.category,
          item.quantity,
          item.unit_price,
          item.total_price,
          lineType,
          resolveServiceBasis(item.service_basis, lineType)
        );
      }

      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('purchase_order', ?, 'ISSUED', ?, ?)
      `).run(
        poId,
        actorName,
        `PO ${poNumber} issued from PR ${pr.pr_number} to ${supplier.name}`
      );

      await enqueueWebhook(db, {
        eventType: WEBHOOK_EVENTS.PO_ISSUED,
        entityType: 'purchase_order',
        entityId: poId,
        data: withDeploymentCurrency({
          po_id: poId,
          po_number: poNumber,
          supplier_id: supplierId,
          supplier_code: supplier.code,
          supplier_name: supplier.name,
          supplier_external_id: await externalIdFor(db, 'supplier', supplierId),
          total_amount_cents: poTotal,
          issue_date: issueDate,
          status: 'issued',
          requisition_id: Number(requisition_id)
        })
      });

      created.push({
        poId,
        poNumber,
        supplier_id: supplierId,
        supplier_name: supplier.name,
        supplier_code: supplier.code,
        total_amount: poTotal,
        item_count: items.length
      });
    }

    await db.prepare(`
      UPDATE purchase_requisitions
      SET status = 'converted_to_po', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(requisition_id);

    const poSummary = created
      .map((po) => `${po.poNumber} (${po.supplier_name}, ${formatMoney(po.total_amount)})`)
      .join('; ');
    const convertAction = split ? 'SPLIT_CONVERTED_TO_PO' : 'CONVERTED_TO_PO';
    const convertSummary = split
      ? `Split converted to ${created.length} purchase orders: ${poSummary}`
      : `Converted to Purchase Order ${created[0].poNumber}`;
    const details = remapLabels.length > 0
      ? `${convertSummary}. Convert remaps: ${remapLabels.join('; ')}.`
      : convertSummary;
    await db.prepare(`
      INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
      VALUES ('requisition', ?, ?, ?, ?)
    `).run(
      requisition_id,
      convertAction,
      actorName,
      details
    );

    return created;
  });
  kickWebhookDispatch(db);
  return issued;
}

/**
 * One issued PO per awarded supplier.
 * Twenty suppliers do not fit in one interactive transaction: each PO is a
 * document number, an insert, its lines, an external-id read, an audit row,
 * and po.issued (6 prepared statements). The Turso client also sends
 * SELECT last_insert_rowid() with every INSERT, so a chunk of 3 suppliers
 * is 19 prepared statements and 31 pipeline statements. A chunk of 2 stays
 * at 13 prepared and 21 pipeline statements, both within the budget of 25.
 * The chunks are idempotent: a PO whose notes start with "RFQ " is unique
 * per requisition and supplier, and a retry inserts only the suppliers that
 * are still missing. The requisition is marked converted_to_po only when
 * every supplier has a PO.
 */
export const AWARD_PO_SUPPLIERS_PER_TRANSACTION = 2;

function awardPoNote(eventNumber, awardId, prNumber) {
  return `RFQ ${eventNumber}. Gunning ${awardId}. ${prNumber}.`;
}

async function loadAwardPurchaseOrders(db, awardId) {
  return db.prepare(`
    SELECT po.id, po.po_number, po.supplier_id, po.status, po.total_amount, po.requisition_id, po.award_id,
           s.name AS supplier_name, s.code AS supplier_code
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.award_id = ?
    ORDER BY po.id ASC
  `).all(awardId);
}

/** Awarded suppliers that do not have exactly one PO yet. "Done" means none. */
async function remainingAwardSuppliers(db, awardId) {
  const rows = await db.prepare(`
    SELECT al.supplier_id,
           (SELECT COUNT(*) FROM purchase_orders po
             WHERE po.award_id = ? AND po.supplier_id = al.supplier_id) AS po_count
    FROM (SELECT DISTINCT supplier_id FROM sourcing_award_lines WHERE award_id = ?) al
    ORDER BY al.supplier_id ASC
  `).all(awardId, awardId);
  return rows.filter((row) => Number(row.po_count) !== 1).map((row) => Number(row.supplier_id));
}

/** Wall-clock budget for one request. The UI calls again while `done` is false. */
export const AWARD_PO_TIME_BUDGET_MS = 10_000;

export async function issueAwardPurchaseOrders(db, {
  requisitionId,
  createdBy,
  actor,
  eventId,
  eventNumber,
  awardId,
  chunkSize = AWARD_PO_SUPPLIERS_PER_TRANSACTION,
  timeBudgetMs = AWARD_PO_TIME_BUDGET_MS,
  clock = () => Date.now()
} = {}) {
  const startedAt = clock();
  const pr = await db.prepare(`SELECT * FROM purchase_requisitions WHERE id = ?`).get(requisitionId);
  if (!pr) throw new PurchaseOrderError('Requisition not found', 404);
  if (pr.status !== 'approved' && pr.status !== 'converted_to_po') {
    throw new PurchaseOrderError('Requisition must be in "approved" state to generate a Purchase Order.');
  }
  const prItems = await loadRequisitionItems(db, requisitionId);
  if (!prItems.length) throw new PurchaseOrderError('Requisition has no items.');
  const { groups, unresolved } = groupItemsBySupplier(prItems);
  if (unresolved.length) {
    throw new PurchaseOrderError('Cannot convert requisition: a line has no supplier.');
  }
  const supplierIds = [...groups.keys()];
  const stillTodo = await remainingAwardSuppliers(db, awardId);
  if (!stillTodo.length) {
    return {
      purchase_orders: await loadAwardPurchaseOrders(db, awardId),
      replayed: true,
      done: true,
      remaining: []
    };
  }
  const suppliers = new Map();
  for (const supplierId of supplierIds) {
    const supplier = await loadSupplier(db, supplierId);
    if (!supplier || (supplier.status && supplier.status !== 'active')) {
      throw new PurchaseOrderError(
        `Cannot convert requisition: supplier ${supplier?.name || supplierId} is not active.`,
        400
      );
    }
    suppliers.set(supplierId, supplier);
  }

  const actorName = actor?.name || await actorNameFor(db, createdBy);
  const issueDate = new Date().toISOString().split('T')[0];
  const deliveryDate = pr.needed_by_date || new Date(Date.now() + 10 * 86400000).toISOString().split('T')[0];
  const shipTo = 'Acme HQ - Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701';
  const note = awardPoNote(eventNumber, awardId, pr.pr_number);
  const size = Math.max(1, Math.min(AWARD_PO_SUPPLIERS_PER_TRANSACTION, Number(chunkSize) || AWARD_PO_SUPPLIERS_PER_TRANSACTION));
  let createdThisCall = 0;
  const todo = supplierIds.filter((id) => stillTodo.includes(Number(id)));

  for (let offset = 0; offset < todo.length; offset += size) {
    if (offset > 0 && clock() - startedAt >= timeBudgetMs) break;
    const chunk = todo.slice(offset, offset + size);
    createdThisCall += await withBusyRetry(() => db.immediateTransaction(async () => {
      const present = await db.prepare(`
        SELECT supplier_id FROM purchase_orders
        WHERE award_id = ? AND supplier_id IN (${chunk.map(() => '?').join(', ')})
      `).all(awardId, ...chunk);
      const have = new Set(present.map((row) => Number(row.supplier_id)));
      let written = 0;
      const year = new Date().getFullYear();
      for (const supplierId of chunk) {
        if (have.has(Number(supplierId))) continue;
        const supplier = suppliers.get(supplierId);
        const items = groups.get(supplierId);
        const poTotal = items.reduce((sum, item) => sum + asCents(item.total_price), 0);
        const poNumber = await nextDocumentNumber(db, 'po', year);
        const inserted = await db.prepare(`
          INSERT INTO purchase_orders (
            po_number, requisition_id, supplier_id, created_by, status, total_amount,
            issue_date, expected_delivery_date, payment_terms, shipping_address, notes, award_id
          )
          SELECT ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM purchase_orders WHERE award_id = ? AND supplier_id = ?
          )
        `).run(
          poNumber,
          requisitionId,
          supplierId,
          createdBy,
          poTotal,
          issueDate,
          deliveryDate,
          supplier.payment_terms || 'Net 30',
          shipTo,
          note,
          awardId,
          awardId,
          supplierId
        );
        if (!inserted.changes) continue;
        let poId = Number(inserted.lastInsertRowid);
        if (!poId) {
          const row = await db.prepare(`
            SELECT id FROM purchase_orders WHERE po_number = ?
          `).get(poNumber);
          poId = Number(row?.id || 0);
        }
        if (!poId) throw new PurchaseOrderError('Failed to allocate purchase order id', 500);
        const columns = [
          'po_id', 'requisition_item_id', 'item_description', 'category', 'quantity',
          'unit_price', 'total_price', 'quantity_received', 'quantity_accepted', 'quantity_invoiced',
          'line_type', 'service_basis'
        ];
        const values = items.map((item) => {
          const lineType = normalizeLineType(item.line_type, item.category);
          return [
            poId,
            item.id,
            item.item_description,
            item.category,
            item.quantity,
            item.unit_price,
            item.total_price,
            0,
            0,
            0,
            lineType,
            resolveServiceBasis(item.service_basis, lineType)
          ];
        });
        const tuples = values.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
        await db.prepare(`
          INSERT INTO po_items (${columns.join(', ')}) VALUES ${tuples}
        `).run(...values.flat());
        await db.prepare(`
          INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
          VALUES ('purchase_order', ?, 'ISSUED', ?, ?)
        `).run(poId, actorName, `PO ${poNumber} issued from PR ${pr.pr_number} to ${supplier.name}`);
        await enqueueWebhook(db, {
          eventType: WEBHOOK_EVENTS.PO_ISSUED,
          entityType: 'purchase_order',
          entityId: poId,
          data: withDeploymentCurrency({
            po_id: poId,
            po_number: poNumber,
            supplier_id: supplierId,
            supplier_code: supplier.code,
            supplier_name: supplier.name,
            supplier_external_id: await externalIdFor(db, 'supplier', supplierId),
            total_amount_cents: poTotal,
            issue_date: issueDate,
            status: 'issued',
            requisition_id: Number(requisitionId),
            event_number: eventNumber,
            award_id: Number(awardId)
          })
        });
        written += 1;
      }
      return written;
    }));
  }

  const purchaseOrders = await loadAwardPurchaseOrders(db, awardId);
  const remaining = await remainingAwardSuppliers(db, awardId);
  const complete = remaining.length === 0;
  if (complete && pr.status === 'approved') {
    await withBusyRetry(() => db.immediateTransaction(async () => {
      const marked = await db.prepare(`
        UPDATE purchase_requisitions
        SET status = 'converted_to_po', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'approved'
      `).run(requisitionId);
      if (!marked.changes) return 0;
      const summary = purchaseOrders
        .map((po) => `${po.po_number} (${po.supplier_name}, ${formatMoney(po.total_amount)})`)
        .join('; ');
      await db.prepare(`
        INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details)
        VALUES ('requisition', ?, ?, ?, ?)
      `).run(
        requisitionId,
        purchaseOrders.length > 1 ? 'SPLIT_CONVERTED_TO_PO' : 'CONVERTED_TO_PO',
        actorName,
        `Award ${eventNumber} converted to ${purchaseOrders.length} purchase order(s): ${summary}`
      );
      await appendComplianceEvent(db, {
        ...actorFromSession({ id: createdBy, name: actorName, role: actor?.role || null }),
        action: 'SOURCING_PURCHASE_ORDERS_CREATED',
        entity_type: 'sourcing_event',
        entity_id: eventId,
        details: JSON.stringify({
          event_number: eventNumber,
          award_id: Number(awardId),
          pr_number: pr.pr_number,
          po_numbers: purchaseOrders.map((po) => po.po_number)
        })
      });
      await enqueueWebhook(db, {
        eventType: WEBHOOK_EVENTS.SOURCING_EVENT_PURCHASE_ORDERS_CREATED,
        entityType: 'sourcing_event',
        entityId: eventId,
        data: {
          event_number: eventNumber,
          award_id: Number(awardId),
          pr_number: pr.pr_number,
          purchase_orders: purchaseOrders.map((po) => ({
            po_id: Number(po.id),
            po_number: po.po_number,
            supplier_id: Number(po.supplier_id),
            total_amount_cents: Number(po.total_amount)
          }))
        }
      });
      return 1;
    }));
  }

  kickWebhookDispatch(db);
  return {
    purchase_orders: await loadAwardPurchaseOrders(db, awardId),
    replayed: createdThisCall === 0,
    done: complete,
    remaining
  };
}
