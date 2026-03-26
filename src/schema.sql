-- Echo Payroll — AI-Powered Payroll Processing
-- D1 Schema

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  ein TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT DEFAULT 'US',
  pay_frequency TEXT DEFAULT 'biweekly',
  pay_day TEXT DEFAULT 'friday',
  fiscal_year_start TEXT DEFAULT '01',
  overtime_threshold REAL DEFAULT 40,
  overtime_rate REAL DEFAULT 1.5,
  settings JSON DEFAULT '{}',
  status TEXT DEFAULT 'active',
  total_employees INTEGER DEFAULT 0,
  total_payroll_ytd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  employee_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  ssn_last4 TEXT,
  date_of_birth TEXT,
  hire_date TEXT NOT NULL,
  termination_date TEXT,
  department TEXT,
  job_title TEXT,
  manager_id INTEGER,
  employment_type TEXT DEFAULT 'full-time',
  pay_type TEXT DEFAULT 'salary',
  pay_rate REAL NOT NULL DEFAULT 0,
  annual_salary REAL DEFAULT 0,
  filing_status TEXT DEFAULT 'single',
  allowances INTEGER DEFAULT 0,
  additional_withholding REAL DEFAULT 0,
  state_filing_status TEXT,
  direct_deposit JSON DEFAULT '[]',
  deductions JSON DEFAULT '[]',
  benefits JSON DEFAULT '[]',
  pto_balance REAL DEFAULT 0,
  sick_balance REAL DEFAULT 0,
  ytd_gross REAL DEFAULT 0,
  ytd_net REAL DEFAULT 0,
  ytd_federal_tax REAL DEFAULT 0,
  ytd_state_tax REAL DEFAULT 0,
  ytd_social_security REAL DEFAULT 0,
  ytd_medicare REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id, status);

CREATE TABLE IF NOT EXISTS pay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  pay_period_start TEXT NOT NULL,
  pay_period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  type TEXT DEFAULT 'regular',
  total_gross REAL DEFAULT 0,
  total_deductions REAL DEFAULT 0,
  total_taxes REAL DEFAULT 0,
  total_net REAL DEFAULT 0,
  total_employer_taxes REAL DEFAULT 0,
  employee_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  approved_by TEXT,
  approved_at TEXT,
  processed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payruns_company ON pay_runs(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payruns_date ON pay_runs(pay_date);

CREATE TABLE IF NOT EXISTS pay_stubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pay_run_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  hours_regular REAL DEFAULT 0,
  hours_overtime REAL DEFAULT 0,
  hours_pto REAL DEFAULT 0,
  hours_sick REAL DEFAULT 0,
  hours_holiday REAL DEFAULT 0,
  gross_pay REAL DEFAULT 0,
  regular_pay REAL DEFAULT 0,
  overtime_pay REAL DEFAULT 0,
  bonus REAL DEFAULT 0,
  commission REAL DEFAULT 0,
  reimbursement REAL DEFAULT 0,
  federal_tax REAL DEFAULT 0,
  state_tax REAL DEFAULT 0,
  local_tax REAL DEFAULT 0,
  social_security REAL DEFAULT 0,
  medicare REAL DEFAULT 0,
  total_taxes REAL DEFAULT 0,
  deductions_pretax REAL DEFAULT 0,
  deductions_posttax REAL DEFAULT 0,
  total_deductions REAL DEFAULT 0,
  net_pay REAL DEFAULT 0,
  employer_ss REAL DEFAULT 0,
  employer_medicare REAL DEFAULT 0,
  employer_futa REAL DEFAULT 0,
  employer_suta REAL DEFAULT 0,
  employer_total REAL DEFAULT 0,
  deduction_details JSON DEFAULT '[]',
  benefit_details JSON DEFAULT '[]',
  earnings_details JSON DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(pay_run_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_paystubs_employee ON pay_stubs(employee_id);
CREATE INDEX IF NOT EXISTS idx_paystubs_payrun ON pay_stubs(pay_run_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 0,
  type TEXT DEFAULT 'regular',
  description TEXT,
  approved INTEGER DEFAULT 0,
  approved_by TEXT,
  pay_run_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_entries_emp ON time_entries(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_time_entries_company ON time_entries(company_id, date);

CREATE TABLE IF NOT EXISTS tax_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  period TEXT NOT NULL,
  year INTEGER NOT NULL,
  quarter INTEGER,
  total_wages REAL DEFAULT 0,
  total_tax REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  due_date TEXT,
  filed_at TEXT,
  details JSON DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, type, period)
);

CREATE TABLE IF NOT EXISTS compliance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  status TEXT DEFAULT 'pending',
  completed_at TEXT,
  details JSON DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  payroll_total REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  employee_count INTEGER DEFAULT 0,
  new_hires INTEGER DEFAULT 0,
  terminations INTEGER DEFAULT 0,
  UNIQUE(company_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
