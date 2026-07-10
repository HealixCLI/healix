import type { Command } from 'commander';
import pc from 'picocolors';
import { deleteProjectAssets, getStore, type ModeId, type NewProject, type Project } from '@healix/core';

/** Print a friendly hint when the local SQLite store is unavailable. */
function storeUnavailable(): void {
  console.log('');
  console.log(pc.yellow('  ⚠ Local storage is unavailable on this runtime.'));
  console.log(
    pc.dim(
      '    Healix needs node:sqlite (Node 22.5+ with --experimental-sqlite, or Node 23.4+). Run `healix doctor`.',
    ),
  );
  console.log('');
}

function fmtCell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
}

function printProjectRow(p: Project): void {
  const id = fmtCell(p.id, 18);
  const name = fmtCell(p.name, 24);
  const mode = fmtCell(p.mode, 12);
  const target = p.baseUrl ?? p.repoPath ?? pc.dim('—');
  const archived = p.archivedAt ? `  ${pc.yellow('[archived]')}` : '';
  console.log(`  ${pc.bold(id)}  ${name}  ${pc.cyan(mode)}  ${pc.dim(target)}${archived}`);
}

function printProjectDetail(p: Project): void {
  console.log('');
  console.log(`  ${pc.bold(p.name)}  ${pc.dim(`(${p.id})`)}`);
  console.log(`    ${pc.dim('mode')}      ${pc.cyan(p.mode)}`);
  console.log(`    ${pc.dim('repo')}      ${p.repoPath ?? pc.dim('—')}`);
  console.log(`    ${pc.dim('baseUrl')}   ${p.baseUrl ?? pc.dim('—')}`);
  console.log(`    ${pc.dim('created')}   ${p.createdAt}`);
  if (p.archivedAt) console.log(`    ${pc.dim('archived')}  ${pc.yellow(p.archivedAt)}`);
  console.log('');
}

export function registerProject(program: Command): void {
  const cmd = program.command('project').description('Manage Healix projects (apps under test)');

  cmd
    .command('add')
    .description('Register a new project')
    .requiredOption('--name <name>', 'human-readable project name')
    .option('--repo <path>', 'path to the project repository (white-box access)')
    .option('--url <baseUrl>', 'base URL of the running app (black-box access)')
    .option('--mode <mode>', 'test engine mode (default: playwright)', 'playwright')
    .action(async (opts: { name: string; repo?: string; url?: string; mode?: string }) => {
      const store = await getStore();
      if (!store) return storeUnavailable();

      const input: NewProject = {
        name: opts.name,
        mode: (opts.mode ?? 'playwright') as ModeId,
        repoPath: opts.repo ?? null,
        baseUrl: opts.url ?? null,
      };
      const project = store.createProject(input);
      console.log('');
      console.log(`  ${pc.green('✔')} Created project ${pc.bold(project.name)} ${pc.dim(`(${project.id})`)}`);
      printProjectDetail(project);
    });

  cmd
    .command('list')
    .description('List registered projects')
    .action(async () => {
      const store = await getStore();
      if (!store) return storeUnavailable();

      const projects = store.listProjects();
      console.log('');
      if (projects.length === 0) {
        console.log(pc.dim('  No projects yet. Add one with `healix project add --name <name>`.'));
        console.log('');
        return;
      }
      console.log(
        `  ${pc.dim(fmtCell('ID', 18))}  ${pc.dim(fmtCell('NAME', 24))}  ${pc.dim(fmtCell('MODE', 12))}  ${pc.dim('TARGET')}`,
      );
      for (const p of projects) printProjectRow(p);
      console.log('');
    });

  cmd
    .command('show <id>')
    .description('Show a single project')
    .action(async (id: string) => {
      const store = await getStore();
      if (!store) return storeUnavailable();

      const project = store.getProject(id);
      if (!project) {
        console.log('');
        console.log(pc.red(`  ✖ No project found with id ${pc.bold(id)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }
      printProjectDetail(project);
    });

  cmd
    .command('rm <id>')
    .description('Permanently remove a project, its runs, and all on-disk assets')
    .option('--keep-assets', 'delete only the database rows; keep run folders on disk')
    .action(async (id: string, opts: { keepAssets?: boolean }) => {
      const store = await getStore();
      if (!store) return storeUnavailable();

      const project = store.getProject(id);
      if (!project) {
        console.log('');
        console.log(pc.red(`  ✖ No project found with id ${pc.bold(id)}.`));
        console.log('');
        process.exitCode = 1;
        return;
      }
      store.deleteProject(id);
      let assetNote = pc.dim('(kept on-disk assets)');
      if (!opts.keepAssets) {
        try {
          await deleteProjectAssets(id);
          assetNote = pc.dim('(runs, suites, and media removed from disk)');
        } catch (err) {
          assetNote = pc.yellow(
            `(could not remove on-disk assets: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      console.log('');
      console.log(
        `  ${pc.green('✔')} Removed project ${pc.bold(project.name)} ${pc.dim(`(${id})`)} ${assetNote}`,
      );
      console.log('');
    });

  cmd
    .command('archive <id>')
    .description('Soft-archive a project (keeps all runs and assets; hidden from new runs)')
    .action(async (id: string) => setArchived(id, true));

  cmd
    .command('unarchive <id>')
    .description('Restore an archived project')
    .action(async (id: string) => setArchived(id, false));
}

async function setArchived(id: string, archived: boolean): Promise<void> {
  const store = await getStore();
  if (!store) return storeUnavailable();

  const project = store.getProject(id);
  if (!project) {
    console.log('');
    console.log(pc.red(`  ✖ No project found with id ${pc.bold(id)}.`));
    console.log('');
    process.exitCode = 1;
    return;
  }
  store.setProjectArchived(id, archived);
  console.log('');
  console.log(
    `  ${pc.green('✔')} ${archived ? 'Archived' : 'Restored'} project ${pc.bold(project.name)} ${pc.dim(`(${id})`)}`,
  );
  console.log('');
}
