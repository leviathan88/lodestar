export interface ITriggerable extends AsyncGenerator<void> {
  trigger: () => void;
  end: (err?: Error) => void;
}

/**
 * Same as [`it-pushable`](https://github.com/alanshaw/it-pushable/blob/76a67cbe92d1db940311ee07775dbc662697e09c/index.d.ts)
 * but it does not buffer values, and this.end() stops the AsyncGenerator immediately
 */
export function itTrigger(): ITriggerable {
  let pushable: AsyncGenerator;
  let onNext: ((next: {error?: Error; done?: boolean}) => void) | null = null;
  let ended = false;
  let error: Error | null = null;
  let triggered = false;

  async function waitNext(): Promise<IteratorResult<void, void>> {
    if (error) {
      throw error;
    }
    if (ended) {
      return {done: true, value: undefined};
    }
    if (triggered) {
      triggered = false;
      return {done: false, value: undefined};
    }

    return new Promise((resolve, reject) => {
      onNext = (next) => {
        onNext = null;
        if (next.error) {
          reject(next.error);
        } else {
          resolve({done: Boolean(next.done), value: undefined});
        }
        return pushable;
      };
    });
  }

  function trigger(): void {
    triggered = true;
    if (onNext) return onNext({done: false});
  }

  function end(err?: Error): void {
    if (err) {
      error = err;
      if (onNext) return onNext({error: err});
    } else {
      ended = true;
      if (onNext) onNext({done: true});
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: waitNext,
    return: async () => {
      end();
      return {done: true, value: undefined};
    },
    throw: async (err: Error) => {
      end(err);
      return {done: true, value: undefined};
    },
    trigger,
    end,
  };
}
