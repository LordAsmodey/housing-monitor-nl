import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluatePullRequestTarget, validateMergeResult } from '../scripts/ci-pr-target-guard';

const REPOSITORY = 'owner/housing-monitor-nl';
const INTEGRATION = 'codex/platform-v2';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
function event(head = 'codex/B02-ci-guard', base = INTEGRATION) {
  return {
    number: 42,
    repository: { full_name: REPOSITORY, id: 123 },
    pull_request: {
      number: 42,
      base: { ref: base, sha: BASE_SHA, repo: { full_name: REPOSITORY, id: 123 } },
      head: { ref: head, sha: HEAD_SHA, repo: { full_name: REPOSITORY, id: 123 } },
    },
  };
}

for (const id of ['A01', 'B02', 'C02P', 'C02R', 'C.source.1', 'C.pararius.2', 'C.funda.3', 'D01', 'G01', 'I01', 'S01', 'M01', 'T01', 'W01', 'O01', 'R01', 'TS01', 'V01', 'B02.1', 'b02']) {
  const head = `codex/${id}-feature`;
  test(`${head} targets integration and rejects main or an unrelated base`, () => {
    assert.deepEqual(evaluatePullRequestTarget(event(head), REPOSITORY), {
      kind: 'v2-task', baseRef: INTEGRATION, headRef: head, baseSha: BASE_SHA, headSha: HEAD_SHA, number: 42,
    });
    for (const base of ['main', 'develop', 'codex/platform-v3']) {
      assert.throws(() => evaluatePullRequestTarget(event(head, base), REPOSITORY), /must target codex\/platform-v2/);
    }
  });
}

test('routing preserves ordinary hotfixes, main syncs and unrelated routes', () => {
  for (const [head, base] of [['hotfix/login', 'main'], ['main', INTEGRATION], ['feature/layout', 'develop'], ['codex/ordinary-maintenance', 'main']]) {
    assert.equal(evaluatePullRequestTarget(event(head, base), REPOSITORY).kind, 'ordinary');
  }
  assert.equal(evaluatePullRequestTarget(event('CODEX/c02r-feature'), REPOSITORY).kind, 'v2-task');
});

test('only the same repository integration branch can release to main', () => {
  assert.equal(evaluatePullRequestTarget(event(INTEGRATION, 'main'), REPOSITORY).kind, 'v2-release');
  assert.throws(() => evaluatePullRequestTarget(event(INTEGRATION, 'develop'), REPOSITORY));
  const fork = event(INTEGRATION, 'main');
  fork.pull_request.head.repo = { full_name: 'attacker/housing-monitor-nl', id: 987 };
  assert.throws(() => evaluatePullRequestTarget(fork, REPOSITORY), /same-repository/);
  fork.pull_request.head.ref = 'hotfix/login';
  assert.equal(evaluatePullRequestTarget(fork, REPOSITORY).kind, 'ordinary');
  fork.pull_request.head.ref = 'codex/B02-ci-guard';
  assert.throws(() => evaluatePullRequestTarget(fork, REPOSITORY), /must target/);
  fork.pull_request.base.ref = INTEGRATION;
  assert.equal(evaluatePullRequestTarget(fork, REPOSITORY).kind, 'v2-task');
});

test('repository identity requires matching names and numeric IDs', () => {
  const nameOnly = event();
  nameOnly.pull_request.head.repo.id = 987;
  assert.throws(() => evaluatePullRequestTarget(nameOnly, REPOSITORY), /identity mismatch/);
  const idOnly = event();
  idOnly.pull_request.head.repo.full_name = 'attacker/spoof';
  assert.throws(() => evaluatePullRequestTarget(idOnly, REPOSITORY), /identity mismatch/);
  const wrongBase = event();
  wrongBase.pull_request.base.repo.id = 987;
  assert.throws(() => evaluatePullRequestTarget(wrongBase, REPOSITORY), /Base repository mismatch/);
  assert.throws(() => evaluatePullRequestTarget(event(), 'other/repository'), /Event repository/);
  assert.equal(evaluatePullRequestTarget(event(), REPOSITORY.toUpperCase()).kind, 'v2-task');
});

test('missing and malformed payload metadata fail closed', () => {
  for (const value of [undefined, null, [], 'payload', {}, { pull_request: {} }]) {
    assert.throws(() => evaluatePullRequestTarget(value, REPOSITORY));
  }
  const invalid = [
    ['number', 0], ['number', 42.5], ['number', '42'], ['pull_request.number', 43],
    ['repository', null], ['repository.id', undefined], ['repository.id', '123'], ['repository.full_name', 'invalid'],
    ['pull_request', null], ['pull_request.base', null], ['pull_request.head', null],
    ['pull_request.head.repo', null], ['pull_request.head.repo.id', undefined],
    ['pull_request.base.repo.full_name', undefined], ['pull_request.base.sha', undefined],
    ['pull_request.head.sha', 'b'.repeat(39)], ['pull_request.head.sha', 'g'.repeat(40)],
    ['pull_request.head.ref', undefined], ['pull_request.head.ref', 'codex/B02-feature\nspoof'],
    ['pull_request.base.ref', 'main..spoof'], ['pull_request.head.ref', 'refs/@{bad}'],
  ] as const;
  for (const [path, value] of invalid) {
    const payload = event();
    let owner = payload as unknown as Record<string, unknown>;
    const keys = path.split('.');
    for (const key of keys.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
    owner[keys[keys.length - 1]!] = value;
    assert.throws(() => evaluatePullRequestTarget(payload, REPOSITORY), Error, path);
  }
});

test('merge validation requires the event merge ref, exact checkout SHA and ordered parents', () => {
  const target = evaluatePullRequestTarget(event(), REPOSITORY);
  const calls: string[][] = [];
  validateMergeResult(target, 'refs/pull/42/merge', MERGE_SHA, (args) => {
    calls.push(args);
    return args[0] === 'rev-parse' ? `${MERGE_SHA}\n` : `${BASE_SHA} ${HEAD_SHA}\n`;
  });
  assert.deepEqual(calls, [['rev-parse', 'HEAD'], ['show', '-s', '--format=%P', 'HEAD']]);
  for (const ref of ['refs/heads/codex/B02-ci-guard', 'refs/pull/42/head', 'refs/pull/43/merge']) {
    assert.throws(() => validateMergeResult(target, ref, MERGE_SHA, () => { throw new Error('git must not run'); }), /default pull request merge ref/);
  }
  assert.throws(() => validateMergeResult(target, 'refs/pull/42/merge', 'bad', () => ''), /Malformed GITHUB_SHA/);
  assert.throws(() => validateMergeResult(target, 'refs/pull/42/merge', MERGE_SHA, () => HEAD_SHA), /Checkout is not/);
  for (const parents of [`${HEAD_SHA} ${BASE_SHA}`, HEAD_SHA, `${BASE_SHA} ${HEAD_SHA} ${MERGE_SHA}`, `${BASE_SHA} ${MERGE_SHA}`]) {
    assert.throws(() => validateMergeResult(target, 'refs/pull/42/merge', MERGE_SHA,
      (args) => args[0] === 'rev-parse' ? MERGE_SHA : parents), /parents do not match/);
  }
  assert.throws(() => validateMergeResult(target, 'refs/pull/42/merge', MERGE_SHA, () => { throw new Error('git unavailable'); }), /git unavailable/);
});

function cli(payload: unknown, overrides: NodeJS.ProcessEnv = {}, mode = 'target', cwd = process.cwd()) {
  const directory = mkdtempSync(join(tmpdir(), 'housing-pr-guard-'));
  try {
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    writeFileSync(eventPath, typeof payload === 'string' ? payload : JSON.stringify(payload));
    const result = spawnSync(process.execPath, ['--import', require.resolve('tsx'), resolve('scripts/ci-pr-target-guard.ts'), mode], {
      cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: REPOSITORY, GITHUB_STEP_SUMMARY: summaryPath, ...overrides },
    });
    assert.ifError(result.error);
    let summary = '';
    if (result.status === 0 && result.stdout.includes('PR #')) summary = readFileSync(summaryPath, 'utf8');
    return { ...result, summary };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('CLI enforces target policy and emits auditable summary evidence', () => {
  const passed = cli(event());
  assert.equal(passed.status, 0, passed.stderr);
  for (const evidence of ['PR #42: v2-task', 'codex/B02-ci-guard → codex/platform-v2', BASE_SHA, HEAD_SHA, 'Target policy passed.']) {
    assert.ok(passed.stdout.includes(evidence), evidence);
    assert.ok(passed.summary.includes(evidence), evidence);
  }
  const failed = cli(event('codex/B02-ci-guard', 'main'));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /PR guard failed: V2 task pull requests must target/);
  assert.doesNotMatch(failed.stderr, /\bat .+:\d+:\d+|node:internal/);
});

test('CLI handles push, unsupported events, malformed payloads and unknown modes', () => {
  for (const mode of ['target', 'merge-result']) {
    const push = cli('invalid JSON', { GITHUB_EVENT_NAME: 'push' }, mode);
    assert.equal(push.status, 0, push.stderr);
    assert.match(push.stdout, /push event; application checks still run/);
  }
  for (const result of [cli(event(), { GITHUB_EVENT_NAME: 'workflow_dispatch' }), cli('{'), cli({}), cli(event(), {}, 'unsupported')]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^PR guard failed: /);
    assert.doesNotMatch(result.stderr, /\bat .+:\d+:\d+|node:internal/);
  }
  const secret = 'private-event-token-do-not-log';
  const poisoned = event();
  poisoned.pull_request.head.ref = `${secret}\nspoof`;
  assert.doesNotMatch(cli(poisoned).stderr, new RegExp(secret));
});

test('merge-result CLI verifies a real git merge and reports its exact SHA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'housing-pr-merge-'));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-b', 'base');
    git('config', 'user.name', 'CI Guard Test');
    git('config', 'user.email', 'ci-guard@example.invalid');
    git('commit', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'candidate');
    git('commit', '--allow-empty', '-m', 'head');
    const head = git('rev-parse', 'HEAD');
    git('checkout', 'base');
    git('merge', '--no-ff', 'candidate', '-m', 'merge');
    const sha = git('rev-parse', 'HEAD');
    const payload = event();
    payload.pull_request.base.sha = base;
    payload.pull_request.head.sha = head;
    const env = { GITHUB_REF: 'refs/pull/42/merge', GITHUB_SHA: sha };
    const passed = cli(payload, env, 'merge-result', directory);
    assert.equal(passed.status, 0, passed.stderr);
    for (const evidence of [base, head, `Validated merge-result SHA: ${sha}`]) {
      assert.ok(passed.stdout.includes(evidence));
      assert.ok(passed.summary.includes(evidence));
    }
    payload.pull_request.base.sha = head;
    const failed = cli(payload, env, 'merge-result', directory);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /parents do not match/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workflow reruns on retargeting, gates every existing job and uses read-only default merge checkout', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:\s*\n\s+types:\s*\[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /^permissions:\s*\n  contents: read\s*\njobs:/m);
  assert.doesNotMatch(workflow, /pull_request_target|permissions:.*write|contents:\s*write|pull-requests:\s*write/);
  const jobs = new Map([...workflow.slice(workflow.indexOf('jobs:\n')).matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1], match[2]!]));
  assert.equal(jobs.size, 6);
  for (const job of ['funda-image', 'application-image', 'huurwoningen-image', 'pararius-image', 'check']) {
    assert.match(jobs.get(job) ?? '', /^    needs: pr-target-guard$/m, job);
  }
  const guard = jobs.get('pr-target-guard')!;
  assert.match(guard, /fetch-depth: 2/);
  assert.ok(guard.indexOf('npm run ci:pr-target') < guard.indexOf('npm run ci:merge-result'));
  assert.match(guard, /npm run typecheck:ci/);
  const checkoutSections = [...workflow.matchAll(/- uses: actions\/checkout@v4\n([\s\S]*?)(?=\n\s+- |\n  [\w-]+:|$(?![\s\S]))/g)];
  assert.equal(checkoutSections.length, 6);
  for (const checkout of checkoutSections) assert.doesNotMatch(checkout[1]!, /^\s+ref:/m);
});
