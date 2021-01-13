import {IForkChoice} from "@chainsafe/lodestar-fork-choice";

import {ChainEventEmitter} from "../emitter";
import {IBlockJob} from "../interface";
import {runStateTransition} from "./stateTransition";
import {IStateRegenerator} from "../regen";
import {BlockError, BlockErrorCode, BlockProcessorError} from "../errors";
import {IBeaconDb} from "../../db";
import {ITreeStateContext} from "../../db/api/beacon/stateContextCache";

export async function processBlocks({
  forkChoice,
  regen,
  emitter,
  db,
  jobs,
}: {
  forkChoice: IForkChoice;
  regen: IStateRegenerator;
  emitter: ChainEventEmitter;
  db: IBeaconDb;
  jobs: IBlockJob[];
}): Promise<void> {
  let preStateContext: ITreeStateContext;
  try {
    preStateContext = await regen.getPreState(jobs[0].signedBlock.message);
  } catch (e) {
    throw new BlockError({
      code: BlockErrorCode.PRESTATE_MISSING,
      job: jobs[0],
    });
  }

  for (const [index, job] of jobs.entries()) {
    try {
      preStateContext = await runStateTransition(emitter, forkChoice, db, preStateContext, job);
    } catch (e) {
      const importedJobs = jobs.slice(0, index);

      if (e instanceof BlockError) {
        throw new BlockProcessorError(e.type, e.job, importedJobs);
      }

      throw new BlockProcessorError({code: BlockErrorCode.BEACON_CHAIN_ERROR, error: e}, job, importedJobs);
    }
  }
}
