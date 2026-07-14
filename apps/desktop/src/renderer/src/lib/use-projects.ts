import { useCallback, useEffect, useState } from 'react';
import type { NewProject, Project } from '@healix/core';

export interface ProjectsState {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: NewProject) => Promise<Project | null>;
  /** Updates a project's editable fields (name, mode, repoPath, baseUrl). */
  update: (id: string, input: NewProject) => Promise<Project | null>;
  /** Permanently deletes the project, its runs, and all on-disk assets. */
  remove: (id: string) => Promise<void>;
  /** Soft-archive (or restore) a project; all data is kept. */
  archive: (id: string, archived: boolean) => Promise<void>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared CRUD over the persisted project list (backed by IPC -> SQLite store). */
export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await window.healix.listProjects());
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: NewProject): Promise<Project | null> => {
      setError(null);
      try {
        const created = await window.healix.createProject(input);
        await refresh();
        return created;
      } catch (err) {
        setError(toMessage(err));
        return null;
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, input: NewProject): Promise<Project | null> => {
      setError(null);
      try {
        const updated = await window.healix.updateProject(id, input);
        await refresh();
        return updated;
      } catch (err) {
        setError(toMessage(err));
        return null;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        const res = await window.healix.deleteProject(id);
        if (!res.assetsRemoved) {
          setError('Project deleted, but some on-disk assets could not be removed.');
        }
        await refresh();
      } catch (err) {
        setError(toMessage(err));
      }
    },
    [refresh],
  );

  const archive = useCallback(
    async (id: string, archived: boolean): Promise<void> => {
      setError(null);
      try {
        await window.healix.archiveProject(id, archived);
        await refresh();
      } catch (err) {
        setError(toMessage(err));
      }
    },
    [refresh],
  );

  return { projects, loading, error, refresh, create, update, remove, archive };
}
