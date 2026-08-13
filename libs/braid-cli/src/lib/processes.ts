import { spawn, type ChildProcess } from 'node:child_process';
import type { ResolvedTarget } from './config.js';

/** ANSI colors, cycled per process so interleaved logs stay readable. */
const COLORS = ['[36m', '[35m', '[32m', '[33m', '[34m'];
const RESET = '[0m';
const DIM = '[2m';

export interface ManagedProcess {
  label: string;
  child: ChildProcess;
}

/**
 * Starts a dev target's command, prefixing every line it prints with the target's name.
 *
 * Ports are passed explicitly rather than inherited: dev servers commonly read `PORT`, and a
 * child that inherits the parent's would silently collide with another one.
 */
export function startTarget(label: string, target: ResolvedTarget, index: number): ManagedProcess | null {
  if (!target.command) return null;

  const color = COLORS[index % COLORS.length];
  const port = new URL(target.url).port;

  const child = spawn(target.command, {
    cwd: target.cwd,
    shell: true,
    env: { ...process.env, ...(port ? { PORT: port } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${color}${label}${RESET} ${DIM}|${RESET} `;
  const forward = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) => {
    stream?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) sink.write(`${prefix}${line}\n`);
      }
    });
  };

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`${prefix}exited with code ${code}\n`);
    }
  });

  return { label, child };
}

/** Waits until a target answers, so "ready" means ready rather than "spawned". */
export async function waitForTarget(target: ResolvedTarget, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fetch(target.url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return false;
}

/** Kills every managed process, on purpose or on the way out. */
export function stopAll(processes: ManagedProcess[]): void {
  for (const { child } of processes) {
    if (!child.killed) child.kill();
  }
}
