# Echo Payroll

> Payroll processing for ECHO Prime. Manage companies, run payroll and tax
> payments through Stripe, and use AI to analyze and forecast payroll costs. A
> Cloudflare Worker.

Private to Echo Prime Technologies.

## What it does

Register **companies**, process **payroll payments** and **tax payments** via
Stripe, reset **year-to-date** totals at period boundaries, and get AI
**analysis** and cost **forecasts** for payroll.

## API (auth: `X-Echo-API-Key`)

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/health` | Liveness |
| `*`    | `/api/companies` | Company management |
| `POST` | `/api/stripe/create-payroll-payment` | Process a payroll payment |
| `POST` | `/api/stripe/create-tax-payment` | Process a tax payment |
| `GET`  | `/api/stripe/payments` | Payment history |
| `POST` | `/api/ytd-reset` | Reset year-to-date totals |
| `POST` | `/api/ai/analyze-payroll` | AI payroll analysis |
| `POST` | `/api/ai/forecast-costs` | AI cost forecast |
| `POST` | `/admin/migrate-stripe` | Stripe migration (admin) |

## Develop

```bash
npm install
npx wrangler dev       # local Worker
npx wrangler deploy    # deploy
```

Stripe keys and the D1 binding live in `wrangler.toml` / the Cloudflare dashboard.
`.gitignore` excludes `node_modules`. Never commit secrets.

## License

Proprietary — © Echo Prime Technologies. All rights reserved.
