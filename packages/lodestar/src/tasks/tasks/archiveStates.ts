/**
 * @module tasks
 */

import {ILogger} from "@chainsafe/lodestar-utils";
import {phase0} from "@chainsafe/lodestar-types";
import {TreeBacked} from "@chainsafe/ssz";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconDb} from "../../db/api";
import {IBeaconChain} from "../../chain";

/**
 * Minimum number of epochs between archived states
 */
const PERSIST_STATE_EVERY_EPOCHS = 1024;
/**
 * Minimum number of epochs between single temp archived states
 * These states will be pruned once a new state is persisted
 */
const PERSIST_TEMP_STATE_EVERY_EPOCHS = 32;

export type StatesArchiverModules = {
  chain: IBeaconChain;
  db: IBeaconDb;
  logger: ILogger;
};

/**
 * Archives finalized states from active bucket to archive bucket.
 *
 * Only the new finalized state is stored to disk
 */
export class StatesArchiver {
  private readonly config: IBeaconConfig;
  private readonly chain: IBeaconChain;
  private readonly db: IBeaconDb;
  private readonly logger: ILogger;

  constructor(config: IBeaconConfig, modules: StatesArchiverModules) {
    this.config = config;
    this.chain = modules.chain;
    this.db = modules.db;
    this.logger = modules.logger;
  }

  /**
   * Persist states every some epochs to
   * - Minimize disk space, storing the least states possible
   * - Minimize the sync progress lost on unexpected crash, storing temp state every few epochs
   *
   * At epoch `x` there will be states peristed at intervals of `MIN_EPOCHS_PER_DB_STATE`
   * and one at `MIN_EPOCHS_PER_DB_STATE / LATEST_STATE_FACTOR`
   * ```
   *    |         |       |    |
   * x-1024*2  x-1024   x-32   x
   * ```
   */
  async maybeArchiveState(finalized: phase0.Checkpoint): Promise<void> {
    const lastStoredSlot = await this.db.stateArchive.lastKey();
    const lastStoredEpoch = computeEpochAtSlot(this.config, lastStoredSlot || 0);

    if (finalized.epoch - lastStoredEpoch > PERSIST_TEMP_STATE_EVERY_EPOCHS) {
      await this.archiveState(finalized);

      const storedEpochs = await this.db.stateArchive.keys({lt: finalized.epoch});
      const statesToDelete = computeEpochsToDelete(storedEpochs, PERSIST_STATE_EVERY_EPOCHS);
      if (statesToDelete.length > 0) {
        await this.db.stateArchive.batchDelete(statesToDelete);
      }
    }
  }

  /**
   * Archives finalized states from active bucket to archive bucket.
   * Only the new finalized state is stored to disk
   */
  async archiveState(finalized: phase0.Checkpoint): Promise<void> {
    const stateCache = this.chain.checkpointStateCache.get(finalized);
    if (!stateCache) {
      throw Error("No state in cache for finalized checkpoint state epoch #" + finalized.epoch);
    }
    const finalizedState = stateCache.state;
    await this.db.stateArchive.put(
      finalizedState.slot,
      finalizedState.getOriginalState() as TreeBacked<phase0.BeaconState>
    );
    // don't delete states before the finalized state, auto-prune will take care of it
    this.logger.verbose("Archive states completed", {finalizedEpoch: finalized.epoch});
  }
}

/**
 * Keeps first epoch per bucket of persistEveryEpochs, deletes the rest
 */
export function computeEpochsToDelete(storedEpochs: number[], persistEveryEpochs: number): number[] {
  const epochBuckets = new Set<number>();
  const toDelete = new Set<number>();
  for (const epoch of storedEpochs) {
    const epochBucket = epoch - (epoch % persistEveryEpochs);
    if (epochBuckets.has(epochBucket)) {
      toDelete.add(epoch);
    } else {
      epochBuckets.add(epochBucket);
    }
  }

  return Array.from(toDelete.values());
}
