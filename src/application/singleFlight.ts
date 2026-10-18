/**
 * Collapse concurrent calls for the same key into one in-flight promise.
 *
 * Used to stop a cache stampede: when `auth:ctx:{id}` expires while a
 * dashboard fires 10 parallel requests, only one of them hits the database.
 * Scope is per process — with N cluster workers the worst case is N queries.
 */
export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = task().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
