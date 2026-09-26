# حجوزاتي — Hujuzati v2

Arabic (RTL) multi-business booking SaaS. Any business signs up, gets a public booking page at `/b/<slug>`, and manages everything from an owner dashboard. Customers get WhatsApp confirmations and reminders.

**Stack:** Vite + vanilla JS → Cloudflare Pages · Supabase (Postgres, Auth, Realtime, Edge Functions) · Meta WhatsApp Cloud API

## Features

- **Multi-business signup**: email/password auth, onboarding wizard, a unique slug per business.
- **Customer booking**: service → staff (or "any") → day and free time slot → name and phone → done. Customers can cancel themselves through the link in their WhatsApp message.
- **Owner dashboard** has five tabs:
  - daily appointments, with live updates and stats
  - manual (phone) bookings
  - services
  - staff
  - per-staff working hours
  - settings
- **No double bookings, ever**: a Postgres exclusion constraint blocks overlapping confirmed appointments for the same staff member, even when two requests race.
- **Security**: Row Level Security isolates each business. Anonymous users can only call four `SECURITY DEFINER` functions and never read tables directly.
- **WhatsApp**:
  - the customer gets a confirmation when they book
  - the owner gets an alert for each new booking
  - the customer gets a notice if the booking is cancelled
  - the customer gets a reminder about 24h before the appointment (pg_cron runs every 10 min)

## Project structure

```
index.html, signup.html, login.html, dashboard.html, book.html
src/
  styles.css
  lib/supabase.js      # client + session guard
  lib/ui.js            # helpers: escaping, dates (Asia/Jerusalem), phone normalisation
  pages/*.js           # one script per page
public/_redirects      # /b/*  → book.html (Cloudflare Pages)
supabase/
  migrations/0001_init.sql            # tables, RLS, booking RPCs
  migrations/0002_notifications.sql   # pg_net trigger + pg_cron reminders
  functions/whatsapp/index.ts         # Edge Function (Meta Cloud API)
  config.toml
```

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run the migrations in order. Either paste each file into the **SQL Editor**, or run:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```
3. Under **Authentication → URL Configuration**:
   - set **Site URL** to your Pages domain
   - add `https://<domain>/dashboard.html` to the redirect URLs
4. Optional: to skip email confirmation during testing, turn off **Authentication → Providers → Email → Confirm email**.

### 2. Frontend (local)

```bash
cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```
When running locally, open the booking page as `http://localhost:5173/book.html?b=<slug>`.

### 3. Deploy to Cloudflare Pages

1. Connect this GitHub repo to Cloudflare Pages.
2. Set **Build command** to `npm run build` and **Output dir** to `dist`.
3. Add the env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

### 4. WhatsApp notifications

1. **Create a Meta WhatsApp Business app.** Note the **Phone number ID** and create a **permanent access token**.
2. **Create these templates** (language: Arabic `ar`, category: Utility) and wait for Meta to approve them:

| Template name | Body |
|---|---|
| `booking_confirmed` | مرحبا {{1}} 👋 تم تأكيد حجزك عند {{2}}: {{3}} يوم {{4}} الساعة {{5}}. للإلغاء: {{6}} |
| `booking_reminder` | تذكير يا {{1}}: عندك موعد عند {{2}} — {{3}} يوم {{4}} الساعة {{5}}. للإلغاء: {{6}} |
| `booking_cancelled` | {{1}}، تم إلغاء موعدك عند {{2}} يوم {{3}} الساعة {{4}}. لحجز جديد: {{5}} |
| `owner_new_booking` | 🔔 حجز جديد: {{1}} ({{2}}) — {{3}} يوم {{4}} الساعة {{5}} |

3. **Deploy the function:**
   ```bash
   npx supabase secrets set WEBHOOK_SECRET=<random-long-string> \
     WHATSAPP_TOKEN=<token> WHATSAPP_PHONE_NUMBER_ID=<id> SITE_URL=https://<your-domain>
   npx supabase functions deploy whatsapp --no-verify-jwt
   ```
4. **Point the database at it** (run in the SQL Editor):
   ```sql
   update private.app_config set value = 'https://<ref>.supabase.co/functions/v1/whatsapp' where key = 'function_url';
   update private.app_config set value = '<same WEBHOOK_SECRET>' where key = 'webhook_secret';
   ```

If `WHATSAPP_TOKEN` is not set, the function runs in **dry-run** mode and only logs messages, which is useful for testing.

## Roadmap ideas

- Days off / holidays per staff member
- Link specific services to specific staff members
- Customer list and visit history
- Subscription billing per business
- Hebrew UI
