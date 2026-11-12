import type { Config } from './config.js';
import type { RelayDb } from './db.js';

export type LookupFn = (hostname: string) => Promise<string[]>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Deps = {
  config: Config;
  db: RelayDb;
  now: () => number;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
};
