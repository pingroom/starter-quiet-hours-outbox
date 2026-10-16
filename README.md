# PingRoom quiet-hours outbox

Queue notifications from a local workflow and send each one after your configured quiet hours end. Jobs keep their own messages and links. Queued jobs that expire are not sent; their receipts are retained.

Use this when a report, import, or background task finishes overnight and its notification can wait until morning. The starter handles delivery timing; your application decides what to say and when that information becomes stale.

## Try it offline

Requires Node.js 22 or newer. Create a repository with **Use this template**, clone it, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses a fixed clock and temporary state. Two jobs wait at 22:30; at 08:00 one send is simulated and the stale job expires. Repeating the run sends nothing. The demo reads no credentials and makes no network requests. Tests also exercise the real pinned CLI against a local mock API.

Uses `@pingroom/cli` 0.12.0, pinned with a lockfile. The 14-day npm release-age policy remains enabled. CI runs tests and the demo on Node 22 and 24.

## Connect and set quiet hours

Install or open [PingRoom](https://pingroom.io/i), sign in, then:

```sh
cp config.example.json config.json
cp .env.example .env
npm run connect
```

Open the CLI's pairing link, claim the robot, and choose its home room. Keep the process open until pairing finishes. Credentials default to this project's ignored `.pingroom/` directory. Setting `PINGROOM_HOME` in your environment or `.env` selects another connection directory; connecting again can replace its saved credential.

For unattended use, set both `PINGROOM_TOKEN` and `PINGROOM_ROOM` in `.env` or your process environment. Leave both unset to use the saved connection. Partial or blank environment values fail without falling back to saved credentials. CI requires the explicit pair. Commands load `.env` from the project directory; existing environment values take precedence.

Edit `config.json` before the first enqueue:

```json
{
  "timeZone": "America/New_York",
  "quietStart": "22:00",
  "quietEnd": "08:00",
  "stateDirectory": ".outbox"
}
```

Use a named timezone supported by Node, such as `America/New_York`, `Europe/London`, `Asia/Dubai`, or `UTC`. Quiet hours include the start minute and exclude the end minute. Overnight and daytime windows work; equal endpoints are rejected. The state path is relative to this project or can be absolute. Choose a dedicated directory on a persistent local filesystem.

Every send attempt checks the timezone's current wall clock. During a repeated daylight-saving hour, both occurrences follow the same quiet rule. A skipped hour has no actual minutes to check. Keep Node's timezone data current; the starter does not calculate a future UTC opening time. See [Node's internationalization support](https://nodejs.org/api/intl.html).

## Enqueue a notification

Your producer writes a completed UTF-8 JSON file with these fields:

```json
{
  "id": "report-2030-10-16",
  "title": "Report ready",
  "message": "Your weekly report is ready to open.",
  "expiresAt": "2030-10-17T20:00:00.000Z",
  "url": "https://example.com/reports/weekly"
}
```

Use your own stable job ID, content, link, and future expiry. The example's 2030 date is for the offline demo. Then:

```sh
npm run enqueue -- /absolute/path/to/job.json
npm start
npm run status
```

Enqueue copies the job into durable state; it sends nothing. Editing or deleting the source file afterward does not change the accepted job. `npm start` drains once and exits. Outside quiet hours, a run attempts at most 20 jobs in enqueue order, skipping records that already have an outcome. Unknown outcomes do not prevent other jobs from being attempted.

Job rules:

- `id`: 1–80 ASCII letters, digits, dots, underscores, colons, or hyphens; the first character must be a letter or digit. Use the same ID for retries of the same producer operation.
- `title` and `message`: nonblank text without control characters; limits are 40 and 120 UTF-16 code units. Emoji may count as two units. Text is not truncated.
- `expiresAt`: a real UTC timestamp with milliseconds and `Z`. A new job must not already be expired. Queued work is never attempted at or after its expiry.
- `url`: optional HTTP(S) link, up to 2048 characters, without embedded credentials. It becomes an **Open** button; the starter does not fetch it.
- No extra or duplicate fields; files must be at most 8 KiB. Close each producer file before enqueueing it.

An identical ID and payload returns the existing status without another send. Reusing an ID with different content or a different expiry fails, including after delivery or expiration. A new notification needs a new ID. Keep producer job files in the ignored `jobs/` directory if you store them inside this project.

## Run from your scheduler

Poll once per minute with your existing scheduler. For example, replace the three absolute paths below and add this entry to your own crontab:

```cron
* * * * * cd /absolute/path/to/starter-quiet-hours-outbox && /absolute/path/to/node scripts/outbox.mjs drain >> /absolute/path/to/outbox.log 2>&1
```

The cron entry runs every minute regardless of the machine's timezone; the configured `timeZone` controls quiet hours. The starter does not install a scheduler. A stopped worker or a backlog can cause jobs to expire before delivery. All enqueue and drain commands must share the same state directory on one host; separate machines or temporary CI workers do not share the local lock.

The policy gates when the CLI attempt begins. A request already in flight, or delayed phone delivery, can arrive during quiet hours. This does not change a room's mute settings or a recipient's Focus settings, and sends do not use the urgent flag.

## Resolve uncertain delivery

Before starting the CLI, the outbox durably records `sending`. A valid notification ID is required to mark it `sent`. An error, timeout, malformed response, or crash may leave delivery uncertain. That record is never retried automatically and never auto-expires. `npm start` and `npm run status` report unresolved IDs and exit nonzero while any remain.

Inspect the PingRoom room, then choose one resolution:

```sh
npm run resolve -- report-2030-10-16 confirmed
npm run resolve -- report-2030-10-16 abandoned
```

Use `confirmed` after verifying the notification arrived, or `abandoned` to accept that it will not be retried. Both retain the ID and send nothing. The starter favors avoiding duplicate attempts over guaranteed delivery; it does not guarantee exactly-once delivery.

Preserve and back up `.outbox/state.json`. Removing it loses accepted jobs and replay protection. State is bound to the canonical timezone, quiet window, room, and token; changing these requires restoring the original settings or a deliberate migration that preserves jobs and receipts. There is no automatic migration or credential-rotation command.

The store permits 1000 pending or uncertain jobs, 10,000 total records, and 8 MiB. At capacity it rejects new jobs; it does not silently evict history. Drain expired work and resolve uncertainties, then plan archival or migration if needed. Terminal receipts remain to prevent ID reuse.

All commands share an exclusive lock. After a crash, verify no worker uses the store, inspect its records, then remove only `.outbox/run.lock/` if it remains. Never remove `state.json` to clear a lock. POSIX state files use mode `0600`, and state directories use `0700`.

Tokens stay out of command arguments and state. Delivery uses a separate temporary CLI home with explicit credentials and the production API; ambient webhook and API settings cannot redirect it. Raw upstream errors and message bodies are not logged.

For other workflows, see [daily digests](https://github.com/pingroom/starter-daily-digest), [calendar reminders](https://github.com/pingroom/starter-calendar-reminders), and [job progress](https://github.com/pingroom/starter-job-progress).

MIT licensed. See [LICENSE](LICENSE).
