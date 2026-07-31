'use strict';

// The remote run-request poller (scripts/poll-run-requests.sh) plus the run
// lock it shares with the nightly (scripts/run-lock.sh).
//
// These are real end-to-end shell runs, not source greps: each test builds a
// throwaway git fixture — a bare "origin", a "mac checkout" cloned from it,
// and the two scripts copied in — and then runs the poller against it exactly
// as launchd would. Local file remotes make fetch/push instant, so the
// perl-alarm timeouts stay in the code path being tested rather than being
// stubbed out.
//
// POLLER_TEST_MODE=1 replaces ONLY the final dispatch (the thing that would
// otherwise launch a real scrape) with a hardcoded `echo`. Everything else —
// fetch, JSON parse, id validation, the state file, the run lock, result
// building, the push to evidence-inbox — is the production path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_DIR = path.join(__dirname, '..');
const POLLER_SCRIPT = path.join(REPO_DIR, 'scripts', 'poll-run-requests.sh');
const RUN_LOCK_SCRIPT = path.join(REPO_DIR, 'scripts', 'run-lock.sh');
const RUN_SCRAPER_SCRIPT = path.join(REPO_DIR, 'scripts', 'run-scraper.sh');
const RUN_REVIEW_SCRIPT = path.join(REPO_DIR, 'scripts', 'run-review.sh');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A fixture is: origin.git (bare, branch main) <- seed (pushed once) -> checkout
// (a real clone, so origin/main exists exactly as it does on the Mac).
// `requestJson` is the literal content of config/run-requests.json on main.
function makeFixture(t, requestJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const checkoutDir = path.join(root, 'checkout');

  git(['init', '--bare', '--initial-branch=main', originDir], root);
  git(['init', '--initial-branch=main', seedDir], root);
  git(['config', 'user.name', 'Fixture'], seedDir);
  git(['config', 'user.email', 'fixture@example.com'], seedDir);

  fs.mkdirSync(path.join(seedDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(seedDir, 'config'), { recursive: true });
  fs.copyFileSync(POLLER_SCRIPT, path.join(seedDir, 'scripts', 'poll-run-requests.sh'));
  fs.copyFileSync(RUN_LOCK_SCRIPT, path.join(seedDir, 'scripts', 'run-lock.sh'));
  fs.writeFileSync(path.join(seedDir, 'config', 'run-requests.json'), requestJson);
  // data/ is gitignored in the real repo; mirror that so the poller's `git add
  // -f` for the result file is exercised the same way it is in production.
  fs.writeFileSync(path.join(seedDir, '.gitignore'), 'data/\n');

  git(['add', '-A'], seedDir);
  git(['commit', '-m', 'fixture'], seedDir);
  git(['remote', 'add', 'origin', originDir], seedDir);
  git(['push', '-u', 'origin', 'main'], seedDir);

  git(['clone', originDir, checkoutDir], root);
  git(['config', 'user.name', 'Fixture'], checkoutDir);
  git(['config', 'user.email', 'fixture@example.com'], checkoutDir);

  return { root, originDir, checkoutDir };
}

// "HH:MM", `minutes` from now, in local time — the same clock the poller and
// launchd both read.
function localTimeFromNow(minutes) {
  const at = new Date(Date.now() + minutes * 60000);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// The poller refuses to start a task when a scheduled scrape (02:00 / 12:30 in
// production) is close enough that the task could still be holding the shared
// run lock when the scrape fires. That makes the poller's behaviour depend on
// the wall clock, which a test suite must never inherit — a suite run at 01:40
// would otherwise see every dispatch deferred. So every run pins the schedule
// six hours out; the blackout tests below pin it deliberately close instead.
const SCHEDULE_FAR_AWAY = () => localTimeFromNow(360);

function runPoller(fixture, extraEnv = {}) {
  return spawnSync('bash', [path.join(fixture.checkoutDir, 'scripts', 'poll-run-requests.sh')], {
    cwd: fixture.checkoutDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      POLLER_TEST_MODE: '1',
      POLLER_SCHEDULED_RUN_TIMES: SCHEDULE_FAR_AWAY(),
      ...extraEnv,
    },
  });
}

function stateFile(fixture) {
  return path.join(fixture.checkoutDir, 'services', 'land-scraper', '.run-requests-handled');
}

function readStateId(fixture) {
  try {
    return fs.readFileSync(stateFile(fixture), 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function readPollerLog(fixture) {
  const logDir = path.join(fixture.checkoutDir, 'services', 'land-scraper', 'logs');
  let names = [];
  try {
    names = fs.readdirSync(logDir).filter((n) => n.startsWith('poller-'));
  } catch (_) {
    return '';
  }
  return names.map((n) => fs.readFileSync(path.join(logDir, n), 'utf8')).join('');
}

function readDispatchLog(fixture, id) {
  const p = path.join(fixture.checkoutDir, 'services', 'land-scraper', 'logs', `run-request-${id}.log`);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

// The result file as it landed on origin's evidence-inbox branch — i.e. what
// the assistant would actually be able to read from GitHub.
function readPublishedResult(fixture, id) {
  const raw = git(['show', `evidence-inbox:data/run-results/${id}.json`], fixture.originDir);
  return JSON.parse(raw);
}

function originBranchExists(fixture, branch) {
  try {
    git(['rev-parse', '--verify', branch], fixture.originDir);
    return true;
  } catch (_) {
    return false;
  }
}

// A modified tracked file or a moved-off-main HEAD would break the nightly's
// `git merge --ff-only` self-update and silently freeze production on old code,
// so every scenario asserts the poller left the tree alone.
//
// Untracked *runtime artifacts* under services/land-scraper/ (the lock dir, the
// logs, the handled-id state file) and data/ are expected and harmless: they
// exist in no commit, so a fast-forward never needs to write over them. The
// nightly already creates the same kinds of files.
function assertCheckoutClean(fixture) {
  const status = git(['status', '--porcelain'], fixture.checkoutDir).trim();
  const lines = status ? status.split('\n') : [];
  const offending = lines.filter((line) => !/^\?\? (services\/|data\/)/.test(line));
  assert.deepEqual(offending, [], `poller left tracked files dirty:\n${status}`);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], fixture.checkoutDir).trim(), 'main');
}

function requestFile(request) {
  return `${JSON.stringify({ request }, null, 2)}\n`;
}

// --- 1. Idle state ----------------------------------------------------------

test('request null: silent no-op, no state file, nothing published', (t) => {
  const fixture = makeFixture(t, requestFile(null));
  const result = runPoller(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readStateId(fixture), null, 'an idle poll must not write the state file');
  assert.equal(readPollerLog(fixture), '', 'the idle path runs 96x/day and must log nothing');
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), false);
  assertCheckoutClean(fixture);
});

test('the committed config/run-requests.json template is the idle state', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config', 'run-requests.json'), 'utf8'));
  assert.deepEqual(committed, { request: null });
});

// --- 2. A new request is dispatched exactly once ----------------------------

test('new id: dispatched once, id recorded, result JSON lands on origin evidence-inbox', (t) => {
  const id = '2026-07-31-evidence';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  const result = runPoller(fixture);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readStateId(fixture), id);
  assert.match(readDispatchLog(fixture, id), /TEST-DISPATCH evidence-capture/);

  const published = readPublishedResult(fixture, id);
  assert.equal(published.id, id);
  assert.equal(published.task, 'evidence-capture');
  assert.equal(published.exitCode, 0);
  assert.equal(published.warning, '');
  assert.match(published.logTail, /TEST-DISPATCH evidence-capture/);
  assert.match(published.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(published.finishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assertCheckoutClean(fixture);
});

test('validation-dry-run with valid params is dispatched', (t) => {
  const id = 'dry-run-1';
  const fixture = makeFixture(t, requestFile({
    id,
    task: 'validation-dry-run',
    params: { counties: 'Wayne|KY,Pittsburg|OK', maxPage: 2 },
  }));

  assert.equal(runPoller(fixture).status, 0);
  assert.match(readDispatchLog(fixture, id), /TEST-DISPATCH validation-dry-run/);
  assert.equal(readPublishedResult(fixture, id).exitCode, 0);
  assertCheckoutClean(fixture);
});

test('validation-dry-run with malformed counties is not dispatched and reports the error', (t) => {
  const id = 'dry-run-bad-params';
  const fixture = makeFixture(t, requestFile({
    id,
    task: 'validation-dry-run',
    params: { counties: 'Wayne KY; rm -rf /' },
  }));

  assert.equal(runPoller(fixture).status, 0);
  const dispatchLog = readDispatchLog(fixture, id);
  assert.ok(!/TEST-DISPATCH/.test(dispatchLog), 'invalid params must not reach dispatch');

  const published = readPublishedResult(fixture, id);
  assert.equal(published.exitCode, 65);
  assert.match(published.logTail, /Invalid params: counties/);
  assert.equal(readStateId(fixture), id, 'a bad-params request must not retry forever');
  assertCheckoutClean(fixture);
});

test('validation-dry-run with an out-of-range maxPage is not dispatched', (t) => {
  const id = 'dry-run-bad-page';
  const fixture = makeFixture(t, requestFile({
    id,
    task: 'validation-dry-run',
    params: { counties: 'Wayne|KY', maxPage: 99 },
  }));

  assert.equal(runPoller(fixture).status, 0);
  assert.ok(!/TEST-DISPATCH/.test(readDispatchLog(fixture, id)));
  const published = readPublishedResult(fixture, id);
  assert.equal(published.exitCode, 65);
  assert.match(published.logTail, /Invalid params: maxPage/);
});

// --- 3. Re-polling the same request -----------------------------------------

test('same id polled again: no second dispatch, no second result commit', (t) => {
  const id = 'repeat-me';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  assert.equal(runPoller(fixture).status, 0);
  const firstDispatch = readDispatchLog(fixture, id);
  const firstResultRev = git(['rev-parse', 'evidence-inbox'], fixture.originDir).trim();

  assert.equal(runPoller(fixture).status, 0);

  assert.equal(readDispatchLog(fixture, id), firstDispatch, 'the task must not run twice');
  assert.equal(git(['rev-parse', 'evidence-inbox'], fixture.originDir).trim(), firstResultRev);
  assertCheckoutClean(fixture);
});

// --- 4. Malformed request file ----------------------------------------------

test('malformed JSON: no dispatch, one logged error', (t) => {
  const fixture = makeFixture(t, '{ "request": { "id": "oops",, }\n');

  assert.equal(runPoller(fixture).status, 0);
  assert.equal(readStateId(fixture), null);
  assert.match(readPollerLog(fixture), /not valid JSON/);
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), false);
  assertCheckoutClean(fixture);
});

// --- 5. Lock contention ------------------------------------------------------

test('run lock held by a live process: skipped WITHOUT recording the id', (t) => {
  const id = 'blocked-by-nightly';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  // Stand in for a nightly run in progress: a lock whose recorded PID is this
  // very (definitely alive) test process.
  const lockDir = path.join(fixture.checkoutDir, 'services', 'land-scraper', '.run.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(lockDir, 'started_epoch'), `${Math.floor(Date.now() / 1000)}\n`);
  fs.writeFileSync(path.join(lockDir, 'job'), 'scraper\n');

  assert.equal(runPoller(fixture).status, 0, 'a busy lock is not an error for the poller');
  assert.equal(readStateId(fixture), null, 'the id must stay unrecorded so the next cycle retries');
  assert.equal(readDispatchLog(fixture, id), null);
  assert.match(readPollerLog(fixture), /another scraper\/review run is already active/);
  assert.ok(fs.existsSync(lockDir), 'the poller must not steal a live holder\'s lock');

  // Once the "nightly" finishes, the very next poll picks the request up.
  fs.rmSync(lockDir, { recursive: true, force: true });
  assert.equal(runPoller(fixture).status, 0);
  assert.equal(readStateId(fixture), id);
  assert.match(readDispatchLog(fixture, id), /TEST-DISPATCH evidence-capture/);
  assertCheckoutClean(fixture);
});

test('the run lock is released after a handled request', (t) => {
  const fixture = makeFixture(t, requestFile({ id: 'lock-release', task: 'evidence-capture' }));
  assert.equal(runPoller(fixture).status, 0);
  assert.equal(
    fs.existsSync(path.join(fixture.checkoutDir, 'services', 'land-scraper', '.run.lock')),
    false,
    'the EXIT trap must remove the lock',
  );
});

// --- 6. Unknown task ---------------------------------------------------------

test('unknown task: no dispatch, result says so, id stays recorded', (t) => {
  const id = 'typo-task';
  const fixture = makeFixture(t, requestFile({ id, task: 'deploy-to-prod' }));

  assert.equal(runPoller(fixture).status, 0);
  assert.ok(!/TEST-DISPATCH/.test(readDispatchLog(fixture, id)), 'a non-whitelisted task must never dispatch');

  const published = readPublishedResult(fixture, id);
  assert.equal(published.exitCode, 64);
  assert.match(published.logTail, /Unknown task 'deploy-to-prod'/);
  assert.equal(readStateId(fixture), id, 'a typo must not retry every 15 minutes forever');
  assertCheckoutClean(fixture);
});

// --- 7. Hostile ids and tasks -------------------------------------------------

// Path-shaped and shell-shaped ids, plus OPTION-shaped ones. The option shapes
// are the interesting half: they are legal path components, so a filesystem
// allowlist waves them through, but they stop being names the moment they reach
// an argv list — `node -e <ours> -e <theirs>` runs theirs, and `-r` is
// --require. Both fields are checked, because both reach argv-adjacent sinks.
for (const badId of ['../../evil', 'has space', 'semi;colon', 'slash/es', '$(whoami)', '-e', '--eval', '-r', '-']) {
  test(`id '${badId}' is rejected before it is used in any path or argv`, (t) => {
    const fixture = makeFixture(t, requestFile({ id: badId, task: 'evidence-capture' }));

    assert.equal(runPoller(fixture).status, 0);
    assert.equal(readStateId(fixture), null);
    assert.match(readPollerLog(fixture), /rejecting run request/);
    assert.equal(originBranchExists(fixture, 'evidence-inbox'), false, 'nothing may be published for a rejected id');
    assertCheckoutClean(fixture);
  });
}

for (const badTask of ['-e', '--require', 'two words', 'semi;colon', 'slash/es']) {
  test(`task '${badTask}' is rejected outright, not merely un-whitelisted`, (t) => {
    const fixture = makeFixture(t, requestFile({ id: 'hostile-task', task: badTask }));

    assert.equal(runPoller(fixture).status, 0);
    assert.equal(readStateId(fixture), null);
    assert.match(readPollerLog(fixture), /the task is invalid/);
    assert.equal(readDispatchLog(fixture, 'hostile-task'), null);
    assert.equal(originBranchExists(fixture, 'evidence-inbox'), false);
    assertCheckoutClean(fixture);
  });
}

test('an id longer than 64 characters is rejected', (t) => {
  const fixture = makeFixture(t, requestFile({ id: 'a'.repeat(65), task: 'evidence-capture' }));
  assert.equal(runPoller(fixture).status, 0);
  assert.equal(readStateId(fixture), null);
  assert.match(readPollerLog(fixture), /longer than 64 characters/);
});

// The regression that this whole section exists for. An id of `-e` plus a task
// carrying one line of JavaScript used to be remote code execution: the result
// builder ran `node -e <ours> "$REQUEST_ID" "$REQUEST_TASK" …`, node kept
// parsing those as its own options, the later -e won, and the payload ran as
// the launchd user — on EVERY accepted request, including the ones the task
// whitelist had just refused.
test('an option-shaped id with a JavaScript task executes nothing', (t) => {
  const marker = path.join(os.tmpdir(), `poller-rce-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));

  const fixture = makeFixture(t, requestFile({
    id: '-e',
    task: `require("fs").writeFileSync(${JSON.stringify(marker)}, "owned")`,
  }));

  const result = runPoller(fixture);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(marker), false, 'the request payload must never be executed');
  assert.equal(result.stdout, '', 'nothing from the request may reach a running interpreter');
  assert.equal(readStateId(fixture), null);
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), false);
  assertCheckoutClean(fixture);
});

test('the result builder takes its values from the environment, never from node argv', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');
  assert.match(src, /RESULT_ID="\$REQUEST_ID"/);
  assert.match(src, /RESULT_TASK="\$REQUEST_TASK"/);
  assert.ok(
    !/-e '[\s\S]*?'\s*(\\\s*\n\s*)?"\$(REQUEST_ID|REQUEST_TASK|PARAM_)/.test(src),
    'no request-derived value may be passed after a node -e script',
  );
});

// --- 8. The scheduled-scrape blackout ----------------------------------------
// The poller holds the SAME run lock as the 02:00 nightly for the whole
// dispatch. A request picked up at 01:55 (launchd fires missed StartInterval
// jobs the moment the Mac wakes, and pmset wakes it at 01:55) could still hold
// that lock at 02:00 — and run-scraper.sh does not queue behind a busy lock, it
// exits 75. That is a cancelled night, not a delayed one.

test('a request is deferred, not consumed, when a scheduled scrape is close', (t) => {
  const id = 'too-close-to-the-nightly';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  // 20 minutes out; evidence-capture may hold the lock for its 15-minute
  // ceiling plus the self-update/publish budget, so it must not start.
  const scheduledAt = localTimeFromNow(20);
  const blocked = runPoller(fixture, { POLLER_SCHEDULED_RUN_TIMES: scheduledAt });
  assert.equal(blocked.status, 0);
  assert.equal(readStateId(fixture), null, 'a deferred request must stay unconsumed');
  assert.equal(readDispatchLog(fixture, id), null);
  // The log must name the scrape it is standing down for — "nothing happened at
  // 01:56" is unanswerable otherwise.
  assert.match(readPollerLog(fixture), new RegExp(`Deferring run request '${id}'.*the ${scheduledAt} scheduled scrape`));
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), false);
  assertCheckoutClean(fixture);

  // The very next cycle outside the window runs it.
  assert.equal(runPoller(fixture).status, 0);
  assert.equal(readStateId(fixture), id);
  assert.match(readDispatchLog(fixture, id), /TEST-DISPATCH evidence-capture/);
});

test('a request is deferred just AFTER a scheduled start too, in case the scrape has not taken the lock yet', (t) => {
  const id = 'right-after-the-nightly';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  assert.equal(runPoller(fixture, { POLLER_SCHEDULED_RUN_TIMES: localTimeFromNow(-5) }).status, 0);
  assert.equal(readStateId(fixture), null);
  assert.match(readPollerLog(fixture), /Deferring run request/);
});

test('the blackout is sized to the task: a 60-minute dry run yields where a 15-minute capture does not', (t) => {
  // 75 minutes to the scheduled scrape. evidence-capture (15 min ceiling + the
  // 45 min post-accept slack = 60) fits; validation-dry-run (60 + 45 = 105)
  // does not.
  const schedule = { POLLER_SCHEDULED_RUN_TIMES: localTimeFromNow(75) };

  const dryRun = makeFixture(t, requestFile({
    id: 'long-task-yields',
    task: 'validation-dry-run',
    params: { counties: 'Wayne|KY' },
  }));
  assert.equal(runPoller(dryRun, schedule).status, 0);
  assert.equal(readStateId(dryRun), null, 'an hour-long task must not start 75 minutes before a scrape');
  assert.match(readPollerLog(dryRun), /Deferring run request/);

  const capture = makeFixture(t, requestFile({ id: 'short-task-runs', task: 'evidence-capture' }));
  assert.equal(runPoller(capture, schedule).status, 0);
  assert.equal(readStateId(capture), 'short-task-runs');
  assert.match(readDispatchLog(capture, 'short-task-runs'), /TEST-DISPATCH evidence-capture/);
});

test('the poller blacks out around the launchd scrape times by default', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');
  // The defaults must match the installed launchd schedules, or the guard
  // protects a scrape that does not exist.
  assert.match(src, /SCHEDULED_RUN_TIMES="\$\{POLLER_SCHEDULED_RUN_TIMES-02:00 12:30\}"/);

  const nightly = fs.readFileSync(path.join(REPO_DIR, 'services', 'com.ccl.land-scraper.plist'), 'utf8');
  assert.match(nightly, /<key>Hour<\/key>\s*<integer>2<\/integer>/);
  assert.match(nightly, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  const midday = fs.readFileSync(path.join(REPO_DIR, 'services', 'com.ccl.land-scraper.midday.plist'), 'utf8');
  assert.match(midday, /<key>Hour<\/key>\s*<integer>12<\/integer>/);
  assert.match(midday, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
});

// --- 8b. The blackout must reserve the WHOLE lock hold, not just the task ----
// The regression these three tests exist for: the reservation used to be the
// task's own ceiling plus a flat 15 minutes, but the run lock is held across
// self-update (`git merge` + an UNBOUNDED `npm install`) and the result publish
// (3 attempts x ls-remote + fetch + worktree + commit + push) as well. That left
// roughly 20 minutes of real timeout budget outside the reservation — enough for
// a request accepted at 00:44 to still hold the lock at 02:00 and cancel the
// night.

test('a task is deferred well beyond its own ceiling, because the lock is held past it', (t) => {
  // 90 minutes to the scheduled scrape: MORE than validation-dry-run's 60-minute
  // ceiling, and still not enough, because self-update + npm install + the
  // publish chain can run on after the task finishes while the lock is held.
  // Under the old flat-15 slack this was accepted (60 + 15 = 75 <= 90).
  const fixture = makeFixture(t, requestFile({
    id: 'ceiling-is-not-the-whole-hold',
    task: 'validation-dry-run',
    params: { counties: 'Wayne|KY' },
  }));

  assert.equal(runPoller(fixture, { POLLER_SCHEDULED_RUN_TIMES: localTimeFromNow(90) }).status, 0);
  assert.equal(readStateId(fixture), null, 'the post-dispatch budget must be reserved too');
  assert.match(readPollerLog(fixture), /Deferring run request/);
  assert.equal(readDispatchLog(fixture, 'ceiling-is-not-the-whole-hold'), null);
});

test('a long task is accepted once the full budget clears the scheduled scrape', (t) => {
  // 110 minutes out is past the derived window (60 + 45 = 105), so it runs.
  const fixture = makeFixture(t, requestFile({
    id: 'clear-of-the-scrape',
    task: 'validation-dry-run',
    params: { counties: 'Wayne|KY' },
  }));

  assert.equal(runPoller(fixture, { POLLER_SCHEDULED_RUN_TIMES: localTimeFromNow(110) }).status, 0);
  assert.equal(readStateId(fixture), 'clear-of-the-scrape');
  assert.match(readDispatchLog(fixture, 'clear-of-the-scrape'), /TEST-DISPATCH validation-dry-run/);
});

test('the blackout slack is derived from the post-accept timeout budget, not hand-picked', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');

  // A literal slack silently goes stale the moment a ceiling below it changes,
  // and "stale" means the poller holds the lock into a scheduled scrape.
  assert.match(
    src,
    /BLACKOUT_MINUTES_SLACK=\$\(\( \(POST_ACCEPT_TIMEOUT_BUDGET_SECONDS \+ 59\) \/ 60 \+ BLACKOUT_MINUTES_MARGIN \)\)/,
    'the slack must be computed from the timeout budget',
  );

  // …and the budget must actually account for every bounded step that runs
  // while the lock is held after the request is accepted.
  for (const term of [
    'GIT_MERGE_TIMEOUT_SECONDS',
    'NPM_INSTALL_TIMEOUT_SECONDS',
    'RESULT_BUILD_TIMEOUT_SECONDS',
    'PUBLISH_ATTEMPTS * PUBLISH_ATTEMPT_TIMEOUT_SECONDS',
  ]) {
    assert.ok(
      new RegExp(`POST_ACCEPT_TIMEOUT_BUDGET_SECONDS=\\$\\(\\([\\s\\S]*?${term.replace(/[*]/g, '\\*')}`).test(src),
      `${term} must be part of the post-accept budget`,
    );
  }
});

test('npm install is timeout-bounded like every other command in the poller', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');
  assert.match(
    src,
    /run_with_timeout "\$NPM_INSTALL_TIMEOUT_SECONDS" \\\n\s*npm install /,
    'an unbounded npm install can hold the run lock past a scheduled scrape',
  );
  assert.ok(
    !/(^|[;&|]\s*|\bif\s+)npm install /m.test(src),
    'no unwrapped `npm install` may remain',
  );
});

test('every network/npm command in the poller runs under a named timeout constant', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');
  // Numeric literals at a run_with_timeout call site are what let the call
  // sites and the blackout arithmetic drift apart.
  const literals = src.match(/run_with_timeout "?\d+"?/g) || [];
  assert.deepEqual(literals, [], `run_with_timeout must be called with named constants: ${literals.join(', ')}`);
});

// --- Results branch: never clobber evidence pushed moments earlier ----------
// evidence-inbox is shared with the nightly's captured HTML — pages only the
// production Mac's residential IP can fetch. Publishing a result there is a
// compare-and-swap against a freshly read remote tip, NEVER a force push, and
// when the remote can't be read the result stays on disk. These tests are the
// enforcement of that trade: evidence preservation beats result delivery.

// Stand in for the nightly having just pushed evidence to the branch. Returns
// origin's evidence-inbox sha so a test can assert it did or didn't move.
function seedEvidenceBranch(fixture, fileName = 'landwatch.html', content = '<html>captured</html>') {
  const evidenceSeed = fs.mkdtempSync(path.join(fixture.root, 'evidence-seed-'));
  git(['clone', '-b', 'main', fixture.originDir, evidenceSeed], fixture.root);
  git(['config', 'user.name', 'Fixture'], evidenceSeed);
  git(['config', 'user.email', 'fixture@example.com'], evidenceSeed);
  git(['checkout', '-b', 'evidence-inbox'], evidenceSeed);
  fs.mkdirSync(path.join(evidenceSeed, 'data', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(evidenceSeed, 'data', 'evidence', fileName), content);
  git(['add', '-f', 'data/evidence'], evidenceSeed);
  git(['commit', '-m', 'evidence'], evidenceSeed);
  git(['push', 'origin', 'evidence-inbox'], evidenceSeed);
  return git(['rev-parse', 'evidence-inbox'], fixture.originDir).trim();
}

function isAncestor(fixture, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: fixture.originDir,
    encoding: 'utf8',
  }).status === 0;
}

test('the result is pushed on top of an existing evidence-inbox, not over it', (t) => {
  const id = 'coexist-with-evidence';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));
  const evidenceRev = seedEvidenceBranch(fixture);

  assert.equal(runPoller(fixture).status, 0);

  // BOTH files are on the branch afterwards, and the evidence commit is an
  // ANCESTOR of the new tip — i.e. the result was added to the branch's
  // history, not pushed over it. A force push would satisfy the first
  // assertion only by accident and would fail this one outright.
  assert.match(git(['show', 'evidence-inbox:data/evidence/landwatch.html'], fixture.originDir), /captured/);
  assert.equal(readPublishedResult(fixture, id).id, id);
  assert.ok(
    isAncestor(fixture, evidenceRev, git(['rev-parse', 'evidence-inbox'], fixture.originDir).trim()),
    'the evidence commit must still be in evidence-inbox history',
  );
  assertCheckoutClean(fixture);
});

test('evidence-inbox absent on the remote: the publish creates it from main', (t) => {
  const id = 'creates-the-branch';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), false, 'precondition: no branch yet');

  assert.equal(runPoller(fixture).status, 0);

  // The empty-lease path ("push only if the ref still does not exist").
  assert.equal(originBranchExists(fixture, 'evidence-inbox'), true);
  assert.equal(readPublishedResult(fixture, id).id, id);
  assert.ok(
    isAncestor(fixture, git(['rev-parse', 'main'], fixture.originDir).trim(), 'evidence-inbox'),
    'a branch created from scratch must be based on main',
  );
  assertCheckoutClean(fixture);
});

// A `git` shim on PATH that fails one subcommand and passes everything else
// through to the real binary. Used to reproduce "GitHub is momentarily
// unreachable at publish time" without breaking the fetch/merge steps that run
// before it.
function makeFailingGitShim(fixture, subcommand) {
  const shimDir = path.join(fixture.root, `git-shim-${subcommand}`);
  fs.mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'for arg in "$@"; do',
    `  if [ "$arg" = "${subcommand}" ]; then`,
    '    echo "fatal: could not read from remote repository" >&2',
    '    exit 128',
    '  fi',
    'done',
    `exec ${realGit} "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return shimDir;
}

// The MAJOR finding this whole redesign exists for. resolve_results_base used
// to swallow a failed fetch with `|| true` and fall back to base=main; the
// ladder then ended in a blind `git push --force`. One transient network blip
// was therefore enough to reset evidence-inbox to "main plus this result" and
// silently delete every captured page on it.
test('remote unreadable at publish: nothing is pushed and the evidence branch is untouched', (t) => {
  const id = 'remote-unreachable';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));
  const before = seedEvidenceBranch(fixture);
  const beforeTree = git(['show', 'evidence-inbox:data/evidence/landwatch.html'], fixture.originDir);

  const shimDir = makeFailingGitShim(fixture, 'ls-remote');
  const result = runPoller(fixture, { PATH: `${shimDir}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);

  // The branch is byte-identical: same tip, same content.
  assert.equal(git(['rev-parse', 'evidence-inbox'], fixture.originDir).trim(), before);
  assert.equal(git(['show', 'evidence-inbox:data/evidence/landwatch.html'], fixture.originDir), beforeTree);
  assert.throws(
    () => readPublishedResult(fixture, id),
    'nothing may be published when the remote state could not be read',
  );

  // The work still happened and the outcome is recoverable from the Mac.
  assert.match(readDispatchLog(fixture, id), /TEST-DISPATCH evidence-capture/);
  const onDisk = path.join(fixture.checkoutDir, 'data', 'run-results', `${id}.json`);
  assert.equal(fs.existsSync(onDisk), true, 'the result must survive on disk');
  assert.equal(JSON.parse(fs.readFileSync(onDisk, 'utf8')).id, id);

  const log = readPollerLog(fixture);
  assert.match(log, /ERROR: could not read origin\/evidence-inbox/);
  assert.match(log, new RegExp(`NOT publishing the result for '${id}'`));
  assertCheckoutClean(fixture);
});

test('the poller never force-pushes: every push is a --force-with-lease', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');

  // A bare --force anywhere near a push is the bug. (`worktree remove --force`
  // is fine and deliberately not matched — it is local and destroys nothing on
  // the remote.)
  const pushLines = src.split('\n').filter((line) => /\bpush\b/.test(line) && !line.trim().startsWith('#'));
  assert.ok(pushLines.length > 0, 'the publish must still push something');
  for (const line of pushLines) {
    assert.ok(!/--force(?!-with-lease)/.test(line), `blind force push: ${line.trim()}`);
    assert.ok(!/\bpush\s+-f\b/.test(line), `blind force push: ${line.trim()}`);
  }
  assert.match(src, /push --force-with-lease="\$RESULTS_BRANCH:\$expected_sha"/);
  assert.ok(
    !/force_flag/.test(src),
    'the force-flag parameter must be gone, replaced by the expected-sha lease',
  );
});

test('a worktree registration leaked by a killed run self-heals instead of blocking the publish', (t) => {
  const id = 'stale-worktree-heals';
  const fixture = makeFixture(t, requestFile({ id, task: 'evidence-capture' }));

  // Exactly what a hard-killed poller leaves behind: the results branch checked
  // out in a worktree whose directory is gone but whose registration is not.
  // `git worktree add -B` then refuses with "cannot force update the branch …
  // used by worktree", which used to fail every subsequent publish (and the
  // nightly's evidence push) until someone SSHed in and pruned by hand.
  const staleDir = path.join(fixture.root, 'leaked-worktree');
  git(['worktree', 'add', '-f', '-B', 'evidence-inbox', staleDir, 'main'], fixture.checkoutDir);
  fs.rmSync(staleDir, { recursive: true, force: true });

  assert.equal(runPoller(fixture).status, 0);
  assert.equal(readPublishedResult(fixture, id).id, id);
  // On the FIRST attempt. publish_result_file has always pruned on its way out,
  // so without the prune BEFORE the add the leak merely costs a retry here —
  // but the same leak is what stops the nightly's evidence push dead, and a
  // publish that burns an attempt on a self-inflicted failure has two left for
  // real races instead of three.
  assert.ok(
    !/publish attempt 1\/3 did not land/.test(readPollerLog(fixture)),
    'the stale registration must be pruned before the add, not recovered from by retrying',
  );
  assertCheckoutClean(fixture);
});

// --- Housekeeping runs on EVERY poll, not just the ones that dispatch --------
// Retention used to sit at the bottom of the script, past nine `exit 0`s. The
// idle path is the overwhelming majority of the 96 daily polls, so in practice
// it almost never ran — and nothing cleaned data/run-results at all.

test('an idle poll still expires logs and results older than 30 days', (t) => {
  const fixture = makeFixture(t, requestFile(null));

  const logDir = path.join(fixture.checkoutDir, 'services', 'land-scraper', 'logs');
  const resultsDir = path.join(fixture.checkoutDir, 'data', 'run-results');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const stale = [
    path.join(logDir, 'poller-2020-01-01.log'),
    path.join(logDir, 'run-request-ancient.log'),
    path.join(resultsDir, 'ancient.json'),
  ];
  const fresh = [
    path.join(logDir, 'poller-recent.log'),
    path.join(resultsDir, 'recent.json'),
  ];
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const file of stale) {
    fs.writeFileSync(file, 'old\n');
    fs.utimesSync(file, longAgo, longAgo);
  }
  for (const file of fresh) {
    fs.writeFileSync(file, 'new\n');
  }

  assert.equal(runPoller(fixture).status, 0);

  for (const file of stale) {
    assert.equal(fs.existsSync(file), false, `${path.basename(file)} should have been expired by an idle poll`);
  }
  for (const file of fresh) {
    assert.equal(fs.existsSync(file), true, `${path.basename(file)} is inside the retention window`);
  }
});

// --- Shell syntax + the run-lock extraction ---------------------------------

// Renamed from "both shell scripts": run-review.sh joined the list when it
// stopped carrying its own inline copy of the lock block.
test('every shell script that takes the run lock passes bash -n', () => {
  for (const script of [POLLER_SCRIPT, RUN_LOCK_SCRIPT, RUN_SCRAPER_SCRIPT, RUN_REVIEW_SCRIPT]) {
    const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path.basename(script)}: ${result.stderr}`);
  }
});

test('run-scraper.sh sources the shared lock instead of inlining it', () => {
  const src = fs.readFileSync(RUN_SCRAPER_SCRIPT, 'utf8');
  assert.match(src, /source "\$SCRIPT_DIR\/scripts\/run-lock\.sh"/);
  assert.match(src, /acquire_run_lock "\$LOCK_JOB_LABEL" "\$LOG_FILE"/);
  assert.match(src, /exit 75/, 'the exit-75 contract on a busy lock must survive the extraction');
  assert.ok(!/STALE_GRACE_SECONDS=/.test(src), 'the lock rules must live in run-lock.sh only');
  assert.ok(!/kill -0/.test(src), 'the liveness check must live in run-lock.sh only');
});

test('run-review.sh sources the shared lock instead of inlining it', () => {
  const src = fs.readFileSync(RUN_REVIEW_SCRIPT, 'utf8');
  assert.match(src, /source "\$SCRIPT_DIR\/scripts\/run-lock\.sh"/);
  // The job label written into the lock dir must be byte-for-byte what this
  // script wrote when the block was inline — `echo "review" > "$LOCK_DIR/job"`.
  assert.match(src, /acquire_run_lock "review" "\$LOG_FILE"/);
  assert.match(src, /exit 75/, 'the exit-75 contract on a busy lock must survive the extraction');
  assert.ok(!/STALE_GRACE_SECONDS=/.test(src), 'the lock rules must live in run-lock.sh only');
  assert.ok(!/kill -0/.test(src), 'the liveness check must live in run-lock.sh only');
  assert.ok(!/LOCK_DIR=/.test(src), 'the lock path must live in run-lock.sh only');
});

test('the poller sources the same lock file with a distinguishing job label', () => {
  const src = fs.readFileSync(POLLER_SCRIPT, 'utf8');
  assert.match(src, /source "\$SCRIPT_DIR\/scripts\/run-lock\.sh"/);
  assert.match(src, /acquire_run_lock "run-request" "\$LOG_FILE"/);
});

test('run-lock.sh writes the caller-supplied job label and the same on-disk lock files', (t) => {
  const fixture = makeFixture(t, requestFile(null));
  const lockDir = path.join(fixture.checkoutDir, 'services', 'land-scraper', '.run.lock');
  fs.mkdirSync(path.join(fixture.checkoutDir, 'services', 'land-scraper', 'logs'), { recursive: true });
  const logFile = path.join(fixture.checkoutDir, 'services', 'land-scraper', 'logs', 'lock-test.log');

  // Acquire, dump the lock's contents while held, then let the shell exit so
  // the EXIT trap runs.
  const script = `
    set -euo pipefail
    source "${fixture.checkoutDir}/scripts/run-lock.sh"
    acquire_run_lock "scraper" "${logFile}"
    cat "${lockDir}/job"
    cat "${lockDir}/pid"
    test -f "${lockDir}/started_epoch" && echo has-started-epoch
  `;
  const held = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(held.status, 0, held.stderr);
  const [job, pid, epochMarker] = held.stdout.trim().split('\n');
  assert.equal(job, 'scraper');
  assert.match(pid, /^\d+$/);
  assert.equal(epochMarker, 'has-started-epoch');
  assert.equal(fs.existsSync(lockDir), false, 'the EXIT trap must remove the lock');
});

test('run-lock.sh returns 75 (not 0) when a live holder owns the lock', (t) => {
  const fixture = makeFixture(t, requestFile(null));
  const serviceDir = path.join(fixture.checkoutDir, 'services', 'land-scraper');
  const lockDir = path.join(serviceDir, '.run.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.mkdirSync(path.join(serviceDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(lockDir, 'started_epoch'), `${Math.floor(Date.now() / 1000)}\n`);
  const logFile = path.join(serviceDir, 'logs', 'lock-busy.log');

  const script = `
    set -euo pipefail
    source "${fixture.checkoutDir}/scripts/run-lock.sh"
    if ! acquire_run_lock "scraper" "${logFile}"; then
      exit 75
    fi
    exit 0
  `;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 75);
  assert.match(fs.readFileSync(logFile, 'utf8'), /another scraper\/review run is already active/);
  assert.ok(fs.existsSync(lockDir), 'a live holder\'s lock must never be stolen');
});

// --- The launchd service -----------------------------------------------------

test('com.ccl.run-request-poller.plist polls every 15 minutes at load', () => {
  const plist = fs.readFileSync(path.join(REPO_DIR, 'services', 'com.ccl.run-request-poller.plist'), 'utf8');
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.ccl\.run-request-poller<\/string>/);
  assert.match(plist, /poll-run-requests\.sh/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/nora\/ccl-land-scraper<\/string>/);
  assert.match(plist, /launchd-poller\.log/);
  assert.match(plist, /launchd-poller-error\.log/);
  // Same PATH as the midday service, so node/npm resolve identically.
  const midday = fs.readFileSync(path.join(REPO_DIR, 'services', 'com.ccl.land-scraper.midday.plist'), 'utf8');
  const pathOf = (text) => text.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)[1];
  assert.equal(pathOf(plist), pathOf(midday));
});
