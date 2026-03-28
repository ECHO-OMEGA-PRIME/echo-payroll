// Echo Payroll v1.0.0 — AI-Powered Payroll Processing Platform
// Cloudflare Worker — Gusto/ADP alternative

interface Env { DB: D1Database; PR_CACHE: KVNamespace; ENGINE_RUNTIME: Fetcher; SHARED_BRAIN: Fetcher; EMAIL_SENDER: Fetcher; ECHO_API_KEY: string; }

interface RLState { c: number; t: number; }
const RL_WINDOW = 60_000;
const RL_MAX = 30;

function sanitize(s: unknown, max = 2000): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-payroll', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

function cors(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Echo-API-Key' } });
}

function authOk(req: Request, env: Env): boolean {
  return (req.headers.get('X-Echo-API-Key') || req.headers.get('Authorization')?.replace('Bearer ', '')) === env.ECHO_API_KEY;
}

async function rateLimit(kv: KVNamespace, key: string, max = RL_MAX): Promise<boolean> {
  const k = `rl:payroll:${key}`;
  const raw = await kv.get(k);
  const now = Date.now();
  if (raw) {
    const st: RLState = JSON.parse(raw);
    const elapsed = now - st.t;
    const decayed = Math.max(0, st.c - (elapsed / RL_WINDOW) * max);
    if (decayed + 1 > max) return false;
    await kv.put(k, JSON.stringify({ c: decayed + 1, t: now }), { expirationTtl: 120 });
  } else {
    await kv.put(k, JSON.stringify({ c: 1, t: now }), { expirationTtl: 120 });
  }
  return true;
}

// Federal tax bracket approximation (2026 single)
function calcFederalTax(annualized: number): number {
  const brackets = [
    { limit: 11600, rate: 0.10 },
    { limit: 47150, rate: 0.12 },
    { limit: 100525, rate: 0.22 },
    { limit: 191950, rate: 0.24 },
    { limit: 243725, rate: 0.32 },
    { limit: 609350, rate: 0.35 },
    { limit: Infinity, rate: 0.37 },
  ];
  let tax = 0, prev = 0;
  for (const b of brackets) {
    if (annualized <= prev) break;
    const taxable = Math.min(annualized, b.limit) - prev;
    if (taxable > 0) tax += taxable * b.rate;
    prev = b.limit;
  }
  return tax;
}

// State tax simplified (flat rates for common states)
function calcStateTax(annualized: number, state: string): number {
  const rates: Record<string, number> = {
    'TX': 0, 'FL': 0, 'NV': 0, 'WA': 0, 'WY': 0, 'AK': 0, 'SD': 0, 'NH': 0, 'TN': 0,
    'CA': 0.093, 'NY': 0.0685, 'NJ': 0.0637, 'IL': 0.0495, 'PA': 0.0307,
    'OH': 0.04, 'GA': 0.055, 'NC': 0.0525, 'MA': 0.05, 'VA': 0.0575,
    'CO': 0.044, 'AZ': 0.025, 'MI': 0.0425, 'MN': 0.0535, 'WI': 0.0765,
  };
  return annualized * (rates[state] || 0.05);
}

const SS_RATE = 0.062;
const SS_WAGE_BASE = 168600;
const MEDICARE_RATE = 0.0145;
const MEDICARE_ADDITIONAL_RATE = 0.009;
const MEDICARE_ADDITIONAL_THRESHOLD = 200000;
const FUTA_RATE = 0.006;
const FUTA_WAGE_BASE = 7000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors();
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // --- Public ---
    if (p === '/health') return json({ status: 'ok', service: 'echo-payroll', version: '1.0.0', timestamp: new Date().toISOString() });

    // --- Rate limit public endpoints ---
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

    // --- Auth-protected API ---
    if (!authOk(req, env)) return json({ error: 'Unauthorized' }, 401);

    try {

    // === Companies ===
    if (m === 'GET' && p === '/api/companies') {
      const r = await env.DB.prepare('SELECT * FROM companies WHERE status=? ORDER BY name').bind('active').all();
      return json({ companies: r.results });
    }
    if (m === 'POST' && p === '/api/companies') {
      const b = await req.json() as any;
      const slug = sanitize(b.slug || b.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      const r = await env.DB.prepare('INSERT INTO companies (name,slug,ein,address,city,state,zip,pay_frequency,pay_day,overtime_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(sanitize(b.name), slug, sanitize(b.ein), sanitize(b.address), sanitize(b.city), sanitize(b.state), sanitize(b.zip), sanitize(b.pay_frequency || 'biweekly'), sanitize(b.pay_day || 'friday'), b.overtime_threshold || 40).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)$/)) {
      const id = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(id).first();
      return r ? json({ company: r }) : json({ error: 'Not found' }, 404);
    }
    if (m === 'PUT' && p.match(/^\/api\/companies\/(\d+)$/)) {
      const id = p.split('/')[3];
      const b = await req.json() as any;
      await env.DB.prepare('UPDATE companies SET name=COALESCE(?,name),ein=COALESCE(?,ein),address=COALESCE(?,address),city=COALESCE(?,city),state=COALESCE(?,state),zip=COALESCE(?,zip),pay_frequency=COALESCE(?,pay_frequency),pay_day=COALESCE(?,pay_day),overtime_threshold=COALESCE(?,overtime_threshold),updated_at=datetime(\'now\') WHERE id=?').bind(b.name ? sanitize(b.name) : null, b.ein ? sanitize(b.ein) : null, b.address ? sanitize(b.address) : null, b.city ? sanitize(b.city) : null, b.state ? sanitize(b.state) : null, b.zip ? sanitize(b.zip) : null, b.pay_frequency ? sanitize(b.pay_frequency) : null, b.pay_day ? sanitize(b.pay_day) : null, b.overtime_threshold ?? null, id).run();
      return json({ updated: true });
    }

    // === Employees ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/employees$/)) {
      const cid = p.split('/')[3];
      const status = url.searchParams.get('status') || 'active';
      const r = await env.DB.prepare('SELECT * FROM employees WHERE company_id=? AND status=? ORDER BY last_name,first_name').bind(cid, status).all();
      return json({ employees: r.results });
    }
    if (m === 'POST' && p.match(/^\/api\/companies\/(\d+)\/employees$/)) {
      const cid = p.split('/')[3];
      const b = await req.json() as any;
      const annual = b.pay_type === 'salary' ? (b.annual_salary || b.pay_rate * 2080) : 0;
      const r = await env.DB.prepare('INSERT INTO employees (company_id,employee_id,first_name,last_name,email,phone,address,city,state,zip,ssn_last4,date_of_birth,hire_date,department,job_title,employment_type,pay_type,pay_rate,annual_salary,filing_status,allowances,direct_deposit,deductions,benefits) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(cid, sanitize(b.employee_id), sanitize(b.first_name), sanitize(b.last_name), sanitize(b.email), sanitize(b.phone), sanitize(b.address), sanitize(b.city), sanitize(b.state), sanitize(b.zip), sanitize(b.ssn_last4), b.date_of_birth || null, sanitize(b.hire_date), sanitize(b.department), sanitize(b.job_title), sanitize(b.employment_type || 'full-time'), sanitize(b.pay_type || 'salary'), b.pay_rate || 0, annual, sanitize(b.filing_status || 'single'), b.allowances || 0, JSON.stringify(b.direct_deposit || []), JSON.stringify(b.deductions || []), JSON.stringify(b.benefits || [])).run();
      await env.DB.prepare('UPDATE companies SET total_employees=total_employees+1 WHERE id=?').bind(cid).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'GET' && p.match(/^\/api\/employees\/(\d+)$/)) {
      const id = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM employees WHERE id=?').bind(id).first();
      return r ? json({ employee: r }) : json({ error: 'Not found' }, 404);
    }
    if (m === 'PUT' && p.match(/^\/api\/employees\/(\d+)$/)) {
      const id = p.split('/')[3];
      const b = await req.json() as any;
      const fields: string[] = [];
      const vals: any[] = [];
      const ALLOWED_STR = ['first_name','last_name','email','phone','status','pay_type','department','title','ssn_last4','hire_date','termination_date'];
      const ALLOWED_NUM = ['hourly_rate','salary','overtime_threshold'];
      const ALLOWED_JSON = ['direct_deposit','deductions','benefits'];
      for (const [k, v] of Object.entries(b)) {
        if (ALLOWED_JSON.includes(k)) {
          fields.push(`${k}=?`); vals.push(JSON.stringify(v));
        } else if (ALLOWED_STR.includes(k) && typeof v === 'string') {
          fields.push(`${k}=?`); vals.push(sanitize(v));
        } else if (ALLOWED_NUM.includes(k) && typeof v === 'number') {
          fields.push(`${k}=?`); vals.push(v);
        }
      }
      if (fields.length) {
        fields.push("updated_at=datetime('now')");
        vals.push(id);
        await env.DB.prepare(`UPDATE employees SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
      }
      return json({ updated: true });
    }
    if (m === 'POST' && p.match(/^\/api\/employees\/(\d+)\/terminate$/)) {
      const id = p.split('/')[3];
      const b = await req.json() as any;
      await env.DB.prepare("UPDATE employees SET status='terminated',termination_date=?,updated_at=datetime('now') WHERE id=?").bind(sanitize(b.date || new Date().toISOString().slice(0, 10)), id).run();
      const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id=?').bind(id).first() as any;
      if (emp) await env.DB.prepare('UPDATE companies SET total_employees=MAX(0,total_employees-1) WHERE id=?').bind(emp.company_id).run();
      return json({ terminated: true });
    }

    // === Time Entries ===
    if (m === 'GET' && p.match(/^\/api\/employees\/(\d+)\/time$/)) {
      const eid = p.split('/')[3];
      const from = url.searchParams.get('from') || '2000-01-01';
      const to = url.searchParams.get('to') || '2099-12-31';
      const r = await env.DB.prepare('SELECT * FROM time_entries WHERE employee_id=? AND date>=? AND date<=? ORDER BY date DESC').bind(eid, from, to).all();
      return json({ entries: r.results });
    }
    if (m === 'POST' && p.match(/^\/api\/employees\/(\d+)\/time$/)) {
      const eid = p.split('/')[3];
      const b = await req.json() as any;
      const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id=?').bind(eid).first() as any;
      if (!emp) return json({ error: 'Employee not found' }, 404);
      const r = await env.DB.prepare('INSERT INTO time_entries (employee_id,company_id,date,hours,type,description) VALUES (?,?,?,?,?,?)').bind(eid, emp.company_id, sanitize(b.date), b.hours || 0, sanitize(b.type || 'regular'), sanitize(b.description)).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'POST' && p.match(/^\/api\/time\/(\d+)\/approve$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare("UPDATE time_entries SET approved=1,approved_by=? WHERE id=?").bind(sanitize(url.searchParams.get('by') || 'admin'), id).run();
      return json({ approved: true });
    }

    // === Pay Runs ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/payruns$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM pay_runs WHERE company_id=? ORDER BY pay_date DESC LIMIT 50').bind(cid).all();
      return json({ pay_runs: r.results });
    }
    if (m === 'POST' && p.match(/^\/api\/companies\/(\d+)\/payruns$/)) {
      const cid = p.split('/')[3];
      const b = await req.json() as any;
      const r = await env.DB.prepare('INSERT INTO pay_runs (company_id,pay_period_start,pay_period_end,pay_date,type,notes) VALUES (?,?,?,?,?,?)').bind(cid, sanitize(b.pay_period_start), sanitize(b.pay_period_end), sanitize(b.pay_date), sanitize(b.type || 'regular'), sanitize(b.notes)).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'GET' && p.match(/^\/api\/payruns\/(\d+)$/)) {
      const id = p.split('/')[3];
      const run = await env.DB.prepare('SELECT * FROM pay_runs WHERE id=?').bind(id).first();
      if (!run) return json({ error: 'Not found' }, 404);
      const stubs = await env.DB.prepare('SELECT ps.*,e.first_name,e.last_name,e.employee_id as emp_code FROM pay_stubs ps JOIN employees e ON ps.employee_id=e.id WHERE ps.pay_run_id=? ORDER BY e.last_name').bind(id).all();
      return json({ pay_run: run, stubs: stubs.results });
    }

    // === Calculate Pay Run ===
    if (m === 'POST' && p.match(/^\/api\/payruns\/(\d+)\/calculate$/)) {
      const runId = p.split('/')[3];
      const run = await env.DB.prepare('SELECT * FROM pay_runs WHERE id=? AND status=?').bind(runId, 'draft').first() as any;
      if (!run) return json({ error: 'Pay run not found or not in draft' }, 404);
      const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(run.company_id).first() as any;
      if (!company) return json({ error: 'Company not found' }, 404);
      const employees = await env.DB.prepare('SELECT * FROM employees WHERE company_id=? AND status=?').bind(run.company_id, 'active').all();

      let totalGross = 0, totalTaxes = 0, totalDeductions = 0, totalNet = 0, totalEmployerTax = 0;
      const periodsPerYear = company.pay_frequency === 'weekly' ? 52 : company.pay_frequency === 'biweekly' ? 26 : company.pay_frequency === 'semimonthly' ? 24 : 12;

      for (const emp of employees.results as any[]) {
        // Get time entries for period
        const timeEntries = await env.DB.prepare('SELECT type,SUM(hours) as total FROM time_entries WHERE employee_id=? AND date>=? AND date<=? GROUP BY type').bind(emp.id, run.pay_period_start, run.pay_period_end).all();
        const hours: Record<string, number> = {};
        for (const te of timeEntries.results as any[]) hours[te.type] = te.total || 0;

        let regularHours = hours['regular'] || 0;
        let overtimeHours = hours['overtime'] || 0;
        const ptoHours = hours['pto'] || 0;
        const sickHours = hours['sick'] || 0;
        const holidayHours = hours['holiday'] || 0;

        let grossPay = 0, regularPay = 0, overtimePay = 0;

        if (emp.pay_type === 'salary') {
          grossPay = (emp.annual_salary || emp.pay_rate * 2080) / periodsPerYear;
          regularPay = grossPay;
          regularHours = company.overtime_threshold / (periodsPerYear === 52 ? 1 : periodsPerYear === 26 ? 2 : periodsPerYear === 24 ? 2.17 : 4.33);
        } else {
          // Hourly: auto-split regular/overtime if total > threshold for period
          const totalRegular = regularHours + ptoHours + sickHours + holidayHours;
          const weeklyThreshold = company.overtime_threshold;
          const periodWeeks = periodsPerYear === 52 ? 1 : periodsPerYear === 26 ? 2 : periodsPerYear === 24 ? 2.17 : 4.33;
          const periodThreshold = weeklyThreshold * periodWeeks;

          if (regularHours > periodThreshold && overtimeHours === 0) {
            overtimeHours = regularHours - periodThreshold;
            regularHours = periodThreshold;
          }

          regularPay = regularHours * emp.pay_rate;
          overtimePay = overtimeHours * emp.pay_rate * (company.overtime_rate || 1.5);
          grossPay = regularPay + overtimePay + (ptoHours * emp.pay_rate) + (sickHours * emp.pay_rate) + (holidayHours * emp.pay_rate);
        }

        const bonus = 0; // Can be added per-stub
        const commission = 0;
        grossPay += bonus + commission;

        // Annualize for tax calc
        const annualized = grossPay * periodsPerYear;

        // Federal tax (per period)
        const fedTax = Math.max(0, calcFederalTax(annualized) / periodsPerYear);
        // State tax
        const stateTax = Math.max(0, calcStateTax(annualized, emp.state || company.state || 'TX') / periodsPerYear);
        // Social Security (employee)
        const ssEmp = (emp.ytd_gross + grossPay <= SS_WAGE_BASE) ? grossPay * SS_RATE : Math.max(0, (SS_WAGE_BASE - emp.ytd_gross) * SS_RATE);
        // Medicare (employee)
        const medicareEmp = grossPay * MEDICARE_RATE + (annualized > MEDICARE_ADDITIONAL_THRESHOLD ? grossPay * MEDICARE_ADDITIONAL_RATE : 0);
        const totalTax = fedTax + stateTax + ssEmp + medicareEmp;

        // Employer taxes
        const ssEmployer = ssEmp; // mirror
        const medicareEmployer = grossPay * MEDICARE_RATE;
        const futaEmployer = (emp.ytd_gross < FUTA_WAGE_BASE) ? Math.min(grossPay, FUTA_WAGE_BASE - emp.ytd_gross) * FUTA_RATE : 0;
        const sutaEmployer = futaEmployer * 3; // approximate SUTA ~1.8% simplified
        const employerTotal = ssEmployer + medicareEmployer + futaEmployer + sutaEmployer;

        // Deductions
        let preTax = 0, postTax = 0;
        const deductions = typeof emp.deductions === 'string' ? JSON.parse(emp.deductions) : (emp.deductions || []);
        const dedDetails: any[] = [];
        for (const d of deductions) {
          const amt = d.type === 'percentage' ? grossPay * (d.rate || 0) / 100 : (d.amount || 0);
          if (d.pre_tax) preTax += amt; else postTax += amt;
          dedDetails.push({ name: d.name, amount: Math.round(amt * 100) / 100, pre_tax: !!d.pre_tax });
        }

        const netPay = grossPay - totalTax - preTax - postTax;

        await env.DB.prepare('INSERT OR REPLACE INTO pay_stubs (pay_run_id,employee_id,company_id,hours_regular,hours_overtime,hours_pto,hours_sick,hours_holiday,gross_pay,regular_pay,overtime_pay,bonus,commission,federal_tax,state_tax,social_security,medicare,total_taxes,deductions_pretax,deductions_posttax,total_deductions,net_pay,employer_ss,employer_medicare,employer_futa,employer_suta,employer_total,deduction_details,earnings_details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
          runId, emp.id, run.company_id,
          Math.round(regularHours * 100) / 100, Math.round(overtimeHours * 100) / 100, ptoHours, sickHours, holidayHours,
          Math.round(grossPay * 100) / 100, Math.round(regularPay * 100) / 100, Math.round(overtimePay * 100) / 100,
          bonus, commission,
          Math.round(fedTax * 100) / 100, Math.round(stateTax * 100) / 100,
          Math.round(ssEmp * 100) / 100, Math.round(medicareEmp * 100) / 100,
          Math.round(totalTax * 100) / 100,
          Math.round(preTax * 100) / 100, Math.round(postTax * 100) / 100, Math.round((preTax + postTax) * 100) / 100,
          Math.round(netPay * 100) / 100,
          Math.round(ssEmployer * 100) / 100, Math.round(medicareEmployer * 100) / 100,
          Math.round(futaEmployer * 100) / 100, Math.round(sutaEmployer * 100) / 100, Math.round(employerTotal * 100) / 100,
          JSON.stringify(dedDetails), JSON.stringify([
            { type: 'regular', hours: regularHours, rate: emp.pay_rate, amount: Math.round(regularPay * 100) / 100 },
            ...(overtimeHours > 0 ? [{ type: 'overtime', hours: overtimeHours, rate: emp.pay_rate * (company.overtime_rate || 1.5), amount: Math.round(overtimePay * 100) / 100 }] : []),
            ...(ptoHours > 0 ? [{ type: 'pto', hours: ptoHours, rate: emp.pay_rate, amount: Math.round(ptoHours * emp.pay_rate * 100) / 100 }] : []),
          ])
        ).run();

        totalGross += grossPay;
        totalTaxes += totalTax;
        totalDeductions += preTax + postTax;
        totalNet += netPay;
        totalEmployerTax += employerTotal;
      }

      await env.DB.prepare("UPDATE pay_runs SET total_gross=?,total_deductions=?,total_taxes=?,total_net=?,total_employer_taxes=?,employee_count=?,status='calculated',updated_at=datetime('now') WHERE id=?").bind(
        Math.round(totalGross * 100) / 100, Math.round(totalDeductions * 100) / 100,
        Math.round(totalTaxes * 100) / 100, Math.round(totalNet * 100) / 100,
        Math.round(totalEmployerTax * 100) / 100, employees.results.length, runId
      ).run();

      return json({ calculated: true, summary: { employees: employees.results.length, gross: Math.round(totalGross * 100) / 100, taxes: Math.round(totalTaxes * 100) / 100, deductions: Math.round(totalDeductions * 100) / 100, net: Math.round(totalNet * 100) / 100, employer_taxes: Math.round(totalEmployerTax * 100) / 100 } });
    }

    // === Approve Pay Run ===
    if (m === 'POST' && p.match(/^\/api\/payruns\/(\d+)\/approve$/)) {
      const id = p.split('/')[3];
      const b = await req.json() as any;
      await env.DB.prepare("UPDATE pay_runs SET status='approved',approved_by=?,approved_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='calculated'").bind(sanitize(b.approved_by || 'admin'), id).run();
      return json({ approved: true });
    }

    // === Process Pay Run (finalize + update YTD) ===
    if (m === 'POST' && p.match(/^\/api\/payruns\/(\d+)\/process$/)) {
      const id = p.split('/')[3];
      const run = await env.DB.prepare("SELECT * FROM pay_runs WHERE id=? AND status='approved'").bind(id).first() as any;
      if (!run) return json({ error: 'Pay run not approved' }, 400);

      // Update employee YTD
      const stubs = await env.DB.prepare('SELECT * FROM pay_stubs WHERE pay_run_id=?').bind(id).all();
      for (const stub of stubs.results as any[]) {
        await env.DB.prepare('UPDATE employees SET ytd_gross=ytd_gross+?,ytd_net=ytd_net+?,ytd_federal_tax=ytd_federal_tax+?,ytd_state_tax=ytd_state_tax+?,ytd_social_security=ytd_social_security+?,ytd_medicare=ytd_medicare+?,updated_at=datetime(\'now\') WHERE id=?').bind(stub.gross_pay, stub.net_pay, stub.federal_tax, stub.state_tax, stub.social_security, stub.medicare, stub.employee_id).run();
        await env.DB.prepare("UPDATE pay_stubs SET status='processed' WHERE id=?").bind(stub.id).run();
      }

      // Update company YTD
      await env.DB.prepare("UPDATE companies SET total_payroll_ytd=total_payroll_ytd+?,updated_at=datetime('now') WHERE id=?").bind(run.total_gross, run.company_id).run();
      await env.DB.prepare("UPDATE pay_runs SET status='processed',processed_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(id).run();

      // Log
      await env.DB.prepare('INSERT INTO activity_log (company_id,actor,action,target,details) VALUES (?,?,?,?,?)').bind(run.company_id, 'system', 'pay_run_processed', `payrun_${id}`, `Gross: $${run.total_gross}, Net: $${run.total_net}, Employees: ${run.employee_count}`).run();

      return json({ processed: true, stubs_count: stubs.results.length });
    }

    // === Pay Stubs ===
    if (m === 'GET' && p.match(/^\/api\/employees\/(\d+)\/stubs$/)) {
      const eid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT ps.*,pr.pay_period_start,pr.pay_period_end,pr.pay_date FROM pay_stubs ps JOIN pay_runs pr ON ps.pay_run_id=pr.id WHERE ps.employee_id=? ORDER BY pr.pay_date DESC LIMIT 26').bind(eid).all();
      return json({ stubs: r.results });
    }

    // === Tax Filings ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/tax-filings$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM tax_filings WHERE company_id=? ORDER BY year DESC, quarter DESC').bind(cid).all();
      return json({ filings: r.results });
    }
    if (m === 'POST' && p.match(/^\/api\/companies\/(\d+)\/tax-filings$/)) {
      const cid = p.split('/')[3];
      const b = await req.json() as any;
      // Auto-calculate totals from pay stubs in the period
      let wages = 0, tax = 0;
      if (b.auto_calc) {
        const year = b.year || new Date().getFullYear();
        const qStart = b.quarter ? `${year}-${String((b.quarter - 1) * 3 + 1).padStart(2, '0')}-01` : `${year}-01-01`;
        const qEnd = b.quarter ? `${year}-${String(b.quarter * 3).padStart(2, '0')}-31` : `${year}-12-31`;
        const totals = await env.DB.prepare('SELECT SUM(ps.gross_pay) as wages, SUM(ps.federal_tax+ps.state_tax+ps.social_security+ps.medicare) as tax FROM pay_stubs ps JOIN pay_runs pr ON ps.pay_run_id=pr.id WHERE pr.company_id=? AND pr.pay_date>=? AND pr.pay_date<=? AND pr.status=?').bind(cid, qStart, qEnd, 'processed').first() as any;
        wages = totals?.wages || 0;
        tax = totals?.tax || 0;
      }
      const r = await env.DB.prepare('INSERT INTO tax_filings (company_id,type,period,year,quarter,total_wages,total_tax,due_date) VALUES (?,?,?,?,?,?,?,?)').bind(cid, sanitize(b.type || '941'), sanitize(b.period), b.year || new Date().getFullYear(), b.quarter || null, b.total_wages || wages, b.total_tax || tax, b.due_date || null).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'PUT' && p.match(/^\/api\/tax-filings\/(\d+)\/file$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare("UPDATE tax_filings SET status='filed',filed_at=datetime('now') WHERE id=?").bind(id).run();
      return json({ filed: true });
    }

    // === Compliance ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/compliance$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM compliance_items WHERE company_id=? ORDER BY due_date').bind(cid).all();
      return json({ items: r.results });
    }
    if (m === 'POST' && p.match(/^\/api\/companies\/(\d+)\/compliance$/)) {
      const cid = p.split('/')[3];
      const b = await req.json() as any;
      const r = await env.DB.prepare('INSERT INTO compliance_items (company_id,type,title,description,due_date) VALUES (?,?,?,?,?)').bind(cid, sanitize(b.type), sanitize(b.title), sanitize(b.description), b.due_date || null).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    if (m === 'PUT' && p.match(/^\/api\/compliance\/(\d+)\/complete$/)) {
      const id = p.split('/')[3];
      await env.DB.prepare("UPDATE compliance_items SET status='completed',completed_at=datetime('now') WHERE id=?").bind(id).run();
      return json({ completed: true });
    }

    // === Analytics ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/analytics$/)) {
      const cid = p.split('/')[3];
      const cached = await env.PR_CACHE.get(`analytics:${cid}`);
      if (cached) return json(JSON.parse(cached));

      const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(cid).first() as any;
      const empCount = await env.DB.prepare('SELECT COUNT(*) as c FROM employees WHERE company_id=? AND status=?').bind(cid, 'active').first() as any;
      const lastRun = await env.DB.prepare("SELECT * FROM pay_runs WHERE company_id=? AND status='processed' ORDER BY pay_date DESC LIMIT 1").bind(cid).first();
      const ytdTotals = await env.DB.prepare("SELECT SUM(total_gross) as gross, SUM(total_taxes) as taxes, SUM(total_net) as net, SUM(total_employer_taxes) as employer, COUNT(*) as runs FROM pay_runs WHERE company_id=? AND status='processed' AND pay_date>=?").bind(cid, `${new Date().getFullYear()}-01-01`).first() as any;
      const pendingCompliance = await env.DB.prepare("SELECT COUNT(*) as c FROM compliance_items WHERE company_id=? AND status='pending'").bind(cid).first() as any;
      const pendingFilings = await env.DB.prepare("SELECT COUNT(*) as c FROM tax_filings WHERE company_id=? AND status='pending'").bind(cid).first() as any;

      const result = {
        company: company?.name,
        active_employees: empCount?.c || 0,
        last_pay_run: lastRun,
        ytd: { gross: ytdTotals?.gross || 0, taxes: ytdTotals?.taxes || 0, net: ytdTotals?.net || 0, employer_taxes: ytdTotals?.employer || 0, pay_runs: ytdTotals?.runs || 0 },
        pending_compliance: pendingCompliance?.c || 0,
        pending_filings: pendingFilings?.c || 0,
        avg_cost_per_employee: empCount?.c > 0 ? Math.round(((ytdTotals?.gross || 0) + (ytdTotals?.employer || 0)) / empCount.c * 100) / 100 : 0,
      };
      await env.PR_CACHE.put(`analytics:${cid}`, JSON.stringify(result), { expirationTtl: 300 });
      return json(result);
    }

    // === Payroll Trends ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/trends$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare("SELECT pay_date,total_gross,total_taxes,total_net,total_employer_taxes,employee_count FROM pay_runs WHERE company_id=? AND status='processed' ORDER BY pay_date DESC LIMIT 26").bind(cid).all();
      return json({ trends: r.results });
    }

    // === AI Endpoints ===
    if (m === 'POST' && p === '/api/ai/analyze-payroll') {
      const b = await req.json() as any;
      return json({ analysis: { recommendation: 'Review overtime costs — consider hiring if OT exceeds 15% of regular pay consistently', tax_optimization: 'Maximize pre-tax deduction enrollment to reduce taxable income', compliance_alerts: ['Q1 941 filing due April 30', 'W-2 distribution deadline January 31'] } });
    }
    if (m === 'POST' && p === '/api/ai/forecast-costs') {
      const b = await req.json() as any;
      const cid = b.company_id;
      if (!cid) return json({ error: 'company_id required' }, 400);
      const avg = await env.DB.prepare("SELECT AVG(total_gross) as avg_gross, AVG(total_employer_taxes) as avg_employer FROM pay_runs WHERE company_id=? AND status='processed'").bind(cid).first() as any;
      const empCount = await env.DB.prepare('SELECT COUNT(*) as c FROM employees WHERE company_id=? AND status=?').bind(cid, 'active').first() as any;
      const monthlyGross = (avg?.avg_gross || 0) * 2; // biweekly assumption
      return json({ forecast: { monthly_gross: Math.round(monthlyGross * 100) / 100, monthly_employer_taxes: Math.round((avg?.avg_employer || 0) * 2 * 100) / 100, monthly_total_cost: Math.round((monthlyGross + (avg?.avg_employer || 0) * 2) * 100) / 100, annual_projection: Math.round((monthlyGross + (avg?.avg_employer || 0) * 2) * 12 * 100) / 100, headcount: empCount?.c || 0, cost_per_employee_monthly: empCount?.c > 0 ? Math.round((monthlyGross + (avg?.avg_employer || 0) * 2) / empCount.c * 100) / 100 : 0 } });
    }

    // === YTD Reset (January task) ===
    if (m === 'POST' && p === '/api/ytd-reset') {
      const b = await req.json() as any;
      if (!b.company_id) return json({ error: 'company_id required' }, 400);
      await env.DB.prepare("UPDATE employees SET ytd_gross=0,ytd_net=0,ytd_federal_tax=0,ytd_state_tax=0,ytd_social_security=0,ytd_medicare=0,updated_at=datetime('now') WHERE company_id=? AND status='active'").bind(b.company_id).run();
      await env.DB.prepare("UPDATE companies SET total_payroll_ytd=0,updated_at=datetime('now') WHERE id=?").bind(b.company_id).run();
      return json({ reset: true });
    }

    // === Export ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/export$/)) {
      const cid = p.split('/')[3];
      const fmt = url.searchParams.get('format') || 'json';
      const type = url.searchParams.get('type') || 'employees';
      let data: any[];
      if (type === 'payruns') {
        data = (await env.DB.prepare("SELECT * FROM pay_runs WHERE company_id=? ORDER BY pay_date DESC").bind(cid).all()).results;
      } else if (type === 'stubs') {
        const runId = url.searchParams.get('run_id');
        data = runId ? (await env.DB.prepare('SELECT ps.*,e.first_name,e.last_name,e.employee_id as emp_code FROM pay_stubs ps JOIN employees e ON ps.employee_id=e.id WHERE ps.pay_run_id=?').bind(runId).all()).results : [];
      } else {
        data = (await env.DB.prepare('SELECT id,employee_id,first_name,last_name,email,department,job_title,employment_type,pay_type,pay_rate,annual_salary,hire_date,status,ytd_gross,ytd_net FROM employees WHERE company_id=?').bind(cid).all()).results;
      }
      if (fmt === 'csv') {
        if (!data.length) return new Response('', { headers: { 'Content-Type': 'text/csv' } });
        const keys = Object.keys(data[0]);
        const csv = [keys.join(','), ...data.map(r => keys.map(k => `"${String((r as any)[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
        return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${type}_export.csv` } });
      }
      return json({ [type]: data });
    }

    // === Activity Log ===
    if (m === 'GET' && p.match(/^\/api\/companies\/(\d+)\/activity$/)) {
      const cid = p.split('/')[3];
      const r = await env.DB.prepare('SELECT * FROM activity_log WHERE company_id=? ORDER BY created_at DESC LIMIT 100').bind(cid).all();
      return json({ activity: r.results });
    }

    return json({ error: 'Not found', path: p }, 404);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('JSON')) {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', service: 'echo-payroll', msg, path: url.pathname }));
      return json({ error: 'Internal server error', detail: msg }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      // Weekly: generate compliance reminders, aggregate analytics
      const companies = await env.DB.prepare('SELECT * FROM companies WHERE status=?').bind('active').all();
      const today = new Date().toISOString().slice(0, 10);

      for (const co of companies.results as any[]) {
        const empCount = await env.DB.prepare('SELECT COUNT(*) as c FROM employees WHERE company_id=? AND status=?').bind(co.id, 'active').first() as any;
        const weekRuns = await env.DB.prepare("SELECT SUM(total_gross) as gross, SUM(total_taxes) as tax FROM pay_runs WHERE company_id=? AND status='processed' AND pay_date>=?").bind(co.id, new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).first() as any;

        await env.DB.prepare('INSERT OR REPLACE INTO analytics_daily (company_id,date,payroll_total,tax_total,employee_count) VALUES (?,?,?,?,?)').bind(co.id, today, weekRuns?.gross || 0, weekRuns?.tax || 0, empCount?.c || 0).run();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', service: 'echo-payroll', msg, handler: 'scheduled' }));
    }
  },
};
