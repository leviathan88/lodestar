import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {computeTimeAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {toHexString, TreeBacked, readOnlyMap} from "@chainsafe/ssz";
import {mostFrequent} from "../../util/objects";

export type Eth1DataGetter = ({
  timestampRange,
}: {
  timestampRange: {gte: number; lte: number};
}) => Promise<phase0.Eth1Data[]>;

export async function getEth1VotesToConsider(
  config: IBeaconConfig,
  state: TreeBacked<phase0.BeaconState>,
  eth1DataGetter: Eth1DataGetter
): Promise<phase0.Eth1Data[]> {
  const periodStart = votingPeriodStartTime(config, state);
  const {SECONDS_PER_ETH1_BLOCK, ETH1_FOLLOW_DISTANCE} = config.params;

  // Modified version of the spec function to fetch the required range directly from the DB
  return (
    await eth1DataGetter({
      timestampRange: {
        // Spec v0.12.2
        // is_candidate_block =
        //   block.timestamp + SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE <= period_start &&
        //   block.timestamp + SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE * 2 >= period_start
        lte: periodStart - SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE,
        gte: periodStart - SECONDS_PER_ETH1_BLOCK * ETH1_FOLLOW_DISTANCE * 2,
      },
    })
  ).filter((eth1Data) => eth1Data.depositCount >= state.eth1Data.depositCount);
}

export function pickEth1Vote(
  config: IBeaconConfig,
  state: TreeBacked<phase0.BeaconState>,
  votesToConsider: phase0.Eth1Data[]
): phase0.Eth1Data {
  const votesToConsiderHashMap = new Set<string>();
  for (const eth1Data of votesToConsider) votesToConsiderHashMap.add(serializeEth1Data(eth1Data));

  const validVotes = readOnlyMap(state.eth1DataVotes, (eth1Data) => eth1Data).filter((eth1Data) =>
    votesToConsiderHashMap.has(serializeEth1Data(eth1Data))
  );

  if (validVotes.length > 0) {
    const frequentVotes = mostFrequent<phase0.Eth1Data>(config.types.phase0.Eth1Data, validVotes);
    if (frequentVotes.length === 1) {
      return frequentVotes[0];
    } else {
      return validVotes[
        Math.max(
          ...frequentVotes.map((vote) =>
            validVotes.findIndex((eth1Data) => config.types.phase0.Eth1Data.equals(vote, eth1Data))
          )
        )
      ];
    }
  } else {
    return votesToConsider[votesToConsider.length - 1] || state.eth1Data;
  }
}

/**
 * Serialize eth1Data types to a unique string ID. It is only used for comparison.
 */
function serializeEth1Data(eth1Data: phase0.Eth1Data): string {
  return toHexString(eth1Data.blockHash) + eth1Data.depositCount.toString(16) + toHexString(eth1Data.depositRoot);
}

export function votingPeriodStartTime(config: IBeaconConfig, state: TreeBacked<phase0.BeaconState>): number {
  const eth1VotingPeriodStartSlot =
    state.slot - (state.slot % (config.params.EPOCHS_PER_ETH1_VOTING_PERIOD * config.params.SLOTS_PER_EPOCH));
  return computeTimeAtSlot(config, eth1VotingPeriodStartSlot, state.genesisTime);
}
