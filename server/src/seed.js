import { applySchema, getDb } from './db.js';

const db = await getDb();

console.log('🌱 Seeding Non-Production Procurement Database...');

const allTables = [
  'invoice_exception_dispositions',
  'match_results',
  'invoice_items',
  'invoices',
  'service_entry_sheet_items',
  'service_entry_sheets',
  'goods_receipt_items',
  'goods_receipts',
  'po_items',
  'purchase_orders',
  'approval_requests',
  'approval_delegations',
  'requisition_items',
  'purchase_requisitions',
  'catalog_items',
  'suppliers',
  'budgets',
  'users',
  'departments',
  'audit_logs'
];

await db.pragma('foreign_keys = OFF');
for (const table of allTables) {
  await db.exec(`DROP TABLE IF EXISTS ${table}`);
}
await db.pragma('foreign_keys = ON');
try {
  await db.exec(`DELETE FROM sqlite_sequence`);
} catch {
  // sqlite_sequence is absent until AUTOINCREMENT tables exist
}
await applySchema(db);

await db.transaction(async () => {
  // 1. Departments
  const insertDept = db.prepare(`INSERT INTO departments (id, code, name) VALUES (?, ?, ?)`);
  await insertDept.run(1, 'MKT', 'Marketing & Brand');
  await insertDept.run(2, 'ITE', 'IT & Digital Infrastructure');
  await insertDept.run(3, 'FAC', 'Facilities & Operations');
  await insertDept.run(4, 'HRP', 'Human Resources & Talent');
  await insertDept.run(5, 'ADM', 'Finance & Administration');

  // 2. Users (approval_limit in integer cents)
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, role, department_id, title, approval_limit, avatar)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await insertUser.run(1, 'Alice Chen', 'alice.chen@company.com', 'requester', 1, 'Brand Marketing Specialist', 0, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(2, 'Bob Martinez', 'bob.martinez@company.com', 'approver', 1, 'VP of Marketing', 1000000, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(3, 'Carol Zhang', 'carol.zhang@company.com', 'procurement', 3, 'Head of Strategic Sourcing', 5000000, 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(4, 'David Miller', 'david.miller@company.com', 'finance', 5, 'Accounts Payable & Financial Controller', 15000000, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(5, 'Elena Rostova', 'elena.rostova@company.com', 'admin', 5, 'Chief Financial Officer (CFO)', 50000000, 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(6, 'Priya Nair', 'priya.nair@company.com', 'approver', 2, 'VP of Information Technology', 1000000, 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(7, 'James Okonkwo', 'james.okonkwo@company.com', 'approver', 3, 'Director of Facilities & Operations', 1000000, 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=120&h=120&fit=crop&crop=faces');
  await insertUser.run(8, 'Sofia Berg', 'sofia.berg@company.com', 'approver', 4, 'VP of People & Talent', 1000000, 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=120&h=120&fit=crop&crop=faces');

  // Map each cost center to its step-1 department head (org admin can change this).
  const setDeptApprover = db.prepare(`UPDATE departments SET approver_user_id = ? WHERE id = ?`);
  await setDeptApprover.run(2, 1); // MKT → Bob Martinez
  await setDeptApprover.run(6, 2); // ITE → Priya Nair
  await setDeptApprover.run(7, 3); // FAC → James Okonkwo
  await setDeptApprover.run(8, 4); // HRP → Sofia Berg
  await setDeptApprover.run(5, 5); // ADM → Elena Rostova (CFO). David remains the finance threshold step.

  // 3. Budgets (Fiscal Year 2026) — amounts in cents
  const insertBudget = db.prepare(`
    INSERT INTO budgets (department_id, fiscal_year, total_budget, committed_amount, actual_spent)
    VALUES (?, ?, ?, ?, ?)
  `);
  await insertBudget.run(1, 2026, 15000000, 1782100, 2435000); // MKT $150,000 / $17,821 committed (PR-2026-006 + buyer-inbox PR-2026-007) / $24,350
  await insertBudget.run(2, 2026, 32000000, 6070000, 8910000); // ITE + $12,500 committed for SOC 2 SES PO
  await insertBudget.run(3, 2026, 9500000, 1230000, 1845000);  // FAC
  await insertBudget.run(4, 2026, 6000000, 450000, 1120000);   // HRP
  await insertBudget.run(5, 2026, 5000000, 320000, 890000);    // ADM

  // 4. Suppliers
  const insertSupplier = db.prepare(`
    INSERT INTO suppliers (id, name, code, contact_person, email, phone, address, payment_terms, rating, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await insertSupplier.run(1, 'TechSupply Global', 'SUP-TSG', 'Marcus Vance', 'enterprise@techsupply.com', '+1 (555) 234-5678', '100 Silicon Way, San Jose, CA', 'Net 30', 4.9, 'active');
  await insertSupplier.run(2, 'CloudCore Software LLC', 'SUP-CCS', 'Sarah Connor', 'billing@cloudcore.io', '+1 (555) 876-5432', '500 Cloud Vista Blvd, Seattle, WA', 'Net 30', 4.8, 'active');
  await insertSupplier.run(3, 'WorkSpace Ergonomics Depot', 'SUP-WED', 'Arthur Pendelton', 'b2b@workspacedepot.com', '+1 (555) 345-6789', '25 Industrial Parkway, Grand Rapids, MI', 'Net 45', 4.7, 'active');
  await insertSupplier.run(4, 'FacilityCare & Janitorial Pro', 'SUP-FCJ', 'Maria Gonzalez', 'orders@facilitycare.com', '+1 (555) 901-2345', '77 Commerce Rd, Chicago, IL', 'Net 30', 4.6, 'active');
  await insertSupplier.run(5, 'Apex Advisory & Digital', 'SUP-AAD', 'Dr. Liam Sterling', 'engagements@apexadvisory.com', '+1 (555) 432-1098', '350 Park Avenue, New York, NY', 'Net 60', 5.0, 'active');
  await insertSupplier.run(6, 'FastTrack Express Freight', 'SUP-FEF', 'Tim O’Brian', 'dispatch@fasttracklogistics.com', '+1 (555) 678-9012', '12 Airport Loop, Dallas, TX', 'Net 15', 4.5, 'active');

  // 5. Non-Production Catalog Items — unit_price in cents
  const insertCatalog = db.prepare(`
    INSERT INTO catalog_items (sku, name, description, category, unit, unit_price, preferred_supplier_id, lead_time_days, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await insertCatalog.run('SKU-HW-001', 'Apple MacBook Pro 16" (M3 Max / 36GB / 1TB)', 'High-performance engineering & design workstation laptop', 'IT Hardware', 'each', 349900, 1, 3, '💻');
  await insertCatalog.run('SKU-HW-002', 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'Color-accurate IPS Black monitor with integrated hub', 'IT Hardware', 'each', 74900, 1, 2, '🖥️');
  await insertCatalog.run('SKU-HW-003', 'Logitech MX Master 3S Wireless Mouse', 'Ergonomic performance mouse with quiet clicks and 8K DPI', 'IT Hardware', 'each', 9900, 1, 1, '🖱️');
  await insertCatalog.run('SKU-HW-004', 'CalDigit TS4 Thunderbolt 4 Docking Station', '18-port expansion dock with 98W host charging', 'IT Hardware', 'each', 39900, 1, 2, '🔌');

  await insertCatalog.run('SKU-SW-001', 'Figma Organization Annual User License', 'Collaborative interface design & prototyping enterprise seat', 'Software & Cloud', 'license/yr', 54000, 2, 1, '🎨');
  await insertCatalog.run('SKU-SW-002', 'Slack Enterprise Grid Annual Subscription', 'Internal team communications and enterprise automation', 'Software & Cloud', 'user/yr', 18000, 2, 1, '💬');
  await insertCatalog.run('SKU-SW-003', 'GitHub Enterprise Cloud Seat', 'Source code hosting, CI/CD Actions, and enterprise security', 'Software & Cloud', 'seat/yr', 25200, 2, 1, '🐙');
  await insertCatalog.run('SKU-SW-004', '1Password Business Password Manager', 'Secure password vaulting for company employees', 'Software & Cloud', 'user/yr', 9600, 2, 1, '🔐');

  await insertCatalog.run('SKU-OFF-001', 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Fully adjustable mesh task chair with PostureFit SL', 'Office Supplies', 'each', 129500, 3, 7, '🪑');
  await insertCatalog.run('SKU-OFF-002', 'Jarvis Dual-Motor Electric Standing Desk (60"x30")', 'Solid bamboo height-adjustable workstation with memory handset', 'Office Supplies', 'each', 69900, 3, 5, '🪵');
  await insertCatalog.run('SKU-OFF-003', 'Mobile Magnetic Porcelain Whiteboard (72" x 48")', 'Double-sided rolling presentation board with locking casters', 'Office Supplies', 'each', 34900, 3, 4, '📋');
  await insertCatalog.run('SKU-OFF-004', 'Hammermill 100% Recycled Copy Paper (Case of 10 Reams)', 'Acid-free premium 20lb white copy paper for daily printing', 'Office Supplies', 'case', 5800, 3, 2, '📄');
  await insertCatalog.run('SKU-OFF-005', 'Artisan Single-Origin Espresso Beans (5 lb Bag)', 'Locally roasted whole bean coffee for office kitchen', 'Office Supplies', 'bag', 7200, 3, 2, '☕');

  await insertCatalog.run('SKU-FAC-001', 'Blueair Pro XL Commercial HEPA Air Purifier', 'Commercial grade air filtration for meeting rooms and open spaces', 'Facilities & MRO', 'each', 89000, 4, 3, '💨');
  await insertCatalog.run('SKU-FAC-002', 'OSHA 4-Shelf Industrial First Aid Station', 'Compliant wall-mounted emergency medical care unit', 'Facilities & MRO', 'kit', 21000, 4, 2, '🩹');
  await insertCatalog.run('SKU-FAC-003', 'Commercial Touchless Sanitizer & Dispenser Stand', 'Floor-standing automatic sensor sanitizer station', 'Facilities & MRO', 'set', 14500, 4, 2, '🧴');

  await insertCatalog.run('SKU-SRV-001', 'Enterprise UX Audit & Design System Sprint', 'Two-week dedicated product design sprint and component audit', 'Consulting & Professional Services', 'sprint', 850000, 5, 14, '📐');
  await insertCatalog.run('SKU-SRV-002', 'SOC 2 Type II Annual Security Penetration Test', 'Full external threat simulation, vulnerability assessment, and report', 'Consulting & Professional Services', 'engagement', 1250000, 5, 21, '🛡️');
  await insertCatalog.run('SKU-SRV-003', 'Executive Team Coaching & Alignment Workshop', 'Two-day facilitator-led offsite strategy alignment workshop', 'Consulting & Professional Services', 'event', 620000, 5, 10, '👥');

  await db.exec(`
    UPDATE catalog_items
    SET line_type = 'service'
    WHERE category IN (
      'Consulting & Professional Services',
      'Software & Cloud',
      'Marketing & Events',
      'Travel & Subscriptions'
    )
  `);

  // 6. Purchase Requisitions & Items
  // Document trail demos:
  //   PR-2026-001 — complete goods path: PR → approvals → PO-2026-001 → GRN-2026-001 → INV-WED-9042 → AP paid
  //   PR-2026-005 — complete service path: PR → approvals → PO-2026-003 → SES-2026-001 → INV-AAD-5501 (matched)
  //   PR-2026-006 — approved multi-supplier split; after convert the trail shows two PO branches
  // Exception workbench: INV-TSG-11029 is open (David can accept, reject, return, or short-pay).
  // INV-FCJ-7701 is already accept_variance. Short-pay walkthrough: pay 2 × $749.00 = $1,498.00.
  // Buyer inbox: INV-TSG-22041 is parked return_to_buyer on Alice's PR-2026-007.
  const insertPR = db.prepare(`
    INSERT INTO purchase_requisitions (id, pr_number, requester_id, department_id, status, total_amount, justification, needed_by_date, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  const insertPRItem = db.prepare(`
    INSERT INTO requisition_items (requisition_id, catalog_item_id, item_description, category, quantity, unit_price, total_price, estimated_supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await insertPR.run(1, 'PR-2026-001', 1, 1, 'converted_to_po', 259000, 'Ergonomic upgrades for new marketing content creators joining this quarter.', '2026-09-15', 'High', '-7 days');
  await insertPRItem.run(1, 9, 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Office Supplies', 2, 129500, 259000, 3);

  await insertPR.run(2, 'PR-2026-002', 1, 1, 'approved', 424800, 'Hardware refresh for senior brand designer preparing Q4 brand relaunch.', '2026-09-20', 'High', '-3 days');
  await insertPRItem.run(2, 1, 'Apple MacBook Pro 16" (M3 Max / 36GB / 1TB)', 'IT Hardware', 1, 349900, 349900, 1);
  await insertPRItem.run(2, 2, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'IT Hardware', 1, 74900, 74900, 1);

  // Pending Marketing PR for Bob; Priya sees it via the seeded OOO delegation.
  await insertPR.run(3, 'PR-2026-003', 1, 1, 'pending_approval', 850000, 'External expert audit of our primary customer onboarding flow to lift conversion.', '2026-10-01', 'Medium', '-1 days');
  await insertPRItem.run(3, 16, 'Enterprise UX Audit & Design System Sprint', 'Consulting & Professional Services', 1, 850000, 850000, 5);

  await insertPR.run(4, 'PR-2026-004', 1, 1, 'draft', 54700, 'Quarterly refill of print paper and kitchen espresso beans for Marketing wing.', '2026-09-25', 'Low', '0 days');
  await insertPRItem.run(4, 12, 'Hammermill 100% Recycled Copy Paper (Case of 10 Reams)', 'Office Supplies', 4, 5800, 23200, 3);
  await insertPRItem.run(4, 13, 'Artisan Single-Origin Espresso Beans (5 lb Bag)', 'Office Supplies', 3, 7200, 21600, 3);
  await insertPRItem.run(4, 3, 'Logitech MX Master 3S Wireless Mouse', 'IT Hardware', 1, 9900, 9900, 1);

  // Service PO path: converted consulting engagement (SES-backed, no GRN)
  await insertPR.run(5, 'PR-2026-005', 1, 2, 'converted_to_po', 1250000, 'Annual SOC 2 Type II penetration test required for enterprise customer diligence.', '2026-10-15', 'High', '-10 days');
  await insertPRItem.run(5, 18, 'SOC 2 Type II Annual Security Penetration Test', 'Consulting & Professional Services', 1, 1250000, 1250000, 5);

  // Multi-supplier convert demo: approved, not yet converted. Carol's convert UI
  // lists TechSupply + WorkSpace defaults; she can remap a line before issue.
  await insertPR.run(6, 'PR-2026-006', 1, 1, 'approved', 204400, 'Q4 studio refresh: designer workstation monitor plus ergonomic chair from preferred vendors on one requisition.', '2026-10-05', 'Medium', '-2 days');
  await insertPRItem.run(6, 2, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'IT Hardware', 1, 74900, 74900, 1);
  await insertPRItem.run(6, 9, 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Office Supplies', 1, 129500, 129500, 3);

  // Buyer inbox demo: Alice's converted PR → PO → partial GRN → qty-variance invoice returned to buyer.
  await insertPR.run(7, 'PR-2026-007', 1, 1, 'converted_to_po', 29700, 'Replacement mice for marketing studio editors after Q3 hardware failures.', '2026-09-18', 'Medium', '-4 days');
  await insertPRItem.run(7, 3, 'Logitech MX Master 3S Wireless Mouse', 'IT Hardware', 3, 9900, 29700, 1);

  await db.exec(`
    UPDATE requisition_items
    SET line_type = 'service'
    WHERE category IN (
      'Consulting & Professional Services',
      'Software & Cloud',
      'Marketing & Events',
      'Travel & Subscriptions'
    )
  `);

  // 7. Approval Requests
  const insertApproval = db.prepare(`
    INSERT INTO approval_requests (requisition_id, approver_id, step_order, status, comments, decided_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  await insertApproval.run(1, 2, 1, 'approved', 'Approved. Within Q3 ergonomics allocated budget.', '2026-08-28 14:20:00');
  await insertApproval.run(1, 3, 2, 'approved', 'Sourcing confirmed Aeron chairs on standard contract.', '2026-08-28 16:05:00');
  await insertApproval.run(2, 2, 1, 'approved', 'Approved hardware upgrade for brand lead.', '2026-09-01 10:15:00');
  await insertApproval.run(2, 3, 2, 'approved', 'Procurement verified against vendor standard contract discount.', '2026-09-01 16:40:00');
  // PR-2026-003 is $8,500 — dept head + procurement; sequential: Bob pending, Carol waiting.
  // Seeded Bob → Priya delegation covers this pending step (OOO walkthrough).
  await insertApproval.run(3, 2, 1, 'pending', null, null);
  await insertApproval.run(3, 3, 2, 'waiting', null, null);
  // PR-2026-005 is $12,500 — ITE dept head + procurement + finance; all approved.
  await insertApproval.run(5, 6, 1, 'approved', 'Required for enterprise security posture.', '2026-08-25 09:10:00');
  await insertApproval.run(5, 3, 2, 'approved', 'Apex Advisory is the contracted security partner.', '2026-08-25 11:40:00');
  await insertApproval.run(5, 4, 3, 'approved', 'Budget committed against ITE FY26 security program.', '2026-08-25 15:05:00');
  // PR-2026-006 is $2,044 — dept head + procurement; both approved so Carol can convert the split.
  await insertApproval.run(6, 2, 1, 'approved', 'Approved studio refresh. Split sourcing is expected.', '2026-09-03 09:40:00');
  await insertApproval.run(6, 3, 2, 'approved', 'TechSupply for the monitor; WorkSpace for the Aeron — convert will issue two POs.', '2026-09-03 11:15:00');
  // PR-2026-007 is $297 — department head only.
  await insertApproval.run(7, 2, 1, 'approved', 'Approved replacement mice against marketing studio kit budget.', '2026-09-04 10:05:00');

  // 7b. Approval delegation (OOO): Bob → Priya, covering now. Stored
  // approval_requests.approver_id on PR-2026-003 stays Bob; Priya sees it at list/decide time.
  const insertDelegation = db.prepare(`
    INSERT INTO approval_delegations (
      delegator_user_id, delegate_user_id, starts_at, ends_at, active, reason,
      created_by_user_id, created_by_name
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const delegationStarts = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const delegationEnds = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  await insertDelegation.run(
    2,
    6,
    delegationStarts,
    delegationEnds,
    'Out of office — Q3 offsite. Priya covers Marketing step-1 approvals including PR-2026-003.',
    2,
    'Bob Martinez'
  );

  // 8. Purchase Orders
  const insertPO = db.prepare(`
    INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, created_by, status, total_amount, issue_date, expected_delivery_date, payment_terms, shipping_address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPOItem = db.prepare(`
    INSERT INTO po_items (id, po_id, requisition_item_id, item_description, category, quantity, unit_price, total_price, quantity_received, quantity_invoiced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await insertPO.run(
    1,
    'PO-2026-001',
    1,
    3,
    3,
    'received',
    259000,
    '2026-08-29',
    '2026-09-05',
    'Net 45',
    'Acme Corp HQ - Bldg B, Receiving Bay 2, 450 Tech Blvd, Austin, TX 78701',
    'Standard ground delivery. Call 555-0199 upon arrival.'
  );
  await insertPOItem.run(1, 1, 1, 'Herman Miller Aeron Ergonomic Chair (Size B)', 'Office Supplies', 2, 129500, 259000, 2, 2);

  await insertPO.run(
    2,
    'PO-2026-002',
    null,
    1,
    3,
    'partially_received',
    299600,
    '2026-08-30',
    '2026-09-10',
    'Net 30',
    'Acme Corp HQ - IT Dept Receiving, 450 Tech Blvd, Austin, TX 78701',
    'Rush order for new engineering cohort.'
  );
  // Claimed invoiced qty recorded for audit even though match failed (4 billed vs 2 received).
  await insertPOItem.run(2, 2, null, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 'IT Hardware', 4, 74900, 299600, 2, 4);

  await insertPO.run(
    3,
    'PO-2026-003',
    5,
    5,
    3,
    'received',
    1250000,
    '2026-08-26',
    '2026-10-15',
    'Net 60',
    'Acme Corp HQ - Security & Compliance, 450 Tech Blvd, Austin, TX 78701',
    'Service engagement. Acceptance via Service Entry Sheet — no physical GRN.'
  );
  await insertPOItem.run(3, 3, 8, 'SOC 2 Type II Annual Security Penetration Test', 'Consulting & Professional Services', 1, 1250000, 1250000, 0, 1);

  await insertPO.run(
    4,
    'PO-2026-004',
    null,
    2,
    3,
    'issued',
    108000,
    '2026-09-02',
    '2026-09-30',
    'Net 30',
    'Acme Corp HQ - Design Systems, 450 Tech Blvd, Austin, TX 78701',
    'SaaS seats. Accept via Service Entry Sheet when licenses are provisioned.'
  );
  await insertPOItem.run(4, 4, null, 'Figma Organization Annual User License', 'Software & Cloud', 2, 54000, 108000, 0, 0);

  // Already-resolved exception demo (price variance accepted). Not on the PR-2026-001 path.
  await insertPO.run(
    5,
    'PO-2026-005',
    null,
    4,
    3,
    'received',
    29000,
    '2026-09-01',
    '2026-09-08',
    'Net 30',
    'Acme Corp HQ - Facilities Closet, 450 Tech Blvd, Austin, TX 78701',
    'Sanitizer stand restock. Used for Exception Workbench resolved-example seed.'
  );
  await insertPOItem.run(5, 5, null, 'Commercial Touchless Sanitizer & Dispenser Stand', 'Facilities & MRO', 2, 14500, 29000, 2, 2);

  await insertPO.run(
    6,
    'PO-2026-006',
    7,
    1,
    3,
    'partially_received',
    29700,
    '2026-09-04',
    '2026-09-12',
    'Net 30',
    'Acme Corp HQ - Marketing Studio, 450 Tech Blvd, Austin, TX 78701',
    'Replacement mice for studio editors. Partial delivery expected.'
  );
  // Claimed invoiced qty recorded for audit even though match failed (3 billed vs 2 received).
  await insertPOItem.run(6, 6, 11, 'Logitech MX Master 3S Wireless Mouse', 'IT Hardware', 3, 9900, 29700, 2, 3);

  // 9. Goods Receipts
  const insertGRN = db.prepare(`
    INSERT INTO goods_receipts (id, grn_number, po_id, received_by, receipt_date, carrier_tracking, delivery_note_number, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGRNItem = db.prepare(`
    INSERT INTO goods_receipt_items (goods_receipt_id, po_item_id, quantity_received, condition, comments)
    VALUES (?, ?, ?, ?, ?)
  `);

  await insertGRN.run(1, 'GRN-2026-001', 1, 3, '2026-09-02', 'FEDEX-992384110', 'DN-WED-8821', 'Arrived intact on pallet. Inspected and verified intact.');
  await insertGRNItem.run(1, 1, 2, 'good', 'Both chairs unboxed and wheels checked.');

  await insertGRN.run(2, 'GRN-2026-002', 2, 3, '2026-09-03', 'UPS-1Z999999999', 'DN-TSG-4412', 'Partial delivery: 2 monitors delivered; 2 remain on backorder.');
  await insertGRNItem.run(2, 2, 2, 'good', 'Boxes intact, serial numbers logged.');

  await insertGRN.run(3, 'GRN-2026-003', 5, 3, '2026-09-04', 'GSO-4411982', 'DN-FCJ-1904', 'Both sanitizer stands received and staged in the facilities closet.');
  await insertGRNItem.run(3, 5, 2, 'good', 'Units assembled; no damage.');

  await insertGRN.run(4, 'GRN-2026-004', 6, 3, '2026-09-06', 'UPS-1Z22041001', 'DN-TSG-2204', 'Partial delivery: 2 of 3 mice received; one remains on backorder.');
  await insertGRNItem.run(4, 6, 2, 'good', 'Serials logged; packaging intact.');

  await db.exec(`
    UPDATE po_items
    SET line_type = 'service'
    WHERE category IN (
      'Consulting & Professional Services',
      'Software & Cloud',
      'Marketing & Events',
      'Travel & Subscriptions'
    );
    UPDATE po_items SET quantity_accepted = 1 WHERE id = 3;
  `);

  const insertSES = db.prepare(`
    INSERT INTO service_entry_sheets (id, ses_number, po_id, created_by, status, service_period_start, service_period_end, notes, decided_by, decided_at, decision_comments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSESItem = db.prepare(`
    INSERT INTO service_entry_sheet_items (ses_id, po_item_id, quantity_accepted, amount_cents, comments)
    VALUES (?, ?, ?, ?, ?)
  `);
  await insertSES.run(
    1,
    'SES-2026-001',
    3,
    1,
    'accepted',
    '2026-09-01',
    '2026-09-20',
    'Engagement completed. Draft report delivered and accepted by IT security.',
    3,
    '2026-09-21 10:15:00',
    'Accepted. Scope complete; no physical receipt required.'
  );
  await insertSESItem.run(1, 3, 1, 1250000, 'Full engagement accepted — report and remediation workshop delivered.');

  // 10. Invoices — UNIQUE(supplier_id, invoice_number); seed numbers are distinct per vendor
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

  // Happy-path goods trail (PR-2026-001): invoice is AP-approved and paid so the Document Trail screen is complete.
  await insertInvoice.run(
    1,
    'INV-WED-9042',
    1,
    3,
    '2026-09-02',
    '2026-10-17',
    259000,
    0,
    259000,
    'paid',
    'perfect_match',
    'ACH-1017-WED9042',
    'Perfect match against GRN-2026-001 and PO-2026-001. AP approved and paid.'
  );
  await insertInvoiceItem.run(1, 1, 'Herman Miller Aeron Ergonomic Chair (Size B)', 2, 129500, 259000);
  await insertMatch.run(1, 1, 1, 2, 2, 2, 129500, 129500, 0, 0, 'pass', 'Exact match on quantity (2) and price ($1,295.00).');

  // Supplier billed 4 monitors at $799 (79900¢) vs PO $749 (74900¢); only 2 received → total_variance
  await insertInvoice.run(
    2,
    'INV-TSG-11029',
    2,
    1,
    '2026-09-03',
    '2026-10-03',
    319600,
    0,
    319600,
    'variance_flagged',
    'total_variance',
    null,
    'Discrepancy detected: Invoiced unit price $799.00 exceeds PO price $749.00 by $50.00/unit. Also only 2 of 4 units have been received. Open for Exception Workbench — Short pay e.g. $1,498.00 (2 received × $749.00 PO price).'
  );
  await insertInvoiceItem.run(2, 2, 'Dell UltraSharp 32" 4K USB-C Hub Monitor (U3223QE)', 4, 79900, 319600);
  await insertMatch.run(2, 2, 2, 4, 2, 4, 74900, 79900, 2, 5000, 'fail', 'Quantity variance: Cumulative invoiced 4 (prior 0 + this claim 4) exceeds 2 physically received on GRN. Price discrepancy: Billed at $799.00 vs authorized PO price $749.00 (+6.68%).');

  // Service invoice: SES-backed match, no GRN on this PO
  await insertInvoice.run(
    3,
    'INV-AAD-5501',
    3,
    5,
    '2026-09-22',
    '2026-11-21',
    1250000,
    0,
    1250000,
    'matched',
    'perfect_match',
    null,
    'SES-backed match against SES-2026-001 and PO-2026-003. No physical GRN.'
  );
  await insertInvoiceItem.run(3, 3, 'SOC 2 Type II Annual Security Penetration Test', 1, 1250000, 1250000);
  await insertMatch.run(3, 3, 3, 1, 1, 1, 1250000, 1250000, 0, 0, 'pass', 'Exact SES-backed match: 1 units at $12500.00 matches PO & accepted service entry sheet.');

  // Resolved exception example: billed $149.00 vs PO $145.00 (400¢ > 145¢ 1% band).
  // Status is matched after accept_variance; match_status stays price_variance.
  await insertInvoice.run(
    4,
    'INV-FCJ-7701',
    5,
    4,
    '2026-09-05',
    '2026-10-05',
    29800,
    0,
    29800,
    'matched',
    'price_variance',
    null,
    'Price variance accepted in Exception Workbench. Billed $149.00 vs PO $145.00 (400¢).'
  );
  await insertInvoiceItem.run(4, 5, 'Commercial Touchless Sanitizer & Dispenser Stand', 2, 14900, 29800);
  await insertMatch.run(4, 5, 5, 2, 2, 2, 14500, 14900, 0, 400, 'fail', 'Price discrepancy: Billed at $149.00 vs authorized PO price $145.00 (+2.76%).');

  // Buyer inbox demo: billed 3 mice at PO price; only 2 received → quantity_variance, parked return_to_buyer.
  await insertInvoice.run(
    5,
    'INV-TSG-22041',
    6,
    1,
    '2026-09-07',
    '2026-10-07',
    29700,
    0,
    29700,
    'variance_flagged',
    'quantity_variance',
    null,
    'Quantity variance: vendor billed 3 mice; GRN-2026-004 received 2. Parked return_to_buyer for Alice (PR-2026-007). INV-TSG-11029 remains the short-pay practice invoice.'
  );
  await insertInvoiceItem.run(5, 6, 'Logitech MX Master 3S Wireless Mouse', 3, 9900, 29700);
  await insertMatch.run(5, 6, 6, 3, 2, 3, 9900, 9900, 1, 0, 'fail', 'Quantity variance: Cumulative invoiced 3 (prior 0 + this claim 3) exceeds 2 physically received on GRN.');

  const insertDisposition = db.prepare(`
    INSERT INTO invoice_exception_dispositions (
      invoice_id, disposition, reason, actor_name, accepted_total_cents, accepted_match_status, billed_total_cents, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await insertDisposition.run(
    4,
    'accept_variance',
    'Facilities restock surcharge approved against FY26 MRO contract. Pay billed $298.00.',
    'David Miller',
    29800,
    'price_variance',
    29800,
    '2026-09-06 09:30:00'
  );
  await insertDisposition.run(
    5,
    'return_to_buyer',
    'Only 2 of 3 mice received on GRN-2026-004. Confirm whether the third unit arrived off-system before AP accepts billed quantity.',
    'David Miller',
    29700,
    'quantity_variance',
    29700,
    '2026-09-08 09:15:00'
  );

  // 11. Audit Logs
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (entity_type, entity_id, action, actor_name, details, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `);
  await insertAudit.run('requisition', 1, 'CREATED', 'Alice Chen', 'Requisition created for 2 Herman Miller Chairs', '-7 days');
  await insertAudit.run('requisition', 1, 'SUBMITTED', 'Alice Chen', 'Submitted for manager approval', '-7 days');
  await insertAudit.run('requisition', 1, 'APPROVED', 'Bob Martinez', 'Approved PR-2026-001 for $2,590.00', '-6 days');
  await insertAudit.run('purchase_order', 1, 'ISSUED', 'Carol Zhang', 'PO-2026-001 issued to WorkSpace Ergonomics Depot', '-5 days');
  await insertAudit.run('goods_receipt', 1, 'RECEIVED', 'Carol Zhang', 'GRN-2026-001 confirmed 2 chairs received in good condition', '-2 days');
  await insertAudit.run('invoice', 1, '3_WAY_MATCHED', 'System Engine', 'Automatic 3-way match passed with 0% variance', '-2 days');
  await insertAudit.run('invoice', 1, 'APPROVED_PAYMENT', 'David Miller', 'Approved invoice INV-WED-9042 for payment', '-1 days');
  await insertAudit.run('invoice', 1, 'PAID', 'David Miller', 'Marked as paid with reference ACH-1017-WED9042', '0 days');
  await insertAudit.run('invoice', 2, 'VARIANCE_DETECTED', 'System Engine', '3-Way Match flagged price variance (+ $50/unit) and quantity discrepancy', '0 days');
  await insertAudit.run('requisition', 5, 'CREATED', 'Alice Chen', 'Requisition created for SOC 2 Type II penetration test', '-10 days');
  await insertAudit.run('requisition', 5, 'APPROVED', 'David Miller', 'Final approval and ITE budget commit for PR-2026-005', '-9 days');
  await insertAudit.run('purchase_order', 3, 'ISSUED', 'Carol Zhang', 'PO-2026-003 issued to Apex Advisory & Digital', '-9 days');
  await insertAudit.run('service_entry_sheet', 1, 'CREATED', 'Alice Chen', 'SES-2026-001 recorded acceptance of SOC 2 engagement', '-2 days');
  await insertAudit.run('service_entry_sheet', 1, 'ACCEPTED', 'Carol Zhang', 'Accepted SES-2026-001 for PO-2026-003 (1 unit)', '-2 days');
  await insertAudit.run('invoice', 3, '3_WAY_MATCHED', 'System Engine', 'Invoice INV-AAD-5501 SES-backed match passed (PO+SES+invoice)', '-1 days');
  await insertAudit.run('invoice', 4, '3_WAY_MATCHED', 'System Engine', 'Invoice INV-FCJ-7701 flagged price_variance (400¢ over PO)', '-1 days');
  await insertAudit.run('invoice', 4, 'EXCEPTION_ACCEPT_VARIANCE', 'David Miller', 'Accepted price_variance on billed total $298.00. Reason: Facilities restock surcharge approved against FY26 MRO contract. Pay billed $298.00.', '0 days');
  await insertAudit.run('requisition', 6, 'CREATED', 'Alice Chen', 'Requisition created with TechSupply monitor and WorkSpace Aeron chair', '-2 days');
  await insertAudit.run('requisition', 6, 'APPROVED', 'Carol Zhang', 'Final approval and MKT budget commit for multi-supplier PR-2026-006', '-2 days');
  await insertAudit.run('requisition', 7, 'CREATED', 'Alice Chen', 'Requisition created for 3 Logitech MX Master 3S mice', '-4 days');
  await insertAudit.run('requisition', 7, 'SUBMITTED', 'Alice Chen', 'Submitted PR-2026-007 for department-head approval', '-4 days');
  await insertAudit.run('requisition', 7, 'APPROVED', 'Bob Martinez', 'Approved PR-2026-007 for $297.00', '-4 days');
  await insertAudit.run('purchase_order', 6, 'ISSUED', 'Carol Zhang', 'PO-2026-006 issued to TechSupply Global', '-3 days');
  await insertAudit.run('goods_receipt', 4, 'RECEIVED', 'Carol Zhang', 'GRN-2026-004 confirmed 2 of 3 mice received; one on backorder', '-1 days');
  await insertAudit.run('invoice', 5, 'VARIANCE_DETECTED', 'System Engine', '3-Way Match flagged quantity variance (3 billed vs 2 received)', '-1 days');
  await insertAudit.run('invoice', 5, 'EXCEPTION_RETURN_TO_BUYER', 'David Miller', 'Disposition return_to_buyer for INV-TSG-22041 (billed $297.00, match quantity_variance). Reason: Only 2 of 3 mice received on GRN-2026-004. Confirm whether the third unit arrived off-system before AP accepts billed quantity.', '0 days');
  await insertAudit.run(
    'approval_delegation',
    1,
    'DELEGATION_CREATED',
    'Bob Martinez',
    'Bob Martinez (id=2) → Priya Nair (id=6). Active OOO window covering PR-2026-003.',
    '0 days'
  );

  // Absolute timestamps so Document Trail chronology is honest (seed datetime('now') would
  // otherwise place PO/invoice/AP "today" after or before GRN/approval dates).
  await db.exec(`
    UPDATE purchase_requisitions SET created_at = '2026-08-27 09:00:00' WHERE id = 1;
    UPDATE purchase_orders SET created_at = '2026-08-29 09:30:00' WHERE id = 1;
    UPDATE goods_receipts SET created_at = '2026-09-02 11:00:00' WHERE id = 1;
    UPDATE invoices SET created_at = '2026-09-02 15:00:00' WHERE id = 1;
    UPDATE audit_logs SET created_at = '2026-09-03 10:00:00'
      WHERE entity_type = 'invoice' AND entity_id = 1 AND action = 'APPROVED_PAYMENT';
    UPDATE audit_logs SET created_at = '2026-09-04 08:00:00'
      WHERE entity_type = 'invoice' AND entity_id = 1 AND action = 'PAID';

    UPDATE purchase_requisitions SET created_at = '2026-08-24 09:00:00' WHERE id = 5;
    UPDATE purchase_requisitions SET created_at = '2026-09-03 08:00:00' WHERE id = 6;
    UPDATE purchase_orders SET created_at = '2026-08-26 10:00:00' WHERE id = 3;
    UPDATE service_entry_sheets SET created_at = '2026-09-21 09:00:00' WHERE id = 1;
    UPDATE invoices SET created_at = '2026-09-22 11:00:00' WHERE id = 3;

    UPDATE purchase_orders SET created_at = '2026-09-01 10:00:00' WHERE id = 5;
    UPDATE goods_receipts SET created_at = '2026-09-04 14:00:00' WHERE id = 3;
    UPDATE invoices SET created_at = '2026-09-05 11:00:00' WHERE id = 4;
    UPDATE audit_logs SET created_at = '2026-09-06 09:30:00'
      WHERE entity_type = 'invoice' AND entity_id = 4 AND action = 'EXCEPTION_ACCEPT_VARIANCE';

    UPDATE purchase_requisitions SET created_at = '2026-09-03 16:00:00' WHERE id = 7;
    UPDATE purchase_orders SET created_at = '2026-09-04 11:00:00' WHERE id = 6;
    UPDATE goods_receipts SET created_at = '2026-09-06 13:00:00' WHERE id = 4;
    UPDATE invoices SET created_at = '2026-09-07 10:30:00' WHERE id = 5;
    UPDATE audit_logs SET created_at = '2026-09-08 09:15:00'
      WHERE entity_type = 'invoice' AND entity_id = 5 AND action = 'EXCEPTION_RETURN_TO_BUYER';
  `);

});

console.log('✅ Database seeded successfully with realistic P2P data (money stored as integer cents)!');
