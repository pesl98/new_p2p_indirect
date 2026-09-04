-- Schema for Non-Production Procurement Application

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('requester', 'approver', 'procurement', 'finance', 'admin')),
  department_id INTEGER,
  title TEXT,
  approval_limit REAL DEFAULT 0,
  avatar TEXT,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL,
  fiscal_year INTEGER NOT NULL,
  total_budget REAL NOT NULL,
  committed_amount REAL DEFAULT 0,
  actual_spent REAL DEFAULT 0,
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
  unit_price REAL NOT NULL,
  preferred_supplier_id INTEGER,
  lead_time_days INTEGER DEFAULT 3,
  image_url TEXT,
  FOREIGN KEY (preferred_supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number TEXT UNIQUE NOT NULL,
  requester_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'converted_to_po')),
  total_amount REAL DEFAULT 0,
  justification TEXT,
  needed_by_date TEXT,
  priority TEXT DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
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
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  estimated_supplier_id INTEGER,
  FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  FOREIGN KEY (catalog_item_id) REFERENCES catalog_items(id),
  FOREIGN KEY (estimated_supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL,
  approver_id INTEGER NOT NULL,
  step_order INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  comments TEXT,
  decided_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
  FOREIGN KEY (approver_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT UNIQUE NOT NULL,
  requisition_id INTEGER,
  supplier_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  status TEXT DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'acknowledged', 'partially_received', 'received', 'closed', 'cancelled')),
  total_amount REAL NOT NULL,
  issue_date TEXT NOT NULL,
  expected_delivery_date TEXT,
  payment_terms TEXT DEFAULT 'Net 30',
  shipping_address TEXT,
  notes TEXT,
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
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  quantity_received REAL DEFAULT 0,
  quantity_invoiced REAL DEFAULT 0,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (requisition_item_id) REFERENCES requisition_items(id)
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
  quantity_received REAL NOT NULL,
  condition TEXT DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'partial', 'incorrect_item')),
  comments TEXT,
  FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  po_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  subtotal REAL NOT NULL,
  tax_amount REAL DEFAULT 0,
  total_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending_match' CHECK (status IN ('pending_match', 'matched', 'variance_flagged', 'approved_for_payment', 'paid', 'rejected')),
  match_status TEXT DEFAULT 'pending' CHECK (match_status IN ('pending', 'perfect_match', 'tolerated_match', 'quantity_variance', 'price_variance', 'total_variance')),
  payment_reference TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity_invoiced REAL NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
);

CREATE TABLE IF NOT EXISTS match_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  po_id INTEGER NOT NULL,
  po_item_id INTEGER,
  ordered_qty REAL,
  received_qty REAL,
  invoiced_qty REAL,
  po_unit_price REAL,
  invoice_unit_price REAL,
  qty_variance REAL,
  price_variance REAL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warning', 'fail')),
  message TEXT,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (po_item_id) REFERENCES po_items(id)
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
