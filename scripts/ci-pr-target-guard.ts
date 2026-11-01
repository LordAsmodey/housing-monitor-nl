import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const INTEGRATION = 'codex/platform-v2';
// Naming contract: codex/<backlog-id>-<slug>, including split and source tasks.
const V2_TASK = /^codex\/(?:(?:A|B|C|D|G|I|S|M|T|W|O|R|TS|V)\d{2,}[a-z]?(?:\.\d+)*|C\.[a-z0-9-]+\.[123])-\S+$/i;
type RecordValue = Record<string, unknown>;
export interface PullRequestTarget {
  kind: 'v2-task' | 'v2-release' | 'ordinary';
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  number: number;
}
function record(value: unknown, name: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing or malformed ${name}`);
  return value as RecordValue;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing or malformed ${name}`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Missing or malformed ${name}`);
  return value;
}
function repository(value: unknown, name: string): { name: string; id: number } {
  const repo = record(value, name);
  const fullName = string(repo.full_name, `${name}.full_name`);
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(fullName)) throw new Error(`Malformed ${name}.full_name`);
  return { name: fullName.toLowerCase(), id: positiveInteger(repo.id, `${name}.id`) };
}
function branch(value: unknown, name: string): { ref: string; sha: string; repo: { name: string; id: number } } {
  const branch = record(value, name);
  const ref = string(branch.ref, `${name}.ref`);
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') ||
      ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') ||
      ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) throw new Error(`Malformed ${name}.ref`);
  const sha = string(branch.sha, `${name}.sha`);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Malformed ${name}.sha`);
  return { ref, sha, repo: repository(branch.repo, `${name}.repo`) };
}
export function evaluatePullRequestTarget(event: unknown, expectedRepository: string): PullRequestTarget {
  const payload = record(event, 'event');
  const repo = repository(payload.repository, 'repository');
  if (repo.name !== expectedRepository.toLowerCase()) throw new Error('Event repository does not match GITHUB_REPOSITORY');
  const pr = record(payload.pull_request, 'pull_request');
  const number = positiveInteger(payload.number, 'number');
  if (pr.number !== number) throw new Error('Pull request number mismatch');
  const base = branch(pr.base, 'base');
  const head = branch(pr.head, 'head');
  if (base.repo.name !== repo.name || base.repo.id !== repo.id) throw new Error('Base repository mismatch');
  const sameRepository = head.repo.name === repo.name && head.repo.id === repo.id;
  if ((head.repo.name === repo.name) !== (head.repo.id === repo.id)) throw new Error('Head repository identity mismatch');
  let kind: PullRequestTarget['kind'] = 'ordinary';
  if (head.ref === INTEGRATION) {
    if (base.ref !== 'main' || !sameRepository) throw new Error('Only the same-repository integration branch may release v2 to main');
    kind = 'v2-release';
  } else if (V2_TASK.test(head.ref)) {
    if (base.ref !== INTEGRATION) throw new Error('V2 task pull requests must target codex/platform-v2');
    kind = 'v2-task';
  }
  return { kind, baseRef: base.ref, headRef: head.ref, baseSha: base.sha, headSha: head.sha, number };
}
export function validateMergeResult(target: PullRequestTarget, ref: string, sha: string, git: (args: string[]) => string): void {
  if (ref !== `refs/pull/${target.number}/merge`) throw new Error('Expected the default pull request merge ref');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Malformed GITHUB_SHA');
  if (git(['rev-parse', 'HEAD']).trim() !== sha) throw new Error('Checkout is not GITHUB_SHA');
  const parents = git(['show', '-s', '--format=%P', 'HEAD']).trim().split(/\s+/);
  if (parents.length !== 2 || parents[0] !== target.baseSha || parents[1] !== target.headSha) throw new Error('Merge commit parents do not match the event base/head SHAs');
}
function main(): void {
  const mode = process.argv[2] ?? 'target';
  if (mode !== 'target' && mode !== 'merge-result') throw new Error('Expected target or merge-result mode');
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    console.log('PR guard: push event; application checks still run.');
    return;
  }
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Expected pull_request or push event');
  const event: unknown = JSON.parse(readFileSync(string(process.env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH'), 'utf8'));
  const target = evaluatePullRequestTarget(event, string(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'));
  if (mode === 'merge-result') validateMergeResult(target, string(process.env.GITHUB_REF, 'GITHUB_REF'), string(process.env.GITHUB_SHA, 'GITHUB_SHA'),
    (args) => execFileSync('git', args, { encoding: 'utf8' }));
  const evidence = `PR #${target.number}: ${target.kind}; ${target.headRef} → ${target.baseRef}\n` +
    `Base SHA: ${target.baseSha}\nHead SHA: ${target.headSha}\n` +
    (mode === 'merge-result' ? `Validated merge-result SHA: ${process.env.GITHUB_SHA}\n` : 'Target policy passed.\n');
  console.log(evidence);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### PR ${mode} evidence\n\n\`\`\`text\n${evidence}\`\`\`\n`);
}
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`PR guard failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
