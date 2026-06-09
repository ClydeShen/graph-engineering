import type { Pool } from 'pg';
import { occWrite } from './occ-write.js';
import type { OccWriteArgs } from './occ-write.js';
import type { WriteResult } from './types.js';

export type { OccWriteArgs };

export interface EventWriter {
  write(args: OccWriteArgs): Promise<WriteResult>;
}

export class OccEventWriter implements EventWriter {
  constructor(private readonly pool: Pool) {}
  write(args: OccWriteArgs): Promise<WriteResult> {
    return occWrite(this.pool, args);
  }
}
