import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {INetwork} from "..";
import {ILogger} from "@chainsafe/lodestar-utils";
import {handlePeerMetadataSequence} from "../peers/utils";

export interface ICheckPeerAliveModules {
  network: INetwork;
  logger: ILogger;
}

/**
 * Periodically ping peers.
 *     If cannot ping them then disconnect.
 *     If its sequence is ahead of our store, issue metadata request to update us.
 */
export class CheckPeerAliveTask {
  private readonly config: IBeaconConfig;
  private readonly network: INetwork;
  private readonly logger: ILogger;

  private interval?: NodeJS.Timeout;

  public constructor(config: IBeaconConfig, modules: ICheckPeerAliveModules) {
    this.config = config;
    this.network = modules.network;
    this.logger = modules.logger;
  }

  public async start(): Promise<void> {
    this.interval = setInterval(
      this.run,
      this.config.params.SLOTS_PER_EPOCH * this.config.params.SECONDS_PER_SLOT * 1000
    );
  }

  public async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  public run = async (): Promise<void> => {
    this.logger.info("Running CheckPeerAliveTask");
    this.logger.profile("CheckPeerAliveTask");
    const peers = this.network.getPeers().map((peer) => peer.id);
    const seq = this.network.metadata.seqNumber;
    await Promise.all(
      peers.map(async (peer) => {
        let peerSeq: BigInt;
        try {
          peerSeq = await this.network.reqResp.ping(peer, seq);
        } catch (e) {
          this.logger.warn("Cannot ping peer, disconnecting it", {peerId: peer.toB58String(), error: e.message});
          // a peer may still be good for gossip blocks even it does not response to ping
          // temporarily disable this due to https://github.com/ChainSafe/lodestar/issues/1619
          // await this.network.disconnect(peer);
          return;
        }
        await handlePeerMetadataSequence(this.network, this.logger, peer, peerSeq);
      })
    );
    this.logger.profile("CheckPeerAliveTask");
  };
}
