/**
 * Ambient module declaration for `expo-task-manager`. Not installed in
 * the workspace yet (same gate as `expo-notifications` — see
 * `types/expo-notifications.d.ts`). Declares only what `src/push/push.ts`
 * and `src/push/backgroundTask.ts` touch. Delete both stubs when the
 * packages become real dependencies.
 */
declare module 'expo-task-manager' {
  export interface TaskManagerTaskBody {
    data: unknown;
    error: unknown | null;
    executionInfo: unknown;
  }

  export type TaskManagerTaskExecutor = (body: TaskManagerTaskBody) => Promise<void> | void;

  export function defineTask(taskName: string, executor: TaskManagerTaskExecutor): void;
}
