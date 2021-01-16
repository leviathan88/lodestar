import PeerId from "peer-id";
import {AbortController} from "abort-controller";
import {IBeaconSync, ISyncModules} from "./interface";
import {defaultSyncOptions, ISyncOptions} from "./options";
import {getSyncProtocols, getUnknownRootProtocols, INetwork, NetworkEvent} from "../network";
import {ILogger} from "@chainsafe/lodestar-utils";
import {CommitteeIndex, Root, Slot, Status, SyncingStatus} from "@chainsafe/lodestar-types";
import {BeaconReqRespHandler, IReqRespHandler} from "./reqResp";
import {BeaconGossipHandler, GossipStatus, IGossipHandler} from "./gossip";
import {AttestationCollector, createStatus, RoundRobinArray, syncPeersStatus} from "./utils";
import {ChainEvent, IBeaconChain} from "../chain";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {List, toHexString} from "@chainsafe/ssz";
import {BlockError, BlockErrorCode} from "../chain/errors";
import {ORARegularSync} from "./regular/oneRangeAhead/oneRangeAhead";
import {
  InitialSyncAsStateMachine,
  ProcessChainSegment,
  DownloadBeaconBlocksByRange,
  GetPeerSet,
} from "./asStateMachine/chain";
import {getPeersInitialSync} from "./utils/bestPeers";
import {SyncEvent, SyncEventBus} from "./events";
import {shouldDisconnectOnStatus} from "./utils/shouldDisconnectOnStatus";
import {GoodByeReasonCode} from "../constants";

export enum SyncStatus {
  SYNCING,
  SYNCED,
  STOPPED,
}

export class BeaconSync implements IBeaconSync {
  private readonly opts: ISyncOptions;
  private readonly config: IBeaconConfig;
  private readonly logger: ILogger;
  private readonly network: INetwork;
  private readonly chain: IBeaconChain;

  private status: SyncStatus = SyncStatus.STOPPED;
  private reqResp: IReqRespHandler;
  private gossip: IGossipHandler;
  private attestationCollector: AttestationCollector;
  private syncEventBus = new SyncEventBus();

  private syncPeersStatusInterval?: NodeJS.Timeout;
  private peerCountTimer?: NodeJS.Timeout;
  // avoid finding same root at the same time
  private processingRoots: Set<string>;

  private controller = new AbortController();

  constructor(opts: ISyncOptions, modules: ISyncModules) {
    this.opts = opts;
    this.config = modules.config;
    this.network = modules.network;
    this.chain = modules.chain;
    this.logger = modules.logger;
    this.reqResp =
      modules.reqRespHandler || new BeaconReqRespHandler(modules, this.syncEventBus, this.controller.signal);
    this.gossip =
      modules.gossipHandler || new BeaconGossipHandler(modules.chain, modules.network, modules.db, this.logger);
    this.attestationCollector =
      modules.attestationCollector || new AttestationCollector(modules.config, modules, this.controller.signal);
    this.processingRoots = new Set();
  }

  public async start(): Promise<void> {
    if (this.status === SyncStatus.SYNCING) {
      return;
    }
    this.status = SyncStatus.SYNCING;

    const finalizedBlock = this.chain.forkChoice.getFinalizedBlock();
    const startEpoch = finalizedBlock.finalizedEpoch;
    const initialSync = new InitialSyncAsStateMachine(
      startEpoch,
      this.processChainSegment,
      this.downloadBeaconBlocksByRange,
      this.getPeerSet,
      this.syncEventBus,
      this.config,
      this.logger,
      this.controller.signal
    );

    // Sync initial sync up to the most common finalized checkpoint of all connected peers
    this.syncPeersStatusEvery(this.config.params.SLOTS_PER_EPOCH * this.config.params.SECONDS_PER_SLOT * 1000);
    await initialSync.sync();

    if ((this.status as SyncStatus) === SyncStatus.STOPPED) {
      return;
    }

    // Start regular sync
    this.syncPeersStatusEvery(3 * this.config.params.SECONDS_PER_SLOT * 1000);
    this.peerCountTimer = setInterval(this.logPeerCount, 3 * this.config.params.SECONDS_PER_SLOT * 1000);
    this.chain.emitter.on(ChainEvent.errorBlock, this.onUnknownBlockRoot);
    const regularSync = new ORARegularSync(this.opts, this.controller.signal, {
      config: this.config,
      network: this.network,
      chain: this.chain,
      logger: this.logger,
    });
    await this.gossip.start();
    await regularSync.sync();

    // Regular sync completed
    this.status = SyncStatus.SYNCED;
    this.stopSyncingPeersStatus();
    this.gossip.handleSyncCompleted();
    await this.network.handleSyncCompleted();
  }

  public async stop(): Promise<void> {
    if (this.status === SyncStatus.STOPPED) {
      return;
    }
    this.status = SyncStatus.STOPPED;

    // Abort signal to trigger child modules clean functions: ReqRespHandler, AttestationCollector, etc
    this.controller.abort();

    // Stop timers
    if (this.peerCountTimer) clearInterval(this.peerCountTimer);
    this.stopSyncingPeersStatus();

    // Remove subscriptions
    this.chain.emitter.removeListener(ChainEvent.errorBlock, this.onUnknownBlockRoot);

    await this.reqResp.goodbyeAllPeers();
    this.gossip.stop();
  }

  public async getSyncStatus(): Promise<SyncingStatus> {
    const currentSlot = this.chain.clock.currentSlot;
    // TODO: Get the best known head slot from the group of peers with consider good
    // TODO: Consider capping their answer with our clock or report large disparities
    const bestKnownHeadSlot = currentSlot;
    const headSlot = this.chain.forkChoice.getHead().slot;
    return {
      headSlot: BigInt(headSlot),
      syncDistance: BigInt(bestKnownHeadSlot - headSlot),
    };
  }

  public isSynced(): boolean {
    return this.status === SyncStatus.SYNCED;
  }

  public async collectAttestations(slot: Slot, committeeIndex: CommitteeIndex): Promise<void> {
    if (this.gossip.status !== GossipStatus.STARTED) {
      throw new Error("Cannot collect attestations before regular sync");
    }
    await this.attestationCollector.subscribeToCommitteeAttestations(slot, committeeIndex);
  }

  private processChainSegment: ProcessChainSegment = async (blocks) => {
    // MUST ignore already known blocks
    // TODO: Is there a way to ignore specifically the BLOCK_IS_ALREADY_KNOWN error on a segment?
    blocks = blocks.filter(
      (block) => !this.chain.forkChoice.hasBlock(this.config.types.BeaconBlock.hashTreeRoot(block.message))
    );

    const trusted = true; // TODO: Verify signatures
    await this.chain.processChainSegment(blocks, trusted);
  };

  private downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange = async (peerId, request) => {
    const blocks = await this.network.reqResp.beaconBlocksByRange(peerId, request);
    return blocks || [];
  };

  private getPeerSet: GetPeerSet = () => {
    const minPeers = this.opts.minPeers ?? defaultSyncOptions.minPeers;
    const peerSet = getPeersInitialSync(this.network);
    if (!peerSet) {
      this.logger.info("No peers found");
      return null;
    } else if (peerSet.peers.length < minPeers) {
      this.logger.info(`Waiting for minPeers: ${peerSet.peers.length}/${minPeers}`);
      return null;
    } else {
      const targetEpoch = peerSet.checkpoint.epoch;
      this.logger.info("New peer set", {count: peerSet.peers.length, targetEpoch});
      return {peers: peerSet.peers.map((p) => p.peerId), targetEpoch};
    }
  };

  /**
   * Send current chain status to all peers and store their statuses
   */
  private syncPeersStatusEvery(interval: number): void {
    this.stopSyncingPeersStatus();
    this.syncPeersStatusInterval = setInterval(async () => {
      try {
        const myStatus = await createStatus(this.chain);
        await syncPeersStatus(this.network, myStatus);
      } catch (e) {
        this.logger.error("Error on syncPeersStatus", e);
      }
    }, interval);
  }

  private logPeerCount = (): void => {
    this.logger.info("Peer status", {
      activePeers: this.network.getPeers().length,
      syncPeers: this.getSyncPeers().length,
      unknownRootPeers: this.getUnknownRootPeers().length,
    });
  };

  private stopSyncingPeersStatus(): void {
    if (this.syncPeersStatusInterval) clearInterval(this.syncPeersStatusInterval);
  }

  private getSyncPeers(): PeerId[] {
    return this.getPeers(getSyncProtocols());
  }

  private getUnknownRootPeers(): PeerId[] {
    return this.getPeers(getUnknownRootProtocols());
  }

  private getPeers(protocols: string[]): PeerId[] {
    return this.network
      .getPeers({supportsProtocols: protocols})
      .filter((peer) => {
        return !!this.network.peerMetadata.getStatus(peer.id) && this.network.peerRpcScores.getScore(peer.id) > 50;
      })
      .map((peer) => peer.id);
  }

  private onUnknownBlockRoot = async (err: BlockError): Promise<void> => {
    if (err.type.code !== BlockErrorCode.PARENT_UNKNOWN) return;
    const blockRoot = this.config.types.BeaconBlock.hashTreeRoot(err.job.signedBlock.message);
    const unknownAncestorRoot = this.chain.pendingBlocks.getMissingAncestor(blockRoot);
    const missingRootHex = toHexString(unknownAncestorRoot);
    if (this.processingRoots.has(missingRootHex)) {
      return;
    } else {
      this.processingRoots.add(missingRootHex);
      this.logger.verbose("Finding block for unknown ancestor root", {blockRoot: missingRootHex});
    }
    const peerBalancer = new RoundRobinArray(this.getUnknownRootPeers());
    let retry = 0;
    const maxRetry = this.getUnknownRootPeers().length;
    let found = false;
    while (retry < maxRetry) {
      const peer = peerBalancer.next();
      if (!peer) {
        break;
      }
      try {
        const blocks = await this.network.reqResp.beaconBlocksByRoot(peer, [unknownAncestorRoot] as List<Root>);
        if (blocks && blocks[0]) {
          this.logger.verbose("Found block for root", {slot: blocks[0].message.slot, blockRoot: missingRootHex});
          found = true;
          await this.chain.receiveBlock(blocks[0]);
          break;
        }
      } catch (e) {
        this.logger.verbose("Failed to get unknown ancestor root from peer", {
          blockRoot: missingRootHex,
          peer: peer.toB58String(),
          error: e.message,
          maxRetry,
          retry,
        });
      }
      retry++;
    } // end while
    this.processingRoots.delete(missingRootHex);
    if (!found) this.logger.error("Failed to get unknown ancestor root", {blockRoot: missingRootHex});
  };
}
