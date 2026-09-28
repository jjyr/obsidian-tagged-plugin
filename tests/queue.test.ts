import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkQueue, type Clock } from '../src/plugin/queue';

class FakeClock implements Clock {
  id = 0;
  tasks = new Map<number, () => void>();
  set(fn: () => void) {
    const id = ++this.id;
    this.tasks.set(id, fn);
    return id;
  }
  clear(id: number) {
    this.tasks.delete(id);
  }
  fire() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    tasks.forEach((fn) => fn());
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('rapid saves debounce to one job; plugin unload clears timers', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const queue = new WorkQueue(
    clock,
    async (key: string) => {
      calls.push(key);
    },
    (error) => assert.fail(String(error)),
  );
  queue.schedule('a', 15000);
  queue.schedule('a', 15000);
  queue.schedule('a', 15000);
  assert.equal(clock.tasks.size, 1);
  clock.fire();
  await tick();
  assert.deepEqual(calls, ['a']);
  queue.schedule('b', 15000);
  queue.stop();
  clock.fire();
  await tick();
  assert.deepEqual(calls, ['a']);
});
test('only one worker runs, later edits queue once, and failures do not block other notes', async () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  let release!: () => void;
  const errors: unknown[] = [];
  const queue = new WorkQueue(
    clock,
    async (key: string) => {
      calls.push(key);
      if (key === 'a' && calls.length === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      if (key === 'b') throw new Error('failed');
    },
    (error) => errors.push(error),
  );
  queue.add('a');
  queue.add('b');
  queue.add('b');
  queue.schedule('a', 15);
  clock.fire();
  assert.deepEqual(calls, ['a']);
  release();
  await tick();
  assert.deepEqual(calls, ['a', 'b', 'a']);
  assert.equal(errors.length, 1);
});

test('manual retries retain their force flag across subsequent automatic debounce', async () => {
  const clock = new FakeClock();
  const calls: boolean[] = [];
  const queue = new WorkQueue(
    clock,
    async (_key: string, force) => {
      calls.push(force);
    },
    (error) => assert.fail(String(error)),
  );
  queue.schedule('note', 15000, true);
  queue.schedule('note', 15000);
  clock.fire();
  await tick();
  assert.deepEqual(calls, [true]);
});
