import {EventEmitter} from "events";
import PeerId from "peer-id";
import StrictEventEmitter from "strict-event-emitter-types";
import {Status} from "@chainsafe/lodestar-types";

export enum SyncEvent {
  /** Peer connected with valid status */
  peerConnect = "peerConnect",
  /** Peer disconnected */
  peerDisconnect = "peerDisconnect",
  /** Received peer status */
  receivedPeerStatus = "receivedPeerStatus",
}

export interface ISyncEvents {
  [SyncEvent.peerConnect]: (peer: PeerId) => void;
  [SyncEvent.receivedPeerStatus]: (peer: PeerId, status: Status) => void;
}

export class SyncEventBus extends (EventEmitter as {new (): StrictEventEmitter<EventEmitter, ISyncEvents>}) {}
