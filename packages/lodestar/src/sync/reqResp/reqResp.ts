/**
 * @module sync
 */

import {AbortSignal} from "abort-controller";
import {GENESIS_SLOT} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {
  BeaconBlocksByRangeRequest,
  BeaconBlocksByRootRequest,
  Goodbye,
  MAX_REQUEST_BLOCKS,
  Metadata,
  Ping,
  RequestBody,
  ResponseBody,
  SignedBeaconBlock,
  Status,
} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import PeerId from "peer-id";
import {IBeaconChain} from "../../chain";
import {Method, ReqRespEncoding, RpcResponseStatus} from "../../constants";
import {IBeaconDb} from "../../db";
import {IBlockFilterOptions} from "../../db/api/beacon/repositories";
import {createRpcProtocol, INetwork} from "../../network";
import {ResponseError} from "../../network/reqresp/response";
import {handlePeerMetadataSequence} from "../../network/peers/utils";
import {createStatus, syncPeersStatus} from "../utils/sync";
import {IReqRespHandler} from "./interface";
import {shouldDisconnectOnStatus} from "../utils/shouldDisconnectOnStatus";

export interface IReqRespHandlerModules {
  config: IBeaconConfig;
  db: IBeaconDb;
  chain: IBeaconChain;
  network: INetwork;
  logger: ILogger;
}

enum GoodByeReasonCode {
  CLIENT_SHUTDOWN = 1,
  IRRELEVANT_NETWORK = 2,
  ERROR = 3,
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const GoodbyeReasonCodeDescriptions: Record<string, string> = {
  // spec-defined codes
  1: "Client shutdown",
  2: "Irrelevant network",
  3: "Internal fault/error",

  // Teku-defined codes
  128: "Unable to verify network",

  // Lighthouse-defined codes
  129: "Client has too many peers",
  250: "Peer score too low",
  251: "Peer banned this node",
};

/**
 * The BeaconReqRespHandler module handles app-level requests / responses from other peers,
 * fetching state from the chain and database as needed.
 */
export class BeaconReqRespHandler implements IReqRespHandler {
  private config: IBeaconConfig;
  private db: IBeaconDb;
  private chain: IBeaconChain;
  private network: INetwork;
  private logger: ILogger;

  public constructor({config, db, chain, network, logger}: IReqRespHandlerModules, signal: AbortSignal) {
    this.config = config;
    this.db = db;
    this.chain = chain;
    this.network = network;
    this.logger = logger;

    this.network.reqResp.registerHandler(this.onRequest.bind(this));
    signal.addEventListener("abort", () => this.network.reqResp.unregisterHandler());
  }

  /**
   * Send current chain status to all peers and store their statuses
   */
  public async syncPeersStatus(): Promise<void> {
    const myStatus = await createStatus(this.chain);
    await syncPeersStatus(this.network, myStatus);
  }

  /**
   * Send goodbye to all peers, for shutdown
   */
  public async goodbyeAllPeers(reason = GoodByeReasonCode.CLIENT_SHUTDOWN): Promise<void> {
    const goodbyeProtocol = createRpcProtocol(Method.Goodbye, ReqRespEncoding.SSZ_SNAPPY);
    const allPeers = this.network.getPeers({supportsProtocols: [goodbyeProtocol]});
    await Promise.all(
      allPeers.map(async (peer) => {
        await this.network.reqResp.goodbye(peer.id, BigInt(reason)).catch((e) => {
          this.logger.verbose("Failed to send goodbye", {error: e.message});
        });
      })
    );
  }

  public async *onRequest(method: Method, requestBody: RequestBody, peerId: PeerId): AsyncIterable<ResponseBody> {
    switch (method) {
      case Method.Status:
        yield* this.onStatus(requestBody as Status, peerId);
        break;
      case Method.Goodbye:
        yield* this.onGoodbye(requestBody as Goodbye, peerId);
        break;
      case Method.Ping:
        yield* this.onPing(requestBody as Ping, peerId);
        break;
      case Method.Metadata:
        yield* this.onMetadata();
        break;
      case Method.BeaconBlocksByRange:
        yield* this.onBeaconBlocksByRange(requestBody as BeaconBlocksByRangeRequest);
        break;
      case Method.BeaconBlocksByRoot:
        yield* this.onBeaconBlocksByRoot(requestBody as BeaconBlocksByRootRequest);
        break;
      default:
        throw Error(`Unsupported method ${method}`);
    }
  }

  private async *onStatus(requestBody: Status, peerId: PeerId): AsyncIterable<Status> {
    // send status response
    yield await createStatus(this.chain);

    const shouldDisconnect = await shouldDisconnectOnStatus(requestBody, {
      chain: this.chain,
      config: this.config,
      logger: this.logger,
    });

    if (shouldDisconnect) {
      try {
        await this.network.reqResp.goodbye(peerId, BigInt(GoodByeReasonCode.IRRELEVANT_NETWORK));
      } catch {
        // ignore error
        return;
      }
    }

    // set status on peer
    this.network.peerMetadata.setStatus(peerId, requestBody);
  }

  private async *onGoodbye(requestBody: Goodbye, peerId: PeerId): AsyncIterable<bigint> {
    this.logger.debug("Received goodbye request", {
      peer: peerId.toB58String(),
      reason: requestBody,
      description: GoodbyeReasonCodeDescriptions[requestBody.toString()],
    });

    yield BigInt(GoodByeReasonCode.CLIENT_SHUTDOWN);

    // # TODO: Will this line be called if the yield consumer returns? Consider using finally {}
    await this.network.disconnect(peerId);
  }

  private async *onPing(requestBody: Ping, peerId: PeerId): AsyncIterable<bigint> {
    yield this.network.metadata.seqNumber;

    // # TODO: Will this line be called if the yield consumer returns? Consider using finally {}
    // no need to wait
    handlePeerMetadataSequence(this.network, this.logger, peerId, requestBody).catch(() => {
      this.logger.warn("Failed to handle peer metadata sequence", {peerId: peerId.toB58String()});
    });
  }

  private async *onMetadata(): AsyncIterable<Metadata> {
    yield this.network.metadata.metadata;
  }

  private async *onBeaconBlocksByRange(requestBody: BeaconBlocksByRangeRequest): AsyncIterable<SignedBeaconBlock> {
    if (requestBody.step < 1) {
      throw new ResponseError(RpcResponseStatus.INVALID_REQUEST, "step < 1");
    }
    if (requestBody.count < 1) {
      throw new ResponseError(RpcResponseStatus.INVALID_REQUEST, "count < 1");
    }
    if (requestBody.startSlot < GENESIS_SLOT) {
      throw new ResponseError(RpcResponseStatus.INVALID_REQUEST, "startSlot < genesis");
    }

    if (requestBody.count > MAX_REQUEST_BLOCKS) {
      requestBody.count = MAX_REQUEST_BLOCKS;
    }

    const archiveBlocksStream = this.db.blockArchive.valuesStream({
      gte: requestBody.startSlot,
      lt: requestBody.startSlot + requestBody.count * requestBody.step,
      step: requestBody.step,
    } as IBlockFilterOptions);
    yield* this.injectRecentBlocks(archiveBlocksStream, this.chain, requestBody);
  }

  private async *onBeaconBlocksByRoot(requestBody: BeaconBlocksByRootRequest): AsyncIterable<SignedBeaconBlock> {
    const getBlock = this.db.block.get.bind(this.db.block);
    const getFinalizedBlock = this.db.blockArchive.getByRoot.bind(this.db.blockArchive);
    for (const blockRoot of requestBody) {
      const root = blockRoot.valueOf() as Uint8Array;
      const block = (await getBlock(root)) || (await getFinalizedBlock(root));
      if (block) {
        yield block;
      }
    }
  }

  private injectRecentBlocks = async function* (
    archiveStream: AsyncIterable<SignedBeaconBlock>,
    chain: IBeaconChain,
    request: BeaconBlocksByRangeRequest
  ): AsyncGenerator<SignedBeaconBlock> {
    let slot = -1;
    for await (const archiveBlock of archiveStream) {
      yield archiveBlock;
      slot = archiveBlock.message.slot;
    }
    slot = slot === -1 ? request.startSlot : slot + request.step;
    const upperSlot = request.startSlot + request.count * request.step;
    const slots = [] as number[];
    while (slot < upperSlot) {
      slots.push(slot);
      slot += request.step;
    }

    const blocks = (await chain.getUnfinalizedBlocksAtSlots(slots)) || [];
    for (const block of blocks) {
      if (block) {
        yield block;
      }
    }
  };
}
