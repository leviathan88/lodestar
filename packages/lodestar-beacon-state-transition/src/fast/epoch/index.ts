import {CachedValidatorsBeaconState, prepareEpochProcessState} from "../util";
import {EpochContext} from "../util/epochContext";
import {processJustificationAndFinalization} from "./processJustificationAndFinalization";
import {processRewardsAndPenalties} from "./processRewardsAndPenalties";
import {processRegistryUpdates} from "./processRegistryUpdates";
import {processSlashings} from "./processSlashings";
import {processFinalUpdates} from "./processFinalUpdates";
import {processForkChanged} from "./processFork";
import {getAttestationDeltas} from "./getAttestationDeltas";
import {sleep} from "@chainsafe/lodestar-utils";

export {
  processJustificationAndFinalization,
  processRewardsAndPenalties,
  processRegistryUpdates,
  processSlashings,
  processFinalUpdates,
  processForkChanged,
  getAttestationDeltas,
};

export async function processEpoch(epochCtx: EpochContext, state: CachedValidatorsBeaconState): Promise<void> {
  const process = prepareEpochProcessState(epochCtx, state);
  await sleep(0);
  processJustificationAndFinalization(epochCtx, process, state);
  processRewardsAndPenalties(epochCtx, process, state);
  await sleep(0);
  processRegistryUpdates(epochCtx, process, state);
  processSlashings(epochCtx, process, state);
  processFinalUpdates(epochCtx, process, state);
  processForkChanged(epochCtx, process, state);
}
