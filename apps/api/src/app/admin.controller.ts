import { Controller, Post } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEPLOY_SCRIPT = join('tools', 'deploy-demo.mjs');
const DEPLOY_TIMEOUT_MS = 120_000;

interface RedeployResult {
  ok: boolean;
  buildId?: string;
  message: string;
}

/**
 * Demo-only operations that exist so the browser does not have to send you to
 * a terminal mid-demonstration.
 *
 * The whole chunk-recovery scenario depends on redeploying the remote *while a
 * tab is open* — and asking someone to alt-tab, find the right shell, and
 * remember a script name in the middle of watching a live failure is how a
 * demo loses its audience. This runs the same `tools/deploy-demo.mjs` the npm
 * script does.
 *
 * ## On shelling out from an HTTP handler
 *
 * This is a local development tool and nothing else. The safeguards are
 * deliberate rather than incidental:
 *
 * - **`execFile`, not `exec`.** No shell is spawned, so there is no
 *   metacharacter interpretation to get wrong.
 * - **The argument vector is a literal.** Nothing from the request reaches
 *   the command line — not the remote name, not a path, nothing. There is no
 *   input to inject through, which is a stronger property than validating one.
 * - **The API binds localhost and CORS is restricted** to the three demo
 *   origins (see `main.ts`).
 *
 * It should not ship in anything reachable from a network you do not own. If
 * this app ever grows a real deployment, delete this file first.
 */
@Controller('admin')
export class AdminController {
  @Post('redeploy-remote')
  redeployRemote(): Promise<RedeployResult> {
    const cwd = process.cwd();

    if (!existsSync(join(cwd, DEPLOY_SCRIPT))) {
      return Promise.resolve({
        ok: false,
        message: `Could not find ${DEPLOY_SCRIPT} relative to ${cwd}. Start the API from the workspace root (npm run api).`,
      });
    }

    return new Promise<RedeployResult>((resolve) => {
      execFile(
        process.execPath,
        [DEPLOY_SCRIPT, 'remote'],
        { cwd, timeout: DEPLOY_TIMEOUT_MS },
        (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`;
          // The script announces itself as "✔ prod-remote deployed as <id>".
          const buildId = /deployed as (\S+)/.exec(output)?.[1];

          if (error) {
            resolve({
              ok: false,
              message: `Deploy failed: ${error.message.split('\n')[0]}`,
            });
            return;
          }

          resolve({
            ok: true,
            buildId,
            message: buildId
              ? `Remote redeployed as ${buildId}. Its chunk hashes changed; the tab is now holding file names that no longer exist.`
              : 'Remote redeployed.',
          });
        },
      );
    });
  }
}
