import type { Command } from 'commander';
import pc from 'picocolors';
import {
  createTargetAdapter,
  detectExternalDependencies,
  findFreePort,
  generateMockResponses,
  getStore,
  mockDependencyUrl,
  ProviderRouter,
  startMockServer,
  type ExternalDependency,
  type MockServerHandle,
  type ProviderId,
} from '@healix/core';

/**
 * Describe how (or whether) each detected dependency is actually mocked in
 * THIS manual session — deliberately distinct from a full `healix run`: there
 * is no Playwright test executing here, so 'route-intercept' dependencies
 * (page.route() interception) cannot be active outside a generated suite.
 * Overclaiming that they're mocked here would be misleading.
 */
function describeStatus(dep: ExternalDependency): string {
  if (dep.mockStrategy === 'undeterminable') {
    return pc.yellow(`not mocked${dep.note ? ` — ${dep.note}` : ''}`);
  }
  if (dep.mockStrategy === 'route-intercept') {
    return pc.dim(
      'only mockable inside a generated Playwright run (page.route) — not active in this manual session',
    );
  }
  return pc.green(`mocked — ${dep.envVar} redirected to the local mock server`);
}

function printDependencies(deps: ExternalDependency[]): void {
  console.log('');
  console.log(pc.bold('  External dependencies'));
  if (deps.length === 0) {
    console.log(pc.dim('    None detected.'));
    console.log('');
    return;
  }
  for (const d of deps) {
    console.log(`    ${pc.cyan('•')} ${pc.bold(d.label)} ${pc.dim(`[${d.category}]`)}`);
    console.log(`      ${describeStatus(d)}`);
  }
  console.log('');
}

export function registerMockLaunch(program: Command): void {
  program
    .command('mock-launch')
    .description(
      'Detect external dependencies (backend APIs, third-party SMS/email/OTP/payment services), mock the ones this session can reach, and launch the app locally for manual testing',
    )
    .requiredOption('--project <id>', 'project id to launch')
    .option(
      '--provider <provider>',
      'AI provider for generating mock response content (falls back to static templates)',
    )
    .action(async (opts: { project: string; provider?: string }) => {
      const store = await getStore();
      if (!store) {
        console.log('');
        console.log(pc.yellow('  ⚠ Local storage is unavailable on this runtime.'));
        console.log(
          pc.dim('    Healix needs node:sqlite (Node 22.5+ with --experimental-sqlite, or Node 23.4+).'),
        );
        console.log('');
        process.exitCode = 1;
        return;
      }

      const project = store.getProject(opts.project);
      if (!project) {
        console.log('');
        console.log(pc.red(`  ✖ No project found with id ${pc.bold(opts.project)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }
      if (!project.repoPath) {
        console.log('');
        console.log(
          pc.red(
            '  ✖ mock-launch requires a white-box project (registered with --repo) — there is no source to scan.',
          ),
        );
        console.log('');
        process.exitCode = 1;
        return;
      }
      const repoPath = project.repoPath;

      console.log('');
      console.log(`  ${pc.bold('Detecting external dependencies')} ${pc.dim(`for ${project.name}`)}`);
      let dependencies: ExternalDependency[] = [];
      try {
        dependencies = await detectExternalDependencies(repoPath);
      } catch (err) {
        console.log(pc.yellow(`    Detection failed (continuing without mocks): ${errMsg(err)}`));
      }
      console.log(
        pc.dim(`    Found ${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}.`),
      );

      // Best-effort AI content generation — falls back to static templates
      // (see generateMockResponses) when no provider is requested/ready, so a
      // quick manual launch never blocks on AI auth/availability.
      let provider;
      try {
        const router = new ProviderRouter();
        provider = opts.provider
          ? router.get(opts.provider as ProviderId)
          : (await router.select('codegen'))?.provider;
      } catch {
        provider = undefined;
      }
      const mockResponses = await generateMockResponses(dependencies, provider, { repoPath });

      const envOverrideDeps = dependencies.filter(
        (d) => d.envVar && (d.mockStrategy === 'env-override' || d.mockStrategy === 'both'),
      );

      let mockServer: MockServerHandle | undefined;
      if (envOverrideDeps.length > 0) {
        try {
          mockServer = await startMockServer(mockResponses);
          console.log(pc.dim(`    Mock server listening at ${mockServer.baseUrl}`));
        } catch (err) {
          console.log(pc.yellow(`    Failed to start mock server (continuing without it): ${errMsg(err)}`));
        }
      }

      const target = createTargetAdapter();
      let detected: Awaited<ReturnType<typeof target.detect>>;
      try {
        detected = await target.detect(repoPath);
      } catch (err) {
        console.log('');
        console.log(pc.red(`  ✖ Detection failed: ${errMsg(err)}`));
        console.log('');
        await mockServer?.stop();
        process.exitCode = 1;
        return;
      }
      if (!detected.startCommand) {
        console.log('');
        console.log(
          pc.red('  ✖ Could not determine a start command for this project. Try `healix scan <repo>` first.'),
        );
        console.log('');
        await mockServer?.stop();
        process.exitCode = 1;
        return;
      }

      const port = await findFreePort(detected.port ?? undefined);
      const env: Record<string, string> = {};
      if (mockServer) {
        for (const dep of envOverrideDeps) {
          if (dep.envVar) env[dep.envVar] = mockDependencyUrl(mockServer.baseUrl, dep.id);
        }
      }

      console.log('');
      console.log(`  ${pc.bold('Launching')} ${pc.dim(detected.startCommand)}`);
      let handle: Awaited<ReturnType<typeof target.launch>>;
      try {
        handle = await target.launch({
          repoPath,
          startCommand: detected.startCommand,
          installCommand: detected.installCommand ?? undefined,
          installDir: detected.installDir ?? undefined,
          baseUrl: port === detected.port ? (detected.baseUrl ?? undefined) : undefined,
          port,
          readyTimeoutMs: 120_000,
          env,
        });
      } catch (err) {
        console.log('');
        console.log(pc.red(`  ✖ Launch failed: ${errMsg(err)}`));
        console.log('');
        await mockServer?.stop();
        process.exitCode = 1;
        return;
      }

      console.log('');
      console.log(`  ${pc.green('✔')} App running at ${pc.bold(handle.baseUrl)}`);
      printDependencies(dependencies);
      console.log(pc.dim('  Press Ctrl+C to stop.'));
      console.log('');

      let stopping = false;
      const shutdown = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        console.log('');
        console.log(pc.dim('  Stopping…'));
        await handle.stop();
        await mockServer?.stop();
        console.log(pc.dim('  Stopped.'));
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      // Keep the process alive until Ctrl+C (or the app itself exits).
      await new Promise<void>(() => undefined);
    });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
