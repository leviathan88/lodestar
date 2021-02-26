/**
 * @module network
 */
import {ENR} from "@chainsafe/discv5/lib";
import Multiaddr from "multiaddr";
import PeerId from "peer-id";
import {INetworkEventBus} from "./events";
import {IGossip} from "./gossip/interface";
import {MetadataController} from "./metadata";
import {RequestedSubnet, IPeerManager, IPeerRpcScoreStore} from "./peers";
import {IReqResp} from "./reqresp";

export type PeerSearchOptions = {
  supportsProtocols?: string[];
  count?: number;
};

export interface INetwork {
  events: INetworkEventBus;
  reqResp: IReqResp;
  gossip: IGossip;
  metadata: MetadataController;
  peerRpcScores: IPeerRpcScoreStore;
  peerManager: IPeerManager;
  /** Our network identity */
  peerId: PeerId;
  localMultiaddrs: Multiaddr[];
  getEnr(): ENR | undefined;
  getConnectionsByPeer(): Map<string, LibP2pConnection[]>;
  getConnectedPeers(): PeerId[];
  /** Search peers joining subnets */
  requestAttSubnets(requestedSubnets: RequestedSubnet[]): void;
  reStatusPeers(peers: PeerId[]): void;
  // Service
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type PeerDirection = LibP2pConnection["stat"]["direction"];
export type PeerStatus = LibP2pConnection["stat"]["status"];
export type PeerState = "disconnected" | "connecting" | "connected" | "disconnecting";
