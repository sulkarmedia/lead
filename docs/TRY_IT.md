# Try Leadline on your computer

Practice mode: nothing is texted or emailed to anyone. About 15 minutes the first time.

## 1. Install (once)
- **Node.js 22** — https://nodejs.org (LTS installer)
- **PostgreSQL 16**
  - Mac: `brew install postgresql@16 && brew link postgresql@16 --force` (needs Homebrew, https://brew.sh)
  - Windows: use WSL (Ubuntu), then `sudo apt install postgresql-16`
- **Git** — Mac has it; otherwise https://git-scm.com

## 2. Get the code and set it up
```bash
git clone https://github.com/sulkarmedia/lead.git
cd lead
npm install
npm run setup:local
```
`setup:local` creates a `.env` file in practice mode, starts a private database on port 54329, and loads a demo BMW dealership with 25 leads, a team and a week of appointments.

## 3. Run it (two terminal windows)
```bash
npm run dev      # the website
npm run worker   # the background worker that sends, follows up and books
```
Open http://localhost:3000/login and click a demo user:
- `owner@demo.leadline.test` — sees everything (dashboard, settings, setup)
- `sam@demo.leadline.test` — a sales rep (inbox, their leads)
- `admin@leadline.test` — platform admin (`/admin`)

## 4. Things to try
1. **Simulator** → create a fake lead → watch the first text appear on the phone mockup.
2. Approve it (approval mode is on for the first two weeks) → text back as the lead, e.g. "I'd like to come in this week" → tick *skip wait* → the AI offers two times → reply "the first one" → it books.
3. Text "How much is the lease per month?" → the AI hands off to the rep; see it in **Inbox** with the 10-minute timer.
4. Open the lead, reply as the rep (the AI pauses), then **Hand back to AI**.
5. Text "STOP" → texting ends with one confirmation.
6. **Advance 1 day** in the simulator to watch follow-ups go out at the right times.
7. Drag cards on **Leads**, check **Calendar** and **Dashboard**, edit the playbook in **Settings → Playbook** and use its test chat.

## Real AI vs. the stand-in
Without an Anthropic key, AI replies come from a simple rule-based stand-in (good for clicking around, not for judging quality). To use Claude, put your key in `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
and restart both commands. Practice mode still stops anything from being sent.

## Start over
Stop both commands, delete the `.localdb` folder and the `.env` file, and run `npm run setup:local` again.
