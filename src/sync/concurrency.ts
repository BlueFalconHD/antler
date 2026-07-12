export async function mapLimit<Input, Output>(
  values: readonly Input[],
  limit: number,
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive integer");
  }
  const output = new Array<Output>(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) {
        return;
      }
      const value = values[index];
      if (value !== undefined) {
        output[index] = await operation(value, index);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

export type EnqueueTask<Input> = (value: Input) => void;

export function drainTaskQueue<Input>(
  initialValues: readonly Input[],
  limit: number,
  operation: (value: Input, enqueue: EnqueueTask<Input>) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    return Promise.reject(new Error("Concurrency limit must be a positive integer"));
  }

  return new Promise((resolve, reject) => {
    const pending = [...initialValues];
    let active = 0;
    let failure: unknown;
    let failed = false;

    const enqueue = (value: Input) => {
      if (!failed) {
        pending.push(value);
        pump();
      }
    };
    const finish = () => {
      active -= 1;
      pump();
    };
    const fail = (error: unknown) => {
      if (!failed) {
        failed = true;
        failure = error;
        pending.length = 0;
      }
      active -= 1;
      pump();
    };
    const pump = () => {
      while (!failed && active < limit && pending.length > 0) {
        const value = pending.shift()!;
        active += 1;
        void operation(value, enqueue).then(finish, fail);
      }
      if (active === 0 && pending.length === 0) {
        if (failed) reject(failure);
        else resolve();
      }
    };

    pump();
  });
}
