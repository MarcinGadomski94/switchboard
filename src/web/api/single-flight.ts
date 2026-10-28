/**
 * D144: one load at a time, never restarted. A {@link SingleFlight.run} while the
 * load is on its way asks for **one** more run after it (however many asks came in
 * between), so a slow answer always lands and the newest state is still read
 * afterwards. Before D144 the session view and the count dropped the load in flight
 * on every `/hub` event and started a new one: an answer slower than the events'
 * pace (a large working tree's detail on a busy agent) never landed.
 */
export class SingleFlight {
  readonly #work: () => Promise<void>;
  #running = false;
  #again = false;
  #closed = false;

  constructor(work: () => Promise<void>) {
    this.#work = work;
  }

  /** `true` while a load is on its way. */
  get running(): boolean {
    return this.#running;
  }

  /** Loads now, or once more after the load on its way. */
  run(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    let work: Promise<void>;
    try {
      work = this.#work();
    } catch (error) {
      work = Promise.reject(error);
    }
    void work
      .catch(() => undefined)
      .finally(() => {
        this.#running = false;
        if (this.#again && !this.#closed) {
          this.#again = false;
          this.run();
        }
      });
  }

  /** No more runs (the view went away or shows another session); the answer on its way is the caller's to ignore. */
  close(): void {
    this.#closed = true;
    this.#again = false;
  }
}
