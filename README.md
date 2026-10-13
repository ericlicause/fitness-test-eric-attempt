# LiftLog

Keep logging your workouts in a paper notepad. After the session, type up the page (or take a photo of it), and LiftLog stores it, charts your progress over time, and gives you coaching insights you can turn into a training plan.

## What it does

- **Log from your notepad.** Type the shorthand you already write (`Bench 135x10, 155x8, 175x6`). A live preview shows exactly how each line was read, and flags anything it couldn't understand. You can paste several dated days at once to backfill old pages.
- **Scan a photo (optional).** Take a photo of the page and Claude transcribes it into the same shorthand. You check the text, then save.
- **Progress per lift.** Estimated 1RM over time (best reps for bodyweight moves, longest hold for timed ones), PRs, trend in % per month, rep-range mix, and every session listed.
- **Insights.** Training frequency and streaks, weekly volume, sets per muscle group compared with a 10–20 sets/week target, push:pull balance, rep-range mix, lifts that have stalled or slipped, and lifts you've stopped doing.
- **Next-session targets.** Uses double progression: add a rep until you reach the top of your rep range, then add weight. If a lift stalls, it suggests a deload.
- **Coach.** Builds a plain-text summary of your training that you can paste to a coach or any AI chat. With an API key, it can also write a 4-week plan from your actual numbers and goals.
- **Your data.** Stored in a single SQLite file. You can export it as JSON (a full backup) or CSV (for spreadsheets), and import a JSON backup.

## Run it

You need Node.js 22.13 or newer. There are no native dependencies.

```bash
npm install
npm start            # http://localhost:3000, data saved to data/liftlog.db
```

To try it with ~10 weeks of sample training first:

```bash
npm run demo         # seeds data/demo.db and starts the server on it
```

### Using it from your phone

The page is built for phones and can be added to your home screen. Your phone needs to reach the server:

- **Same Wi-Fi:** run `npm start` on your computer and open `http://<your-computer's-LAN-IP>:3000` on your phone.
- **Anywhere:** deploy it to any host that runs Node and has a persistent disk (Fly.io, Render, Railway, a small VPS). Set `LIFTLOG_DB` to a path on that disk.

There is no login. Anyone who can reach the URL can see and edit your log, so don't expose it publicly without putting it behind something like Tailscale, Cloudflare Access, or basic auth on a reverse proxy.

### Optional AI features

Photo scanning and plan generation use the Claude API. Everything else works without them.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

These use `claude-opus-5-5` by default (override with `LIFTLOG_MODEL`), and server-side refusal fallbacks are enabled. Each scan or plan costs a few cents in API usage.

### Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `LIFTLOG_DB` | `data/liftlog.db` | or pass `--db <path>` |
| `ANTHROPIC_API_KEY` | — | turns on scan + plan |
| `LIFTLOG_MODEL` | `claude-opus-5-5` | |

## Notepad shorthand

Mix these notations freely. Separate sets with commas, spaces or slashes.

| You write | Means |
|---|---|
| `Bench: 135x10, 155x8, 175x6` | weight × reps, one set each |
| `OHP 95 x 8, 8, 7` | bare numbers reuse the last weight |
| `Squat 225x5x3` | weight × reps × sets |
| `Incline DB 3x10 @ 50`, `Squat 225 5x5`, `3 sets of 10 at 30` | sets × reps at a weight |
| `Pullups bw x 12, 10`, `Dips bw+25 x 6` | bodyweight, optionally with added load |
| `Pushups 20, 15, 12` | reps only |
| `Plank 3x60s`, `1:30`, `2min` | timed sets |
| `175x6 @8`, `135x10 rpe 7` | RPE |
| `60kg x 8`, `135lb x 10` | units (otherwise the default unit from Settings) |
| `(felt easy)` | a note on that exercise |
| `10/12 Push day`, `2026-10-12`, `Oct 12` | a date line starts a new workout |
| `Notes: …` | workout notes |
| `Bench` on one line, then `135x10` / `155x8` below | multi-line sets |

A small first number means sets, not weight. `3x8` is read as 3 sets of 8. To log 5 lb × 15, write `5lb x 15`.

Exercise names are normalized, so `bench`, `BP` and `flat bench` all become **Bench Press**. Each exercise is mapped to a muscle group. Names the app doesn't recognize are kept as you wrote them and grouped by keyword.

## How the numbers work

- **Estimated 1RM** uses the Epley formula, `weight × (1 + reps/30)`, on your best set of 12 reps or fewer. This puts heavy and light days on the same scale. For sets of 13+ reps it uses the same formula as a rough progress signal.
- **Trend** is a least-squares slope over the last 8 weeks, shown as % per month.
- A lift is **stalled** after 4 sessions without a new best, or 3 sessions with a flat trend.
- **Weekly sets per muscle** is a 4-week average. Every logged set counts.

## Development

```bash
npm test
```

```
src/parser.js      notepad shorthand → structured workouts
src/exercises.js   name aliases + muscle groups
src/analytics.js   e1RM, PRs, trends, volume, insights, coach summary
src/db.js          SQLite (node:sqlite)
src/ai.js          Claude photo transcription + plan generation
src/server.js      JSON API + static files
public/            single-page frontend, dependency-free SVG charts
```
