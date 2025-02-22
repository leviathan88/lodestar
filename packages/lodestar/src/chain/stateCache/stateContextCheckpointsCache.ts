import {toHexString, fromHexString} from "@chainsafe/ssz";
import {phase0, Epoch} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ITreeStateContext} from "../interface";

/**
 * In memory cache of BeaconState and connected EpochContext
 * belonging to checkpoint
 *
 * Similar API to Repository
 */
export class CheckpointStateCache {
  private readonly config: IBeaconConfig;
  private cache: Record<string, ITreeStateContext>;
  /**
   * Epoch -> Set<blockRoot>
   */
  private epochIndex: Record<Epoch, Set<string>>;

  constructor(config: IBeaconConfig) {
    this.config = config;
    this.cache = {};
    this.epochIndex = {};
  }

  get(cp: phase0.Checkpoint): ITreeStateContext | null {
    const item = this.cache[toHexString(this.config.types.phase0.Checkpoint.hashTreeRoot(cp))];
    if (!item) {
      return null;
    }
    return this.clone(item);
  }

  add(cp: phase0.Checkpoint, item: ITreeStateContext): void {
    const key = toHexString(this.config.types.phase0.Checkpoint.hashTreeRoot(cp));
    if (this.cache[key]) {
      return;
    }
    this.cache[key] = this.clone(item);
    const epochKey = toHexString(cp.root);
    if (this.epochIndex[cp.epoch]) {
      this.epochIndex[cp.epoch].add(epochKey);
    } else {
      this.epochIndex[cp.epoch] = new Set([epochKey]);
    }
  }

  /**
   * Searches for the latest cached state with a `root`, starting with `epoch` and descending
   */
  getLatest({root, epoch}: phase0.Checkpoint): ITreeStateContext | null {
    const hexRoot = toHexString(root);
    // sort epochs in descending order, only consider epochs lte `epoch`
    const epochs = Object.keys(this.epochIndex)
      .map(Number)
      .sort((a, b) => b - a)
      .filter((e) => e <= epoch);
    for (const epoch of epochs) {
      const rootSet = this.epochIndex[epoch];
      if (rootSet && rootSet.has(hexRoot)) {
        return this.get({root, epoch});
      }
    }
    return null;
  }

  pruneFinalized(finalizedEpoch: Epoch): void {
    for (const epoch of Object.keys(this.epochIndex).map(Number)) {
      if (epoch < finalizedEpoch) {
        this.deleteAllEpochItems(epoch);
      }
    }
  }

  prune(finalizedEpoch: Epoch, justifiedEpoch: Epoch): void {
    const epochs = Object.keys(this.epochIndex)
      .map(Number)
      .filter((epoch) => epoch !== finalizedEpoch && epoch !== justifiedEpoch);
    const MAX_EPOCHS = 10;
    if (epochs.length > MAX_EPOCHS) {
      for (const epoch of epochs.slice(0, epochs.length - MAX_EPOCHS)) {
        this.deleteAllEpochItems(epoch);
      }
    }
  }

  delete(cp: phase0.Checkpoint): void {
    const key = toHexString(this.config.types.phase0.Checkpoint.hashTreeRoot(cp));
    delete this.cache[key];
    const epochKey = toHexString(cp.root);
    this.epochIndex[cp.epoch]?.delete(epochKey);
    if (!this.epochIndex[cp.epoch]?.size) {
      delete this.epochIndex[cp.epoch];
    }
  }

  deleteAllEpochItems(epoch: Epoch): void {
    for (const hexRoot of this.epochIndex[epoch] || []) {
      delete this.cache[
        toHexString(this.config.types.phase0.Checkpoint.hashTreeRoot({root: fromHexString(hexRoot), epoch}))
      ];
    }
    delete this.epochIndex[epoch];
  }

  clear(): void {
    this.cache = {};
    this.epochIndex = {};
  }

  private clone(item: ITreeStateContext): ITreeStateContext {
    return {
      state: item.state.clone(),
      epochCtx: item.epochCtx.copy(),
    };
  }
}
