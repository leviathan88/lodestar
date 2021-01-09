import PeerId from "peer-id";
import {WinstonLogger} from "@chainsafe/lodestar-utils";
import {config} from "@chainsafe/lodestar-config/minimal";
import {BeaconBlocksByRangeRequest, Epoch, SignedBeaconBlock, Slot} from "@chainsafe/lodestar-types";
import {linspace} from "../../../../src/util/numpy";
import {InitialSyncAsStateMachine} from "../../../../src/sync/asStateMachine/chain";
import {generateEmptyBlock} from "../../../utils/block";
import {silentLogger} from "../../../utils/logger";

const debugMode = process.env.DEBUG;

describe("sync / InitialSyncAsStateMachine / simulation", () => {
  const {SLOTS_PER_EPOCH} = config.params;

  const testCases: {
    id: string;
    startEpoch: Epoch;
    targetEpoch: Epoch;
    badBlocks?: Set<Slot>;
    skippedSlots?: Set<Slot>;
  }[] = [
    {
      id: "No issues, successful sync",
      startEpoch: 0,
      targetEpoch: 16,
    },
    {
      id: "Successful sync with skipped slots",
      startEpoch: 0,
      targetEpoch: 16,
      skippedSlots: new Set(linspace(3 * SLOTS_PER_EPOCH, 6 * SLOTS_PER_EPOCH)),
    },
    {
      id: "Stalled sync with bad block",
      startEpoch: 0,
      targetEpoch: 16,
      badBlocks: new Set(linspace(3 * SLOTS_PER_EPOCH, 4 * SLOTS_PER_EPOCH)),
    },
  ];

  // Helper variables to trigger errors
  const ACCEPT_BLOCK = Buffer.alloc(96, 0);
  const REJECT_BLOCK = Buffer.alloc(96, 1);
  const interval: NodeJS.Timeout | null = null;

  afterEach(() => {
    if (interval) clearInterval(interval);
  });

  for (const {id, startEpoch, targetEpoch, badBlocks, skippedSlots} of testCases) {
    it(id, async () => {
      const logger = debugMode ? silentLogger : new WinstonLogger();

      async function processChainSegment(blocks: SignedBeaconBlock[]): Promise<void> {
        for (const block of blocks) {
          if (block.signature === ACCEPT_BLOCK) continue;
          if (block.signature === REJECT_BLOCK) throw Error("REJECT_BLOCK");
        }
      }

      async function downloadBeaconBlocksByRange(
        peerId: PeerId,
        request: BeaconBlocksByRangeRequest
      ): Promise<SignedBeaconBlock[]> {
        const blocks: SignedBeaconBlock[] = [];
        for (let i = request.startSlot; blocks.length < request.count; i += request.step) {
          if (skippedSlots?.has(i)) {
            continue; // Skip
          }

          // Only reject once to prevent an infinite loop
          const shouldReject = badBlocks?.has(i);
          if (shouldReject) badBlocks?.delete(i);
          blocks.push({
            message: generateEmptyBlock(),
            signature: shouldReject ? REJECT_BLOCK : ACCEPT_BLOCK,
          });
        }
        return blocks;
      }

      const initialSync = new InitialSyncAsStateMachine(
        startEpoch,
        processChainSegment,
        downloadBeaconBlocksByRange,
        config,
        logger
      );

      const peers = [new PeerId(Buffer.from("lodestar"))];
      initialSync.peerSetChanged({peers, targetEpoch});

      await initialSync.startSyncing();
    });
  }
});
