import {computeStartSlotAtEpoch, getBlockRootAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Status} from "@chainsafe/lodestar-types";
import {toHexString} from "@chainsafe/ssz";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconChain} from "../../chain";
import {GENESIS_EPOCH, ZERO_HASH} from "../../constants";

interface IThisModules {
  chain: IBeaconChain;
  config: IBeaconConfig;
  logger: ILogger;
}

export async function shouldDisconnectOnStatus(
  peerStatus: Status,
  {config, chain, logger}: IThisModules
): Promise<boolean> {
  const forkDigest = await chain.getForkDigest();
  if (!config.types.ForkDigest.equals(forkDigest, peerStatus.forkDigest)) {
    logger.verbose("Fork digest mismatch", {
      expected: toHexString(forkDigest),
      received: toHexString(peerStatus.forkDigest),
    });
    return true;
  }

  if (peerStatus.finalizedEpoch === GENESIS_EPOCH) {
    if (!config.types.Root.equals(peerStatus.finalizedRoot, ZERO_HASH)) {
      logger.verbose("Genesis finalized root must be zeroed", {
        expected: toHexString(ZERO_HASH),
        received: toHexString(peerStatus.finalizedRoot),
      });
      return true;
    }
  } else {
    // we're on a further (or equal) finalized epoch
    // but the peer's block root at that epoch may not match match ours
    const headSummary = chain.forkChoice.getHead();
    const finalizedCheckpoint = chain.forkChoice.getFinalizedCheckpoint();
    const peerStatusFinalizedSlot = computeStartSlotAtEpoch(config, peerStatus.finalizedEpoch);

    if (peerStatus.finalizedEpoch === finalizedCheckpoint.epoch) {
      if (!config.types.Root.equals(peerStatus.finalizedRoot, finalizedCheckpoint.root)) {
        logger.verbose("Status with same finalized epoch has different root", {
          expected: toHexString(finalizedCheckpoint.root),
          received: toHexString(peerStatus.finalizedRoot),
        });
        return true;
      }
    } else if (peerStatus.finalizedEpoch < finalizedCheckpoint.epoch) {
      // If it is within recent history, we can directly check against the block roots in the state
      if (headSummary.slot - peerStatusFinalizedSlot < config.params.SLOTS_PER_HISTORICAL_ROOT) {
        const headState = await chain.getHeadState();
        // This will get the latest known block at the start of the epoch.
        const expected = getBlockRootAtSlot(config, headState, peerStatusFinalizedSlot);
        if (!config.types.Root.equals(peerStatus.finalizedRoot, expected)) {
          logger.verbose("Status with different finalized root", {
            expected: toHexString(expected),
            received: toHexString(peerStatus.finalizedRoot),
            epoch: peerStatus.finalizedEpoch,
          });
          return true;
        }
      } else {
        // finalized checkpoint of status is from an old long-ago epoch.
        // We need to ask the chain for most recent canonical block at the finalized checkpoint start slot.
        // The problem is that the slot may be a skip slot.
        // And the block root may be from multiple epochs back even.
        // The epoch in the checkpoint is there to checkpoint the tail end of skip slots, even if there is no block.
        // TODO: accepted for now. Need to maintain either a list of finalized block roots,
        // or inefficiently loop from finalized slot backwards, until we find the block we need to check against.
        return false;
      }
    } else {
      // peerStatus status finalized checkpoint is in the future, we do not know if it is a true finalized root
      logger.verbose("Status with future finalized epoch", {
        finalizedEpoch: peerStatus.finalizedEpoch,
        finalizedRoot: toHexString(peerStatus.finalizedRoot),
      });
    }
  }
  return false;
}
