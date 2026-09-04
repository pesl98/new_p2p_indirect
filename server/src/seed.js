import db from './db.js';

console.log('🌱 Seeding Non-Production Procurement Database...');

// Clear existing tables in reverse dependency order
const clearTables = [
  'match_results',
  'invoice_items',
  'invoices',
  'goods_receipt_items',
  'goods_receipts',
  'po_items',
  'purchase_orders',
  'approval_requests',
  'requisition_items',
  'purchase_requisitions',
  'catalog_items',
  'suppliers',
  'budgets',
  'users',
  'departments',
  'audit_logs'
];

db.transaction(() => {
  for (const table of clearTables) {
    db.prepare(`DELETE FROM ${table}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
  }

  // 1. Departments
  const insertDept = db.prepare(`INSERT INTO departments (id, code, name) VALUES (?, ?, ?)`);
  insertDept.run(1, 'MKT', 'Marketing & Brand');
  insertDept.run(2, 'ITE', 'IT & Digital Infrastructure');
  insertDept.run(3, 'FAC', 'Facilities & Operations');
  insertDept.run(4, 'HRP', 'Human Resources & Talent');
  insertDept.run(5, 'ADM', 'Finance & Administration');

  // 2. Users
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, approval_limit, avatar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(1, 'Alice Chen', 'alice.chen@company.com', 'requester', 1, 'Brand Marketing Specialist', 0, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&h=120&fit=crop&crop=faces');
  insertUser.run(2, 'Bob Martinez', 'bob.martinez@company.com', 'approver', 1, 'VP of Marketing', 10000, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=120&fit=crop&crop=faces');
  insertUser.run(3, 'Carol Zhang', 'carol.zhang@company.com', 'procurement', 3, 'Head of Strategic Sourcing', 50000, 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&h=120&fit=crop&crop=faces');
  insertUser.run(4, 'David Miller', 'david.miller@company.com', 'finance', 5, 'Accounts Payable & Financial Controller', 150000, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&h=120&fit=crop&crop=faces');
  insertUser.run(5, 'Elena Rostova', 'elena.rostova@company.com', 'admin', 5, 'Chief Financial Officer (CFO)', 500000, 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=120&h=120&fit=crop&crop=faces');

  // 3. Budgets (Fiscal Year 2026)
  const insertBudget = db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertBudget.run(1, 2026, 150000, 15480, 24350); // MKT
  insertBudget.run(2, 2026, 320000, 48200, 89100); // ITE
  insertBudget.run(3, 2026, 95000, 12300, 18450);  // FAC
  insertBudget.run(4, 2026, 60000, 4500, 11200);   // HRP
  insertBudget.run(5, 2026, 50000, 3200, 8900);    // ADM

  // 4. Suppliers
  const insertSupplier = db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, phone, address, payment_terms, rating, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSupplier.run(1, 'TechSupply Global', 'SUP-TSG', 'Marcus Vance', 'enterprise@techsupply.com', '+1 (555) 234-5678', '100 Silicon Way, San Jose, CA', 'Net 30', 4.9, 'active');
  insertSupplier.run(2, 'CloudCore Software LLC', 'SUP-CCS', 'Sarah Connor', 'billing@cloudcore.io', '+1 (555) 876-5432', '500 Cloud Vista Blvd, Seattle, WA', 'Net 30', 4.8, 'active');
  insertSupplier.run(3, 'WorkSpace Ergonomics Depot', 'SUP-WED', 'Arthur Pendelton', 'b2b@workspacedepot.com', '+1 (555) 345-6789', '25 Industrial Parkway, Grand Rapids, MI', 'Net 45', 4.7, 'active');
  insertSupplier.run(4, 'FacilityCare & Janitorial Pro', 'SUP-FCJ', 'Maria Gonzalez', 'orders@facilitycare.com', '+1 (555) 901-2345', '77 Commerce Rd, Chicago, IL', 'Net 30', 4.6, 'active');
  insertSupplier.run(5, 'Apex Advisory & Digital', 'SUP-AAD', 'Dr. Liam Sterling', 'engagements@apexadvisory.com', '+1 (555) 432-1098', '350 Park Avenue, New York, NY', 'Net 60', 5.0, 'active');
  insertSupplier.run(6, 'FastTrack Express Freight', 'SUP-FEF', 'Tim O’Brian', 'dispatch@fasttracklogistics.com', '+1 (555) 678-9012', '12 Airport Loop, Dallas, TX', 'Net 15', 4.5, 'active');

  // 5. Non-Production Catalog Items
  const insertCatalog = db.prepare(`
    INSERT INTO catalog_items (sku, name, description, category, unit, unit_price, preferred_supplier_id, lead_time_days, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  // IT Hardware
  insertCatalog.run('SKU-HW-001', 'Apple MacBook Pro 16" (M3 Max / 36GB / 1TB)', 'High-performance engineering & design workstation laptop', 'IT Hardware', 'each', 3499.00, 1, 3, '💻');
  insertCatalog.run('SKU-HW-002', 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'Color-accurate IPS Black monitor with integrated hub', 'IT Hardware', 'each', 749.00, 1, 2, '🖥️');
  insertCatalog.run('SKU-HW-003', 'Logitech MX Master 3S Wireless Mouse', 'Ergonomic performance mouse with quiet clicks and 8K DPI', 'IT Hardware', 'each', 99.00, 1, 1, '🖱️');
  insertCatalog.run('SKU-HW-004', 'CalDigit TS4 Thunderbolt 4 Docking Station', '18-port expansion dock with 98W host charging', 'IT Hardware', 'each', 399.00, 1, 2, '🔌');
  
  // Software & Cloud
  insertCatalog.run('SKU-SW-001', 'Figma Organization Annual User License', 'Collaborative interface design & prototyping enterprise seat', 'Software & Cloud', 'license/yr', 540.00, 2, 1, '🎨');
  insertCatalog.run('SKU-SW-002', 'Slack Enterprise Grid Annual Subscription', 'Internal team communications and enterprise automation', 'Software & Cloud', 'user/yr', 180.00, 2, 1, '💬');
  insertCatalog.run('SKU-SW-003', 'GitHub Enterprise Cloud Seat', 'Source code hosting, CI/CD Actions, and enterprise security', 'Software & Cloud', 'seat/yr', 252.00, 2, 1, '🐙');
  insertCatalog.run('SKU-SW-004', '1Password Business Password Manager', 'Secure password vaulting for company employees', 'Software & Cloud', 'user/yr', 96.00, 2, 1, '🔐');

  // Office Supplies & Ergonomics
  insertCatalog.run('SKU-OFF-001', 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Fully adjustable mesh task chair with PostureFit SL', 'Office Supplies', 'each', 1295.00, 3, 7, '🪑');
  insertCatalog.run('SKU-OFF-002', 'Jarvis Dual-Motor Electric Standing Desk (60"x30")', 'Solid bamboo height-adjustable workstation with memory handset', 'Office Supplies', 'each', 699.00, 3, 5, '🪵');
  insertCatalog.run('SKU-OFF-003', 'Mobile Magnetic Porcelain Whiteboard (72" x 48")', 'Double-sided rolling presentation board with locking casters', 'Office Supplies', 'each', 349.00, 3, 4, '📋');
  insertCatalog.run('SKU-OFF-004', 'Hammermill 100% Recycled Copy Paper (Case of 10 Reams)', 'Acid-free premium 20lb white copy paper for daily printing', 'Office Supplies', 'case', 58.00, 3, 2, '📄');
  insertCatalog.run('SKU-OFF-005', 'Artisan Single-Origin Espresso Beans (5 lb Bag)', 'Locally roasted whole bean coffee for office kitchen', 'Office Supplies', 'bag', 72.00, 3, 2, '☕');

  // Facilities & MRO
  insertCatalog.run('SKU-FAC-001', 'Blueair Pro XL Commercial HEPA Air Purifier', 'Commercial grade air filtration for meeting rooms and open spaces', 'Facilities & MRO', 'each', 890.00, 4, 3, '💨');
  insertCatalog.run('SKU-FAC-002', 'OSHA 4-Shelf Industrial First Aid Station', 'Compliant wall-mounted emergency medical care unit', 'Facilities & MRO', 'kit', 210.00, 4, 2, '🩹');
  insertCatalog.run('SKU-FAC-003', 'Commercial Touchless Sanitizer & Dispenser Stand', 'Floor-standing automatic sensor sanitizer station', 'Facilities & MRO', 'set', 145.00, 4, 2, '🧴');

  // Consulting & Professional Services
  insertCatalog.run('SKU-SRV-001', 'Enterprise UX Audit & Design System Sprint', 'Two-week dedicated product design sprint and component audit', 'Consulting & Professional Services', 'sprint', 8500.00, 5, 14, '📐');
  insertCatalog.run('SKU-SRV-002', 'SOC 2 Type II Annual Security Penetration Test', 'Full external threat simulation, vulnerability assessment, and report', 'Consulting & Professional Services', 'engagement', 12500.00, 5, 21, '🛡️');
  insertCatalog.run('SKU-SRV-003', 'Executive Team Coaching & Alignment Workshop', 'Two-day facilitator-led offsite strategy alignment workshop', 'Consulting & Professional Services', 'event', 6200.00, 5, 10, '👥');

  // 6. Purchase Requisitions & Items
  const insertPR = db.prepare(`
    INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  const insertPRItem = db.prepare(`
    INSERT INTO requisition_items (requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // PR 1: Converted to PO (Herman Miller Chairs for Marketing team)
  insertPR.run(1, 'PR-2026-001', 1, 1, 'converted_to_po', 2590.00, 'Ergonomic upgrades for new marketing content creators joining this quarter.', '2026-09-15', 'High', '-7 days');
  insertPRItem.run(1, 9, 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Office Supplies', 2, 1295.00, 2590.00, 3);

  // PR 2: Approved, Ready for PO creation (Designer Laptops & Monitors)
  insertPR.run(2, 'PR-2026-002', 1, 1, 'approved', 4248.00, 'Hardware refresh for senior brand designer preparing Q4 brand relaunch.', '2026-09-20', 'High', '-3 days');
  insertPRItem.run(2, 1, 'Apple MacBook Pro 16" (M3 Max / 36GB / 1TB)', 'IT Hardware', 1, 3499.00, 3499.00, 1);
  insertPRItem.run(2, 2, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'IT Hardware', 1, 749.00, 749.00, 1);

  // PR 3: Pending Approval (UX Audit Consulting Sprint - $8,500)
  insertPR.run(3, 'PR-2026-003', 1, 1, 'pending_approval', 8500.00, 'External expert audit of our primary customer onboarding flow to lift conversion.', '2026-10-01', 'Medium', '-1 days');
  insertPRItem.run(3, 16, 'Enterprise UX Audit & Design System Sprint', 'Consulting & Professional Services', 1, 8500.00, 8500.00, 5);

  // PR 4: Draft (Office stationery & Coffee)
  insertPR.run(4, 'PR-2026-004', 1, 1, 'draft', 476.00, 'Quarterly refill of print paper and kitchen espresso beans for Marketing wing.', '2026-09-25', 'Low', '0 days');
  insertPRItem.run(4, 12, 'Hammermill 100% Recycled Copy Paper (Case of 10 Reams)', 'Office Supplies', 4, 58.00, 232.00, 3);
  insertPRItem.run(4, 13, 'Artisan Single-Origin Espresso Beans (5 lb Bag)', 'Office Supplies', 3, 72.00, 216.00, 3);
  insertPRItem.run(4, 3, 'Logitech MX Master 3S Wireless Mouse', 'IT Hardware', 1, 99.00, 99.00, 1);

  // 7. Approval Requests
  const insertApproval = db.prepare(`
    INSERT INTO approval_requests (requisition_id, approver_id, step_order, status, comments, decided_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // PR 1: Approved by Bob
  insertApproval.run(1, 2, 1, 'approved', 'Approved. Within Q3 ergonomics allocated budget.', '2026-08-28 14:20:00');
  // PR 2: Approved by Bob & Carol
  insertApproval.run(2, 2, 1, 'approved', 'Approved hardware upgrade for brand lead.', '2026-09-01 10:15:00');
  insertApproval.run(2, 3, 2, 'approved', 'Procurement verified against vendor standard contract discount.', '2026-09-01 16:40:00');
  // PR 3: Pending with Bob Martinez (Marketing Director)
  insertApproval.run(3, 2, 1, 'pending', null, null);

  // 8. Purchase Orders
  const insertPO = db.prepare(`
    INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, expected_delivery_date, payment_terms, shipping_address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPOItem = db.prepare(`
    INSERT INTO po_items (id, po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // PO 1: Issued & Fully Received against PR 1 (Chairs)
  insertPO.run(
    1,
    'PO-2026-001',
    1,
    3,
    3,
    'received',
    2590.00,
    '2026-08-29',
    '2026-09-05',
    'Net 45',
    'Acme Corp HQ - Bldg B, Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701',
    'Standard ground delivery. Call 555-0199 upon arrival.'
  );
  insertPOItem.run(1, 1, 1, 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Office Supplies', 2, 1295.00, 2590.00, 2, 2);

  // PO 2: Partially Received (Monitors ordered directly by Procurement)
  insertPO.run(
    2,
    'PO-2026-002',
    null,
    1,
    3,
    'partially_received',
    2996.00,
    '2026-08-30',
    '2026-09-10',
    'Net 30',
    'Acme Corp HQ - IT Dept Receiving, 450 Tech Blvd, Austin, TX 78701',
    'Rush order for new engineering cohort.'
  );
  insertPOItem.run(2, 2, null, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'IT Hardware', 4, 749.00, 2996.00, 2, 0);

  // 9. Goods Receipts
  const insertGRN = db.prepare(`
    INSERT INTO goods_receipts (id, grn_number, po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGRNItem = db.prepare(`
    INSERT INTO goods_receipt_items (goods_receipt_id, po_item_id, quantity_received, condition, comments)
    VALUES (?, ?, ?, ?, ?)
  `);

  // GRN 1: Full receipt for PO 1
  insertGRN.run(1, 'GRN-2026-001', 1, 3, '2026-09-02', 'FEDEX-992384110', 'DN-WED-8821', 'Arrived intact on pallet. Inspected and verified intact.');
  insertGRNItem.run(1, 1, 2, 'good', 'Both chairs unboxed and wheels checked.');

  // GRN 2: Partial receipt for PO 2 (2 out of 4 monitors received)
  insertGRN.run(2, 'GRN-2026-002', 2, 3, '2026-09-03', 'UPS-1Z999999999', 'DN-TSG-4412', 'Partial delivery: 2 monitors delivered; 2 remain on backorder.');
  insertGRNItem.run(2, 2, 2, 'good', 'Boxes intact, serial numbers logged.');

  // 10. Invoices
  const insertInvoice = db.prepare(`
    INSERT INTO invoices (id, invoice_number, po_id, supplier_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, match_status, payment_reference, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertInvoiceItem = db.prepare(`
    INSERT INTO invoice_items (invoice_id, po_item_id, description, quantity_invoiced, unit_price, total_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMatch = db.prepare(`
    INSERT INTO match_results (invoice_id, po_id, po_item_id, ordered_qty, received_qty, invoiced_qty, po_unit_price, invoice_unit_price, qty_variance, price_variance, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Invoice 1: Perfect 3-Way Match for PO 1 (Chairs)
  insertInvoice.run(
    1,
    'INV-WED-9042',
    1,
    3,
    '2026-09-02',
    '2026-10-17',
    2590.00,
    0.00,
    2590.00,
    'approved_for_payment',
    'perfect_match',
    'ACH-SCHEDULED-1017',
    'Perfect match against GRN-2026-001 and PO-2026-001.'
  );
  insertInvoiceItem.run(1, 1, 'Herman Miller Aeron Ergonomic Chair (Size B)', 2, 1295.00, 2590.00);
  insertMatch.run(1, 1, 1, 2, 2, 2, 1295.00, 1295.00, 0, 0, 'pass', 'Exact match on quantity (2) and price ($1,295.00).');

  // Invoice 2: Discrepancy / Variance Example for PO 2
  // Supplier billed 4 monitors at $799 each ($50 higher than PO price $749), and 4 billed while only 2 physically received!
  insertInvoice.run(
    2,
    'INV-TSG-11029',
    2,
    1,
    '2026-09-03',
    '2026-10-03',
    3196.00,
    0.00,
    3196.00,
    'variance_flagged',
    'price_variance',
    null,
    'Discrepancy detected: Invoiced unit price $799.00 exceeds PO price $749.00 by $50.00/unit. Also only 2 of 4 units have been received.'
  );
  insertInvoiceItem.run(2, 2, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 4, 799.00, 3196.00);
  insertMatch.run(2, 2, 2, 4, 2, 4, 749.00, 799.00, 2, 50.00, 'fail', 'Quantity variance: Billed for 4, but only 2 received. Price variance: Billed at $799.00 vs PO $749.00 (+6.67%).');

  // 11. Audit Logs
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `);
  insertAudit.run('requisition', 1, 'CREATED', 'Alice Chen', 'Requisition created for 2 Herman Miller Chairs', '-7 days');
  insertAudit.run('requisition', 1, 'SUBMITTED', 'Alice Chen', 'Submitted for manager approval', '-7 days');
  insertAudit.run('requisition', 1, 'APPROVED', 'Bob Martinez', 'Approved PR-2026-001 for $2,590.00', '-6 days');
  insertAudit.run('purchase_order', 1, 'ISSUED', 'Carol Zhang', 'PO-2026-001 issued to WorkSpace Ergonomics Depot', '-5 days');
  insertAudit.run('goods_receipt', 1, 'RECEIVED', 'Carol Zhang', 'GRN-2026-001 confirmed 2 chairs received in good condition', '-2 days');
  insertAudit.run('invoice', 1, '3_WAY_MATCHED', 'System Engine', 'Automatic 3-way match passed with 0% variance', '-2 days');
  insertAudit.run('invoice', 1, 'APPROVED_PAYMENT', 'David Miller', 'Approved invoice INV-WED-9042 for payment', '-1 days');
  insertAudit.run('invoice', 2, 'VARIANCE_DETECTED', 'System Engine', '3-Way Match flagged price variance (+ $50/unit) and quantity discrepancy', '0 days');

})();

console.log('✅ Database seeded successfully with realistic P2P data!');
