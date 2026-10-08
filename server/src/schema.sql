-- Schema for Non-Production Procurement Application
-- Money columns are INTEGER cents (minor units of the deployment currency, default EUR).
-- EUR and USD both use 2 decimal places, so the integer scale does not change.
-- Discrete quantities (goods, services, consignment) are INTEGER whole units.
-- Metered utilities and vendor-managed bulk store measured qty as milli-units
-- (quantity_scale = 1000). Line amount is round(milli × unit_price / 1000).
-- Service lines may set service_basis (lump_sum | hours | days). Goods lines leave it NULL.
-- Hours/days quantity is whole hours or days; lump_sum quantity is whole occurrences.
-- Line total for whole units is quantity × unit_price in integer cents.
-- Consignment stock is supplier-owned on-hand (consignment_balances). It is not a GRN.
-- A discrete draw-down sets po_items.receipt_basis = 'consignment' and quantity_consumed.
-- purchase_orders.order_source = 'consignment' marks that payable. Owned goods stay order_source 'standard'.
-- Utility and bulk payables keep order_source 'standard' and receipt_basis 'grn' (those CHECKs
-- are not the measured path). settlement_kind is 'utility' or 'bulk', quantity_consumed is milli-units.

-- Step-1 department head lives on departments.approver_user_id (nullable users.id).
-- Not a SQLite FK because departments is created before users.
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  approver_user_id INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('requester', 'approver', 'procurement', 'finance', 'admin')),
  department_id INTEGER,
  title TEXT,
  approval_limit INTEGER DEFAULT 0,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

-- Password hashes live here, never on users and never in API responses.
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL,
  fiscal_year INTEGER NOT NULL,
  total_budget INTEGER NOT NULL,
  committed_amount INTEGER DEFAULT 0,
  actual_spent INTEGER DEFAULT 0,
  UNIQUE(department_id, fiscal_year),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  contact_person TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  payment_terms TEXT DEFAULT 'Net 30',
  rating REAL DEFAULT 5.0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'under_review'))
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('IT Hardware', 'Software & Cloud', 'Office Supplies', 'Facilities & MRO', 'Consulting & Professional Services', 'Marketing & Events', 'Travel & Subscriptions')),
  unit TEXT DEFAULT 'each',
  unit_price INTEGER NOT NULL,
  preferred_supplier_id INTEGER,
  lead_time_days INTEGER DEFAULT 3,
  image_url TEXT,
  line_type TEXT NOT NULL DEFAULT 'goods' CHECK (line_type IN ('goods', 'service')),
  service_basis TEXT CHECK (service_basis IS NULL OR service_basis IN ('lump_sum', 'hours', 'days')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  FOREIGN KEY (preferred_supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number TEXT UNIQUE NOT NULL,
  requester_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'converted_to_po')),
  total_amount INTEGER DEFAULT 0,
  justification TEXT,
  needed_by_date TEXT,
  priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
  -- Nullable pointer at contracts.id. Not a SQLite FK: contracts is created later.
  source_contract_id INTEGER,
  -- none = no link yet (submit may still auto-match). skipped = requester opted out; do not rematch.
  -- proposed = auto/explicit/renewal assignment awaiting approver.
  -- allowed / refused are the approver's contract-use decision (PR may still be approved).
  contract_use_status TEXT NOT NULL DEFAULT 'none' CHECK (contract_use_status IN ('none', 'proposed', 'allowed', 'refused', 'skipped')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requester_id) REFERENCES users(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS requisition_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL,
  catalog_item_id INTEGER,
  item_description TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  estimated_supplier_id INTEGER,
  line_type TEXT NOT NULL DEFAULT 'goods' CHECK (line_type IN ('goods', 'service')),
  service_basis TEXT CHECK (service_basis IS NULL OR service_basis IN ('lump_sum', 'hours', 'days')),
  FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (estimated_supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL,
  approver_id INTEGER NOT NULL,
  step_order INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'waiting', 'approved', 'rejected', 'skipped')),
  comments TEXT,
  decided_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  FOREIGN KEY (approver_id) REFERENCES users(id)
);

-- Out-of-office substitute approver. Resolve at list/decide time
-- do not rewrite approval_requests.approver_id when a delegation is created.
-- Soft-revoke via active=0. starts_at / ends_at are ISO timestamps (NULL = open).
CREATE TABLE IF NOT EXISTS approval_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegator_user_id INTEGER NOT NULL,
  delegate_user_id INTEGER NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  reason TEXT,
  created_by_user_id INTEGER,
  created_by_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  revoked_by_user_id INTEGER,
  revoked_by_name TEXT,
  FOREIGN KEY (delegator_user_id) REFERENCES users(id),
  FOREIGN KEY (delegate_user_id) REFERENCES users(id),
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (revoked_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT UNIQUE NOT NULL,
  requisition_id INTEGER,
  supplier_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  status TEXT DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'acknowledged', 'partially_received', 'received', 'closed', 'cancelled')),
  total_amount INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  expected_delivery_date TEXT,
  payment_terms TEXT DEFAULT 'Net 30',
  shipping_address TEXT,
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  change_order_count INTEGER NOT NULL DEFAULT 0,
  -- standard = buyer-owned PO (GRN or SES). consignment = discrete draw-down of supplier-owned stock.
  order_source TEXT NOT NULL DEFAULT 'standard' CHECK (order_source IN ('standard', 'consignment')),
  -- purchase = owned goods/services, or discrete consignment (see order_source).
  -- utility / bulk = measured consumption payable. Not a GRN and not discrete consignment.
  settlement_kind TEXT NOT NULL DEFAULT 'purchase' CHECK (settlement_kind IN ('purchase', 'utility', 'bulk')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL,
  requisition_item_id INTEGER,
  item_description TEXT NOT NULL,
  category TEXT,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  quantity_received INTEGER DEFAULT 0,
  quantity_accepted INTEGER DEFAULT 0,
  -- Draw-down qty for receipt_basis = 'consignment'. Owned goods leave this at 0 and use GRN.
  quantity_consumed INTEGER NOT NULL DEFAULT 0,
  quantity_invoiced INTEGER DEFAULT 0,
  line_type TEXT NOT NULL DEFAULT 'goods' CHECK (line_type IN ('goods', 'service')),
  receipt_basis TEXT NOT NULL DEFAULT 'grn' CHECK (receipt_basis IN ('grn', 'consignment')),
  service_basis TEXT CHECK (service_basis IS NULL OR service_basis IN ('lump_sum', 'hours', 'days')),
  -- 1 = whole units. 1000 = milli-units of unit_of_measure (utility and bulk only).
  quantity_scale INTEGER NOT NULL DEFAULT 1 CHECK (quantity_scale IN (1, 1000)),
  unit_of_measure TEXT,
  settlement_kind TEXT NOT NULL DEFAULT 'purchase' CHECK (settlement_kind IN ('purchase', 'utility', 'bulk')),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (requisition_item_id) REFERENCES requisition_items(id)
);

-- Formal PO amendments. Apply-on-confirm (status usually 'applied').
-- Numbered CO-YYYY-NNN. revision is 1-based per PO (PO header revision tracks last applied).
CREATE TABLE IF NOT EXISTS po_change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL,
  co_number TEXT UNIQUE NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('draft', 'applied')),
  reason TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  notes TEXT,
  before_total_cents INTEGER NOT NULL,
  after_total_cents INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,
  UNIQUE(po_id, revision),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
);

CREATE TABLE IF NOT EXISTS po_change_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_order_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  old_quantity INTEGER NOT NULL,
  new_quantity INTEGER NOT NULL,
  old_unit_price INTEGER NOT NULL,
  new_unit_price INTEGER NOT NULL,
  notes TEXT,
  FOREIGN KEY (change_order_id) REFERENCES po_change_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_number TEXT UNIQUE NOT NULL,
  po_id INTEGER NOT NULL,
  received_by INTEGER NOT NULL,
  receipt_date TEXT NOT NULL,
  carrier_tracking TEXT,
  delivery_note_number TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (received_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goods_receipt_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  quantity_received INTEGER NOT NULL,
  condition TEXT DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'partial', 'incorrect_item')),
  comments TEXT,
  FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS service_entry_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ses_number TEXT UNIQUE NOT NULL,
  po_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'accepted', 'rejected')),
  service_period_start TEXT,
  service_period_end TEXT,
  notes TEXT,
  decided_by INTEGER,
  decided_at DATETIME,
  decision_comments TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (decided_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS service_entry_sheet_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ses_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  quantity_accepted INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  comments TEXT,
  FOREIGN KEY (ses_id) REFERENCES service_entry_sheets(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  po_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  tax_amount INTEGER DEFAULT 0,
  total_amount INTEGER NOT NULL,
  -- NULL = pay billed total_amount. Set by short_pay; billed total is never rewritten.
  payable_total_cents INTEGER,
  -- clear = no open suspect. suspect blocks approve/pay until AP disposes.
  -- confirmed_unique clears the block. confirmed_duplicate voids this invoice.
  duplicate_status TEXT NOT NULL DEFAULT 'clear' CHECK (duplicate_status IN ('clear', 'suspect', 'confirmed_unique', 'confirmed_duplicate')),
  status TEXT DEFAULT 'pending_match' CHECK (status IN ('pending_match', 'matched', 'variance_flagged', 'approved_for_payment', 'paid', 'rejected')),
  match_status TEXT DEFAULT 'pending' CHECK (match_status IN ('pending', 'perfect_match', 'tolerated_match', 'quantity_variance', 'price_variance', 'total_variance')),
  payment_reference TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, invoice_number),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity_invoiced INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS match_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  po_id INTEGER NOT NULL,
  po_item_id INTEGER,
  ordered_qty INTEGER,
  received_qty INTEGER,
  invoiced_qty INTEGER,
  po_unit_price INTEGER,
  invoice_unit_price INTEGER,
  qty_variance INTEGER,
  price_variance INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warning', 'fail')),
  message TEXT,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

-- Likely-duplicate AP control (soft hold). Hard uniqueness remains
-- UNIQUE(supplier_id, invoice_number) on invoices. One row per candidate.
CREATE TABLE IF NOT EXISTS invoice_duplicate_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  candidate_invoice_id INTEGER NOT NULL,
  match_rule TEXT NOT NULL CHECK (match_rule IN ('same_amount_near_date', 'same_po_same_amount', 'both')),
  billed_total_cents INTEGER NOT NULL,
  candidate_billed_total_cents INTEGER NOT NULL,
  invoice_date TEXT NOT NULL,
  candidate_invoice_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed_unique', 'confirmed_duplicate')),
  reason TEXT,
  actor_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_invoice_id) REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS invoice_exception_dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('accept_variance', 'reject_invoice', 'return_to_buyer', 'short_pay', 'buyer_response')),
  reason TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  -- For accept_variance: billed total. For short_pay: payable amount AP will pay.
  accepted_total_cents INTEGER,
  accepted_match_status TEXT,
  billed_total_cents INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Software & Cloud', 'Consulting & Professional Services', 'Facilities & MRO', 'Office Supplies', 'Marketing & Events', 'Travel & Subscriptions', 'IT Hardware')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notice_period_days INTEGER DEFAULT 30,
  annual_value_cents INTEGER NOT NULL,
  auto_renew INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expiring_soon', 'expired', 'cancelled')),
  terms TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS contract_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  catalog_item_id INTEGER,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  total_price INTEGER NOT NULL,
  line_type TEXT NOT NULL DEFAULT 'service' CHECK (line_type IN ('goods', 'service')),
  service_basis TEXT CHECK (service_basis IS NULL OR service_basis IN ('lump_sum', 'hours', 'days')),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
);

-- Coupa/Ariba-style AP payment proposal (batch ACH). Draft → execute once.
-- Execute reuses mark-paid (status paid + shared payment_reference + PAID audit).
-- Budget actuals are posted at Approve for Payment, not here — do not double-post.
CREATE TABLE IF NOT EXISTS payment_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'executed', 'cancelled')),
  payment_date TEXT,
  payment_reference TEXT,
  actor_name TEXT NOT NULL,
  billed_total_cents INTEGER NOT NULL DEFAULT 0,
  payable_total_cents INTEGER NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME,
  cancelled_at DATETIME
);

CREATE TABLE IF NOT EXISTS payment_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  billed_total_cents INTEGER NOT NULL,
  payable_total_cents INTEGER NOT NULL,
  UNIQUE(run_id, invoice_id),
  FOREIGN KEY (run_id) REFERENCES payment_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

-- Supplier-owned inventory at the buyer site. Not company-owned stock and not a GRN.
-- location_label is free text: ProcureFlow has no location / warehouse master.
CREATE TABLE IF NOT EXISTS consignment_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  location_label TEXT NOT NULL DEFAULT 'Buyer site',
  quantity_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  unit_price INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, catalog_item_id, location_label),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id)
);

-- Inward consignment. Increases on-hand only. Does not insert goods_receipts or a PO.
CREATE TABLE IF NOT EXISTS consignment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT UNIQUE NOT NULL,
  balance_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  location_label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL,
  received_by INTEGER NOT NULL,
  receipt_date TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (balance_id) REFERENCES consignment_balances(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (received_by) REFERENCES users(id)
);

-- Consumption into company use. Decrements on-hand and opens a consignment PO for AP.
-- Does not post a GRN and does not increment po_items.quantity_received.
CREATE TABLE IF NOT EXISTS consignment_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number TEXT UNIQUE NOT NULL,
  balance_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  location_label TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  po_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  issued_by INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (balance_id) REFERENCES consignment_balances(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (po_item_id) REFERENCES po_items(id),
  FOREIGN KEY (issued_by) REFERENCES users(id)
);

-- Ongoing metered supply (water, electricity, gas). Not a goods PO and not consignment stock.
CREATE TABLE IF NOT EXISTS utility_arrangements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arrangement_number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  utility_type TEXT NOT NULL CHECK (utility_type IN ('water', 'electricity', 'gas')),
  name TEXT NOT NULL,
  meter_label TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- One measured billing period. Opens a utility payable. Does not insert goods_receipts.
-- Quantities are milli-units of unit_of_measure (scale 1000).
CREATE TABLE IF NOT EXISTS utility_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumption_number TEXT UNIQUE NOT NULL,
  arrangement_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  reading_previous_milli INTEGER,
  reading_current_milli INTEGER,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_of_measure TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  po_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  recorded_by INTEGER NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (arrangement_id) REFERENCES utility_arrangements(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (po_item_id) REFERENCES po_items(id),
  FOREIGN KEY (recorded_by) REFERENCES users(id)
);

-- Vendor-managed container or silo. A real holding location, not a free-text note.
-- Level and capacity are milli-units. Stock stays supplier-owned until drawn.
CREATE TABLE IF NOT EXISTS bulk_containers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_number TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  vessel_type TEXT NOT NULL CHECK (vessel_type IN ('container', 'silo')),
  unit_of_measure TEXT NOT NULL,
  capacity_milli INTEGER NOT NULL CHECK (capacity_milli > 0),
  level_milli INTEGER NOT NULL DEFAULT 0 CHECK (level_milli >= 0),
  unit_price INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(supplier_id, name),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  CHECK (level_milli <= capacity_milli)
);

-- Inward fill. Increases measured level only. Does not insert goods_receipts or a PO.
CREATE TABLE IF NOT EXISTS bulk_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_number TEXT UNIQUE NOT NULL,
  container_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_of_measure TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  level_after_milli INTEGER NOT NULL,
  filled_by INTEGER NOT NULL,
  fill_date TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (container_id) REFERENCES bulk_containers(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (filled_by) REFERENCES users(id)
);

-- Measured draw into company use. Decrements level and opens a bulk payable. No GRN.
CREATE TABLE IF NOT EXISTS bulk_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_number TEXT UNIQUE NOT NULL,
  container_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_of_measure TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  level_after_milli INTEGER NOT NULL,
  po_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  drawn_by INTEGER NOT NULL,
  draw_date TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (container_id) REFERENCES bulk_containers(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (po_item_id) REFERENCES po_items(id),
  FOREIGN KEY (drawn_by) REFERENCES users(id)
);

-- One row per customer database. IdP secrets stay in the environment.
-- sso_provisioning defaults off: unknown IdP users are rejected.
-- sso_default_role is the least-privilege role used only when an admin enables provisioning.
CREATE TABLE IF NOT EXISTS tenant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sso_provisioning INTEGER NOT NULL DEFAULT 0 CHECK (sso_provisioning IN (0, 1)),
  sso_default_role TEXT NOT NULL DEFAULT 'requester'
    CHECK (sso_default_role IN ('requester', 'approver', 'procurement', 'finance', 'admin'))
);

INSERT OR IGNORE INTO tenant_settings (id, sso_provisioning, sso_default_role)
VALUES (1, 0, 'requester');

-- IdP subject → local users.id. Role is never copied from an IdP claim.
CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('oidc', 'saml')),
  subject TEXT NOT NULL,
  email TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, subject),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Single-use OIDC state / SAML AuthnRequest id. Deleted when the attempt finishes.
CREATE TABLE IF NOT EXISTS sso_requests (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('oidc', 'saml')),
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Append-only replay guard. Triggers reject UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS sso_assertion_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('oidc', 'saml')),
  assertion_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, assertion_id)
);

-- Append-only SSO evidence. Triggers reject UPDATE and DELETE.
-- Local password login is not stored here (provider is oidc|saml only).
-- Compliance reports read this table; they do not copy the rows.
CREATE TABLE IF NOT EXISTS sso_login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('oidc', 'saml')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  subject TEXT,
  email TEXT,
  user_id INTEGER,
  reason TEXT,
  assertion_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Events that audit_logs and the SSO tables do not already store:
-- local login/logout/failure, bootstrap, user and role changes, SSO setting
-- changes, just-in-time user create, and compliance CSV exports.
-- prev_hash is the literal GENESIS on the first row, otherwise the previous
-- row_hash. row_hash is SHA-256 hex of prev_hash + canonical JSON, computed
-- in the server (SQLite/Turso have no portable SHA-256). Triggers reject
-- UPDATE/DELETE, a missing 64-char row_hash, and a prev_hash that does not
-- link to the previous row. P2P decisions stay in audit_logs; SSO stays in
-- sso_login_events and sso_assertion_uses.
CREATE TABLE IF NOT EXISTS compliance_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER,
  actor_name TEXT NOT NULL,
  actor_role TEXT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS compliance_audit_events_created_at
  ON compliance_audit_events (created_at);

CREATE INDEX IF NOT EXISTS compliance_audit_events_action
  ON compliance_audit_events (action);

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS sso_login_events_no_update
BEFORE UPDATE ON sso_login_events
BEGIN
  SELECT RAISE(ABORT, 'sso_login_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS sso_login_events_no_delete
BEFORE DELETE ON sso_login_events
BEGIN
  SELECT RAISE(ABORT, 'sso_login_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS sso_assertion_uses_no_update
BEFORE UPDATE ON sso_assertion_uses
BEGIN
  SELECT RAISE(ABORT, 'sso_assertion_uses is append-only');
END;

CREATE TRIGGER IF NOT EXISTS sso_assertion_uses_no_delete
BEFORE DELETE ON sso_assertion_uses
BEGIN
  SELECT RAISE(ABORT, 'sso_assertion_uses is append-only');
END;

CREATE TRIGGER IF NOT EXISTS compliance_audit_events_no_update
BEFORE UPDATE ON compliance_audit_events
BEGIN
  SELECT RAISE(ABORT, 'compliance_audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS compliance_audit_events_no_delete
BEFORE DELETE ON compliance_audit_events
BEGIN
  SELECT RAISE(ABORT, 'compliance_audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS compliance_audit_events_hash_required
BEFORE INSERT ON compliance_audit_events
WHEN NEW.row_hash IS NULL OR length(NEW.row_hash) != 64
BEGIN
  SELECT RAISE(ABORT, 'compliance audit row_hash is required');
END;

CREATE TRIGGER IF NOT EXISTS compliance_audit_events_chain
BEFORE INSERT ON compliance_audit_events
WHEN NEW.prev_hash IS NOT (
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM compliance_audit_events) THEN 'GENESIS'
    ELSE (SELECT row_hash FROM compliance_audit_events ORDER BY id DESC LIMIT 1)
  END
)
BEGIN
  SELECT RAISE(ABORT, 'compliance audit chain prev_hash mismatch');
END;

-- Sprint 4 integrations. One database per customer, so these rows are that
-- customer's keys and outbox — there is no org_id. The plaintext API key is
-- never stored; key_hash is SHA-256 hex. Webhook signing secrets stay in the
-- environment (WEBHOOK_SIGNING_SECRET), not in a table.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute >= 1),
  created_by_user_id INTEGER NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS api_key_rate_windows (
  api_key_id INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, window_start),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

-- External ERP id → local supplier or catalog row.
-- Invoice external ids live in integration_invoice_links so an existing
-- database can gain them with CREATE TABLE IF NOT EXISTS. Do not rebuild
-- this table: a failed statement on Turso does not stop the rest of the batch.
CREATE TABLE IF NOT EXISTS integration_entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('supplier', 'catalog_item')),
  external_id TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(entity_type, external_id)
);

CREATE TABLE IF NOT EXISTS integration_invoice_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(api_key_id, idempotency_key),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

-- Durable outbound webhooks. status pending retries until delivered or dead.
-- Signing happens at send time so a retry gets a fresh timestamp.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  last_attempt_at TEXT,
  delivered_at TEXT,
  dead_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_outbox_pending
  ON webhook_outbox (status, next_attempt_at);

