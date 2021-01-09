import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Root, SignedBeaconBlock} from "@chainsafe/lodestar-types";

/**
 * Randomize an array of items
 */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Sort by multiple conditions in order
 */
export function sortBy<T>(arr: T[], ...conditions: ((item: T) => number)[]): T[] {
  return arr.sort((a, b) => {
    for (const condition of conditions) {
      const ca = condition(a);
      const cb = condition(b);
      if (ca > cb) return 1;
      if (ca < cb) return -1;
    }
    return 0;
  });
}

/**
 * Compute a unique-ish ID of an array of blocks to track request results
 */
export function hashBlocks(config: IBeaconConfig, blocks: SignedBeaconBlock[]): Root {
  const hashes = blocks.map((block) => config.types.SignedBeaconBlock.hashTreeRoot(block));
  return Buffer.concat(hashes);
}

// TODO: Include in chainSegment block processor
export class BlockProcessorError extends Error {
  importedBlocks: SignedBeaconBlock[];
  error: Error;
  constructor(error: Error, importedBlocks: SignedBeaconBlock[]) {
    super(error.message);
    this.importedBlocks = importedBlocks;
    this.error = error;
  }
}
