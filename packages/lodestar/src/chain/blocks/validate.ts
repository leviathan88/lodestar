import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";

import {IBlockJob} from "../interface";
import {IBeaconClock} from "../clock";
import {BlockError, BlockErrorCode} from "../errors";

export async function validateBlocks({
  config,
  forkChoice,
  clock,
  jobs,
}: {
  config: IBeaconConfig;
  forkChoice: IForkChoice;
  clock: IBeaconClock;
  jobs: IBlockJob[];
}): Promise<void> {
  if (jobs.length === 0) {
    return; // No jobs to validate
  }

  // only validate PARENT_UNKNOWN condition for 1st block
  const firstJob = jobs[0];
  const firstJobAncestorRoot = firstJob.signedBlock.message.parentRoot;
  if (!forkChoice.hasBlock(firstJobAncestorRoot)) {
    throw new BlockError({
      code: BlockErrorCode.PARENT_UNKNOWN,
      parentRoot: firstJobAncestorRoot.valueOf() as Uint8Array,
      job: firstJob,
    });
  }

  let parentRoot = firstJobAncestorRoot;

  for (const job of jobs) {
    try {
      const blockHash = config.types.BeaconBlock.hashTreeRoot(job.signedBlock.message);
      const blockSlot = job.signedBlock.message.slot;
      if (blockSlot === 0) {
        throw new BlockError({
          code: BlockErrorCode.GENESIS_BLOCK,
          job,
        });
      }

      if (!job.reprocess && forkChoice.hasBlock(blockHash)) {
        throw new BlockError({
          code: BlockErrorCode.BLOCK_IS_ALREADY_KNOWN,
          job,
        });
      }

      const finalizedCheckpoint = forkChoice.getFinalizedCheckpoint();
      const finalizedSlot = computeStartSlotAtEpoch(config, finalizedCheckpoint.epoch);
      if (blockSlot <= finalizedSlot) {
        throw new BlockError({
          code: BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT,
          blockSlot,
          finalizedSlot,
          job,
        });
      }

      const currentSlotWithGossipDisparity = clock.currentSlotWithGossipDisparity;
      if (blockSlot > currentSlotWithGossipDisparity) {
        throw new BlockError({
          code: BlockErrorCode.FUTURE_SLOT,
          blockSlot,
          currentSlot: currentSlotWithGossipDisparity,
          job,
        });
      }

      if (!config.types.Root.equals(parentRoot, job.signedBlock.message.parentRoot)) {
        throw new BlockError({
          code: BlockErrorCode.NON_LINEAR_PARENT_ROOTS,
          blockSlot,
          job,
        });
      }

      parentRoot = blockHash;
    } catch (e) {
      if (e instanceof BlockError) {
        throw e;
      }

      throw new BlockError({
        code: BlockErrorCode.BEACON_CHAIN_ERROR,
        error: e,
        job,
      });
    }
  }
}
