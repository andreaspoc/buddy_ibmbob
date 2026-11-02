/** A subsequent turn waits for the previous workspace writer, outside the answer UI. */
export async function waitForBackgroundSave<T extends { status: string }>(
  jobId: string,
  read: (id: string, signal?: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500)),
): Promise<T> {
  while (true) {
    signal.throwIfAborted();
    const job = await read(jobId, signal);
    if (!['running', 'queued'].includes(job.status)) return job;
    await pause();
  }
}
