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
