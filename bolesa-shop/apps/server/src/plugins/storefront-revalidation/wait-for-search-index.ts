const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_IDLE_POLLS = 2;

export async function waitForSearchIndexToSettle(
    countActiveJobs: () => Promise<number>,
    options?: {
        timeoutMs?: number;
        intervalMs?: number;
        idlePolls?: number;
        sleep?: (ms: number) => Promise<void>;
        now?: () => number;
    },
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    const idlePollsRequired = options?.idlePolls ?? DEFAULT_IDLE_POLLS;
    const sleep = options?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = options?.now ?? Date.now;
    const deadline = now() + timeoutMs;
    let idlePolls = 0;

    while (now() < deadline) {
        await sleep(intervalMs);
        const activeJobs = await countActiveJobs();
        if (activeJobs === 0) {
            idlePolls += 1;
            if (idlePolls >= idlePollsRequired) {
                return;
            }
        } else {
            idlePolls = 0;
        }
    }
}
